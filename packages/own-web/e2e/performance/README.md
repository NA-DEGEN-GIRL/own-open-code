# own-web performance harness (PF gates)

Release gate for the own-web budgets of 01 §6.6 (numbers) and 03 §20.1 (how own-web measures them), in the
installed Microsoft Edge against the **production bundle**. The P3 scope of 01 §16.3 is covered: PF2–PF5 and PF7,
plus the web variant of PF1. PF1 (desktop), PF6 and PF8 need the packaged shell (P4) and are listed as not measured.

## Run

From `packages/own-web`:

```powershell
bun e2e/performance/run.ts            # build → PF5 → every bench ×3 → perf.json; exit 1 when a measured gate fails
bun e2e/performance/run.ts --gate     # release gate: ×20, no retries; pending (unmeasurable) PFs fail as well
bun test e2e/performance              # unit tests of the harness math (percentiles, trace frames, budgets, IME steps)
```

| Option           | Meaning                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `--repeat <n>`   | `--repeat-each` for every bench (default 3, `--gate` 20)                                                                        |
| `--grep <regex>` | only matching benches (e.g. `--grep PF7`)                                                                                       |
| `--out <dir>`    | result directory (default `%TEMP%\own-web-perf\<run id>`); `--out ../../own/release/<version>` writes the release file in place |
| `--no-build`     | reuse `dist/`                                                                                                                   |
| `--headed`       | show the browser window (default headless)                                                                                      |
| `--version <v>`  | version recorded in perf.json (default `<package version>+<git head>[.dirty]`)                                                  |

Output in `--out`: `perf.json` (summary, the shape of `own/release/<version>/perf.json`), `records.jsonl` (every
`BENCHMARK` record with raw samples and its wall-clock span), `load.jsonl` (machine CPU busy share every second),
`dist/` (the snapshot of the bundle that was measured), `test-results/`. A single bench can run directly (fixture
backend included):

```powershell
bunx playwright test --config e2e/performance/playwright.config.ts session-switch --repeat-each=5
```

`OWN_PERF_REUSE_BACKEND=1` reuses a backend you started with `bun e2e/performance/backend.ts` (keep its stdin open;
type `stop` to shut it down and remove its temp directories).
`OPENCODE_PERFORMANCE_TRACE_DIR=<dir>` keeps Chrome traces (upstream behavior for page-scoped traces; the frame
benches save their own frame trace there too, one file per repetition).

## Fixture (`backend.ts`)

The real upstream server boots from source with own.accounts + own.telemetry (packages/own-accounts/test/e2e-kit),
auto compaction off (config `compaction.auto: false`, the bench measures rendering), an API-key account created
through RPC, and a paced fake OpenAI Responses provider (`fixture/stream-provider.ts`). Sessions are imported with
`POST /api/experimental/session/import` (≈1 s for all):

| Session    | Content                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A, B       | 2,000 messages each (1,000 turns); 40% of messages carry 1–3 tool cards (read/grep/bash/edit), 20% of answers have reasoning, every 3rd a table, every 4th a code block |
| S          | same shape; receives the streamed answer (4,000 deltas at 200/s by default (20 s))                                                                                      |
| 40 fillers | short sessions so the sidebar list is realistic                                                                                                                         |

Every message carries a plain-text marker `OWNB-<tag>-<turn>-U|R`. Probes find content by marker text inside
`[data-testid="transcript"]`, so they do not depend on the transcript's DOM structure. `vite preview` serves the bundle
on 5196 with the dev proxy (server-side Basic auth): run.ts copies `dist/` into `--out` first so another process
rebuilding `dist/` cannot swap files mid-run (`OWN_PERF_DIST`; direct Playwright runs serve `dist/`). Fake credentials
only; temp directories are removed after the run.

## Benchmarks and what they gate

| File                                      | PF        | Measures                                                                                                                                                                                                        | Gate (p95 over all repetitions; median recorded)                                                                           |
| ----------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `session-list.bench.ts`                   | PF1 (web) | navigationStart → `own:sessions-visible` on a warm reload (IndexedDB list), cold load, `own:sessions-fresh`                                                                                                     | warm ≤ 1,000 ms; fresh ≤ 2,000 ms and cold tracked                                                                         |
| `composer-input.bench.ts`                 | PF2       | Korean IME typing through CDP (`rawKeyDown` 229 → `Input.imeSetComposition` / `Input.insertText`), 200 keystrokes at 35 ms, in the 2,000-message session; every keydown/beforeinput/composition\*/input counted | processing (`processingEnd − startTime`) ≤ 16 ms; event → paint ≤ 33 ms (Event Timing; unreported events count as < 16 ms) |
| `timeline-scroll.bench.ts`                | PF3       | pages the whole history in, then wheel flings (`Input.synthesizeScrollGesture`, 4,000 px/s, 10 s) with a CDP frame trace, rAF and long-task probes                                                              | presented frame interval ≤ 16.7 ms (01); rAF intervals > 2F ≤ 1% (03, F = 16.7 ms); long tasks > 50 ms = 0                 |
| `streaming.bench.ts`                      | PF4       | 200 deltas/s into session S; phase A: IME typing while following; phase B: wheel up + typing, then the viewport must not move for 1.5 s                                                                         | PF2 and PF3 gates while streaming; anchor released; jump ≤ 1 px                                                            |
| (run.ts → `script/bundle-size.ts --json`) | PF5       | initial JS/CSS gzip, desktop code in the first chunk                                                                                                                                                            | JS ≤ 400 KB, no desktop code; CSS ≤ 60 KB tracked                                                                          |
| `session-switch.bench.ts`                 | PF7       | sidebar row mousedown → first frame with the destination's last answer visible and no source content (upstream `firstCorrectObservedMs`)                                                                        | warm (cached) ≤ 100 ms; cold entry < 500 ms tracked; stable (3 frames) tracked                                             |
| `harness-selftest.bench.ts`               | —         | every probe against a synthetic windowed list of 2,000 rows                                                                                                                                                     | recorded as `harness.selfTest`                                                                                             |

A bench whose module does not render the fixture (no marker visible within 30 s, e.g. a skeleton transcript) is
**skipped with a reason** and its PF is `pending` in perf.json: the default run reports it, `--gate` fails on it.

### Measurement notes

- Input: a window listener registered after the app runs last in dispatch, so `performance.now() − event.timeStamp`
  covers every app handler; Event Timing (`durationThreshold: 16`) supplies event → paint and overrides processing
  when it reported the event. Units (composition events + input of one keystroke) are recorded as a tracked metric.
- Frames: `PipelineReporter` events (`disabled-by-default-devtools.timeline.frame`) of the page's renderer, merged
  per BeginFrame sequence, between the probe's `ownb:measure:*` marks.
- Long-frame ratio: 03's "rAF interval > 2F" with **F fixed at 01 §6.6's 16.7 ms** (threshold 33.4 ms, a missed
  frame at 60 fps). It used to be the idle rAF interval (this PC's display runs at 240 Hz, F ≈ 4.17 ms), but Chromium
  moves its frame clock between 240 and 120 Hz, and every 120 Hz frame (8.33 ms, right at 2 × 4.17) then counted as
  long. The refresh is still observed and recorded: `raf.refresh` per run (idle rate before the run, active = median
  rAF interval during it), `environment.display` in perf.json (Windows display mode + per-bench rates). Diagnostics
  kept next to the gate: `raf.overBudget` (intervals > 16.7 ms; on 60/120 Hz clocks this sits on a vsync multiple)
  and `raf.displayNormalized` (the old > 2 × idle-F count).
- Presented-frame intervals only count while the page keeps asking for frames: a frame with nothing to update ends
  the run (idle is not jank), a dropped frame extends it. F for PF4 is measured before the stream starts.
- PF4 phase B must start while deltas still arrive (the bench fails otherwise; raise `OWN_PERF_STREAM_DELTAS`), and
  `stream.timeline` in the record shows each phase boundary in ms after the prompt.
- The gate runs serially, without retries; any failed repetition fails its checks.
- Machine load: run.ts samples the whole machine's CPU busy share every second (`os.cpus()` deltas). The first
  `OWN_PERF_BASELINE_SECONDS` (5) run before the backend starts, so they are other applications' load
  (`environment.load.baseline`); `benchmarks[].cpuBusy` is the load while each bench ran (its own Edge, server and
  preview included). A baseline mean ≥ 25 % marks the run `busy` and the summary says so: PF1–PF4 and PF7 are then
  pessimistic, and a release run belongs on an idle machine. No process names are recorded.

### Environment

| Variable                                                                       | Default                                                              | Meaning                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| `OWN_PERF_TURNS`                                                               | 1000                                                                 | exchanges per long session (messages = 2 × turns) |
| `OWN_PERF_FILLER_SESSIONS`                                                     | 40                                                                   | short sessions in the list                        |
| `OWN_PERF_KEYSTROKES` / `OWN_PERF_KEY_PACE_MS`                                 | 200 / 35                                                             | PF2 workload                                      |
| `OWN_PERF_SCROLL_SPEED` / `OWN_PERF_SCROLL_SECONDS`                            | 4000 / 10                                                            | PF3 fling                                         |
| `OWN_PERF_HISTORY_TIMEOUT_MS`                                                  | 240000                                                               | PF3 history paging limit                          |
| `OWN_PERF_STREAM_DELTAS` / `OWN_PERF_STREAM_RATE` / `OWN_PERF_STREAM_PHASE_MS` | 4000 / 200 / 5000                                                    | PF4 stream and phase length                       |
| `OWN_PERF_COMPOSER`                                                            | skeleton id + textarea/contenteditable in `[data-testid="composer"]` | composer selector                                 |
| `OWN_PERF_PREVIEW_PORT`                                                        | 5196                                                                 | preview port                                      |
| `OWN_PERF_HEADED`                                                              | –                                                                    | `1` = headed (same as `--headed`)                 |
| `OWN_PERF_BASELINE_SECONDS`                                                    | 5                                                                    | machine-load baseline before the backend starts   |
| `OWN_PERF_PROFILE`                                                             | –                                                                    | `tasks` / `1`: profile trace (see Profiling)      |

## Profiling a failed frame gate

The gate numbers come from runs without profiling. To find what made PF3/PF4 frames or tasks long, rerun the bench
with a profile trace (it costs main-thread time, so its numbers are not gate numbers):

```powershell
$env:OWN_PERF_PROFILE = "tasks"   # or "1" for the DevTools categories + CPU samples
$env:OPENCODE_PERFORMANCE_TRACE_DIR = "$env:TEMP\own-web-perf-traces"
bun e2e/performance/run.ts --no-build --grep PF3 --repeat 10
bun e2e/performance/trace-tasks.ts "$env:TEMP\own-web-perf-traces\<run>-PF3-timeline-scroll-r0-frames.json" --min 30
```

- `tasks` records task wall and thread time (`toplevel`) and GC phases (`disabled-by-default-v8.gc`). Each frame
  record then carries `traceTasks`: every main-thread task over 50 ms with `kind` = `gc` (collector ≥ half the wall
  time), `descheduled` (on a CPU < half the wall time: the machine was busy) or `work` (the page's script, style,
  layout, paint). `longTaskStartsMs` (Long Tasks API, ms after the measurement start) lines up with `atMs`.
- `1` adds the DevTools performance-panel categories; `trace-tasks.ts` then also breaks each long task and the whole
  window down by self time (FunctionCall with bundle location, UpdateLayoutTree, Layout, Layerize, GC …) and CPU
  samples. Bundle locations resolve through `dist/_assets/*.js.map` (the snapshot in `--out` drops maps; `dist/` has
  them while nobody rebuilt it).
- The Long Tasks API does not report GC-only tasks: a major GC shows up as a rAF gap and in `traceTasks`, not in
  `longTasks`. PF3 records `jsHeapMB` before and after the fling.

## Vendored

`benchmark.ts` and `chrome-trace.ts` are copied from `packages/app/e2e/performance` @ `00d179015f` (MIT, 01 §6.6
"측정 인프라"). Local changes in `benchmark.ts` are marked `OWN`: records are appended to `$OWN_PERF_RESULTS`, a skipped
bench emits a record with its reason, records carry their wall-clock span (`timing`), and the console line abbreviates
raw sample arrays.
