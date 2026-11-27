# own-computer-use architecture (`@own/computer-use`, plugin id `own.computer-use`)

Specs: 01 §10.2 (computer use), 06 §2.6 (plugin slot 6, last, after `own.telemetry`), 07 §2.4 and §5.4 (subagents
and presets), 06 §5.1 and §5.6 (own.team's main requests and team updates). The default engine is the **in-process
driver** (`driver: "windows"`): direct Win32 calls through `bun:ffi` on two Bun worker threads inside the service, so
there is no separate exe to build, sign or start and nothing for Smart App Control to block. Our own C# helper
(`own/native/own-cu-helper`, built by the in-box .NET Framework `csc.exe`, JSON lines over stdio like own-vault) stays
as an opt-in fallback (`driver: "helper"`); both speak the same protocol. The earlier cua-driver + `own-cua-proxy` plan
is dropped, and cua-driver stays a possible later `Driver` adapter.

## Role

Lets an agent see and drive the Windows desktop through ordinary plugin tools in the `computer` namespace (Code Mode by
default). Names and parameters mirror Anthropic's `computer_toolset_20260801` members (`screenshot`, `left_click`,
`key`, `scroll`, …) plus `list_windows` / `focus_window`, so both Claude and GPT models can use their computer-use
priors without provider-native tool lowering (which `@opencode/ai` does not have).

It is an **Effect-API** plugin: Promise-API throws become defects, while Effect tools fail with `Tool.Error`. Every
model-facing error carries `[computer.<code>]` in its message, because core re-wraps foreign errors by message
(`core/src/tool/runtime.ts`).

## Layers

```
src/index.ts          guard → options → Desktop.acquire → agent-wide {computer,*,deny} → tools, hooks, RPC, events
  src/agents.ts       the deny as one agent transform, registered in setup and again after each local plugin.updated
  src/tools.ts        registers the 19 tools (JSON Schema in/out, Code Mode, permission "computer"); borrows `question`
  src/gate.ts         per call: decode → kill switch → session consent → read-only role (explore, own-review)
                      → a model that sees images → subagent (allowed, root's main model)
                      → team turn → blocked chords → lease
                      → [lock] session consent again → stop chord → frame lookup + coordinate mapping → target
                      window → Policy → action
                      (keyboard: the window in front re-checked before every step) → audit + `action` notice;
                      `question` approval is asked outside the lock, then everything is checked again
  src/hooks.ts        `context`/`compaction` screenshot pruning with per-session (keep, batch) in plugin storage
  src/rpc.ts          `own.computer` handlers + `status`/`action` events (Portable.definition)
  src/singleton.ts    Desktop: one per process and build id (globalThis, live instances): driver, kill switch, lease,
                      lock, frames, grants, audit dir, notices; the live instances' options combined (the strictest
                      app policy wins); stop chord / worker or helper exit engage the kill switch; a new lease
                      holder, its release and the lease lapsing are `status` notices (team view tag, 06 §9.4)
        ▼
actions.ts            composite input in physical px; kill switch before every step; `before` hook ahead of every
                      keyboard step (after a settle pause when focus may have moved); releaseAll on failure/interrupt
        ▼
driver/driver.ts      Driver: one OS operation per method (Effect, DriverError)
   ├─ driver/fake.ts                 in-memory desktop (tests, `driver: "fake"`)
   └─ driver/windows/driver.ts       WindowsDriver.over(link): one protocol request per method, held-input tracking
        ├─ ffi()    driver: "windows" (default) → ffi/channel.ts ⇄ Bun worker threads (postMessage)
        │             ├─ desktop worker (ffi/desktop.ts): displays, capture, input, windows, focus, stop chord, mutex
        │             └─ UI Automation worker (ffi/uia.ts): the focused element (password-field rule)
        └─ helper() driver: "helper" → transport.ts ⇄ own-cu-helper.exe (JSON lines over stdio)
core/                 pure logic, no plugin services, no driver
```

## Files

| Path                                    | Contents                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`                             | Dev entry for `"<repo>/packages/own-computer-use"` (a directory plugin resolves `<dir>/server`)                                                |
| `src/index.ts`                          | `Plugin.define`: guard (`OWN_OPEN_CODE=1`, app version, options, Windows for `windows`/`helper`) or a status-only RPC, then the wiring above   |
| `src/build.ts`                          | Release defines (`OWN_BUILD_ID`, `OWN_EXPECTED_APP_VERSION`, `OWN_PLUGIN_VERSION`), `PLUGIN_ID`, `NAMESPACE`, `HELPER_EXE`                     |
| `src/options.ts`                        | `Options.decode` / `decodeResult`: every field optional, defaults filled by the schema                                                         |
| `src/singleton.ts`                      | `Desktop.acquire` (process singleton), `create` (picks the driver), `status`, `forget`, `FAKE_DESKTOP`                                         |
| `src/agents.ts`                         | `Agents.register`: the agent-wide deny, moved to the end after each `plugin.updated` of this Location                                          |
| `src/gate.ts`                           | `Gate.run`, `enabled(rules)`, `DENY`/`ALLOW` rules, the subagent and team-turn checks, question approval                                       |
| `src/tools.ts`                          | `Tools.register`                                                                                                                               |
| `src/hooks.ts`                          | `Hooks.register` (prune hooks), `key(sessionID)`                                                                                               |
| `src/rpc.ts`                            | `ComputerRpc.register`, `registerUnavailable`                                                                                                  |
| `src/actions.ts`                        | `click`, `drag`, `press`, `scroll`, `keys`, `holdKey`, `type`, `wait`, `screenshot`, `zoom`                                                    |
| `src/driver/driver.ts`                  | `Driver` interface and data schemas (`Info`, `CaptureInput`, `Event`, …)                                                                       |
| `src/driver/fake.ts`                    | `FakeDriver.make(scenario)` and `DISPLAYS` presets                                                                                             |
| `src/driver/windows/protocol.ts`        | The protocol both Windows drivers speak: ops, answer schemas, `PROTOCOL = 1`, 16 MiB line cap                                                  |
| `src/driver/windows/driver.ts`          | `WindowsDriver.over(link)` (shared op mapping and held-input release), `ffi`, `helper`, `command` (exe path), `refusal` (hello check)          |
| `src/driver/windows/transport.ts`       | Helper `Transport`: lazy spawn, hello check, rid map, events, timeout → kill, backoff, `command` override                                      |
| `src/driver/windows/ffi/channel.ts`     | Worker `Channel` (same shape as the transport): lazy start, hello check, rid map, events, timeout → abandon, backoff, graceful `close`; `worker(source)`, `script` |
| `src/driver/windows/ffi/desktop.ts`     | The desktop worker (`main`, run from source text): every desktop FFI call                                                                     |
| `src/driver/windows/ffi/uia.ts`         | The UI Automation worker: COM through vtables, `focus.element`; `TIMEOUT_MS`, `refusal`                                                        |
| `src/driver/windows/ffi/native.ts`      | Pure Win32 data helpers the workers carry as text: struct packing, `SendInput` records, GDI+ encoder parameters, monitor order, layout signature |
| `src/core/*.ts`                         | `ToolSchema` (inputs, outputs, decode), `Geometry`, `Keys`, `Policy`, `Frames`, `Budget`, `Lease`, `KillSwitch`, `Audit`, `Errors`             |
| `test/unit/**`                          | `bun test test/unit`: no desktop (the transport tests spawn `test/fixtures/fake-helper.ts`; the FFI tests use in-process fake workers)        |
| `test/e2e/**`                           | `bun test test/e2e`: real server from source and from the release bundle with `driver: "fake"`; on Windows the bundle again with `windows`    |
| `test/real/**`                          | `OWN_CU_REAL=1 bun test test/real` (skipped otherwise): both Windows drivers on the real desktop, input only to `fixture/fixture.ps1`'s window |

## Coordinates

- **Physical**: device pixels of the virtual desktop. The desktop worker thread (`SetThreadDpiAwarenessContext`) and the
  helper process are Per-Monitor-V2 aware, so they report and accept physical pixels everywhere; monitors left of or
  above the primary have negative origins. `Display.scale` is informational only. The service's process-wide DPI
  awareness is left alone.
- **Image**: pixels of one returned screenshot. A `Frame` records which physical rectangle an image shows and at what
  size; the model only sends image coordinates, and the gate maps them with `toPhysical` (pixel centre, clamped into
  the capture, `undefined` outside the image → `out_of_bounds`). `toImage(toPhysical(p)) = p` exactly for every
  downscaled frame.
- Screenshots capture one whole display. The default `standard` tier fits the long edge to 1568 px and 1.15 MP; `high`
  allows 2000 px. Both stay inside core's image pass-through limits (2000x2000, 5 MiB base64), and the encoding ladder
  keeps the base64 form under `image.maxBase64Bytes` (4.5 MB), so core never rescales an image after we computed its
  frame.
- Frames are stale once the display layout hash changes (resolution, DPI, monitor added/removed/moved); the model must
  take a new screenshot. `zoom` captures a region at higher detail but never becomes a frame.

## Consent and safety

- **Consent**: plugin tools cannot ask core for a permission (`options.permission` only filters the catalog), so:
  - every agent gets `{computer, *, deny}` (`ctx.agent.transform`): the tools are not listed by default. Core applies
    the config's and markdown agents in a builtin `post` plugin after every configured plugin, so `src/agents.ts`
    registers the transform in setup and again after each `plugin.updated` of this Location, dropping the previous
    registration: it stays last until the next activation and reaches those agents too (07 §5.4, the same pattern as
    own-accounts' `presets/agents.ts`; surface `builtin-plugin-placement`, `plugin-updated-after-activation`). Only
    one registration is live, moves run one at a time (a semaphore, the setup one included), and the plugin's scope
    drops the last on stop. It adds that one rule to each agent and nothing else;
  - own-accounts `session.approval.set{computerUse:"on"}` writes the session rule `{computer, *, allow}` before the own
    bundle, which lists them (one catalog delta per toggle);
  - the gate re-checks the **session** rules on every call: the last rule whose action matches `computer` must be
    exactly that allow, once before the call and again once it holds the action lock (turning computer use off stops
    a call that was waiting there). A later config rule (`"*": "allow"`) can make the tools visible but never counts
    as consent; an unreadable session fails closed (critic D1). Subagents (sessions with a parent) are denied unless
    `policy.allowSubagents` (`subagent`), and even then only on the root's main model: the gate reads the parent
    chain (`ctx.session.get`) and refuses with `subagent_model` unless the child has the root's provider and model id
    (07 §2.4 target `rel:"main"`; the variant may differ). A subagent pinned to another account or provider (the
    Claude slot, a metered API, a local model) or a lighter model never drives the desktop. An unreadable root, or a
    model either side does not record, refuses as well;
  - **a model that sees images** (`no_vision`, 2026-10-18): the session's model must read images
    (`capabilities.input` from `ctx.model.list`), or the agent would act on screenshots it never sees. A text-only
    model (a local model without a projector, a `compat` model whose `그림 입력` is off) is refused on every call,
    observing ones included; there is no accessibility-text fallback and no helper model (user decision "안 됨으로
    두기"). A model the list does not know is not refused. A subagent runs on its root's model, so its own decides.
    own-web blocks turning computer use on for such a model and says why;
  - **team turns** (`team_turn`): a turn that own.team started never drives the desktop, nor do its subagents. After
    consent, the kill switch and the subagent checks, before the lease, the gate reads the session's messages since
    its latest completed compaction (`ctx.session.context`, which includes core's `idle` markers) and takes the turn of
    the calling step: the messages after the last `idle` marker before the step's assistant message
    (`Tool.Context.messageID`; when the messages do not hold it, the latest turn). A message there whose metadata has
    `source: "own.team"` (`OwnTeam.PROMPT_SOURCE`) or an `own.dispatch` / `own.team.update` key refuses. So does a
    team message delivered later in the same busy period, such as a team update queued behind the user's turn (no
    `idle` marker between). A subagent is judged by its root's latest turn (an idle root's last one), so a dispatched
    owner turn cannot hand the desktop to a subagent. Session metadata `own.team` (core copies it into children) is
    never read: the user's own turns in team sessions and their children keep working. A turn that began before the
    latest compaction (a long task; upstream's background compaction can land in the middle of a turn) is read on
    from before it through `ctx.session.messages` (core P-054), newest first in pages of 20 back to the turn's `idle`
    marker or the session's start, once per compaction (the answer is kept, since messages before a compaction never
    change). Unreadable messages, or a start more than 25 pages back, refuse (fail closed);
  - the phone gateway passes only `own.computer` `status` and `killswitch.engage`, to a device that can prompt or
    switch (watch and stop, 05 §13.4), accepts `session.approval.set{computerUse:"on"}` only on the PC, and
    refuses a device's `POST /api/session` or session import whose rules allow `computer`, and a device's fork of a
    session whose rules allow it (a fork copies them; the gateway reads the source first, 05 §13.4).
  - own-web writes the switch from the session `⋯` dialog "이 세션에서 컴퓨터 사용" (consent asked once when turning
    on), shows a header chip with the activity and a Stop button, and has the status panel in 설정 > 실험
    (own-web `src/computer/`, 03 §5.7.2). `status` also reports the app policy (`policy`) for that panel.
- **Approval** (`approval` option): `session` (default) treats enabling the session as consent for every app that is
  not denied (a non-empty `policy.allowApps` is exclusive). `question` asks per app through core's own `question` tool,
  borrowed from the tool editor in the same transform ("이 세션 동안 허용 · Allow for this session" grants the app
  until the session is deleted; anything else is `not_approved`; a dismissal stays core's defect; the texts are Korean
  and English because the plugin cannot know the reader's language). The question is asked after the action lock is
  released, so other sessions keep working while the user decides (no time limit, like core's own questions); then
  the whole check runs again, because answering usually brings this app to the front: input never goes to a window
  that was not checked after the answer. It is covered by unit tests with a fake question tool only.
- **Policy** (`Policy.evaluate`, in this order): subagents; observing and hovering never check a target; no target
  window (activation changing) → `no_target`; an unknown process image, a user-denied app or a built-in denied app
  (this app, other agent apps that show approval buttons of their own: Claude, ChatGPT, Codex and the Codex manager,
  2026-11-24; credential, security and administration UI; password managers) →
  `app_denied` (deny beats every allow; only the terminal part, which includes IDEs with an integrated terminal, lifts
  with `allowTerminals`; Start and its search box are on the built-in list, since a typed name and Return runs it);
  explorer's `#32770` dialogs (the Run dialog) and any window titled like own-web
  (`own-open-code` exactly, or followed by a space and the browser's suffix such as ` - Google Chrome`,
  ` — Mozilla Firefox` or Edge's ` and 2 more pages - …`) → `app_denied`; elevated targets → `elevated_target`; for `text`, an unknown
  focused element → `no_target` and a password field → `password_field`; then allow list / session grants / approval
  mode. `text` is every keyboard step except pure navigation (`Keys.navigates`: Tab, Return, Escape, arrows,
  Home/End, Page Up/Down, alone or with shift), because shortcuts can paste (ctrl+v, shift+Insert, super+v).
- **Keyboard steps**: `type`, `key` and `hold_key` are checked as a whole first (this is where approval happens), then
  `Actions` calls the gate's `before` hook ahead of every chord, text chunk and Tab/Return, which checks the window in
  front (and the focused element for text) again. A step after a chord that can move focus (anything but one
  character) waits `settleMs` (100 ms) first. A change that fails the policy ends the call with that code (or
  `target_changed` when the new app would need approval), saying the rest was not sent.
- **Blocked chords**: `super+r` (Run), `super+x` (the Win+X menu: Run, Terminal, Task Manager), `ctrl+alt+delete`, the
  stop chord `ctrl+alt+shift+q` and `policy.blockedChords`; matching is by key plus a superset of the entry's
  modifiers. An invalid configured chord makes the plugin report `invalid_options` instead of running without it.
- **Kill switch**: engaged by the stop chord (`RegisterHotKey` in the desktop worker or the helper → `kill_chord`
  event), the Stop button (RPC) or a ready desktop worker or helper ending without `close`/`restart` (crash, external
  kill, or our abandoning it after a timeout or a broken line); engaging releases held input. Checked before every input step; only `killswitch.reset` clears it. Builds
  that overlap after a hot reload share one switch per stop file (`KillSwitch.shared`), so a stop in either build
  stops both and releases the input each build holds (each desktop registers a plain callback on the shared cell). The
  engaged state is written to `<OWN_HOME>\state\computer-use-stop.json` (removed by the reset) before held input is
  released, so it survives the desktop entry being dropped when the last Location releases it (idle eviction, location
  reload), a service restart and a crash right after the stop. The release waits at most 300 ms for that write, so a
  slow or hung write (a scanner, a network share) never keeps a key or button down. The write is best effort: if it
  fails, the running process stays stopped but a later desktop would not be. A file that does not decode counts as
  engaged.
- **Stop chord required**: before any input the gate asks the driver `hello` again (about 1 ms) and refuses with
  `no_stop_chord` while the chord is not registered (another program or a second service holds it); that `hello` also
  retries the registration, so input works again once the chord is free. `status.helper.killChord` shows it and own-web
  warns in 설정 > 실험. Observing still works.
- **Held input**: `left_mouse_up` by the session that left the button down (`left_mouse_down`) is never refused (no
  consent, kill switch, policy or stop chord check), so the user's mouse cannot stay held; it clears only that
  session's marker. Any other session's `left_mouse_up` is admitted like other input (consent, subagent, team turn,
  lease, stop chord). While a session holds the button, `mouse_move` drags and is checked like `left_click_drag`'s
  end. The kill switch and the session's deletion release a held button. The Windows driver remembers which keys and
  buttons it sent down: Windows keeps injected input pressed when the injecting thread or process is gone, so after a
  desktop worker was abandoned or a helper killed (timeout, crash, broken line) `releaseAll` sends those ups through
  the next one. `helper.restart` waits for the action lock, releases held input and ends the desktop worker with its
  own `close` (or the helper with stdin EOF), each releasing what it tracked itself, before any terminate or kill.
- **Unseen windows** (2026-11-24): every screenshot also records the windows on screen (`Frame.seen`: visible window
  ids and their apps, listed right before the capture, so a window that opens in between counts as new). A click,
  scroll, drag end or held-button move aimed by a screenshot that lands on a window that was not on screen then, of
  an app that had no window on screen either (a notification, another program's dialog, an app that just started),
  is refused with `target_changed` before the policy check, and the model takes a new screenshot. Menus and dialogs
  of an app that was on screen pass; actions at the cursor (no screenshot point) and the keyboard are not affected
  (the keyboard has its own check of the window in front). A frame whose window list failed is not checked.
- **Lease**: one session drives the desktop at a time (non-observing actions); others get `busy` until 120 s idle, or
  until the holder's run ends (`session.execution.succeeded|failed|interrupted`: `Desktop.settle` also lets go of a
  button that session left down; its frames and grants stay for the next turn).
  All driver work runs under one lock, so a target check and its input are never interleaved with another call.
- **Audit**: `<OWN_HOME>\audit\computer-YYYY-MM.jsonl`, one line per call (the `own.computer` `AuditEntry`): typed text
  becomes only its length (no hash: a short value such as a PIN could be found from it), `key` and `hold_key` keep
  only the chords that do more than type a character plus the count of the rest, titles only a hash, never images;
  invalid input keeps no arguments. Best effort.

## Screenshot budget

`Budget.pruneScreenshots` runs in the session `context`/`compaction` hooks over this plugin's named image parts
(`own-computer-use/cap_*.png|jpg`, `zoom_*`, direct and Code Mode results): with N screenshots the oldest
`floor((N - keep) / batch) * batch` become a short text. Defaults keep 8 / batch 7, so a request carries 8–14
screenshots and its prefix only changes every 7th screenshot (prompt cache). The (keep, batch) a session first pruned
with is stored under `history/<sessionID>` in plugin storage, so a later option change cannot reshuffle its prefix. A
request without our screenshots touches no storage.

Core replaces the oldest images of a request once its images pass 25 MiB of data URIs, which would move the cut with
every new screenshot and keep fewer than `keep`. So each screenshot and zoom is also held to an equal share of
`Budget.REQUEST_BYTES` (20 MiB) over the most a request carries after pruning, `keep + batch - 1` images
(`Budget.imageLimit`: about 1.43 MiB of base64 with the defaults; a larger PNG takes the JPEG steps). The 5 MiB left
below core's trigger are for the user's own images. The share is computed from the current options, not a session's
stored (keep, batch).

## Bundle boundary

A release bundle (`packages/own-remote/script/bundle.ts plugins`) carries its own `effect` copy. Verified by the
bundle e2e: the host runs this bundle's Effect values (plugin effect, tool executes, RPC handlers, hooks, forked
streams) fine, but it cannot run the **checks** of this bundle's Effect schemas (`Schema.Int` refuses 1). Therefore:

- tool inputs and outputs are registered as plain JSON Schema (`ToolSchema.jsonSchema` / `outputJsonSchema`); inputs
  are decoded inside the gate with this bundle's copy. Core requires a declared output schema for any result with
  `output` (`core/src/tool/runtime.ts:46`);
- the RPC definition goes through `Portable.definition` (own-protocol), like own-accounts and own-remote;
- `Tool.Error` from this bundle is not the host's class: core re-wraps it by message (metadata is lost), so the code
  lives in the message.

## In-process driver (`driver: "windows"`, default)

Why: the unsigned helper exe can be refused by Smart App Control (it blocked one of nine fresh local builds on the
development PC, and that PC has it on), needs its own build and release artifact, and costs 125–270 ms per start.
In-process `bun:ffi` calls need no exe: Code Integrity checks images, and the service only loads Windows' own DLLs.
The worker starts and answers `hello` in about 20 ms; the 2026-10-01 measurements (and that day's Code Integrity
refusal of the prebuilt helper) are in [`README.md`](./README.md).

- **Threads**: synchronous FFI never runs on the service's event loop. One Bun worker thread (the **desktop worker**,
  `ffi/desktop.ts`) makes every desktop call: displays, capture, input, window list and focus, the stop chord and the
  desktop mutex. Thread affinity matters there: the Per-Monitor-V2 context is set per thread
  (`SetThreadDpiAwarenessContext(-4)`; `hello` reports what the thread got and the driver refuses anything but
  `per_monitor_v2`; the service's process-wide awareness is untouched), the mutex is owned by a thread, and
  `RegisterHotKey(NULL, …)` posts `WM_HOTKEY` to the registering thread's queue. A second worker (the **UI Automation
  worker**, `ffi/uia.ts`) answers only `focus.element`, so a hung UIA provider in another app never stalls input.
- **Protocol**: both workers answer the helper protocol (below) over `postMessage` instead of JSON lines; a capture
  carries its bytes (transferred, no base64). `WindowsDriver.over` maps the `Driver` onto either link, so held-input
  tracking and release are the same code for both drivers.
- **Channel** (`ffi/channel.ts`, the transport's twin): a worker starts on the first request and answers `hello` first;
  every request has a timeout (`helper.timeoutMs`, default 10 s, for the desktop worker; 3 s for UI Automation, like the
  helper's `focus.element`). A timeout, an uncaught error in the worker (Bun then ends it) or its end abandons the worker
  with `terminate()`, which returns at once even while the thread is stuck in a native call, fails every pending request,
  and (desktop worker only) emits `exited`, which engages the kill switch as before; the next request starts a fresh
  worker, with the transport's backoff after three failures. A UI Automation failure or timeout reads as "no focused
  element" (`undefined`): the gate then refuses text (`no_target`, fail closed) and computer use keeps running.
  `close`/`restart` send the worker its own `close` (release tracked input, unregister the chord, release the mutex) and
  terminate it after that answer or 1 s.
- **Single-file bundle**: the plugin ships as one minified file, so a worker cannot be a separate module. Each worker is
  one self-contained function (`main`) plus the pure helpers of `ffi/native.ts`, turned into text with
  `Function.prototype.toString` (`FfiChannel.script`) and started from a Blob URL. Rules that keep this valid after
  minification: `main` and the `native.ts` exports reference nothing else at module level (the minifier renames the
  `native.ts` declarations and `main`'s references to them consistently, so the text still links up), `native.ts`
  exports only functions, and `bun:ffi` is imported inside `main` through a computed specifier. The e2e bundle check
  proves it on Windows: the built bundle starts the worker and answers `hello`, `cursor.get` and `displays`. The Blob
  URL is revoked on the worker's first message; Bun fires `open` before it fetches the module.
- **Capture**: `BitBlt(SRCCOPY | CAPTUREBLT)` from the screen DC into a top-down 24 bpp DIB section, wrapped in place
  by GDI+ (`GdipCreateBitmapFromScan0`), resized like the helper (SourceCopy, HighQualityBicubic, high-quality pixel
  offsets, TileFlipXY image attributes) with `GdipDrawImageRectRectI`, and encoded with the built-in PNG and JPEG
  encoders (`GdipSaveImageToStream` into `CreateStreamOnHGlobal`; JPEG quality as `EncoderParameters`). The length
  comes from `IStream::Seek(0, STREAM_SEEK_END)` through the stream's vtable. 24 bpp sources give RGB PNGs, like the
  helper's. GDI+ starts on the first capture and shuts down on `close`.
- **Windows**: z-order from `GetTopWindow(NULL)` and `GetWindow(GW_HWNDNEXT)` (no callback; capped at 10 000 steps
  against a reordering list). `JSCallback`s only where Windows insists on one (`EnumDisplayMonitors`,
  `EnumChildWindows` for UWP frames), created on the worker thread and closed right after the call. UWP frames,
  `TokenElevation` (unreadable → elevated), `DWMWA_CLOAKED`, DWM frame bounds and this process's own windows (never
  reported) follow the helper.
- **Stop chord and events**: the chord is registered when the worker owns the desktop mutex (else every op but `hello`
  is `busy`); the thread's queue is drained with `PeekMessageW(PM_REMOVE)` every 50 ms and before each request (no
  blocking `GetMessage` loop). `WM_HOTKEY` releases the worker's tracked input, then emits `kill_chord`. A later
  `hello` retries the mutex and the chord. Display changes: a layout signature (bounds, scale, primary) checked every
  second and on `displays`/`capture` emits `display_changed`.
- **UI Automation through COM**: `CoInitializeEx(MTA)`, `CoCreateInstance(CUIAutomation, IUIAutomation)`, then vtable
  calls through `CFunction` (one compiled call per function pointer): `GetFocusedElement` (8),
  `get_CurrentProcessId` (20), `get_CurrentControlType` (21, mapped to the helper's names such as `Edit`),
  `get_CurrentIsPassword` (35), `Release`. The real-desktop suite checks the indexes against a plain and a password
  TextBox.
- **Differences from the helper**: the on-screen indicator (`indicator`) is accepted and does nothing (the gate does not
  drive it yet); the chord is noticed between requests (within about 50 ms, or after the current request ends) instead
  of on a separate UI thread at once; the window list walks `GetWindow` rather than `EnumWindows` (it may also list
  immersive shell windows, which are cloaked and filtered by `Policy.visible`); a UI Automation failure is "no focus"
  instead of a `failed` error, and a UIA timeout no longer engages the kill switch. A desktop worker stuck in a native
  call cannot be killed like a process: it is abandoned, keeps the mutex and the chord until the call returns (the next
  worker reports `busy` and no stop chord, so input is refused), and a natural exit of the service waits for that call
  (`process.exit` does not).

## Helper wire protocol

The contract is `own/native/own-cu-helper/README.md` (ops, fields, errors and Windows behaviour, in Korean like
own-vault's); `src/driver/windows/protocol.ts` mirrors it, and the in-process workers answer the same ops (above). In
short, the helper's framing follows own-vault (README §5):

- One UTF-8 JSON object per line each way. Requests `{op, rid, …args}`; responses `{ok: true, rid, …}` or
  `{ok: false, rid, error, message?}` in request order; unsolicited event lines `{event}` without `rid`.
- Lines up to 16 MiB (a capture is at most 4.5 MB of base64); a longer line kills the helper.
- `hello` first: `{name: "own-cu-helper" (the desktop worker: "own-cu-ffi"), version, protocol: 1, dpiAwareness:
  "per_monitor_v2", interactive, inputDesktop, pid?, killChord?}`. Another protocol or DPI awareness is refused
  (coordinates would be scaled). A later
  `hello` takes a free desktop mutex and retries the stop chord; the gate sends one before every input action and
  refuses input while `killChord` is not true (a missing field counts as false).
- Errors: `bad_request`, `unknown_op` (→ protocol), `busy` (another driver holds `Local\own-open-code-computer-use`),
  `desktop_unavailable` (lock screen, UAC, Ctrl+Alt+Del, or a minimized remote-desktop client window: the session
  stays active but `GetCursorPos` and screen reads are denied), `unknown_window`, `failed`.
- Environment: only `SystemRoot` and `windir`; `windowsHide`; stdin EOF means release held input and exit.

| Driver                                | Helper op (args → result)                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `hello`                               | `hello` → hello fields                                                                                          |
| `displays`                            | `displays` → `{displays: Display[]}` (ids 0..n-1, physical bounds)                                              |
| `capture`                             | `capture {display, region?, width, height, format, quality?}` → `{mime, data (base64 / bytes), width, height, cursor?}` |
| `cursor` / `move`                     | `cursor.get` → `{x, y}` / `mouse.move {x, y}`                                                                   |
| `button` / `wheel`                    | `mouse.button {button, action}` / `mouse.wheel {dx, dy}` (notches; +dy up, +dx right)                           |
| `key` / `text`                        | `key {vk, extended, action}` / `text {text}` (SendInput, `KEYEVENTF_UNICODE` for text)                          |
| `windowAt` / `foreground` / `windows` | `window.at {x, y}` / `window.foreground` → `{window: WindowInfo \| null}`; `windows.list` → `{windows}`         |
| `focus` / `focused`                   | `window.focus {id}` / `focus.element` → `{focus: FocusInfo \| null}` (UIA `IsPassword`; in-process: the UI Automation worker) |
| `releaseAll` / `indicator`            | `release.all` / `indicator {on, text?}` (only sent to a running helper or worker; the worker ignores it)        |
| `events`                              | `{event: "kill_chord"}`, `{event: "display_changed"}`; an unexpected exit → `exited`                            |

With `driver: "helper"` the exe is `helper.command` (tests), `helper.exePath`, the installed version's
`app\<version>\own-cu-helper.exe` (own-runtime `Home.layout`), or in a source run
`own/native/own-cu-helper/target/own-cu-helper.exe`. It starts on the first request only; a timeout (default 10 s)
kills it, and three failed starts in a row back off up to 30 s.

## Residual risks (not provable by unit tests)

- `driver: "helper"` in a release built without `own/native/own-cu-helper` (build-desktop.ps1 step 3c skipped) fails
  every action with `driver_unavailable`. The default in-process driver needs no extra file.
- Foreground `SendInput` moves the real cursor and competes with the user; there is no takeover detection yet, and the
  on-screen indicator is not driven yet.
- File Explorer's address bar can launch programs from typed text; explorer windows are not denied, so the consent
  dialog says so. The Run dialog is blocked by chord (`super+r`, `super+x`) and denied as a window (explorer
  `#32770`), and Start and its search box (StartMenuExperienceHost, SearchHost; SearchApp or SearchUI on Windows 10)
  are on the built-in deny list. Other apps that run commands are not denied unless listed in `policy.denyApps`.
- The keyboard re-check runs after a settle pause, not under a lock: a window that comes to the front later than
  `settleMs` after a step (a slow app launch, a delayed popup) can still receive the rest of that call.
- The password rule covers the keyboard only: pasting into a password field through a context menu or by drag and
  drop is not detected. The focused element's pid is not compared with the foreground window's (UWP apps run inside
  ApplicationFrameHost).
- UWP apps: the driver names a frame (`ApplicationFrameHost.exe`) by the process of its first child window owned by
  another process (the app's CoreWindow). A suspended or minimized UWP app has no such child (Windows detaches the
  CoreWindow), so its frame reports no exe and is denied, `focus_window` included; the user restores it by hand.
  `applicationframehost` itself is on the built-in deny list, so an allow entry or a grant never covers every UWP app.
- Apps are denied by exe name, window class and own-web's title. Other ways to run commands (a browser's devtools
  console, an editor's run menu) are not detected; `policy.denyApps` can add those apps.
- Agents defined in the config or as markdown files get `{computer, *, deny}` only from the registration made after
  `plugin.updated` (verified by the e2e). Between a Location's plugin activation and that registration, and if the
  event is lost (the event stream fails a consumer that falls far behind and is not resubscribed), they can list the
  tools; the gate still refuses every call with `not_enabled` until the session switch is on.
- The team-turn check reads the session's (or the root's) messages since the latest compaction on every computer
  call, as core does once per step; screenshots stay in those messages as base64, so long computer-use sessions pay
  that read once more per call (a Code Mode script with several computer calls pays it per call).
- A turn whose start lies more than 25 pages (500 messages) before the latest compaction is refused (`team_turn`);
  the user's next message starts a readable turn.
- The unseen-window check knows apps by exe name: a new window of an app that already had a window on screen (a
  second browser window, a dialog of the same program) is not caught, and a window that only moved in front is
  not either.
- A subagent is judged by its root's latest turn, not by the turn that started it: a background subagent spawned in
  a team turn passes again once the user starts a turn of their own in the root. Its own messages are not read
  (own.team prompts root sessions only, 06 §5.1).
- A desktop worker abandoned or a helper killed after a timeout cannot release what it pressed itself; the driver's
  explicit ups through the next one are best effort (they fail while the desktop takes no input and are retried by the
  next `releaseAll`).
- Korean IME: `key` with letters goes through the IME (text uses KEYEVENTF_UNICODE and does not).
- A desktop worker or helper timeout engages the kill switch (conservative: input may be half done). With the helper a
  hung UI Automation call is such a timeout and needs a manual reset; the in-process driver keeps UI Automation apart.
- In-process driver: a desktop worker stuck inside a native call keeps its thread, the mutex and the stop chord until
  the call returns (see "Differences from the helper"); the service process itself is what Code Integrity and
  antivirus see.
- The real-desktop suite covers one monitor layout per run; mixed-DPI and negative-origin monitors, the secure desktop,
  elevated windows, UWP/Chromium/Electron targets and a Korean IME in other apps still need manual checks.
- A remote-desktop session whose client window is minimized takes no input and cannot be captured; every action then
  fails with `[computer.desktop_unavailable]` until the window is restored.
- Smart App Control (or another application control policy) can refuse the unsigned helper (`driver: "helper"`): Code
  Integrity blocked one of nine fresh local builds on the development PC. The start then fails with
  `driver_unavailable` and a hint in the message; the in-process default has no such file.

## Tests

How to run each suite, and what the unit tests cannot prove: [`README.md`](./README.md). In short, from this directory
(never the repo root): `bun run typecheck`, `bun test test/unit` (schemas and JSON Schema, geometry, keys, policy,
frames, budget, lease/kill switch, audit, options, fake driver, actions, the helper transport and driver against the
fake helper, the in-process driver's native helpers, worker sources, channel and driver against in-process fake
workers, the gate through the registered tools including subagent models and team turns over fake sessions and
messages, the moving deny transform, RPC handlers, prune hooks, the singleton) and `bun test test/e2e` (server boot
from source and from the built bundle with the fake desktop, a config-defined agent carrying the deny, and on Windows
the bundle with the in-process driver answering `hello`, `cursor.get` and `displays`; about 30 s).

`OWN_CU_REAL=1 bun test test/real` is the opt-in real-desktop suite, run once per Windows driver: the in-process driver
always, the helper when a prebuilt exe is there and starts (it never builds one). It starts a topmost fixture window
(`fixture/fixture.ps1`, a WinForms script run by the system `powershell.exe`: TextBox, password TextBox, Button,
scrollable Panel on known colours) that reports what it receives on stdout, and checks hello and displays,
`windows.list`/`window.at`, a screenshot's colours at frame-mapped points, capture latency, clicks through screenshot
coordinates (within 2 physical px), the focused element (UI Automation, including `IsPassword`), ASCII + Hangul + emoji
typing, ctrl+a / BackSpace, wheel notches, and the gate typing into the fixture, refusing its password field and
refusing it once it is deny-listed. The fixture runs in `powershell.exe`, a terminal on the built-in deny list, so the
gate test lifts terminals with an exclusive allow list of `powershell` and checks the fixture's window handle before
every click and typing step. Input only goes to the fixture; the cursor is restored and the fixture and driver are
closed afterwards. It prints its measurements per driver (start, `hello`, captures, focus queries, click latency).
