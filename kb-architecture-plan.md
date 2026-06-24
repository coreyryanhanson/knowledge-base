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
individual blocks (UUID + title + timestamps). For a vector index you can pull
top-level blocks per page via MCP. For full nested-block coverage or arbitrary
Datalog, use the `logseq` CLI `query` over the same network path.

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
│   └─ MCP client → host endpoint over the network bridge
│        writes: upsertNodes (dry-run-first)
│        reads:  listPages / getPage / listTags / listProperties / searchBlocks
├─ vector sidecar: vectors.sqlite (sqlite-vec)
│   └─ indexer pulls blocks from host (MCP top-level, or CLI query for nesting)
│   └─ hybrid_search() feeds agent retrieval
└─ (optional) logseq CLI client → host graph, for arbitrary Datalog pulls
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

### Known MCP gaps (still true despite the strong block read/write)

1. **Nested block children** — `getPage` returns top-level only. No
   "get children" tool. Reconstructing a full outliner tree needs the CLI
   `query` (Datalog pull with `{:block/page ...}` + `:block/children`) or a
   recursive walk you implement yourself.
2. **Property _values_ on nodes (MCP only)** — `upsertNodes` defines
   properties and assigns tags, but does **not** set arbitrary property values
   on a block (e.g. `:status`, `:due-date`) via MCP. **Note: this is an MCP-path
   gap, not a hard block** — the CLI `upsert block --update-properties '{…}'`
   and `upsert page --update-properties '{…}'` commands set property values
   today (`src/main/logseq/cli/command/upsert.cljs:45,55,367-388,399-437`). So
   the deferral in §6 is a **design choice** (avoid premature schema), not a
   technical impossibility; the bridge exists now via the same CLI path the
   plan already uses for nesting. See §6.

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
3. No arbitrary Datalog (use CLI for that).
4. No namespaces/property-values handling.

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
   "read the markdown file." Mitigation: the CLI `query` path (Datalog pull with
   `:block/children`) reads the full tree in one call — see §5 "Indexing source"
   and the `kb_get_page_tree` tool in §4. Writes have no equivalent gap:
   `upsertNodes` adds blocks to a page by `:page-id`, and nested writes are a
   recursive sequence of add-block ops (covered in phase 5 of the build order).

**Net:** if the KB is mostly flat top-level bullets, MCP alone is ~zero
friction vs. markdown. If it leans on nesting, the cost is one CLI fallback for
reads + recursive writes — bounded, and already in the plan. Either way, prefer
"atomic note per bullet" as the authoring model; it is both what Logseq DB is
and what suits an agent-maintained KB best.

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

### CLI-over-bridge probe (separate auth surface — de-risk in the same step)

The plan relies on the `logseq` CLI `query` for nested-block reads and
retraction detection (`:logseq.property/deleted-at`). The CLI is a **separate
process/transport from the MCP HTTP server** — it talks to the same desktop app
but via a different path, so the §3 MCP probe above does **not** cover it. This
was previously hand-waved in §4 (`kb_get_page_tree`) and §5 ("Indexing source —
CLI path"); make it explicit now.

Two viable shapes — pick whichever the CLI actually supports (verify with
`logseq query --help` / `logseq --help` on the host before committing):

1. **CLI on the VM, pointed at the host.** Confirm the CLI accepts a remote
   `--host`/`--token` (or `--server-url`) against the desktop app's worker node,
   i.e. it can be a network client like the MCP path. If yes, the VM runs
   `logseq query --host <host-ip> --token <TOKEN> …` directly.
2. **CLI on the host, invoked over the bridge.** If the CLI can only open a
   local graph (no remote-client mode), run `logseq` **on the host** and invoke
   it from the VM over SSH / a bridge exec helper: `ssh host logseq query …`.
   The VM never opens the graph file; the host CLI does.

Probe (run from the VM, covers both shapes):

```bash
# Shape 1: CLI-as-network-client (preferred if supported)
logseq query --host <host-ip> --token <TOKEN> --graph <graph> \
  --output json --query '[:find ?e :where [?e :block/uuid]]' | head -c 200

# Shape 2: host-CLI-over-SSH (fallback)
ssh <host> 'logseq query --graph <graph> --output json \
  --query "[:find ?e :where [?e :block/uuid]]"' | head -c 200
```

A JSON array response confirms the CLI path round-trips for nested pulls. Fold
this probe into build-order step 1 alongside the MCP curl probe — **do not
start the indexer or `kb_get_page_tree` until both the MCP and CLI paths are
confirmed**, because retraction detection and full-tree reads both depend on
the CLI path.

---

## 4. Pi plugin scope (build on the working endpoint)

The plugin is a thin MCP client + KB-shaped tool surface + guardrails. It does
**not** touch SQLite directly.

### Read tools (wrap MCP)

- `kb_list_pages` → `listPages`
- `kb_get_page` → `getPage` (present top-level blocks readably; expose uuid+title+updated_at)
- `kb_find_notes` → `searchBlocks` (term search over blocks)
- `kb_list_tags` / `kb_list_properties` → list tools
- `kb_get_page_tree` _(plugin-level)_ → recursive walk to rebuild a nested
  tree. Caveat: MCP has no get-children, so this either (a) limits depth to
  top-level, or (b) shells out to the host `logseq query` CLI over the bridge
  for a Datalog pull with `:block/children`. Recommend (b) when nesting matters.

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

### Indexing source — choose by coverage need

- **MCP path (simple, one channel):** iterate `listPages` → `getPage` each →
  embed each top-level block's `:block/title` with its `:block/uuid` +
  `:block/updated-at`. Covers **top-level blocks only**. Good enough to start.
- **CLI path (full nesting):** `logseq query --output json --query '<Datalog
pull including {:block/page ...} and :block/children>'` run against the host
  graph over the bridge. Covers nested blocks. Use when you want every block
  indexed, or when you need attrs MCP strips (e.g. `:logseq.property/deleted-at`
  for recycled-block filtering).
- Recommend: **start MCP, move to CLI query only when top-level coverage is
  insufficient.** One auth/network path to maintain first.

### Incremental + retraction

- Reindex where `updated_at > embedded_at` (MCP `getPage` returns
  `:block/updated-at`; `remove-hidden-properties` keeps it).
- Tombstone UUIDs the source no longer returns (`deleted=1`); **periodic full
  sweep to detect retractions** — name the trigger explicitly: a systemd timer /
  cron / launchd job (e.g. hourly incremental + daily full sweep). Incremental
  alone cannot catch retractions.
- **Retraction detection needs the CLI path.** `:logseq.property/deleted-at` is
  how recycled blocks are identified (`src/main/logseq/cli/command/search.cljs`
  walks `{:block/parent …}` to drop them), but MCP `getPage` strips it. So even
  if indexing uses the MCP path, the retraction sweep must use the CLI `query`
  pull (with `:logseq.property/deleted-at`) — this is the concrete reason the
  CLI-over-bridge probe (§3) is a build-order gate, not optional.
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
`edges.sqlite` is the deciding factor. Keep the MCP/CLI choice behind one
interface so a future Logseq MCP upgrade (nested children, property values, a
UUID-keyed native index) can swap in cheaply.

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

## 6. Structured property values — deliberately deferred (by design, not blocked)

`upsertNodes` sets property _definitions_ and tags, not property _values_ on
blocks (e.g. `:status`, `:due-date`, `:source-url`) via MCP. **Important:**
this is an **MCP-path gap, not a hard block.** The CLI `upsert block
--update-properties '{…}'` and `upsert page --update-properties '{…}'` commands
set property values today
(`src/main/logseq/cli/command/upsert.cljs:45,55,367-388,399-437` — parses an
EDN map → `:update-properties` and applies it). That is the **same CLI path the
plan already relies on for nested reads** (§5 "Indexing source — CLI path"),
so the bridge exists now.

Recommendation: **start with tags + page refs + hierarchy only.** You can't
design a property schema for knowledge you haven't captured yet; premature
typed fields ossify into friction. Design the plugin so property-value support
is a clean slot filled later when **a clear repeated need surfaces in your
actual notes** — then bridge via CLI `upsert … --update-properties` (never raw
SQLite). If/when Logseq ships property-value setting in the MCP server, swap the
bridge to MCP behind the same interface.

**Why this matters for §9:** because property values are reachable via CLI
today, §9 option-1 (typed edges as Logseq block properties) is **not** dead —
it's a viable **future migration path** off the `edges.sqlite` sidecar if
Logseq property-values become first-class and you want the edge graph inside
the page store instead of a derived index. The chosen path for v1 is still the
`edges.sqlite` sidecar (§9 option-2), but the reason is "derived index matches
the gbrain model and keeps Logseq untouched," **not** "properties are
impossible."

---

## 7. Build order

1. **De-risk the network path (host-side).** Rebind MCP server to VM-facing
   iface; set `allowedHosts`; create token; run the §3 MCP curl probe **and**
   the §3 CLI-over-bridge probe from the VM. ~15 min. **Stops everything if
   either doesn't round-trip** — the CLI path is required for retraction
   detection and nested reads (§5), so it's a gate, not optional. While you
   have a server up, also run the §8 headless-MCP-surface probe (one `curl
   tools/call upsertNodes` against a CLI-started server) to determine whether
   the "always-on agent" fallback is real or aspirational — that result shapes
   how much abstraction to put behind the MCP/CLI interface now.
2. **Minimal plugin: read + safe write.** `kb_list_pages`, `kb_get_page`,
   `kb_find_notes`, `kb_add_note`, `kb_append_inbox` + dry-run-by-default
   policy. Validate against a throwaway test graph: agent reads, appends, you
   watch it appear in the GUI.
3. **Templates + index page + no-delete guardrail.** The KB-shape layer.
4. **Vector sidecar v1 (MCP-sourced, top-level).** `vectors.sqlite` +
   indexer pulling via `listPages`→`getPage`; `hybrid_search` wired into agent
   retrieval.
5. **Nested coverage** (move indexer to CLI `query` when needed) and
   `kb_get_page_tree` via CLI.
6. **Property values** only when a concrete need appears.

---

## 8. Risks / eyes-open

- **App must be running** for the agent to act (MCP server lives in the desktop
  process). The previously-stated mitigation — "repoint the plugin at the
  CLI-started MCP server (headless) by changing one endpoint" — is **unverified
  and likely wrong as written**: the `logseq server` CLI command
  (`src/main/logseq/cli/command/server.cljs`) starts a `db-worker-node`, **not**
  the MCP HTTP server, so it is not a drop-in headless replacement for the
  desktop MCP endpoint. Whether a CLI-started process exposes the **same MCP
  tool surface** (incl. `tools/call upsertNodes`) as the desktop app is unknown
  and must be probed, not assumed. **Probe (fold into build-order step 1):**
  start whatever CLI server mode exists and issue a `curl … tools/call
  upsertNodes` with `dry-run: true`; if the tool is present and round-trips,
  the always-on path is real (keep the MCP/CLI choice behind one interface so
  the swap is cheap); if not, the "always-on agent" is a deferred dependency on
  a future Logseq feature, and the plugin should be designed to degrade
  gracefully when the desktop app is down (queue writes, surface a
  "Logseq not running" status) rather than assume a headless endpoint exists.
- **`allowedHosts` strictness** — if the VM's view of the host changes
  (IP/hostname), the MCP transport rejects until updated. Pin the VM-facing
  hostname.
- **MCP is page-scoped for reads** — full-graph block scans mean N `getPage`
  calls (one per page). Fine for personal KB scale; the CLI `query` is the
  escape hatch for bulk pulls.
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
   Cleanest in principle. **Not blocked** — the CLI `upsert block
   --update-properties` path sets property values today (§6, verified at
   `src/main/logseq/cli/command/upsert.cljs:45,55,367-388`). So this is a
   **viable future migration path** off the `edges.sqlite` sidecar if Logseq
   property-values become first-class (e.g. MCP gains a property-value setter)
   and you want the edge graph inside the page store. **Not chosen for v1**
   because (a) it co-mingles a derived, regex/NER-extracted graph with the
   source-of-truth page store (loses the "Logseq never touches files it doesn't
   own" property), and (b) it bakes a verb schema into Logseq properties that's
   expensive to change once written into real blocks. Revisit after the
   `edges.sqlite` graph is proven and a stable verb set exists.
2. **As a sidecar `edges.sqlite`** (`from_uuid`, `to_uuid`, `verb`, `context`,
   `source`) populated by the same regex/NER gazetteer gbrain uses, running over
   block text pulled via CLI `query`. Keyed by the same `:block/uuid`s the
   vector sidecar uses. ✅ **The chosen call for v1.** It's exactly what gbrain
   does — the typed-edge graph is a _derived index over prose_, same as
   vectors. Keeps it external to the page store (Logseq never touches a file it
   doesn't own, same principle as the vector sidecar); the regex/NER extraction
   is deterministic and cheaply rebuildable, so the sidecar is an expendable
   build artifact. Lift gbrain's verb set + regex shapes from
   `src/core/extract-ner.ts` and `src/core/schema-pack/link-inference.ts`.
   Rationale corrected from a prior version: the reason is the separation-of-
   concerns + rebuildability, **not** "MCP can't set property values" (it can,
   via CLI — see §6).
3. As verb-as-tag (`#works-at/acme`). Hacky, loses the to-UUID link. ❌

So: add **one more sidecar** (`edges.sqlite`) + a graph-traversal query layer
over it. Shares infrastructure with the vector indexer — a "pull full page text"
helper (CLI `query` with `:block/children`) that both the vector indexer and the
NER extractor call (already anticipated in phase 5).

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
