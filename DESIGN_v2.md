# SiYuan Knowledge Base — Design Doc (v2)

A pi extension that builds and maintains a knowledge base in SiYuan, modeled on GBrain's
methods but re-grounded: **pi as the harness, SiYuan as the storage engine, zero model/provider
opinions.**

Status: design complete — Milestone 0 (connectivity/auth smoke test, §11) is done, implementation
starts at Milestone 1. This document is the successor to DESIGN.md and fully supersedes it; it folds in the addressing, discovery, and title-policy
revisions agreed in design review (decision records R1–R6, Appendix).
Provenance: decisions reached via a Socratic design interview plus adversarial review against
GBrain and SiYuan primary sources (kernel claims verified against ~/siyuan @ 3.8.2; the
discovery doctrine anchored against ~/gbrain skills/query + MEMORY_VERBS_v1); rationale
recorded inline.

Contents: [1 Goals](#1-goals) · [2 Architecture](#2-architecture--two-packages) · [3 v1 scope & result budgets](#3-v1-scope--the-lean-agent-driven-loop) · [4 Write-back conventions](#4-write-back-conventions) · [5 Multi-KB config & scope state](#5-multi-kb-config--scope-state) · [6 Named ceilings](#6-named-ceilings-deliberate-simplifications) · [7 Access invariant](#7-access-invariant) · [8 Deployment topology](#8-deployment-topology) · [9 Risks](#9-risks) · [10 Testing posture](#10-testing-posture) · [11 Milestone rollout](#11-milestone-rollout) · [Appendix — decision ledger](#appendix--decision-ledger)

---

## 1. Goals

- **Agent-driven memory loop**: a pi agent distills knowledge into SiYuan during sessions and
  recalls it in later sessions — the "tell it to remember X, restart, ask for X back" test.
- **General and robust from day 1**: clean package boundaries, typed client, version-checked
  API — but *not* published to npm. Shared locally via symlink / `file:` dependency. No
  versioning or breaking-change tax.
- **Model-neutral**: the extension makes **zero** model/provider calls. The agent is the
  intelligence; SiYuan is the memory.
- **Minimal context surface**: a small, curated tool set. No MCP tool wall, no per-KB tool
  duplication.

### Non-goals (v1)

- No embedding/vector/RAG layer, no entity graph, no dream-cycle/overnight consolidation
  **in the initial build** — RAG is planned v2 work, not a contingency: the lean loop ships
  first (GBrain's own zero-key mode proves it works), and v1 stays embedding-free by
  construction so the vector sidecar lands later without re-architecture (§6 — vectors are
  derived data over the same storage).
- No npm publication, no semver maintenance.
- No hard multi-KB isolation (see §6, Named ceilings).
- No backup machinery — whatever backs the workspace (git, SiYuan sync, nothing) is the
  user's business. The extension only ever speaks to the kernel API.

---

## 2. Architecture — two packages

Following the validated `pi-tbox` → `pi-tool-masking` precedent, minus publishing:

```
┌────────────────────────────┐        ┌──────────────────────────────┐
│  pi (harness, agent loop)  │        │  host: docker-compose SiYuan │
│  ┌──────────────────────┐  │  HTTP  │  kernel API, port 6806      │
│  │ pi-kb extension      │──────────▶│  Authorization: Token <key> │
│  │ (tools, scope)       │  │        │                             │
│  └─────────┬────────────┘  │        │  workspace data/            │
│            │ library       │        │   └─ kb/ (.sy doc trees)    │
│  ┌─────────▼────────────┐  │        │                             │
│  │ siyuan-core          │  │        │                             │
│  │ (client + types)     │  │        │                             │
│  └──────────────────────┘  │        │                             │
└────────────────────────────┘        └──────────────────────────────┘
        Firecracker microVM                  host
```

### `siyuan-core` (library-only)

- Pure SiYuan kernel HTTP API client + TypeScript types.
- **Zero pi imports, zero runtime dependencies** (native `fetch`, hand-rolled types).
- URL + token injected via config (never hardcoded — the deployment topology requires it).
- Version check (`/api/system/version`) against a pinned, tested SiYuan version. **Timing**
  (decision record): the probe runs eagerly at `session_start` and the verdict is cached
  for the session — no write ever executes before a probe has succeeded. **Fail-closed**:
  probe failure (unreachable, error) also refuses writes — "never probed successfully"
  means no writes, whatever the reason; reads are never version-gated — the gate exists
  for the write blast radius only, so a mismatch (or a failed probe) leaves reads
  untouched, and the unreachable-kernel behavior §5 pins is a separate per-call
  degradation, not a second gate. The probe is a **correctness gate, not a security gate**: `/api/system/version` is unauthenticated, so it proves connectivity and version only — auth enforcement for writes lives kernel-side. **Mismatch
  behavior**: **refuse writes on any drift from the pinned full version** (writes are
  the blast radius); reads warn and proceed either way. Strict, not coarse (decision
  record, revised after external review): the earlier draft refused only on *major*
  drift to avoid breaking the extension on every SiYuan point release — but §8 pins the
  compose image tag, so an upgrade is always a deliberate act and never arrives as a
  background point release, while every behavior-drift case this design records landed
  in *minor* releases (duplicate-minting create in v3.7.0; all kernel pins verified at
  3.8.2) — a major-only gate would never fire against the drift class it exists for.
  Strict matching fires the gate at exactly the moment the deliberate upgrade happens —
  when the §10 upgrade checklist should run — making the §10 integration suite the
  *verification* step of that upgrade rather than an unenforced drift guard. No
  *automatic* staleness re-probe exists, so a mid-session kernel version swap is out of
  threat model; the §5 recovery hook (every `/kb` dispatch re-runs the probe) is
  user-invoked and incidentally refreshes the verdict — it is not staleness polling. The
  first-write probe retry when no probe has yet succeeded is specified with the
  unreachable-startup flow (§5).
- Query/search methods take explicit `limit` parameters — the kernel API is
  called exactly as the caller specifies; result-budget policy belongs to the extension
  (§3), not the client. Exception: the query method takes `stmt` plus the read-only `mode` flag (§2's second
  named exception, below) and **no** limit parameter — a client-side query limit could
  only exist as SQL-text injection, which is the extension's job (§3); client-side
  limits apply only
  where the kernel API has a real field (search `pageSize`). The **read method takes
  only the doc `id`** — `exportMdContent` (`kernel/api/export.go`) has no size field
  and returns whole docs; there is no kernel-side or client-side read limit, so the
  read budget (inline preview + spill) is entirely extension-owned (§3).
- **429 is its own error class**: `authByAPIToken` rate-locks IPs after repeated bad-token
  attempts (kernel/model/session.go:404, `Retry-After`; GHSA-m6w6-p7pc-fpg2 — the
  throttle constants and sweep live in kernel/util/session.go, cited in-source as
  GHSA-2x7j-p79w-7744; both advisories cover this throttle). The client maps
  HTTP 429 distinctly from generic auth failure (one misconfigured session must not lock
  the IP and degrade confusingly); the envelope message names the lockout and its self-healing
  expiry — never "correct the token" (with a correct token that advice is wrong and invites
  settings edits; the full guidance text is pinned in §5). A 429 can arrive with a **correct** token — the
  lock is keyed by client IP and shared across clients, so another session's or client's
  bad-token failures lock the VM's IP for everyone (the §5 two-session 3+3 case); the
  extension's handling of that case is pinned in §5, not here. The lock is per-IP and
  shared with the access-auth-code path — one VM is one client IP, so the client **never
  retries 401/403/429** responses; a retry loop with a bad token would lock the VM out of
  the kernel entirely. (And the client-side rule alone is not enough: the agent's own
  tool-call retries are the real retry loop — extension-side circuit breaker, §5.)
  The throttle's runtime contract is pinned by integration test, not assumed (§10
  throttle case; §5 has the full record).
  Transient 5xx/timeouts on idempotent reads get a single retry; writes are never
  retried. **Every client call carries a hard timeout** (30 s, one constant — native
  `fetch` waits forever by default, and a hung kernel would hang the agent's turn): a
  timeout is a transient failure and follows the same read-retry/write-never policy.
- **Documented endpoints only, two named exceptions**: per API.md, undocumented kernel routes and `/api/transactions` carry no compatibility guarantees; the client never calls them — with two exceptions: **`/api/search/fullTextSearchBlock`**. The route is absent from API.md, but SiYuan's own MCP server exposes `search.fulltext` as a supported agent-facing tool whose handler calls the identical kernel function (`model.FullTextSearchBlock`) — the underlying behavior carries an upstream support commitment even though the HTTP route is not documented. The exception is named, pinned in §3 (search transport), and pinned by integration test (§10); if it ever breaks, the fallback is SQL `content LIKE` over the documented `/api/query/sql`.
  The second exception is a parameter, not a route: **`/api/query/sql` with `mode: "readonly"`**
  (`api/sql.go`, absent from API.md) — the `mode` flag invokes the kernel's
  `CheckReadonlyStatement`, a real `sqlite3_stmt_readonly` check (SELECT/WITH only). The
  query tool always sends it: kernel-enforced read-only is defense in depth behind the
  extension's parser certification (§3), so a certification bug can never turn the query
  tool into a writer. Pinned by integration test (§10).
- Any extension can consume it; only this project's KB extension registers pi tools.

### `pi-kb` extension (the pi extension)

- Registers the curated pi tool set (query/search/read/write-back).
- Owns all pi API surface: `session_start`/`session_shutdown`, `pi.appendEntry` scope state,
  write confirmation.
- Reads multi-KB config from settings.json; validates `kb` params against it.

**Why library-only for the core (decision record):**

| Question | Why library, not a plugin |
| --- | --- |
| Distribution | No npm publish → a second plugin surface has no distribution channel to exploit |
| Context surface | A library contributes zero always-on tool tokens; a plugin adds a second tool wall |
| Precedent | `pi-tool-masking` has no `pi.extensions` field — same shape, already validated |
| Coupling | Core never carries pi API churn; a second consumer gets it for free |

**Why kernel HTTP API, not the MCP server (decision record):**

- Every MCP tool is a wrapper over an HTTP endpoint the core can call directly; MCP adds
  JSON-RPC, capability negotiation, an SDK dependency, and a pinned protocol version without
  adding capability.
- There is no privilege advantage either way: SiYuan has exactly one API token
  (`Conf.Api.Token`), and authenticating with it grants `RoleAdministrator` regardless of
  transport (`authByAPIToken`, kernel/model/session.go). The kernel API is chosen despite
  both paths being admin-token paths, not because of a lesser token.
- The "remove MCP context overhead" goal is achieved *architecturally* regardless of
  transport: pi never sees any SiYuan tool wall — the KB extension curates its own few tools.
- Kernel API is community-stable and has years of wide usage.

---

## 3. v1 Scope — the lean agent-driven loop

Curated pi tools (one set, not per-KB):

1. **query** — SQL over blocks (`/api/query/sql`, always `mode: "readonly"` — the §2
   second named exception), scoped to active KBs (mechanism pinned
   below). Tool-owned discovery: the tool description pins the include-`hpath` pattern
   (§5) — discovery SELECTs include `id` + `root_id` + `box` + `hpath` + `updated`
   (all columns on every block row), so every discovery row carries the docId that `read`
   and the write modes consume, its per-row KB attribution, and its recency signal
   (doctrine, §4).
2. **search** — full-text search via `/api/search/fullTextSearchBlock` (the §2 first named exception), scoped to active KBs. The route has **no `boxes` field** — `parseSearchBlockArgs` (kernel/api/search.go) derives the box set from the first segment of each `paths` entry — so the extension resolves `kb` names to notebook IDs and sends `paths: [<boxId>...]` (request shape pinned by integration test, §10: a wrong shape is *silently ignored* by the kernel and degrades to whole-workspace search, where pre-filter `pageSize` truncation can drop every in-scope match); the agent never writes box IDs and no injection machinery is needed, unlike query. **`method` is tool-owned, never agent input (decision record)**: the route accepts `method: 2` — SQL search — which the kernel gates to admin role only (`api/search.go`), and the API token is always admin, so an agent-supplied `method` could smuggle raw SQL through the search route, bypassing the query tool's parser certification entirely (it reaches the same index the query tool guards, so it is a certification bypass, not a new capability surface). The extension always sends `method: 0` (keyword search) and rejects any agent-supplied `method` value — one tool-schema constraint closes the bypass. The same ownership rule covers the route's auxiliary params (`types`, `orderBy`, `groupBy`): tool-owned, rejected if agent-supplied — same smuggling class as `method`, smaller stakes, one schema constraint each so no second `method`-shaped hole appears mid-build. Tool-owned values are pinned too: the tool sends only `query`, `paths`, `pageSize`, and `method: 0` — the aux params are **omitted entirely**, letting the kernel's own defaults apply (`parseSearchBlockArgs` defaults `orderBy`/`groupBy` to 0 and `types` to the full default set when absent, `api/search.go:626-705`); absent is the pinned behavior, never invented defaults. **Post-filter backstop**: returned blocks are dropped unless their box is in the resolved set (`post_filtered: true` in the result, same semantics as query); the truncation marker counts post-filter matches. **Per-KB fan-out (decision record)**: the tool issues **one kernel call per resolved KB** (`paths: [<boxId>]`, the shared limit constant as `pageSize`) and merges the results — never one call with multiple `paths` entries under a single `pageSize`. The kernel takes one `pageSize` over the union of the boxes, so a single multi-KB call lets a hit-rich KB fill the entire pre-filter window while another active KB's in-scope matches are dropped pre-filter — invisible to both the post-filter backstop (it drops *out-of-scope* rows) and the truncation marker (it counts *post-filter* rows): the same silent-miss class the `paths`-shape pin guards, one layer deeper. Query has no such hole — `box IN (...)` filters inside SQLite before `LIMIT` applies — so fan-out is what restores recall parity between the two discovery tools. Semantics pinned: merged rows keep per-KB kernel order (no global relevance rank exists — kernel rows carry no scores); the truncation marker is computed per call and aggregated into the envelope (`truncated: N rows — truncated in 2 of 3 KBs`); a single active KB degenerates to exactly the single-call shape (zero change where the bug cannot exist). Cost: N kernel round-trips per search (N = active KBs, normally 1–2), an armed cooldown refuses locally before any fan-out call is issued, so fan-out adds no lock-extension surface (§9). Pinned by the §10 two-KB saturation case. **Echo contract (decision record)**:
  every row echoes the full doc address — `id` (the matched block, kernel `id`),
  **`root_id`** (kernel `rootID` — a doc's root block ID *is* the `docId` `read` consumes),
  `hpath`, `box` mapped back to its resolved **KB name per row** (the extension built
  the name→box map for `paths` itself, so the reverse mapping is free), and `updated`
  (recency echo, same column the query pattern carries — see the shape note below),
  making a multi-KB search result self-describing — the same property the query envelope
  already has. Search
  is the discovery step: a hit is directly consumable as `read { kb, docId: root_id }`
  with no intermediate box→name resolution hop, so the `search → read` recall loop (§4)
  never dead-ends on attribution. (Kernel shape verified at 3.8.2: the route returns
  `[]*Block` whose JSON carries `box`, `rootID`, `hPath`, `id`, `updated` per hit —
  `model/block.go:43-74`; the FTS projections select `created, updated` verbatim,
  `model/search.go:2479`, and `fromSQLBlock` copies `Updated` through untruncated —
  unlike `content`, capped at 5120, and `hpath`, snippet-cut at 512 bytes, which is one
  more reason hpath is display-only in this doctrine — `model/search.go:3094`. The
  multi-word doc-mode path rides `SELECT blocks.*`, full row included —
  `model/search.go:2764-2800`.) `updated` is the **matched block's** update time, not the
  doc's: doc-level recency for reconciliation reads the root row (`id = root_id`) or a
  `read`, never whichever block happened to match.
3. **read** — fetch a doc as GFM markdown via `exportMdContent`. `getDoc` (DOM output) is
   never used — the block-ID outline and spill design presuppose GFM. **Addressing
   (decision record, R2; full record §4): `read` takes `kb` (one name) + `docId`** — an
   echoed target, never invented by the agent; read-by-name does not exist, and the
   ownership query doubles as the scoping check. On success the tool returns the doc
   body (spill budget below) plus the outline ride-along (below); the recall loop is
   `search/query → read {kb, docId}` (§4).
4. **write-back** — create/update/reconcile distilled knowledge in KB notebooks
   (interactive write confirmation, always on). Write modes and collision handling are
   pinned in §4 (echoed-docId targeting, create-by-title with the stored-title
   existence guard, replace-first preference, `delete`/`move` for reconciliation — no
   whole-doc rewrites).

### Result budgets (inline-cap + spill-file)

Tool results are a **map, not the territory**: oversized results are cached to disk, never
truncated away. Mechanism adopted from the proven shape in `~/pi-browser`
(`capFetchContent`): content within the inline limit is returned directly; overflow is
written to `os.tmpdir()/pi-kb/<session-id>/{tool}-{sha256-16hex}.jsonl|.md` — per-session
subdirectory, so concurrent sessions querying the same KB never collide — hash =
first 16 hex chars of the SHA-256 of the full spilled content, so identical payloads
dedupe and names never collide. **No cleanup machinery** (decision record):
`session_shutdown` also fires on resume/fork, where the resumed transcript still quotes
the spill paths — any cleanup there deletes files the agent is about to grep, and the
reason set (`quit`/`reload`/`new`/`resume`/`fork`) has no safe terminal subset that
justifies the machinery. Spill files are hash-named files in a per-session temp dir:
disk-bounded by spill frequency, wiped by the OS on reboot, and a quit-then-resume or
crash just leaves them — the resumed agent re-queries and re-spills (same payload →
same hash → same filename). Accumulation is accepted; a cleanup pass is a v2 add-on if
/tmp usage ever matters (§9). Spill format: **JSONL** — one JSON object per line
for query/search rows and outline spills (lossless, self-describing, still line-greppable; `.jsonl`
suffix); `read` spills are raw text (`.md` suffix — the payload is `exportMdContent`
GFM). The inline result keeps an **8000-char newline-boundary preview** plus
`… N more — full result in <path>`, and the agent extracts what it needs with the native
`read` (offset/limit) and grep — no paging protocol to invent, nothing is lost, only
deferred. Three constants (`SPILL_DIR`, `PREVIEW_CHARS`, `OUTLINE_HEADINGS`) and one helper.

- **query** — the extension injects `LIMIT` into the statement when the AST shows it
  lacks one (default 64,
  extension-owned — the kernel's own clamp tracks the user's workspace `Search.Limit`
  setting and only fills in *missing* clauses on its primary AST parse path, so it is a
  backstop, not a contract). Because certification is parser-based (below), limit
  detection is exact — `ast.limit` is present or absent; no text-scan consequence map to
  pin. If the result count equals the limit, the tool result says so (`truncated: 64
  rows — refine the query; full result in <path>`); spilled results are JSONL rows
  (format pinned above). **Agent-supplied `LIMIT` passes through uncapped (decision
  record)**: the extension injects a LIMIT only when the AST shows none; an
  agent-supplied LIMIT is never clamped or rejected — the agent owns its query budget
  the same way it owns its WHERE clause, the spill mechanism bounds the result
  (lossless, deferred to disk), the 30 s client timeout bounds a runaway call, and
  row-level scoping is unaffected (the injected `box IN (...)` rides any LIMIT). The
  passthrough is pinned by a unit case (§10) so a parser bump can never silently change
  it. If oversized-LIMIT calls become a real latency pattern, the upgrade path is a
  one-line `min(existing, 64)` clamp in the same AST rebuild step — deferred until
  earned.
- **query scoping (decision record)** — `kb` (array, §5) resolves to notebook IDs; the
  extension owns the `box IN (...)` predicate, the agent never writes `box` or knows IDs.
  Certification is **parser-based, not token-scanned**: `pi-kb` uses **`node-sql-parser`**
  (SQLite dialect) — the extension's one runtime dependency (`siyuan-core` stays
  zero-dep; scoping is policy, and §3 policy is extension-owned) — **pinned to the exact
  spike-verified version (`node-sql-parser@5.4.0`)**, same discipline as the §8 kernel
  pin: layer 1's AST certification and CTE rejection rest entirely on this library's
  parse/serialize behavior, so a transitive or careless bump could silently change what
  layer 1 certifies; dependency upgrades are deliberate acts gated by the §10 upgrade
  checklist, never drift. The kernel itself uses
  vitess `sqlparser` for its own LIMIT clamp, so parser-not-regex is
  upstream-precedented; a hand-rolled scanner's failure mode is silently wrong results,
  and one review pass already found three holes in it (OR precedence, aggregate
  post-filter interaction, unrestricted FROM). Three layers, worst case at each rung is
  a rejection, never a silently mis-scoped query:
  1. **Parser-certified injection** — the statement must parse as exactly one top-level
     `SELECT` (this is the DML gate: `UPDATE`/`DELETE`/`INSERT` are rejected here and are
     doubly dead at the kernel via `mode: "readonly"`, layer 2); FROM over the allowlisted
     tables only (`blocks`, `refs` — `AND box IN (...)` is meaningless or erroneous
     against `blocks_fts` or other tables); **single-table FROM only** — JOINs are
     rejected (the injected `box` predicate is unqualified; against a two-table FROM it
     is an ambiguous column, and while SQLite would reject that loudly — a safe
     rejection, not a silent mis-scope — an unpinned failure mode is a mid-build policy
     invention; v1 has no multi-table use case, so JOINs are rejected with the reason
     named rather than pinned); no subqueries, no CTEs (`WITH` — the kernel's readonly layer
     explicitly *permits* WITH, `sql/stmt_validate.go:165`, so layer 2 will never catch
     one; and a CTE shadowing an allowlisted table name (`WITH blocks AS (SELECT 1 AS
     box) …`) would fabricate in-scope rows past both the FROM check and the layer-3
     backstop; v1 has no CTE use case), no compound `UNION`, no bare
     `HAVING` (v1 policy, unchanged from the scan-era rejection list — now structurally
     checkable instead of heuristically guessed). Anything else is **rejected with the
     reason named**, never guessed at. If certified, the extension **rebuilds the
     statement from the AST**: splice `box IN (...)` into the AST's top-level WHERE
     (`(existing) AND box IN (...)`), inject LIMIT if absent, serialize with the parser's own
     serializer, then **re-parse the serialized statement and verify** it is still a
     single certified SELECT whose WHERE is the original expression ANDed with the
     injected predicate — the executed statement is the re-parsed one. (Mechanism pinned
     by an executed parser spike on node-sql-parser@5.4.0, SQLite dialect — findings
     recorded in §10: the library emits **no AST locations on any dialect**, so the
     originally planned coords-based text splice has no coordinates to read; the spike
     verified the serializer round-trip is **stable on the certified grammar subset**
     (adversarial literals included: escaped quotes, `LIKE` backslash escapes, clause
     keywords inside strings, comment-lookalikes, non-ASCII — 8/8 re-parse to an
     identical AST; reformatting is cosmetic backtick-quoting); **multi-statement input
     does not throw** — `astify` returns an array, so the cert rejects `Array.isArray(ast)`;
     and **UNION parses as `type: 'select'`** with the second arm in `_next`/`set_op`, so
     the cert rejects on those fields, not the type string — the kernel *does* execute
     UNIONs, and a first-arm-only injection would leave the second arm unscoped, whose
     box-less aggregate rows would then pass the backstop exemption.) Bare concatenation
     would turn `WHERE a OR b` into `a OR (b AND box IN ...)`: row queries get rescued by
     the backstop, but aggregates compute over the whole workspace — the exact corruption
     injection exists to prevent. (No WHERE at all → the AST gets a fresh
     `box IN (...)` WHERE; the serializer renders it in clause order before
     `GROUP BY`/`ORDER BY`/`LIMIT`.) (Note: the kernel has no index on `blocks(box)` —
     `box IN (...)` filters at the storage layer but still scans `blocks`; the
     correctness rationale, not a performance claim, is why injection is done this way.
     The §4 title guard likewise matches `blocks.content`, which has no index: it is a
     plain scan over the box's `type='d'` root rows — its LIMIT caps returned rows, not
     scan work, which is fine at personal-workspace scale and indexable if it ever isn't.)
  2. **Kernel executes with `mode: "readonly"`** (§2's second named exception) — a
     `sqlite3_stmt_readonly`-based check; even a certification bug cannot write
     siyuan.db.
  3. **Post-filter backstop** — result rows **that carry a `box` field** are dropped
     unless `box` is in the resolved set (`post_filtered: true` in the result); catches
     anything that slipped layer 1. Aggregate output rows (`COUNT`/`GROUP BY`) carry no
     `box` column and are **exempt** — safe because layer 1 guarantees the injected
     predicate on every executed statement; exempting them is required, else every
     aggregate query returns zero rows. Row-level leaks are impossible.
  The `truncated: N rows` marker counts **post-filter** rows, never pre-filter ones, and
  fires whenever `kept + dropped` reaches the limit — a limit window filled with
  out-of-scope rows must still signal that in-scope rows exist beyond it. `post_filtered`
  is a payload flag alongside the envelope `status`, not a status value: a result can be
  both `truncated` and `post_filtered`. Results echo the resolved KB names **and** the
  injected box IDs, so a multi-KB query result is self-describing.
- **search** — same shared limit constant and truncation marker (per-KB fan-out, above: per-call `pageSize`, marker aggregated across calls).
- **read** — no kernel-side limit exists (`getDoc`/`exportMdContent` return whole docs),
  so the spill mechanism is the only budget: large docs spill in full to the temp file
  while the inline result stays small.
- **Block-ID outline rides inline** (KB-specific addition to the spill shape):
  `exportMdContent` output is GFM without block IDs, but the §4 write path (`edit` mode)
  addresses blocks by ID. So the inline result includes the first `OUTLINE_HEADINGS` of
  the doc's compact heading→block-ID outline even when the body spills — the agent greps the file for
  content and uses the inline map for block addressing. **Budget (pinned)**: outlines
  at or under `OUTLINE_HEADINGS` (200) ride inline as before; an over-cap outline
  inlines the first 200 lines plus `… N more — full outline in <path>` and spills the
  full outline to the per-session dir (same helper, same hash naming, `.jsonl`). The
  cap bounds the **inline rendering only** — anchoring and the §4 `newBlockId`
  verification always run on the full walk data (the unfiltered `getChildBlocks` ID
  set, §4) — so a
  pathological but legitimate doc
  (a generated spec with 2,000 headings) costs one spill file, not 2,000 inline lines
  repeated on every read and every write result. **Mechanism (pinned)**: the
  documented `/api/block/getChildBlocks` (API.md "Get child blocks") called with the
  doc's root block ID — it walks the kernel's AST and returns `{id, type, subType}`
  children **in document order**, with `subType: h1–h6` supplying heading depth; the
  extension filters `type = 'h'` and renders indented `content → id` lines, walking
  container children recursively (bounded by an extension-owned recursion depth —
  note the §4 7-level cap is the *doc-tree depth* limit, a different axis: it counts
  `/` separators in the hpath, and the kernel imposes no cap on block-container
  nesting within a doc, so this bound is ours and exists to keep the walk finite) to
  catch headings nested under lists/quotes. The heading filter applies to rendering only —
  the walk visits every child block, and the tool retains the walk's unfiltered ID set as
  the evidence for the §4 stale-target verification. The
  root block ID is the echoed `docId` itself (a SiYuan doc's root block ID *is* its doc
  ID, and `read`'s ownership query — above — already proved the row exists), so the
  outline fetch needs no second doc query. **Decision record (superseded
  SQL outline)**: the original pin (`SELECT id, content, hpath FROM blocks WHERE
  root_id = ? AND type = 'h' ORDER BY sort`) misread two `blocks` column semantics,
  verified at 3.8.2: `sort` is a block-type weight (`database.go:1772`, every heading =
  5), not document order; and the hash-diff index upsert (`sql/upsert.go:445`) re-inserts
  edited blocks at the table's end, so rowid tie-break order is document order only for
  freshly-indexed docs — the outline returned headings out of order exactly after the
  §4 preferred write modes (`edit`/`replace-section`), silently misplacing the next
  tool-derived anchor. (`hpath` is likewise doc-level on every block row,
  `database.go:1009`, not heading depth — §4's `type = 'd'` filter already encodes that
  truth.) `getChildBlocks` has none of these failure modes and is a documented endpoint —
  no new §2 exception.
  Freshness: the outline is rebuilt on every `read` call from the live block tree — and
  on every doc-targeting write (§4 write-result contract): the write result itself
  carries the fresh outline, so a post-write `read` is never needed just to regain
  valid targets and anchors.
- Where the policy lives: the inline limit and spill mechanism are extension-owned (one
  shared helper, the three constants above); `siyuan-core` stays policy-free — its query method takes
  `stmt` + `mode`, its search method takes an explicit `limit` parameter, and its read
  method takes only the doc `id` (§3 owns the entire read budget via preview + spill).

No index, no embeddings, no graph, no background cycles. The agent performs synthesis
in-session; model-neutrality holds by construction.

---

## 4. Write-back conventions

- **KB notebooks**: settings.json declares an array of KBs (name + notebook id). Each is
  agent-scoped territory. A single monolithic KB is equally valid.
  - Use case example: a recipes KB (sourced from extracted epubs) stays isolated from
    day-to-day project knowledge — domain isolation is a config decision, not a code path.
- **Topic docs → doc trees**: each topic starts as one doc inside the KB notebook; when it
  grows large it becomes a sub-doc tree (SiYuan docs nest to **7 levels by default** —
  `validateCreateDoc` rejects deeper paths unless `Conf.FileTree.AllowCreateDeeper` is set,
  `model/file.go`; `MoveDocs` enforces the same cap against the child depth — the native
  answer to scale, no monolithic mega-docs; a deep tree that hits the cap surfaces the
  kernel's error verbatim, and lifting it is a workspace setting, not extension code).
  Growth vehicles: `create` with an echoed `parentId` mints a nested doc directly (mint
  policy below), and the §4 `move` mode's doc-level flavor (`doc: true`) restructures an
  existing tree.
- **Entity/source separation (from GBrain)**: curated topic docs vs source-material docs;
  sources live as separate docs with **block refs** into topic docs. Provenance rides
  SiYuan block refs/attributes — citations are native, not bolted on.

### Write strategy (decision record)

**Docs are addressed by echoed docId; docs are minted by title (decision records R1–R3, R6).**
SiYuan's addressing contract, verified in kernel source: the **doc ID is the identity key**
— docs live at `data/<notebook>/<blockID>.sy`, uniqueness guaranteed by minting
(`validateCreateDoc` checks occupancy only on the ID path) — while **hpath is a derived
label**: rebuilt from titles on every rename/move (`SetBlockTreePath`, `renameDoc0`,
`MoveDocs`), never used as a uniqueness guarantee, and collidable (duplicate-minting create
since v3.7.0, unguarded `renameDoc0`, same-titled siblings in the UI). The UI itself never
addresses docs by hpath — the file tree is built from ID paths. hpath is therefore unusable
as an addressing key; this design addresses docs by echoed docId and mints by title:

**Doctrine line (pinned in the tool descriptions)**: *mint by title (kernel-normalized).
Discover by query/search. Consume by ID.*

- **Discovery is search/query's job.** Query and search rows echo the doc address in
  full — `root_id` + per-row KB attribution (the include-`hpath` pin, §5; the search
  echo contract, §3) — alongside the display fields (`id`, `hpath`); the recall loop is
  `search/query → read {kb, docId}` with no intermediate resolution call.
- **Consumption is by echoed docId.** `read` and every non-create write mode take a
  `docId` — an **echoed target**: an ID the tool previously surfaced (query row, outline,
  write-result echo, `duplicate`/`near_matches` candidates, move result). `docId` is never
  invented by the agent. Scoping rides one query — `SELECT root_id FROM blocks WHERE
  id = ? AND box = ?`: an id from another KB returns no rows, so the KB boundary holds
  with no ownership machinery beyond what block targets already have.
- **Minting is by title.** `create` takes the topic as a *title*, guards against stored
  titles (below), and the kernel normalizes whatever it stores. The title is a mint
  argument, never an address; titles are display, not identity.

**User edits are free (decision record, R5).** UI renames and hand edits to KB docs are
safe by construction — identity is the docId, block IDs survive renames, and the doc stays
reachable from any query row; no hand-rename advisory or rename-detection machinery is
needed. A rename's worst case is the already-accepted two-docs-reconcilable path: a
retitled doc whose new title no longer matches an agent's remembered mint simply won't be
found by the *guard* on the next create — one duplicate, reconcilable, never data loss.
Titles are display; any casing the user prefers is fine.

**Create mints by title, guarded against stored titles (decision record, R3).** The guard
matches against the kernel's own stored titles on the `type='d'` root rows — kernel ground
truth, never a tool-predicted address:

```sql
-- exact leg (LIKE is ASCII-case-insensitive; pattern = HTML-escape(title),
-- then % and _ LIKE-escaped)
SELECT id, root_id FROM blocks
WHERE box = ? AND type = 'd' AND content LIKE ? ESCAPE '\'   -- 'docker networking'
-- near-match scan (space/hyphen/underscore variance; LIKE is ASCII-case-insensitive)
... AND (content LIKE ? OR content LIKE ? OR content LIKE ?)
-- 'docker networking%', 'docker-networking%', 'docker\_networking%' (_ escaped: LIKE wildcard)
```

The exact leg must be `LIKE`, not `=`: `blocks.content` carries the binary (case-sensitive)
collation, so an `=` guard would send every ASCII-cased variant ("Docker Networking") into
the near-match scan and the `confirmNew` interruption instead of matching transparently.
The exact-leg pattern is built from the **HTML-escaped** submitted title (mint policy step
2, below): the kernel stores the title IAL entity-escaped in `blocks.content`, and entity
escaping is a deterministic, spec-defined transform, so the guard computes the stored form
rather than being structurally blind to it. Entity output contains no `%` or `_`, so it
composes trivially with LIKE-wildcard escaping (order: HTML-escape first, then LIKE-escape).
Two queries, run in order: the exact leg first; only when it returns no rows does the
near-match scan run (the scan's `AND` legs are its own query — the `...` above stands for
the same `box`/`type='d'` filters). The scan is a plain walk over the box's `type='d'` rows
— `content` has no index; its LIMIT caps returned rows, not scan work (fine at
personal-workspace scale, indexable if it ever isn't). Agent casing drift and user
retitles that differ only in ASCII case are absorbed transparently; non-ASCII case
variance (É/é) fails both legs and lands in the accepted-duplicate path. The underscore
leg closes the likeliest cross-session LLM casing drift — kebab-vs-snake
(`docker-networking` vs `docker_networking`), a pair that matches neither the exact leg
nor the space/hyphen legs and would otherwise land in the accepted-duplicate tier the
vector sidecar exists to rescue; `_` is a LIKE wildcard, so it is escaped in the fragment
like any other.

**Mint policy.** The kernel splits the create request path on `/` and find-or-creates
every intermediate segment as a real nested doc; its own comment flags the parent matching
as unstable under duplicate hpaths (issue 9322). The tool therefore never predicts what
the kernel stores — it builds the submission path from ground truth:

1. **Trim** the submitted title — the only lossless transform, and it matches the
   kernel's own `TrimSpace`.
2. **Reject** with a structured, tool-owned (non-localized) error: empty after trim;
   contains `/` (the tool builds the path itself; a `/` in the title would be read as a
   path separator and mint an unintended intermediate doc); >512 runes (the
   `createDocWithMd` handler silently truncates the basename to 512 before any
   kernel-side rejection can fire — the tool rejects where the kernel silently truncates);
   contains tab/newline/control characters (their stored form is an unpredictable kernel
   transform — reject at mint with a rephrase hint; user-minted docs with such titles
   stay reachable by docId per R1). HTML-special characters (`& < > " '`) are **not**
   rejected: the IAL stores them entity-escaped in `blocks.content`, but escaping is a
   deterministic transform the tool can apply itself, so the guard matches these titles
   via escape parity (guard SQL above) instead of rejecting them. Titles like `R&D`,
   `O'Reilly`, or "Don't repeat yourself" mint normally — LLM agents are the primary
   minters and such titles are common, so reject-at-mint here would be a recurring
   interruption training agents toward awkward rephrases. The trade: one new assumption
   (escaping parity), pinned live by the §10 title round-trip; if parity ever breaks,
   the failure mode is a missed guard → accepted reconcilable duplicate, never a silent
   clobber.
3. **Send** the path the kernel will store:
   - *Top level* (no `parentId`): `path = "/" + trimmedTitle` — a single segment, so the
     kernel's parent-matching loop never runs and the doc mints deterministically at top
     level.
   - *Nested* (`parentId` = echoed docId): look up the parent's stored hpath —
     `SELECT hpath FROM blocks WHERE id = :parentId AND box = :kb AND type = 'd'`; no row
     → structured error (stale or foreign target, never a guess); the query doubles as
     the ownership check — and send `path = storedParentHpath + "/" + trimmedTitle`
     **together with** `parentID = parentId`. Nesting requires the multi-segment path;
     `parentID` alone never nests (it only disambiguates duplicate-hpath parents, issue
     8138). The child title remains a single segment appended to a read-back path — never
     a multi-segment title. The path field is the submission envelope, not an address; no
     hpath addressing is reintroduced — the child is consumed by its echoed docId like
     any other doc, and the guard still catches same-title mints anywhere in the box (it
     scans all `type='d'` root rows regardless of hpath).
4. **Verified-create keys on the kernel-returned root ID, fail-loud on shape.**
   `createDocWithMd` returns the minted doc's id; the tool asserts the minted row's
   identity *and* stored shape:
   - *Top level*: `WHERE box = ? AND id = :returnedId AND type = 'd'`.
   - *Nested*: additionally re-read the parent row and assert it still exists with the
     hpath that was used, and assert the child row's hpath against ground truth:
     `child.hpath = :storedParentHpath + "/" + <child row's stored title>` — the expected
     child hpath is built from the kernel's own stored child title, read back from the
     returned row, **never from the submitted title**. A submission-derived assert would
     be exactly the prediction R3 forbids: the kernel stores
     `normalizeDocTitle(submitted)`, so any transform the rejection set doesn't cover
     could falsely fail a successful mint — and the pinned response (retry with the same
     title) would loop forever. If the parent is deleted or renamed between the hpath
     read-back and the create, the kernel silently mints ghost intermediate docs along
     the submitted path and nests the child under a ghost; these asserts refuse the
     result with a structured error (drop the ghost subtree, retry) instead of passing a
     silently-wrong nesting. A by-title re-lookup is never used (same reason). The
     guard→create race duplicate lands in the already-accepted reconcilable class.
     **Superset claim (decision record)**: the mint rejection set above (trim, `/`,
     tab/newline/control, >512 runes) is asserted to cover every transform
     `normalizeDocTitle` applies — any title that survives step 2 stores verbatim, so
     the ground-truth assert cannot falsely fail and the escape-parity guard is
     matchable. This claim is pinned live by the §10 title round-trip (clean titles must
     store verbatim *and* yield the expected hpath); a red pin there means the rejection
     set has fallen behind kernel normalization — extend the rejection list, never
     predict the transform.
5. **Echo** the stored title, real `hpath`, and root docId from the verified root row —
   display plus the docId the doctrine requires. The agent sees any normalization the
   kernel applied; the tool never predicts or matches on it.

**Create is not idempotent — the guard makes it near-idempotent, verified-create makes it
honest.** The kernel's create-when-exists behavior is *not* safe to lean on: since v3.7.0
(commit `4f2148e3b`), `createDocsByHPath` never consults the blocktree for the final path
segment, so a create on an existing path **mints a duplicate doc** — same hpath, fresh
block ID, content written into the new doc, success returned. **No content-landed
check (decision record)**: a content check is unimplementable as pinned — the
kernel parses the submitted markdown into kramdown blocks with minted IDs, so a literal
comparison against any stored field always fails, and loosened enough to pass it is
vacuous. The by-ID assert plus the guard carry the whole value; content comparison would
be mid-build policy invented against a bug that no longer exists.

**Title policy honesty — canonical mint + tiered dedup (decision record, R4).** "Same
title → same address across sessions" was never *identity* determinism; it is determinism
of form for identical strings only, and LLMs paraphrase. The taxonomy, stated explicitly:

| Agent variance across sessions | Mechanism that catches it |
| --- | --- |
| ASCII casing | Title guard exact leg (`LIKE`, ASCII-case-insensitive) |
| Shared prefix ("docker-networking" vs "docker-networks") | Near-match scan (prefix on title) |
| Identical string containing HTML-special chars (`& < > " '`) | Guard exact leg matches via escape parity — the pattern is built from the HTML-escaped title (mint policy step 2), so these titles mint and match normally |
| Identical string whose stored form would unpredictably transform (tab/newline/control — rejected at mint, above) | Rejected at mint with a rephrase hint; user-minted docs with such titles fall to the accepted-duplicate path |
| Paraphrase ("docker-networking" vs "networking-in-docker") | Nothing — accepted duplicate, reconciled later |

GBrain's evidence is the same: its dedup rides embedding similarity precisely because
identity is semantic, surfaced as `create_safety: exists | probable | unknown`. The tier-2
guard + accepted-duplicate path is the zero-dep fallback (their `probable/unknown` with
LIKE instead of vectors); the §6 vector-dedup sidecar is the eventual **primary** mechanism
for the identity property.

**Create/update/reconcile flow** (the tool decides, not the agent's guess):

1. Agent supplies a title (create) → tool trims and validates it (mint policy, above) and
   runs the guard's exact leg. **More than one row** (a normal kernel-created state —
   same-titled siblings are creatable in the UI, and the guard→create race can produce
   one) → `duplicate`
   status: return all rows — docId, title, each doc's **`updated` timestamp** (the
   recency signal for the reconciliation judgment: when the loop is "told X twice, the
   second version differs", the agent must be able to tell which doc is current — without
   it the reconciliation below is a coin flip between echoed IDs), and each doc's
   **budgeted heading outline**
   (not a first-paragraph excerpt: the judgment this stop demands is *content* identity,
   not title identity — byte-identical titles are legitimately different topics, and a
   paragraph excerpt shows neither structure nor enough surface to judge — while the
   outline, plus the `updated` recency signal above, does; rows at the exact-leg stop
   are few, so the outline budget is affordable here; budgeted like §3's outline cap,
   spill-backed). An inline body is draft-staged to
   `stagedPath` on this stop too (guard-stop draft staging, below — the merge exit reuses
   the staged file for the `append`/`edit` content). The agent reconciles before any
   write — edit/append onto the wanted docId, or `delete {docId, doc: true}` of the
   unwanted doc (write modes below); never append to whichever row SQLite returns
   first. The echoed docIds give `duplicate` its exit (R1), and the response message
   names all of them: reconcile by docId, or pass `confirmNew: true` to mint a
   conscious second doc (decision record below). Byte-identical titles are
   legitimately different docs ("John Smith", the engineer vs. the biologist —
   same-titled siblings are creatable in the UI, and R4 concedes identity was never
   solvable syntactically), so the stop's judgment is a content judgment, which is
   what the outline exists to serve. A sparse or empty stub surfaces as an empty
   outline — itself the identity signal.
2. **No exact row** → near-match scan (space/hyphen/underscore prefix variants on the title, above;
   `%`/`_` escaped in the fragments so a title like `100%_devops` can't widen the scan;
   fragments are built from the HTML-escaped title, same parity as the exact leg;
   writes take exactly one KB name (§5 `kb` param), so the scan is single-notebook-scoped
   and never surfaces candidates from other notebooks, including user-owned ones; the
   scan returns doc rows, not every block) — **capped at 20 rows with the shared
   `truncated` marker** (one line, reuses the existing envelope machinery; a short title
   like `go` can prefix-match hundreds of docs and the agent drowns in candidates).
   Empty → mint per the policy above (verified-create follows). Near-matches → do NOT
   create; return the candidates (docId, title, first paragraph, `updated` — same
   recency signal as the `duplicate` rows, above) with a `near_matches`
   status so the agent consciously chooses: read an existing topic by its echoed docId
   and edit/replace-section it, or create a genuinely new one with **`confirmNew: true`**
   (pinned below). Without that flag the same title hits the same guard on retry — an
   escape hatch is the mechanism, not an instruction to argue with the tool a second
   time. The rejection message names the path: `near-matches exist for 'docker-networking'
   — pass confirmNew: true to create anyway, or read an existing topic by docId and edit
   it`. Failure mode if the guard misses: two docs, reconcilable later — never a silent
   clobber.

   **Guard-stop draft staging (decision record)**: a guard stop (`duplicate` or
   `near_matches`) on a create whose body arrived **inline** stages the submitted
   markdown to the session's spill dir as `draft-<sha256-16hex>.md` and returns the path
   as `stagedPath` in the rejection payload, message: `body staged at <stagedPath> —
   retry with markdownFile: '<stagedPath>'` — the retry re-enters the whole flow for ~25
   tokens instead of re-transmitting the full draft (the pi-lean-host token-treadmill
   class: long payloads + validator stop + inline retry = repeated full-payload
   transmission). The staged file holds exactly the string the guard saw; the retry
   re-reads it under the read-once-at-call-start pin (file-path input record, below), so no new
   race is introduced. Creates that already used `markdownFile` stage nothing (the file
   is already on disk — `stagedPath` absent, message unchanged). No size threshold
   (staging a 3-line body is cheaper than a knob to decide whether to), no cleanup (the
   §3 no-cleanup spill posture covers it), deterministic name (same hash → same file, the
   resumed-agent property). Upgrade path: extend staging to `confirm_timeout` write
   refusals if resend frequency ever shows up on the write path.

   **`confirmNew` (decision record)**: the flag is **not declared in the write tool's
   input schema** — the agent learns it exists only from a `near_matches` rejection or
   a `duplicate` response message, so speculative/habitual flagging cannot form before
   the first collision (an agent that passes flags preemptively would otherwise disarm
   the guard on every create). When passed, it bypasses the **entire guard — both
   legs, including an exact-title match**. An exact match can be a legitimate new doc
   (byte-identical titles ≠ identical topics, above), the agent has just seen the
   existing doc's content, and content identity is exactly the judgment call the tool
   cannot make for the agent — so the agent, deciding with data in view, is the right
   layer. A flagged re-mint of an exact match is a **conscious duplicate**: two
   same-titled docs, the accepted reconcilable class — the failure mode of a wrong
   judgment is a visible duplicate the user merges, never silent clobbering. What the
   flag does NOT bypass: the write confirmation and verified-create (§4 R3) — a
   flagged create is still a verified mint. The near-match candidates keep
   first-paragraph excerpts rather than outlines (up to 20 rows — excerpts scan
   cheaply; the outline upgrade is reserved for the exact-leg stop, where rows are
   few and excerpts are worthless).
3. **Found** → return the doc's root docId, outline + block IDs (with content), and let
   the agent pick the write mode — the target for that write is the echoed docId, never
   the title (R1). **Anchor ownership (decision record)**: the tool derives all block
   anchors (`previousID`/`nextID`/`parentID`) from the outline it just fetched — the agent
   never supplies block anchors. An agent-supplied `previousID` after a section-ending list
   is exactly the nesting trap the anchor rule exists to avoid (below); tool-derived anchors
   make that trap unreachable by construction. **Preference order is replace-first** (the workspace is git-tracked and
   the user favors doc coherency over append-only growth): new material that *corrects or
   supersedes* existing content is written in place; `append` is for genuinely new facts:
   - **`edit` (preferred)** — `updateBlock` on a specific block ID (correcting a stale
     fact, replacing a superseded paragraph). The inline outline carries heading IDs only;
     for a non-heading block the agent gets its ID from the `query` tool
     (`SELECT id FROM blocks WHERE root_id = ? AND …`) — the outline deliberately does not
     carry every block ID (context bloat).
   - **`replace-section`** — swap a section's body **in one tool call** (the tool
     enumerates → inserts → deletes internally; agent-orchestrated multi-call sequencing
     would re-expose the stale-enumeration hazard this ordering exists to avoid),
     **insert-before-delete** (no kernel
     transactions on the documented surface; a mid-sequence failure must cost visible
     duplication, never loss): insert the new body first with the same anchor rule as
     `append` — `insertBlock` with `nextID` = the next heading's block ID (or
     `appendBlock` on the doc root for the final section); a bare
     `parentID`=<heading id> insert is rejected by the container check the doc itself
     documents (headings are leaves) — then `deleteBlock` the old blocks. **The old
     section's block IDs are enumerated by the §3 `getChildBlocks` document-order walk
     before the insert, never by SQL** — §3's superseded-outline record proves SQL
     enumeration breaks on edited docs — and this is the *delete set* of the preferred
     write mode. The section slice runs from the
     target heading to the next heading of same-or-shallower depth: blocks after the
     target heading up to (not including) that boundary heading — deeper headings (an
     h3 under an h2 target) belong to the section and are deleted with it. **Final
     section (no boundary heading): the slice runs to end of doc, so trailing
     non-heading content after the last heading is deleted with the section** — pinned,
     not accidental: the alternative (excluding trailing content) is rejected because
     the replacement then appends at doc end *after* the surviving fragments, which sit
     under a section the agent believes it fully rewrote; sweeping is the coherent
     semantic. Because the inline outline is heading-only (§3), trailing content is
     otherwise invisible at decision time — the write confirmation therefore displays
     the enumerated delete set's block count, and the same backlink visibility the
     `delete` mode's confirmation carries: the `delete` mode's `refs` query (§4,
     `SELECT DISTINCT root_id FROM refs WHERE def_block_id IN (...)`) runs over every
     ID in the walk-enumerated delete set, and the confirmation carries the
     inbound-ref count plus referring doc hpaths. The asymmetry this closes: the
     heading ID survives (below), but refs into the section's *content* blocks — the
     same citation surface `edit`'s `blockId` is sourced from — point at IDs the
     replace deletes and re-mints, so the preferred, highest-stakes write must show
     what it orphans, not just the rarer single-block `delete`. Advisory, same
     semantics as `delete`: the agent has seen the refs and decides. The new body
     lands under the same heading (the anchor rule), so an enumeration issued after the
     insert would sweep the replacement into the delete set and silently empty the
     section.
     Block IDs inside
     the section are minted fresh, but the heading ID survives (the new body lands
     under the same heading, which the anchor preserves) — refs into the heading
     resolve; refs into the section's content blocks orphan, and the confirmation's
     backlink count plus the result's `invalidRefs` echo (§4 write-result contract)
     make them visible before and after the agent decides.
   - **`append`** — new fact, new section. Headings are leaf blocks — the kernel's
     `appendBlock` requires a *container* parent and rejects `parentID=<heading id>`
     outright — so "insert under a heading" is mechanically insert-with-anchor, and the
     anchor rule is pinned: **`insertBlock` with `nextID` = the *next heading's* block ID**
     (computable from the heading-only outline; the kernel skips the container check when
     `previousID`/`nextID` is set — `api/block_op.go`). Anchoring `previousID` after a
     section's last block instead would nest the new block *inside* a list/quote ending
     that section (insert is AST-sibling placement). Final section (no next heading) →
     `appendBlock` with the doc root as parent. **Divergence from the kernel's own
     suggestion (deliberate)**: the container-check rejection text (`blocktree.go:511`)
     recommends `previousID=<heading id> or previousID=<last block below the heading>`;
     both are rejected here — the first lands the block *before* the section's existing
     body (top-of-section placement, wrong for appending), and the last-block variant is
     not computable from the heading-only outline without a non-heading enumeration per
     append. `nextID=<next heading>` gives exact end-of-section placement from data the
     tool already has and sidesteps the list-nesting trap; implementers cross-checking
     kernel source should not "correct" this back to the error text's idiom. This is the second reason the inline
     outline exists: addressing *and* anchoring.
   - **`delete`** — `deleteBlock` for a block; a whole doc rides the documented
     `/api/filetree/removeDocByID` (`doc: true` + `docId` — the by-ID endpoint, no path
     shapes). The
     reconciliation vehicle for `duplicate` status (step 1) and conscious section removal.
     Before deleting, the tool runs a backlink check through the documented SQL endpoint —
     `SELECT DISTINCT root_id FROM refs WHERE def_block_id IN (...)` (the kernel's `refs`
     table in siyuan.db, queryable via `/api/query/sql` — no new tool surface) — and the
     confirmation carries the inbound-ref count plus referring doc hpaths, so the agent
     decides with the refs in view instead of guessing from the outline. The `IN (...)`
     set is the walk-enumerated delete set — the target block for block-level deletes,
     the whole doc's `getChildBlocks` walk for `doc: true` (the §3 SQL-vs-walk
     precedent: enumeration never rides SQL on a live doc). Inbound refs to a
     deleted block are orphaned — the agent has seen them and decides; doc-level deletes go
     through write confirmation.
   - **`move`** — `/api/block/moveBlock`; the restructure vehicle for same-doc reordering
     and cross-doc block relocation (the doc-tree growth vehicles are nested `create`
     and the doc-level flavor, below). **Destination addressing (decision record)**: the
     destination doc is `toDocId` — an echoed target (R1), scoped by the same ownership
     query as every other doc reference (a stale or foreign destination docId →
     structured error, never a guess; same-doc moves name the source doc's own docId).
     **Intra-KB only (decision record)**: the destination resolves within the call's single `kb` — the §5 single-name write contract makes cross-KB structurally unreachable, no extra validation needed; the rare domain-migration case is a SiYuan UI hand-move, which is safe here because identity is the docId and the doc stays reachable from any query row (§6). Cross-doc anchoring cannot
     reuse the source outline — the destination was never outlined — so the tool fetches
     the **destination** doc's outline via the §3 `getChildBlocks` helper and derives the
     anchor from it; the anchor-ownership rule (agent never supplies anchors) holds across
     the doc boundary, which is the whole reason `move` exists as one tool call instead of
     insert-copy + delete (copy-delete mints fresh IDs and orphans every inbound ref to the
     deleted source blocks — the exact §4 no-whole-doc-rewrites hazard at block granularity;
     `moveBlock` preserves block IDs, so provenance survives the move). Omitted
     `toHeadingId` → destination doc end (`appendBlock`-on-root fallback, same default as
     `append`).
   - **`move` with `doc: true` (doc-level, decision record)** — moves the whole source doc
     under a new parent via **`/api/filetree/moveDocsByID`** (`fromIDs: [<sourceRootID>]`,
     `toID: <destination doc's docId>` — a parent doc — or the notebook ID when `toDocId`
     is omitted, the un-nest case; S1: the path-based `/api/filetree/moveDocs` shapes are
     rejected — `fromPaths: [<hpath>.sy]` fails `getBoxesByPathsStrict`'s
     `IsNodeIDPattern` check and `toPath` is ID-path semantics, so the ID endpoint
     eliminates the path shapes entirely; both root IDs are in hand from the ownership
     query / the echoed destination target). This is a growth and restructure vehicle
     alongside nested `create` (above). Identity is preserved (`.sy` paths are ID-based;
     block IDs survive) so block-ref provenance survives, same as block-level moves.
     Kernel behaviors pinned: the 7-level depth cap is enforced against the child depth
     and surfaces verbatim (`model/file.go` `MoveDocs`); a move to the doc's own parent
     is a kernel success no-op; and **the kernel silently filters a move into the source
     doc's own subtree** (`FilterMoveDocFromPaths`, `util/path.go` — the fromID is
     dropped, zero moves, success returned), the same silently-wrong class as the search
     `paths` shape — so the tool retains its self-descendant pre-check (destination is
     the source doc or its descendant → rejected with the reason named, never forwarded
     to the kernel's silent drop). Intra-KB holds (same decision record as block moves):
     the destination docId is validated against the call's single `kb` by the ownership
     query. The result carries the source doc's fresh `outline` plus the **stored title
     and real `hpath`** echo from the root row (display only — after a doc-level move the
     hpath has changed, which is exactly why the doc is consumed by its echoed docId
     hereafter, never by topic); **no `destOutline`** — `getChildBlocks` walks blocks,
     not child docs, and the doc the agent writes into next is the moved one, whose
     outline already rides the result.

**Write-back tool schema (pinned)**: every call takes `kb` (exactly one name, §5), `mode`,
and a content-bearing body on `create`/`edit`/`replace-section`/`append` (meaningless on
`delete`/`move`) — **`markdown` (inline string) XOR `markdownFile` (path to a prepared
markdown file, decision record below)** — plus the mode-specific target: `create` takes
`topic` (a **title** — mint policy above) and optional `parentId` (echoed docId →
nested mint); **every other mode takes `docId`** (echoed target) instead of `topic`:

**File-path input (decision record)**: `markdownFile` lets a large body travel by path
(~25 tokens) instead of inline (a 500-line draft is the whole payload per call). The tool
**reads the file once, at call start, and the captured string is what the entire flow —
guard, write confirmation, kernel call, verification — operates on**; file edits between
confirm and apply never apply (one sentence kills the whole mid-flow race class). Missing
or unreadable file → structured `error` naming the path, **no kernel call fires** (the
read is the call's first content step, before any guard query); passing both `markdown`
and `markdownFile` (or neither, on a content-bearing mode) → shape-validation `error`.
Trust posture matches §6's soft-scope ceiling: the path is agent-controlled in a
single-user VM holding an admin token — pin "must exist, must be a regular file" and stop;
no path allowlisting machinery. Inline `markdown` stays the primary path for normal-sized
bodies; the file form is the escape valve for long drafts, and the two share one schema
union, one read, and zero tool-side state.

| mode | extra params | notes |
| --- | --- | --- |
| `create` | optional `parentId` (echoed docId → nested mint, R3), optional `confirmNew` — **not declared in the tool's input schema** (discovered only via rejection/duplicate response messages, §4 decision record) | flows through flow steps 1–2 (title guard: exact leg + near-match scan) and mint-policy step 4 (verified-create); `confirmNew: true` bypasses the entire guard — both legs, including an exact-title match (a flagged re-mint is a conscious duplicate, the reconcilable class) — write confirmation and verified-create still apply |
| `edit` | `docId`, `blockId` | `docId` scopes and targets the doc (ownership query); `blockId` is an agent-supplied *target*, read off the inline outline or the `query` tool; a target is not an anchor — `previousID`/`nextID`/`parentID` anchors stay tool-derived (above) |
| `replace-section` | `docId`, `headingId` | one tool call — the tool enumerates → inserts → deletes internally (above) |
| `append` | `docId`, optional `headingId` | omitted → doc end (`appendBlock` on the doc root); with a heading → tool derives the `nextID` anchor from the outline |
| `delete` | `docId`, plus `blockId` **or** `doc: true` | block-level = `deleteBlock`; `doc: true` = whole-doc delete via the documented `/api/filetree/removeDocByID` (S1 — the by-ID endpoint, no path shapes); the backlink check rides the write confirmation (§4 `delete` mode) |
| `move` | `docId`, plus `blockId` **or** `doc: true`, `toDocId` (destination doc; omitted on `doc: true` → notebook root), optional `toHeadingId` (block-level only) | destination addressed by echoed docId (ownership-checked like every doc target); same-doc move = `toDocId` naming the source doc; the tool fetches the *destination* outline and derives the anchor — never agent-supplied (§4 `move` decision record); `doc: true` = doc-level move via `/api/filetree/moveDocsByID` (§4 doc-level decision record) |

The split the table encodes: **targets** (which doc or block to touch) are agent-supplied,
from data the tool already showed it; **anchors** (where new blocks land relative to siblings)
are always tool-derived. An implementer never has to invent either policy.

**Stale targets (decision record)**: agent-supplied targets (`blockId`/`headingId`) and
tool-derived anchors are read off outlines fetched earlier in the session, and the
freshness contract (write-result contract, below) guarantees freshness only across this
session's own writes — §9 accepts concurrent sessions on one KB, so another session's
`replace-section` or a UI hand-edit can delete a target or anchor between the outline the
agent saw and the write it issues. The four block-write ops do **not** behave uniformly
when the ID no longer resolves, verified against source at 3.8.2:

- **`updateBlock` errors synchronously** — `PerformBlockUpdates`
  (`model/block_update.go`) loads the tree and node before building operations and
  returns a real error (`block [id] not found`) that the handler surfaces as a failed
  HTTP result. The honest case: the tool passes the kernel error through verbatim with
  the fresh outline attached, so the agent re-targets.
- **`insertBlock`/`appendBlock` silently roll back behind a success** — the handler
  (`api/block_op.go`) enqueues the transaction asynchronously and unconditionally
  returns `code: 0`; when the anchor does not resolve, `doInsert0`
  (`model/transaction.go`) returns `TxErrCodeBlockNotFound` and `flushTx` surfaces it
  only via `util.PushTxErr` — a UI websocket push a headless API client never sees. The
  HTTP result says success, the transaction rolled back, nothing was inserted — and the
  write-result contract would otherwise echo a `newBlockId` minted from the rolled-back
  transaction. This is the exact silently-wrong class the design exists to prevent.
- **`deleteBlock` on a missing ID is a kernel success no-op** — `doDelete`
  (`model/transaction.go`) returns nil on `ErrBlockNotFound` (the in-source comment
  treats a missing block after a move as normal). Benign — the end state (block absent)
  is what the agent asked for — but the tool must not read the success as evidence the
  delete *did* anything.
- **`moveBlock` straddles both classes, depending on which ID is missing and where it
  is caught** — the handler (`api/block_op.go:474`) checks the blocktree index
  synchronously: a missing source `id` or a missing `previousID`/`parentID` anchor
  returns a real HTTP error (`block not found` / `target block not found`, `code: -1`),
  the `updateBlock` class. But the transaction layer (`doMove`,
  `model/transaction.go:572`) re-resolves both IDs against the live tree and returns
  `TxErrCodeBlockNotFound` on a tree-level miss — the silent-rollback class: HTTP
  `code: 0`, transaction rolled back, nothing moved, the error pushed only via
  `util.PushTxErr` (websocket, invisible to a headless client). And a third class no
  other op has: `TxErrCodeSkipTx` — moving a block before itself, moving a parent into
  its own child, or a cross-crypto-boundary move is silently skipped with no error
  pushed anywhere (not even the websocket), HTTP success returned.

Because the kernel cannot be trusted to report a failed insert, verification is the
tool's job, and the evidence is already in hand: **every insert-bearing write result
must show `newBlockId` present in the fresh post-write block tree** — the unfiltered ID
set from the same `getChildBlocks` walk that renders the outline (§3 pins that the walk's
full ID set is retained for exactly this; an inserted paragraph never appears in the
heading-only outline, so the outline itself can never be the evidence) — absent →
`{status: error}` naming the vanished target/anchor, fresh outline attached, never a
silent success. **Multi-block bodies upgrade this to a walk-set diff**: the write tool
accepts arbitrary markdown and the kernel mints one block per parsed block, so a
multi-block body's `newBlockId` is only the kernel's representative of several — the
verification compares the post-write walk set against the pre-write set (the same walk
the anchor derivation already fetches before every write): the returned ID must appear
among the newly-present IDs, and a single-block body's diff must be exactly that one ID
(full record on `newBlockId`, below). The other targets ride their kernel behavior or an equivalent
assertion: an `edit` target's synchronous not-found error surfaces verbatim; a `delete`
target already gone reports success with the unfiltered post-write block tree as
evidence — the same walk-ID set the insert verification uses, since a non-heading target
can never appear in the heading-only outline (goal state reached either way); a **`move`
is verified like an insert** — `movedBlockId` must appear in the destination doc's
post-move `getChildBlocks` walk set (and be absent from the source's), the outlines the
cross-doc move result already fetches — because a tree-level miss rolls back silently
behind HTTP success exactly like the insert path (cross-doc move record, below). The
SkipTx degenerate destinations (block moved before itself, parent into own descendant)
are unreachable by tool-derived anchors — the tool never anchors a block relative to
itself or into its own subtree, the same tool-side pre-check the doc-level move pins
against `FilterMoveDocFromPaths`. The §10
integration suite pins all four behaviors against the real kernel.

**Write-result contract (pinned)**: every doc-targeting write result carries three fields
alongside the envelope, all built from data the write flow already has in hand — the only
added round-trip is the outline fetch (documented `getChildBlocks`, the same call the
§3 `read` outline uses, same spill budget, same helper). Every create and write result
additionally echoes the doc's **root `docId`, stored title, and real `hpath`** from the
root row — the docId is the echoed target R1 requires and the input to
every follow-up read/write/move; title and hpath are display only, not an address:

- **`outline`** — the fresh heading→block-ID map of the affected doc, rendered by the
  §3 outline helper from the live block tree (the §3 `OUTLINE_HEADINGS` cap applies to
  the inline rendering; the full outline spills, and the verification logic below runs
  on the full data regardless). Outline freshness is the tool's contract,
  not an agent discipline rule: a stale outline cannot be relied on because the fresh
  one always arrives with the write result, and chained writes (`append` → `edit` →
  `replace-section`) need zero re-reads between links.
- **`anchor`** — the placement the tool resolved (e.g. `nextID=<next heading id>` or
  `appendBlock(root) — no next heading`), present on placement-bearing modes
  (`append`, `replace-section`, `move`). This makes the doc-end fallback visible at the
  moment it happens: `append`/`replace-section` on a doc whose last heading has
  trailing non-heading content lands the body at doc end, not directly under that
  heading — on `append` content is preserved and valid; on `replace-section` the trailing
  content is swept into the delete set (the final-section boundary pin, above) — and the
  `anchor` echo shows exactly where
  it went (accepted placement quirk; the alternative — anchoring `previousID` to the
  heading's last block — needs a non-heading enumeration for a rare shape and is
  deliberately not built).
- **`newBlockId`** — the inserted block's ID (insert/append/replace-section modes), the
  kernel call's return value; it is the ready target for a follow-up `edit` without a
  `query` round-trip. **Multi-block markdown (decision record)**: a body that parses to
  N blocks mints N block IDs, and the kernel returns one representative ID whose choice
  the tool does not assume (not source-read — the §10 multi-block pin converts the
  return-value assumption into evidence, the same move as the search-shape pin). For a
  multi-block body `newBlockId` therefore addresses *one block of the appended content*,
  never "the whole thing I sent" — an agent that needs a different fragment of its own
  body re-locates it via the outline/`query` (echoed IDs, R1), the same route as editing
  any other non-heading block. **Verified, not trusted** (stale-target record, above):
  the walk-set diff must contain the returned `newBlockId`, and a single-block body's
  diff must be exactly that one ID — the assertion, not the HTTP code, is what turns
  the kernel's silent rollback into a visible error, and the diff (not just returned-ID
  membership) is what keeps the evidence honest when the kernel mints several blocks
  from one call.

- **`invalidRefs`** — every delete-bearing write (`replace-section`, block-level
  `delete`, doc-level `delete`) echoes the orphan outcome: the count of distinct
  referring root docs whose refs point into the walk-enumerated delete set, queried
  through the same documented SQL endpoint as the pre-write confirmation check (§4
  `delete` mode), run after the delete lands. Verified, not trusted — the same
  doctrine as `newBlockId`: the post-write echo is what actually got orphaned, not a
  prediction, closing the loop the confirmation opens (decision input in, outcome
  evidence out) and giving real-usage telemetry on how often rewrites touch cited
  content. Advisory like the pre-write check: the derived `refs` index can lag (§9),
  so a zero count is evidence, not proof. Non-delete-bearing writes omit the field;
  doc-level `delete` (no doc left to outline) still carries it — the refs query rides
  the pre-delete walk set, not the vanished doc.

`delete` with `doc: true` carries none of the three (no doc left to outline, and no root
row left to echo); doc-level
`move` carries `outline` + the stored-title/`hpath` echo but no `anchor`/`newBlockId`/`destOutline` (§4
doc-level decision record); block-level `delete`, `move`, and `edit` results carry the
outline (edit/move also the other fields where applicable).

**Block-level cross-doc `move` result (pinned)**: a block-level move whose destination
doc differs from the source changes **two** docs, so the result carries both outlines — `outline` (fresh source, via
`getChildBlocks` after the move) and **`destOutline`** (fresh destination, fetched after
the move lands so it includes the moved subtree). Carrying only one would leave the
agent's next `edit`/`replace-section` against the other doc on a stale outline — exactly
the decay the freshness contract exists to prevent. The moved block's ID is echoed as
**`movedBlockId`**, not `newBlockId`: `moveBlock` preserves the ID (that is the
identity-preserving property the mode exists for), and the echo is the ready target for
a follow-up `edit` in the destination. **Verified, not trusted** (stale-target decision
record, above): `movedBlockId` must appear in the destination's post-move walk set and
be absent from the source's — the outlines the result already carries are the evidence.
Same-doc `move` collapses to the standard shape
(`outline` + `anchor`, no `destOutline`). For block-level moves the result shape differs
only in whether the two docs differ; doc-level `move` has its own shape (`outline` +
stored-title/`hpath` echo, no `destOutline` — its decision record above). Cost: one extra `getChildBlocks`
call per cross-doc move, same helper.

**No whole-doc rewrites in v1.** The naive path (removeDoc + recreate) mints fresh block
IDs and silently severs every block-ref pointing into that doc — provenance dies for the
whole topic at once. **Git does not change this**: the workspace's git history can restore
old *bytes*, but refs in *other live docs* point at block IDs that no longer exist — a
revert is a history repair, not a working fix. Replacement therefore means replacing
*content* with identity-preserving ops, never recreating docs. Restructuring (generalizing a topic after a second example, merging
sections, promoting sub-docs) is expressed with identity-preserving ops instead:
`updateBlock`, `appendBlock`/`insertBlock` with `previousID`/`parentID` anchors,
`deleteBlock`, `/api/block/moveBlock`, and doc-level `move` for doc-tree restructuring
(nested `create` under an echoed `parentId` is the growth vehicle for new sub-docs). Block IDs survive all of these, so block-ref provenance survives with them.
Deeper restructures cost N sequential calls (the no-bulk-transactions ceiling, §6), never
data loss. One caveat: `deleteBlock` on a heavily-referenced block orphans its inbound
refs — deletion is a conscious per-block decision the agent makes while looking at the
returned outline, not a side effect of a bulk rewrite.

**Topic growth** ("told X twice, second version differs") degrades gracefully: the second
create hits the guard, returns the existing doc's root docId + outline, and the agent
*replaces* the stale version in place
(`edit`/`replace-section`) — never appends a second, now-contradictory version, never a
duplicate doc, never a silent clobber.

---

## 5. Multi-KB config & scope state

- **Config (declarative)**: settings.json holds the KB array plus connection settings under
  one parent key, `pi-kb` — the parent key matches the package name, avoiding settings.json
  namespace collisions with other extensions (renaming later would be a breaking config
  change; accepted for local-only use). Exact shape:

  ```json
  {
    "pi-kb": {
      "baseUrl": "http://192.168.100.1:6806",
      "apiToken": "…token copied from the workspace conf.json…",
      "kbs": [
        { "name": "recipes",  "notebook": "20240101120000-abcd123" },
        { "name": "projects", "notebook": "20240101130000-efgh456" }
      ],
      "defaultKBs": ["projects"],
      "allowUnattendedWrites": false,
      "writeConfirmTimeout": 60
    }
  }
  ```

  `name` is the human-facing primary key (the `kb` tool param and `/kb` operate on names);
  names must be single tokens — no whitespace or `/` (shape validation rejects them, the
  `/kb <name> on|off` grammar is unparseable otherwise, §5 validation step 1);
  `writeConfirmTimeout` (seconds, default 60) is the write-confirmation dialog timeout —
  `0` waits indefinitely (§5 write-confirmation record);
  `notebook` is the SiYuan notebook ID. Nothing is hardcoded: `siyuan-core` receives
  `baseUrl` + `token` as constructor args and has zero knowledge of IPs, env, or pi; the
  extension is the only layer that reads settings.json and injects them.
- **Validation order (decision record)**: at `session_start`, three steps in fixed order:
  1. **Shape/sync validation** (no network): required keys, types, unique `kbs` names,
     `defaultKBs` names exist in `kbs`, and KB names checked against the `/kb` reserved
     set (subcommand surface below — a KB named `all` is rejected here). KB names are
     also rejected at this pass when they contain whitespace or `/` — the toggle grammar
     is `/kb <name> on|off` split on whitespace, so `my projects` or `projects on` is
     unparseable at toggle time (`projects on` collides with the verb itself); the
     constraint is enforced where names enter the config, and the rejection message
     names it (`name must not contain whitespace or /`) — bad names never reach the
     parse ambiguity, not handled after it.
     Failure **degrades** the session — tools stay
     registered, every call is rejected with the problem named — rather than crashing it.
  2. **Kernel probe** — the §2 version gate, fail-closed for writes.
  3. **Notebook existence** via `lsNotebooks`: a stale notebook ID warns and drops that KB
     from the valid set (its calls get a rejection naming the problem), never a crash.
     `lsNotebooks` also reports per-notebook encryption state (`encrypted`/`unlocked`,
     `model/box.go`): a configured KB with `encrypted: true` is **rejected** at startup,
     naming the KB — `/api/query/sql` executes only against the global `siyuan.db`, so an
     encrypted notebook is invisible to the title guard, verified-create's by-ID asserts,
     and the backlink check; the §4 flow would misfire (the guard cannot see existing
     docs, so every create mints and verified-create then fails loud on a mint the SQL
     surface cannot see, while the delete backlink check silently reports zero refs) —
     the one verified kernel behavior that
     breaks the design's never-silently-wrong invariant (§9). (A *locked* encrypted notebook
     never appears in `lsNotebooks` at all — the kernel skips locked boxes
     (`model.IsBoxUnlocked`) — so it is dropped as a stale notebook ID with that warning
     instead of the named encrypted rejection; both messages fail safe — the KB leaves
     the valid set either way, so the flow never runs against a notebook the SQL surface
     cannot see.)
     This step is also where the token is first exercised — the `/api/system/version`
     probe is unauthenticated (connectivity only, §9), so an auth failure here
     (401/403) is counted by the circuit breaker (below) instead of surfacing later as
     per-call failures.
- **Error surface (decision record)**: every tool result carries one envelope,
  `{status: ok | near_matches | duplicate | error | refused, message, ...payload}` — one
  shared helper; the model reads `status` mechanically and `message` for detail.
  **`truncated` and `post_filtered` are payload markers, never status values (decision
  record)**: a near-match scan capped at its 20-row limit (§4) must signal both the
  guard stop (`near_matches`) and the cap (`truncated` marker in the payload) — one
  status value cannot carry both, so the status classifies the call's outcome and the
  markers ride the payload (a truncated query result is `status: ok` plus the marker).
  Status classes are pinned — the implementer never assigns them per call:

  | Situation | Status |
  | --- | --- |
  | Success (with `truncated`/`post_filtered` payload markers as applicable) | `ok` |
  | Guard stop — near-matches found | `near_matches` |
  | Guard stop — exact-title match(es) | `duplicate` |
  | Kernel call failed or unreachable; verified-create/stale-target assertion failed; guard SQL errored | `error` |
  | Every refusal: version gate, circuit breaker / 429 cooldown, scope or `kb`-param rejection, shape validation, headless write default-deny, write-confirmation decline or `confirm_timeout` | `refused` |

  The `message` distinguishes causes within a class (the 429 cooldown and the breaker
  share `refused` since both mean "no kernel calls will pass" — the message names which).
  The version-refusal message is static text naming the kernel version, the pinned version,
  and the fix (run the §10 upgrade checklist against the new kernel, re-pin, then start
  a new session) — under the strict full-version gate (§2) this is the one message that
  fires on any upgrade.
- **Write confirmation across modes (decision record)**: interactive sessions always
  confirm writes via `pi.ui.confirm`; sessions with no UI at all (`pi -p`) require
  `pi-kb.allowUnattendedWrites: true` (default false = default-deny: no UI ⇒ write
  refused). **RPC mode (`pi --mode rpc`) has a working confirm path and is NOT headless
  for this rule**: `ctx.ui.confirm` in RPC mode emits an `extension_ui_request`
  (`method: "confirm"`) over stdout and blocks until the client answers with an
  `extension_ui_response` (`confirmed: true/false`) — pi sets `ctx.hasUI: true` in RPC
  mode precisely because the dialog methods are functional via that sub-protocol. The
  extension therefore passes a **timeout on every confirm dialog**: a timeout expiry or
  an explicit client cancellation auto-resolves to refused — fail-closed in every
  direction, and never a deadlocked turn on a blocking dialog. The timeout value is the
  **`pi-kb.writeConfirmTimeout`** setting (seconds, default 60 — pinned, not invented
  per implementer; this is the disruption-vs-oversight dial, so it is user-owned rather
  than a constant): `0` waits **indefinitely** (the dialog blocks the write until
  answered — the right value for a user who is usually at the keyboard; no tokens burn
  while blocked). A timeout expiry resolves to refused with reason **`confirm_timeout`**,
  which is **terminal for that write in that session**: a re-request of the *same* write
  returns the terminal refusal immediately (no new dialog) with a message instructing
  the agent not to retry, to stop, and to report the pending write — without this pin,
  an AFK user + a retrying agent is an unbounded confirm/timeout/refuse loop burning
  tokens on refusals (the exact retry-treadmill class the 429 cooldown exists to
  prevent, §5/§9). An *explicit* decline (`confirmed: false`) stays ordinary recoverable
  `refused` — the user answered, so re-asking a rephrased variant is legitimate. The two
  settings stay orthogonal: `writeConfirmTimeout` is how long to hold the dialog,
  `allowUnattendedWrites` is whether to ask at all (headless); never-asked is a typed
  opt-out in settings, never a side effect of a timeout value. The two RPC client shapes
  collapse to the same safety boundary: a full client (implements the UI sub-protocol)
  behaves like an interactive session with a remote confirm UI; a minimal client that
  ignores or dismisses the request yields `confirmed: false`/timeout ⇒ write refused —
  degraded convenience, never a silent widening of the write path. The rejected-write message
  names the enabling setting or the interactive path. Silence never grants unattended
  writes; the opt-out is typed, in settings. (A per-session confirmation toggle was
  considered and cut: `allowUnattendedWrites` already covers the only real opt-out —
  headless — and confirmation off in an interactive session adds convenience, not
  capability; the tuning need `writeConfirmTimeout` now serves is the disruption dial,
  not a capability widening. Revisit if both knobs demonstrably still annoy.)
- **Scope (session state)**: active KB scope persisted via `pi.appendEntry("kb-scope", ...)`,
  read on `session_start`. This uses pi's native session persistence — survives session
  resume/fork, stays out of LLM context.
- **Mid-session activation — the `/kb` command**: scope is not `session_start`-only. A
  `/kb` extension command is the activation vehicle: `/kb <name> on|off` toggles one KB
  and writes a fresh `kb-scope` entry holding the full post-toggle active set (validated
  against the config array, same rejection messages as the tool param).
  - **Toggle grammar (decision record)**: single-name actuation, `/kb <name> on|off` —
    each command validates and applies **one** KB, so there is no multi-name partial-apply
    question to pin: an unknown or invalid name rejects the command and the scope is
    untouched (atomicity is trivial — nothing to partially apply), and no toggle can
    silently narrow the scope (the set-replacement alternative's failure mode:
    `/kb projects recipies` partially applied would silently drop `recipes`). Toggles are
    **idempotent** (`on` on an active KB / `off` on an inactive one succeed as no-ops,
    reported as such — pi-tbox's toolset-actuation semantics). The entry stays a complete
    scope snapshot (resolve current set → apply toggle → write full array), so the
    resume/fork read rule below is unchanged — the command grammar changes, the
    persistence mechanism doesn't.
  - **Set-wide toggle — `/kb all on|off` (decision record)**: the same `on|off` verb with
    the reserved keyword `all` in front — not a second grammar, one more member of the
    reserved keyword set (a KB named `all` is rejected at `session_start`, same pass as
    the `defaultKBs` check; pi-tbox precedent: `toggleAll` in `groups.ts` lives alongside the
    single-toolset toggle). `/kb all on` activates every KB in the **valid** set (the
    post-validation set: a stale or encrypted KB was already dropped at validation with
    its own rejection, so it cannot be activated); `/kb all off` writes an **empty**
    active set (latest-entry-wins still applies — the persisted empty set overrides
    `defaultKBs` on resume, and it doubles as the one-keystroke start-empty form). Zero
    valid KBs is a success no-op reported as such (`0 KBs activated`), matching tbox's
    `Enabled 0 toolsets.` shape. No partial-apply trap exists: `all` resolves against the
    already-validated config, so every name is known-valid by construction. Named
    **subsets** ("activate exactly these 3 of 5") are what `all` genuinely cannot do —
    that case stays deferred to tbox-style named KB groups (§6 ceiling): a group
    expansion is just N validated toggles, all-or-nothing at the validation layer, so
    the upgrade path is untouched by adding `all` now.
  - **Subcommand surface (decision record)**: the first argument is checked against a
    reserved keyword set before KB-name resolution; if it matches, the command is a
    subcommand and consumes no KB-name arguments. Bare `/kb` (no arguments) prints the
    current active scope. `/kb <name>` without an explicit `on|off` verb prints usage —
    no bare-name default to guess at. The reserved set is just `all` (R5 — no slug
    convention survives, so no janitor subcommand exists); a KB named `all` is rejected
    at shape validation (validation order, above).
- **Scope read rule**: active scope = the latest `kb-scope` entry in the session file,
  else `pi-kb.defaultKBs` — latest entry wins, so resume/fork and mid-session switches
  are the same mechanism. The `kb`-param rejection message names the command:
  *`'projects' exists but is not in the active scope — activate it with /kb, or
  change pi-kb.defaultKBs in settings`*.
  - **Headless bound (decision record)**: extension commands are dispatched by core
    `session.prompt()` whenever `expandPromptTemplates` is true (the default), and print
    mode (`pi -p`) and RPC mode's `prompt` command both call it unmodified — so `/kb`
    **does work headless**. That is accepted, not worked around: `/kb` from a headless
    prompt is user-typed intent, the same trust level as editing settings.json, and no
    handler-side headless check is added to block it (it would be logic guarding nothing).
    The boundary the record protects is **no agent-invocable activation tool**: the agent
    itself cannot trigger `/kb` — `sendUserMessage` (the extension/agent path) defaults
    `expandPromptTemplates` to false (`agent-session.ts`), so dispatch only fires on
    directly-typed input. Only user-typed text (slash command, headless prompt text) or
    settings changes scope. `pi-kb.defaultKBs` remains the default when no `/kb` was
    issued; the `kb`-param rejection message names `/kb` and the `defaultKBs` path without
    claiming either is interactive-only. **Residual (named, not worked around)**: headless
    prompt text is only user-typed when the pipeline says so — a `pi -p` prompt that
    interpolates untrusted content (`… $(cat ticket.md)`) can carry `/kb all on`, widening
    the write blast radius of an unattended session in one dispatch. **Headless +
    `allowUnattendedWrites: true` + untrusted content interpolated into the prompt string
    is an unsupported combination** (§9): untrusted data belongs in files the agent reads
    via tools — tool results never dispatch commands.
- **Unreachable kernel (decision record)**: if the session-start probe fails, the session
  still starts — degraded: tools registered, calls return `{status: error, message: SiYuan
  unreachable at <baseUrl>}` until the kernel is reachable again; reads recover per-call
  automatically. Any write attempted while no successful probe exists first retries the
  probe — per write attempt, not per session (a transient kernel outage that outlives the
  session-start probe self-heals once the kernel returns; no probe counter is kept, and a
  session whose startup probe succeeded never enters this path because the verdict is
  cached). Still strictly fail-closed: a successful probe must precede any write, and a
  still-failed retry refuses only that write.
- **Auth-lockout circuit breaker (decision record)**: the kernel rate-locks IPs on the
  **6th consecutive auth failure within a 15-minute window** (fail counts ≤ 5 still pass —
  `util/session.go` `FailCount <= 5`; first lock 60 s, exponential to a 15 min max), and locked-out
  requests themselves increment the counter, extending the lock. The lock is shared with
  the access-auth-code path, so a lockout kills *reads* too, not just writes. The
  client-side never-retry rule (§2) does not cover the real hazard: the agent's own
  tool-call retries — a model retrying a failing tool six times locks the VM out of the
  kernel entirely. So the extension counts consecutive auth failures
  and, at **3**, degrades the session: every call returns `{status: refused}` fail-fast
  naming the token fix, with zero further kernel calls from tool calls until recovery or
  session restart.
  The budget of 3 deliberately sits under the kernel's lock threshold under either
  reading of its boundary. The breaker counts **per session**, while the kernel lock is
  keyed by **client IP** — two concurrent sessions with the same bad token contribute
  3 + 3 = 6 failures and trip the kernel's first 60 s lock. That is self-healing and
  read-degrading, not a design break: the cross-session sum is visible (both sessions
  degrade), the concurrent-sessions risk row (§9) already accepts shared-notebook races,
  and closing it would need a shared-breaker file — machinery a single-user VM topology
  doesn't earn. Recovery re-checks with a still-wrong token add one kernel-side failure
  per typed `/kb`, so the human-paced argument covers them. The threshold numbers
  themselves are source-read (`util/session.go`), and reading code proves existence, not
  runtime behavior — so the throttle contract is pinned by the §10 integration throttle
  case: a misread constant, or an upgrade that moves the threshold, turns the suite red
  instead of silently mis-tuning the breaker (a breaker sitting above a lowered kernel
  threshold would learn about it only from a locked-out VM).
  - **429 with a correct token (decision record)**: a 429 is **never counted toward the
    breaker** — it is not evidence that this session's token is wrong (the acknowledged
    two-session 3+3 case, §9, or any other client on the shared IP can trip the lock),
    so counting it would degrade a healthy session for someone else's mistake, and the
    breaker stays strictly a 401/403 mechanism. It is also **never auto-retried** (§2's
    client rule; a retry during an active lock extends the lock — the exact runaway loop
    the breaker exists to prevent, reachable here with a perfectly correct token). The
    **Structural guard (decision record)**: a message alone re-creates the "agent
    discipline" pattern the design rejects everywhere else — a model that retries the
    refused tool makes a real kernel call each time, and every call during an active lock
    extends it. So after the first 429 the extension holds a **cooldown deadline**
    (`now + Retry-After`, floored at 60 s — the verified first lock; the served header
    understates a lock extended since it was computed, so the deadline is advisory, and
    the worst case is one extra kernel call per window, bounded by design): every kb tool
    call before `cooldownUntil` returns the refusal **locally, with zero kernel
    round-trips**, so a retrying model cannot extend the lock no matter how it behaves.
    The gate lives beside the breaker (same dispatch point, same `{status: refused}`
    envelope, message distinguishing the cause); it needs no expiry polling (any poll
    would itself extend the lock), no cross-restart persistence (the kernel lock survives
    a restart anyway; one wasted call per restart is bounded, not a loop), and no
    per-tool cooldowns. The cooldown gates **tool calls only** — a `/kb` re-check remains
    the user-typed, human-paced act (§5 recovery), with the degraded-state message still
    saying wait out the lock first. The tool returns the distinct 429 envelope naming the
    lockout, its cause (IP-keyed lock, possibly tripped by another client), and its
    self-healing expiry (first kernel lock 60 s — `30 << (6-5)`; quote the kernel's
    `Retry-After` when present — with one
    multiplier fact pinned, S2: any single call during an active lock **extends** the
    lock (locked-out requests themselves increment the counter, exponential backoff:
    FailCount 6 → 7 → 120 s), and the interleaved 429's `Retry-After` header is computed
    *before* that extension — so the served header understates the new lockout, and the
    honest guidance is **wait out the lock with zero calls first, then retry**). The
    refusal message tells the model: your token is probably correct — do **not** change
    the token or settings, and do not retry; all kb calls are refused for the stated
    window; report the lockout to the user and pause kb work until then (the model cannot
    sleep mid-turn, so yielding to the user is the only useful action and saves tokens vs
    spinning on harmless-but-billed local refusals; headless, the expiry note does the
    work — the lock self-heals and the next call simply succeeds); it carries
    `{status: refused}` — the breaker's fail-fast value, since both states mean "no
    kernel calls will pass" — with the message, not the status, distinguishing the
    two causes. No `/kb` recovery
    is involved — the state belongs to the kernel, not the extension, and expires on its
    own; reads and writes both surface the same refusal for the lock's duration, and the
    next call after expiry simply succeeds.
  - **Recovery (decision record)**: every `/kb` dispatch first re-runs the session-start
    validation pass — settings re-read (so a corrected token takes effect mid-session;
    a re-check against the old token would be pointless), shape check, version probe,
    `lsNotebooks` — and updates the cached state (probe verdict, valid-notebook set,
    breaker). On success the degraded flag and the consecutive-failure counter clear —
    any successful authenticated call resets the counter, mirroring the kernel's own
    reset-on-success (`AuthThrottleReset`). The re-check is one uniform hook before
    subcommand dispatch, so every current and future `/kb` subcommand inherits recovery
    with no per-subcommand logic. The subcommand then proceeds under the tool-call
    degrade rules: local reads (bare `/kb`, scope print) and scope toggles (`/kb <name>
    on|off`, `/kb all on|off` — they validate against the already-loaded config and
    write local `kb-scope` state only, no kernel call) proceed with the warning
    attached; kernel-touching subcommands (anything that writes — none in v1, every
    current subcommand is local scope state) fail closed. A failed re-check is all-or-nothing — it re-engages the breaker and stays
    degraded, never a retry loop. Cost is bounded by design: the re-check is human-paced
    (each failed attempt is one more kernel-side auth failure against the 15-minute lock
    window — two LAN round-trips on a typed command, milliseconds), and the agent cannot
    trigger `/kb` (headless bound above), so it can never widen its own retry budget.
    **Reconciliation with the §2 never-retry rule**: that rule governs *automatic* retries
    (client code paths, agent tool-call loops); the `/kb` re-check is a *user-typed,
    human-paced* recovery act — at most one extra kernel-side auth failure per deliberate
    keystroke, never a loop the code or the model can spin. It is the sanctioned exception,
    not a relaxation of the rule.
    **Ordering matters during an active kernel lock**: locked-out requests extend the lock
    (§5 429 record), so repeated `/kb` re-checks make recovery strictly worse — the
    degraded-state message says **wait out the lock first, then `/kb`** (the 429 refusal
    already carries the self-healing expiry note). Session restart remains the alternate
    recovery path.
- **Status bar**: a `kb` status-bar slot (pi-lean-search pattern: `ctx.ui.setStatus` +
  theme-colored glyphs, try/catch-guarded for headless) surfaces active KBs plus
  connectivity/config state: probe ok → `● kb: projects, recipes` (accent, active scope
  names), unreachable/never-probed → red/grey, degraded config → yellow; cleared on
  `session_shutdown`.
- **Fresh-session scope (decision record)**: `appendEntry` state persists across
  resume/fork of the same session file; a brand-new session starts with no scope entries.
  Resolution rule, one line: on `session_start`, active scope =
  persisted `kb-scope` entries if present, else `pi-kb.defaultKBs` from settings. This keeps
  resume behavior unchanged and makes the fresh-session case a *declaration*, not an
  inference — no "if exactly one KB, assume it" cardinality guessing.
  - `pi-kb.defaultKBs: string[]` — KB names matching the config array, validated against it at
    `session_start` (a default naming an unknown/renamed/deleted KB warns loudly at startup
    instead of silently producing an empty or half scope; same validation pass covers the
    stale-notebook-config edge). Empty default = strict start-empty behavior for anyone
    who wants it. The key is optional: an **absent `defaultKBs` resolves to an empty
    active set, identical to `[]`** — there is no implicit activate-all; blast radius is
    always explicitly declared.
  - **Project vs global settings (decision record)**: pi's settings merge is a deep merge
    for plain objects but **replaces arrays wholesale** (project value wins, global array
    gone — `settings-manager.ts` `isMergeableObject` excludes arrays). The config split
    follows that grain instead of fighting it:
    - **`kbs` + connection settings (`baseUrl`, `apiToken`, `allowUnattendedWrites`):
      global-only.** These are deployment facts — notebook IDs live in exactly one place,
      so they can never go stale in two. Projects must not declare them; validation warns
      if a project settings file sets `kbs` or connection keys (the values would
      invisibly override, splitting one deployment's truth across files).
    - **`defaultKBs`: both levels, array-replace is the intended semantics.** A project
      declaring `defaultKBs` states its complete active set — that is precisely the
      composition rule wanted, and pi already implements it. A project wanting the
      global default omits the key (object merge lets the global value through).
    - Workflow fit: project-scoped `defaultKBs` activates the project's KB in its
      checkout; global `defaultKBs` covers the personal cross-project memory KB. A
      project that wants both just lists both names in its `defaultKBs` — names are
      cheap to re-list, unlike notebook IDs.
    Validation note: `defaultKBs` names are validated against the (global) `kbs` array at
    `session_start`, so a project default naming a missing/renamed KB still fails loudly
    at startup rather than producing a half scope.
- **Tool shape**: single tool set with a validated `kb` string param (Flavor B: visible,
  validated at call time, helpful rejection on out-of-scope values). Context surface stays
  flat regardless of KB count. **`read` takes exactly one KB name plus a `docId` (the §4
  doctrine — read consumes echoed docIds; the single ownership query doubles as the
  scoping check) — it fetches one doc, so the array form exists only for the multi-scope
  sweep tools (query/search).**
- **`kb` param contract (decision record)**: `kb` is **required on every tool call**.
  Read tools (`query`/`search`) accept an **array of names** — one call covers multi-KB
  sweeps, and the extension deterministically builds the `box IN (...)` predicate from it
  (query-scoping record, §3). Write-back requires **exactly one** name — a write targets
  one notebook, and the single-name requirement keeps "which KB did this land in"
  unambiguous. Explicit beats implicit for model behavior — no "which default was in effect" debugging,
  and the model can never silently write to the wrong KB. Rejection messages are the
  model's discovery mechanism, so they always list the currently active KBs:
  - Unknown KB (typo) → reject with `unknown KB 'recipies'. Active: recipes, projects`.
  - Valid but not in active scope → reject with the activation path named:
    `'projects' exists but is not in the active scope — activate it with /kb
    or change pi-kb.defaultKBs in settings`.
    Keeps the scope boundary meaningful without making it a trap.
  - **Empty array (decision record)**: `kb: []` on the read tools is rejected at the
    extension layer, before any kernel call, with the same envelope as the other
    rejections: `no KBs in scope — activate one with /kb <name> on, or set
    pi-kb.defaultKBs`. Never forwarded to the kernel on either transport: on query,
    the resolved set would build `box IN ()` (a SQLite syntax error) — or, worse, an
    implementer's "empty filter = no filter" shortcut would skip injection entirely,
    letting box-less aggregate rows (backstop-exempt, since layer 1 is supposed to
    guarantee scoping) compute over the whole workspace; on search, `paths: []`
    degrades silently to whole-workspace results (the kernel's `IsValidSearchBoxPath`
    discards invalid entries without error). Empty scope is a legitimate state (`/kb
    all off`, `defaultKBs: []`), so an agent echoing its current scope into `kb: []`
    is a plausible call — it must mean "nothing is in scope", never "search
    everything".
  - Success → tool results **echo the resolved KB**, so every call (especially writes) is
    auditable in-session.
  - The query tool description documents the kernel's `refs` table schema (id, def_block_id,
    def_block_root_id, block_id, root_id, box, … — database.go) so ad-hoc agent backlink queries
    don't require guessing column names; the delete flow's automated backlink check (§4) uses the
    same table. The description also pins the kernel's `blocks` table schema (`id`,
    `parent_id`, `root_id`, `hpath`, `box`, `type`, `content`, `updated`, `sort`, … —
    database.go) with the two semantics notes agents demonstrably misread: **`sort` is a
    block-type weight, not display order** (§3 — `ORDER BY sort` does not yield document
    order; heading order comes from the outline or the `parentID`/`previousID` anchors),
    and **`hpath` is a derived display label** stamped on every row (R1 — never an
    address). The discovery doctrine's ad-hoc SELECTs run against this table, so it gets
    the same no-guessing treatment as `refs`. Virtual mentions (text matches in `blocks_fts`) are intentionally out of reach —
    they are not identity refs and are irrelevant to delete safety. It also pins the
    **include-`hpath` discovery pattern**: `hpath`, `root_id`, and `updated` are columns
    on every
    block row (`batchUpdateHPath` stamps the doc-level path on all rows;
    `updated` is the kernel's `yyyymmddhhmmss` per-block timestamp — sorts lexically, so
    no parsing machinery ever exists), so a SELECT
    that includes them returns each block's doc address and its recency for free —
    `read { kb, docId:
    root_id }` consumes the echoed id directly with zero intermediate calls. Only ids
    from sources that predate the pattern (older spill files, hand-off context) pay the
    one ownership query (§3 read), which is the scoping check itself.
- **Why not `pi-tool-masking` for scope state**: its state namespace is tool *allowlists*
  owned by tbox (`toolset-state:<id>` persistKeys). KB scope would be foreign data in
  someone else's namespace. Reuse pi's persistence primitive, not the masking semantics.

---

## 6. Named ceilings (deliberate simplifications)

| Ceiling | What it means | Upgrade path |
| --- | --- | --- |
| Soft scope only | The api token is a workspace-admin credential (the only kind SiYuan issues); KB isolation is tool-level filtering to keep other KBs out of context, not a security boundary against a hostile actor. Anything holding the token — agent or otherwise — can touch the whole workspace. | Separate SiYuan instances, if hard isolation is ever genuinely needed. (No per-KB or read-only tokens exist in SiYuan's auth model.) |
| Agent-trust on writes | Write tools touch real notebooks. | Interactive write confirmation (v1) + KB-notebook blast radius; tighter permissioning later if trust proves unwarranted. |
| Lean loop, no RAG (v1) | Recall depends on the model re-querying via SQL/search, not embeddings. RAG is planned v2 work, sequenced after the lean loop ships — not a contingency awaiting a shortfall measurement. | Add a RAG layer as an external sidecar fed by `exportMdContent`/`query/sql`, never a second writer (GBrain precedent: its vectors/graph live in its own Postgres sidecar, not the storage format). v1's embedding-free construction is what makes the sidecar a clean add. |
| No bulk transactions | No documented bulk-transaction endpoint; large imports and deep restructures are sequential API calls. (Undocumented `batchAppendBlock`/`batchInsertBlock`/`batchUpdateBlock` routes exist in the kernel — headroom, not a dependency: documented-endpoints-only stands; upstream a docs PR, then adopt.) | Host-side offline import script + index rebuild (sanctioned in SY-FORMAT.md §0.5), if a bulk-ingest workload ever appears. |
| Intra-KB moves only | `move` resolves its destination within the call's single `kb`; cross-KB reorganization has no tool mode. | Hand-move the doc in SiYuan's UI — identity is the docId, so the doc stays reachable from any query row and every follow-up write by echoed docId works; a `toKB` param if a real migration need appears. |
| Single-KB toggles + one set-wide form | Scope activation is `/kb <name> on\|off` per KB, plus `/kb all on\|off` for set-wide actuation. Named subsets ("these 3 of 5") have no form. | Named KB groups in config (tbox precedent) if subset switching is ever genuinely needed — a group expands to N validated toggles, all-or-nothing at the validation layer. |
| Title-guard-only dedup (tier 2) | Create-path dedup is the write-only title guard (§4 R3/R4): one exact query + one space/hyphen/underscore prefix scan over stored titles. Paraphrases and non-ASCII case variants land as accepted, reconcilable duplicate docs — identity was never solvable syntactically at zero dependencies (R4). | Embedding-assisted dedup in an extension-owned sidecar (v2) — **promoted to the eventual primary mechanism for topic identity** (R4): vectors are derived data, rebuildable from SiYuan content; the embedding model's id is stored per-vector so model swaps are re-embeds, not migrations (no dimension columns in durable storage — the GBrain failure mode). The title guard is retained as the zero-dep fallback when no provider is configured/available (`near_matches` → `degraded_dedup`), not removed. |
| Assets out of scope | `exportMdContent` can emit asset references (`assets/…`) the VM-side agent can neither fetch (host network paths) nor write back; v1 treats KB content as text-first. | Host-side asset fetch + re-embed, if image-bearing source docs ever need distilling — extension code stays asset-blind. |

---

## 7. Access invariant

**All reads and writes go through the kernel API. Never write `.sy` files directly.**

This is structural, not merely prudent: the pi agent runs in a jailed Firecracker microVM;
SiYuan runs on the host. Host files (including `.sy`) are invisible to the VM — the HTTP API
is the only access path that exists. It also sidesteps SiYuan's torn-write warning about
external writers on a live workspace entirely: the kernel serializes its own writes.

---

## 8. Deployment topology

- pi agent: Firecracker microVM.
- SiYuan: host, via docker-compose — image tag pinned (no `:latest` — an upgrade must be a deliberate act that triggers the §10 upgrade checklist; this pin is also what makes the §2 version gate's strictness free — an upgrade can never arrive as a background point release); port 6806 published on the host's VM-facing
  interface only (`192.168.100.1:6806`, *not* `0.0.0.0`), non-empty access auth code set
  (this is what makes `IsAccessAuthRequired()` true and keeps the anonymous-admin bypass
  path in `CheckAuth` dead), API token copied from the workspace `conf.json` into the
  extension's settings.json (`pi-kb.apiToken`) — settings.json is the **only** config surface
  the extension reads (§5); there is no env-var fallback. A user who prefers env indirection
  just puts the value (or a `$VAR` reference, if their settings pipeline expands it) into
  settings.json themselves; the access auth code never leaves the host. **Token placement
  is a token-disclosure decision**: settings.json lives where the agent's own tools (file
  read, shell) can read it, so an agent that goes looking can lift `pi-kb.apiToken` and
  call the kernel directly — bypassing parser certification, `method` enforcement,
  scoping, and write confirmation at once. Accepted (the threat model is model accident,
  not a hostile agent — §6), but stated plainly: every §3/§4 guard is tool-surface-only.
  If guards ever need to mean more, the fix is deployment-side (token outside the agent's
  readable paths, or a proxy layer) — never more extension code.
- VM → host: gateway/LAN IP. Kernel URL is config, never hardcoded.
- Host firewall (firewalld rich rule for the VM's tap subnet) is the network security
  boundary: it is what scopes kernel access to the VM, since the API token is a
  workspace-admin credential (see §6).

## 9. Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| VM→host connectivity fails | ~~Unknown~~ **Resolved** — smoke test passed (Milestone 0) | Was compose/firewall fix; not an architecture problem. |
| Unauthenticated workspace access (deployment drift) | ~~Unknown~~ **Resolved** — auth posture verified (Milestone 0) | Non-empty access auth code keeps the anonymous-admin bypass dead; API-token matrix (no-token → rejected, bogus → rejected, real token → `code:0` on guarded + SQL endpoints) passed from the VM. `/api/system/version` has no auth middleware and proves connectivity only — guarded endpoints must be probed when re-verifying. |
| Auth lockout from agent retry loops | Medium (model tool-retry loops are common) | Extension circuit breaker: 3 consecutive auth failures → degraded fail-fast (§5), under the kernel's lock threshold (6th consecutive failure within a 15-min window); the client never retries 401/403/429 (§2). A 429 with a correct token (lock tripped by a concurrent session or client) is surfaced as the self-healing 429 refusal — never counted toward the breaker, never retried (§5) — and arms a cooldown deadline (now + `Retry-After`, floor 60 s): further kb tool calls are refused locally with zero kernel round-trips, so a retrying model cannot extend the lock (§5). The source-read throttle contract (threshold, window, backoff, `Retry-After`, lock-extension, self-heal) is pinned by the §10 integration throttle case (§5 has the full record). Multi-KB search fan-out (§3) multiplies per-call round-trips by the active-KB count (normally 1–2); an armed cooldown refuses locally before any fan-out call is issued, so it adds no lock-extension surface. |
| SiYuan kernel API drift | Low (community-stable for years) | Eager version probe at `session_start` (§2) against the pinned tested version; core is thin so surface area is small. The probe refuses writes on **any** drift from the pinned full version — the strict-gate rationale is the §2 decision record; enforcement is the §10 upgrade checklist (run the suite against the new kernel first, then re-pin — a verified conclusion, never a version-number bump). |
| Model writes garbage into notebooks | Medium | Interactive write confirmation; KB notebooks bound blast radius; user backup strategy outside extension scope. |
| Headless prompt injection widens scope | Low (corner-case config) | `/kb` dispatches on headless prompt text (§5 headless bound), so untrusted content interpolated into a `pi -p` prompt can carry `/kb all on` and widen an unattended session's write blast radius. **Unsupported combination (§5): headless + `allowUnattendedWrites: true` + untrusted content in the prompt string** — keep untrusted input in files the agent reads via tools; tool results never dispatch commands. Bounded regardless: activation is config-validated, soft-scope ceiling applies (§6). |
| Scope confusion (soft isolation) | Low (accepted) | Named ceiling; hard isolation out of scope for v1. |
| Git-on-host vs live workspace (user's personal backup) | User-owned | Extension is agnostic: it writes via kernel API regardless of what backs the workspace. Torn-write risk belongs to the backup strategy, not this design. Kernel API writes land on disk as `.sy` either way — git backs the workspace identically; direct file writes buy git nothing. |
| UI rename / hand edits to KB docs | Medium (normal usage) | Safe by construction (§4 R5): identity is the docId, block IDs survive renames, and the doc stays reachable from any query row — every read/write by echoed docId works regardless of retitles. Worst case: a retitled doc no longer matches an agent's remembered mint title, so the next create by that title misses the guard — one reconcilable duplicate, never data loss (the accepted two-docs-reconcilable path). Write confirmation and result-echo keep it visible. No rename-detection machinery exists or is needed; no slug janitor exists (R5 — nothing to repair without a slug convention). |
| Concurrent pi sessions on one KB | Normal usage, not degenerate | Two sessions can both pass the title guard before either create lands in the SQL index → duplicate topics; interleaved appends are last-writer-wins. Same "two docs, reconcilable later" blast radius as guard misses — never data loss. Verified-create is a by-ID mint assert (§4 R3), not a uniqueness check, so the race surfaces as a reconcilable duplicate, not an immediate error. A racing session's deletions also make stale targets reachable; the §4 stale-target record covers them — never a silent success against a vanished block. No cross-session locking in v1. |
| SQL-index lag after write breaks find-then-write | Low | If the index lags, the title guard misses → create path → duplicate doc. Verified-create is now a **by-ID assert that proves mint success** (§4 R3), not a uniqueness check — it cannot make the guard→create race visible; that race's duplicate is the accepted reconcilable class (§6, §4 R4). The same lag applies to the advisory backlink checks — the pre-write confirmations and the `invalidRefs` echo (§4) — which is why they are evidence, not proof, and never a safety gate. The design's defense stays fail-loud where the kernel is silent and reconcilable-never-lossy elsewhere. §10's read-consistency test pins the sync-flush contract for `blocks` and `refs` alike. |
| Encrypted KB notebook | Low (opt-in feature, rejected loudly at startup) | `/api/query/sql` sees only the global `siyuan.db`; an encrypted notebook's blocks are invisible to the title guard, to verified-create's by-ID asserts, and to the backlink check — the §4 flow would misfire (guard misses minting duplicates; verified-create then fails loud on a mint the SQL surface cannot see). §5 validation step 3 rejects any configured KB with `encrypted: true` at `session_start`, naming the KB, so the flow never runs against a notebook it cannot see. A *locked* encrypted notebook is skipped by `lsNotebooks` entirely and is dropped as a stale notebook ID instead — both messages fail safe (§5). |
| Dual writer on the workspace | Low (user-controlled) | §7's serialization argument covers the kernel's own writes only; if the same workspace is also opened in a desktop SiYuan instance while the kernel runs, torn writes are back. Mitigation is deployment hygiene: one kernel per workspace; worth a note in the compose docs. |
| Spill files accumulate in /tmp | Low (cosmetic) | No cleanup machinery (§3): hash-named files in per-session temp dirs, disk-bounded by spill frequency, wiped by the OS on reboot; crash or quit-then-resume leaves files the resumed transcript may quote — the agent re-queries and re-spills (same hash). A cleanup pass is a v2 add-on if /tmp usage ever matters. |

## 10. Testing posture

- **Stack**: TypeScript + vitest (pi-tbox precedent); `node-sql-parser@5.4.0` (SQLite
  dialect, exact-pinned — §3 query scoping) in `pi-kb` is the one runtime dependency —
  `siyuan-core` stays zero-dep.
- **Unit**: `siyuan-core` client tested with mocked `fetch` — request shapes, auth header,
  error mapping, version check.
- **Unit (extension layer)**: the risky logic lives in the extension, not the client, so the
  extension gets its own suite with a mocked `siyuan-core`, covering:
  - title guard (§4 R3) — the exact leg (ASCII-cased variant matches transparently;
    HTML-special titles match via escape parity — pattern built from the HTML-escaped
    title, with `%`/`_` LIKE-escaped so they can't widen the scan), the space/hyphen/underscore
    prefix-variant scan (`docker-networking` vs `docker\_networking` matches the third leg),
    the 20-row candidate cap and its `truncated` marker, and the
    `confirmNew` skip path (guard fires without it; with it, create proceeds past
    **both** legs — including an exact-title match — and the param is absent from the
    tool's declared input schema, §4 decision record); mint-policy
    rejections — empty after trim, `/` in title, >512 runes, and tab/newline/control
    characters (each with the rephrase-hint message);
  - verified-create by-ID asserts (§4 R3) — top-level identity assert; nested assert
    shape (parent still exists with the used hpath, child `hpath` derived from the
    read-back child row's stored title — ground truth, never the submitted title); a
    simulated stale parent (deleted between hpath read-back and create) fails loud with
    the structured error, never a silent ghost nesting;
  - parser certification — single top-level SELECT enforcement / DML rejection;
    multi-statement rejection (pinned to the executed spike: `astify` returns an array
    rather than throwing, so the cert checks `Array.isArray`); FROM-allowlist violation
    incl. comma cross-join (`FROM blocks, refs`); CTE rejection (`WITH blocks AS
    (SELECT 1 AS box) SELECT * FROM blocks` — the kernel's readonly layer permits WITH,
    so layer 1 is the only line of defense; the pin asserts rejection, never allowlist
    filtering of CTE refs); subquery rejection; UNION rejection (pinned to the spike:
    UNION parses as `type: 'select'` with the second arm in `_next`/`set_op`, so
    rejection keys on those fields, not the type string); JOIN rejection
    (single-table-FROM policy);
  - injected-predicate re-parse — OR precedence verified via the re-parse, plus
    round-trip parity pins for escaped quotes, `LIKE` backslash escapes, clause
    keywords inside strings, and non-ASCII literals (spike finding: no AST locations
    exist on any dialect, so the original coords-into-source-text splice plan was
    replaced by AST rebuild + serializer round-trip);
  - LIMIT presence read off the AST; an `||`-containing statement (vitess rejects `||`,
    so the kernel falls to the `queryRawStmt` text-scan path, `sql/block_query.go` —
    the extension's injected LIMIT must still be present in the executed statement);
    agent-supplied LIMIT passes through verbatim — a statement with `LIMIT 100000`
    executes with that limit, never clamped or rejected (the §3 passthrough decision
    record);
  - post-filter rules — box-less aggregate rows skip the backstop; the truncation
    marker fires when `kept + dropped` reaches the limit;
  - `kb`-param rejection messages, incl. the empty-array rejection (no kernel call
    fires, `status: error` names the activation path);
  - search rejecting agent-supplied `method` and always sending `method: 0`, plus the
    same ownership rule for the aux params `types`/`orderBy`/`groupBy` (§3);
  - scope resolution (`persisted → defaultKBs`, reason-agnostic, incl. the absent-key →
    empty-set branch);
  - `/kb` toggle writes — bare `/kb`, verbless `/kb <name>` usage output, idempotent
    re-toggle, `/kb all off` empty-scope write, zero-valid-KB no-op report, the
    reserved-keyword rejection for a KB named `all`, and the name-grammar rejection for
    a KB whose name contains whitespace or `/` (the §5 shape-validation constraint);
  - spill inline-cut/preview/per-session-dir (no-cleanup posture) plus the outline cap
    (an over-`OUTLINE_HEADINGS` outline inlines the first N lines + spill pointer, and
    the §4 verification and anchor logic run on the full unfiltered walk set regardless);
  - replace-section call-order pin (insert-before-delete — the mocked suite asserts the
    deleteBlock follows the successful insert, so a failed delete leaves visible
    duplication, never loss; the live-kernel integration case covers the rest);
  - stale-target verification (§4 stale-target record) — an insert whose `newBlockId`
    is absent from the post-write block tree (the unfiltered `getChildBlocks` walk set,
    §3 — not the heading-only outline) → `status: error` naming the vanished target,
    never success; an edit target's kernel error surfaces verbatim with the fresh
    outline; a delete no-op reports success with the unfiltered walk-ID set as evidence;
    a cross-doc move whose `movedBlockId` is absent from the destination post-move walk
    set (or still present in the source's) → `status: error`, never a silent no-move
    success;
  - auth circuit breaker — 3 consecutive auth failures → degraded, zero further kernel
    calls from tool calls; recovery (a corrected token in settings plus a `/kb` dispatch
    re-runs the full validation pass, clears the degraded flag and counter, and calls
    proceed; a failed re-check re-engages degradation all-or-nothing instead of
    looping, §5);
  - 429 handling — a 429 with a correct token does not increment the breaker and does
    not retry; the result names the lockout and its self-healing expiry, a call inside
    the cooldown window returns the local refusal with no kernel round-trip (zero
    requests on the test-harness request log), and a post-expiry call succeeds without
    any recovery step (§5);
  - settings validation order (shape → probe → notebooks, incl. the
    project-declares-`kbs` warning branch and the token-failure branch);
  - error-envelope shape;
  - write-confirmation branches — allow/refuse; a cancelled confirm and a timed-out
    confirm both resolve to refusal (the §5 fail-closed direction; the confirm call
    carries the timeout so an unresponsive RPC client cannot deadlock the turn); a
    timed-out confirm carries reason `confirm_timeout`, a re-request of the same write
    after it returns the terminal refusal immediately with no new confirm call (the
    mocked suite asserts the confirm mock fires exactly once across both calls — the
    AFK retry-treadmill pin), and an explicit `confirmed: false` decline stays
    recoverable `refused`; `writeConfirmTimeout: 0` issues the confirm with no timeout
    (blocks until answered); a `replace-section` confirmation on a final section displays the enumerated delete
    set's block count plus the inbound-ref count and referring doc hpaths over the
    walk-enumerated delete set (the §4 visibility fixes for trailing content the
    heading-only outline can't show and for refs into section content), and the
    delete-bearing results carry `invalidRefs` (§4 write-result contract);
  - status-slot rendering (glyph per probe state, headless-safe);
  - version-gated write refusal (probe failure must fail closed for writes; also covers
    a version mismatch from the pinned full version — the refusal path additionally has
    an honest integration form, below);
  - the per-write-attempt first-write probe retry;
  - file-path write input (§4 decision record) — a missing/unreadable `markdownFile` →
    structured `error` naming the path with **no kernel call fired** (asserted on a
    request log); `markdown` and `markdownFile` both present (or neither, on a
    content-bearing mode) → shape-validation `error`; and the read-once capture: the
    mocked flow mutates the file after the guard/confirm step and asserts the kernel
    call and write confirmation operate on the string captured at call start;
  - guard-stop draft staging (§4) — a `duplicate`/`near_matches` stop on an inline-body
    create returns `stagedPath` under the session spill dir, the staged file's content
    byte-equals the submitted markdown, the message names the `markdownFile` retry path;
    a `markdownFile`-sourced create returns no `stagedPath` (nothing re-staged); a
    non-guard stop (successful mint) leaves no draft file.
- **Integration (opt-in)**: profile against the real host SiYuan (reachable from the dev VM);
  skipped by default so CI never needs SiYuan. **Setup asserts the running kernel version exactly equals the pinned version** — an accidental upgrade produces a red suite instead of silently unverified drift; the upgrade checklist is the deliberate path. **Upgrade checklist (the enforcement procedure the §2 strict write gate backs — the gate fires, this checklist is how the re-pin gets earned; a guard no process runs is not a guard)**: on every
  SiYuan upgrade, run the full integration profile against the new kernel *before*
  updating the pinned version in this repo; a red suite means a behavior pin broke and
  the affected decision records in this doc need re-verification — the re-pin is a
  verified conclusion, never a version-number bump. The same procedure gates the parser
  dependency: on any `node-sql-parser` version bump, re-run the full parser certification
  matrix (unit) — the CTE-shadow rejection case included, since layer 1 is the *sole*
  guard against a shadowed allowlisted table (`stmt_validate.go:165` permits WITH
  kernel-side, so a parser regression here fails silently as mis-scoped rows) — plus the
  spike's round-trip assertions (§3) against the new version, *before* updating the pin.
  A parser bump is earned the same way as a kernel re-pin: verified conclusion, never a
  version-number bump. **Fixture policy**: setup creates **two**
  disposable notebooks, `pi-kb-test-fixture-a-<timestamp>` and `pi-kb-test-fixture-b-<timestamp>`,
  via the documented `createNotebook` endpoint and teardown removes them via `removeNotebook` —
  every write-path case (and every read case that filters by box) operates only inside the
  fixtures, so a failed run leaves at worst two stray fixture notebooks (recoverable via
  SiYuan's history, where `removeNotebook` copies it before deleting) instead of degrading the
  live workspace. Two notebooks, not one: the multi-KB pins (multi-element `box IN (...)`,
  two-KB search sweeps, the OR-precedence aggregate) need a deterministic two-KB workspace —
  not fixture + live notebooks, whose expectations would depend on live data and flake. The raw-DELETE case below deletes only
  fixture-created rows. Fixture lifecycle is test setup code calling the kernel API directly —
  notebook management stays out of `siyuan-core` and the tool surface. The write path gets
  dedicated cases here — it is the highest-stakes code in the project:
  - title-guard kernel round-trip (§4 R3 — the guard rides `blocks.content`, whose exact
    behavior no unit transcription can prove, so this is the mandatory live pin): create
    docs through the real kernel with adversarial titles — a tab-bearing title must be
    **rejected at mint** with the rephrase hint (never forwarded), while HTML-special
    titles (`A & B`, an apostrophe-bearing title) mint normally and the guard's exact
    leg — built from the HTML-escaped title — re-finds each one (the live escape-parity
    pin: if kernel IAL storage ever changes, this goes red instead of the guard going
    silently blind); clean titles (leading/trailing space → trimmed, Unicode, the
    512-rune boundary) store verbatim **and** yield the expected child hpath — the live
    pin for the §4 superset claim (any mint-policy-surviving title must transform to
    itself); a user-retitled doc (kernel
    `renameDoc` mid-test) still re-finds by its new stored title and misses the old one
    (one guard miss → accepted-duplicate path, asserting no data loss);
  - nested-mint case (§4 R3): create under an echoed `parentId` → the echo shows the
    real `/parent/child` hpath → `read` by the echoed docId works → re-create with the
    same title under the same parent hits the guard; the verified-create nested assert
    compares the child's hpath against the read-back child row's stored title (ground
    truth), not the submitted title (§4); the stale-parent race (parent
    deleted between read-back and create) asserts fail-loud instead of nesting under a
    ghost (drop the ghost subtree in teardown);
  - duplicate-disambiguation case (§4 R1 — `duplicate` must have its exit): two
    same-titled docs in one fixture (UI-created) → create with that title → `duplicate`
    rows carrying the budgeted heading outline (not just excerpts — §4 flow step 1)
    → re-create with `confirmNew: true` → a third same-titled doc mints (the
    conscious-duplicate path, §4 decision record) → `delete {docId, doc: true}` on two
    → re-create without the flag hits the guard's exact leg and one doc remains;
  - verified-create, split into two cases (the kernel mints a duplicate on
    create-on-existing-path, §4, so one test cannot assert both layers):
    *kernel-contract pin* — a raw second `createDocWithMd` on an existing path →
    re-lookup returns **exactly two** doc rows and the content landed in the *new* doc
    (catches any SiYuan upgrade that changes the duplicate-minting behavior);
    *tool-path test* — the extension's create flow against a pre-existing title → the
    guard's exact leg matches first (no create call fires, the existing doc's docId is
    returned), and the guard→create race is only reachable in the mocked suite — its
    duplicate lands in the accepted reconcilable class (§4 R3/R4, §9);
  - `insertBlock` with `nextID=<next heading>` lands where the outline says — including a
    section ending in a list/quote (the AST-sibling nesting trap, §4) and the
    final-section `appendBlock`-on-root case;
  - `replace-section` end to end (§4 — the highest-stakes composite write; the
    enumerate→insert→delete machinery and the same-or-shallower boundary rule have no
    other executable pin): replace a section whose body ends in a list/quote, then assert
    the old body is gone, the new body sits directly under the heading, deeper headings
    under the target went with the section (the boundary rule), the heading ID survives
    (a block ref into the heading still resolves; `listInvalidBlockRefs` returns zero),
    and the result carries `outline`/`anchor`/`newBlockId` (§4 write-result contract). A
    second variant runs the same replacement against a doc with trailing non-heading
    content after the final heading and asserts the trailing block is deleted with the
    section (the §4 final-section boundary pin), the new body lands at doc end, and the
    heading ID survives. A third variant plants a block ref from another fixture doc
    into a *content block inside the section* (not the heading — the same citation
    surface `edit`'s `blockId` is sourced from): the confirmation surfaced the
    inbound-ref count and referring doc hpath before the replace, and afterward the
    ref reports invalid via `listInvalidBlockRefs` with the result's `invalidRefs`
    echo carrying it (the §4 delete-bearing-write contract; the heading-survives
    assert above covers the resolving half). The
    insert-before-delete ordering cannot be forced against a live kernel honestly, so it
    is pinned in the mocked unit suite as call order — a failed `deleteBlock` after a
    successful insert leaves visible duplication, never loss;
  - `updateBlock` preserves block IDs — assert zero invalid refs via
    `/api/search/listInvalidBlockRefs` after an edit (route name per kernel/api/router.go; the route
    is undocumented in API.md, so the test calls the kernel directly, not through `siyuan-core` —
    the §2 documented-endpoints rule is a client rule, not a test constraint);
  - `deleteBlock` orphan behavior on a referenced block;
  - stale-target contract pin (§4 — the four block-write ops disagree on missing IDs,
    and the insert path fails silently behind an HTTP success, so this cannot live in
    mocks alone): delete a fixture block directly via the kernel (simulating another
    session's write or a UI hand-edit), then (a) `edit` against it → the kernel's
    synchronous not-found error surfaces as a failed result naming the block;
    (b) `append` anchored to it → the tool's `newBlockId`-in-block-tree assertion (the
    unfiltered `getChildBlocks` walk set, §3) turns the kernel's silent rollback into
    `{status: error}` with the fresh outline attached, and no block was inserted; (c) `delete` against it → success with the unfiltered walk-ID set showing
    the target already absent (the kernel's success no-op, benign end state); (d) `move`
    whose source block was deleted → the handler's synchronous `-1`
    (`block not found`, `api/block_op.go:474` — blocktree-index check) surfaces as a
    failed result; (e) `move` whose destination anchor is deleted between outline-fetch
    and move (a tree-level miss, not an index miss) → the kernel rolls back silently
    behind `code: 0`, and the tool's `movedBlockId`-in-destination assertion turns it
    into `{status: error}` with both outlines attached, and no block moved.
    (Mechanism for (e) is open: kernel deletes keep both indexes in sync, so no honest
    live-kernel route to a stale tree-level state is known — if none exists at build
    time, pin the tree-level-miss branch in the mocked suite and let this case cover
    only the synchronous classes (a)/(d).) A SiYuan
    upgrade that makes the insert path report its rollback synchronously, changes the
    `doDelete` no-op, or moves `moveBlock`'s index checks behind the transaction layer,
    turns this case red;
  - `removeDocByID` (`delete doc: true`, §4): delete a fixture doc that carries an inbound
    block ref from another fixture doc — assert the confirmation surfaced the backlink
    count, the doc is gone from the box's `type='d'` root rows (zero rows to the guard's
    content scan and to a by-id re-read), and the
    referring doc's ref now reports invalid via `listInvalidBlockRefs` (§4's documented
    orphan outcome, pinned rather than assumed);
  - doc-level `move` (`doc: true`, §4): create a second top-level topic in fixture-a,
    `move` blocks from the source doc into it, then `move doc: true` to nest it under the
    source topic — assert block IDs survived (a block ref into a moved block still
    resolves; `listInvalidBlockRefs` returns zero), the result echoes the stored title
    and the real `/parent/child` hpath (display only), and **a follow-up write by the
    echoed docId works after the move** — the docId-targeting assertion (§4 R1),
    and `destOutline` is
    absent. Pin the tool-side self-descendant rejection (§4 — the kernel would silently
    no-op it), that the kernel's depth-cap error surfaces verbatim, and that a re-issue
    targeting the doc's own parent is the kernel's success no-op (§4 pins it — assert
    zero blocks moved);
  - cross-doc `move` (§4 — intra-KB only, §6, so both docs live in fixture-a): move a
    block from one doc in fixture-a into another doc in fixture-a via
    the tool's `move` mode and assert the pinned cross-doc result contract — `movedBlockId`
    equals the source block's pre-move ID (`moveBlock` preserves identity; asserting
    equality catches any kernel upgrade that starts minting IDs, which would silently
    sever the source doc's inbound refs), `destOutline` reflects the moved subtree in the
    destination (freshness pin — fetched after the move lands), and the source `outline`
    no longer lists it. Provenance survives: a block ref created into the moved block
    before the move still resolves afterward (`listInvalidBlockRefs` returns zero, same
    documented-route exception as the `updateBlock` case above);
  - write-after-create read consistency (the block handlers flush synchronously, but §4's
    find-then-write flow depends on that contract, so a test pins it) — extended to the
    §4 write-result contract: the `outline` field riding a write result must match a
    fresh post-write query of the doc (heading IDs and order), pinning outline
    freshness as the tool's contract rather than agent discipline; extended again to
    `refs` freshness: the §4 backlink checks (the `delete` confirmation, the
    `replace-section` confirmation, and the post-write `invalidRefs` echo all read
    the derived `refs` index) could undercount inbound refs under index lag (advisory
    signal, not a safety gate — the agent still decides) — the same test creates a block ref, immediately
    runs the §4 backlink query (`SELECT DISTINCT root_id FROM refs WHERE
    def_block_id = ?`), and asserts the inbound ref is visible, pinning `refs` onto the
    same sync-flush contract as `blocks`;
  - search scoping: correctly-scoped path (`paths`-derived narrowing, §3) plus a **shape
    assertion** for the backstop — a scoped call's results contain zero out-of-scope boxes
    and set no `post_filtered` flag. With layer-1 injection and `paths` scoping both correct,
    the drop path is unreachable against a real kernel, so integration can only pin the
    shape; the drop behavior itself (contaminated input → filtered, `post_filtered: true`,
    truncation marker counting post-filter rows) is exercised in the mocked unit suite,
    where out-of-scope rows can be supplied; plus a **recall-loop echo assertion** (the
    §3 echo contract): a two-fixture search hit's row carries `root_id`, `box`, the
    per-row resolved KB name, and a non-empty `updated` matching `\d{14}` — the
    source-read pins say the FTS projections select `updated` verbatim and
    `fromSQLBlock` copies it through (`model/search.go:2479`, `:3094`), but the row JSON,
    not the Go struct, is the contract the extension consumes, so the claim is pinned
    against the live kernel like every other shape claim — and `read { kb, docId: root_id }`
    on that hit succeeds —
    the `search → read` loop the recall harness rides is mechanically valid, not assumed;
  - **two-KB search saturation pin** (§3 per-KB fan-out): with both fixtures active, plant a
    shared query term densely in fixture A (past the shared limit) and once in fixture B →
    assert B's hit arrives with no `post_filtered` flag. Under a single-call union search
    this fails silently — one `pageSize` fills with A's rows, B's row is dropped pre-filter
    where neither the backstop nor the truncation marker can see it — so the case proves the
    fan-out, not the shape (pinned separately above); a second assertion densifies past the
    limit in *both* fixtures → the aggregate `truncated` marker names both KBs (per-call
    accounting, merged envelope, §3). Runs on the deterministic two-KB workspace the fixture
    policy already supplies;
  - `exportMdContent` block-ID absence pinned: grep the exported markdown for `{: id=` and
    assert zero matches — the §3 inline-outline mechanism is built on this claim, and the
    renderer lives in the `88250/lute` dependency (not in local checkouts), so the
    contract must be pinned by test, not by reading source;
  - outline ordering pin: the §3 outline source (`getChildBlocks`) returns headings in
    document order for a doc whose sections end in lists/quotes
    (the same shape that traps the §4 anchor rule), and again after a `replace-section`
    round-trip — the load-bearing case, where the superseded SQL outline (rowid-order
    drift; see the §3 decision record) provably broke (freshness pin); plus an
    anchor-echo pin — an `append` on a trailing-content-after-last-heading doc reports
    `anchor: appendBlock(root)` (the
    §4 visibility mechanism for the doc-end fallback), and an insert-bearing write
    result's `newBlockId` resolves via `query` to the inserted content — extended with
    the **multi-block pin (§4)**: an `append` whose markdown parses to several blocks (a
    paragraph followed by a list) yields a walk-set diff containing every newly-minted
    block ID with the kernel-returned `newBlockId` among them, and a single-block body
    yields a diff of exactly one ID — pinning both the diff-based verification and the
    kernel's representative-ID choice against the real kernel (the return shape was not
    source-read, so this test owns the claim);
  - guard-stop staging round-trip pin (§4): a large-body create stopped by the guard
    (`near_matches` against a fixture doc), then retried with `markdownFile:
    <stagedPath>` + `confirmNew: true`, mints successfully — and the doc's content read
    back via `exportMdContent` matches the staged file's content (normalization aside,
    the kernel-round-trip form of the unit suite's byte-equality pin); the staged file
    lives in the session spill dir and needs no cleanup (§3 posture);
  - same-doc `move` result pin: a `move` whose `toDocId` names the source doc collapses to
    the standard shape — `outline` + `anchor`, no `destOutline`, `movedBlockId` present
    (the §4 result-shape rule keyed on whether the two docs differ);
  - version-refusal contract pin (§2/§5 — the write path's most load-bearing safety
    property, exercised against the real kernel): the mismatch is a relation between the
    kernel's reported version and the extension's pinned expectation, and the test owns
    the pin — run the suite with the pin deliberately set to a version the real 3.8.2
    kernel does not report (the same deliberate-misconfiguration move as the bogus-token
    cases: you don't make the kernel lie about auth to test rejection, you supply a wrong
    credential; here you supply a wrong expectation) → assert every write call returns
    the version-refusal envelope naming both versions and reads still proceed (the
    permissive-reads half of the §2 mismatch behavior). Refused writes touch no kernel
    state, so the case is fixture-neutral; the pin override is per-test config, not a
    global constant mutation. (Supersedes the doc's earlier claim that the refusal path
    "has no honest integration form" — that reasoning assumed the only way to create a
    mismatch is to alter the kernel's report, but the test controls the other operand.)
  - auth-throttle contract pin (§5 — the constants the circuit breaker is tuned against
    are source-read; this case converts them into observed behavior, the same
    assumption-into-evidence move as the search-shape pin below): fire 6 bogus-token
    requests against the real kernel → assert the lockout surfaces as the distinct 429
    class with `Retry-After` (the class the breaker deliberately excludes); interleave
    one correctly-authenticated request during the lockout and assert it receives the
    same 429 (the shared per-IP lock, the §5 two-session 3+3 case exercised for real);
    with the lock still active, make a further kb tool call and assert the cooldown
    refusal — `{status: refused}`, lockout message, and **no kernel request issued**
    (empty test-harness request log for the refusal — the structural guard is proven,
    not the message); then wait out the `Retry-After` the lockout asserted and assert the next
    correctly-authenticated call succeeds with no recovery step (the §5 self-healing
    expiry; the wait follows the header, not the base constant — the interleaved
    request extends the lock, §5). **Ordering: the lock is
    per-IP, so this case 429s every other kernel call from the VM while active — it runs
    after all other kernel-dependent cases and before the raw-DELETE case, and ends by
    waiting out the backoff so the lock is expired before the case that follows.**
    **Cost (S2 correction): expect ~2 minutes, not the first lock's 60 s** — the in-test wait is bounded
    by the *extended* lock, not the served `Retry-After`: the interleaved request
    extends the lock, and its 429 header was computed before the extension, so the
    header understates the new lockout (§5 429 record);
  - query read-only end to end: a raw `DELETE` via `/api/query/sql` without `mode`
    mutates siyuan.db, while the same statement through the tool is parser-rejected and
    every tool-issued statement carries `mode: "readonly"` (defense-in-depth pin). This
    case desyncs siyuan.db from blocktree.db until a reindex, so it runs **last** in the
    integration suite (after the auth-throttle pin has waited out the backoff) and follows the deletes with a kernel reindex (the same sanctioned
    rebuild SY-FORMAT.md §0.5 describes), bounding any leakage to its own run;
  - search request shape: `paths`-derived scoping genuinely narrows results (guards the
    silently-ignored-field degradation, §3). **Run this case first among the integration
    tests** — it is the cheapest falsifier of a load-bearing assumption (the request shape
    everything search-scoping rests on), and the failure mode it guards is silent
    (whole-workspace results, not an error). A no-code precursor works before any
    implementation exists: two `curl` calls against the live kernel with the real API token
    (held on the host, not in the VM — run from the host or paste the token), one
    correctly-shaped `paths` call expected to return only fixture-box rows, one
    deliberately wrong `boxes` call expected to degrade to whole-workspace results —
    observing the degradation converts the §3 assumption into evidence before M3 builds on
    it;
  - an OR-precedence aggregate (`SELECT box, COUNT(*) … WHERE a OR b`) with
    `kb: [fixture-a, fixture-b]` equals the sum of the two fixtures' seeded counts — the
    parenthesized-injection pin (deterministic because the fixture policy supplies exactly
    the two notebooks the query touches).
- **End-to-end (automated recall harness)**: cross-session recall is the product, and the
  failure class its test guards — a correct answer reconstructed from chat context or
  session residue instead of read from SiYuan — is indistinguishable from success to a
  human watching a click-through. So the loop is automated, headless (`pi -p` runs
  extension commands — verified against pi source, §5 scope-activation record):
  **(1) Plant** — session A with `allowUnattendedWrites: true`, prompt to remember a fact
  carrying a fresh random **nonce** (unique per run, so no prompt template, system
  context, or prior transcript can ever satisfy recall); then assert directly against
  the kernel — fixture SQL — that the fact actually landed in the fixture KB (the plant
  itself is verified, not assumed). **(2) Restart** — a brand-new session: fresh chat
  state, fresh spill dir, scope activated via `/kb` dispatch (the same headless posture
  §5 pins). **(3) Recall** — ask for the fact back; assert the answer contains the
  nonce, and assert **kernel-sourcing from the transcript**: at least one
  `search`/`query`/`read` tool call strictly between the question and the answer (the
  R1 recall loop observed, not trusted). **(4) Negative control** — delete the planted
  doc from the kernel, rerun steps 2–3 against the same nonce, and assert recall now
  *fails*. This is what makes the harness a falsifier rather than a demo: a run that
  leaks context fails step 4, exactly where a click-through would have scored another
  false positive. Fixture hygiene: the planted fact exists nowhere except the fixture
  KB — not in any file under the session cwd, not in config, not in the prompt beyond
  the plant instruction itself. **What stays manual**: the interactive click-moments
  automation cannot reach — write-confirmation allow/refuse in a TTY session, status
  slot visibility, and the M4 real-KB exercise (recipes epub extraction) — folded into
  a residual checklist whose job shrinks from "prove recall works" to "prove the
  interactive moments work".

## 11. Milestone rollout

| # | Milestone | Gate |
| --- | --- | --- |
| 0 | **VM→host connectivity + auth smoke test** — guarded endpoint probed with no token, a bogus token, and the real API token | ✅ **Done.** Connectivity: 200 (`{"code":0,"data":"3.8.2"}`) from the VM at `http://192.168.100.1:6806`; deployment: `HOST_SERVICE_PORTS` += 6806, firewalld rich rule for the VM subnet; SiYuan published on `192.168.100.1:6806`. **Auth posture (verified in second pass):** the original M0 test hit `/api/system/version`, which has no auth middleware, so it proved connectivity only — and the deployment then had `ACCESS_AUTH_CODE_BYPASS=true`, which granted anonymous admin (verified: unauthenticated `/api/query/sql` returned data). Fixed by setting a non-empty access auth code (removes the bypass; `${SIYUAN_ACCESS_AUTH_CODE:?...}` interpolation in compose, value in gitignored `.env`, shape in committed `.env.example`) and removing the bypass. Re-verified matrix: no token → `Auth failed [session]`; bogus token → rejected; real API token → `code:0` on `/api/notebook/lsNotebooks` and `/api/query/sql`. The `ACCESS_AUTH_CODE_BYPASS` line must never return to the compose file. Pinned version: **3.8.2**. |
| 1 | Repo scaffold — monorepo or two dirs, `siyuan-core` package skeleton, settings schema | `vitest` runs green on trivial test |
| 2 | `siyuan-core` client — typed endpoints, auth, version check, mock-fetch unit tests | Unit suite green; integration profile passes against real SiYuan (auth smoke matrix against a guarded endpoint included; the verified-create *kernel-contract pin* included — the single riskiest kernel contract, tested as soon as the client surface exists (the *tool-path* case lands with the extension at M3); the **auth-throttle contract pin** included, ordering per §10; **search `paths`-shape pin runs first** — cheapest falsifier, guards the silent whole-workspace-degradation failure mode §3 search-scoping rests on; a no-code precursor — two `curl` calls from the host — can run before any client code exists) |
| 3 | KB extension — tool set, `kb` param validation, `/kb` command (on/off toggles incl. `all`, scope, chat state via `appendEntry`), interactive write confirmation | Tools callable from pi; scope survives session restart; `/kb <name> on` and `/kb all off` land mid-session; write confirmation refuse/allow verified; auth circuit breaker degrades after 3 consecutive auth failures; write-path integration suite green under the fixture policy (§10), incl. the title-guard kernel round-trip pin, the version-refusal contract pin (§2/§5), the stale-target contract pin (§4), and the headless `/kb` dispatch exercised for real (`/kb all off` from `pi -p` — converting the §5 scope-activation source-read claim into evidence before M4's harness depends on it) |
| 4 | Loop validation — write-back conventions exercised on a real KB (e.g. recipes epub extraction) | **Automated recall harness passes end to end (§10)**: plant (kernel-asserted), restart, recall (nonce + transcript-proven tool use), negative control on deletion; residual manual checklist covers the interactive-only moments (write confirmation, status slot) |

---

## Appendix — decision ledger

| Decision | Choice | Rejected alternative | Key rationale |
| --- | --- | --- | --- |
| Sharing model | Local symlink/`file:`, no npm publish | npm publish | No versioning tax; general code anyway |
| Core package shape | Library-only, zero pi imports | Core as second pi plugin | Zero context surface; no distribution channel to exploit; pi-tool-masking precedent |
| Transport | Kernel HTTP API | MCP bridge to SiYuan's `/mcp` | Simpler, no SDK; both paths use the same admin token, MCP adds protocol overhead with no capability |
| v1 scope | Lean agent-driven loop | RAG/graph/dream-cycle in v1 | GBrain zero-key mode proves lean loop; RAG is planned v2 work, sequenced after the lean loop — v1 stays embedding-free so the sidecar lands without re-architecture |
| Model neutrality | By construction (no model calls) | Provider abstraction layer | Nothing to abstract if you never call |
| Write-back layout | KB notebook(s), doc trees, block-ref provenance | Append-only journal; mixed into user notebooks | GBrain entity/source separation maps to native SiYuan refs; blast radius |
| Multi-KB config | settings.json array | Hardcoded single KB | Real use case (recipes vs projects); cheap |
| Scope state | `pi.appendEntry("kb-scope")` | pi-tool-masking reuse; per-KB toolsets | Namespace clash with masking state; per-KB tools multiply context |
| Scope mechanism | Required `kb` param on every call — array on read tools, single name on write-back | Hidden scope (no param); optional param defaulting to active scope; list-valued `kb` everywhere | Model can honor explicit user intent; no param-vs-scope ambiguity class; rejections list active KBs (discovery via error), results echo resolved KB; single-name writes keep landing-KB unambiguous; empty `kb: []` on read tools rejected extension-side, never forwarded (query would build `box IN ()` or skip injection on an "empty = no filter" shortcut — unscoped aggregates; search `paths: []` silently degrades to whole-workspace) — an empty scope means "nothing is in scope", never "search everything" |
| Scope activation | `/kb <name> on\|off` — single-name idempotent toggle; `/kb all on\|off` for set-wide actuation (`all` = reserved keyword over the same verb, tbox `toggleAll` precedent; `all on` = every KB in the valid post-validation set, `all off` = persisted empty set); the written `kb-scope` entry is the full post-toggle set; latest entry wins; works headless too (`pi -p` runs extension commands — verified against pi source); boundary is **no agent-invocable activation tool**, not interactivity | Multi-name set-replacement (partial-apply question to answer, silent-scope-shrink on typo — the exact bug class the list grammar must then re-pin away with all-or-nothing validation); agent-invocable activation tool; config/restart-only | One command touches one name, so atomicity is trivial and no toggle can silently narrow the scope; `all` resolves against the already-validated config, so it has no partial-apply trap either; same mechanism covers resume, fork, mid-session switch, and headless prompts; no cardinality guessing; user intent stays user-typed. Named **subsets** stay deferred: tbox-style named KB groups are the upgrade path if ever earned — expansion is N validated toggles, all-or-nothing at the validation layer |
| `/kb` subcommands | Reserved-keyword check on the first argument, bare `/kb` prints the current scope, conflicts rejected at startup; the reserved set is just `all` (R5 — no slug convention survives, so no janitor subcommand exists) | `/kb repair` (overclaims, collides with plausible KB names); separate top-level commands | One reserved set, one `if`; `all`'s consumer is the surviving `/kb all on\|off` set-wide toggle, so a KB named `all` is still rejected at startup (R5) |
| Version gate | Eager probe at `session_start`, verdict cached, writes fail-closed until one successful probe (never-probed = no writes); **strict full-version match for writes** — any drift from the pinned version refuses writes, reads warn-and-proceed (revised from major-only after external review); no *automatic* staleness re-probe — §5 recovery's per-`/kb` re-probe is user-invoked and incidentally refreshes the verdict | Pre-write probe every call; re-probe on staleness; major-only refusal (never fires on the minor-version drift class the gate exists for — duplicate-minting create landed in v3.7.0, all pins at 3.8.2) | One HTTP call per session in the happy path (the per-write-attempt retry runs only while no probe has ever succeeded); reads unaffected; §8's pinned compose tag makes upgrades deliberate, so strictness never fires on a background point release — it fires exactly when the §10 upgrade checklist should run; mid-session version swap out of threat model |
| Doc addressing & discovery (R1/R2/R6, **supersedes the v1 title-as-primary-key doctrine**) | Docs addressed by **echoed docId** (query/outline/write-result echoes); `read` = `kb` + `docId` (topic param removed; read-by-name does not exist); discovery is search/query's job (rows echo the doc address — `root_id` + per-row KB attribution — with `id` + `hpath` as display); the recall loop is `search/query → read {kb, docId}`, a hit directly consumable with no resolution hop; the doctrine line — *mint by title (kernel-normalized), discover by query/search, consume by ID* — pinned in the tool descriptions; doc-level targeting rides the pure-ID endpoints (`/api/filetree/moveDocsByID`, `/api/filetree/removeDocByID` — S1: the path-based `moveDocs` shapes fail the kernel's `IsNodeIDPattern` check) | Name/hpath resolution (basenames force disambiguation state machines for same-basename collisions; path-qualified topics weaken recall and re-open the A1 blocker — the v1 hpath-equality lookup could not reach a moved doc, the silent topic-fork failure); keeping read-by-topic with docId fallback (retains the near-match/duplicate machinery on the read path for one saved query hop) | SiYuan's doc ID is the identity key (`data/<notebook>/<blockID>.sy`, uniqueness by minting); hpath is a derived label — rebuilt on every rename/move, collidable (duplicate-minting create since v3.7.0, unguarded `renameDoc0`). The schema principle (targets are agent-supplied IDs read off tool-echoed data) extends up one level; scoping rides the one ownership query. GBrain anchor: its query skill discovers by search and reads full pages only on confirmed targets — this revision goes one step stricter and refuses name-reads entirely; the one-query recall hop in fresh sessions is what the vector sidecar (§6) improves rather than works around |
| Create addressing (R3, **supersedes the v1 slug mint address**) | `create` takes a **title**; write-only existence guard on the kernel's **stored titles** (`blocks.content`, `LIKE`-based — ASCII-case-insensitive exact leg, escaped wildcards, space/hyphen/underscore prefix-variant scan); mint policy builds the submission path from ground truth (trimmed title; top-level single-segment path; nested = stored parent hpath read-back + `parentID` pair); verified-create keys on the kernel-returned root ID, fail-loud on nested shape (nested hpath assert derived from the read-back child row, never the submitted title) | Guard on slug-hpath equality (inherits every hpath problem); keeping the slugifier as the mint address (predicts what the kernel stores → forced sanitize-parity, lowercase doctrine, user-edit drift class, and a janitor) | The kernel stores `normalizeDocTitle(submitted)` — a tool-predicted hpath can only be matched by replicating kernel sanitization, which was the entire downstream mechanism chain (slugifier, parity pins, lowercase rule, fix-slugs, hand-rename advisory — all deleted with it); reading stored titles back is kernel ground truth. Titles whose stored form would unpredictably transform (tab/newline/control) are rejected at mint with a rephrase hint; HTML-special titles are guard-matched via escape parity (deterministic transform, parity pinned live by the §10 round-trip), so the guard only ever faces titles it can reproduce in their stored form |
| Title policy (R4, **supersedes the v1 "create determinism" claim**) | Four-tier taxonomy stated explicitly: ASCII casing → guard exact leg; shared prefix → near-match scan; transform-forming strings → rejected at mint; paraphrase → accepted duplicate, reconciled later. The §6 vector-dedup sidecar is promoted to the eventual **primary** mechanism for topic identity; the guard is the zero-dep fallback | Claiming "same title → same address across sessions" as identity determinism (determinism of form for identical strings only — LLMs paraphrase, tier 4 was never solvable syntactically) | GBrain's dedup rides embedding similarity for the same reason (`create_safety: exists \| probable \| unknown`); tier-2 guard + accepted-duplicate path is their `probable/unknown` with LIKE instead of vectors |
| User edits (R5) | UI renames and hand edits to KB docs are safe by construction — identity is the docId; no hand-rename advisory or rename-detection machinery; `/kb fix-slugs` and the `fix-` prefix reservation do not exist (nothing to repair without a slug convention); `all` stays reserved (its consumer survives) | Keeping fix-slugs for title hygiene (no slug convention left to enforce) | A rename's worst case is the accepted two-docs-reconcilable path — one guard miss, reconcilable, never data loss; block IDs and docIds survive renames untouched |
| Settings parent key | Single `pi-kb` parent key (= package name), full shape pinned in §5 | Bare `kb` parent key; flat per-KB keys | Namespace collisions with other extensions; `defaultKBs` needs an array to reference |
| Project/global config split | `kbs` + connection settings global-only; `defaultKBs` settable at both levels (array-replace = intended semantics); absent key = empty active set (no implicit activate-all) | Projects re-declaring the full `kbs` array; extension-defined array composition; absent = activate-all (silently widens write blast radius when KBs are added) | pi replaces arrays wholesale in settings merge (`isMergeableObject`); notebook IDs in one place can't go stale in two; project scope intent stays per-project; blast radius is always explicitly declared |
| Error surface | `{status, message}` envelope on every tool result; status classes pinned (outcome-classifying: `ok`/`near_matches`/`duplicate`/`error`/`refused`), `truncated`/`post_filtered` are payload markers never statuses — a capped guard stop must carry `near_matches` *and* the truncation marker simultaneously | Free-text with fixed prefixes; `truncated` as a sixth status value (one status cannot carry a guard stop and its cap at once) | One shared helper; refusals always name the fix; implementers never assign status per call — the §5 decision table does |
| Headless writes | Default-deny; enabled by `pi-kb.allowUnattendedWrites: true`; interactive sessions always confirm (no per-session toggle); RPC (`--mode rpc`) is not headless — its confirm dialog works via the extension UI sub-protocol, with a timeout so a non-responding client auto-refuses (§5); untrusted content must enter via files/tools, never interpolated into headless prompt strings — prompt text dispatches `/kb` (§5 residual, §9) | Default-allow headless; CLI flag; per-session toggle chat state | Unattended writes require a typed opt-in; settings is the only escape hatch headless can reach; a toggle adds convenience, not capability; the confirm timeout keeps every RPC client shape fail-closed (cancelled/timeout ⇒ refused, never a hang, never a silent allow) |
| Spill files | `os.tmpdir()/pi-kb/<session-id>/`, `{tool}-{sha256-16hex}` (`.jsonl` for row and outline spills, `.md` for raw read spills), 8000-char preview; **no cleanup machinery** — files persist until OS reboot | TSV rows; task-hash names; flat shared dir; terminal-shutdown cleanup | Lossless, self-describing, still line-greppable; content-hash dedupes; per-session dir avoids cross-session interference without tracking; no cleanup means no unsafe-delete bug class (`session_shutdown` fires on resume/fork, where the transcript still quotes spill paths) and no terminal-shutdown definition to pin — accumulation is cosmetic and reboot-bounded |
| Recall test | **Automated headless harness** (§10): nonce-planted fact, kernel-side plant assert, fresh-session recall with transcript-proven tool use, negative control (delete → must-not-recall) | Manual click-through only (a human cannot distinguish kernel-sourced recall from chat-context reconstruction — the exact failure class the product exists to prevent — and a demo proves nothing about regressions); full UI automation of interactive moments | `pi -p` runs extension commands (verified, §5); the nonce makes a context-sourced false positive structurally impossible, not merely unlikely; the negative control converts "the harness detects sourcing" from assumption into evidence — the same move as the search-shape and throttle pins; interactive-only moments (confirmation dialogs, status slot) stay manual because headless cannot exercise them |
| Unreachable startup | Degrade: session lives, tools registered, per-write-attempt probe retry while no successful probe exists; `kb` status-bar slot (active KBs + connectivity) | Fail session; lazy-connect | Chat shouldn't die as sidecar collateral; gate stays fail-closed; visible state via status slot |
| Result budgets | Inline-cap + spill-to-temp-file (pi-browser `capFetchContent` shape); the forced-inline heading outline is budgeted like rows — first `OUTLINE_HEADINGS` inline + spill pointer, cap on rendering only | Byte-truncation in the result; trusting the kernel's `Search.Limit` clamp; unbounded inline outlines (a 2,000-heading doc defeats the minimal-context goal on every read and write) | Lossless (content deferred, not dropped); reuses native `read`/grep for extraction; one mechanism covers query/search/read; kernel limit is workspace config, a backstop not a contract |
| Isolation | Soft (tool-level) | Hard (per-KB tokens/instances) | Named ceiling; out of scope v1 |
| Writes | Kernel API only, ever; **replace-first** mode preference (`edit`/`replace-section` preferred, `append` for new facts, `delete`/`move` for reconciliation); `append` = `insertBlock` with `nextID=<next heading>` (a `previousID` after a section-end list nests inside it); create minted by title behind the stored-title guard, verified by **by-ID asserts on the kernel-returned root ID** (nested: fail-loud shape asserts — content check cut, §4) | Direct `.sy` file access; `appendBlock` under headings; trusting `createDocWithMd` success; whole-doc removeDoc+recreate (git restores bytes, not the block IDs other live docs reference) | Structural: VM can't see host files; kernel owns two derived indexes (blocktree.db, siyuan.db) that direct writes desync (SY-FORMAT.md §0.5); GBrain's direct writes work only because it owns its format and is sole writer; user prefers coherency (replace) over append-only growth. Verified against kernel source: `appendBlock` requires a container parent (headings are leaves); since v3.7.0 (commit `4f2148e3b`) create-on-existing-path mints a duplicate doc — the guard keeps that create from firing, and verified-create asserts the mint that does go through (R3) |
| Query scoping | Parser-certified `box IN (...)` injection — `node-sql-parser@5.4.0` exact-pinned in `pi-kb` (bumps gated by the §10 upgrade checklist: parser regression = silent mis-scope), parenthesized WHERE splice, FROM allowlist (`blocks`/`refs`), single-table-FROM-only (JOINs rejected: the unqualified injected `box` is ambiguous against a two-table FROM), no CTEs (kernel readonly permits WITH — `stmt_validate.go:165` — so layer 1 is the only line of defense, and a CTE shadowing an allowlisted name would fabricate in-scope rows) — plus kernel `mode: "readonly"` and the box-carrying-rows post-filter backstop; anything else rejected, never guessed at | Post-filter only (aggregates wrong, and box-less aggregate rows would all be dropped); hand-rolled token scanner (OR-precedence, aggregate-backstop, and unrestricted-FROM holes — silent mis-scope class); agent-supplied filter (guesswork); raw SQL rewriting (silent semantics change) | The parser answers "single top-level SELECT over allowlisted tables" exactly; injection lands parenthesized in the top-level WHERE so aggregates compute over in-scope rows only; `mode: "readonly"` (source-supported, same named-exception class as fullTextSearchBlock) makes the query tool structurally unable to write; the backstop exempts box-less aggregate rows because layer 1 guarantees scoping (no `blocks(box)` index — correctness mechanism, not performance) |
| SQL certification dependency | `node-sql-parser@5.4.0` (SQLite dialect) exact-pinned in `pi-kb` — bump gated by the §10 upgrade checklist | Hand-rolled token scanner; coords-based text splice | Scanner failure mode is silently wrong results; the kernel itself uses vitess `sqlparser` for its LIMIT clamp; executed parser spike (node-sql-parser@5.4.0, SQLite): no AST locations on any dialect → coords splice impossible; serializer round-trip stable on the certified subset → injection = AST rebuild + `sqlify` + re-parse verification; multi-statement returns an array (reject), UNION hides in `_next`/`set_op` under `type: 'select'` (reject on fields); `siyuan-core` stays zero-dependency |
| Search request shape | `paths: [<boxId>]` (kernel derives boxes from the first path segment) | A `boxes` JSON field | No such field exists — silently ignored → whole-workspace search where pre-filter truncation can drop all in-scope matches |
| Agent-supplied query LIMIT | Passthrough uncapped — the extension injects a LIMIT only when the AST shows none; agent-supplied limits are never clamped or rejected (§3) | Clamping to the shared limit constant; rejecting LIMITs above it | The agent owns its query budget like it owns its WHERE clause; the spill mechanism already bounds the result (lossless, deferred) and the 30 s client timeout bounds a runaway call, so a clamp adds code and a behavioral surprise ("why did my LIMIT shrink?") to protect the agent from its own explicit input — one slow call it self-corrects from is the reconcile loop the design trusts everywhere else. Upgraded if oversized-LIMIT latency ever shows in use: one-line `min(existing, 64)` clamp in the existing AST rebuild. Pinned by the §10 passthrough unit case |
| Multi-KB search fan-out | One kernel call per resolved KB (`paths: [<boxId>]`, shared limit as `pageSize`), merged extension-side — per-KB kernel order preserved; per-call truncation accounting aggregated into the envelope marker | One call with multiple `paths` entries under a single `pageSize`; raising `pageSize` to cover the union | The kernel takes one `pageSize` over the union of boxes, so a hit-rich KB fills the pre-filter window and silently starves other KBs' in-scope matches — dropped pre-filter, invisible to both the post-filter backstop and the truncation marker (the same silent-miss class as the `paths` shape, one layer deeper); query has no such hole (`box IN (...)` filters inside SQLite before `LIMIT`), so fan-out restores recall parity between the two discovery tools; no global relevance rank exists anyway (kernel rows carry no scores), so per-KB ordering loses nothing; a single active KB degenerates to the exact single-call shape. Pinned by the §10 two-KB saturation case |
| Search method param | `method` is tool-owned: extension always sends `method: 0` (keyword) and rejects agent-supplied values — the same ownership rule covers the aux params `types`/`orderBy`/`groupBy`, which the tool **omits entirely** (kernel defaults apply; absent is the pinned behavior) | Exposing `method` (or the aux params) to the agent; inventing tool-side defaults for the aux params | `method: 2` is SQL search gated to admin role only (`api/search.go`) — the API token is always admin, so an agent-supplied `method` would smuggle raw SQL through the search route past the §3 parser certification; one tool-schema constraint closes it |
| replace-section ordering | Insert new body, then delete old (insert-before-delete) | Delete-then-insert | Mid-sequence failure costs visible duplication, never loss — no kernel transactions (§6) |
| Write-confirmation timeout | `pi-kb.writeConfirmTimeout` (seconds, default 60): user-owned disruption dial; `0` waits indefinitely; timeout expiry refuses with reason `confirm_timeout`, **terminal for that write in that session** — a same-write re-request returns the terminal refusal immediately (no new dialog), message tells the agent to stop and report the pending write; an explicit `confirmed: false` decline stays recoverable `refused` | A pinned constant (no universal value exists — disruption-vs-oversight is user preference, e.g. a git-backed workspace tolerates far less oversight); `0` = auto-approve (overloads the timeout knob with the never-ask semantics `allowUnattendedWrites` already owns — two ways to disarm the confirmation is how safety flags rot); a non-terminal timeout refusal (AFK user + retrying agent = unbounded confirm/timeout/refuse token treadmill, the retry loop class the 429 cooldown prevents) | Fail-closed on expiry is unchanged; terminality converts the dangerous loop into the bounded one — one refusal, agent stops, pending write surfaces in its report for the returning user; `0` = indefinite wait keeps a usually-present user from ever losing a write while burning zero tokens; the never-asked path remains the typed `allowUnattendedWrites` opt-out. Pinned by the §10 confirm-once/terminal-refusal unit case |
| Auth lockout | Extension circuit breaker, 3 consecutive auth failures → degraded fail-fast; 429 with a correct token is a separate class — never counted toward the breaker, never retried, surfaced as a self-healing lockout refusal (the state is kernel-side and expires on its own, so no `/kb` recovery applies), and arms a **cooldown deadline** (now + `Retry-After`, floor 60 s) under which every kb tool call is refused locally with zero kernel round-trips — the structural counterpart to the breaker, so a retrying model cannot extend the lock; the refusal message says the token is probably correct, forbids token/settings edits and retries, and tells the model to report and pause; recovery = any `/kb` dispatch re-runs the full validation pass (settings re-read, probe, notebooks) and on success clears the breaker | Client-side never-retry alone (the agent's tool-call retry loop is the real retry loop); a message-only 429 refusal (a model that retries makes real kernel calls, each extending the lock — the "agent discipline" pattern the design rejects); restart-only recovery; counting 429s toward the breaker (a healthy session would degrade for another client's bad token) | The kernel locks the IP on the 6th consecutive failure in a 15-min window (locked-out requests themselves extend the lock — a model-paced retry loop can keep the whole VM locked out), shared with the access-auth path. The cooldown converts the dangerous loop into a harmless one (local time check, no lock extension) without expiry polling (any poll extends the lock), cross-restart persistence (kernel lock survives restart anyway; one bounded wasted call), or per-tool cooldowns. A sticky breaker without a re-read path would keep refusing after the token is fixed (settings are injected at construction); the `/kb` hook is user-typed and un-invocable by the agent, so it can never widen its own retry budget. The source-read throttle numbers (first lock 60 s = `30 << (6-5)`, second 120 s) are pinned by the §10 integration throttle case (§5 has the full record) |
| Encrypted notebooks | Rejected at `session_start` validation (`encrypted: true` → KB rejected, named) | Warn-and-proceed | The SQL surface sees only the global `siyuan.db` — an encrypted KB's blocks are invisible to the title guard, verified-create's by-ID asserts, and the backlink check, so the §4 flow misfires (§5, §9) |
| Tool surface for reconciliation | Write-back gains `delete` (block/doc) and `move` modes; `move` is cross-doc, intra-KB only (cross-KB reorganization is a UI hand-move, §6) — destination by `toDocId` (echoed, ownership-checked like every doc target) + optional `toHeadingId`, tool-fetched destination outline, tool-derived anchor across the doc boundary; result carries both outlines (`outline`/`destOutline`) + `movedBlockId` (ID preserved by `moveBlock` — never a fresh mint); `move doc: true` is the doc-level flavor via `/api/filetree/moveDocsByID` (`fromIDs` + `toID`, S1) — restructure/growth vehicle alongside nested `create` (`toDocId` omitted → un-nest to notebook root); tool-side self-descendant rejection because the kernel silently no-ops that move (`FilterMoveDocFromPaths`) | Defer reconciliation/restructure out of v1; insert-copy+delete for cross-doc moves (mints fresh IDs, orphans inbound refs — the no-whole-doc-rewrites hazard at block granularity) | §4's `duplicate` status and doc-tree restructuring are unreachable without them; still one tool, mode param; `moveBlock`/`moveDocsByID` preserve block IDs so provenance survives; a move touching two docs must echo both fresh outlines or the next chained write runs stale; after a doc-level move the doc is consumed by its echoed docId — the hpath echo is display only (R1) |
| Search transport | Named exception for `/api/search/fullTextSearchBlock` (`paths`-derived scoping + post-filter backstop) | SQL `content LIKE` only; full MCP transport | SiYuan's MCP server exposes `search.fulltext` as a supported agent-facing tool wrapping the identical kernel function — upstream support commitment by proxy; fallback if it breaks: SQL `LIKE` over documented `/api/query/sql` |
| Delete safety | Backlink check before delete via documented SQL over the kernel's `refs` table (`SELECT DISTINCT root_id FROM refs WHERE def_block_id IN (...)` — the `IN` set is the walk-enumerated delete set: target block, section walk, or whole-doc walk per mode) | Guess from outline; separate backlinks tool/endpoint | Zero new tool surface — `refs` is queryable through the same documented SQL endpoint; confirmation carries inbound-ref count + referring docs so the agent decides with refs in view |
| Replace-section ref visibility | Delete-bearing writes (`replace-section`, block/doc `delete`) carry the same backlink visibility as any delete: the `refs` query rides the confirmation (count + referring doc hpaths) and the result echoes `invalidRefs` — the actually-orphaned count, post-write (§4) | Ref-preserving section rewrite (enumerate old blocks, parse the new body, pair by position/similarity, `updateBlock` survivors in place so their IDs — and inbound refs — survive; delete/insert only the true diff) | Pairing is a heuristic: a mismap silently rewrites the wrong block's content under a surviving ID, and the (still-valid) refs guarantee no signal — invisible corruption, strictly worse than the visible orphan class this fixes (`listInvalidBlockRefs` and the `invalidRefs` echo see orphans; nothing sees a mismap). Also N+ kernel calls vs two and more partial-failure states behind the no-bulk-transactions ceiling (§6). The doctrine is agent-decides-with-refs-in-view, so pre-write and post-write visibility is the fix — not ID preservation |
| Write-back tool schema | Every call: `kb` (single name) + `mode` (+ `markdown` XOR `markdownFile` on content-bearing modes only — file input read once at call start, the captured string drives guard/confirm/kernel/verification, missing file → `error` before any kernel call); `create` takes `topic` (a title, R3) + optional `parentId`; every other mode takes `docId` (echoed target); block targets (`blockId`/`headingId`) agent-supplied, anchors (`previousID`/`nextID`/`parentID`) always tool-derived from the outline; `replace-section` is one tool call; every doc-targeting write result echoes the fresh heading outline, the resolved anchor, the new block ID, and the doc's root docId + stored title + real hpath (display) | Agent-supplied anchors (re-exposes the list-nesting trap the anchor rule avoids); multi-call replace-section (re-exposes the stale-enumeration hazard the insert-before-delete ordering avoids); post-write agent re-reads (a discipline rule that decays in long sessions — fresh-state-in-result cannot be forgotten); inline-only bodies (a 500-line draft re-transmits in full on every retry — the pi-lean-host token-treadmill class) | Targets are data the tool already showed the agent; anchors are derived placement — conflating them is how an agent-supplied `previousID` lands a block inside a section-ending list; the docId echo is the input to every follow-up read/write/move (R1); riding the outline/anchor/newBlockId on the result makes chained writes re-read-free and the doc-end fallback visible at the moment it happens; file input adds one schema union + one read and zero tool-side state — the filesystem is the staging area, symmetric with the output-side spill posture |
| Guard-stop draft staging | On a `duplicate`/`near_matches` guard stop of a create whose body arrived inline, the tool writes the captured markdown to the session spill dir (`draft-<sha256-16hex>.md`) and returns `stagedPath` in the rejection payload; the retry carries `markdownFile: <stagedPath>` (~25 tokens) instead of re-transmitting the draft; `markdownFile`-sourced creates stage nothing; no size threshold; no cleanup (§3 spill posture); read-once capture carries over, so the staged file holds exactly what the guard saw | Inline retry with the full body (one duplicate transmission per guard stop — cheap once, a token treadmill in aggregate; the pi-lean-host long-API-guide precedent: repeated failed validator calls each re-sending the whole payload); tool-side draftRef staging with a lifetime and stale-draft semantics (new state + lifecycle for one resent string); requiring a check-before-draft tool (duplicates the guard, adds a round-trip to every create's happy path) | After file-path input exists, staging is one spill-helper call plus one field on an already-exceptional path — never the happy path; the merge exit (`append`/`edit` onto the echoed docId) reuses the staged file the same way; the deterministic hash name reuses the resumed-agent same-file property. Upgrade path: extend to `confirm_timeout` write refusals if resend frequency shows up there. Pinned by the §10 staging unit cases + integration round-trip |
| Stale targets | Every insert-bearing write result is verified: `newBlockId` must appear in the fresh post-write block tree (the unfiltered `getChildBlocks` walk set — a heading-only outline can never evidence a paragraph insert), else `{status: error}` naming the vanished target with the outline attached; `edit` surfaces the kernel's synchronous not-found error verbatim; `delete` on a vanished target is accepted as a benign no-op with the unfiltered walk-ID set as evidence; `move` is verified like an insert — `movedBlockId` must appear in the destination's post-move walk set and be absent from the source's | Trust the kernel's HTTP result; post-write agent re-reads as a discipline rule | Verified against source at 3.8.2 (full per-op classification and evidence in §4): only `updateBlock` fails synchronously — vanished-target inserts and tree-level moves roll back silently behind `code: 0` (websocket-only error push), and `moveBlock`'s degenerate destinations skip silently but are unreachable by tool-derived anchors. §9's accepted concurrent-session race makes vanished targets reachable, and the assertions are free — the `getChildBlocks` walks the write-result contract already fetches carry the evidence (unfiltered ID sets, not rendered heading outlines) |
| Multi-block markdown inserts | `newBlockId` is the kernel call's returned representative ID for a body that mints N block IDs; verification is a **walk-set diff** (post-write minus pre-write walk set — the pre-write set is already fetched for anchor derivation): the returned ID must appear in the diff, and a single-block body's diff must be exactly that one ID; for a multi-block body the result semantics are "one block of the appended content" — agents needing another fragment re-locate it via outline/`query` (echoed IDs, R1) | Membership-only verification of the returned ID (a one-of-N check passes while the walk set — which the contract already fetches — holds the evidence for the whole inserted subtree); asserting the *predicted* full ID set (predicts what the kernel mints from markdown — the R3 no-prediction doctrine, now with a markdown parser in the loop) | The write tool accepts arbitrary markdown and the kernel splits it into blocks; which ID a multi-block insert returns was not source-read, so the choice is pinned by the §10 multi-block case, not assumed — the same assumption-into-evidence move as the search-shape pin; the diff costs nothing (both walk sets are already in hand) and pins what actually landed, not what the kernel's first return value claims |
| Discovery recency echo | Every discovery row — query SELECTs (include-`hpath` pattern, §5), search hits (echo contract, §3), and `duplicate`/`near_matches` candidate rows (§4) — carries `updated` (`yyyymmddhhmmss`, sorts lexically, no parsing); the echo is **data, not ordering** (kernel order and LIMIT behavior unchanged); doc-level recency reads the root row (`id = root_id`) or a `read`, since the value is per-block | Adding `ORDER BY updated DESC` to discovery (changes which rows survive LIMIT — a behavioral change disguised as an echo); deriving recency from hpath/session memory (no currency signal at all) | The reconciliation loop — "told X twice, the second version differs" — had no signal for which doc is current, leaving `duplicate`/`near_matches` judgments to a coin flip between echoed IDs; the column is free on both tools (query: a plain `blocks` column; search: the kernel FTS projections select `updated` verbatim and `fromSQLBlock` copies it through untruncated — `model/search.go:2479/:3094`, serialized per hit, `model/block.go:73`); root rows are `type='d'`, so their `updated` **is** doc-level — the §4 guard queries and `duplicate` rows already select roots. Pinned by the §10 recall-loop echo assertion (updated-echo leg) |
| `confirmNew` escape hatch | Hidden from the tool's input schema (discovered only via rejection/duplicate response messages); when passed it bypasses the **entire** title guard — both the exact leg and the near-match scan; write confirmation and verified-create still apply; `duplicate` rows carry the budgeted heading outline (the judgment is content identity, not title identity — byte-identical titles are legitimately different topics — and the exact-leg rows are few enough to afford it) | Always-declared optional param (speculative flagging disarms the guard before any collision); exact leg unflaggable (byte-identical titles ≠ identical topics — "John Smith" collisions are legitimate distinct docs, same-titled siblings are UI-creatable, and R4 concedes identity was never solvable syntactically); user arbitration on flagged re-mints (the agent has the existing doc in view and the failure mode is a visible reconcilable duplicate, never loss — no new machinery to price) | A flagged re-mint is a conscious duplicate, the accepted reconcilable class (§4 R4); hiding the param is what keeps it an escape hatch instead of a habit |

---

## Reference material (local checkouts)

| Path | What it informs here |
| --- | --- |
| `~/siyuan/` | SiYuan source — kernel API surface (§2, §3), `.sy`/torn-write behavior (§7), compose/deployment (§8) |
| `~/gbrain/` | GBrain methods — lean loop, entity/source separation, zero-key mode (§1, §3, §4, §6); `skills/query` SKILL.md + `MEMORY_VERBS_v1` — the discovery-doctrine anchor for the R1/R2/R6 addressing revision (search discovers, read consumes confirmed targets only) |
| `~/pi/` | pi harness — extension API, `session_start`/`appendEntry`, settings.json (§2, §5) |
| `~/pi-tbox/` | Precedent — two-package shape, settings schema, vitest posture (§2, §10) |
| `~/pi-tool-masking/` | Precedent — library-only core shape; why its namespace was rejected for scope state (§2, §5) |
