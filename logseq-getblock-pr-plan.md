# Upstream Logseq PR — `getPage` `includeChildren` + depth

A plan for upstreaming the one real MCP gap that blocks the KB: **nested block
reads.** Today MCP `getPage` returns a page's top-level blocks only; child
blocks are stripped. This PR makes that strip optional and adds a depth cap,
exposing the nested tree that Logseq already builds internally.

This is the concrete, in-repo implementation plan for the PR discussed in
conversation (scoped against `~/logseq` source). It is **not** the KB's own
plugin work — that lives in `kb-architecture-plan.md`. This document is only
about changing Logseq itself.

---

## 0. Why this PR, and why now

- **It's already on their roadmap.** PR
  [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111) names
  `getBlock - include children`, `getManyBlocks`, `getManyPages` as planned MCP
  additions. We are implementing something they have already said they want —
  not pitching a new feature. That is the single biggest factor in acceptance
  odds.
- **The capability already exists end-to-end; the MCP surface just discards it.**
  `get-page-blocks` calls `otree/blocks->vec-tree`, which returns top-level
  blocks **with `:block/children` recursively nested**
  (`deps/outliner/src/logseq/outliner/tree.cljs:11`, `blocks->vec-tree-aux`
  recurses fully). `get-page-data` then maps each top-level block through
  `(dissoc :block/children :block/page)` — **that one line is what flattens the
  tree** (`src/main/logseq/api/db_based/tools.cljs:89`). So this is a wiring PR,
  not a feature PR.
- **There is prior art for the flag name.** `get_block` in
  `src/main/logseq/api/block.cljs:200` already implements an `includeChildren`
  option (uses `db-model/get-block-and-children` + `blocks->vec-tree`), exported
  at `src/main/logseq/api.cljs:109`. Mirroring that name makes the change feel
  native to maintainers.
- **Unblocks the KB without a fork.** The KB is MCP-only by decision (see
  `kb-architecture-plan.md` §3 "No CLI fallback"). Nested reads are the one
  thing blocking full-tree indexing and `kb_get_page_tree`. An upstream merge +
  release is the only way to get nested reads with zero host-side glue — which
  is the KB's portability requirement.

---

## 1. The call chain (MCP `getPage` today)

```
MCP getPage                    src/electron/electron/mcp_server.cljs:96   api-get-page
  → call-api-fn "logseq.cli.getPageData" [pageName]
  → resolve-real-api-method    src/electron/electron/server.cljs:73      → "cli@getPageData"
  → get_page_data              src/main/logseq/api.cljs:237              = cli-based-api/get-page-data
  → get-page-data              src/main/logseq/api/db_based/cli.cljs:34
  → <invoke-db-worker :thread-api/api-get-page-data>
                               src/main/frontend/worker/db_core.cljs:1639
  → api-tools/get-page-data    src/main/logseq/api/db_based/tools.cljs:79
       └─ get-page-blocks      src/main/logseq/api/db_based/tools.cljs:62
            └─ otree/blocks->vec-tree   (RECURSIVE — children present)
       └─ (dissoc :block/children :block/page)   ← THE FLATTEN (tools.cljs:89)
```

The change threads an `opts` map (`{includeChildren?, depth?}`) down this chain
and makes the final `dissoc` conditional.

---

## 2. PR shape: extend `getPage` (Option A, recommended)

**Backwards-compatible:** optional flag, default off = today's behavior. Reuses
the tree that's already built. One tool, smallest blast radius, no schema
migration, no auth/dry-run surface touched (read-only).

The alternative — a new `getBlock` MCP tool matching the roadmap name literally
(Option B) — was rejected for v1: `get_block` lives in the SDK API surface
(`api/block.cljs`), while MCP routes through the CLI API surface
(`api/db_based/cli.cljs`). Bridging them means touching `server.cljs`'s method
resolver or duplicating logic — more files, more review surface, higher
scope-creep risk. Revisit Option B only if a reviewer explicitly asks for a
separate tool (ask in the PR description upfront).

---

## 3. File-by-file changes (~5 files, all small)

### 3a. `src/main/logseq/api/db_based/tools.cljs` — the core change

1. **`get-page-blocks` (line 62):** add a recursive normalizer so nested nodes
   get the same treatment top-level nodes get (`remove-hidden-properties` +
   `(update :block/uuid str)`). Today only the top level is normalized; children
   come back as raw entity maps from `blocks->vec-tree`. When `includeChildren?`
   is on, walk the returned tree and normalize every node.
2. **Depth cap.** `blocks->vec-tree` recurses with **no depth or count cap**
   (`tree.cljs:11`). Add a `depth` parameter (default `50`, hard cap `100`): stop
   recursing past N levels; truncated nodes get a marker like
   `{:block/children {:truncated true}}` instead of their children. ~3 lines in
   the normalizer walk.
3. **`get-page-data` (line 79):** accept an `opts` map `{includeChildren?,
   depth?}`. Replace the unconditional `(dissoc :block/children :block/page)`
   with a conditional: keep `:block/children` when `includeChildren?` is true
   (still dissoc `:block/page` to avoid parent loops). When keeping children,
   apply the normalizer from step 1 to the whole tree.

### 3b. `src/main/logseq/api/db_based/cli.cljs:34` — `get-page-data` arity

Currently `[page-title]`. Add an `opts` arg and thread it into the
`<invoke-db-worker :thread-api/api-get-page-data` call.

### 3c. `src/main/frontend/worker/db_core.cljs:1639` — worker handler

Currently `[repo page-title]`. Add `opts` and pass to
`api-tools/get-page-data`.

### 3d. `src/main/logseq/api.cljs:237` — the `^:export get_page_data` wrapper

Adjust arity so MCP's resolved `get_page_data` can receive the options object
from the JS side. Mirror how the existing `expand`-bearing tools pass options.

### 3e. `src/electron/electron/mcp_server.cljs:96` — `api-get-page` + schema

- `api-get-page`: pass `includeChildren`/`depth` from `args` into
  `call-api-fn`.
- `:getPage` `inputSchema` (around line 127): add
  `includeChildren` (`z/boolean`, optional) and `depth` (`z/number`, optional).
  Copy the declaration pattern from `listPages`'s `expand` (line 101).

No other files. No CLI command changes (CLI can adopt the same opts later in a
follow-up; keep this PR to the MCP path).

---

## 4. The reviewer risk to pre-empt

`blocks->vec-tree` recurses **unbounded** (`tree.cljs:11`). A page with 10k
nested blocks → a 10k-entity JSON payload over an authed HTTP endpoint. This is
the single most likely reason for a slow/no merge. **Ship the PR with these
already designed and tested, not as a follow-up:**

- **`depth` parameter** (default `50`, hard cap `100`): stop recursing past N
  levels; truncated nodes carry `{:block/children {:truncated true}}`. 3-line
  change in the normalizer walk.
- **Max-node cap** (e.g. `5000` nodes total across the tree): if exceeded, return
  an error or a truncated top-level slice rather than the whole page. The
  existing `list-pages` comment at `tools.cljs` ("return minimal info to avoid
  exceeding max payload size") shows maintainers already think about payload
  size — cite that comment in the PR description as precedent.
- **Test** that a deep page returns `truncated` markers and respects `depth`.
- **Explicitly state** in the PR description that this is read-only, so no
  dry-run/auth-surface change is needed — head off that question.

---

## 5. Tests

There is no `api_tools_test.cljs` today. Closest existing coverage:

- `src/test/frontend/worker/db_core_test.cljs` — covers the
  `:thread-api/api-get-page-data` worker path (the exact layer changed in §3c).
- `src/test/logseq/api_test.cljs` — covers the `api.cljs` export layer (§3d).

Add a test (in `db_core_test.cljs`, or a new
`src/test/logseq/api/db_based/tools_test.cljs`) that:

1. Builds a page with known nesting (≥3 levels deep).
2. Calls `get-page-data` with `includeChildren? true` and asserts children are
   present at every level.
3. Asserts `:block/uuid` is stringified at **every** level (today only
   top-level is stringified — this is a real correctness fix the normalizer in
   §3a step 1 delivers).
4. Asserts `depth` truncation produces `{:truncated true}` markers and stops at
   the requested depth.
5. Asserts **default behavior is unchanged** when `includeChildren?` is absent
   (top-level only, no `:block/children`) — guards backwards compatibility,
   which reviewers will check first.

Mirror whatever graph-fixture helper the existing `db_core_test` tests use for
building pages/blocks.

---

## 6. PR description framing (the part that sells it)

- **Lead with the roadmap:** "Implements the `getBlock - include children` item
  from #12111 on the MCP `getPage` surface."
- **Note the existing capability:** "The tree is already built by
  `blocks->vec-tree` and stripped by `get-page-data`; this PR makes the strip
  optional. The `includeChildren` flag mirrors the existing `get_block` SDK API
  (`api/block.cljs`)."
- **Pre-empt security/size:** "Read-only, no auth/dry-run surface change.
  Includes `depth` (default 50, cap 100) and a max-node cap with `truncated`
  markers; tests cover both. Payload-size discipline matches the existing
  `listPages` approach (`tools.cljs` comment)."
- **Keep scope tight:** one PR for `getPage - include children` **only**.
  `getManyBlocks` / `getManyPages` / the property-value setter = separate
  follow-up PRs. Say this explicitly so reviewers don't try to bundle.
- **Ask the open question upfront:** "I implemented this as an option on the
  existing `getPage` tool for minimal blast radius. Happy to split it into a
  separate `getBlock` tool if the team prefers matching the roadmap name
  literally — let me know." (Gives reviewers an easy yes/no instead of a
  design debate.)

---

## 7. Honest timeline

- **Fork / own build:** a day or two of focused work. The change is small; the
  test fixtures and the recursive normalizer are the bulk.
- **Upstream merge:** weeks to months, dominated by review bandwidth and the
  pagination/depth round-trip — which we minimize by shipping depth + caps +
  tests on day one.
- **Release:** on Logseq's release cadence after merge; not controllable.

---

## 8. Sequencing with the KB build

**Do not block the KB on this PR.** The KB's `fetch_block_tree` seam
(`kb-architecture-plan.md` §4/§5) is designed so that today it returns
top-level blocks via `getPage`, and upgrades to full trees the moment
`includeChildren` is available — whether from this PR upstream, a stock Logseq
release, or (last resort) a patched fork. So:

1. **Proceed with the KB build order now** (`kb-architecture-plan.md` §7):
   MCP-only, top-level-only, `fetch_block_tree` seam in place.
2. **In parallel, open this PR.** Frame it per §6. Keep scope tight (one
   capability per PR).
3. **Do not run a patched fork as a daily driver** unless willing to own the
   rebuild-on-every-Logseq-update tax. A fork is host glue with extra steps —
  the exact burden the MCP-only decision eliminated. Stay on stock Logseq +
   top-level-only; let the seam carry the KB until the capability lands
   upstream.

---

## 9. Scope boundaries — what this PR does NOT do

- No `getManyBlocks` / `getManyPages` (separate follow-up PRs).
- No property-value setter via MCP (separate; deferred in KB §6 regardless).
- No new MCP tool (Option B) unless reviewers ask.
- No CLI command changes (CLI can adopt the same `opts` in a later PR).
- No changes to `db.sqlite`, schema, FTS, or the search worker.
- No auth/dry-run surface changes (read-only).
