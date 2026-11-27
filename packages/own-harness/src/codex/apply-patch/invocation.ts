// Ports the heredoc extraction of codex-rs/apply-patch/src/invocation.rs (extract_apply_patch_from_bash), which
// recognises `apply_patch <<'EOF' … EOF` and `cd <dir> && apply_patch <<'EOF' … EOF` as the only statement of a shell
// script. Codex matches a Tree-sitter Bash query; this is a scanner for exactly the shapes that query accepts.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
export * as PatchInvocation from "./invocation.js"

const APPLY_PATCH_COMMANDS = ["apply_patch", "applypatch"]
const BLANK = /^[ \t]*/
const SPACE = /^[ \t\r\n]*/
// An unquoted Bash word without expansions, quoting, or operators.
const WORD = /^[^\s'"`$\\;&|<>()]+/

/**
 * The patch body (heredoc text without trailing newlines) and the `cd` directory of a script whose only statement is
 * `apply_patch <<DELIM` / `applypatch <<DELIM`, optionally preceded by `cd <path> &&` with exactly one argument (a
 * word, a double-quoted string without expansions, or a single-quoted string). Anything else (`;`, `||`, `|`, other
 * commands before or after, arguments to a direct `apply_patch`) is not an apply_patch invocation: `undefined`.
 */
export function extractHeredocPatch(command: string): { patch: string; workdir?: string } | undefined {
  const start = command.length - command.replace(SPACE, "").length
  const cd = parseCd(command, start)
  const apply = parseApplyCommand(command, cd?.end ?? start, cd !== undefined)
  if (apply === undefined) return undefined
  const body = parseHeredoc(command, apply)
  if (body === undefined) return undefined
  const patch = body.replace(/\n+$/, "")
  return cd === undefined ? { patch } : { patch, workdir: cd.workdir }
}

/** `cd <arg> &&` at `index`, returning the directory and where the next command starts. */
function parseCd(script: string, index: number) {
  const rest = script.slice(index)
  if (!/^cd[ \t]/.test(rest)) return undefined
  const argStart = index + 2 + (rest.slice(2).match(BLANK)?.[0].length ?? 0)
  const arg = parseArgument(script, argStart)
  if (arg === undefined) return undefined
  const after = script.slice(arg.end)
  const connector = after.match(/^[ \t]*&&[ \t\r\n]*/)
  if (connector === null) return undefined
  return { workdir: arg.value, end: arg.end + connector[0].length }
}

function parseArgument(script: string, index: number) {
  const rest = script.slice(index)
  if (rest.startsWith("'")) {
    const close = rest.indexOf("'", 1)
    return close === -1 ? undefined : { value: rest.slice(1, close), end: index + close + 1 }
  }
  if (rest.startsWith('"')) {
    const close = rest.indexOf('"', 1)
    const value = close === -1 ? "" : rest.slice(1, close)
    // Only a plain string content node is accepted; expansions, escapes, and `""` are not.
    if (value === "" || /[$`\\]/.test(value)) return undefined
    return { value, end: index + close + 1 }
  }
  const word = rest.match(WORD)?.[0]
  return word === undefined ? undefined : { value: word, end: index + word.length }
}

/**
 * The apply command at `index` up to its heredoc operator. After `cd … &&` Codex's query does not anchor the command's
 * end, so arguments are tolerated there; a direct `apply_patch` must have none.
 */
function parseApplyCommand(script: string, index: number, afterCd: boolean) {
  const name = APPLY_PATCH_COMMANDS.find((candidate) => {
    const following = script[index + candidate.length]
    return script.startsWith(candidate, index) && (following === "<" || following === " " || following === "\t")
  })
  if (name === undefined) return undefined
  const cursor = skipBlank(script, index + name.length)
  if (script.startsWith("<<", cursor)) return cursor
  if (!afterCd) return undefined
  const arg = parseArgument(script, cursor)
  return arg === undefined ? undefined : parseApplyArguments(script, arg.end)
}

function parseApplyArguments(script: string, index: number): number | undefined {
  const cursor = skipBlank(script, index)
  if (script.startsWith("<<", cursor)) return cursor
  if (cursor === index) return undefined
  const arg = parseArgument(script, cursor)
  return arg === undefined ? undefined : parseApplyArguments(script, arg.end)
}

/**
 * The heredoc body for the `<<` operator at `index`: the lines after the operator's line up to the terminator line.
 * The operator line must end after the delimiter, the terminator must exist (indented by tabs only for `<<-`), the
 * body must not be empty, and only whitespace may follow the terminator.
 */
function parseHeredoc(script: string, index: number) {
  const stripTabs = script[index + 2] === "-"
  const delimiter = parseDelimiter(script, skipBlank(script, index + (stripTabs ? 3 : 2)))
  if (delimiter === undefined) return undefined
  const lineEnd = skipBlank(script, delimiter.end)
  if (script[lineEnd] !== "\n") return undefined
  const bodyStart = lineEnd + 1
  const lines = script.slice(bodyStart).split("\n")
  const terminator = lines.findIndex((line) => (stripTabs ? line.replace(/^\t+/, "") : line) === delimiter.value)
  if (terminator <= 0) return undefined
  if (lines.slice(terminator + 1).some((line) => line.trim() !== "")) return undefined
  return lines.slice(0, terminator).join("\n") + "\n"
}

function parseDelimiter(script: string, index: number) {
  const quote = script[index]
  if (quote === "'" || quote === '"') {
    const close = script.indexOf(quote, index + 1)
    if (close === -1 || close === index + 1) return undefined
    const value = script.slice(index + 1, close)
    return value.includes("\n") ? undefined : { value, end: close + 1 }
  }
  const word = script.slice(index).match(/^[^\s;&|<>()'"]+/)?.[0]
  return word === undefined ? undefined : { value: word.replaceAll("\\", ""), end: index + word.length }
}

function skipBlank(script: string, index: number) {
  return index + (script.slice(index).match(BLANK)?.[0].length ?? 0)
}
