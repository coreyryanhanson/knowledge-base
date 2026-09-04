# `fetch_block_tree` — shared seam contract

The single interface both `McpClient` implementations (TS and Python, per
[`stage0-network-de-risk.md`](stage0-network-de-risk.md) Step 4) conform to for
page/block reads, **and** the contract the upstream Logseq PR
([`logseq-getblock-pr-plan.md`](logseq-getblock-pr-plan.md)) delivers server-side.
One spec, two client impls, one server impl — the future `getBlock`-with-
`includeChildren` swap is identical on all three sides because all three honor
this document.

Authoritative for the *shape* of nested reads. For *why this is the seam* and
*how it fits retrieval*, defer to [`kb-architecture-plan.md`](kb-architecture-
plan.md) §4/§5. For *how the server change is implemented*, defer to
`logseq-getblock-pr-plan.md` §3.

---

## 1. Purpose

Today MCP `getPage` returns a page's **top-level blocks only** — `get-page-data`
dissocs `:block/children` (`src/main/logseq/api/db_based/tools.cljs:89`), even
though `blocks->vec-tree` already builds the full recursive tree
(`deps/outliner/src/logseq/outliner/tree.cljs:11`). This seam abstracts that
flatten so that:

- The Stage 4 vector indexer and Stage 6 edges extractor (Python) read blocks
  through one function, not raw `getPage`.
- The Stage 7 code indexer and the Pi extension's `kb_*` tools (TS) read blocks
  through the same-shaped function.
- When Logseq ships `getPage - includeChildren` (or a new `getBlock`), only the
  **backend** of this function changes on each side — no caller rewrite, no
  indexer rewrite, no plugin rewrite.

---

## 2. Signature

```
fetch_block_tree(page, opts?) -> BlockNode[]
```

- `page`: a page identifier — either the page's UUID (string) or its name/title
  (string). Impl accepts either and passes through to MCP `getPage`'s
  `pageName` arg (which already accepts both).
- `opts` (optional, all fields optional):
  - `includeChildren`: `bool`, default `false`. When `false`, returns
    top-level blocks only (today's behavior). When `true`, returns the full
    recursive tree, subject to `depth`.
  - `depth`: `int`, default `50`, hard cap `100`. Max nesting depth to return.
    Nodes at depth > `depth` carry `:block/children [{:truncated true}]`
    instead of their children. `depth=0` is invalid (rejected); `depth=1`
    means top-level only.
- Returns: a list of `BlockNode` (see §3), one per top-level block of the
  page. Empty page → `[]`. Missing page → impl raises / returns a typed
  error (see §5); never `[]` for a missing page (that would alias "empty"
  with "not found").

`opts` is passed straight through to the MCP tool call. Today the server
ignores `includeChildren`/`depth` (they're the PR's job); the impl MUST send
them anyway so the day the capability lands, no client change is needed — the
backend swap is the only change.

---

## 3. `BlockNode` shape

Namespaced Clojure keys, as MCP `getPage` returns today (verified in Stage 0:
`getPage` returns `:block/uuid` / `:block/title` / `:block/children` /
`:block/page`; only `searchBlocks` returns bare keys — that's a different tool,
not this seam). The impl MUST NOT rename keys; consumers read `:block/uuid`
etc. directly. (This keeps the seam a transparent passthrough — renaming would
be a third shape for reviewers and consumers to track.)

```
BlockNode = {
  ":block/uuid":   string,          // MCP stringifies (:db.unique/identity)
  ":block/title":   string,         // the embeddable / displayable text
  ":block/children"?: BlockNode[]   // present only when includeChildren=true
                                    //   AND depth not exhausted
                                    //   OR {:truncated true} when depth-exhausted
  ":block/page":    { ":block/uuid": string, ":block/title": string }
                                    // parent page ref; impl attaches it even
                                    //   though getPage may omit it on nested
                                    //   nodes (see §4 normalizer rule 3)
  // ...other keys the server returns (:block/created-at, :block/updated-at,
  //   :block/order, etc.) pass through untouched.
}
```

Key invariants (enforced by the impl's normalizer, mirroring the server-side
normalizer the PR adds — `logseq-getblock-pr-plan.md` §3a step 1):

1. **`:block/uuid` is a string at every level.** Today `tools.cljs` only
   stringifies the top level; nested children come back as raw entity maps
   with non-string UUIDs. The PR fixes this server-side; until then, the
   **client normalizer stringifies recursively** so consumers never see a
   non-string UUID regardless of server version. After the PR lands, the
   client normalizer is a no-op safety net.
2. **`:block/title` is present at every level** or the node is dropped (a
   node with a UUID but no title is not an embeddable/indexable block —
   e.g. container-only blocks the server may emit). Log it at debug, don't
   crash.
3. **`:block/page` is attached at every level.** `getPage` may omit it on
   nested children; the impl back-fills it from the page argument so every
   returned node carries its parent page ref. Consumers (the indexers) key
   off this and must not have to special-case root-vs-nested.

---

## 4. Depth and truncation

When `includeChildren=true`:

- Recurse to `depth` levels (default 50, cap 100). `depth=1` = top-level
  only (same as `includeChildren=false`).
- A node at the depth boundary carries
  `":block/children": [{":truncated": true}]` — a **one-element vector**
  (a marker element inside the children vector), so `:block/children`
  stays a collection at every node, matching `blocks->vec-tree`'s
  invariant. Consumers iterate as usual; a marker element with
  `:truncated` means "more exists, not fetched."

`depth` is the only payload bound — there is no node-count cap. The
truncated-marker shape is identical server-side and client-side so a
consumer can't tell (and doesn't care) which side truncated.

---

## 5. Errors

- **Missing page** (page name/UUID not in the graph): raise
  `PageNotFound` (TS) / `PageNotFound` (Python) — same name, both libs. Not
  `[]`.
- **MCP transport / auth failure**: raise the underlying `McpClient` error
  (the seam does not swallow transport errors). See Step 4a's session
  rules — the seam relies on the `McpClient`'s `initialize`-once +
  `DELETE`-before-reconnect handling.
- **`depth` out of range** (`<1` or `>100`): raise `InvalidDepth`, do not
  call the server.
- **Server returns a node with no `:block/uuid`**: drop the node, log at
  debug. Not an error (the server may emit page-meta nodes mixed in).

---

## 6. Return shape

`fetch_block_tree` returns `BlockNode[]`. Truncation is signaled in-tree:
nodes at the depth boundary carry `:block/children [{:truncated true}]`
(§4), so consumers iterate the array as usual and check for a `:truncated`
marker element. There is no separate container object or node-count field.

---

## 7. Today's implementation (pre-PR, both client impls)

Both the TS and Python `McpClient.fetch_block_tree` do the same thing today:

1. `call_tool("getPage", {pageName: page, includeChildren: opts?.includeChildren, depth: opts?.depth})`.
   (Server ignores the two extra fields until the PR lands — harmless.)
2. Read `page[":block/children"]` → top-level blocks (the only level the
   server returns today).
3. Run the §3 normalizer over that list (stringify UUIDs, drop titleless
   nodes, back-fill `:block/page`).
4. If `includeChildren` was requested, the result is **still top-level
   only** today — the client does not synthesize nested data. This is the
   honest pre-PR behavior; §8 describes the post-PR swap (backend-only).
5. Return per §6.

No client-side recursion is attempted today (there's nothing to recurse
into). The `depth`/`includeChildren` args are threaded through purely so
the post-PR swap is a backend-only change.

---

## 8. Post-PR implementation (after `getPage - includeChildren` ships)

Same signature, same `BlockNode` shape. The only change is step 2: the
server now returns nested `:block/children` when `includeChildren=true`,
already normalized (UUID stringified at every level — the PR's normalizer).
The client:

1. Same `call_tool` (now the server honors the two fields).
2. Walk the returned tree, run the §3 normalizer as a **safety net** (no-op
   if the server already normalized — cheap), enforce the §4 depth bound,
   emit `[{:truncated true}]` markers at the boundary.
3. Return per §6.

No consumer changes. No indexer changes. No plugin rewrite. This is the
seam's whole reason for existing.

---

## 9. Test contract (both impls)

Each `McpClient` impl ships a unit test that asserts, against the throwaway
graph from Stage 0:

1. **Default behavior unchanged:** `fetch_block_tree(page)` (no opts)
   returns top-level blocks only, each with a string `:block/uuid`, no
   `:block/children`. (Backwards compat — reviewers' first check, and the
   Stage 4 indexer's only mode until Stage 5.)
2. **Missing page raises `PageNotFound`**, not `[]`.
3. **`depth` validation:** `depth=0` and `depth=101` raise `InvalidDepth`.
4. **`includeChildren=true` today** returns top-level only (the server
   does not yet return nested data) — documents the pre-PR honest
   behavior (§7 step 4).
5. **Post-PR (skip until the capability lands):** a page with ≥3 levels of
   nesting returns a full tree; `depth=2` truncates at level 2 with
   `[{:truncated true}]` markers; `:block/uuid` is a string at every level.

Tests 1–4 are written **now**, against today's server. Test 5 is written as
a `skip`/`xit`/`pytest.mark.skip` and un-skipped the day the PR's capability
is in the running server.

---

## 10. Cross-references

- Why this seam / where it fits: [`kb-architecture-plan.md`](kb-architecture-
  plan.md) §4 (`kb_get_page_tree`), §5 (vector indexer uses it), §6 (edges
  extractor uses it).
- Server-side implementation (the PR): [`logseq-getblock-pr-plan.md`](logseq-
  getblock-pr-plan.md) §3 (file-by-file), §4 (depth bound).
- Client location decision: [`stage0-network-de-risk.md`](stage0-network-de-
  risk.md) Step 4 (two impls grouped by language; this spec is shared).
- Observed MCP shapes that constrain this spec (Stage 0 findings):
  `getPage` returns namespaced `:block/*` keys; `searchBlocks` returns bare
  keys — the seam uses `getPage`, so it's namespaced. Recorded in
  `stage0-network-de-risk.md` "Risks and fallbacks."
