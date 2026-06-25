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
e.g. `kb-stage0-throwaway`. Add a page or two with a few blocks so `listPages`
and `searchBlocks` have something to return. Put a distinctive keyword in a
block (e.g. `stage0probe-kiwi`) so the `searchBlocks` round-trip is unambiguous.

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

```bash
TOKEN="<paste token>"

# 1) initialize — validates transport + auth. The Mcp-Session-Id response header
#    is written with the SSE stream's headers, so you MUST use -i (--include) to
#    see it — bare `curl -sS` prints only the body, never the headers, and the
#    header is definitely there (the server logs `Initialize sessionId <uuid>`
#    right after handleRequest at mcp_server.cljs:37). Expect a body like:
#      event: message
#      data: {"result":{"protocolVersion":...,"serverInfo":{...}},"jsonrpc":"2.0","id":1}
curl -sS -i -X POST http://127.0.0.1:12315/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
                 "clientInfo":{"name":"probe","version":"0"}}}'
```

Capture the `Mcp-Session-Id` response header; subsequent `tools/call` requests
should include `Mcp-Session-Id: <that value>` per the MCP spec. (If the server
accepts stateless `tools/call` without it, fine — but record which behavior you
see, because `McpClient` in Stage 1 must match it.) Or extract it straight into
a var (one initialize mints one session — don't re-run initialize between
probes or you'll mint a fresh id and your captured `$SID` won't match the live
transport):

```bash
SID=$(curl -sS -i -X POST http://127.0.0.1:12315/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
                 "clientInfo":{"name":"probe","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')
echo "SID=$SID"
```

**SSE-stream gotcha (read before running the `tools/call` probes):** the
`Accept: application/json, text/event-stream` header makes the server respond
with `Content-Type: text/event-stream`, and SSE streams stay open by design —
the server can push more events later. So a bare `curl -sS` prints the result
body as it arrives, then **blocks forever** waiting for EOF, looking like it's
"running something." The result is already in your terminal above the apparent
hang. Every `tools/call` probe below adds `--max-time 10` to cap that wait:
the body printed before the cap is the real, valid response; curl exit code 28
just means "I cut the idle stream off," not "it failed." This doubles as the
timeout check `McpClient` needs in Stage 1 — if any probe hits 10s with **no**
body printed, *that's* a real failure worth debugging.

```bash
# 2) listPages — validates a graph read. Expect the throwaway graph's pages.
#    --max-time 10 caps the SSE stream wait (see the note above); the result
#    printed before the cap is valid — exit 28 just means "I cut the stream off."
curl -sS --max-time 10 -X POST http://127.0.0.1:12315/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"listPages","arguments":{}}}'

# 3) searchBlocks — validates the keyword leg (and the retraction-detection probe
#    leg, which depends on searchBlocks). Expect the block with your distinctive keyword.
curl -sS --max-time 10 -X POST http://127.0.0.1:12315/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"searchBlocks","arguments":{"query":"stage0probe-kiwi"}}}'

# 4) upsertNodes dry-run — validates the write/dry-run path WITHOUT mutating the
#    graph. De-risks Stage 1's write surface for free. Expect a planned diff and
#    NO new block in the Logseq GUI afterward.
curl -sS --max-time 10 -X POST http://127.0.0.1:12315/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call",
       "params":{"name":"upsertNodes","arguments":{
         "dry-run": true,
         "operations":[{"operation":"add","entityType":"block",
           "data":{"page-id":"<a page uuid from listPages>","title":"stage0 dry-run block"}}]
       }}}'
```

**Step 1 exit criteria:** all four round-trips succeed from the host on
loopback; the dry-run `upsertNodes` returns a planned diff and **no new block
appears in the Logseq GUI**. If any of these fail, stop and fix the server/token/
tool — the bridge won't fix them.

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
# Run from inside the VM (ssh root@172.16.0.2)
TOKEN="<token from Step 1d>"
HOST_EP="http://192.168.100.1:12315/mcp"

# 1) initialize over the bridge — validates transport + auth + firewall + allowedHosts.
#    Use -i (--include) so the Mcp-Session-Id header is visible (it rides on the
#    SSE stream's headers; bare `curl -sS` hides it). See Step 1e for the same
#    gotcha on loopback.
curl -sS -i -X POST "$HOST_EP" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
                 "clientInfo":{"name":"probe","version":"0"}}}'
```

Or capture the session id straight into a var (don't re-run initialize between
probes — one initialize mints one session):

```bash
SID=$(curl -sS -i -X POST "$HOST_EP" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
                 "clientInfo":{"name":"probe","version":"0"}}}' \
  | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')
echo "SID=$SID"
```

If `initialize` fails here but succeeded on loopback in Step 1, the failure is
in exactly one of: bind (host = `192.168.100.1` in the Server-config dialog?),
`allowedHosts` (derived from bind host — is it `192.168.100.1:12315`, matching
the VM's `Host` header? remember it's hardcoded, not a list you can append to
— see Step 2b), firewall (`HOST_SERVICE_PORTS` includes `12315` and VM was
restarted?), or routing (can the VM reach `192.168.100.1` at all — `ping`/
`curl -v` to a known good port like `8001`?). Debug in that order — the
loopback success localizes it to the bridge.

The same SSE-stream gotcha from Step 1e applies here — `tools/call` responses
arrive as SSE and a bare `curl -sS` blocks forever after printing the body. The
probes below use `--max-time 10` to cap the wait; exit 28 means "stream cut,"
not failure.

```bash
# 2) listPages — graph read over the bridge
curl -sS --max-time 10 -X POST "$HOST_EP" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"listPages","arguments":{}}}'

# 3) searchBlocks — keyword leg over the bridge
curl -sS --max-time 10 -X POST "$HOST_EP" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"searchBlocks","arguments":{"query":"stage0probe-kiwi"}}}'

# 4) upsertNodes dry-run — write/dry-run path over the bridge, no mutation
curl -sS --max-time 10 -X POST "$HOST_EP" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call",
       "params":{"name":"upsertNodes","arguments":{
         "dry-run": true,
         "operations":[{"operation":"add","entityType":"block",
           "data":{"page-id":"<page uuid from listPages>","title":"stage0 dry-run block"}}]
       }}}'
```

**Step 3 exit criteria (the gate):** all four round-trips succeed **from the VM**
against the throwaway graph; the dry-run `upsertNodes` returns a planned diff and
no new block appears in the Logseq GUI on the host. Until this passes, do not
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

**Recommended: a thin, duplicated-on-purpose client in two places** — one inside
the Pi extension (Node, for the `kb_*` tools) and one in the Python indexer
(for the vector/edges/code sidecars). The transport is trivial (JSON-RPC
envelope + Bearer header + `mcp-session-id` + reconnect/timeout); duplicating it
across two languages is cheaper than forcing the Python indexer to depend on a
Node extension or vice versa. Both copies are validated against the same
endpoint Stage 0 just proved.

The alternative — one shared client in a language-agnostic service the others
call — adds a third process and a new failure mode, for ~40 lines of saved
duplication. Not worth it.

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
  match the observed behavior — don't assume.
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
