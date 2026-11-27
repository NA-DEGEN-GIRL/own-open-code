export * as Code from "./code.js"

import path from "node:path"
import { Creator } from "@own/protocol/creator"

/**
 * An early lint of the code of C2 servers and C3 plugins, before anything is asked or staged (17 §11.6, §12.3). It is
 * not a boundary: C2 code runs inside own's WebAssembly sandbox whatever passes here, and C3 code runs in the service
 * once the user approved it. The lint only turns away, early and with a clear message, what would fail or what the
 * user should not be asked about:
 *
 * - every file: code files are `.ts`, `.js`, `.mts` or `.mjs` (lower case; `.tsx`, `.jsx`, `.cts`, `.cjs` and other
 *   spellings are refused), and every code file is scanned, whatever its name;
 * - relative imports name a file of the item (or own's helper) with its extension, never a folder or a guess; no
 *   import attributes (`with { … }`), no dynamic `import()` or `import.meta`;
 * - C2: own's `./own-mcp.ts`, the item's allow-listed dependencies, nothing of Node or Bun (none exists in the
 *   sandbox), and none of the names the sandbox does not have (`process`, `Bun`, `require`, global `fetch`, …);
 * - C3: its own files and `./own-plugin.ts` only, the names of 17 §12.3, and no `@ts-nocheck`, `@ts-ignore` or
 *   `@ts-expect-error` (the typecheck against own's plugin API is part of the review).
 *
 * The transpiler runs with macros switched off (`macro: false`): Bun evaluates `with { type: "macro" }` imports while
 * it transpiles or scans, so untrusted source is never handed to it otherwise.
 */

/**
 * npm packages a C2 server may depend on: pure JavaScript libraries without dependencies of their own, so the exact
 * version the user approves is everything that installs (17 §11.4). Each is bundled into one file for the sandbox.
 */
export const ALLOWED_PACKAGES: ReadonlyArray<string> = [
  "zod",
  "yaml",
  "date-fns",
  "dayjs",
  "marked",
  "diff",
  "papaparse",
  "semver",
  "lodash-es",
]

/** Code files: lower-case `.ts`, `.js`, `.mts`, `.mjs`. */
const CODE = /\.m?[jt]s$/
/** Anything that looks like a code file in another spelling or flavour (`.tsx`, `.CJS`, `.Ts`, …). */
const CODE_LIKE = /\.[cm]?[jt]sx?$/i

/** Names the C2 sandbox does not have: using one fails at run time, so the lint says so first. */
const SERVER_ABSENT = [
  "process",
  "Bun",
  "Deno",
  "require",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "setTimeout",
  "setInterval",
]

/** Names a C3 plugin may not use (17 §12.3). */
const PLUGIN_BANNED = [
  "process",
  "Bun",
  "Deno",
  "require",
  "globalThis",
  "global",
  "self",
  "window",
  "eval",
  "Function",
  "module",
  "exports",
  "__dirname",
  "__filename",
  "Reflect",
  "Proxy",
  "WebAssembly",
  "Worker",
  "SharedArrayBuffer",
  "Atomics",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "navigator",
  "setInterval",
]

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bimport\s*\(/, "dynamic import()"],
  [/\bimport\s*\.\s*meta\b/, "import.meta"],
  [/\.\s*constructor\b/, ".constructor"],
  [/__proto__/, "__proto__"],
]

/** TypeScript directives that switch the typecheck off; a C3 file may not hold one (any case). */
const TS_DIRECTIVES = /@ts-(?:nocheck|ignore|expect-error)/i

/** The lint's problems for every file of `item`. */
export function problems(item: Creator.McpServer | Creator.PluginCode, at: string): Creator.Problem[] {
  const files = Object.keys(item.files)
  return Object.entries(item.files).flatMap(([file, source]): Creator.Problem[] => {
    const where = `${at}.files.${file}`
    if (CODE_LIKE.test(file) && !CODE.test(file))
      return [{ path: where, message: "code files are .ts, .js, .mts or .mjs (lower case); .tsx, .jsx, .cts and .cjs are not run" }]
    const directive =
      item.type === "plugin.code" && TS_DIRECTIVES.test(source)
        ? [{ path: where, message: "may not switch the typecheck off (@ts-nocheck, @ts-ignore, @ts-expect-error)" }]
        : []
    if (!CODE.test(file)) return directive
    const js = transpile(source, file)
    if (js === undefined)
      return [...directive, { path: where, message: "does not parse as TypeScript (import attributes and macros are refused)" }]
    const imports = scanImports(source, file)
    if (imports === undefined) return [...directive, { path: where, message: "its imports could not be read" }]
    return [
      ...directive,
      ...imports.flatMap((specifier) => importProblem(item, files, file, specifier, where)),
      ...bannedNames(js, item.type === "plugin.code" ? PLUGIN_BANNED : SERVER_ABSENT).map((name) => ({
        path: where,
        message:
          item.type === "mcp.server" && name === "fetch"
            ? "use context.fetch (only the declared hosts); there is no global fetch in own's sandbox"
            : item.type === "mcp.server" && SERVER_ABSENT.includes(name)
              ? `'${name}' does not exist in own's sandbox`
              : `may not use '${name}'`,
      })),
    ]
  })
}

/** Dependencies outside the allow-list. */
export function dependencyProblems(item: Creator.McpServer, at: string): Creator.Problem[] {
  return Object.keys(item.dependencies ?? {})
    .filter((name) => !ALLOWED_PACKAGES.includes(name))
    .map((name) => ({ path: `${at}.dependencies`, message: `'${name}' is not on own's allow-list` }))
}

function importProblem(
  item: Creator.McpServer | Creator.PluginCode,
  files: ReadonlyArray<string>,
  file: string,
  specifier: string,
  where: string,
): Creator.Problem[] {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    if (target.startsWith("../") || target === "..") return [{ path: where, message: `'${specifier}' leaves the item` }]
    const own = item.type === "mcp.server" ? "own-mcp" : "own-plugin"
    const hasExtension = CODE.test(target) || target.endsWith(".json")
    // C3 relative imports need an explicit extension (F5); C2 may omit it (the bundler resolves it).
    if (item.type === "plugin.code" && !hasExtension)
      return [{ path: where, message: `'${specifier}' needs an explicit extension (e.g. '${specifier}.ts')` }]
    const base = target.replace(CODE, "").replace(/\.json$/, "")
    if (base === own) return []
    if (hasExtension && files.includes(target)) return []
    if (item.type === "mcp.server" && files.some((name) => name.replace(CODE, "").replace(/\.json$/, "") === base)) return []
    return [{ path: where, message: `'${specifier}' names no file of the item (write the file's name with its extension)` }]
  }
  if (item.type === "plugin.code") return [{ path: where, message: `may import only its own files, not '${specifier}'` }]
  if (Object.hasOwn(item.dependencies ?? {}, specifier)) return []
  return [{ path: where, message: `may not import '${specifier}' (own's sandbox has its own files, ./own-mcp.ts and the declared dependencies)` }]
}

function transpiler(file: string) {
  // SAFETY: `macro: false` is Bun's switch that refuses macro imports instead of running them (absent from its types).
  return new Bun.Transpiler({ loader: file.endsWith("ts") ? "ts" : "js", macro: false } as unknown as Bun.TranspilerOptions)
}

function scanImports(source: string, file: string) {
  try {
    return transpiler(file)
      .scan(source)
      .imports.map((entry) => entry.path)
  } catch {
    return undefined
  }
}

function transpile(source: string, file: string) {
  try {
    return transpiler(file).transformSync(source)
  } catch {
    return undefined
  }
}

/** The banned names `js` uses outside strings, regular expressions and property names. */
export function bannedNames(js: string, names: ReadonlyArray<string>) {
  const code = blankStrings(js)
  return [
    ...names.filter((name) => new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(code)),
    ...SHAPES.filter((entry) => entry[0].test(code)).map((entry) => entry[1]),
  ]
}

/**
 * `js` with the contents of its string, template and regular expression literals blanked (template `${…}` parts kept).
 * A `/` starts a regular expression where an expression may start (after an operator, a bracket or a keyword), so a
 * quote inside one does not open a string.
 */
export function blankStrings(js: string) {
  const out: string[] = []
  const stack: Array<"template" | "brace"> = []
  let quote: string | undefined
  for (let index = 0; index < js.length; index++) {
    const char = js[index]!
    if (quote !== undefined) {
      if (char === "\\") {
        index++
        continue
      }
      if (quote === "`" && char === "$" && js[index + 1] === "{") {
        out.push("${")
        index++
        stack.push("template")
        quote = undefined
        continue
      }
      if (char === quote) {
        out.push(char)
        quote = undefined
      }
      continue
    }
    if (char === "/" && js[index + 1] !== "/" && js[index + 1] !== "*" && regexMayStart(out)) {
      index = regexEnd(js, index)
      out.push("/r/")
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char
      out.push(char)
      continue
    }
    if (char === "{") stack.push("brace")
    if (char === "}") {
      const top = stack.pop()
      if (top === "template") {
        out.push("}")
        quote = "`"
        continue
      }
    }
    out.push(char)
  }
  return out.join("")
}

const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

function regexMayStart(out: ReadonlyArray<string>) {
  const before = out.join("").trimEnd()
  if (before === "") return true
  return /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || REGEX_KEYWORDS.test(before)
}

/** The index of the last character of the regular expression literal that starts at `start` (its flags included). */
function regexEnd(js: string, start: number) {
  let klass = false
  for (let index = start + 1; index < js.length; index++) {
    const char = js[index]!
    if (char === "\\") {
      index++
      continue
    }
    if (char === "\n") return index - 1
    if (klass) {
      if (char === "]") klass = false
      continue
    }
    if (char === "[") klass = true
    else if (char === "/") {
      let end = index
      while (/[a-z]/i.test(js[end + 1] ?? "")) end++
      return end
    }
  }
  return js.length - 1
}
