# Stage 0 (Modified) — De-risk the MCP network path, host-loopback first

Detailed expansion of Stage 0 from [`kb-build-stages.md`](kb-build-stages.md).
Authoritative for *how to execute the gate*; for *why MCP-only / what the tools
return / the isolation model*, defer to [`kb-architecture-plan.md`](kb-
architecture-plan.md) §1–§3.

**This is a hard gate.** If it doesn't round-trip from the VM against a throwaway
graph, nothing downstream (Stage 1 `McpClient`, Stage 2 `kb_*` tools, the
sidecars) is testable. Do it before writing a line of client code.

---

## What changed vs. the original Stage 0, and why

The original Stage 0 jumped straight to "host Logseq bound to the VM-facing
interface, probe from the VM." This modified version splits that into two
ordered de-risks so the bridge (the harder-to-debug variable) is added only
*after* the server itself is proven:

1. **Host-loopback first** — stand up Logseq on the host with defaults, probe
   from the host on `127.0.0.1`. Isolates the *server / token / tool* variables.
2. **Then bridge** — rebind to the VM-facing interface, open the bridge, probe
   from the VM. Isolates the *network / `allowedHosts` / firewall* variables.

### Decision recorded: no Logseq inside the Firecracker VM

An earlier draft proposed installing Logseq **inside** the Firecracker VM as
step 1, to de-risk the protocol with the server co-located with the client and
to give the agent autonomous work while the host setup waited on the user. We
dropped it, for one disqualifying reason:

- **Logseq desktop is an Electron app and needs a display.** The Firecracker
  base image is headless (no GPU, no display server), so running Logseq in the
  VM means standing up **Xvfb** + launching Electron against a virtual
  framebuffer. There is **no** lightweight headless option — `logseq mcp-server`
  was removed May 2026 (per `kb-build-stages.md`'s locked decisions), so the
  desktop app is the only MCP server.
- The result would be **throwaway infrastructure that exists only for testing**
  — the target topology (`kb-architecture-plan.md` §1) has Logseq on the host,
  never in the VM. The in-VM setup's failure modes (headless Electron) don't
  overlap with the production path's failure modes (bridge routing), so it
  wouldn't de-risk what we're actually going to run.
- The host-loopback probe achieves the same protocol de-risk more cheaply, with
  the GUI you already have, against a throwaway graph on the host.

The cost we accept by dropping it: **the agent cannot make autonomous progress
on Stage 0** — step 1 is human-guided (the agent can't install/open the Logseq
desktop app or click through Settings). The payoff is that we don't spend a
headless-Electron yak-shave on infrastructure we'll throw away.

---

## The modified Stage 0 at a glance

```
Step 1  Host Logseq + throwaway graph + host-loopback probe      [human-guided]
        └─ isolates: server, token, tool surface (initialize / listPages /
           searchBlocks / dry-run upsertNodes) on 127.0.0.1
        └─ exit: four round-trips succeed from the host

Step 2  Expose over the Firecracker bridge                        [agent + human]
        └─ ~/lab config edit (HOST_SERVICE_PORTS) + Logseq rebind host to the
           bridge IP 192.168.100.1 (allowedHosts is hardcoded to host:port, so
           the bind host IS the allowedHosts) + firewall (already wired in
           start.sh's HOST_SERVICE_PORTS loop)
        └─ exit: bridge config applied, VM restarted

Step 3  VM-side round-trip tests (THE GATE)                       [agent-runnable]
        └─ from the VM: initialize / listPages / searchBlocks / dry-run upsertNodes
           against the host's MCP endpoint over the bridge
        └─ exit: all four round-trips succeed from the VM

Step 4  Decide McpClient location (carried from original Stage 0) [design call]
        └─ thin duplicated client in two places (Pi extension + Python indexer)
```

Two throwaway graphs may be in play during this stage (one if you reuse the
same host graph for both steps). **Neither is the real KB.** See "Throwaway-
graph discipline" below.

---

## Step 1 — Host Logseq + throwaway graph + host-loopback probe

**Owner: human.** The agent cannot install/open the Logseq desktop app or drive
its Settings UI. This section is the user guide.

### 1a. Stand up a Logseq desktop app on the host

The MCP HTTP server lives inside the desktop app — it must be running for the
rest of Stage 0. There is no headless server to fall back on (see "Decision
recorded" above). Two ways to get a running desktop app:

- **Packaged app:** install the Logseq desktop app on the host (AppImage /
  .deb / .dmg per your platform) and open it. Simplest, no toolchain.
- **Dev build from source (recommended for this project):** run Logseq from the
  `~/logseq` source tree. The Electron dev app is the desktop app — same GUI,
  same Settings, same graph storage, same MCP server code path (`:electron`
  shadow-cljs target: `src/electron/electron/mcp_server.cljs`, `server.cljs`),
  and gives hot reload for the upstream PR work in
  [`logseq-getblock-pr-plan.md`](logseq-getblock-pr-plan.md) (which touches
  `tools.cljs` / `cli.cljs` / `db_core.cljs` / `api.cljs` / `mcp_server.cljs`,
  all in the live-rebuilt `:electron`/`:app`/`:db-worker` targets). Per
  [`docs/develop-logseq.md`](../logseq/docs/develop-logseq.md):

  ```bash
  cd ~/logseq
  pnpm install && (cd static && pnpm install && cd ..)
  pnpm watch          # builds :app :db-worker :db-worker-node :electron
  # in another shell, once watch reports `Build Completed` for :electron and :app:
  pnpm dev-electron-app
  ```

  Caveats that apply to the dev path:
  - **Browser dev ≠ desktop dev.** `pnpm watch` also serves a browser app on
    `localhost:3001`, but the MCP server is Electron-only — you must use
    `pnpm dev-electron-app`, not the browser app.
  - **Single-instance lock.** Close any other Logseq (packaged or dev) before
    `dev-electron-app` or it fails. Pick one build at a time.
  - **Dev ≠ release.** Dev mode has different optimizations and a couple of
    `DEV-RELEASE` code paths; none of them touch MCP transport, auth, or the
    tool surface, so Stage 0's probes are unaffected.
  - **Not a daily driver.** Running from source is the right setup for
    *developing and testing* the PR, not for daily-driving a patched fork
    long-term — see `logseq-getblock-pr-plan.md` §8. Once the PR is open, go
    back to stock Logseq + top-level-only + the `fetch_block_tree` seam.

**Baseline-first discipline (important):** whatever build you pick, run Step 1's
loopback probe against the **unmodified** app first and get all four
round-trips green before touching `getPage`/`mcp_server.cljs` for the PR. The
whole point of Stage 0 is to isolate one variable at a time; if you start the
probe against a build that already has PR edits and it fails, you can't tell
whether the failure is the bridge/auth or your local Clojure/webpack build. So:

  1. Stand up the app (packaged **or** dev-from-source, your call).
  2. Get Step 1e's four round-trips green on loopback — your known-good MCP
     baseline.
  3. *Then* layer the PR edits on the dev build and re-probe; any new failure
     localizes to your change.

### 1b. Create a throwaway test graph

Create a **new, empty DB graph** dedicated to Stage 0. Do **not** point this at
your real KB — Stage 0 will issue writes (dry-run only, but the path gets
exercised) and Stages 1–2 will issue real writes. Name it something obvious,
e.g. `kb-stage0-throwaway`.

Then **manually add, in the Logseq GUI**, the probe block the `searchBlocks`
round-trip needs. The MCP probe script can only *dry-run* writes — it cannot
create the block for you — so this is a prerequisite, not something the script
does. Concretely:

1. Open a page in the throwaway graph (e.g. today's journal). Blur/commit it so
   it's saved, not still being typed.
2. Add a block whose content is a distinctive **alphanumeric-only** keyword, e.g.
   `kiwiprobe77`. (Avoid hyphens/punctuation — `get-match-input`
   `src/main/frontend/worker/search.cljs:354` phrase-quotes punctuated queries
   and the trigram path doesn't surface them; `stage0probe-kiwi` was observed to
   return `blocks:[]` while `kiwiprobe77` returned a hit. See the
   `searchBlocks` punctuation bullet in "Risks and fallbacks.")
3. Wait a few seconds for `blocks_fts` to index the new block, then re-run the
   probe (Step 1e) — `searchBlocks` should return the block with its `uuid`.
4. **Record the block's `uuid`** from the `searchBlocks` response. Stage 4's
   retraction-detection probe will delete this block in the GUI and confirm its
   UUID disappears from later `searchBlocks` results (retraction-by-absence).

Adding a page or two with a few other blocks is fine too, so `listPages` has
something to return beyond the built-in schema pages, but the one mandatory
manual step is the `kiwiprobe77` block — without it `searchBlocks` returns
`blocks:[]` and the keyword leg of the gate is not closed.

### 1c. Enable the MCP server (Settings → AI)

In Logseq: Settings → AI → flip the **"Enable MCP server"** toggle on. That's
the *only* control on that screen — `mcp-server-row` in
`src/main/frontend/components/settings.cljs:1383` flips just
`:server/mcp-enabled?` and, as a side effect, silently enables Logseq's older
"Local HTTP API Server" underneath (`http-server-enabled`), because the MCP
routes are mounted in the *same* Fastify instance as the `/api` HTTP server
(`src/electron/electron/server.cljs` `start!` registers both `/api` and `/mcp`,
and one `api-pre-handler!` hook guards both). So host, port, auth tokens, and
`allowedHosts` are *all* shared with — and configured alongside — the HTTP API
server, **not** in Settings → AI. They live behind the header API-icon popup
(used in 1d and Step 2b).

Keep the **defaults** for now: host `127.0.0.1`, port `12315`, `allowedHosts` =
the default (`127.0.0.1:12315`). Do **not** rebind yet — that's Step 2. Loopback
defaults avoid the DNS-rebinding guard entirely, which is the point of doing
loopback first.

Defaults and the `allowedHosts` computation are verified at
`src/electron/electron/server.cljs` (`get-host`/`get-port` → `127.0.0.1:12315`)
and `src/electron/electron/mcp_server.cljs` (`:allowedHosts #js [(str host ":"
port)]`, `:enableDnsRebindingProtection true`). **Note:** `allowedHosts` is
hardcoded to `(str host ":" port)` — there is no UI to add extra entries. This
breaks the rebind strategy assumed by `kb-architecture-plan.md` §3; see the box
in Step 2b.

### 1d. Create a Bearer token

The token UI is **not** in Settings → AI — it's in the **HTTP API Server**
controls, which share auth with MCP (see 1c). Once MCP is enabled (1c flipped
`http-server-enabled` on), an **API server status icon** (an `api` / `api-off`
glyph) appears in the header toolbar (`server-indicator` in
`src/main/frontend/components/server.cljs`, rendered by `header.cljs:476` once
`feature-http-server-enabled?` is true). Click it → a popup with Start/Stop,
**Tokens** (key icon), and **Server config** (server-cog icon).

Click **Tokens** → a dialog (`panel-of-tokens`) with token rows (name + value)
and a regenerate button that fills a `util/unique-id`. Add one row, name it
e.g. `kb-stage0`, generate/copy its value, and **Save**. Record that value —
the VM needs it in Step 3.

Two gotchas:

- **Auth is optional until a token exists.** `validate-auth-token`
  (`server.cljs:83`) is wrapped in `when-let [valid-tokens (cfgs/get-item
  :server/tokens)]`; if no tokens are stored, the check is skipped and `/mcp`
  accepts requests with **no** `Authorization` header. So you can sanity-check
  `initialize` bare before creating a token. Create one anyway so the loopback
  probe exercises the same auth path the bridge probe will.
- **Never save an empty token list.** `normalize-tokens` turns `nil` into `[]`
  in the state atom, and `[]` is truthy in ClojureScript — so opening the
  Tokens dialog, adding nothing, and hitting Save writes `[]` to config and
  *every* request (including `/mcp`) starts getting `401 Access Denied!`. Add a
  real token row before saving.

### 1e. Host-loopback probe (the protocol de-risk)

From the host, run the four round-trips against `127.0.0.1:12315`. These
validate transport + auth + the read surface + the dry-run write path — all
without the bridge in the loop.

**Prerequisite (do this first, in the Logseq GUI):** the `searchBlocks` leg
needs a block to find. The probe script can only *dry-run* writes — it cannot
create the block for you — so add one manually first, per Step 1b: a block
whose content is an **alphanumeric-only** keyword like `kiwiprobe77`, on a
page in the throwaway graph, committed (blur it so it saves). Wait a few
seconds for `blocks_fts` to index it. Without this, `searchBlocks` returns
`blocks:[]` and the keyword leg is not de-risked.

The probe lives in a single idempotent script, [`stage0-probe.sh`](stage0-probe.sh)
(in this repo), so the loopback and bridge runs share one tested implementation.
Run it on the host:

```bash
./stage0-probe.sh http://127.0.0.1:12315/mcp "<paste token>"
```

For a meaningful `upsertNodes` dry-run, grab a page uuid from the `listPages`
output first and export it:

```bash
PAGE_UUID="<a page uuid from the listPages output>" \
  ./stage0-probe.sh http://127.0.0.1:12315/mcp "<paste token>"
```

**What the script does (and why it's written this way):**

- **`initialize` once, reuse the SID.** One `initialize` mints one `Mcp-Session-Id`;
  the script caches it in `./stage0-sid` and reuses it for every `tools/call`.
  Re-running `initialize` between probes mints a fresh id that won't match the
  live transport — and worse, against the current server it **hangs** (see the
  one-shot-`initialize` bullet in "Risks and fallbacks"). The script avoids
  both: it only re-initializes when the cached SID is missing or stale, and it
  `DELETE`s the stale session first to free the server's shared `Protocol` for
  a fresh `initialize`.
- **`-i` on `initialize`.** The `Mcp-Session-Id` rides on the SSE response
  headers; bare `curl -sS` prints only the body and hides it. The server also
  logs `Initialize sessionId <uuid>` (`mcp_server.cljs:37`) if you need to
  confirm.
- **`--max-time 10` on every `tools/call`.** The `Accept: …, text/event-stream`
  header makes the server respond with `Content-Type: text/event-stream`, and
  SSE streams stay open by design — a bare `curl -sS` prints the body then
  **blocks forever** waiting for EOF, looking like a hang. The body printed
  before the cap is the real, valid response; curl exit code 28 just means "I
  cut the idle stream off," not failure. If any probe hits 10s with **no** body
  printed, *that's* a real failure. This cap doubles as the timeout check
  `McpClient` needs in Stage 1.
- **`searchBlocks` uses `searchTerm`, not `query`** (the script's `$PROBE_KW`,
  default `kiwiprobe77`); the schema exposes only that field
  (`mcp_server.cljs:198`). See the `searchBlocks` bullet in "Risks and fallbacks."

**Step 1 exit criteria:** all four round-trips succeed from the host on
loopback; the dry-run `upsertNodes` returns a planned diff and **no new block
appears in the Logseq GUI**; `searchBlocks` returns a block **with a `uuid`**
(not `blocks:[]` — an empty result proves the call path but not the keyword leg;
if it's empty, add an alphanumeric block per Step 1b and re-run). **Record the
returned block `uuid`** — Stage 4's retraction-detection probe will delete that
block in the GUI and confirm its UUID disappears from later `searchBlocks`
results. If any round-trip fails, stop and fix the server/token/tool — the
bridge won't fix them.

---

## Step 2 — Expose over the Firecracker bridge

**Owner: human for the Logseq rebind; agent can do the `~/lab` config edit.**

The bridge **already exists** — this is *not* a networking rebuild. Verified in
`~/lab/startup_scripts/firecracker/`:

- `config.sh`: `VETH_HOST_IP="192.168.100.1"` (host veth), `VM_IP="172.16.0.2"`,
  `VETH_SUBNET="192.168.100.0/24"` (computed from `VETH_NS_IP`).
- `start.sh` netns setup: the netns MASQUERADEs the VM's `172.16.0.2` →
  `192.168.100.2` on its way out the veth, so the host sees the VM's traffic as
  sourcing from `192.168.100.2` ∈ `192.168.100.0/24`.
- `start.sh` firewall loop (line ~232): for each port in `HOST_SERVICE_PORTS`,
  adds a `firewall-cmd` rich-rule allowing `source address="${VETH_SUBNET}"`
  (`192.168.100.0/24`) to reach that port. OpenCode already uses this to reach
  `http://192.168.100.1:8001/v1` on the host.

So the only `~/lab` change is appending the MCP port to `HOST_SERVICE_PORTS`.

### 2a. `~/lab` config edit (agent-runnable)

In `~/lab/startup_scripts/firecracker/config.sh`:

```diff
- HOST_SERVICE_PORTS="8001"
+ HOST_SERVICE_PORTS="8001 12315"
```

(Replace `12315` with your chosen port if you didn't keep the default.) This is
the entire networking change. The firewall rule, netns, veth, and MASQUERADE are
already correct and will pick up the new port on the next `start.sh`.

### 2b. Logseq rebind to the VM-facing interface (human)

The host/port rebind is **not** in Settings → AI (that screen is only the
on/off toggle — see 1c). It's in the **header API-icon popup → Server config**
(server-cog icon) dialog, `panel-of-configs` in
`src/main/frontend/components/server.cljs`. That dialog edits `:server/host`
and `:server/port` and triggers a server restart on save.

> **`allowedHosts` is not configurable — this changes the rebind strategy.**
> `mcp_server.cljs` hardcodes `:allowedHosts #js [(str host ":" port)]` —
> always exactly `{configured-host}:{configured-port}`, with no UI or config
> key to add entries. So the choice of bind host *is* the choice of
> `allowedHosts`; the VM's `Host` header must equal `{bind-host}:{port}` or the
> rebinding guard rejects it. This contradicts what earlier drafts (and
> `kb-architecture-plan.md` §3) assumed about adding the VM's host header to
> `allowedHosts`.

1. **Rebind the host** — and because of the `allowedHosts` hardcode, **bind to
   the host's bridge IP `192.168.100.1`, not `0.0.0.0`**. Reason: with bind =
   `0.0.0.0`, `allowedHosts` becomes `0.0.0.0:12315`, which does **not** match
   the VM's `Host: 192.168.100.1:12315` header → the rebinding guard rejects
   every bridge request. Binding to `192.168.100.1` makes `allowedHosts` =
   `192.168.100.1:12315`, which matches exactly. This is a narrower bind than
   `0.0.0.0` but it's the only value that satisfies the guard without a code
   patch. (If `0.0.0.0` is required for some other reason, see the fallback
   below — it needs a `mcp_server.cljs` patch and is a candidate second
   upstream PR.)
2. **`allowedHosts`** — no action; it's derived from the host you just set
   (see the box above). Verify by probing from the VM in Step 3.
3. **Token** is already created (Step 1d); no change.
4. **Host firewall** for the bridge is already handled by `start.sh`'s
   `HOST_SERVICE_PORTS` loop once 2a is applied — no manual `firewall-cmd`.

**Fallback if `0.0.0.0` binding is required:** patch
`src/electron/electron/mcp_server.cljs` to make `allowedHosts` configurable
(e.g. read a `:server/mcp-allowed-hosts` config, fall back to `[(str host ":"
port)]`). ~5 lines. This is a clean, separately-mergeable upstream PR candidate
("make MCP `allowedHosts` configurable") — keep it out of the
`getPage-includeChildren` PR so each stays one-capability. Until it lands,
bind to `192.168.100.1`.

### 2c. Apply: restart the VM

The `HOST_SERVICE_PORTS` change takes effect on the next `start.sh`:

```bash
cd ~/lab/startup_scripts/firecracker
sudo ./cleanup.sh        # if a VM is running
sudo ./start.sh <name>   # re-runs the firewall loop with 12315 now included
```

**Step 2 exit criteria:** `config.sh` edited; Logseq host rebound to
`192.168.100.1` (so the derived `allowedHosts` = `192.168.100.1:12315`,
matching the VM's `Host` header); VM restarted and SSH-reachable
(`ssh -i keys/debian-trixie.id_rsa root@172.16.0.2`).

---

## Step 3 — VM-side round-trip tests (THE GATE)

**Owner: agent-runnable.** From inside the VM, run the same four round-trips,
now against `http://192.168.100.1:12315/mcp` over the bridge. This is the actual
gate — it validates the entire network path the plugin will use.

```bash
# Run from inside the VM (ssh root@172.16.0.2). Copy stage0-probe.sh onto
# the VM first (e.g. scp it, or curl it from a host-served path).
TOKEN="<token from Step 1d>"
HOST_EP="http://192.168.100.1:12315/mcp"

./stage0-probe.sh "$HOST_EP" "$TOKEN"
# or, with a page uuid for the upsertNodes dry-run:
# PAGE_UUID="<page uuid from listPages>" ./stage0-probe.sh "$HOST_EP" "$TOKEN"
```

Same script as Step 1e ([`stage0-probe.sh`](stage0-probe.sh)) — the only
difference is the endpoint. It caches the bridge SID in `./stage0-sid` on the
VM (keep that separate from the host's `./stage0-sid` so the two sessions
don't collide; or pass a third arg like `./stage0-probe.sh "$HOST_EP" "$TOKEN" /tmp/stage0-sid-bridge`).

If `initialize` fails here but succeeded on loopback in Step 1, the failure is
in exactly one of: bind (host = `192.168.100.1` in the Server-config dialog?),
`allowedHosts` (derived from bind host — is it `192.168.100.1:12315`, matching
the VM's `Host` header? remember it's hardcoded, not a list you can append to
— see Step 2b), firewall (`HOST_SERVICE_PORTS` includes `12315` and VM was
restarted?), or routing (can the VM reach `192.168.100.1` at all — `ping`/
`curl -v` to a known good port like `8001`?). Debug in that order — the
loopback success localizes it to the bridge. The SSE-stream `--max-time 10`
behavior is identical to Step 1e (exit 28 = "stream cut," not failure).

**Step 3 exit criteria (the gate):** all four round-trips succeed **from the VM**
against the throwaway graph; the dry-run `upsertNodes` returns a planned diff and
no new block appears in the Logseq GUI on the host; `searchBlocks` returns a
block **with a `:block/uuid`** (not `blocks:[]`). Until this passes, do not
start Stage 1.

---

## Throwaway-graph discipline

- The graph used in Steps 1–3 is **not** the real KB. Keep using it through
  Stage 1 (`McpClient` integration tests) and Stage 2 (the minimal `kb_*` read +
  safe-write tools, which issue *real* writes).
- The **test graph → real graph cutover** happens at the end of Stage 3, per
  `kb-build-stages.md`, once read + safe-write is proven. Do not cut over
  earlier.
- If you used a separate in-VM graph in any earlier draft: that's gone now
  (see "Decision recorded"). There is exactly one throwaway graph, on the host.

---

## Step 4 — Decide `McpClient` location (carry from original Stage 0)

Decide before exiting Stage 0 so the Stage 1 plugin tools and the Stage 4/6/7
sidecar indexers share transport logic by design, not by accident.

**Decision (locked): two thin, duplicated-on-purpose `McpClient`
implementations, grouped by language ecosystem — NOT "extension vs. all
indexers."** The earlier draft of this section said "Node (extension) + Python
(indexers)," but that mis-grouped the code-layer indexer: per
[`code-layer-plan.md`](code-layer-plan.md) §3a/§9 the Stage 7 code indexer is
TypeScript (`chunkers/code.ts`, gbrain-style Bun, "the agent runs on code like
this repo"), while the Stage 4 vector indexer and the Stage 6 typed-edges
extractor are Python and share `fetch_block_tree`
([`kb-architecture-plan.md`](kb-architecture-plan.md) §6). So the real split is:

- **TS `McpClient`** — shared by the Pi extension's `kb_*` tools **and** the
  code-layer indexer (Stage 7). One impl, two consumers in the same language
  ecosystem.
- **Python `McpClient`** — shared by the vector sidecar indexer (Stage 4) and
  the typed-edges extractor (Stage 6). One impl, two consumers.

Two impls, no third. The transport is trivial (JSON-RPC envelope + Bearer
header + `mcp-session-id` + reconnect/timeout); duplicating it across two
languages is cheaper than forcing the Python indexers to depend on a TS client
or vice versa, and cheaper than rewriting the Python indexers in TS. Both
impls are validated against the same endpoint Stage 0 just proved.

The rejected alternative — one shared client in a language-agnostic service the
others call — adds a third process and a new failure mode, for ~40 lines of
saved duplication. Not worth it.

### 4a. Process topology (locked)

Three long-lived processes hold an MCP session (each = one `initialize` + one
SID, and each must handle the one-shot-`initialize` / `DELETE`-before-reconnect
fragility recorded in "Risks and fallbacks" below):

1. **Pi extension** (TS) — `kb_*` tools; one TS `McpClient`, one session.
2. **Python indexer** (Python) — vector + edges in **one process** (they share
   `fetch_block_tree` and the block-pull path anyway); one Python `McpClient`,
   one session.
3. **Code indexer** (TS) — its own process; reuses the **same TS `McpClient`
   impl** as the extension (library, not a second copy), its own session.

~3 sessions total. Vector and edges are co-located (cohesion > isolation, since
they read the same blocks); the code indexer is separate from the extension
(isolation > coupling, so code indexing doesn't depend on extension uptime).
Rejected: one-process-per-sidecar (~4 sessions, more bootstrap duplication) and
running the code indexer in-process inside the extension (~2 sessions, but
couples code indexing to extension uptime).

### 4b. `fetch_block_tree` seam contract (locked)

**Written:** [`fetch-block-tree-spec.md`](fetch-block-tree-spec.md) (standalone,
in this repo). Both the TS and Python `McpClient` impls conform to it, and the
upstream PR ([`logseq-getblock-pr-plan.md`](logseq-getblock-pr-plan.md))
delivers the server side of the same contract. Summary of what the spec fixes
(matching the PR plan §3a/§4):

- Method signature: `fetch_block_tree(page, opts?)` where `opts =
  {includeChildren?: bool, depth?: int}`.
- Default `depth = 50`, hard cap `100`; nodes past `depth` carry
  `{:block/children {:truncated true}}` instead of their children.
- Return shape: a list of block nodes, each with stringified `:block/uuid`
  (the normalizer must stringify at **every** level, not just top-level — a
  real correctness fix the PR delivers).
- Today's behavior (no `includeChildren`) returns top-level only, no
  `:block/children` — backwards compatible, the default both impls ship with.
- Missing page raises `PageNotFound` (not `[]`); `depth` out of range raises
  `InvalidDepth`; pre-PR `includeChildren=true` returns top-level only with an
  `_truncated` flag (honest signal that Stage 5 is pending upstream).

Both impls are unit-tested against the spec (tests 1–4 now, test 5 skipped
until the capability lands), so the upstream swap is identical on both sides
and drift is caught at test time, not at query time.

### 4c. Config source (locked)

**One shared config file** read by every consumer (the extension, the Python
indexer, the code indexer) — e.g. `~/.config/kb/mcp.json` or an env file —
carrying `endpoint` (`http://192.168.100.1:12315/mcp`), `token`, and `graph`.
One place to rotate the token; no risk of the extension and the indexers
pointing at different endpoints. Rejected: extension-settings-as-source-of-
truth (introduces a sync step that drifts) and per-process env vars (re-set the
token in N places on rotation).

### Step 4 exit criteria

The four decisions above are recorded here, and the `fetch_block_tree` spec is
written as a standalone file in this repo
([`fetch-block-tree-spec.md`](fetch-block-tree-spec.md) — done). Stage 1 may now
start coding either `McpClient` against the spec and the shared config; the
upstream PR track ([`logseq-getblock-pr-plan.md`](logseq-getblock-pr-plan.md))
may start in parallel immediately — it shares the spec as its server-side
contract and has no dependency on Stage 1.

---

## Risks and fallbacks

- **`allowedHosts` mismatch is the most likely Step 3 failure.** The VM's `Host`
  header must equal `allowedHosts` *exactly* (`192.168.100.1:12315`, including
  the port). If `initialize` returns a rebinding-protection rejection, this is
  it. **The fix is *not* "add the host string to `allowedHosts`" — `allowedHosts`
  is hardcoded to `[(str host ":" port)]` with no UI.** The fix is to bind the
  server host to `192.168.100.1` (Step 2b) so the derived `allowedHosts`
  matches. If you must bind `0.0.0.0`, patch `mcp_server.cljs` (Step 2b
  fallback).
- **Loopback probe breaks after rebind — by design, accept it.** Binding host
  to `192.168.100.1` means the server only listens on that interface, so
  `127.0.0.1:12315` probes fail at the connection level (not the guard). And
  since `allowedHosts` is a single derived entry, you can't keep both
  `127.0.0.1:12315` and `192.168.100.1:12315` working simultaneously. Treat
  Step 1 as pre-rebind-only; re-probe from the VM after Step 2.
- **`mcp-session-id` behavior.** Record in Step 1 whether `tools/call` requires
  the `Mcp-Session-Id` header or works stateless. `McpClient` (Stage 1) must
  match the observed behavior — don’t assume. **Observed in this run:**
  `tools/call` works with the `Mcp-Session-Id` header captured from
  `initialize`; the server issues a fresh UUID per `initialize`.
- **`initialize` is one-shot per server lifetime — re-running the probe script
  hangs / rejects.** Root cause verified in `mcp_server.cljs:26-40`: the
  `isInitializeRequest` branch creates a *new* `StreamableHTTPServerTransport`
  and calls `(.connect mcp-server transport)` — but `mcp-server` is a single
  shared `Server` (Protocol) instance. The MCP SDK’s `Protocol.connect()`
  throws `Already connected to a transport. Call close() before connecting to
  a new transport` if `this._transport` is already set from a prior
  `initialize` that was never closed. So a second `initialize` (no
  `Mcp-Session-Id` header) against the same running server fails with an
  `UnhandledPromiseRejectionWarning` and the curl hangs (the SSE stream never
  gets a response). Restarting the server clears the in-memory `transports`
  atom and `_transport`, which is why a restart “fixes” it. **Recovery without
  restart:** send `DELETE /mcp` with the *old* `Mcp-Session-Id`
  (`handle-delete-request` at line 60 calls `(.close transport)`, firing
  `onclose` → `swap! transports dissoc ...` and freeing the server’s
  `_transport`), then re-`initialize`. **Implications for Stage 1 `McpClient`:**
  call `initialize` once at bootstrap, cache the SID, and reuse it for all
  `tools/call`. On reconnect, `DELETE` the old session (if the SID is known)
  before re-initializing. If the SID is lost (client process restart) and the
  old session is unknown, only a server restart recovers — a real upstream
  fragility worth a small companion PR (create a fresh `Server` per session in
  the initialize branch, matching the MCP SDK’s streamable-HTTP reference).
- **`searchBlocks` arg is `searchTerm`, not `query` — and `limit` is not a
  parameter.** Verified at `src/electron/electron/mcp_server.cljs:198`:
  `:inputSchema #js {:searchTerm (z/string)}`, the only field.
  `api-search-blocks` (line 111) calls `logseq.app.search` with
  `[(aget args "searchTerm") #js {:enable-snippet? false}]` — no `limit`
  threaded. Passing `{"query": ...}` fails with MCP error `-32602` (input
  validation: `searchTerm` required). Passing `"limit"` is silently dropped
  (or rejected, depending on zod strictness). The Stage 4 indexer must
  truncate the keyword leg client-side after the call.
- **`searchBlocks` empty result does NOT close the gate for the keyword leg.**
  `searchBlocks` is an FTS5 query over block content (`blocks_fts.title`), so it
  can only return a hit if a block containing the term already exists. The probe
  script can only *dry-run* writes — it cannot create the block — so adding the
  probe block manually in the GUI (Step 1b) is a **prerequisite**, not
  something the script does. An empty `blocks:[]` proves the call path but not
  the keyword leg; a hit with a `uuid` proves both.
- **`searchBlocks` phrase-quotes punctuated terms — use alphanumeric probe
  keywords.** Verified in this run: `searchTerm:"stage0probe-kiwi"` returned
  `blocks:[]`, while `searchTerm:"kiwiprobe77"` returned a hit on the same
  block-shape. Root cause: `get-match-input` (`src/main/frontend/worker/
  search.cljs:354`) sees the `-` (or any `[^\w\s]` char) and routes the query
  through `fts-phrase-input`, which wraps it as `"stage0probe-kiwi"*`. The
  trigram tokenizer doesn't surface that phrase form. **Implication for Stage
  4:** `kb_find_notes` / hybrid search should normalize or warn on
  hyphenated/punctuated search terms, or strip punctuation before calling
  `searchBlocks`. Don't assume arbitrary user queries pass through unmodified.
- **`searchBlocks` hit field is `uuid`, not `:block/uuid`.** The observed hit
  shape is `{"uuid":"…","page?":null,"fullTitle":"…","title":"…",
  "content":"…","id":…,"parent":…,"page":"<page-uuid>"}` — bare keys,
  not the namespaced `:block/uuid` / `:block/title` that `getPage` returns.
  Stage 4 code that reads `h.get(":block/uuid")` from `searchBlocks` hits
  (the earlier draft of `vector-logseq.md` §5 did) will get `None` and silently
  drop every keyword hit. Read `h["uuid"]` / `h["title"]` / `h["content"]`
  / `h["page"]` instead. (`vector-logseq.md` §5 has been corrected.)
- **Host firewall backend.** `start.sh` uses `firewall-cmd` (Firewalld). If the
  host runs pure `iptables`/`nftables` instead, the `HOST_SERVICE_PORTS` loop's
  `firewall-cmd` call fails silently (`|| true`) and the port won't be opened —
  you'd need an equivalent `iptables` rule. Check `sudo firewall-cmd --state`
  first; if it's not running, add an `iptables` ACCEPT for tcp/12315 from
  `192.168.100.0/24`.
- **VM can't reach `192.168.100.1` at all.** Validate with `curl -v
  http://192.168.100.1:8001/v1` (the already-working llama.cpp endpoint). If
  *that* fails, the bridge itself is down (netns/veth) and Step 2 didn't apply
  cleanly — re-run `cleanup.sh` + `start.sh`.

---

## Time estimate

- Step 1: ~10–15 min if Logseq is already installed; longer if the desktop app
  needs installing. Human-gated.
- Step 2: ~5 min (one config line + a Logseq Settings change + VM restart).
- Step 3: ~5 min (four curls from the VM). Agent-runnable.
- Step 4: a design decision, not work — ~5 min of thought, recorded here.

Budget ~30 min total if Logseq is already on the host; the dominant cost is the
human-gated desktop-app setup, not the networking.
