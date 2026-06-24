# KB Build Stages — Bringing the Vision to Fruition

A single, end-to-end stage plan for the personal knowledge base: a Logseq DB
graph on the host, a Pi agent in a Firecracker VM reading/writing it over MCP,
sidecar vector + typed-edge + code indexes, and a synthesis/dream-cycle layer
on top.

This document is the **sequencing layer** that ties the four existing plans
together. It is authoritative for *what order to build things in*. For *how
each thing works*, defer to the relevant plan:

- Architecture (topology, MCP surface, guardrails, sidecars):
  [`kb-architecture-plan.md`](kb-architecture-plan.md)
- Vector sidecar design + indexer: [`vector-logseq.md`](vector-logseq.md)
- Code intelligence layer: [`code-layer-plan.md`](code-layer-plan.md)
- Upstream Logseq PR (nested reads, parallel track):
  [`logseq-getblock-pr-plan.md`](logseq-getblock-pr-plan.md)

**Critical-path invariant:** MCP-only. The Logseq CLI is not a fallback (it is
localhost-only; VM→host shell/SSH is rejected by the isolation model). There is
no headless MCP server (`logseq mcp-server` was removed May 2026). Everything
goes through the desktop app's MCP HTTP endpoint over the Firecracker bridge.

---

## Decisions already locked (these shape every stage)

- **MCP-only.** No CLI fallback, no SSH, no host-side shim. The desktop app must
  be running; plugin degrades gracefully (queues writes, surfaces status) when
  it isn't.
- **Agent surface = high-level `kb_*` tools only.** Raw Logseq MCP is an
  internal `McpClient`, never registered as agent tools. Guardrails (dry-run-by-
  default, no-delete, templates) live in the `kb_*` `execute()` layer — they are
  an enforced boundary, not advisory text.
- **Embedding model = `BAAI/bge-m3` (dim 1024).** Logseq's native
  `all-MiniLM-L6-v2` is outdated (MTEB 56.3); native semantic search is
  **disabled** in favor of the sidecar (UUID-keyed join to `edges.sqlite`,
  single ranking source of truth).
- **Sidecars are rebuildable caches.** `vectors.sqlite`, `edges.sqlite`,
  `code_chunks.sqlite`, `code_edges.sqlite` are derived and expendable; the
  source of truth is Logseq's `db.sqlite` and code on disk. Never touch
  `db.sqlite`, never bump `PRAGMA user_version`.
- **`fetch_block_tree` single seam.** Today returns top-level blocks per page
  (via `getPage`); upgrades to full recursive trees (via `getBlock`) when it
  ships upstream — no plugin rewrite.

---

## Stage 0 — De-risk the network path (GATE)

**Goal:** a reachable MCP endpoint over the Firecracker bridge.

**This is a hard gate.** If it doesn't round-trip, nothing downstream is
testable. Do it before writing a line of client code.

- Firecracker VM image exists; bridge is up.
- On the host: Logseq desktop app installed, a throwaway **test graph** created,
  MCP server enabled in Settings → AI, server rebound to the VM-facing
  interface, `allowedHosts` set to the `Host` header the VM will send, Bearer
  token created, host firewall opened for the bridge only.
- From the VM, run the `kb-architecture-plan.md` §3 probe:
  - `initialize` JSON-RPC round-trips (validates transport + auth).
  - `tools/call listPages` returns pages (validates a graph read).
  - `tools/call searchBlocks` returns blocks (validates the keyword leg of
    hybrid retrieval and the retraction-detection probe — both depend on
    `searchBlocks`).
- Confirm the graph you'll test against is **not** your real KB. Use a throwaway
  graph until the write path is proven safe.

**Exit criteria:** all three round-trips succeed from the VM against the test
graph. ~15 min of config; longer if the VM image doesn't exist yet.

**Decide before exiting Stage 0:** where `McpClient` lives so the plugin tools
and the sidecar indexers share transport logic. Recommended: a thin
duplicated-on-purpose client in two places (one inside the Pi extension for
tools, one in the Python indexer) rather than forcing the indexer to depend on a
Node extension. The transport is trivial; duplication is cheaper than a
cross-language dependency.

---

## Stage 1 — Internal `McpClient` module

**Goal:** a thin, tested JSON-RPC client over the confirmed endpoint. Not
registered as agent tools — internal foundation.

- JSON-RPC `initialize` / `tools/call` envelope; Bearer auth; `mcp-session-id`
  handling; reconnect-on-failure; sane timeouts.
- 1:1 Logseq surface methods: `listPages`, `getPage`, `searchBlocks`,
  `listTags`, `listProperties`, `upsertNodes` (with `dry-run`).
- `fetch_block_tree(page)` seam: today = iterate `getPage` top-level blocks;
  designed to swap to `getBlock`-with-`includeChildren` later with no caller
  change.
- Config (endpoint URL, token, graph name) via settings, not hardcoded.
- Integration-tested against the test graph: read a page, search a block,
  dry-run an `upsertNodes` add-block op and confirm the planned diff comes back
  without committing.

**Exit criteria:** every method round-trips against the test graph; dry-run
writes return a diff and do not mutate the graph.

---

## Stage 2 — Minimal plugin: read + safe write (`kb_*` tools)

**Goal:** the agent can read the KB and append notes safely. The first user-
facing payoff — you watch the agent's writes appear in the Logseq GUI.

Register (via `pi.registerTool`) the minimal `kb_*` set, each backed by
`McpClient`:

- `kb_list_pages`, `kb_get_page`, `kb_find_notes` (read — wrap `listPages` /
  `getPage` / `searchBlocks`).
- `kb_add_note`, `kb_append_inbox` (write — construct `upsertNodes` ops).

Guardrails implemented in each write tool's `execute()`:

- **Dry-run by default:** every write returns the planned diff; a separate
  `kb_commit` confirms. `upsertNodes` already supports `dry-run`.
- **No deletes:** plugin refuses any delete op; rely on Logseq's 30-day recycle
  bin.
- Each tool gets a one-line `promptSnippet` and tool-specific `promptGuidelines`
  (kept small — context cost is real; ~8 tools total is the target ceiling).

**Exit criteria:** against the test graph, the agent reads a page, appends a
block, and the block appears in the Logseq GUI; a dry-run write does not
persist; a delete attempt is refused.

---

## Stage 3 — KB-shape layer (templates, index page, guardrail polish)

**Goal:** notes have consistent shape without a property schema, and you and the
agent always have a graph map.

- A small set of page templates the agent applies on creation.
- Auto-regenerated `KB Index` page (tags + recent notes) so the graph is
  navigable.
- `kb_edit_note`, `kb_create_tag`, `kb_create_page` added once patterns
  stabilize.
- Guardrail edge cases hardened (bad UUIDs, missing pages, oversized writes).

**Exit criteria:** the agent creates a templated page, the index page reflects
it, edits round-trip cleanly. At this point the **test graph → real graph**
cutover can happen (read + safe-write is proven).

---

## Stage 4 — Vector sidecar v1 (MCP-sourced, top-level)

**Goal:** semantic retrieval over the KB, hybrid with Logseq's FTS5.

- `vectors.sqlite` (sqlite-vec, `vec0` dim 1024) + `blocks_meta` schema per
  `vector-logseq.md` §2. Lives outside the graph dir so Logseq backup/restore
  can't clobber it.
- Indexer pulls via `listPages` → `getPage` (top-level blocks only for v1),
  embeds with `BAAI/bge-m3`, upserts keyed by `:block/uuid`. Uses its own thin
  `McpClient` (per the Stage 0 location decision).
- **Disable Logseq's native semantic search** (`:feature/enable-semantic-search?`
  off) — single ranking source of truth, UUID-keyed join to the future
  `edges.sqlite`.
- `hybrid_search`: semantic KNN ∪ keyword via MCP `searchBlocks` (FTS5), merged
  by **RRF** (`k ≈ 60`). Keyword leg uses `searchBlocks`, **not** the CLI
  `search block` command (see `vector-logseq.md` §5).
- Incremental: reindex where `updated_at > embedded_at`. Retraction via absence
  (UUID no longer returned by `searchBlocks` → tombstone) — verified under
  MCP-only.
- Wired into agent retrieval: a `kb_*` tool (e.g. `kb_semantic_search`) or the
  existing `kb_find_notes` upgraded behind the same interface.

**Exit criteria:** a query returns semantically + keyword-relevant blocks, cited
by UUID; incremental reindex only touches changed blocks; a deleted block stops
appearing after the sweep.

---

## Stage 5 — Nested coverage (BLOCKED on upstream Logseq)

**Goal:** full outliner-tree reads and nested-block indexing.

**This stage waits on Logseq shipping `getPage - includeChildren` (or a new
`getBlock` tool) via MCP** — planned per
[logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), not yet
implemented as of June 2026. There is no CLI workaround (MCP-only decision).

Until then: author flat (top-level atomic bullets), index top-level only,
`kb_get_page_tree` returns top-level-only with a documented "nested reads pending
upstream" caveat.

- **Parallel track (start now, non-blocking):** the upstream PR per
  [`logseq-getblock-pr-plan.md`](logseq-getblock-pr-plan.md). Implement
  `getPage - includeChildren` with `depth` cap (default 50, cap 100) + max-node
  cap + `truncated` markers + tests. Open the PR; keep scope to one capability.
  Do **not** daily-drive a patched fork — it's host glue with extra steps.
- **When the capability lands** (upstream merge + release, or last-resort fork):
  swap the backend of `fetch_block_tree` to `getBlock`, add `kb_get_page_tree`
  full-tree mode, reindex for nested coverage. No plugin rewrite — the seam was
  built for this in Stage 1.

**Exit criteria:** `kb_get_page_tree` returns a full nested tree respecting
`depth`; the vector index includes nested blocks; retraction still works via
absence.

---

## Stage 6 — Typed-edge sidecar (`edges.sqlite`) — gbrain's moat

**Goal:** self-wiring typed verb edges (`works_at`, `invested_in`, `attended`…)
by regex/NER with zero LLM calls. The one real gbrain-parity lift.

- `edges.sqlite` sidecar (`from_uuid`, `to_uuid`, `verb`, `context`, `source`),
  keyed by the same `:block/uuid`s the vector sidecar uses.
- Regex/NER extractor running over block text sourced via `fetch_block_tree`
  (same helper as the vector indexer — one pull path). Lift gbrain's verb set +
  regex shapes from `gbrain/src/core/extract-ner.ts` and
  `gbrain/src/core/schema-pack/link-inference.ts`.
- Graph-traversal query layer over `edges.sqlite` ("who works at Acme?" answered
  by UUID). Exposed as a `kb_*` tool (e.g. `kb_graph_query`).
- Deterministic and cheaply rebuildable — the sidecar is an expendable build
  artifact, same discipline as the vector sidecar.

**Exit criteria:** a traversal query returns typed-edge answers with block-UUID
provenance; re-running the extractor is idempotent.

---

## Stage 7 — Code intelligence layer (parallel-eligible with 4–6)

**Goal:** LSP-grade, semantically-searchable, call-graph-aware code index as a
sibling sidecar layer. Full plan: [`code-layer-plan.md`](code-layer-plan.md).

This stage is largely independent of Stages 4–6 and can run in parallel once
Stage 1's `McpClient` pattern is established (the code sidecar doesn't touch
Logseq at all — it indexes code on disk).

- Tree-sitter indexer over one language (TS first) → `code_chunks.sqlite` +
  embeddings (sqlite-vec). Validate `code-def`.
- Qualified-name + call-graph extraction → `code_edges.sqlite` + within-file
  resolver. Validate `code-callers` / `code-callees`.
- Query commands as Pi plugin tools: `code-def`, `code-refs`, `code-callers`,
  `code-callees`, `query --lang`.
- Staleness mechanics: `content_hash` watermark, tombstones, periodic sweep,
  synchronous reindex on the agent's own writes, async batched for bulk.
- Notes-side convention + symbol-alias table for renames.

**Exit criteria:** `code-def`/`code-callers`/`code-callees` round-trip on a real
repo; a code edit is reflected after reindex; staleness is flagged, not silent.

---

## Stage 8 — Synthesis layer (the payoff)

**Goal:** cited prose answers + "what the brain doesn't know yet" gap analysis,
over all three indexes, unified by symbol name at query time.

- Pure LLM orchestration over `hybrid_search` + graph traversal + code query —
  **zero storage dependency**. Substrate-agnostic; this is "just" agent code.
- The **one place** the KB and the code layer meet: at query time, by name,
  never in storage. A query like "why is `loadConfig` async and what breaks if I
  make it sync?" pulls code-def + code-callers + `searchBlocks`/backlinks in
  parallel and synthesizes a cited answer with a gap note.
- **Gap analysis makes the no-stored-relationship design safe:** when code
  returns but no notes match, it says "found the function; no notes on file"
  rather than silently giving a code-only answer. Under-recall becomes
  information, not a hidden failure.
- **Cross-sidecar freshness watermark:** the synthesis layer takes the minimum
  `embedded_at`/`indexed_at` across the sidecars it joins as the "fresh as of"
  watermark for any cross-index result.

**Exit criteria:** a cross-layer query returns a cited answer with a gap note;
stale indexes produce flagged under-recall, not wrong answers.

---

## Stage 9 — On-demand reconciliation + generation (no built-in scheduler)

**Goal:** bring derived indexes back in sync (maintenance) and reason over
accumulated material to write new synthesis/consolidated takes (generation) —
**on demand**, not on a cron. The plugin ships the *primitives*; scheduling is
a user-chosen deployment concern.

This replaces the earlier "external cron/systemd dream-cycle daemon" framing.
Two reasons it changed:

1. **The deployment target is an intermittently-running secure container.** A
cron job that fires at 02:00 is useless when the container is down — it just

doesn't run, silently, and the index drifts. A staleness signal is *honest*
about this; a scheduled job that can't fire is worse.
2. **gbrain itself separates primitive from scheduler.** `gbrain dream` is a
one-shot, phase-selectable command; `gbrain autopilot` is the scheduler. Both
call one `runCycle` primitive (`src/commands/dream.ts`). The plugin ships the
primitive; users who want unattended runs add their own cron/systemd one-liner.

The cycle's ~15 phases (see `gbrain/src/core/cycle.ts`) split into two buckets,
which become two commands:

### 9a. `kb_reconcile` — maintenance (LLM-free, idempotent, dry-run-capable)

The catch-up half: `sync`, `embed` (re-embed stale chunks), `extract`/
`extract_facts` (re-extract edges from changed text), `orphans`, `purge`,
`lint`, `backlinks`. These are idempotent reconcilers triggered by staleness,
and they *fix* staleness. They already key off `content_hash <> stored` /
`updated_at > embedded_at` / absence — gbrain's own `embed --stale` walks
stale chunks. **No LLM, no new content** — just bring derived indexes back to
the source of truth.

- On-demand; phase-selectable (`kb_reconcile --phase embed,extract`).
- **Auto-runnable on container start** when the staleness signal (below)
exceeds a threshold — the agent reconciles before serving retrieval.
- Same dry-run-first, no-delete guardrails as ad-hoc `kb_*` writes.

### 9b. `kb_dream` — generation (LLM-driven, phase-selectable, dry-run-capable)

The thinking half: `synthesize` (LLM writes new synthesized takes),
`consolidate` (cluster + dedupe facts into consolidated takes), `enrich_thin`
(LLM flesh out sparse notes), `synthesize_concepts`. **Non-idempotent,
LLM-driven write passes that add new content** — not triggered by staleness;
run when you want the brain to reason over accumulated material.

- On-demand; phase-selectable (`kb_dream --phase synthesize,consolidate`).
- `--dry-run` to preview before mutating real notes (essential for a write
path — same guardrail principle as `kb_add_note`).
- This is gbrain's `dream` one-shot, ported onto the KB's sidecars.

### 9c. No built-in scheduler — by design

The plugin ships `kb_reconcile` and `kb_dream` as **commands/primitives**.
Users who want unattended overnight runs set up their own scheduler calling
them — e.g. `0 2 * * * pi kb_dream --json >> /var/log/kb-dream.log`. That's a
one-liner of *user* config, not a feature the plugin owns. This matches Pi's
"ship the primitive, not the deployment" philosophy (same as the MCP
decision) and gbrain's primitive/scheduler separation.

**Exit criteria:** `kb_reconcile` brings a deliberately-drifted sidecar back to
the source of truth idempotently with a dry-run preview; `kb_dream --phase
synthesize` writes a new synthesized take with citations and a gap note; both
respect guardrails; no scheduler ships in the plugin.

---

## Cross-cutting concerns (apply throughout, not a stage)

- **Retraction detection** via absence under MCP-only: a UUID that disappears
from `searchBlocks`/`getPage` results is a retraction → tombstone. A periodic
full sweep (`kb_reconcile`) catches what incremental misses — run on demand
or auto-triggered by the staleness signal, not on a fixed cron.
- **Staleness signal (first-class, not a side effect).** Every sidecar already
carries `embedded_at`/`indexed_at`/`content_hash`, and the synthesis layer
takes the min-watermark as "fresh as of" and flags under-recall (Stages 4/7/8).
Promote this to a first-class signal: on container start and on each retrieval,
compute "index is N stale (M blocks changed since last embed, K edges
unextracted)" and surface it — to the user as a status line, to the agent as
context ("retrieval may under-recall; last embed 3d ago"). This is the honest
primitive for an intermittently-running container: it says what's stale
instead of pretending a scheduled job has been maintaining things. It is the
trigger for `kb_reconcile` (Stage 9a) — auto-run when stale, or surface for a
manual call.
- **Model swaps are a schema decision.** Changing the embedding model requires a
  full re-embed (the `model`/`dim` columns exist for this). Set the model once,
  change deliberately.
- **Graceful degradation when Logseq is down.** No headless MCP server exists.
  Plugin queues writes and surfaces "Logseq not running" status; retrieval
  serves from sidecars (which remain valid until the next reindex needs the
  host).
- **Keep the MCP/CLI choice behind one interface.** A future Logseq MCP upgrade
  (nested children, property values, a UUID-keyed native index) should swap in
  cheaply. The `fetch_block_tree` seam is the canonical example.

---

## Critical path vs. parallel work, at a glance

```
Stage 0 (gate) ─► Stage 1 (McpClient) ─► Stage 2 (kb_* read+write) ─► Stage 3 (shape)
                                                                       │
                                                                       ├─► Stage 4 (vector v1) ─► Stage 5 (nested, blocked upstream) ─┐
                                                                       │                                                              │
                                                                       └─► Stage 6 (edges) ─────────────────────────────────────────┤
                                                                                                                                     ├─► Stage 8 (synthesis) ─► Stage 9 (reconcile + dream, on-demand)
                                                                       Stage 7 (code layer) ─────────────────────────────────────────┘
                                                                                                              (parallel from ~Stage 1)

PARALLEL (non-blocking, start now): the upstream getPage-includeChildren PR
per logseq-getblock-pr-plan.md — unblocks Stage 5, not the front of the path.
```

- **Front of path:** Stage 0 → 1 → 2 → 3. Nothing starts before the network
  gate; nothing user-facing exists before `McpClient` + the minimal `kb_*` set.
- **Fork after Stage 3:** vector sidecar (4), typed edges (6), and code layer
  (7) are largely independent and can proceed in parallel.
- **Single bottleneck:** Stage 5 (nested coverage) waits on upstream Logseq.
  Everything else builds on top-level-only fine; the seam absorbs the upgrade.
- **Convergence:** Stage 8 (synthesis) is where all three indexes meet; Stage 9
(reconciliation + generation) is the on-demand maintenance-and-thinking layer
on top of synthesis — no built-in scheduler; users add cron/systemd themselves
if they want unattended runs.
