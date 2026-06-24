# Host-Logseq + VM-Agent KB Architecture (Plan)

A plan for running Logseq's DB graph and GUI on the host while a Pi agent in a
Firecracker VM reads and writes it over the network, plus a sidecar vector store
for RAG keyed by Logseq block UUIDs.

---

## 0. TL;DR / verified claims

- **The Logseq GUI cannot connect to a remote DB.** Verified in
  `src/main/frontend/persist_db/remote.cljs` and `handler/db_based/sync.cljs`:
  "remote graph" is a db-sync/RTC replication protocol (initial binary DB
  download + SSE transaction stream against a Cloudflare Durable Object), not
  "open a sqlite file over the network." The GUI always keeps a local replica.
  There is no thin-client mode. → Keep the DB on the host.
- **Blocks can be queried via MCP — at top-level-of-each-page granularity.**
  The MCP `getPage` tool (`logseq.cli.getPageData`) returns a page's entity plus
  its **top-level blocks**, each with `:block/uuid` (string), `:block/title`,
  `:block/created-at`, `:block/updated-at`, etc. Verified in
  `src/main/logseq/api/db_based/tools.cljs` (`get-page-data` / `get-page-blocks`)
  and `deps/outliner/src/logseq/outliner/tree.cljs` (`blocks->vec-tree`).
  **Nested child blocks are stripped** (`get-page-data` dissocs
  `:block/children` from each returned block). This matches the official docs'
  MCP TODO: "listing blocks beyond the top-level in a page." So MCP gives you
  UUID + text + timestamps per top-level block, **not** full outliner trees.
- **Blocks can be written via MCP.** The `upsertNodes` tool
  (`logseq.cli.upsertNodes`) supports `add`/`edit` on `block`, `page`, `tag`,
  and `property` in a single batched call, with `dry-run`, app-side validation,
  and undo/redo. Verified in `tools.cljs` (`ops->existing-pages-and-blocks`,
  `ops->pages-and-blocks`, `build-add-block`, `build-upsert-nodes-edn`).
- **`:block/uuid` is `:db.unique/identity`** in `deps/db/src/logseq/db/frontend/schema.cljs` — stable across edits, the correct join key for the vector sidecar.
- **Block text lives in `:block/title`** in DB graphs (there is no `:block/content`). Confirmed in the schema.

**Bottom line:** MCP is a real, typed, validated read/write surface over
individual blocks (UUID + title + timestamps). The plugin is **MCP-only**: it
pulls top-level blocks per page via MCP and detects retractions via MCP
`searchBlocks` (which already filters deleted blocks — see §5). The `logseq`
CLI is **not** a fallback path (see §3 for why). Nested child blocks are not
readable via MCP today; that's a known gap with a named roadmap tool (`getBlock`)
— see §2 and §5.

---

## 1. Target topology

```
HOST (your machine — full GUI visibility here)
├─ Logseq desktop app            ← you watch/edit here
│   └─ DB graph: db.sqlite       = single source of truth
│   └─ MCP HTTP server           = bound to VM-facing iface, Bearer token
│        default 127.0.0.1:12315 → rebind to 0.0.0.0:<port> (see §3)
│        allowedHosts must include <vm-facing-host>:<port> (rebinding guard)
│
VM (Firecracker) — agent + retrieval, isolated blast radius
├─ Pi agent + KB plugin
│   └─ MCP client → host endpoint over the network bridge (the ONLY host surface)
│        writes: upsertNodes (dry-run-first)
│        reads:  listPages / getPage / listTags / listProperties / searchBlocks
├─ vector sidecar: vectors.sqlite (sqlite-vec)
│   └─ indexer pulls blocks from host via MCP (top-level only until getBlock ships)
│   └─ hybrid_search() feeds agent retrieval
└─ (no CLI path — the logseq CLI is localhost-only and cannot be a VM fallback; see §3)
```

Why this shape:

- DB on host = GUI runs as designed, real-time visibility, undo/redo, no sync server.
- VM as network client = agent isolated; one validated write path; no raw SQLite.
- Sidecar vector DB = pure rebuildable derivative; Logseq never touches it.

---

## 2. What MCP gives you (verified)

| Tool             | Maps to                     | Returns / does                                                              | Block-level?        |
| ---------------- | --------------------------- | --------------------------------------------------------------------------- | ------------------- |
| `listPages`      | `logseq.cli.listPages`      | page uuid + title (+ created/updated if `expand`)                           | page                |
| `getPage`        | `logseq.cli.getPageData`    | page entity + **top-level blocks** (uuid, title, created-at, updated-at, …) | **yes (top-level)** |
| `searchBlocks`   | `logseq.app.search`         | blocks matching a term                                                      | yes                 |
| `listTags`       | `logseq.cli.listTags`       | tags (uuid, title; parents + tag-props if `expand`)                         | —                   |
| `listProperties` | `logseq.cli.listProperties` | properties (uuid, title, type, cardinality if `expand`)                     | —                   |
| `upsertNodes`    | `logseq.cli.upsertNodes`    | batched add/edit of page/block/tag/property; `dry-run`; validated; undoable | **yes**             |

`upsertNodes` operation shape (from the tool description in `mcp_server.cljs`):

- `:operation` `add`|`edit`, `:entityType` `block`|`page`|`tag`|`property`
- `:id` — string uuid for `edit`; temp string for `add` when referenced by later ops
- `:data` keys: `:title`, `:page-id` (required to add a block), `:tags`
  (uuid list), `:property-type`, `:property-cardinality`, `:property-classes`,
  `:class-extends`, `:class-properties`

### Known MCP gaps (and the roadmap that closes them)

1. **Nested block children** — `getPage` returns top-level only; there is no
   "get children" tool. **This is the one real gap for this plan, and it is a
   known roadmap item, not a design boundary.** Per the official MCP server PR
   ([logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), merged
   Oct 29 2025), the maintainer lists under "features that will come later":
   "block children - reading and writing," and the approving review lists
   `getBlock - include children` (plus `getManyBlocks` / `getManyPages` batch
   reads) under "still need to be added." As of this writing (June 2026) those
   tools are **not yet implemented** in the shipped tree (`mcp_server.cljs`
   defines only the six tools above; `getBlock`/`getManyBlocks` appear nowhere).
   So: nested reads are **planned, with a named tool, from the server's owner,
   against an actively-maintained server** — but undated. The plan designs for
   top-level-only indexing now and upgrades to `getBlock` when it ships (see
   §5). **The `logseq` CLI is not a fallback for this** (§3).
2. **Property _values_ on nodes** — `upsertNodes` defines properties and
   assigns tags, but does **not** set arbitrary property values on a block
   (e.g. `:status`, `:due-date`) via MCP. Same roadmap source as #1 lists "read
   and writing of properties for any node type" and "anything related to
   namespaces or property values" as coming-later. So property values are
   **deferred until MCP ships a setter** — not bridged via the CLI (§3). The
   deferral is also a design choice (avoid premature schema); see §6.

   Separately: **Logseq ships a native semantic-search subsystem** that this
   section previously didn't mention. When the user setting
   `:feature/enable-semantic-search?` is on, MCP `searchBlocks` already
   returns vector-ranked hybrid results from a zvec index + a local
   `all-MiniLM-L6-v2` embedding server
   (`src/electron/electron/embedding_server.cljs`,
   `src/electron/electron/configs.cljs:51`,
   `src/main/frontend/state.cljs:554`). The plan's decision is to **build the
   sidecar and disable native semantic search** — see §5 "Native semantic
   search" and `vector-logseq.md` §6a–6b.
3. No arbitrary Datalog. (The CLI exposes Datalog via `logseq query`, but the
   CLI is not reachable from the VM — §3. So in practice this plan has no
   Datalog escape hatch; it works within the MCP tool surface.)
4. No namespaces/property-values handling (same roadmap as #2).

### Mental model: MCP page vs. markdown document

For an agent coming from the Obsidian-style "markdown files on disk" pattern,
the adaptation cost is low **provided you think in "pages of atomic notes"
rather than "markdown documents."** Two concrete differences:

1. **Atomic bullets, not prose blobs.** A Logseq DB page is an _outliner_: the
   atomic unit is a bullet (`:block/title`), each with its own stable UUID and
   timestamps. There is no `:block/content`, no markdown frontmatter block, no
   free-form document body. So `getPage` returns a page as a list of
   individually-addressable text units, not a markdown string. For an agent
   _maintaining_ a KB this is a **feature**: every fact is independently
   editable, linkable, and retrievable, and the vector sidecar keys off exactly
   these UUIDs. An agent that "thinks in atomic notes" maps onto MCP almost
   perfectly; an agent expecting to read/rewrite a whole `.md` file body does
   not.

2. **Hierarchy is flattened on read.** The underlying `blocks->vec-tree` builds
   a nested tree, but `get-page-data` strips `:block/children` from each
   returned block — so a page like

   ```
   - Top bullet
     - Nested point A
     - Nested point B
   - Another top bullet
   ```

   is returned as `["Top bullet", "Another top bullet"]`; the nested points are
   invisible unless fetched separately. A markdown file gives you the whole
   tree in one read. This is the one place MCP reads are **not** a drop-in for
   "read the markdown file." **There is no MCP-side mitigation today** — the
   plan indexes top-level blocks only and authors flat (see §5 and the build
   order). When Logseq ships `getBlock - include children` (planned, per
   [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111); not yet
   implemented as of June 2026), the plugin's read interface upgrades to full
   trees with no rewrite — design that interface now (a single `fetch_block_tree`
   call that today returns top-level and later returns nested). Writes have no
   equivalent gap: `upsertNodes` adds blocks to a page by `:page-id`, and
   nested writes are a recursive sequence of add-block ops (covered in phase 5
   of the build order).

**Net:** if the KB is mostly flat top-level bullets, MCP alone is ~zero
friction vs. markdown. If it leans on nesting, the cost is real and **not
bridgeable today** — nested reads are blocked on Logseq shipping `getBlock`
(planned, undated). The recommended authoring model is "atomic note per top-level
bullet," which is both what Logseq DB is and what suits an agent-maintained,
MCP-only KB best. Either way, prefer flat authoring; the plugin should not assume
nested reads exist.

---

## 3. Host-side networking (de-risk first)

The MCP/HTTP server defaults to loopback and has strict DNS-rebinding
protection, so exposing it to the VM needs explicit config. Verified at
`src/electron/electron/server.cljs` (`get-host`/`get-port` default
`127.0.0.1:12315`) and `src/electron/electron/mcp_server.cljs`
(`:allowedHosts #js [(str host ":" port)]`, `:enableDnsRebindingProtection true`).

Steps:

1. In Logseq, set the HTTP server host to the VM-facing interface
   (`0.0.0.0` or the host's bridge IP) and pick a port (e.g. keep `12315`).
2. Set the MCP transport's `allowedHosts` to the **`Host` header the VM will
   send** — i.e. the host IP/hostname the VM resolves, plus the port:
   `<vm-facing-host>:<port>`. Mismatch = request rejected as a rebinding attack.
3. Create a Bearer auth token (MCP server requires it) — mandatory once
   non-loopback.
4. Open the port on the host firewall for the VM bridge only.

VM-side probe (validates the whole network path before any plugin work):

```bash
curl -sS -X POST http://<host-ip>:12315/mcp \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
                 "clientInfo":{"name":"probe","version":"0"}}}'
```

A successful initialize response (with an `mcp-session-id` header) means the
foundation is real. Then issue `tools/call` with `listPages` to confirm a graph
read round-trips. **Do this before writing the plugin.**

### No CLI fallback (and why)

The `logseq` CLI is **not a fallback path** for this plan, for two independent
reasons — either one is disqualifying:

1. **The CLI is localhost-only; it cannot be a VM network client.** The CLI is
   an HTTP client to a **local** `db-worker-node` that it spawns and manages.
   Verified in source: discovery pings `127.0.0.1` only
   (`src/main/logseq/cli/server.cljs:243` `fetch-healthz {:host "127.0.0.1"
   :port port}`); `ensure-server!` calls `spawn-server!` with a **local script
   path** and **local repo dir**; `transport/invoke` builds its base-url from
   the locally-spawned daemon's host/port. There is **no** `--host`/`--token`/
   `--server-url` flag, no `LOGSEQ_CLI_HOST/PORT/SERVER` env var, and no remote-
   client config key anywhere in `src/main/logseq/cli/` (grep returns zero
   matches). So `logseq query --host <host-ip> …` from the VM is not a real
   command — the flag doesn't exist. Making the CLI talk to a remote db-worker
   would require patching Logseq, not config.
2. **Any VM→host shell/exec channel is rejected by the isolation model.** The
   remaining way to use the host's CLI from the VM would be SSH or a host-side
   exec shim. SSH-from-VM-to-host gives the isolated VM an interactive shell
   into the host, negating the entire purpose of the Firecracker VM (the
   blast-radius boundary exists so the agent cannot reach the host's execution
   surface). A host-side HTTP shim wrapping `logseq query` is less dangerous
   than SSH but still adds host-side glue the user must install and maintain —
   which defeats the goal of a **portable plugin that works on any Logseq
   install with the MCP server enabled**.

**Therefore: the plugin is MCP-only.** The VM's reachable surface is exactly
**outbound HTTP to the host's MCP endpoint** — no inbound, no shell, no SSH, no
host-side shim to install. The consequences, accepted deliberately:

- **Nested block reads are not available** until Logseq ships `getBlock -
  include children` via MCP (planned per
  [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), not yet
  implemented as of June 2026). The plan indexes top-level blocks only and
  authors flat (§5). No CLI workaround.
- **Retraction detection does not need the CLI.** MCP `searchBlocks` already
  filters deleted/recycled blocks out of its results (it pulls
  `:logseq.property/deleted-at` and applies `hidden-entity?`, which checks
  `deleted-at` and walks `:block/parent` — `search.cljs:607,1000`,
  `entity_util.cljs:64-66`). So "UUID no longer returned by `searchBlocks`/
  `getPage`" is a valid retraction signal under MCP-only. See §5.
- **Property values are deferred** until MCP ships a setter (same roadmap as
  `getBlock`). Not bridged via CLI `upsert --update-properties`. See §6.
- **No arbitrary Datalog.** The plan works within the six MCP tools; there is
  no Datalog escape hatch from the VM.

This keeps the plugin portable (zero host glue) and the VM's attack surface
minimal. The single gating probe is the MCP curl probe above — nothing else
---

## 4. Pi plugin scope (build on the working endpoint)

The plugin is a thin MCP client + KB-shaped tool surface + guardrails. It does
**not** touch SQLite directly.

### Read tools (wrap MCP)

- `kb_list_pages` → `listPages`
- `kb_get_page` → `getPage` (present top-level blocks readably; expose uuid+title+updated_at)
- `kb_find_notes` → `searchBlocks` (term search over blocks)
- `kb_list_tags` / `kb_list_properties` → list tools
- `kb_get_page_tree` _(plugin-level)_ → returns a block tree for a page.
  **Today: top-level only** — `getPage` strips `:block/children`, MCP has no
  get-children tool, and the CLI is not a fallback (§3). So this returns the
  same top-level blocks as `kb_get_page`, just shaped as a one-level tree.
  **When Logseq ships `getBlock - include children`** (planned per
  [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), not yet
  implemented), this tool upgrades to a full recursive tree with no plugin
  rewrite — it sits behind the same `fetch_block_tree` interface the indexer
  uses (§5). Design that interface now so the upgrade is a one-line backend
  swap, not a rewrite.

### Write tools (wrap `upsertNodes`, batched, dry-run-first)

- `kb_add_note` → add a block to a page (create page if missing); optional tags
- `kb_edit_note` → edit a block/page/tag title
- `kb_append_inbox` → append to a fixed "Inbox" page (frictionless capture)
- `kb_create_tag` / `kb_create_page` → declare structure once a pattern is observed

### Guardrails (the part that justifies a custom plugin)

- **Dry-run by default**: every write returns the planned diff; a separate
  `kb_commit` confirms. `upsertNodes` already supports `dry-run`.
- **No deletes from the agent**: plugin refuses delete ops; rely on Logseq's
  30-day recycle bin for safety.
- **Templates**: a small set of page templates the agent applies on creation,
  so notes have consistent shape without hand-rolling a property schema.
- **Auto index page**: plugin can regenerate a `KB Index` page (tags + recent
  notes) so you and the agent always have a graph map.
- **Structured property values deferred** — see §6.

---

## 5. Vector sidecar (RAG, keyed by UUID)

Design from `vector-logseq.md` is sound; verified against the live schema.
Adjustments for the host-DB / VM-agent split:

### Sidecar schema (`vectors.sqlite`, sqlite-vec)

- `block_embeddings` virtual table (`vec0`, dim = your embedder — **1024 for `BAAI/bge-m3`**, the chosen default; see "Native semantic search" below and `vector-logseq.md` §6a for model choice)
- `blocks_meta`: `uuid` (PK, = `:block/uuid`), `graph`, `page_uuid`,
  `page_title`, `title` (= `:block/title`, the embeddable text),
  `created_at`, `updated_at` (= `:block/updated-at`, drives incremental reindex),
  `embedded_at`, `model`, `dim`, `deleted` (tombstone)
- Indexes on `(graph, updated_at)` and `(graph, deleted)`

### Where it lives

- VM is fine (keeps embedding compute off the GUI machine); indexer reaches the
  host over the bridge. Or host sibling dir — either works. Keep it **out** of
  the graph directory so Logseq backup/restore can't clobber it.

### Indexing source — MCP only

- **The only path.** Iterate `listPages` → `getPage` each → embed each top-level
  block's `:block/title` with its `:block/uuid` + `:block/updated-at`. Covers
  **top-level blocks only**. There is no CLI alternative (§3) and no nested-
  read MCP tool yet.
- **Nested blocks are not indexed today.** This is the known gap: `getPage`
  strips `:block/children`, and `getBlock - include children` is planned but
  not yet shipped (per
  [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), as of
  June 2026). When `getBlock` ships, the indexer's `fetch_block_tree` helper
  upgrades from "top-level blocks of a page" to "full recursive tree" with no
  other change — design that helper behind one interface now. Until then,
  **author flat** (top-level atomic bullets) so top-level-only indexing is
  complete; nested bullets are invisible to retrieval.
- **Full-graph scan cost.** Indexing the whole graph is N `getPage` calls (one
  per page). Fine at personal-KB scale (hundreds to low-thousands of pages).
  The planned `getManyBlocks` / `getManyPages` batch-read MCP tools (same
  roadmap source) would collapse this to a few calls when they ship; until
  then, N `getPage` calls is the cost.

### Incremental + retraction (MCP-only)

- Reindex where `updated_at > embedded_at` (MCP `getPage` returns
  `:block/updated-at`; `remove-hidden-properties` keeps it).
- Tombstone UUIDs the source no longer returns (`deleted=1`); **periodic full
  sweep to detect retractions** — name the trigger explicitly: a systemd timer /
  cron / launchd job (e.g. hourly incremental + daily full sweep). Incremental
  alone cannot catch retractions.
- **Retraction detection works under MCP-only — no CLI needed.** The signal is
  "UUID no longer returned," and MCP `searchBlocks` is a valid existence probe
  because it **already filters deleted/recycled blocks out of its results**:
  its pull selector includes `:logseq.property/deleted-at`
  (`src/main/frontend/worker/search.cljs:607`) and the search worker applies
  `(remove hidden-entity?)` where `hidden?` checks `:logseq.property/deleted-at`
  and walks `:block/parent`
  (`deps/db/src/logseq/db/frontend/entity_util.cljs:64-66`,
  `search.cljs:1000`). So a recycled block's UUID disappears from `searchBlocks`
  results — exactly the "no longer returned" signal the tombstone logic wants.
  (`getPage` strips `:block/children` but does **not** strip `:block/uuid` or
  `:block/updated-at`, so per-page existence checks work too.) This corrects an
  earlier version of the plan that claimed retraction detection required the
  CLI `query` pull with `:logseq.property/deleted-at` — it doesn't.
- Model swap: re-embed rows where `model <> ?` (full re-embed — model choice is
  a schema decision; see `vector-logseq.md` §6a).

### Hybrid retrieval

- Semantic: `vec0` KNN over `block_embeddings` joined to `blocks_meta` by rowid.
- Keyword: Logseq's own `searchBlocks` (FTS5 trigram via the search worker) via
  MCP — **not** the CLI `search block` command (which is a lowercased-substring
  Datalog scan and emits no `:block/uuid`; see `vector-logseq.md` §5 for the
  corrected, authoritative example). No need to re-implement FTS5.
- Merge by UUID with **Reciprocal Rank Fusion (RRF)**:
  `score(d) = Σ 1/(k + rank_i(d))`, k ≈ 60. (Both sides return ranked lists, so
  go straight to RRF rather than a plain union.)
- Agent resolves a hit's UUID → fetch full context via `kb_get_page` /
  `kb_get_page_tree`.

### Native semantic search — decision: build the sidecar, disable Logseq's native

Logseq already ships a native semantic-search subsystem: an `embedding-server`
running `sentence-transformers` with model `all-MiniLM-L6-v2`
(`src/electron/electron/embedding_server.cljs:9`), backed by a `vector-index` at
`search/vector`, consulted by the search worker when the user setting
`:feature/enable-semantic-search?` is on (`src/electron/electron/configs.cljs:51`,
`src/main/frontend/state.cljs:554`, `src/main/frontend/components/settings.cljs:566`).
**When enabled, MCP `searchBlocks` already returns vector-ranked hybrid results**
— a capability this plan previously didn't account for.

**Decision: build the `vectors.sqlite` sidecar and keep
`:feature/enable-semantic-search?` off.** Full rationale in `vector-logseq.md`
§6a–6b; short version:

- The native index uses `all-MiniLM-L6-v2` (MTEB 56.3, ~4 years old, dead last
  among established retrieval models — meaningfully outdated). The sidecar uses
  `BAAI/bge-m3` (MTEB ~63.0).
- Native zvec is **not UUID-keyed**, so it can't join to `edges.sqlite` — which
  the gbrain-parity typed-edge graph (§9) requires. The sidecar is UUID-keyed.
- If both were on, two vector stores would rank the same blocks with different
  models/scores and `kb_find_notes`'s merge would be undefined. One ranking
  source of truth → native off.

This is a conscious choice, not an oversight: the UUID-keyed join to
`edges.sqlite` is the deciding factor. Keep the read path behind one interface
(`fetch_block_tree`) so a future Logseq MCP upgrade — `getBlock - include
children`, `getManyBlocks`/`getManyPages` batch reads, a UUID-keyed native
index — can swap in cheaply when those ship (roadmap per
[logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111)).

### Cross-sidecar freshness watermark

There are up to **four** derived indexes around this KB: KB vectors
(`vectors.sqlite`), KB typed edges (`edges.sqlite`), code chunks+edges
(`code_chunks.sqlite`/`code_edges.sqlite`, see `code-layer-plan.md`), and — if
it were enabled — Logseq's native zvec (disabled per above). Each carries its
own `embedded_at` / `indexed_at`. The synthesis/query layer treats the
**minimum** `embedded_at`/`indexed_at` across the sidecars it joins as the
"fresh as of" watermark for any cross-index result, and treats any join across
indexes of different freshness as _under-recall to be flagged by gap analysis_,
not a wrong answer. (Parallel statement in `code-layer-plan.md` §7.)

### Hard rules (from the schema, verified)

- **Never** add tables/columns to Logseq's `db.sqlite` — `search.cljs` owns
  `PRAGMA user_version` + FTS5 tables, GC rewrites them, backup/restore
  clobbers the file, db-sync never carries vectors. Sidecar only.
- **Never** bump `PRAGMA user_version` on `db.sqlite`.
- `:block/uuid` is `:db.unique/identity` → safe join key across re-indexes.

---

## 6. Structured property values — deliberately deferred

`upsertNodes` sets property _definitions_ and tags, not property _values_ on
blocks (e.g. `:status`, `:due-date`, `:source-url`) via MCP. This is a known
MCP gap with a named roadmap item: the official MCP server PR
([logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111)) lists "read
and writing of properties for any node type" and "anything related to
namespaces or property values" under "features that will come later." As of
June 2026 those are **not yet shipped** — `upsertNodes`'s `:data` keys remain
`:title`/`:page-id`/`:tags`/property-definition fields only.

**Note on the CLI:** the `logseq` CLI _does_ set property values today
(`upsert block --update-properties '{…}'`,
`src/main/logseq/cli/command/upsert.cljs:45,55,367-388,399-437`). But the CLI
is not reachable from the VM (§3 — localhost-only, and a host shim/SSH is
rejected for isolation + portability), so it is **not a bridge** for this
plan. Property values are deferred until MCP ships a setter, full stop.

Recommendation: **start with tags + page refs + hierarchy only.** You can't
design a property schema for knowledge you haven't captured yet; premature
typed fields ossify into friction. Design the plugin so property-value support
is a clean slot filled later when **a clear repeated need surfaces in your
actual notes** — then fill it once Logseq ships an MCP property-value setter
(never raw SQLite). The deferral is both a design choice (avoid premature
schema) and a current technical constraint (no MCP setter yet).

**Why this matters for §9:** §9 option-1 (typed edges as Logseq block
properties) is **not chosen for v1** — not because properties are impossible
in principle, but because (a) the MCP setter isn't shipped yet, and (b) even
when it ships, co-mingling a derived regex/NER-extracted graph with the
source-of-truth page store loses the "Logseq never touches files it doesn't
own" property. It remains a **future migration path** off the `edges.sqlite`
sidecar if Logseq property-values become first-class via MCP and you want the
edge graph inside the page store. The chosen path for v1 is the `edges.sqlite`
sidecar (§9 option-2).

---

## 7. Build order

1. **De-risk the network path (host-side).** Rebind MCP server to VM-facing
   iface; set `allowedHosts`; create token; run the §3 MCP curl probe from the
   VM. ~15 min. **Stops everything if this doesn't round-trip** — it's the only
   host surface the plugin has (CLI is not a fallback, §3; there is no headless
   MCP server, §8). Confirm the desktop app's MCP server is enabled in Settings
   → AI and that `tools/call listPages` and `tools/call searchBlocks` both
   round-trip (the latter validates the keyword leg of hybrid retrieval and the
   retraction-detection probe).
2. **Minimal plugin: read + safe write.** `kb_list_pages`, `kb_get_page`,
   `kb_find_notes`, `kb_add_note`, `kb_append_inbox` + dry-run-by-default
   policy. Validate against a throwaway test graph: agent reads, appends, you
   watch it appear in the GUI.
3. **Templates + index page + no-delete guardrail.** The KB-shape layer.
4. **Vector sidecar v1 (MCP-sourced, top-level).** `vectors.sqlite` +
   indexer pulling via `listPages`→`getPage`; `hybrid_search` wired into agent
   retrieval.
5. **Nested coverage — blocked on Logseq.** `kb_get_page_tree` and nested
   block indexing are **not available** until Logseq ships `getBlock - include
   children` via MCP (planned per
   [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), not yet
   implemented as of June 2026). There is no CLI workaround (§3). Until then:
   author flat (top-level atomic bullets), index top-level only, and keep the
   `fetch_block_tree` interface ready to upgrade. When `getBlock` ships, this
   step becomes "swap the backend of `fetch_block_tree` to `getBlock` and
   reindex" — no plugin rewrite.
6. **Property values** only when a concrete need appears **and** Logseq ships
   an MCP property-value setter (same roadmap as `getBlock`).

---

## 8. Risks / eyes-open

- **App must be running** for the agent to act (the MCP HTTP server lives in the
  desktop process — `src/electron/electron/mcp_server.cljs`, gated by the
  Settings → AI "MCP Server" toggle). There is **no headless MCP server** in the
  current tree. History: a `logseq mcp-server` CLI command was added Dec 2025
  (`9d49ba6`) exposing the same tool surface over a configurable `:host`/`:port`,
  but it was **removed May 28 2026** in the "remove old cli" cleanup
  (`52398ac7aa`, PR #12739) with no replacement in the new CLI tree
  (`src/main/logseq/cli/` has no `mcp_server.cljs` and `commands.cljs` has no
  `mcp` entry). The remaining `logseq server` command starts a `db-worker-node`,
  **not** an MCP HTTP server. So an earlier draft's "repoint the plugin at a
  CLI-started headless MCP server by changing one endpoint" is **wrong** — that
  endpoint no longer exists. Practical consequence: the plugin must be designed
  to **degrade gracefully when the desktop app is down** (queue writes, surface
  a "Logseq not running" status) rather than assume a headless endpoint. If
  headless operation becomes important, the options are: (a) wait for Logseq to
  re-ship a CLI MCP server (the removal looks like a tree-consolidation side
  effect, not a policy decision — the desktop server is actively maintained),
  or (b) run the desktop app headless on the host (Xvfb/Electron headless) so
  its in-process MCP server is up without a visible GUI. Neither is a plugin
  concern; keep the MCP endpoint address as the one configurable abstraction.
- **`allowedHosts` strictness** — if the VM's view of the host changes
  (IP/hostname), the MCP transport rejects until updated. Pin the VM-facing
  hostname.
- **MCP is page-scoped for reads** — full-graph block scans mean N `getPage`
  calls (one per page). Fine for personal KB scale; there is no Datalog escape
  hatch from the VM (CLI not reachable, §3). The planned `getManyBlocks` /
  `getManyPages` batch-read MCP tools (same roadmap as `getBlock`) would
  collapse this when they ship.
- **No vector sync** — db-sync/RTC never carries the sidecar. If you want RAG
  on multiple machines, replicate `vectors.sqlite` yourself (rsync/git-lfs).
- **MCP feature gaps may close** — the TODO list (nested children, property
  values) is active territory; re-check `src/electron/electron/mcp_server.cljs`
  and `src/main/logseq/api/db_based/tools.cljs` before bridging gaps manually.

---

## 9. gbrain-parity layer (typed edges, synthesis, dream cycle)

[GBrain](https://github.com/garrytan/gbrain) is a Postgres-native brain daemon
with three differentiators that sit on top of a notes+vector store: a synthesis
layer (cited prose _answers_ + "what the brain doesn't know yet" gap analysis),
a self-wiring typed-edge graph (`works_at`, `invested_in`, `attended`… extracted
by regex/NER with zero LLM calls), and an overnight dream cycle (enrich,
extract-facts, consolidate, citation-fix). Most of it ports onto this
architecture because the synthesis and dream-cycle logic is substrate-agnostic —
it's agent orchestration that reads/writes through an API. The vector sidecar in
§5 _is_ gbrain's `content_chunks`+pgvector layer.

### Component mapping

| gbrain component                                    | Logseq-side equivalent                                                                      | Ports?                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `pages` (markdown bodies)                           | Logseq DB pages/blocks via MCP `getPage`/`upsertNodes`                                      | ✅ clean (UUID-keyed)                           |
| `tags`                                              | Logseq tags (first-class in DB mode; MCP `listTags`)                                        | ✅ stronger than gbrain's flat tags             |
| `content_chunks` + pgvector + FTS                   | §5 vector sidecar (sqlite-vec by block UUID) + Logseq FTS5 (`searchBlocks`)                 | ✅ already designed                             |
| `links` (typed verb edges)                          | **new `edges.sqlite` sidecar — see below**                                                  | ⚠️ the one real lift                            |
| `page_versions` / `timeline_entries` / `ingest_log` | optional sidecar audit table, or lean on `:block/updated-at`                                | ✅ optional                                     |
| Synthesis layer (cited answers + gap analysis)      | pure LLM orchestration over `hybrid_search` + graph traversal — **zero storage dependency** | ✅ ports fully, written regardless of substrate |
| Dream cycle (overnight daemon)                      | external cron/systemd daemon calling MCP + sidecars — **substrate-agnostic**                | ✅ ports fully                                  |
| MCP server (`gbrain serve`)                         | this plan's Pi plugin over Logseq's MCP endpoint                                            | ✅ already in §4                                |

The headline: **the synthesis layer and the dream cycle — the bulk of gbrain's
code and its two biggest user-facing features — are substrate-agnostic.**
Swapping gbrain's Postgres engine for "Logseq MCP + sidecars" changes the I/O
calls, not the logic.

### The one real lift: typed verb edges

Logseq has page refs (`[[page]]`) and tags but **no native typed verb edge** —
gbrain's core moat ("who works at Acme?" queries). Three options:

1. As Logseq properties on blocks (`:works-at` node-type property → Acme).
   Cleanest in principle. **Not chosen for v1** because (a) the MCP server
   doesn't yet set property values (§6 — roadmap item, not shipped; the CLI
   can but the CLI is unreachable from the VM, §3), and (b) even when an MCP
   setter ships, it co-mingles a derived, regex/NER-extracted graph with the
   source-of-truth page store (loses the "Logseq never touches files it doesn't
   own" property) and bakes a verb schema into Logseq properties that's
   expensive to change once written into real blocks. It remains a **viable
   future migration path** off the `edges.sqlite` sidecar if Logseq
   property-values become first-class via MCP and you want the edge graph
   inside the page store. Revisit after the `edges.sqlite` graph is proven and
   a stable verb set exists.
2. **As a sidecar `edges.sqlite`** (`from_uuid`, `to_uuid`, `verb`, `context`,
   `source`) populated by the same regex/NER gazetteer gbrain uses, running over
   block text pulled via **MCP** (`getPage` top-level blocks today; `getBlock`
   with children when it ships). Keyed by the same `:block/uuid`s the
   vector sidecar uses. ✅ **The chosen call for v1.** It's exactly what gbrain
   does — the typed-edge graph is a _derived index over prose_, same as
   vectors. Keeps it external to the page store (Logseq never touches a file it
   doesn't own, same principle as the vector sidecar); the regex/NER extraction
   is deterministic and cheaply rebuildable, so the sidecar is an expendable
   build artifact. Lift gbrain's verb set + regex shapes from
   `src/core/extract-ner.ts` and `src/core/schema-pack/link-inference.ts`.
   Rationale: the reason is separation-of-concerns + rebuildability, **not**
   "properties are impossible" (the MCP setter is just not shipped yet — §6).
3. As verb-as-tag (`#works-at/acme`). Hacky, loses the to-UUID link. ❌

So: add **one more sidecar** (`edges.sqlite`) + a graph-traversal query layer
over it. Shares infrastructure with the vector indexer — the same
`fetch_block_tree` MCP helper (§5) that both the vector indexer and the NER
extractor call. Today that helper returns top-level blocks per page (so the NER
extractor sees top-level block text only, same coverage as the vector sidecar);
when `getBlock - include children` ships, both upgrade to full nested text in
one swap.

### What does NOT port / where Logseq is weaker

- **Outliner vs. prose.** gbrain's `compiled_truth` is prose; its chunkers split
  paragraphs. Logseq DB pages are atomic bullets — _better_ for retrieval
  precision, but synthesis groups context per-bullet. Modeling choice, not blocker.
- **No Postgres.** Lose pgvector HNSW (sqlite-vec KNN is fine at personal scale,
  slower at 146K pages), JSONB (SQLite JSON is weaker), PG triggers (logic moves
  into the indexer). **Scale caveat:** hundreds-to-low-thousands of pages is a
  non-issue; at gbrain's 146K-page scale sqlite-vec KNN becomes the bottleneck
  and you'd want a real vector DB. Personal brain — fine.
- **Multi-source + multi-tenant access control.** gbrain's `sources` table +
  per-login scoping (the "company brain" feature) has no Logseq analog. Personal
  brain — skip. If ever needed, build from scratch.
- **Code/symbol indexing.** gbrain indexes code as `page_kind='code'` pages.
  On this architecture, code intelligence is a **separate sibling layer**, not
  part of the Logseq graph — see [`code-layer-plan.md`](code-layer-plan.md).
  It unifies with this KB at the synthesis step (§10 of that doc / below).

### Unifying the layers at the synthesis step

The synthesis layer is the **one place** the KB (this plan) and the code
intelligence layer (`code-layer-plan.md`) meet — at query time, by symbol name,
never in storage. A query like "why is `loadConfig` async and what breaks if I
make it sync?" pulls in parallel: code-def + code-callers (code layer) +
`searchBlocks`/backlinks for `loadConfig` (KB layer), then synthesizes a cited
answer with a gap note. **The cross-layer relationship is never stored; it's
discovered at query time by name; gap analysis absorbs the seams.**

### Build order (extends §7)

1. **`edges.sqlite` sidecar + regex/NER extractor** over block text (typed-edge
   graph — gbrain's moat, as a derived index). Shares the "pull full page text"
   helper with the vector indexer.
2. **Graph-traversal query layer** over `edges.sqlite` ("who works at Acme?"
   answers, by UUID).
3. **Synthesis pipeline** — LLM orchestration over `hybrid_search` + graph
   traversal → cited prose + gap analysis. Substrate-agnostic; gbrain's headline
   feature, "just" agent code. This is also the step that unifies with the code
   layer per [`code-layer-plan.md`](code-layer-plan.md) §10.
4. **Dream cycle daemon** — cron phases (enrich, extract-facts, consolidate,
   citation-fix) calling the above + MCP writes. The bulk of gbrain's code,
   fully portable.

The inversion is clean: gbrain is "one Postgres holds everything"; this is
"Logseq DB holds pages/blocks/tags/refs, sidecars hold vectors + typed-edges +
audit + code, an external daemon does synthesis + dreams." Better separation —
and everything that touches Logseq goes through the validated MCP path with
undo, so the agent can't corrupt the graph.
