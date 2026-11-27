// The program-side half of Code Mode's globals. Codex installs them as V8 globals (codex-rs/code-mode-runtime/src/
// runtime/globals.rs); the CodeMode interpreter only lets a host add functions, which cannot receive program
// callbacks, so `tools`, `ALL_TOOLS`, `setTimeout`, and the helpers that serialize like `JSON.stringify` are defined in
// program code that calls private `__codex_*` host functions. The model's source runs in a function below this
// prelude, so its own declarations may shadow any helper, as they shadow V8 globals.
export * as CodeModePrelude from "./prelude.js"

import type { CodeMode } from "@opencode/codemode"

const PRELUDE = [
  // `serialize_output_text`: primitives as `String(value)`, everything else through `JSON.stringify`.
  `const __codex_ser = (value) => value === undefined || value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string" ? String(value) : JSON.stringify(value) ?? String(value)`,
  `const __codex_json = (value) => { try { return JSON.stringify(value) } catch { return undefined } }`,
  `const __codex_media = (value, key) => { if (typeof value === "string") return { kind: "string", value }; if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "other" }; const field = value[key]; const detail = value.detail; return { kind: "object", fieldType: typeof field, field: typeof field === "string" ? field : undefined, detailType: detail === null ? "null" : typeof detail, detail: typeof detail === "string" ? detail : undefined, json: __codex_json(value) } }`,
  `const text = (value) => { __codex_text(__codex_ser(value)) }`,
  `const notify = (value) => { __codex_notify(__codex_ser(value)) }`,
  `const image = (...args) => { const detail = args[1]; if (args.length >= 2 && typeof detail !== "string" && detail !== null && detail !== undefined) throw "image detail must be a string when provided"; __codex_image(__codex_media(args[0], "image_url"), typeof detail === "string" ? detail : undefined) }`,
  `const audio = (value) => { __codex_audio(__codex_media(value, "audio_url")) }`,
  `const generatedImage = (value) => { const isObject = (typeof value === "object" && value !== null) || typeof value === "function"; const hint = isObject ? value.output_hint : undefined; __codex_generated_image(isObject, typeof hint, typeof hint === "string" ? hint : undefined, __codex_media(value, "image_url")) }`,
  `const store = (key, value) => { __codex_store(String(key), JSON.stringify(value)) }`,
  `const load = (key) => { const stored = __codex_load(String(key)); return stored === undefined ? undefined : JSON.parse(stored) }`,
  `const yield_control = () => { __codex_yield() }`,
  // `exit()` ends the whole cell from the host side (index.ts `Cell.exit`): nothing is thrown that a `catch` could see.
  `const exit = () => { __codex_exit() }`,
  `const setTimeout = (callback, delayMs) => { if (typeof callback !== "function") throw "setTimeout expects a function callback"; const id = __codex_timer_start(Number(delayMs)); __codex_timer_wait(id).then((fired) => { if (!fired) return; try { callback() } catch (error) { __codex_fail(error) } }); return id }`,
  `const clearTimeout = (timeoutId) => { __codex_timer_clear(timeoutId === undefined || timeoutId === null ? null : Number(timeoutId)) }`,
  `const ALL_TOOLS = __codex_all_tools()`,
  `const tools = {}`,
  `for (const name of __codex_tool_names()) tools[name] = (input) => __codex_tool(name, JSON.stringify(input)).then((result) => result === undefined ? undefined : JSON.parse(result))`,
].join("; ")

/**
 * The program the interpreter runs: the prelude on line 1, then the model's source from line 2 as the body of an
 * awaited async function, so its `var`, `let`, `const`, and function declarations may all shadow the helpers.
 */
export function program(code: string) {
  return `${PRELUDE}; await (async () => {\n${code}\n})()`
}

/**
 * Formats a failed run the way Codex reports a V8 exception: `name: message`, or a thrown value's own text. The
 * interpreter's suggestions are already part of its messages.
 */
export function errorText(diagnostic: CodeMode.Diagnostic) {
  return diagnostic.message.startsWith("Uncaught: ")
    ? diagnostic.message.slice("Uncaught: ".length)
    : locate(diagnostic)
}

/**
 * True when the interpreter ended the program because it awaits a promise nothing can settle (upstream v2.2). V8 keeps
 * such a program pending, so Codex's cell keeps running until it yields or is terminated (its own tests use
 * `await new Promise(() => {})` for a long-running cell).
 */
export function isStuck(diagnostic: CodeMode.Diagnostic) {
  return diagnostic.message.includes("waiting on a promise that can never settle")
}

/**
 * Maps interpreter locations to the model's lines (one less than the program's) in V8's stack-frame form, and drops
 * locations inside the prelude. Parse errors keep Acorn's wording.
 */
function locate(diagnostic: CodeMode.Diagnostic) {
  if (diagnostic.kind === "ParseError") return parseError(diagnostic)
  return diagnostic.message.replace(/ \(line (\d+), col (\d+)\)$/, (_, line: string, column: string) =>
    Number(line) > 1 ? `\n    at exec_main.mjs:${Number(line) - 1}:${column}` : "",
  )
}

/**
 * Acorn's text for a parse error, `SyntaxError: <reason> (line:column)` with a 0-based column, as before upstream
 * v2.2. The interpreter now adds model guidance and a 1-based ` (line L, col C)`; Codex reports the parser's own
 * message, so both come off again.
 */
function parseError(diagnostic: CodeMode.Diagnostic) {
  const body = diagnostic.message.replace(/ \(line \d+, col \d+\)$/, "").replace(/^SyntaxError: /, "")
  const reason = body.endsWith(PARSE_GUIDANCE) ? body.slice(0, -PARSE_GUIDANCE.length).replace(/\.$/, "") : body
  const location = diagnostic.location
  return `SyntaxError: ${reason}${location !== undefined && location.line > 1 ? ` (${location.line - 1}:${location.column - 1})` : ""}`
}

// The guidance upstream's interpreter appends to every parse error (codemode `parseDiagnostic`).
const PARSE_GUIDANCE = " Code must be plain JavaScript written as a program body."
