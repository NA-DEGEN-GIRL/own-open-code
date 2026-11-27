// Reproduces Codex Code Mode's `exec` and `wait` tools on the confined `@opencode/codemode` interpreter. Ports the
// cell lifecycle of codex-rs/code-mode-runtime (runtime/, cell_actor/, session_runtime/, service.rs) and the result
// formatting of codex-rs/core/src/tools/code_mode (mod.rs, output.rs, execute_handler.rs, wait_handler.rs).
// Ported from openai/codex (Apache-2.0) @ rust-v0.162.1; `exit()` ending the whole cell follows rust-v0.165.0 (#52748).
//
// Interpreter versus Codex's V8 isolate. Codex evaluates the source as an ES module in a fresh V8 isolate; here it is
// a script run by a JavaScript-subset interpreter (packages/codemode/interpreter-support.md). Programs that work in
// V8 but not here:
// - Private class fields, constructor functions (`new F()` of a plain function; classes construct), BigInt,
//   arbitrary Symbols, Proxy/Reflect, `Object.defineProperty`, `eval`/`Function`, Intl, ArrayBuffer/DataView and typed
//   arrays other than Uint8Array, Request/Response/Blob, `crypto.subtle`. Unsupported syntax fails the cell with a
//   `SyntaxError`/`TypeError` naming the construct.
// - `import`/`export` are parse errors (V8: `Unsupported import in exec: ...`). Top-level `return` is allowed here
//   (V8 rejects it in a module).
// - Errors have no `stack`; failure text is `Name: message` plus `at exec_main.mjs:LINE:COL` when the interpreter
//   knows the location (never for a user-thrown Error). Interpreter messages differ in wording from V8's.
// - `String(fn)` is `"[object Function]"` (V8: the source text), so `text(fn)` differs. Circular references throw
//   when created, not only when serialized. Promise reaction ordering matches V8 only at the observable level.
// - `console` exists and its output is discarded (Codex deletes `console`, so calling it is a ReferenceError there).
// - Thrown helper errors from the interpreter itself (e.g. `JSON.stringify` of a cycle inside `text()`) are TypeError
//   objects; V8 helpers throw the message as a plain string. Helper validation errors here are plain strings, as in
//   Codex.
// - The interpreter is far slower than V8's JIT (roughly 100k simple loop iterations per second, plus ~20-30 ms per
//   cell to load the prelude) and has no heap limit. Busy loops still yield, so yields and `terminate` work.
// - Codex's undocumented `as_settled`/`stream_settled` globals are not provided; the interpreter's own `search()`
//   global exists (it finds nothing, as no interpreter tools are registered).
export * as CodeModeRuntime from "./index.js"

import { CodeMode, Extension } from "@opencode/codemode"
import { Effect } from "effect"
import { Truncate } from "../truncate/index.js"
import { CodeModeMedia } from "./media.js"
import { CodeModePragma } from "./pragma.js"
import { CodeModePrelude } from "./prelude.js"

export { RespondToModelError } from "./pragma.js"

/** Codex's `code_mode.default_exec_yield_time_ms` default (core config), used when the pragma sets none. */
export const DEFAULT_EXEC_YIELD_TIME_MS = 30_000
export const DEFAULT_WAIT_YIELD_TIME_MS = 10_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const YIELD_GRACE_PERIOD_MS = 1_000
const MIN_YIELD_TIME_FOR_GRACE_MS = 10_000
// Node fires longer timeouts immediately.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export type ImageDetail = CodeModeMedia.ImageDetail
/** One output item; the host maps these to `input_text` / `input_image` / `input_audio`. */
export type ContentItem = CodeModeMedia.MediaItem

export interface ToolContext {
  readonly cellId: string
  /** Aborted when the cell completes, fails, or is terminated (Codex cancels the nested call's token). */
  readonly signal: AbortSignal
  /**
   * Aborted only when the cell is cut off: terminated (`wait` with `terminate`, a user interrupt, the session's end) or
   * ended by `exit()`. A nested call cut off this way ends what it started (own: an `exec_command` process still in its
   * first collection, whose id the program can never learn); a call left pending by a cell that completed keeps it.
   */
  readonly terminated: AbortSignal
  /**
   * Adds an item to the cell's output, as the program's `image(...)` would (own: the images a kept plugin tool returns
   * beside its structured output, which the program's value cannot carry).
   */
  readonly show: (item: ContentItem) => void
}

/** A nested tool callable as `tools.<name>(input)`. */
export interface NestedTool {
  /** The normalized JavaScript identifier, e.g. `exec_command` or `clock__curr_time`. */
  readonly name: string
  readonly description: string
  /** A function tool's JSON Schema (object input), or `"string"` for a freeform tool such as `apply_patch`. */
  readonly input: Readonly<Record<string, unknown>> | "string"
  /**
   * Runs the tool. The resolved value is what the program receives, after a JSON round trip (Codex's
   * `code_mode_result`); a rejection reaches the program as the error's message string.
   */
  readonly execute: (input: unknown, context: ToolContext) => Promise<unknown>
}

export interface SessionOptions {
  /** Default `exec` yield; Codex's config default is 30000 ms. */
  readonly defaultExecYieldTimeMs?: number
  /** Whether the model may receive `detail: "original"` images; otherwise they become `"high"`. Default true. */
  readonly supportsOriginalImageDetail?: boolean
  /** Token cost of an audio item for truncation; defaults to the PCM WAV duration estimate. */
  readonly estimateAudioTokenCount?: (audioUrl: string) => number
}

export interface ExecOptions {
  /** Token budget when the pragma sets no `max_output_tokens`. Default 10000. */
  readonly maxOutputTokens?: number
  /**
   * Receives each `notify(...)` text. Codex injects it immediately as an extra `custom_tool_call_output` for the
   * `exec` call; this runtime cannot reach the conversation, so the host must do that. Pending returned promises are
   * awaited before the cell reports completion, like Codex drains notifications.
   */
  readonly onNotify?: (text: string) => void | Promise<void>
}

/** The `wait` tool's arguments as Codex decodes them. */
export interface WaitArgs {
  readonly cell_id: string
  readonly yield_time_ms?: number
  readonly max_tokens?: number
  readonly terminate?: boolean
}

type CellEvent =
  | { readonly type: "yielded"; readonly items: ReadonlyArray<ContentItem> }
  | { readonly type: "completed"; readonly items: ReadonlyArray<ContentItem>; readonly errorText?: string }
  | { readonly type: "terminated"; readonly items: ReadonlyArray<ContentItem> }

/** Code Mode state of one session: stored values, live cells, and cell IDs (`"1"`, `"2"`, ...). */
export class Session {
  private readonly stored = new Map<string, string>()
  private readonly cells = new Map<string, Cell>()
  private nextCellId = 1

  constructor(private readonly options: SessionOptions = {}) {}

  /**
   * Runs `exec` input (raw JavaScript, optionally with a first-line `// @exec:` pragma). Resolves with the content
   * items of Codex's `custom_tool_call_output`. Rejects with `RespondToModelError` for input Codex refuses.
   */
  async exec(source: string, tools: ReadonlyArray<NestedTool>, options: ExecOptions = {}): Promise<ContentItem[]> {
    const started = performance.now()
    const parsed = CodeModePragma.parseExecSource(source)
    const id = String(this.nextCellId++)
    const cell = new Cell(id, {
      stored: new Map(this.stored),
      commit: (writes) => writes.forEach((value, key) => this.stored.set(key, value)),
      close: () => this.cells.delete(id),
      onNotify: options.onNotify,
    })
    this.cells.set(id, cell)
    const event = await cell.start(
      parsed.code,
      enabledTools(tools),
      yieldTimeout(parsed.yieldTimeMs ?? this.options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS),
    )
    return this.format(event, id, parsed.maxOutputTokens ?? options.maxOutputTokens, performance.now() - started)
  }

  /**
   * Runs the `wait` tool: new output since the last yield, the completion, or (with `terminate`) the termination.
   * Unknown cells report `Script failed` with `exec cell <id> not found`. Rejects with `RespondToModelError` while
   * another `wait` observes the cell or a termination is already in progress.
   */
  async wait(args: WaitArgs): Promise<ContentItem[]> {
    const started = performance.now()
    const cell = this.cells.get(args.cell_id)
    const event =
      cell === undefined || (!args.terminate && cell.terminating)
        ? missingCell(args.cell_id)
        : args.terminate
          ? await cell.terminate()
          : await cell.observe(yieldTimeout(args.yield_time_ms ?? DEFAULT_WAIT_YIELD_TIME_MS))
    return this.format(event, args.cell_id, args.max_tokens, performance.now() - started)
  }

  /**
   * Terminates every live cell and discards undelivered completions: for the session's end, and for a user interrupt of
   * its turn (Codex `interrupt_active_cells`, #51835, on by default since 0.163.0), which also ends the cells an earlier
   * `exec` left running after a yield. Nested calls are cut off with their cells; stored values stay.
   */
  async terminateAll() {
    await Promise.all([...this.cells.values()].filter((cell) => !cell.terminating).map((cell) => cell.terminate()))
  }

  /** `handle_runtime_response` and `CodeModeToolOutput::new`: status header first, then the truncated items. */
  private format(event: CellEvent, cellId: string, maxTokens: number | undefined, wallMs: number): ContentItem[] {
    const failure =
      event.type === "completed" && event.errorText !== undefined
        ? [{ type: "text" as const, text: `Script error:\n${event.errorText}` }]
        : []
    const items = truncate(
      [...event.items.map((item) => this.sanitize(item)), ...failure],
      maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      this.options.estimateAudioTokenCount ?? CodeModeMedia.estimateAudioTokenCount,
    )
    const seconds = (Math.round(wallMs / 100) / 10).toFixed(1)
    return [{ type: "text", text: `${status(event, cellId)}\nWall time ${seconds} seconds\nOutput:\n` }, ...items]
  }

  /** `sanitize_original_image_detail`. */
  private sanitize(item: ContentItem): ContentItem {
    if (this.options.supportsOriginalImageDetail ?? true) return item
    if (item.type !== "image" || item.detail !== "original") return item
    return { ...item, detail: CodeModeMedia.DEFAULT_IMAGE_DETAIL }
  }
}

function status(event: CellEvent, cellId: string) {
  if (event.type === "yielded") return `Script running with cell ID ${cellId}`
  if (event.type === "terminated") return "Script terminated"
  return event.errorText === undefined ? "Script completed" : "Script failed"
}

function missingCell(cellId: string): CellEvent {
  return { type: "completed", items: [], errorText: `exec cell ${cellId} not found` }
}

/** `resolve_yield_timeout`: yields of 10 s or more get a one-second grace period. */
function yieldTimeout(yieldTimeMs: number) {
  return yieldTimeMs >= MIN_YIELD_TIME_FOR_GRACE_MS ? yieldTimeMs + YIELD_GRACE_PERIOD_MS : yieldTimeMs
}

/** Codex sorts the enabled tools by name and keeps the first of each name. */
function enabledTools(tools: ReadonlyArray<NestedTool>) {
  const sorted = [...tools].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return sorted.filter((tool, index) => index === 0 || sorted[index - 1]!.name !== tool.name)
}

/** `truncate_code_mode_result`: text-only output is joined and truncated as one; mixed output item by item. */
function truncate(
  items: ReadonlyArray<ContentItem>,
  maxTokens: number,
  estimateAudioTokenCount: (audioUrl: string) => number,
): ContentItem[] {
  const policy: Truncate.TruncationPolicy = { mode: "tokens", limit: maxTokens }
  const converted = items.map(toTruncateItem)
  const truncated = converted.every((item) => item.type === "input_text")
    ? Truncate.formattedTruncateTextContentItemsWithPolicy(converted, policy)[0]
    : Truncate.truncateFunctionOutputItemsWithPolicy(converted, policy, estimateAudioTokenCount)
  // Codex's items carry no file name; an image a kept plugin tool showed gets its own back (`MediaItem.name`).
  const names = new Map(
    items.flatMap((item) => (item.type === "image" && item.name !== undefined ? [[item.image_url, item.name]] : [])),
  )
  return truncated
    .flatMap(fromTruncateItem)
    .map((item) =>
      item.type === "image" && names.has(item.image_url) ? { ...item, name: names.get(item.image_url) } : item,
    )
}

function toTruncateItem(item: ContentItem): Truncate.ContentItem {
  if (item.type === "text") return { type: "input_text", text: item.text }
  if (item.type === "audio") return { type: "input_audio", audio_url: item.audio_url }
  return {
    type: "input_image",
    image_url: item.image_url,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
  }
}

function fromTruncateItem(item: Truncate.ContentItem): ContentItem[] {
  if (item.type === "input_text") return [{ type: "text", text: item.text }]
  if (item.type === "input_audio") return [{ type: "audio", audio_url: item.audio_url }]
  if (item.type === "input_image" && item.image_url !== undefined) {
    const detail = item.detail as ImageDetail | undefined
    return [{ type: "image", image_url: item.image_url, ...(detail === undefined ? {} : { detail }) }]
  }
  return []
}

interface CellHost {
  /** The session's stored values when the cell started; the cell's own `store` calls update it. */
  readonly stored: Map<string, string>
  /** Publishes the cell's `store` writes to the session; called only when the cell completes or fails. */
  readonly commit: (writes: ReadonlyMap<string, string>) => void
  /** Removes the cell from the session once its terminal event was delivered. */
  readonly close: () => void
  readonly onNotify: ExecOptions["onNotify"]
}

interface Observer {
  readonly resolve: (event: CellEvent) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface Timer {
  readonly handle: ReturnType<typeof setTimeout>
  readonly fired: Promise<boolean>
  readonly resolve: (fired: boolean) => void
}

/**
 * One `exec` cell: the program runs in the background; output accumulates until an observer (the `exec` call itself,
 * then each `wait`) takes it at a yield, completion, or termination.
 */
class Cell {
  private items: ContentItem[] = []
  private observer: Observer | undefined
  private phase: "running" | "terminating" | "completed" = "running"
  /** A completion that arrived while nobody observed; the next `wait` (or terminate) receives it. */
  private completion: CellEvent | undefined
  private readonly abort = new AbortController()
  /** Aborted with `abort` when the cell is cut off rather than finished (`ToolContext.terminated`). */
  private readonly cut = new AbortController()
  private readonly timers = new Map<number, Timer>()
  private nextTimerId = 1
  private readonly notifications: Array<Promise<unknown>> = []
  private readonly writes = new Map<string, string>()
  /** Set by `exit()`: from then on no host function has an effect. */
  private exited = false
  /** Set when a timer callback threw or `exit()` was called: the cell ends with this outcome. */
  private forced: { readonly errorText: string | undefined } | undefined
  private run: Promise<CodeMode.Result | undefined> = Promise.resolve(undefined)

  constructor(
    readonly id: string,
    private readonly host: CellHost,
  ) {}

  get terminating() {
    return this.phase === "terminating"
  }

  /** Attaches the `exec` call as the first observer, then starts the program. */
  start(code: string, tools: ReadonlyArray<NestedTool>, yieldMs: number) {
    const event = this.observe(yieldMs)
    const runtime = CodeMode.make({ extensions: [this.extension(tools)] })
    this.run = Effect.runPromise(runtime.execute(CodeModePrelude.program(code)), { signal: this.abort.signal }).then(
      (result) => result,
      () => undefined,
    )
    void this.run.then((result) => this.finish(result))
    return event
  }

  observe(yieldMs: number): Promise<CellEvent> {
    const completion = this.completion
    if (completion !== undefined) {
      this.completion = undefined
      this.host.close()
      return Promise.resolve(completion)
    }
    if (this.observer !== undefined) {
      return Promise.reject(
        new CodeModePragma.RespondToModelError(`exec cell ${this.id} already has an active observer`),
      )
    }
    return new Promise((resolve) => {
      this.observer = { resolve, timer: setTimeout(() => this.yield(), yieldMs) }
    })
  }

  async terminate(): Promise<CellEvent> {
    const completion = this.completion
    if (completion !== undefined) {
      this.completion = undefined
      this.host.close()
      return completion
    }
    if (this.phase === "terminating") {
      throw new CodeModePragma.RespondToModelError(`exec cell ${this.id} is already terminating`)
    }
    this.phase = "terminating"
    this.cut.abort()
    this.stopBackground()
    await this.run
    const event: CellEvent = { type: "terminated", items: this.take() }
    this.deliver(event)
    this.host.close()
    return event
  }

  private async finish(result: CodeMode.Result | undefined) {
    if (this.phase !== "running") return
    // A program stuck on a promise nothing can settle stays a running cell, as in V8: its observers see yields until
    // a `wait` terminates it (the interpreter has already stopped; nothing is left to run).
    if (this.forced === undefined && result !== undefined && !result.ok && CodeModePrelude.isStuck(result.error)) return
    const errorText = this.forced === undefined ? outcomeError(result) : this.forced.errorText
    await Promise.allSettled(this.notifications)
    if (this.phase !== "running") return
    this.host.commit(this.writes)
    this.phase = "completed"
    this.stopBackground()
    const event: CellEvent = { type: "completed", items: this.take(), errorText }
    if (this.observer === undefined) {
      this.completion = event
      return
    }
    this.deliver(event)
    this.host.close()
  }

  private yield() {
    if (this.phase !== "running" || this.exited) return
    this.deliver({ type: "yielded", items: this.take() })
  }

  private deliver(event: CellEvent) {
    const observer = this.observer
    if (observer === undefined) return
    this.observer = undefined
    clearTimeout(observer.timer)
    observer.resolve(event)
  }

  private take() {
    const items = this.items
    this.items = []
    return items
  }

  private push(item: ContentItem) {
    if (this.exited) return
    this.items.push(item)
  }

  /** Cancels nested tool calls and pending timers; interrupts the program if it still runs. */
  private stopBackground() {
    this.abort.abort()
    this.timers.forEach((timer) => {
      clearTimeout(timer.handle)
      timer.resolve(false)
    })
    this.timers.clear()
  }

  private fail(errorText: string) {
    if (this.phase !== "running" || this.forced !== undefined) return
    this.forced = { errorText }
    this.abort.abort()
  }

  /**
   * `exit()` (#52748, Codex `terminate_execution`): the whole cell ends at once and successfully, with the output and
   * `store` writes it made before. Aborting interrupts the program at the interpreter's next step, and the interpreter
   * runs no `catch` or `finally` for an interruption, so no handler, timer or promise callback of it runs after this;
   * every host function is a no-op from here on in case JavaScript still runs until that step. A cell that already
   * failed or is being terminated stays so.
   */
  private exit() {
    if (this.phase !== "running" || this.forced !== undefined) return
    this.exited = true
    this.forced = { errorText: undefined }
    this.cut.abort()
    this.stopBackground()
  }

  /**
   * The private host functions the prelude calls; failures are thrown as plain strings, as Codex's helpers do. After
   * `exit()` the ones with an effect do nothing (Codex's `exit_requested` guards): a tool call then never settles.
   */
  private extension(tools: ReadonlyArray<NestedTool>) {
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    return Extension.make({
      name: "codex",
      globals: {
        __codex_text: (text: string) => this.push({ type: "text", text }),
        __codex_notify: (text: string) => {
          if (this.exited) return
          if (text.trim() === "") throw "notify expects non-empty text"
          const onNotify = this.host.onNotify
          // Codex only logs a failed notification.
          if (onNotify !== undefined) {
            this.notifications.push(
              Promise.resolve()
                .then(() => onNotify(text))
                .catch(() => undefined),
            )
          }
        },
        __codex_image: (media: CodeModeMedia.Media, detail: string | undefined) =>
          this.push(CodeModeMedia.image(media, detail)),
        __codex_audio: (media: CodeModeMedia.Media) => this.push(CodeModeMedia.audio(media)),
        __codex_generated_image: (
          isObject: boolean,
          hintType: string,
          hint: string | undefined,
          media: CodeModeMedia.Media,
        ) => CodeModeMedia.generatedImage(isObject, hintType, hint, media).forEach((item) => this.push(item)),
        __codex_store: (key: string, json: string | undefined) => {
          if (this.exited) return
          if (json === undefined)
            throw `Unable to store ${rustDebug(key)}. Only plain serializable objects can be stored.`
          this.host.stored.set(key, json)
          this.writes.set(key, json)
        },
        __codex_load: (key: string) => this.host.stored.get(key),
        __codex_yield: () => this.yield(),
        __codex_exit: () => this.exit(),
        __codex_timer_start: (delayMs: number) => this.startTimer(delayMs),
        __codex_timer_wait: (id: number | undefined) =>
          (id === undefined ? undefined : this.timers.get(id)?.fired) ?? Promise.resolve(false),
        __codex_timer_clear: (id: number | null) => this.clearTimer(id),
        __codex_fail: (error: unknown) => this.fail(thrownText(error)),
        __codex_all_tools: () => tools.map((tool) => ({ name: tool.name, description: tool.description })),
        __codex_tool_names: () => tools.map((tool) => tool.name),
        __codex_tool: (name: string, json: string | undefined) =>
          this.exited ? new Promise<never>(() => {}) : this.callTool(byName.get(name)!, json),
      },
    })
  }

  /**
   * `schedule_timeout`: non-finite or non-positive delays fire on the next turn; ids count from 1 per cell. After
   * `exit()` nothing is scheduled and `setTimeout` answers `undefined`.
   */
  private startTimer(delayMs: number) {
    if (this.exited) return undefined
    const id = this.nextTimerId++
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? Math.min(Math.trunc(delayMs), MAX_TIMER_DELAY_MS) : 0
    const fired = Promise.withResolvers<boolean>()
    const handle = setTimeout(() => {
      this.timers.delete(id)
      fired.resolve(true)
    }, delay)
    this.timers.set(id, { handle, fired: fired.promise, resolve: fired.resolve })
    return id
  }

  /** `clear_timeout`: nullish, non-finite, and non-positive ids are ignored, and so is every id after `exit()`. */
  private clearTimer(id: number | null) {
    if (this.exited || id === null || !Number.isFinite(id) || id <= 0) return
    const timer = this.timers.get(Math.trunc(id))
    if (timer === undefined) return
    clearTimeout(timer.handle)
    this.timers.delete(Math.trunc(id))
    timer.resolve(false)
  }

  /** `build_nested_tool_payload` plus the call; the result crosses back as JSON text the prelude parses. */
  private async callTool(tool: NestedTool, json: string | undefined) {
    const result = await tool
      .execute(toolPayload(tool, json === undefined ? undefined : JSON.parse(json)), {
        cellId: this.id,
        signal: this.abort.signal,
        terminated: this.cut.signal,
        show: (item) => this.push(item),
      })
      .catch((error: unknown) => {
        throw error instanceof Error ? error.message : String(error)
      })
    return result === undefined ? undefined : JSON.stringify(result)
  }
}

function toolPayload(tool: NestedTool, input: unknown) {
  if (tool.input === "string") {
    if (typeof input !== "string") throw `tool \`${tool.name}\` expects a string input`
    return input
  }
  if (input === undefined) return {}
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw `tool \`${tool.name}\` expects a JSON object for arguments`
  }
  return input
}

/** The cell's error text, or `undefined` when it completed (`exit()` sets its outcome before the run ends). */
function outcomeError(result: CodeMode.Result | undefined) {
  if (result === undefined) return "exec runtime ended unexpectedly"
  if (result.ok) return undefined
  return CodeModePrelude.errorText(result.error)
}

/** `value_to_error_text` for a value thrown by a timer callback: an error as `Name: message`, else its string. */
function thrownText(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  return error.message === "" ? error.name : `${error.name}: ${error.message}`
}

/** Rust's `{:?}` for a string: double-quoted with `\\`, `\"`, `\n`, `\r`, `\t`, `\0`, and `\u{..}` escapes. */
function rustDebug(text: string) {
  const escaped = [...text]
    .map((char) => {
      if (char === "\\" || char === '"') return `\\${char}`
      if (char === "\n") return "\\n"
      if (char === "\r") return "\\r"
      if (char === "\t") return "\\t"
      if (char === "\0") return "\\0"
      const code = char.codePointAt(0)!
      return code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : char
    })
    .join("")
  return `"${escaped}"`
}
