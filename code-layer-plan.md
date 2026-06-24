# Code Intelligence Layer — Plan

A plan for giving a Pi agent LSP-grade, semantically-searchable, call-graph-aware
code intelligence over a codebase, kept as a **sidecar derived index** that lives
next to (not inside) the Logseq knowledge base. The two meet at query time by
symbol name, never in storage.

This doc stands alone, but it shares one concept with the sibling plan
[`kb-architecture-plan.md`](kb-architecture-plan.md): a **synthesis/query layer
that joins code and notes by symbol name at query time.** See §10.

---

## 0. TL;DR

- **What this is:** a derived index over a codebase — tree-sitter parses every
  file into symbol-level chunks, each chunk gets an embedding, and a call-graph
  table records which symbols call which. Enables semantic code search,
  structural precision (methods not comments), and call-graph traversal
  (`code-callers` / `code-callees`) across the whole repo.
- **Where the code lives:** on disk / in git, unchanged. The sidecars
  (`code_chunks.sqlite`, `code_edges.sqlite`) are rebuildable derived indexes,
  never the source of truth.
- **How it relates to the Logseq KB:** it doesn't, in storage. Notes about
  symbols live as ordinary Logseq blocks; the code sidecar has symbol rows.
  They share a name (e.g. `loadConfig`) as plain text and meet at query time in
  the synthesis step. No stored relationship, no sync to maintain between them.
- **Reference:** [gbrain](https://github.com/garrytan/gbrain) ships this exact
  layer (`src/core/chunkers/code.ts`, `code_edges_*` tables, `code-def` /
  `code-refs` / `code-callers` / `code-callees` commands). The hard IP
  (tree-sitter chunking, qualified names, the disambiguation resolver) is
  substrate-independent and ports directly; Postgres tables become SQLite
  sidecars.

---

## 1. What a symbol is

A **symbol** is any named, addressable unit of code that tree-sitter's grammar
recognizes as a discrete thing — broader than methods:

- Functions (standalone: `function loadConfig() {}`)
- Methods (functions on a class/struct: `UsersController.render`)
- Classes / structs / interfaces / types (`class BrainEngine`, `interface Config`)
- Enums and their variants
- Module-level constants and exported bindings (language-dependent)
- Top-level variables (in some grammars)

Tree-sitter decides "this is a symbol" by AST node type
(`function_declaration`, `method_definition`, `class_declaration`, …). Each
becomes one row in `code_chunks.sqlite` with a `symbol_type` column identifying
which kind.

**The unit of indexing is the symbol, not the file, not the line.** That's the
structural-precision advantage: "find methods named `render`" returns method
definitions, not the word `render` in a comment.

---

## 2. Symbols vs. notes — the asymmetry that makes the design work

Symbols vastly outnumber notes about them. A small file may have 20 symbols; you
may have notes about 2. A 50K-symbol codebase may have notes about 200 — the ones
you've actively reasoned about, made decisions about, hit bugs in. The other
~49,800 are indexed but never annotated in Logseq.

This is a feature, not a gap:

- **Symbol rows** are exhaustive, machine-generated, cheap. You index every
  symbol because you can't predict which a future query needs — the agent may
  ask "where is `parse` defined?" about a function you never noted. The code
  layer answers that from the symbol index alone.
- **Note blocks** are selective, human-/agent-authored, attention-expensive.
  You write one only when there's something worth saying — a decision, tradeoff,
  TODO, gotcha. Most symbols don't deserve a note (`readFile` is a stdlib
  wrapper; nothing to say). `loadConfig` has a story, so it gets one.

The relationship is one-to-many optional, symbols on the "many" side:

```
1 Logseq note block  ←── matches by name ──→  0 or 1 or many symbols
(most symbols)                                   (has a note)
```

The query-time join handles all cases:

- **Symbol with no note** → code layer returns definition + call graph;
  synthesis says "here's what it is and how it's wired; no notes on file"
  (gap analysis — surfaces unrecorded context rather than hiding it).
- **Symbol with a note** → both come back, synthesize together (the payoff).
- **Pure notes query (no code)** → notes layer alone; code layer not consulted.

---

## 3. Components (verified against gbrain)

### 3a. Tree-sitter semantic chunking (`chunkers/code.ts`)

36 WASM grammars (TS/JS/Python/Ruby/Go/Rust/Java/C/C++/etc.) parse each file
into an AST and emit one chunk per symbol with: `language`, `symbol_name`,
`symbol_type`, `start_line` / `end_line`, `parent_symbol_path`, `doc_comment`,
plus the chunk text that gets embedded. Pure function `code string → chunks[]`,
no DB dependency. WASM grammars bundle into the indexer binary (gbrain uses
Bun's `--compile` asset embedding).

### 3b. Qualified symbol names (`chunkers/qualified-names.ts`)

A **shared identity across languages** — the edge-identity join key:

- Ruby: `Admin::UsersController#render` (instance), `Admin::UsersController.find_all` (singleton)
- Python: `admin.users_controller.UsersController.render`
- TS/JS: `BrainEngine.searchKeyword` (class method), `parseInput` (standalone fn)
- Go: `users.Render` (package-qualified), `(*UsersController).Render` (pointer receiver)
- Rust: `users::UsersController::render` (impl-scoped)
- Java: `com.acme.admin.UsersController.render`

This is the single most important design decision for the code layer: **key on
qualified symbol name, not file path.** It turns file moves/renames into cheap
metadata updates instead of re-embeds (see §7).

### 3c. Call graph (`code_edges_chunk` + `code_edges_symbol`)

The edge extractor emits typed call edges between symbols
("chunk A calls symbol B"). A two-pass resolver
(`chunkers/symbol-resolver.ts`) disambiguates bare callee tokens — `render` →
`Admin::UsersController#render` vs `ViewHelper.render` — within a file.
Indexed both directions, so `code-callers` and `code-callees` are fast.

### 3d. Query commands

- `code-def <symbol>` — definition site(s): file, language, type, line range
- `code-refs <symbol>` — all usage sites (bypasses one-result-per-page collapse)
- `code-callers <symbol>` — who calls this (reverse call-graph walk)
- `code-callees <symbol>` — what does this call (forward walk)
- `query --lang` — semantic search filtered by language and symbol type

---

## 4. Sidecar schemas (`code_chunks.sqlite`, `code_edges.sqlite`)

Same pattern as the KB's vector sidecar (`vector-logseq.md`): a rebuildable
derived index keyed by stable identity, never touched by the source of truth.

### `code_chunks.sqlite` (sqlite-vec)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS code_embeddings USING vec0(embedding float[1536]);

CREATE TABLE IF NOT EXISTS code_chunks (
  rowid               INTEGER PRIMARY KEY,   -- joins to code_embeddings.rowid
  symbol_qualified    TEXT NOT NULL,         -- stable identity (§3b); join key
  symbol_name         TEXT NOT NULL,         -- short name, for substring/ILIKE
  symbol_type         TEXT,                  -- function|method|class|interface|...
  language            TEXT NOT NULL,
  file                TEXT NOT NULL,         -- metadata; NOT the identity
  start_line          INTEGER,
  end_line            INTEGER,
  parent_symbol_path  TEXT,                  -- scope, for qualified-name rebuild
  doc_comment         TEXT,
  chunk_text          TEXT NOT NULL,         -- the embedded body
  content_hash        TEXT NOT NULL,         -- file content hash; staleness check
  embedded_at         INTEGER NOT NULL,
  model               TEXT NOT NULL,
  dim                 INTEGER NOT NULL,
  deleted             INTEGER NOT NULL DEFAULT 0  -- tombstone
);

CREATE INDEX IF NOT EXISTS idx_chunks_symbol_qualified ON code_chunks(symbol_qualified);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name      ON code_chunks(symbol_name);
CREATE INDEX IF NOT EXISTS idx_chunks_stale            ON code_chunks(content_hash) WHERE deleted=0;
```

### `code_edges.sqlite`

```sql
CREATE TABLE IF NOT EXISTS code_edges_chunk (
  from_chunk_id  INTEGER NOT NULL REFERENCES code_chunks(rowid) ON DELETE CASCADE,
  to_chunk_id    INTEGER NOT NULL REFERENCES code_chunks(rowid) ON DELETE CASCADE,
  from_symbol    TEXT NOT NULL,
  to_symbol      TEXT NOT NULL,
  edge_type      TEXT NOT NULL,             -- 'calls' | ...
  edge_metadata  TEXT NOT NULL DEFAULT '{}',-- JSON: resolved|ambiguous|candidates
  created_at     INTEGER NOT NULL,
  UNIQUE(from_chunk_id, to_chunk_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON code_edges_chunk(from_symbol, edge_type);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON code_edges_chunk(to_symbol, edge_type);
```

(Mirror gbrain's `code_edges_symbol` table for unresolved short-name captures if
you want the two-pass resolver's full behavior.)

---

## 5. Use cases, concretely

1. **`code-def` — "what is this and where?"** One structured hit instead of grep
   - read-each-match. Agent reads the exact lines and answers.
2. **`code-refs` — "what uses this?"** Actual usage sites, not text matches.
   Knows the blast radius before a change.
3. **`code-callers` / `code-callees` — graph traversal grep can't do.** "If I
   change `UsersController.render`, what breaks?" — transitive callers across
   the repo. Forward: "what does `render` depend on so I know where to look?"
4. **`query --lang` — semantic + structural code search.** "Functions that
   retry" matches `withBackoff`, `attemptRecovery`, `retryAfter` (semantic, via
   vectors) filtered to `language=ts AND symbol_type IN (function, method)`
   (structural, via tree-sitter metadata). Grep can't do the semantic half;
   raw-file vector search can't do the structural half.
5. **Code + notes synthesis (the payoff).** "Why is `loadConfig` async, and
   what breaks if I make it sync?" → code-def + code-callers + notes about
   `loadConfig` retrieved together, synthesized into one cited answer with a
   gap note. The agent remembers your codebase _and_ your reasoning about it.

---

## 6. What a Logseq block about a symbol looks like

There is **no required format** and **no stored relationship to the code layer.**
You write notes naturally, with the symbol name as plain text:

```
Page: [[Config loading]]

- Decided to use async file reads for config loading because the config
  file lives on a network mount in production; sync reads blocked the
  event loop during cold start. See loadConfig.
  - Benchmarked it: cold start dropped from 800ms to 90ms.
- loadConfig currently doesn't validate the schema — add zod parsing
  before v2. TODO.
- [[loadConfig]] is called from main on boot and from the test runner.
```

Two cases for the symbol mention:

- **Plain text** ("See loadConfig.") — from Logseq's perspective the block is
  just text; no link, no backlink. An orphan, structurally. The connection to
  the code symbol exists nowhere in storage — only the synthesis layer, at
  query time, notices both mention the same name.
- **Page ref** (`[[loadConfig]]`) — Logseq sees a backlink to a page named
  `loadConfig`, which becomes a collection point for your reasoning about that
  symbol. Useful for browsing notes in Logseq. **But** that Logseq page has no
  structural connection to the code symbol — they share a name, nothing more.
  The bridge to code is still query-time by name.

**The block's job is the _why_, not the _what_.** The code layer stores what
`loadConfig` does (the body). Your note stores what code can't: reasoning,
decisions, tradeoffs, history, TODOs. Don't duplicate the code; annotate it.

A useful convention: give symbols you care about their own Logseq page
(`loadConfig`) and reference via `[[loadConfig]]`. That's a note-authoring
habit, not a schema change. The code layer never knows those pages exist.

---

## 7. Sync & staleness (the manage-the-risk part)

The sidecars are never the source of truth — code on disk / in git is. So "out
of sync" only ever means "the index is stale until the next reindex; a query may
under-recall." It's a quality-of-retrieval problem, not data integrity. Same
model as the KB vector sidecar.

The three things that drift, and the handling for each:

1. **Content changed, index not updated.** Watermark by `content_hash` (file
   blob SHA). `WHERE content_hash <> stored_hash` finds stale rows instantly;
   re-chunk + re-embed. (gbrain stores `content_hash` on pages and re-INSERTs
   chunks on change.)
2. **Source deleted, index still references.** Tombstone (`deleted=1`), never
   hard-delete-on-miss. Query layer filters `WHERE deleted=0`. Periodic full
   sweep catches retractions the incremental path missed. The query layer always
   reads live source state for anything it returns, so a tombstoned row can't
   serve a "deleted" answer — it just stops contributing to retrieval.
3. **Identity changed (move/rename).** Key on `symbol_qualified`, not file path
   (§3b). File move = metadata update on existing rows, no re-embed. Symbol
   rename = tombstone the old qualified name + create a new row with a fresh
   embedding (the name is part of the chunk text, so the vector changes even if
   the body is identical). Unavoidable but bounded.

### Recency gap

Between a code edit and the next reindex, queries can miss the change. **For the
agent's own writes:** reindex synchronously (the write path kicks off an
incremental reindex of that file before returning) so the agent never misses its
own change. **For external edits** (you editing, git pulls): a periodic sweep
catches them. **For bulk refactors:** don't reindex synchronously — mark stale,
reindex in the background, accept temporary under-recall (gbrain does exactly
this; `embed-stale.ts` is the async batched loop). Synthesis gap analysis
surfaces the recency seam rather than silently returning a wrong answer.

### Cross-sidecar consistency

Three sidecars (KB vectors, KB typed edges, code chunks+edges) derive from
different sources at different times, so a query joining across them can hit one
fresh and another stale. The synthesis layer treats under-recall as first-class:
it retrieves what's available and the gap section says what's missing. Stale
indexes produce _under-recall, flagged_, not _wrong answers_.

---

## 8. Scale & refactoring — honest costs

- **Initial indexing time.** Tree-sitter parsing is fast (ms/file); chunking
  50K symbols is a minute or two. **Embedding is the bottleneck** — API calls
  (rate-limited, costs money) or local inference (slow on CPU). One-time build
  is minutes to ~an hour at personal scale; incremental forever after. gbrain
  built rate-limit-aware batching, 429 backoff, resumable cursors
  (`embed-stale.ts`) for its 146K-page scale — you don't need that machinery at
  personal scale, but the patterns are worth copying if you grow.
- **Query latency.** sqlite-vec KNN is fine to ~100K vectors; above that, a real
  ANN index (HNSW via a dedicated vector DB). Not a personal-scale concern.
- **Refactor costs by type:**
  - File move/rename — **cheap** (qualified-name keying; metadata update only).
  - Single symbol rename — **medium** (one re-embed; the identity changed).
  - Mass rename (100 symbols) — 100 re-embeds; still seconds-minutes.
  - Big refactor (many files/symbols) — **async batched reindex with temporary
    under-recall**; don't block the write path.
- **The notes-side drift (specific to this architecture).** Rename
  `loadConfig` → `loadSettings` and your Logseq notes still say `loadConfig`.
  Queries for `loadSettings` under-recall the old notes until updated. Mitigations:
  (a) instruct the agent to update notes when it renames a symbol it knows is
  referenced in notes; (b) keep a symbol-alias table (old → new) populated on
  rename so queries map across; (c) accept it and rely on gap analysis. gbrain
  avoids this because notes and code share one store and update together; we've
  traded that convenience for the cleaner separation.

---

## 9. Build order

1. **Tree-sitter indexer over one language** (TS, since the agent runs on code
   like this repo). Chunk → `code_chunks.sqlite` + embeddings via sqlite-vec.
   Validate: `code-def` returns the right row for a known function.
2. **Qualified-name + call-graph extraction.** Add `code_edges.sqlite` + the
   edge extractor + within-file resolver. Validate: `code-callers` /
   `code-callees` round-trip on a small repo.
3. **Query commands** (`code-def`, `code-refs`, `code-callers`, `code-callees`,
   `query --lang`) as Pi plugin tools over the sidecars.
4. **Staleness mechanics.** `content_hash` watermark, tombstones, periodic sweep,
   synchronous reindex on the agent's own writes, async batched for bulk.
5. **Notes-side convention + alias table.** `[[symbol]]` page-ref habit; alias
   table for renames.
6. **Unify with the KB at the synthesis layer** (see §10 and
   `kb-architecture-plan.md` §9). The payoff step.

---

## 10. Unifying with the KB at the synthesis/query layer

This is the **only** place the code layer and the Logseq KB meet, and it's at
query time, not in storage. A query like "why is `loadConfig` async and what
breaks if I make it sync?" does three parallel pulls joined by the name
`loadConfig`:

1. **Code layer** → `code-def loadConfig` → definition (file, lines, body).
2. **Call graph** → `code-callers loadConfig` → `[main, test-runner]`.
3. **Notes layer** (from [`kb-architecture-plan.md`](kb-architecture-plan.md)) →
   `searchBlocks "loadConfig"` or `[[loadConfig]]` backlinks → your Logseq
   blocks about it.

The synthesis step (the same one described in the KB plan's gbrain-parity
section) gets all three and writes a cited answer with a gap note. No foreign
key, no stored relationship, no sync between code and notes — just a name that
appears in both because you wrote it in your notes and the indexer extracted it
from your code.

The synthesis layer's **gap analysis** is what makes the no-stored-relationship
design safe: when code returns but no notes match, it says "found the function;
no notes on file" rather than silently giving a code-only answer. Under-recall
becomes information, not a hidden failure.

**The cross-layer relationship is never stored; it's discovered at query time by
name; gap analysis absorbs the seams.** That is the defining tradeoff of this
architecture, and the price of the no-sync separation. See
[`kb-architecture-plan.md`](kb-architecture-plan.md) §9 (gbrain-parity layer)
for the synthesis pipeline and dream cycle that consume both layers.
