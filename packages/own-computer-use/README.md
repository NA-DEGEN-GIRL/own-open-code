# @own/computer-use

Windows computer use for own-open-code: the plugin `own.computer-use` gives the agent `computer.*` tools (screenshot,
click, type, key, scroll, …) that drive the real desktop. By default it calls Win32 itself through `bun:ffi` on two
worker threads inside the service (`driver: "windows"`); our own helper exe, `own/native/own-cu-helper`, remains an
opt-in fallback (`driver: "helper"`). Tools are hidden in every session until the user turns computer use on for that
session (own-web: session header `⋯` > "이 세션에서 컴퓨터 사용"), and every call goes through a gate (consent, kill
switch, app policy, lease, audit).

- Design and decisions: `own/docs/01-architecture.md` §10.2. UI: `own/docs/03-ui-ux.md` §5.7.2.
- Structure, coordinates, safety order, the in-process driver and the bundle boundary: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- The protocol both drivers speak, and the helper's measurements: [`own/native/own-cu-helper/README.md`](../../own/native/own-cu-helper/README.md).

## Drivers

| `driver` | Engine | Needs |
| --- | --- | --- |
| `windows` (default) | In-process: a desktop worker thread (displays, capture, input, windows, stop chord) and a UI Automation worker thread, both calling Windows DLLs through `bun:ffi` | nothing beyond Windows 10/11 and the service's Bun |
| `helper` | `own-cu-helper.exe`, a C# child process speaking JSON lines | the exe (below); Smart App Control may refuse it |
| `fake` | An in-memory desktop for tests | — |

Why the in-process driver is the default: on a PC with Smart App Control on, Code Integrity refuses unsigned, locally
built exes (events 3077/3033 in CodeIntegrity/Operational). It refused the helper again on 2026-10-01 when the
real-desktop suite tried to start it. The helper also costs a separate build and release artifact and 125–270 ms per
start; the desktop worker starts in about 20 ms.

### Build the helper (only for `driver: "helper"`)

The helper is C# 5 compiled by the .NET Framework compiler that ships with Windows (`csc.exe` 4.8). There is no SDK to
install and no third-party code.

```powershell
# from the repository root
powershell -NoProfile -ExecutionPolicy Bypass -File own/native/own-cu-helper/build.ps1
# -> own/native/own-cu-helper/target/own-cu-helper.exe (git-ignored)
powershell -NoProfile -ExecutionPolicy Bypass -File own/native/own-cu-helper/build.ps1 -OutDir <folder>
```

- A source run of the plugin finds `target/own-cu-helper.exe` on its own; an installed version uses
  `app\<version>\own-cu-helper.exe`, copied by `own/scripts/build-desktop.ps1` step 3c. `helper.exePath` and
  `helper.command` in the plugin options override both.
- Calling `csc` from Git Bash mangles its `/options`; run `build.ps1` from PowerShell (or set `MSYS_NO_PATHCONV=1`).
- Builds are unsigned and not deterministic. On a PC with Smart App Control on, Code Integrity may refuse a build; the
  plugin then reports `[computer.driver_unavailable]` with a hint. Do not change security settings to get around it;
  use the default driver.

## Run the tests

Always from this directory, never from the repository root.

| Command | What it covers | Needs |
| --- | --- | --- |
| `bun run typecheck` | `bun check` (TypeScript 7) over `server.ts`, `src`, `test` | — |
| `bun test test/unit` | input schemas and JSON Schema, geometry, keys, policy, frames, screenshot pruning, lease and kill switch, audit, options, the fake driver, composite actions, the helper transport and driver against `test/fixtures/fake-helper.ts`, the in-process driver (native struct helpers, worker sources, the worker channel's timeouts, crashes, backoff and close, the driver over `test/fixtures/fake-worker.ts`), the gate through the registered tools, RPC handlers, prune hooks, the singleton | nothing (no desktop, no helper) |
| `bun test test/e2e` | boots the real server from source with own-accounts and `driver: "fake"`, then again with the release bundle built by `packages/own-remote/script/bundle.ts`: tools absent until the session is turned on, a screenshot reaches the next model request, the kill switch blocks calls. On Windows, the bundle once more with `driver: "windows"`: a `cursor_position` call starts the desktop worker from the bundled source, which answers `hello`, `cursor.get` and `displays` (read-only) | a checkout path without `#` (OpenTUI preload); about 30 s |
| `bun test` | both of the above; the real-desktop suite is skipped | as above |
| `OWN_CU_REAL=1 bun test test/real` | both Windows drivers on the real desktop (below) | an unlocked, interactive Windows desktop |

### The real-desktop suite (`OWN_CU_REAL=1`)

It runs once per Windows driver: the in-process driver always, the helper when `own/native/own-cu-helper/target/
own-cu-helper.exe` (or `OWN_CU_HELPER_EXE`) exists and starts. It never builds anything: the fixture is a WinForms
script, `test/real/fixture/fixture.ps1`, run by the system `powershell.exe` as a topmost window (TextBox, password
TextBox, Button, scrollable Panel on known colours) that reports what it receives on stdout. It checks:

- `hello`, `displays` against the fixture's own view of the screens, `windows.list` and `window.at` (exact bounds);
- screenshot colours at frame-mapped points (RGB PNG), capture latency (standard tier and native, PNG and JPEG 85);
- `window.focus`, clicks through screenshot coordinates (within 2 physical px), the focused element through UI
  Automation (`Edit`, and `IsPassword` on the password field), ASCII + Hangul + emoji typing (exact),
  `ctrl+a` / `BackSpace`, wheel notches, a button click;
- the gate typing into the fixture, refusing its password field (`[computer.password_field]`) and refusing the fixture
  with `[computer.app_denied]` once it is deny-listed.

Input only ever goes to the fixture: before each input step the suite checks that the window under the point (or the
foreground window and its focused process) is the fixture's window handle. The fixture runs in `powershell.exe`, which
the built-in policy denies as a terminal, so the gate test uses `allowTerminals` with the exclusive allow list
`["powershell"]` and the same handle checks before its click and typing steps. Afterwards it restores the cursor, closes
the fixture and the driver, and removes the temp folder. It prints `[own-cu-real] <driver> measurements`.

Before running it: unlock the desktop, keep a remote-desktop client window restored (a minimized one makes every input
test fail with a clear "desktop does not take input" message), and keep your hands off the mouse and keyboard for the
few seconds of input tests. `Ctrl+Alt+Shift+Q` stops it at any time.

#### 2026-10-01 run

Windows 11 Pro 26200, one 3840x2160 monitor at 150 %, an unlocked interactive desktop. In-process driver: 15 of 15 passed;
the cursor was restored exactly. Helper variant: skipped, because Code Integrity refused to start the prebuilt
`own-cu-helper.exe` (`EUNKNOWN` from `uv_spawn`, CodeIntegrity/Operational events 3077 and 3033 at 21:03:03; Smart App
Control is on). Medians of 5 runs unless noted; helper numbers are from its README §5.1 (an earlier session, other
screen content):

| What | In-process driver | Helper |
| --- | --- | --- |
| Start + first `hello` | 23 ms (first in the process), 16 ms after a restart | 125–270 ms restart, 0.8–1.3 s first run of a fresh build |
| `hello` round trip | 0.5 ms | < 1 ms |
| `windows.list` (29 windows) | 3.1 ms | 11–18 ms |
| Standard screenshot (`displays` + 1429x804 PNG, once) | 357 ms | 289–505 ms |
| `capture` 1429x804 PNG / JPEG 85 | 331 ms / 308 ms | 359 ms / 246 ms |
| `capture` 3840x2160 PNG / JPEG 85 | 240 ms / 128 ms | 243–370 ms / 180–238 ms |
| Click: action / press arriving in the fixture | 30–42 ms / 22–56 ms | 35–58 ms / 23–47 ms |
| Gate `left_click` until the press arrives | 54 ms | 34 ms |
| Focused element (UI Automation) | 180 ms first (worker start), then 19 ms | not measured |

Most of a downscaled capture is GDI+'s HighQualityBicubic resize (about 160–200 ms of a 4K frame, measured while
prototyping), the same filter the helper uses, so the downscaled sizes cost about the same in both engines; native
captures are faster in process. Typing's arrival time is not comparable with the helper's: the PowerShell fixture
reports every text change through a script block (374 ms for 35 characters here).

## Try it locally

In a development config the plugin is a directory entry after own-telemetry; `driver: "fake"` gives an in-memory
desktop (one 1920x1080 display with a Notepad window) instead of the real one:

```jsonc
{ "package": "<repo>/packages/own-computer-use", "options": { "home": "C:/Users/you/AppData/Local/own-open-code-dev", "driver": "fake" } }
```

The plugin only activates in a service started with `OWN_OPEN_CODE=1` (the own launcher); otherwise its `status` says
`unmanaged`. Turn it on for a session from own-web (session `⋯`), and watch it in 설정 > 실험 > 컴퓨터 사용.

## What the unit tests cannot prove

These need the real desktop (the opt-in suite covers some of them on one monitor layout) or manual checks:

- click accuracy at 100/125/150/175/200 % and on mixed-DPI or negative-origin multi-monitor layouts;
- captures of hardware-accelerated, HDR, DRM-protected (`WDA_EXCLUDEFROMCAPTURE`) and UWP/WinUI/Chromium/Electron
  windows; the lock screen, UAC and Ctrl+Alt+Del (expected: `desktop_unavailable`, not black images);
- `SendInput` behaviour per toolkit, against elevated windows (UIPI), and with a Korean IME active in the target app;
- the stop chord on a real keyboard (the in-process driver notices it between requests, within about 50 ms), and the
  on-screen indicator (not implemented in process; the gate does not drive it yet, and there is no user-takeover
  detection);
- display-change events on a real resolution or DPI change;
- hung UI Automation providers in real apps (the in-process driver gives up after 3 s and reads it as no focused
  element, so the gate refuses text; the helper's timeout engages the kill switch);
- a desktop worker stuck in a native call (abandoned; it keeps the desktop mutex and the stop chord until the call
  returns, so input is refused meanwhile);
- the service context: the workers inside the launcher's detached service in the interactive user session;
- the helper on this PC, which Smart App Control currently refuses (see the run above);
- model behaviour: how well Claude and GPT models act on 1568 px vs 2000 px screenshots through these function tools,
  and prompt-cache behaviour of batch pruning over a long run;
- `approval: "question"` against core's real question dock (only a fake question tool is tested).
