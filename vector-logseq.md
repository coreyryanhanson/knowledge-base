# Vector Logseq — Hybrid Notes + RAG Agent Knowledge Base

A design for adding semantic (vector) retrieval over a Logseq DB graph **without modifying Logseq's own `db.sqlite`**.

## TL;DR

- Logseq's DB graph is a single `db.sqlite` whose content lives in a `kvs` blob table (a serialized datascript DB) plus an FTS5 search index (`blocks` / `blocks_fts`). You cannot sanely add a vector column there — GC, backup/restore, search reindexing, and `PRAGMA user_version` all own those tables.
- Keep vectors in a **sidecar SQLite file** (`vectors.sqlite`) using the `sqlite-vec` extension, keyed by **block UUID**.
- Pull block text + UUIDs from Logseq via the `logseq` CLI (`logseq list block` / `logseq query`, `--output json`).
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

Requires the [sqlite-vec](https://github.com/asg0171/sqlite-vec) extension loaded at connection time. Dim `768` below matches `BAAI/bge-small-en-v1.5`; swap for your model.

```sql
-- loadable extension must be loaded first, e.g.
--   conn.enable_load_extension(True)
--   conn.load_extension("./vec0")

CREATE VIRTUAL TABLE IF NOT EXISTS block_embeddings USING vec0(
  embedding float[768]
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
  model          TEXT NOT NULL,           -- e.g. "BAAI/bge-small-en-v1.5"
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

## 3. Pulling blocks from Logseq (CLI)

Two supported paths. Both emit JSON.

### 3a. `logseq list block` — simplest

```bash
logseq list block --graph my-graph --output json
```

Fields exposed (from `src/main/logseq/cli/command/list.cljs`): `uuid`, `title`, `created-at`, `updated-at`. Page context isn't in the default projection; use 3b if you need it.

### 3b. `logseq query` — arbitrary datascript pull (recommended for indexing)

```bash
logseq query --graph my-graph --output json --query '[:find [(pull ?b [:block/uuid :block/title :block/created-at :block/updated-at {:block/page [:block/uuid :block/title]}]) ...] :where [?b :block/uuid] [?b :block/title]]'
```

Notes:

- In **DB graphs**, block text lives in `:block/title` (there is no `:block/content`). Pages also have `:block/name` (lowercased) and `:block/title` (original case).
- `:block/uuid` is the stable identity — use it as the sidecar primary key.
- Filter out recycled/deleted blocks by checking `:logseq.property/deleted-at` (see how `search.cljs`'s `search-block-query` walks `{:block/parent ...}` to drop blocks on recycled pages). For a v1 indexer, just skip any entity where `:logseq.property/deleted-at` is non-nil.
- Verify live flags before relying on them:

  ```bash
  logseq list block --help
  logseq query --help
  logseq example query
  ```

---

## 4. Minimal indexer (Python)

`vector_logseq.py` — incremental, idempotent, model-aware.

```python
#!/usr/bin/env python3
"""
Index a Logseq DB graph into a sqlite-vec sidecar.

- Pulls blocks via `logseq query --output json`
- Embeds with sentence-transformers (swap _embed() for any provider)
- Upserts into blocks_meta + block_embeddings
- Tombstones UUIDs that Logseq no longer returns
"""
import json
import sqlite3
import subprocess
import time
from typing import Iterable

GRAPH = "my-graph"
SIDECAR = "vectors.sqlite"
VEC0_EXT = "./vec0"                 # path to sqlite-vec loadable extension
MODEL = "BAAI/bge-small-en-v1.5"
DIM = 768
BATCH = 128

QUERY = """
[:find [(pull ?b [:block/uuid :block/title :block/created-at :block/updated-at
                  {:block/page [:block/uuid :block/title]}
                  :logseq.property/deleted-at]) ...]
  :where [?b :block/uuid] [?b :block/title]]
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(SIDECAR)
    conn.enable_load_extension(True)
    conn.load_extension(VEC0_EXT)
    conn.executescript(open("schema.sql").read())  # the SQL from section 2
    return conn


def _logseq_query(graph: str, query: str) -> list[dict]:
    out = subprocess.run(
        ["logseq", "query", "--graph", graph, "--output", "json", "--query", query],
        check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout)


def _embed(texts: list[str]) -> list[list[float]]:
    # Swap for OpenAI, Ollama, local ggml, etc.
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(MODEL)
    return model.encode(texts, normalize_embeddings=True, show_progress_bar=False).tolist()


def _uuid_str(v) -> str | None:
    # datascript uuids serialize as strings in JSON output; be defensive
    if v is None:
        return None
    return str(v)


def index(conn: sqlite3.Connection, graph: str) -> None:
    rows = _logseq_query(graph, QUERY)
    # Drop deleted/recycled
    rows = [r for r in rows if not r.get(":logseq.property/deleted-at")]

    seen_uuids = set()
    now_ms = int(time.time() * 1000)

    for batch in _chunks(rows, BATCH):
        texts = [r[":block/title"] for r in batch]
        vecs = _embed(texts)
        for r, vec in zip(batch, texts_and_rows := batch, vecs):
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

    # Tombstone UUIDs Logseq no longer returns
    if seen_uuids:
        placeholders = ",".join("?" for _ in seen_uuids)
        conn.execute(
            f"UPDATE blocks_meta SET deleted=1 WHERE graph=? AND uuid NOT IN ({placeholders})",
            (graph, *seen_uuids))
    conn.commit()


def _chunks(xs: list, n: int) -> Iterable[list]:
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


if __name__ == "__main__":
    c = _connect()
    index(c, GRAPH)
```

### Incremental mode

`blocks_meta.updated_at` mirrors `:block/updated-at`. To reindex only changed blocks:

```sql
SELECT uuid, title FROM blocks_meta
WHERE graph = ? AND deleted = 0
  AND (updated_at > ? OR embedded_at < ?);
```

…then re-query Logseq filtered to those UUIDs, re-embed, upsert. A full sweep (above) is fine for small/medium graphs and is also what you need to detect retractions (tombstoning).

---

## 5. Hybrid retrieval

Combine Logseq's keyword recall with vector KNN, then merge by UUID.

```python
def hybrid_search(conn, graph, query_text, k_sem=10, k_kw=10):
    # --- Semantic: vector KNN ---
    qvec = json.dumps(_embed([query_text])[0])
    sem = conn.execute("""
      SELECT m.uuid, m.title, m.page_title, v.distance
      FROM block_embeddings v
      JOIN blocks_meta m ON m.rowid = v.rowid
      WHERE m.graph = ? AND m.deleted = 0
      AND v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    """, (graph, qvec, k_sem)).fetchall()

    # --- Keyword: delegate to Logseq's own search ---
    kw = subprocess.run(
        ["logseq", "search", "block", "--graph", graph,
         "--content", query_text, "--output", "json"],
        check=True, capture_output=True, text=True).stdout
    kw_rows = [(r["uuid"], r["title"], None, None) for r in json.loads(kw)]

    # --- Merge (simple union; swap for RRF / weighted fusion) ---
    by_uuid = {}
    for uuid, title, page, dist in sem:
        by_uuid[uuid] = {"uuid": uuid, "title": title, "page": page,
                         "sem_dist": dist, "kw": False}
    for uuid, title, *_ in kw_rows:
        if uuid in by_uuid:
            by_uuid[uuid]["kw"] = True
        else:
            by_uuid[uuid] = {"uuid": uuid, "title": title, "page": None,
                             "sem_dist": None, "kw": True}
    return list(by_uuid.values())
```

Upgrade the merge to **Reciprocal Rank Fusion (RRF)** once you have rank lists from both sides:

```
score(d) = sum_i  1 / (k + rank_i(d))      # k ~ 60
```

---

## 6. Caveats & operational notes

- **No sync.** db-sync/RTC never carries vectors. If you want them on multiple machines, sync `vectors.sqlite` yourself (it's a normal SQLite file — replication, rsync, or a git-lfs blob all work).
- **UUID stability.** `:block/uuid` is `:db.unique/identity`, so it survives edits. Handle retractions via the `deleted` tombstone + a periodic full sweep.
- **Page vs block granularity.** Indexing at block granularity maximizes retrieval precision but yields short texts. For page-level context, embed concatenated block titles per page and store with a synthetic `page:<uuid>` key, then fan out to child block UUIDs at query time.
- **Don't touch `PRAGMA user_version`** on Logseq's `db.sqlite`. If you ever store metadata in the same file (not recommended), use your own version table.
- **File graphs vs DB graphs.** This design assumes a DB graph (`db.sqlite`). For a legacy file graph, content is Markdown/Org on disk — even easier: walk the directory, embed file/heading chunks, key by file path + heading anchor.
- **Verify CLI flags live** before scripting around them: `logseq <command> --help` and `logseq example <command>`. The skill policy is explicitly not to hardcode option lists.
- **Embedding model swaps.** Bump `MODEL`/`DIM`, then re-embed rows where `model <> ?` (or just drop and rebuild). The `model`/`dim` columns exist for exactly this.
- **OPFS / browser caveat.** Logseq's renderer uses OPFS-backed SQLite in the browser. The sidecar is a separate Node/Python process file — keep it out of the graph directory so Logseq's backup/restore can't clobber it. Suggested location: a sibling dir like `~/logseq-vectors/<graph>/vectors.sqlite`.

---

## 7. Putting it together

1. `pip install sqlite-vec sentence-transformers` (or your embedder of choice).
2. Download `vec0` loadable extension for your platform.
3. Save the section 2 SQL as `schema.sql`.
4. Save section 4 as `vector_logseq.py`; set `GRAPH` / `SIDECAR` / `VEC0_EXT`.
5. Run `python vector_logseq.py` to build the index.
6. Cron / launchd / systemd timer it for incremental sweeps.
7. Wire `hybrid_search()` into your agent's retrieval step.

You now have a hybrid notes + agent knowledge base where Logseq remains the editable source of truth and the vector store is a pure, rebuildable derivative — Logseq loads and syncs exactly as before.
