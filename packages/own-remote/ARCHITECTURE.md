# own-remote (`@own/remote`, plugin id `own.remote`)

SSH remote projects (own/docs/04-ssh-remote.md). This package covers R0–R1 transport and lifecycle: host registry,
bootstrap by upload, ensure inside the tunnel session, per-host loopback tunnels, epoch-scoped broker forwards and arm,
reconnect/backoff, drain and update. The credential broker (own-accounts `src/broker`, local) and its client
(own-accounts `src/remote`, `mode:"remote"`) are own-accounts; the run-time contract between them is
`src/protocol/broker.ts` (wire schemas: `Broker` in `@own/protocol`).

## Modes

| mode | where | registers | does |
|---|---|---|---|
| `local` (default) | local service, guard `OWN_OPEN_CODE=1` | `OwnRemote.Definition` (all methods; `agent.*` answer `not_supported`) | the SSH controller (process-lifetime singleton), RPC, events (leader only) |
| `agent` | remote service, guard `OWN_REMOTE=1` | `OwnRemote.AgentDefinition` (`agent.*` only) | `agent.realpath`, `agent.status`, `agent.broker.arm` (hands the key to the remote broker client), `agent.probe`; SIGUSR1 writes no heap snapshot (`muteHeapSignal`, below) |

The remote service's plugins come from the managed config this package writes (`RemoteModel.managedConfig`, 04 §5.6):
`own-accounts {mode:"remote", home}`, `own-remote {mode:"agent", home}`, and since T3 `own-team {mode:"remote", home}`
third (06 §4.13: the whole team plugin runs on the host). `own-computer-use` never goes to a host (`REMOTE_PLUGINS`
lacks it, and the gateway refuses `own.computer` on `/srv/<hostId>`), and neither does `own-import` (09, IMPORT: it
reads this PC's Codex and Claude Code stores only; the gateway refuses `own.import` on `/srv/<hostId>`). `own-harness`
(10, H0) is not carried yet either: remote installs get it once its request hooks land (10 H1).

## Modules

| file | role |
|---|---|
| `src/index.ts` | plugin entry, guards, RPC registration (`Portable.definition` of `@own/protocol`: a release bundle has its own `effect`), leader-only event republishing (own-runtime `role: "own.remote"`: its own leader, never own-accounts' control instance); `muteHeapSignal` in agent mode (EXT wave 2, below) |
| `src/singleton.ts` | process-lifetime controller per build (04 §4.1): refcount, 30 s linger, `locks/remote-controller.lock` |
| `src/controller.ts` | per-host state machine: stages, pause rules, backoff, prompt ownership and heartbeat, inspect → tunnel + ensure → readiness → arm → probe, `resolve` tokens |
| `src/operations.ts` | plan → nonce → execute: prepare (install), update (stage, drain, stop, backup, switch, restart, rollback, GC), drain, forget (with uninstall also `<OWN_HOME>/tools`), owner takeover, legacy import; `toolsEnsure` (`hosts.tools.ensure`, T3, below) |
| `src/remote/scripts.ts` | every remote POSIX script (inspect, install, ensure + keep, ops, start.sh, socket dir, owner, `tool`) and the report parsers |
| `src/remote/model.ts` | typed inspect/ensure reports, remote paths from the chosen shell mode, socket directory choice, managed config (own-team third since T3), service env, `toolDir` (`<OWN_HOME>/tools/<tool>/current`), `validatePathPrepend` |
| `src/remote/bundle.ts` | local `app\<ver>\remote\{<target>.tar.gz, manifest.json}` lookup and hash check (the installed version from `app\current.json`, `Home.layout` of `@own/runtime`; never through a junction); `locateTool`/`readTool` for `remote\tools\…` (T3) |
| `src/remote/client.ts` | own HTTP client over `-L`: `/api/info`, `/api/session/active`, `own.remote agent.*` at the remote control location |
| `src/ssh/*` | Promise facade over the vendored Effect modules, long-lived tunnel process, failure classification (`failure.ts`, below), `~/.ssh/config` file view and `ssh -G` parser |
| `src/vendor/*` | copies of upstream desktop SSH modules (own/ledger/vendored.yaml); own changes are marked `own:`, among them `ForwardAgent=no` and `ForwardX11=no` in `ssh/command.ts` `sshArgs` (EXT wave 2, below) |
| `src/protocol/*` | re-export of `@own/protocol/rpc-remote` (`OwnRemote`) and the broker run-time contract |
| `src/agent.ts`, `src/rpc/handlers.ts` | agent handlers, RPC handler maps |
| `script/bundle.ts` | release tooling: build id, plugin bundles with defines, remote tarballs + manifests (driven by `own/scripts/build-remote.ps1`); `REMOTE_PLUGINS` = own-accounts, own-remote, own-team (T3); `DESKTOP_PLUGINS` = own-accounts, own-remote, own-team, own-telemetry, own-computer-use, own-import, own-harness (activation order, seven bundles since 10 H0) and `OWN_PACKAGES` (the build-id inputs) include own-import and own-harness; `IMPORT_WORKER` bundles own-import's `src/worker.ts` first (minified, the same defines) and passes its text as the define `OWN_IMPORT_WORKER_SOURCE` to the index build, so `plugins/own-import/index.js` stays one file (the define check covers it); `package --tools <dir>` puts each target's git-lfs and `LICENSE.md` in `remote/tools/git-lfs/<ver>/<target>/` (never in the tarball) and writes `tools["git-lfs"]` into `manifest.json` and `remote_artifacts.json`; `inspectRemote(dir)` (release-smoke: plugins per target, tool hashes) |
| `script/native.ts` | Linux native inputs for the Windows cross-compile of the remote CLI (RG2): fetch the glibc native packages at the `bun.lock` versions (sha512 checked), link them for the build and unlink after, verify the Bun runtime Bun downloaded against npm and the GitHub release. T3: `GIT_LFS` pins git-lfs 3.8.1 (both release archives with their published sha256; 3.8.0 until 2026-10-30), `lfs` fetches or takes local archives, checks the sha256 before writing or unpacking, extracts only `git-lfs-<ver>/git-lfs`, requires a static ELF of the target machine (`checkLfsBinary`: 64-bit LE, EXEC/DYN, no PT_INTERP) and writes the repository's `LICENSE.md` beside it (the archives carry none); `own/ledger/vendored.yaml` keeps the same record (`native.test.ts` checks both match) |
| `script/bundle.ts verify-binary` | ELF check of each built `opencode`: 64-bit LE, machine, glibc loader, version and own-channel user agent, no foreign images, the four native libraries embedded byte for byte |

## M1 gateway (05 §13.3–13.6, §15 M1)

The remote-access gateway for paired devices (a phone browser or the installed PWA) lives in `src/gateway/`. It is a
process-lifetime object per build next to the SSH controller (`GatewaySlot.acquire`, `globalThis` key
`own-open-code.remote-gateway/<buildId>`), created by the first local-mode instance and shared by all. Whether it runs
is `OWN_HOME\gateway.json` (`{enabled, bind, port, publicOrigin}`), so the first instance after a service start opens
it again; while enabled it **pins** itself: one `Runtime.acquire({role:"own.remote.gateway"})` reference and one
controller reference, released by `gateway.disable` (05 §13.4 "고정"). A reload across builds hands the port over
(`own-open-code.remote-gateway/active`).

| file | role |
|---|---|
| `gateway.ts` | settings, plan → nonce → execute, disable, pin, status view, `devices.*` operations, the event hub |
| `config.ts` | `gateway.json`; `checkBind`: loopback only, everything else `bind_rejected_lan` (MG1); `checkOrigin` (https, or loopback http) |
| `server.ts` | the `Bun.serve` listener on `127.0.0.1:<G>` (table below), cookies, CSRF, relay, SSE filter, PTY WebSocket relay, per-device connection registry (revocation closes all of them), rate limits |
| `policy.ts` | the allow list: every upstream route (`packages/protocol/openapi.json`, checked by a test) → device scope or always-blocked; plugin RPC through `OwnAccounts.MethodScope` / `OwnRemote.scopeOf` / `OwnTeamRouting.MethodScope` / `OwnImportRouting.MethodScope` (never a copy; `own.import` decides with `OwnImportRouting.scopeOf(method, input)`: `local` (`sources.configure`, any `scope: "all"`, `migrate.plan{redact: false}`) → 403 `local`, a method outside the table → 403 `unknown`, any `own.import` call on `/srv/<hostId>` → 403 `remote`, and only the events its table declares `read` reach a device, 09 §5.5; a session create, import or update whose metadata carries own.import's helper marker is 403 `local`, since own.import deletes such sessions at its next start); body rules (no computer-use allow answer in a form reply); what the relay reads first (a fork's source session, the server's temp folder for a file write); the SSE frame filter. On `/srv/<hostId>` (T3) `own.accounts` and `own.team` keep their tables (`local` → 403 `local`, a method outside the table → 403 `unknown`), while `own.remote` (the host's `agent.*`) and `own.computer` are refused; `frameVisible(frame, servers, stream?)` drops frames of servers outside the device's list when the stream key is given (the relay does not pass it yet: it already refuses an out-of-scope `/srv/<key>` stream) |
| `devices.ts` | `OWN_HOME\devices.json`: `sha256:` token hashes only, verify/revoke/expiry (30 days, 14 days idle), `lastSeenAt` persisted ≤ 1/min |
| `pairing.ts` | pairings in memory: 128-bit one-use code (5 min), 4-digit SAS, claim secret, 2-min approval and claim windows, the brute-force limiter |
| `browser-hub.ts` | the browser pane on a device (05 §8.10, section below): viewers of paired devices ⇄ the desktop shell's `browser.host.*` long poll; in memory, outlives a listener restart |
| `ServiceTarget` (`@own/runtime` `service-target.ts`) | local service URL + password from the registration file (`service-<channel>.json`), re-read on change or 401; loopback URLs only; `fixed({url, password})` for source runs and tests |
| `web.ts` | own-web static serving (`app\<version>\web` of the installed version, `app\current.json`) with the WebUi CSP rule, SPA fallback, `<meta name="own-gateway">` + manifest link injected into `index.html` |
| `tailscale.ts` | detection only: `tailscale status --json`, `tailscale serve status --json` (HTTPS proxies and raw `TCP` forwards), `tailscale lock status --json` (Tailnet Lock); never installs, logs in, serves or funnels |
| `tls.ts` | the app listener's identity (08 §3.2): a self-signed P-256 certificate for `<pcKey>.ownpc.internal` built with a minimal DER encoder, its SPKI pin, kept in the vault (`gateway-app-tls`, DPAPI) |
| `portproxy.ts` | the direct (DDNS) route (08 §1): reads `netsh interface portproxy show v4tov4`; the setup/remove commands the user runs as admin |
| `feed.ts` | the notification feed (05 §13.6): loopback `/api/event` subscription while pinned → `OWN_HOME\feed\feed-YYYY-MM.jsonl`, 03 §21.3 kinds, no content. T3 FeedKind `team.decision`: `rpc.own.team.op.confirm` → `warn`, `rpc.own.team.integration.changed{state:"failed"}` → `danger` (no item for `conflict`, `done` or other states); the item points at the team main conversation (`team.list` → `team.get` at that server's control location, `Feed.Input.controlDir` for this PC; title = the session title cut to 120 chars), never the step text, files, nonce, manifest or a path; same team and severity within 10 s merge. One narrow subscription per **ready** host (spec addition (3) of 06 T3): the endpoint and signed token of `hosts()` in process, only `rpc.own.team.*` frames parsed (others dropped by a string check first), backoff 1–30 s, ends when the host leaves `ready` or the feed stops; started at feed start, on every local `rpc.own.remote.host.state` and every 10 s; items carry `serverKey: hostId`. `stop()` also aborts the local stream and its backoff; `following()` lists the subscribed hosts (tests) |
| `audit.ts` | 5-minute per-device counts and last address → `OWN_HOME\gateway\audit-YYYY-MM.jsonl` (no bodies, paths or tokens), plus one dated line when a device's browser view opens or closes (`note`: device and session id only). It counts device requests, refused links and claims; a link that opened and the polls of a pairing are not counted, so a pairing that never reached its claim leaves no audit line (and no file when nothing else happened in the window) |

**Logs.** In local mode every own-remote line also goes to `OWN_HOME\logs\own-remote.log` (`Log.create({file})` over
own-runtime's `LogFile`, rotated to `.1` past 10 MB): the installed service's stderr is read by nobody. A host's agent
keeps stderr only. The pairing steps are there: `pairing_opened` (scope `gateway.http` or `gateway.app`, with the agent
summary), `pairing_approved` / `pairing_approve_failed`, `pairing_ended` (`claimed`, `rejected`, `cancelled`,
`expired`, and the state it left), `pairing_device_silent` / `pairing_device_back` (an open pairing's device has not
polled for 10 s, `Pairing.SILENT_MS`; the Android app stops polling off screen), `pairing_claimed` (`deviceId`, `kind`),
and, at most once a minute per reason with a `skipped` count (anyone can send them), `pairing_open_refused`,
`pairing_poll_ended` and `pairing_claim_failed`. Never the code, the claim, the SAS, the token or an address.

| path | who | what |
|---|---|---|
| `GET /auth/connect/<code>` | the QR link | consumes the code, `own_pairing` claim cookie, `302 /pair` (`Accept: application/json` → `{claim, sas}` for apps); bad codes count toward the limiter |
| `GET /own/pairing`, `POST /own/pairing/claim` | the pairing device | state + SAS; after the PC's approval the claim sets `own_device` (`HttpOnly; SameSite=Strict; Secure` except plain-http loopback) or returns `{token}` to an app (`x-own-pairing` header) |
| `GET /own/device`, `GET /own/servers` | a device | its scopes and control location; the servers it may see (`/srv/<serverKey>`, control dir, stage) |
| `POST /own/device/revoke` | a device (both listeners) | the device revokes itself (08 §3.6a, an app removing this PC): `{deviceId, revoked:true}`, like 폐기; a cookie request needs the gateway's origin |
| `GET /own/routes` | a device (app listener only) | `{pcKey, pin, name, routes}` (08 §3.6); on the browser listener the path is an own-web page |
| `/srv/<serverKey>/api/*` | a device | auth (cookie or Bearer), `servers` check, `Policy.decide`, body rules (≤ 64 KiB; a prompt ≤ 4 MiB), a device prompt stamped with the device's scopes (`metadata["own.device"] = {scopes}`, `Policy.stamp`: a client value is replaced, the other keys stay; own.team's voice plans read it, 06 §2.9), then the service's Basic (`local`) or own-remote's signed host token (`h-…`, in process from the controller); incoming `Authorization`/`Cookie`/`Origin`/`Referer` dropped |
| `GET /own/browser/<serverKey>/<sessionID>` + `Upgrade: websocket` | a device (`read` + `browser`) | the viewer socket of a session's browser pane (below); `local` or one of this PC's SSH hosts |
| anything else | anyone | own-web (the page is not a secret; it shows the pairing screen itself); `/api/*` and `/auth/*` at the root are 404 (`/api/pair` 403) |

**App listener (08).** With `gateway.json` `app.enabled`, the same server code opens a second listener on
`127.0.0.1:<app port>` (default 28540) with the pinned TLS identity, sharing the device store, pairings and relay. It
has its own pairing limiter (every peer is 127.0.0.1, so a scanner there must not block browser pairing) and ignores
the client-sent `tailscale-user-login` header. It answers only Host `<pcKey>.ownpc.internal` (and loopback forms for tests), refuses browser pairing (no
`Accept: application/json` → 403 page, cookie claim → 403: apps pair with `x-own-pairing`), ignores
`x-forwarded-for` (every peer is loopback behind `tailscale serve --tcp` or the portproxy), and adds
`GET /own/routes` (`{pcKey, pin, name, routes}`). `devices.pair.start` also returns `appLink`
(`ownpc://pair?v=1&k&p&c&n&r…`). With `appRoute: "loopback"` that link carries only `<bind>:<app port>`, for this PC's
own 모바일 미리보기 (08 §4.3); the route appears nowhere else (QR, `/own/routes`, the gateway view), and the method is
`local` like every `devices.*` call. A pairing user agent with `OwnPreview/<n>` is summarized as
"Own 모바일 미리보기 · Windows". The vault helper runs only to read or create the identity. Revocation and scope
changes close a device's connections on both listeners.

Rules: Host header allow list (DNS rebinding), cookie requests that change state or open a socket must carry an origin
of the gateway (loopback forms, the tailnet name, the configured origin), `feed.*`/`push.*` input gets the caller's
`deviceId`, one event stream per device and server (newest wins), 60 req/s per device, `local` own.remote events and
hosts outside `servers` never reach a device.

### The browser pane on a device (05 §8.10, MBR)

The pane stays the desktop shell's (05 §8.1). `BrowserHub.Hub` (`gateway.browser`, one per gateway, in memory) only
hands things on between two sides that never meet, and reads none of it. The wire contract is
`@own/protocol/remote-browser` (`RemoteBrowser`).

```text
device viewer ── text: hello · view · ack · input · action ─▶ hub ── browser.host.pull → {views, commands} ─▶ shell main
(own-web)     ◀─ text: ready · state · result · notice        hub ◀─ browser.host.frame · state · result ── (own-desktop)
              ◀─ binary: one JPEG frame (16-byte `OBF1` head)  hub ── event browser.pane.wanted ─▶ desktop window (own-web)
```

- **The route** (`server.ts` `browserView`), a device route like `/srv/…`: device auth (cookie or Bearer; 401 with the
  unauthorized budget, the 60 req/s bucket, `touch`), 426 unless it is a WebSocket upgrade, the gateway's origin for
  cookie auth (403 `origin`), `Policy.browserView` (403 `scope_denied` naming `browser`, then `read`, then `server`;
  a server key that is neither `local` nor a host of this PC's registry is 404 `browser_unavailable`: the PC's desktop
  pane holds this PC's and its SSH hosts' sessions, 05 §8.6, §8.10.8), the session must exist on that server (`GET
  /api/session/<id>` with the service's Basic, or the host's endpoint and token when it is connected, else 503
  `host_unavailable`; the id must be one `ses…` path segment; else 404 `session_not_found`), then the upgrade with
  `control = device holds prompt`. The hub names a pane by `RemoteBrowser.paneKey` (a local session by its id, a
  host's as `<hostId>/<sessionID>`); views, commands, frames, states and `browser.pane.wanted` carry a host as an
  optional `serverKey`. A device's prompt waits for the pane of the session's own server (`attachPane`).
  `Policy.ROUTES` and `WEBSOCKET_ROUTES` (the relay's allow list) are untouched; `SocketData` is a tagged union
  (`relay` for PTY sockets, `browser`).
- **What ends a viewer.** Its closer is in the per-device `Connections`, so `devices.update` (any scope or server
  change) and revocation close it at once on both listeners: 4403 for a change, 4401 for a revoked device, 4410 when
  the listener stops (`Gateway.#shut` calls `hub.closeAll()` first). Expiry (30 days, 14 days idle) is checked in
  memory whenever something of the pane would go to the viewer or the viewer speaks (`alive()` → 4403). 4400: an
  invalid or binary message, a second `hello`, no `hello` in 10 s. 1013: more than 4 viewers of a device or 16 in all.
- **Viewers → shell.** `input` and `action` are queued only from a `control` viewer and only for a session the shell
  reported as hosted (otherwise input is dropped and an action answered `read_only` / `no_host`). Consecutive input of a
  session is merged; the queue holds 512 events (the oldest `move` phases go first); a viewer has a budget of about
  120 messages a second. An action gets a hub id and is answered by `browser.host.result`, or `timeout` after 15 s.
- **The shell's long poll.** `browser.host.pull{host, windows, hosted, waitMs ≤ 30 s}` answers at once the first time,
  when commands wait or when the wanted `views` differ from the last answer; otherwise it waits. `views`: one per
  hosted session with a greeted, visible viewer (mode and viewport of the visible viewer that chose last, `low` if any
  asks for it). A newer pull of the same host ends the waiting one without news; a new host id replaces the shell
  (queue dropped, open actions answered `no_host`, pane states and frames forgotten); a host silent for 60 s is
  forgotten the same way and viewers are told `absent`. `idle: true` (no listener, or no active device that could
  watch) answers at once. `desktop()` = a host pulled within 60 s and reported a window. Nothing on the service's
  side has a deadline for the request (a 30 s pull was checked against a real server).
- **Frames.** `browser.host.frame` is refused (`input_invalid`) from a host that is not the current one, when the
  data is not base64, not a JPEG (`FF D8`) or larger than `RemoteBrowser.MAX_FRAME_BYTES`. It goes to every greeted,
  visible viewer of the session that owes no ack (or has owed one for `ACK_TIMEOUT_MS`), and answers
  `{viewers, acked}` at the first ack of that frame, or after `ACK_TIMEOUT_MS`; `viewers: 0` at once when nobody
  watches. The hub keeps the newest frame of each watched session (memory only, gone with the last visible viewer or
  the attachment): a viewer that acknowledges an older frame, joins or turns visible gets it, so a slow viewer ends on
  the newest frame and a late one does not wait for the page to change.
- **State.** `browser.host.state` keeps the last `PaneState` of a session and sends it with the host word
  (`ready` / `attaching` / `detached` / `absent`); a session that is not hosted shows `EMPTY_PANE`, and its stored
  state goes when it leaves `hosted`.
- **Wanting a pane** (05 §8.10.4; the desktop window attaches, never the shell main): `want(sessionID)` emits
  `browser.pane.wanted` (a `local` event, dropped from device streams) at most every 5 s per session while a desktop
  runs, and the wish lasts 60 s, renewed while a visible control viewer looks at the unhosted session.
  `browser.pane.wanted` (method, `local`) lists what is wanted and not hosted.
- **A device's prompt** (05 §8.10.5 rule 2, `server.ts` `attachPane`): on `/srv/local`, with a desktop running and the
  session not hosted, the relay reads the session and, unless its rules remove the browser
  (`Policy.paneAttachable` / `browserRemoved`, core's `whollyDisabled`), waits up to 3 s (`PANE_WAIT_MS`) for
  `hub.ensure`. A timeout is remembered for 5 minutes per session (answered at once, still wanted). A failed read or a
  timeout never holds the prompt back. The device's own scopes do not matter here: `browser` is about watching.
- **`devices.json`.** `browser` is written to `extraScopes` beside `scopes` (`OwnRemote.EXTRA_DEVICE_SCOPES`): a build
  from before the scope ignores the key and loses only the scope, where an unknown word in `scopes` would fail the
  file and drop every device. Unknown words in `extraScopes` are ignored; a device without extras has no such key.
- **Never logged.** The hub and the route log `browser_view_opened` / `browser_view_closed` (device and session id),
  `browser_view_refused` (limit) and `browser_host` (`present`, `replaced`, `gone`). The audit journal gets one dated
  line per opening and closing with the same two ids. No frame, address, title, dialog text, input event or typed
  text goes to a log, an error or the audit; the tests scan for them.

## Remote layout and scripts

Every script reaches the remote as stdin of `sh -s`, except install (`sh -c '<script>'`, archive on stdin), whose text
contains no single quote or backslash so that bash, zsh and fish parse it the same way. Bodies run from a function
called on the last line, so the shell has read the whole script before a child can read stdin. Output is only
`OWN_<SCRIPT>_<KEY>=value` lines (last value wins) plus upstream's registration block for ensure.

Test seam: `OWN_REMOTE_TEST_ROOT` (never set by own-remote) prefixes `/proc` and `/etc/machine-id` and skips the POSIX
mode check of the socket directory, so the fake-SSH harness can run the scripts in Git for Windows' shell.

## Failure classification (`src/ssh/failure.ts`, 04 §6.3)

`Failure.classifyText` reads OpenSSH's own message texts (`host_key` unknown/changed, `auth`, `forwarding_disabled`,
`loopback_unavailable`; anything else is a non-pausing `connection`), and `PAUSING` lists the errors that stop
background retries until the user acts. `classify(SshFailure)` (the vendored command runner's failures) uses it as
before.

A tunnel start that ends before the ensure result goes through `Failure.classifyStart` (`controller.ts`, since EXT
wave 1, P2-27). The remote ensure script writes to the same stderr as ssh, so ssh's texts count only when ssh itself
failed: `reason: "exited"` with code 255. Any other exit code is the remote command's own status (ssh connected and
the script failed, e.g. `mkdir: cannot create directory: Permission denied` with exit 1) and becomes a non-pausing
`service_failed`; a timeout, an abort, a spawn failure or an exit by signal (no code) becomes a non-pausing
`connection`. Both carry `exited (<code>)` or the reason plus the last line of the scrubbed stderr (`Log.scrub`) and
retry with the backoff (the five-failures pause still applies). Tests: `test/unit/failure.test.ts` (exit 1 with
`Permission denied` is not `auth` and does not pause; the same text with exit 255 is `auth` and pauses; host-key,
forwarding and loopback texts count only with 255).

## A silent link (`src/ssh/liveness.ts`, 04 §6.3 "죽은 링크", own.15)

A Wi-Fi switch, a sleeping PC or a dropped router sends no FIN or RST. The tunnel's ssh gets
`ServerAliveInterval=4` and `ServerAliveCountMax=2` ahead of `sshArgs`' upstream 15 s × 3 (short commands keep those),
so it exits 255 with `Timeout, server … not responding.` 12 s after its last received byte (`Liveness.SILENT_LIMIT_MS`);
any received byte resets that, so a large transfer or a long model answer cannot starve it, where a probe of our own
through `-L` would queue behind them. `#onTunnelExit` logs `tunnel_ended` (`cause: silent | closed`) and reconnects as
before, and for ten minutes after such a drop `connection` failures retry at the backoff cap instead of pausing after
five (`Liveness.keepRetrying`). A clock tick every 2 s that comes 8 s late means the process was frozen (sleep):
`recheck` asks `/api/info` through each live tunnel for 4 s (any HTTP answer counts) and ends a tunnel nothing answers
through (`link_silent`); a host waiting for a retry tries at once. `Tunnel.start`'s `exited` waits up to 500 ms for the
streams to close so ssh's last stderr line is there. The fake-SSH harness emulates a pulled cable (`setLink(alias,
"silent")`) and OpenSSH's keepalive with the options it gets. Tests: `test/unit/liveness.test.ts`,
`test/unit/ssh-args.test.ts` (`ssh -G`), `test/e2e/liveness.test.ts`; real host: RG4's frozen sshd session in phase A
(bound 12 s + 3 s) and D4's evidence (epoch, `tunnel_ended` lines) in phase D.

## Remote hardening (EXT wave 2, decision D6 (가), 04 §7.2, §15)

From the external repository research (`own/reports/external-repos-2026-10-05.md` SEC-1, SEC-2), approved
2026-10-05. Neither needs a core patch.

- **No heap snapshot on SIGUSR1 (SEC-1).** Upstream `Heap.listen` (`packages/cli/src/heap.ts`) writes a V8 heap
  snapshot into the log folder when the process gets SIGUSR1 (not on Windows). The remote agent's shell runs as the same
  uid, so `kill -USR1` would put the armed broker key and the leases on disk, which 04 §8.3 keeps in memory only. In
  agent mode `muteHeapSignal` (`src/index.ts`, right after guard 1) removes every SIGUSR1 listener and adds one no-op,
  because with no listener the signal would end the process. Setup runs again for each Location and still leaves one
  listener. `OWN_REMOTE_ALLOW_HEAP_SIGNAL=1` in the service env keeps upstream's snapshot for debugging. Until the
  first Location loads the plugin, upstream's handler stays, but nothing is armed yet.
- **No agent or X11 forwarding (SEC-2).** `sshArgs` (`src/vendor/ssh/command.ts`) adds `ForwardAgent=no` and
  `ForwardX11=no` (`-o`) ahead of the target's own options, so short commands, `ssh -G` and the tunnel all carry them,
  and the command line wins over a user config with `ForwardAgent yes`. Without it the remote service started in the
  tunnel session would inherit `SSH_AUTH_SOCK`, and its agent shell could sign with the user's keys. The target parser
  refuses `-o forwardagent`, `-o forwardx11`, `-X` and `-Y`; a `-A` written on the target line is the user's own
  choice for that host and still wins. `own/ledger/vendored.yaml` records the change.
- Tests: `test/unit/ssh-args.test.ts` (both options in every argument list ahead of the target's; a target line cannot
  turn them back on; the real `ssh -G` with a temp config forwarding both resolves `no`) and
  `test/unit/heap-signal.test.ts` (the listener swap and the escape hatch; on POSIX a real SIGUSR1 to a child that
  listens like upstream; the opt-in G14 step on the approved host, see Tests).

## Tools on a host (`hosts.tools.ensure`, T3, 06 §4.13, 04 §16.2)

A remote own.team answers `lfs_missing` while a repository uses LFS and the bundled git-lfs is not on the host (it
cannot reach SSH itself); own-web then calls `hosts.tools.ensure{hostId, tool:"git-lfs"}` here once and retries the
enable once. Scope `manage` (device admin, like own.team `enable`), control location, one step (it only adds files).

1. Needs a host that was inspected (remote paths and platform), else `remote_unreachable`. `Bundle.locateTool` finds
   `app\<ver>\remote\tools\git-lfs\<ver>\<target>\` from `remote\manifest.json` (`bundle_missing` when absent) and
   `Bundle.readTool` checks every file's sha256 and the binary's size against the manifest before anything goes out
   (`tool_hash_mismatch{tool, expected, actual}`; the host is never contacted). The payload is the license first and
   the executable last.
2. Under the host's op lock (`controller.begin`, kind `tools`; `host_busy` otherwise) one `sh -c '<Scripts.tool>'`
   session looks: a `.verified` version makes `current` point at it and answers `present` (nothing written otherwise;
   `missing` plus `FREE_KB`). Only a missing tool gets a second session, after a free-space check of twice the payload
   (`disk_full`): `dd` reads the leading files, the executable takes the rest of stdin, sizes are checked, then
   `sha256sum -c` (else `shasum`, else `openssl`), `chmod 755`, `git-lfs version`, `.verified`, the stage moved to
   `<ver>`, `current` swapped atomically (`ln -sfn`, `mv -fT`) and checked again through `current`. Output lines
   `OWN_TOOL_{PATH, VERSION, …, DONE}`; outcomes `install_failed` (checksum, version, platform), `noexec` (exit 126),
   `disk_full` (ENOSPC/EDQUOT) leave nothing installed. All three are declared errors of `hosts.tools.ensure`
   (`@own/protocol` `rpc-remote.ts`, with `input_invalid`), so own-web words each one.
3. Each run is journaled in the local `ops.jsonl`. `<OWN_HOME>/tools/git-lfs/current` joins the host's `pathPrepend`
   once (`RemoteModel.validatePathPrepend`, `controller.updateHost`), so `pendingSettings` stays true until the next
   service start (04 §6.4); own.team's own git uses the folder at once (`own-team/src/remote/env.ts`).
4. `forget{uninstall:true}` first puts back the `filter.lfs.*` values own.team saved in each repository listed in
   `<OWN_HOME>/tools/git-lfs/repos` (`own_lfs_restore`), then removes `<OWN_HOME>/tools` with `app/`, so no repository keeps a filter that
   points at a removed folder.

Tests: `test/unit/{model, scripts, protocol}.test.ts` (quoting rules, look writes nothing, upload/link/version,
`present` drains its payload, a new version replaces `current` and keeps the old folder, the failure outcomes), and the
fake-SSH `test/e2e/tools.test.ts` (hash mismatch with no ssh call, two `sh -c` sessions and no sudo, nothing outside
`<OWN_HOME>/tools` and no `~/.gitconfig`, `present` with 0 bytes, `host_busy`, the PATH after a drain and reconnect,
forget with uninstall).

## Deviations from 04 (see the work report for the full list)

- Managed config lives in `<configDir>/opencode.json` (owned whole) instead of edited keys in `opencode.jsonc`
  (no JSONC editor on the remote). Upstream loads `opencode.json` before `opencode.jsonc`; surface entries
  `config-dir-json-first`, `config-dir-names` watch that.
- `own.remote` is defined in `@own/protocol/rpc-remote` (04 §16.1); added error types `input_invalid`,
  `not_supported`, `bundle_missing`; `agent.*` has device scope `remote` (never through the gateway).
- `heartbeat{clientId, replay:true}` (additive): sends `host.prompt` again for every prompt the client still owns.
  own-web calls it after each host list load, so a reloaded owner tab gets its pending prompt back (RG5).
- M1 (05 §13): the gateway runs in own-remote's process-lifetime singleton (not a listener class in own-runtime; the
  pin holds an own-runtime reference, 05 §13.4). Own additions: error `device_not_found`, event
  `device.pairing.ended` (local), `devices.pair.approve` returns `{pairingId, deviceId, expiresAt}` (the record is
  written at the device's claim, so an approval the phone never finishes leaves no device), `devices.list` also lists
  open pairings (a reloaded settings page gets the SAS dialog back). `push.*` answer `not_supported` (M2). Wake-up
  after a service start (05 §13.4 2) is the launcher's (`own.ps1` 0.2.0 `Invoke-GatewayWake`: when `gateway.json` has
  `enabled:true`, `own start`/`restart`/`open` call `gateway.status` at the control location once); a service started
  without the launcher gets the gateway back with the first Location that loads own-remote (`own logon` does not
  exist yet; MG9's phone half and MG10 are not run). The feed covers local sessions, host disconnections and (T3)
  `team.decision` of this PC's teams and of every ready host's team through the narrow per-host subscription above;
  other remote-session items still wait for the full remote event subscription (04 §12.3, `events.state: "off"` in
  this build). Scope choices where 05 §13.5 is silent: `GET /api/config` admin (may hold
  hand-written keys), `/api/vcs{,/base,/branch}` read (header chip), status/diff files, session delete/move and
  worktree writes admin, `plugin.update` and persistent-PTY handoff/shutdown always blocked.

## Tests

`bun test` (Windows with Git for Windows): unit tests, vendored upstream tests, the fake-SSH e2e (`test/e2e`), and the
plugin on a real server booted from source (`test/plugin.test.ts`, own-accounts' e2e kit). `script/bundle.test.ts`
checks the bundle lists (own-team third, own-import then own-harness last on the desktop; remote installs never carry
own-computer-use, own-import or, until 10 H1, own-harness), the build-id inputs and the own-import bundle with its
embedded Worker source. `test/gateway/`: the allow list against `openapi.json` and the protocol tables (the `own.import` cases iterate `OwnImportRouting.MethodScope`
without a fixed method count: read and prompt devices, `local` refused, `/srv/<hostId>` refused, declared events
visible), pairing/devices/bind units, and the gateway in process with a
fake service and host (MG1–MG5, MG8 on loopback); the browser pane on a device (05 §8.10): the hub alone on a manual
clock (`browser-hub.test.ts`), the viewer route, scopes, revocation mid-stream and the prompt wait on a real listener
(`browser.test.ts` with `test/harness/browser-gateway.ts`, a fixture other packages' tests can import: gateway, fake
service answering `browser.*` through the real handlers, paired devices, a viewer client), and once on a real server
with the gateway opened by RPC (`test/plugin.test.ts`); the Edge walkthrough with a real server, the fake-SSH host and a
375 px phone is own-web's `bun run test:e2e:gateway`. The fake-SSH harness
(`test/harness`) runs the "remote host" as a local bash with a temp HOME and a fake own-channel `opencode`
(`fake-service.ts`); it never touches `~/.ssh`, `known_hosts`, the firewall or a real host, and kills every process it
starts.

Real host (opt-in, 04 §20.3): `test/real-host/` runs the gates the fake harness cannot cover against ONE approved alias
(`OWN_REAL_HOST=dev-host`; every suite is skipped otherwise). `a-transport` drives the controller and operations in
process with the real `ssh.exe` (a temp `-F` config and temp known_hosts, never the user's files), the release tarball
and the broker test double; `b-stack` runs this PC's release service (`app\opencode.exe`, own-remote rebuilt from this
tree with the release's version and build id, placed under `<OWN_HOME>\app\<version>\plugins` with `app\current.json`) with the real broker, fake
providers reached from the host through a helper `ssh -R`, and the remote service's `HTTPS_PROXY` pointed at a local
sink; `z-cleanup` stops everything we started on the host, removes the 04 §5.3 install paths and `/tmp/own-<uid>*`, and
compares the listing with the one taken before the first suite. own-web's `e2e/remote-real` (Playwright, Edge) reuses
`stack.ts` for RG13/RG16. `c-team` (T3, 06 §11.3 TG17 and the remote parts of TG2/TG3/TG4/TG11, 07 PG2 on the
remote) drives own.team inside the host's own service through the tunnel: `team-fixture.ts` builds an F1-like code
repository and an F2-like LFS repository with plain git in one temp root `/tmp/own-<uid>-team-<rand>`, removed in
`afterAll`; the release check (own-team third in the managed config), `hosts.tools.ensure` and the bundled git-lfs
first on the service PATH, enable with `lfs-remote` before the areas, an owner shell commit storing a pointer, need
paths and integration with `push-lfs`, a tunnel kill during a 45 s check, the gateway's `/srv/<hostId>` scopes for a
read-only device, and the mirrored presets with R4 on the remote. The LFS items need a release whose remote manifest
carries the pinned `tools.git-lfs`; `OWN_REAL_HOST_TEAM_NO_LFS=1` skips them (a development check). The release is
`OWN_REAL_HOST_RELEASE` or the build of `OWN_REAL_HOST_VERSION` (default `2.0.18-own.7`, the T3 exit build). The
listings carry the sha256 of `~/.gitconfig` (`== gitconfig`), which `z-cleanup` compares (never written). Order:
`a-transport` → `b-stack` → `c-team` → own-web `remote-real` → `z-cleanup`.

`test/unit/heap-signal.test.ts` has one more opt-in step on the same alias (04 §15 G14, EXT wave 2): the release's
Linux CLI (`remote/linux-x64-baseline.tar.gz` of the `OWN_REAL_HOST_VERSION` build) and this tree's own-remote bundle
go to `/tmp/own-<uid>/heap-signal`, and `serve` runs twice in agent mode with isolated HOME and XDG roots. After
`kill -USR1`, the default run answers `agent.status` with 200, writes no `*.heapsnapshot` and keeps running; the run
with `OWN_REMOTE_ALLOW_HEAP_SIGNAL=1` writes a snapshot (the control that the signal arrived). The step kills its
processes and removes the folder afterwards.
