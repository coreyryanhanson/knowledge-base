# Vector Logseq — Hybrid Notes + RAG Agent Knowledge Base

A design for adding semantic (vector) retrieval over a Logseq DB graph **without modifying Logseq's own `db.sqlite`**.

> **Status / authority.** This document is the **design rationale** for the
> vector sidecar. The authoritative, chosen implementation path lives in
> [`kb-architecture-plan.md`](kb-architecture-plan.md) §5 — wherever the two
> disagree, **the architecture plan wins**. Two known divergences were
> reconciled in this revision: (1) the keyword leg of hybrid search uses **MCP
> `searchBlocks`** (FTS5 trigram via the search worker), *not* the CLI
> `search block` command (which is a lowercased-substring Datalog scan and
> does **not** emit `:block/uuid` — see corrected §5); (2) Logseq's native
> semantic search is **disabled** in favor of this sidecar (see §6).

## TL;DR

- Logseq's DB graph is a single `db.sqlite` whose content lives in a `kvs` blob table (a serialized datascript DB) plus an FTS5 search index (`blocks` / `blocks_fts`). You cannot sanely add a vector column there — GC, backup/restore, search reindexing, and `PRAGMA user_version` all own those tables.
- Keep vectors in a **sidecar SQLite file** (`vectors.sqlite`) using the `sqlite-vec` extension, keyed by **block UUID**.
- Pull block text + UUIDs from Logseq via **MCP** (`listPages` → `getPage` per page; top-level blocks only — nested reads blocked on the planned `getBlock` MCP tool). The `logseq` CLI is **not** used (it is localhost-only and unreachable from the VM; see `kb-architecture-plan.md` §3).
- Hybrid retrieval = Logseq's built-in FTS5 / datascript queries (keyword) **∪** vector KNN (semantic), merged by UUID.

This keeps Logseq loading cleanly, survives its backup/restore/GC lifecycle, and still gives you a queryable agent knowledge base.

---

## 1. Why not extend `db.sqlite` directly

Quick map of what's inside a DB graph's `db.sqlite` (verified against the repo):

| Table                                                                                                                | Owner                                      | Purpose                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `kvs`                                                                                                                | `deps/db/src/logseq/db/common/sqlite.cljs` | The actual graph — datascript segments serialized via `datascript.storage` |
| `blocks`, `blocks_fts`                                                                                               | `src/main/frontend/worker/search.cljs`     | FTS5 trigram search index, rebuilt/dropped by Logseq                       |
| KV rows (`:logseq.kv/schema-version`, `:logseq.kv/graph-initial-schema-version`, `:logseq.kv/remote-schema-version`) | migrations / RTC                           | Gate schema migrations on load                                             |
| `PRAGMA user_version`                                                                                                | `search.cljs` (`search-db-version`)        | Triggers search-index rebuild when bumped                                  |

Problems with adding a vector column / table in this file:

- `CREATE TABLE IF NOT EXISTS` won't extend existing tables; a stray column on `kvs`/`blocks` is orphaned and dropped on the next rebuild.
- `sqlite-gc` rewrites these tables.
- Backup/restore (`graph_backup.cljs`) and "repair" flows overwrite the whole file.
- db-sync/RTC syncs **encrypted datascript tx blobs only** — never a queryable relational shape, and `tx-sanitize` drops unknown attrs (`migration-deleted-attrs`). Vectors would never sync anyway.
- Bumping `PRAGMA user_version` makes Logseq rebuild the search index from scratch.

A sidecar file sidesteps all of this. Logseq never touches files it doesn't own.

---

## 2. Sidecar schema (`vectors.sqlite`)

Requires the [sqlite-vec](https://github.com/asg0171/sqlite-vec) extension loaded at connection time. Dim `1024` below matches **`BAAI/bge-m3`** — the chosen default (MTEB ~63.0, multilingual, CPU-runnable). See §6 (model choice) for why this is **not** Logseq's native `all-MiniLM-L6-v2` (MTEB 56.3, ~4 years old, dead last among established models — meaningfully outdated for retrieval) and for the swap procedure.

```sql
-- loadable extension must be loaded first, e.g.
--   conn.enable_load_extension(True)
--   conn.load_extension("./vec0")

CREATE VIRTUAL TABLE IF NOT EXISTS block_embeddings USING vec0(
  embedding float[1024]
);

CREATE TABLE IF NOT EXISTS blocks_meta (
  uuid           TEXT PRIMARY KEY,        -- :block/uuid (stable identity)
  graph          TEXT NOT NULL,           -- graph name, for multi-graph sidecars
  page_uuid      TEXT,                    -- :block/page uuid (context)
  page_title     TEXT,                    -- denormalized for display
  title          TEXT NOT NULL,           -- :block/title (the embeddable text)
  created_at     INTEGER,
  updated_at     INTEGER,                 -- :block/updated-at — drives incremental reindex
  embedded_at    INTEGER NOT NULL,        -- when we last embedded this row
  model          TEXT NOT NULL,           -- e.g. "BAAI/bge-m3"
  dim            INTEGER NOT NULL,
  deleted        INTEGER NOT NULL DEFAULT 0  -- tombstone; set when Logseq no longer returns the UUID
);

CREATE INDEX IF NOT EXISTS idx_blocks_meta_graph_updated
  ON blocks_meta(graph, updated_at);
CREATE INDEX IF NOT EXISTS idx_blocks_meta_graph_deleted
  ON blocks_meta(graph, deleted);
```

Notes:

- **UUID is the join key.** `:block/uuid` is `:db.unique/identity` in `deps/db/src/logseq/db/frontend/schema.cljs`, so it's stable across edits.
- **`vec0` rowid discipline.** `sqlite-vec`'s `vec0` table uses an integer rowid. Keep `blocks_meta.uuid` as the canonical key and store the `vec0` rowid alongside it (see indexer) — or insert into `vec0` and use its rowid as `blocks_meta.rowid`. The simplest pattern: insert metadata first, get `rowid`, then `INSERT INTO block_embeddings(rowid, embedding) VALUES (?, ?)`.
- **`deleted` tombstones** instead of hard deletes, so reindex runs can detect retractions without losing history until you choose to prune.
- **`model` / `dim`** columns let you re-embed with a new model and `WHERE model = ?` filter out stale rows.

---

## 3. Pulling blocks from Logseq (MCP only)

The indexer pulls blocks over **MCP** — the same surface the agent uses. The
`logseq` CLI is **not used**: it is localhost-only (it spawns/finds a local
`db-worker-node` on `127.0.0.1` and has no `--host`/`--token` remote-client
flag), so it cannot run from the VM, and a host-side shim/SSH is rejected for
isolation + portability. See `kb-architecture-plan.md` §3 for the full
rationale. Consequences for the indexer:

- **Source = `listPages` → `getPage` per page.** `getPage` returns a page's
  entity plus its **top-level blocks**, each with `:block/uuid` (string),
  `:block/title`, `:block/created-at`, `:block/updated-at`. Nested child blocks
  are stripped (`get-page-data` dissocs `:block/children`). So the indexer
  covers **top-level blocks only** today.
- **Nested blocks are not indexed yet.** `getBlock - include children` is a
  planned MCP tool (per
  [logseq/logseq#12111](https://github.com/logseq/logseq/pull/12111), not yet
  shipped as of June 2026). The indexer's `fetch_block_tree` helper (see §4) is
  the single seam that upgrades from "top-level blocks of a page" to "full
  recursive tree" when `getBlock` lands — no other change needed. Until then,
  author flat (top-level atomic bullets) so top-level-only indexing is
  complete.
- **Retraction detection does not need `:logseq.property/deleted-at`.** MCP
  `getPage` strips that attribute, but the indexer doesn't need it: the
  retraction signal is "UUID no longer returned," and MCP `searchBlocks` is a
  valid existence probe because it already filters deleted/recycled blocks out
  of its results (verified: `search.cljs:607` pulls `:logseq.property/deleted-at`
  and `search.cljs:1000` applies `(remove hidden-entity?)` where `hidden?`
  checks `deleted-at` and walks `:block/parent`, `entity_util.cljs:64-66`). So a
  recycled block's UUID disappears from `searchBlocks`/`getPage` results —
  exactly the "no longer returned" signal the tombstone logic wants.

Notes on the MCP block shape:

- In **DB graphs**, block text lives in `:block/title` (there is no
  `:block/content`). Pages also have `:block/name` (lowercased) and
  `:block/title` (original case).
- `:block/uuid` is the stable identity (`:db.unique/identity`) — use it as the
  sidecar primary key. MCP stringifies it for you (`tools.cljs` `(update :block/uuid str)`).

---

## 4. Minimal indexer (Python)

`vector_logseq.py` — incremental, idempotent, model-aware. Pulls via MCP (a
thin JSON-RPC client over HTTP to the host endpoint), not the CLI.

```python
#!/usr/bin/env python3
"""
Index a Logseq DB graph into a sqlite-vec sidecar, pulling blocks via MCP.

- Pulls top-level blocks via MCP listPages -> getPage (one call per page)
- Embeds with sentence-transformers (swap _embed() for any provider)
- Upserts into blocks_meta + block_embeddings
- Tombstones UUIDs the source no longer returns (retraction via absence)
"""
import json
import sqlite3
import time
from typing import Iterable

GRAPH = "my-graph"
SIDECAR = "vectors.sqlite"
VEC0_EXT = "./vec0"                 # path to sqlite-vec loadable extension
MODEL = "BAAI/bge-m3"           # default; see §6a for swap procedure
DIM = 1024
BATCH = 128

# MCP HTTP endpoint on the host (kb-architecture-plan.md §3).
MCP_URL = "http://<host-ip>:12315/mcp"
MCP_TOKEN = "<TOKEN>"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(SIDECAR)
    conn.enable_load_extension(True)
    conn.load_extension(VEC0_EXT)
    conn.executescript(open("schema.sql").read())  # the SQL from section 2
    return conn


class McpClient:
    """Thin MCP JSON-RPC client. Manages one mcp-session-id."""
    def __init__(self, url, token):
        self.url, self.token = url, token
        self.session_id = None
        self._id = 0

    def _call(self, method, params=None):
        import urllib.request
        self._id += 1
        headers = {"Authorization": f"Bearer {self.token}",
                   "Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        body = json.dumps({"jsonrpc": "2.0", "id": self._id,
                           "method": method, "params": params or {}}).encode()
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            self.session_id = resp.headers.get("Mcp-Session-Id") or self.session_id
            return json.loads(resp.read().decode())

    def initialize(self):
        return self._call("initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "vector-logseq-indexer", "version": "0"}})

    def call_tool(self, name, args):
        r = self._call("tools/call", {"name": name, "arguments": args})
        # MCP returns content blocks; assume a single JSON text block.
        content = r.get("result", {}).get("content", [{}])
        text = content[0].get("text") if content else None
        return json.loads(text) if text else None


def _fetch_block_tree(mcp, graph):
    """
    The single seam for nested reads. Today: top-level blocks per page via
    getPage. When Logseq ships `getBlock - include children`, swap only this
    function to return full recursive trees -- the rest of the indexer is
    unchanged. See kb-architecture-plan.md §5.
    """
    pages = mcp.call_tool("listPages", {"expand": True}) or []
    rows = []
    for p in pages:
        page_uuid = p.get(":block/uuid")
        page_title = p.get(":block/title") or p.get(":block/name")
        page = mcp.call_tool("getPage", {"pageName": page_uuid or page_title})
        if not page:
            continue
        for b in (page.get(":block/children") or []):  # top-level blocks
            if b.get(":block/uuid") and b.get(":block/title"):
                rows.append({**b, ":block/page": {":block/uuid": page_uuid,
                                                  ":block/title": page_title}})
    return rows


def _embed(texts):
    # Swap for OpenAI, Ollama, local ggml, etc.
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL)
    return model.encode(texts, normalize_embeddings=True, show_progress_bar=False).tolist()


def _uuid_str(v):
    return None if v is None else str(v)


def index(conn, mcp, graph):
    rows = _fetch_block_tree(mcp, graph)  # MCP already filters deleted blocks
    seen_uuids = set()
    now_ms = int(time.time() * 1000)

    for batch in _chunks(rows, BATCH):
        texts = [r[":block/title"] for r in batch]
        vecs = _embed(texts)
        for r, vec in zip(batch, vecs):
            uuid = _uuid_str(r[":block/uuid"])
            if not uuid:
                continue
            seen_uuids.add(uuid)
            page = r.get(":block/page") or {}
            conn.execute("""
              INSERT INTO blocks_meta (uuid, graph, page_uuid, page_title, title,
                                        created_at, updated_at, embedded_at, model, dim, deleted)
              VALUES (?,?,?,?,?,?,?,?,?,?,0)
              ON CONFLICT(uuid) DO UPDATE SET
                graph=excluded.graph, page_uuid=excluded.page_uuid,
                page_title=excluded.page_title, title=excluded.title,
                created_at=excluded.created_at, updated_at=excluded.updated_at,
                embedded_at=excluded.embedded_at, model=excluded.model,
                dim=excluded.dim, deleted=0
            """, (uuid, graph, _uuid_str(page.get(":block/uuid")),
                  page.get(":block/title"), r[":block/title"],
                  r.get(":block/created-at"), r.get(":block/updated-at"),
                  now_ms, MODEL, DIM))
            rowid = conn.execute(
                "SELECT rowid FROM blocks_meta WHERE uuid=?", (uuid,)).fetchone()[0]
            conn.execute(
                "INSERT OR REPLACE INTO block_embeddings(rowid, embedding) VALUES (?, ?)",
                (rowid, json.dumps(vec)))

    # Tombstone UUIDs the source no longer returns (retraction via absence;
    # searchBlocks/getPage already drop deleted blocks, so absence == retracted).
    if seen_uuids:
        placeholders = ",".join("?" for _ in seen_uuids)
        conn.execute(
            f"UPDATE blocks_meta SET deleted=1 WHERE graph=? AND uuid NOT IN ({placeholders})",
            (graph, *seen_uuids))
    conn.commit()


def _chunks(xs, n):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


if __name__ == "__main__":
    c = _connect()
    mcp = McpClient(MCP_URL, MCP_TOKEN)
    mcp.initialize()
    index(c, mcp, GRAPH)
```

### Incremental mode

`blocks_meta.updated_at` mirrors `:block/updated-at`. To reindex only changed
blocks:

```sql
SELECT uuid, title FROM blocks_meta
WHERE graph = ? AND deleted = 0
  AND (updated_at > ? OR embedded_at < ?);
```

…then re-pull those pages via MCP `getPage`, re-embed, upsert. A full sweep
(above) is fine for small/medium graphs and is also what you need to detect
retractions (tombstoning via absence). Note: incremental re-pull is per-page
(`getPage`), so it's one MCP call per stale page — acceptable at personal scale;
the planned `getManyBlocks`/`getManyPages` batch-read MCP tools would collapse
this when they ship
---

## 5. Hybrid retrieval

Combine Logseq's keyword recall with vector KNN, then merge by UUID.

> **Corrected path (authoritative: kb-arch §5).** The keyword leg uses **MCP
> `searchBlocks`**, which routes through `logseq.app.search` → the frontend
> search worker → `blocks_fts` (a real FTS5 trigram index). Each hit carries a
> bare `uuid` (the block's `:block/uuid`), so it joins cleanly to the vector
> sidecar — read `h["uuid"]`, **not** `h[":block/uuid"]` (the observed hit
> shape uses bare keys, not the namespaced keys `getPage` returns; verified in
> Stage 0 — see `stage0-network-de-risk.md` "Risks and fallbacks").
>
> **Do not** use the CLI `logseq search block` command for the keyword leg. It
> was previously shown here, but it (a) emits `[:db/id :db/ident :block/title
> :logseq.property/deleted-at]` with **no `:block/uuid`** (verified in
> `src/main/logseq/cli/command/search.cljs:47-78`), and (b) is a
> `clojure.string/includes?` lowercased-substring Datalog scan, **not FTS5** —
> so the old example's `r["uuid"]` lookup fails and the "Logseq's own FTS5"
> comment is false for that path. The CLI `search block` is fine for ad-hoc
> human substring search; it is not the keyword leg of hybrid retrieval.

```python
def hybrid_search(conn, mcp, graph, query_text, k_sem=10, k_kw=10):
    # --- Semantic: vector KNN over the sidecar ---
    qvec = json.dumps(_embed([query_text])[0])
    sem = conn.execute("""
      SELECT m.uuid, m.title, m.page_title, v.distance, v.rowid
      FROM block_embeddings v
      JOIN blocks_meta m ON m.rowid = v.rowid
      WHERE m.graph = ? AND m.deleted = 0
      AND v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    """, (graph, qvec, k_sem)).fetchall()
    sem_ranked = [dict(uuid=r[0], title=r[1], page=r[2], dist=r[3], rank=i)
                  for i, r in enumerate(sem)]

    # --- Keyword: MCP searchBlocks (FTS5 via the search worker) ---
    # `mcp` is a thin MCP JSON-RPC client pointed at the host endpoint (kb-arch §3).
    # searchBlocks hit shape uses BARE keys (verified in Stage 0):
    #   {"uuid":..., "title":..., "content":..., "page":<page-uuid>, ...}
    # NOT the namespaced :block/uuid / :block/title that getPage returns.
    # NOTE: the MCP searchBlocks schema exposes ONLY `searchTerm` (verified in
    # src/electron/electron/mcp_server.cljs:198 — `:inputSchema #js {:searchTerm
    # (z/string)}`, and api-search-blocks hardcodes `:enable-snippet? false`).
    # There is no server-side `limit`; truncate client-side after the call.
    # NOTE: get-match-input (worker/search.cljs:354) phrase-quotes punctuated
    # terms (hyphens etc.) and the trigram path doesn't surface them — strip
    # punctuation from query_text or warn before calling.
    kw_raw = mpc.call("searchBlocks", {"searchTerm": query_text})
    kw_hits = kw_raw[:k_kw]
    kw_ranked = []
    for i, h in enumerate(kw_hits):
        uuid = _uuid_str(h.get("uuid"))   # bare key, NOT ":block/uuid"
        if not uuid:
            continue
        kw_ranked.append(dict(uuid=uuid, title=h.get("title", ""),
                              page=h.get("page"), dist=None, rank=i))

    # --- Merge: Reciprocal Rank Fusion (RRF), k ~ 60 ---
    K = 60
    by_uuid = {}
    for side in (sem_ranked, kw_ranked):
        for hit in side:
            d = by_uuid.setdefault(hit["uuid"], {
                "uuid": hit["uuid"], "title": hit["title"],
                "page": hit.get("page"), "sem_dist": None, "kw": False,
                "rrf": 0.0})
            d["rrf"] += 1.0 / (K + hit["rank"])
            if side is sem_ranked:
                d["sem_dist"] = hit.get("dist")
            else:
                d["kw"] = True
    return sorted(by_uuid.values(), key=lambda d: -d["rrf"])
```

RRF formula (the merge used above):

```
score(d) = sum_i  1 / (k + rank_i(d))      # k ~ 60
```

---

## 6. Caveats & operational notes

- **No sync.** db-sync/RTC never carries vectors. If you want them on multiple machines, sync `vectors.sqlite` yourself (it's a normal SQLite file — replication, rsync, or a git-lfs blob all work).
- **UUID stability.** `:block/uuid` is `:db.unique/identity`, so it survives edits. Handle retractions via the `deleted` tombstone + a periodic full sweep.
- **Page vs block granularity.** Indexing at block granularity maximizes retrieval precision but yields short texts. For page-level context, embed concatenated block titles per page and store with a synthetic `page:<uuid>` key, then fan out to child block UUIDs at query time. Known recall cliff for v1: terse nested bullets (3–8 words) embed poorly; the page-level concat fallback (vector-logseq §6) is the mitigation when top-level coverage under-recalls.
- **Don't touch `PRAGMA user_version`** on Logseq's `db.sqlite`. If you ever store metadata in the same file (not recommended), use your own version table.
- **File graphs vs DB graphs.** This design assumes a DB graph (`db.sqlite`). For a legacy file graph, content is Markdown/Org on disk — even easier: walk the directory, embed file/heading chunks, key by file path + heading anchor.
- **Verify the MCP tool surface live** before scripting around it: issue
  `tools/list` against the host endpoint and confirm `listPages`, `getPage`,
  `searchBlocks` are present and round-trip. The skill policy is explicitly not
  to hardcode tool lists — re-check `src/electron/electron/mcp_server.cljs` if a
  tool's input shape changes.
- **OPFS / browser caveat.** Logseq's renderer uses OPFS-backed SQLite in the browser. The sidecar is a separate Node/Python process file — keep it out of the graph directory so Logseq's backup/restore can't clobber it. Suggested location: a sibling dir like `~/logseq-vectors/<graph>/vectors.sqlite`.
- **Cross-sidecar freshness watermark.** There are up to four derived indexes around this KB (KB vectors, KB typed edges in `edges.sqlite`, code chunks+edges, and — if it were enabled — Logseq's native zvec). Each carries its own `embedded_at` / `indexed_at`. The synthesis/query layer treats the **minimum** `embedded_at`/`indexed_at` across the sidecars it joins as the "fresh as of" watermark for any cross-index result, and treats any join across indexes of different freshness as *under-recall to be flagged by gap analysis*, not a wrong answer. See [`code-layer-plan.md`](code-layer-plan.md) §7 for the parallel statement on the code side.
- **Sweep trigger for retraction detection.** Retractions (blocks deleted via
  Logseq's recycle bin) are only caught by a **periodic full sweep**, not
  incrementally. Run it on demand via `kb_reconcile` (kb-arch Stage 9a) or
  auto-triggered by the staleness signal — **not on a fixed cron**, because the
  container is intermittently running and a cron that can't fire is worse than
  an honest staleness signal. The sweep tombstones UUIDs the source no longer
  returns — and that "no longer returned" signal is valid under MCP-only
  because `searchBlocks`/`getPage` already filter deleted blocks out of their
  results (§3). No `:logseq.property/deleted-at` field and no CLI path needed.

### 6a. Embedding model choice (and why not Logseq's native `all-MiniLM-L6-v2`)

Logseq ships a **native semantic-search subsystem**: an `embedding-server`
process running `sentence-transformers` with model `all-MiniLM-L6-v2`
(`src/electron/electron/embedding_server.cljs:9`), backed by a `vector-index`
at `search/vector` consulted by the search worker when the user setting
`:feature/enable-semantic-search?` is on (`src/electron/electron/configs.cljs:51`,
`src/main/frontend/state.cljs:554`). When enabled, **MCP `searchBlocks` already
returns vector-ranked hybrid results** — the feature is not mentioned in
`kb-architecture-plan.md` and was a blind spot.

The chosen model for the sidecar is **`BAAI/bge-m3`** (MTEB ~63.0, multilingual,
CPU-runnable at personal scale), not `all-MiniLM-L6-v2` (MTEB 56.3, ~4 years old,
dead last among established retrieval models — meaningfully outdated, a
7–15 point MTEB gap vs. modern alternatives). Acceptable alternatives in the
same class: `Qwen3-Embedding-0.6B`, `jina-embeddings-v3`-class small models.

**Model choice is a schema decision.** The embedding dimension and the model
name are part of the sidecar's row identity (`model`/`dim` columns exist for
exactly this). Switching models requires a **full re-embed** of every row
(`UPDATE … SET deleted=1` on stale-`model` rows, then re-index from scratch, or
just drop and rebuild `vectors.sqlite`). The sidecar is a rebuildable cache,
so this costs only processing time, never data — but set the model once and
change it deliberately.

### 6b. Disable Logseq's native semantic search

**Decision: build the sidecar (per §6a) and disable Logseq's native semantic
search.** Keep `:feature/enable-semantic-search?` **off** in user settings
(Settings → Editor / semantic search toggle,
`src/main/frontend/components/settings.cljs:566`).

Rationale — the three-way choice and why (b) wins:

1. **Rely on native, skip the sidecar.** Zero infra, already wired into
   `searchBlocks`. But: opaque zvec index, **no UUID-keyed join to
   `edges.sqlite`** (which the gbrain-parity typed-edge graph requires), no
   model control (stuck on `all-MiniLM-L6-v2`), requires host Python. ❌
   fails the gbrain-parity goal.
2. **Build the sidecar + disable native (chosen).** Full control over
   model/dim, UUID-keyed join to `edges.sqlite`, VM-local embedding compute,
   agent-owned retraction. Cost: one extra index to keep fresh + duplicated
   embedding compute if native were also on — so we **turn native off** to
   avoid double-vectorizing the same blocks with two different models and
   producing conflicting ranks in `kb_find_notes`. ✅
3. **Build the sidecar + leave native on.** Two vector stores rank the same
   blocks with different models/scores; the merge semantics in
   `kb_find_notes` become undefined. ❌ concrete failure mode.

The deciding factor is the **UUID-keyed join to `edges.sqlite`**: gbrain-parity
typed edges (`kb-architecture-plan.md` §9) need a vector index whose rows are
addressable by `:block/uuid`, and Logseq's native zvec is not that. So the
sidecar is built, and native semantic search is explicitly disabled to keep one
ranking source of truth.

---

## 7. Putting it together

1. `pip install sqlite-vec sentence-transformers` (or your embedder of choice).
2. Download `vec0` loadable extension for your platform.
3. Save the section 2 SQL as `schema.sql`.
4. Save section 4 as `vector_logseq.py`; set `GRAPH` / `SIDECAR` / `VEC0_EXT`
   and `MCP_URL` / `MCP_TOKEN` (the host MCP endpoint — see
   `kb-architecture-plan.md` §3).
5. Run `python vector_logseq.py` to build the index.
6. Run incremental sweeps on demand via `kb_reconcile` (kb-arch Stage 9a), or
   auto-triggered by the staleness signal — **not on a fixed cron**, because the
   container is intermittently running. (If you *do* want unattended sweeps,
   add your own cron/systemd one-liner calling `vector_logseq.py` — that's a
   deployment choice, not part of the plugin.)
7. Wire `hybrid_search()` into your agent's retrieval step.

You now have a hybrid notes + agent knowledge base where Logseq remains the editable source of truth and the vector store is a pure, rebuildable derivative — Logseq loads and syncs exactly as before.
