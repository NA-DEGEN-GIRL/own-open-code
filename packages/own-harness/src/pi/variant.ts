// own's revision of a pi session's prompt (12, 10 §3.9), the `own` prompt variant. Pi keeps its system prompt short,
// but core's Code Mode catalog, which goes into Pi's <addendum>, prints every own tool with its full input and output
// types (about 5,000 characters for the eight `opencode` tools alone). The revision lists each tool by its argument
// names and description, closer to Pi's own one-line tool snippets. Pi's own text stays as it is.
// The codex harness's own revision lists core's catalog the same way (codex/request.ts).
// The `custom` variant (내 지시문, 10 §3.11) is the revision with the user's text in place of Pi's opening paragraph
// (prompt.ts `preamble`); <tools>, <rules> and the rest stay generated.
export * as PiVariant from "./variant.js"

import type { OwnHarness } from "@own/protocol/rpc-harness"

/** Whether `prompt` runs own's revision: `own`, and `custom`, which only replaces the opening paragraph. */
export function revised(prompt: OwnHarness.PromptID | undefined) {
  return prompt === "own" || prompt === "custom"
}

/** The revision's one change, with its Korean title and reason for 설정 > 에이전트 방식 (prompts.ts). */
export const CHANGE = {
  title: "Code Mode 도구 목록",
  why: "OpenCode의 Code Mode 목록은 도구마다 입력과 출력 타입을 모두 적어 길어서(도구 8개에 약 5,000자), Pi가 도구를 한 줄씩 소개하듯 목록도 인자 이름과 설명 한 줄로 줄여요. Pi의 지시문은 그대로예요. 목록은 대화마다 달라 여기서는 설명만 보여요.",
} as const

/** Core's Code Mode catalog (core/src/codemode/instructions.ts `render`) with each entry cut to one line. */
export function codemode(text: string) {
  const lines = text.split("\n")
  const at = lines.indexOf(HEADING)
  if (at < 0) return text
  const blocks = lines.slice(at + 1).reduce<Array<Array<string>>>((all, line) => {
    if (line.startsWith("- ") || line.startsWith("  - ")) return [...all, [line]]
    if (all.length === 0) return line.trim() === "" ? all : [...all, [line]]
    all.at(-1)!.push(line)
    return all
  }, [])
  const listed = blocks.map((block) => (block[0]!.startsWith("- ") && block.length === 1 ? block[0]! : entry(block)))
  // A signature this reading does not know keeps the whole catalog as core wrote it.
  if (listed.some((line) => line === undefined)) return text
  return [...lines.slice(0, at + 1), "", NOTE, "", ...listed].join("\n")
}

// Upstream v2.2 renamed it from "## Available tools"; the variant tests render core's real catalog to catch the next one.
const HEADING = "## Code Mode tools (call only inside `execute`)"

const NOTE =
  "Each tool is listed by its argument names (`?` marks an optional one). Return a call's result from `execute` to see its shape."

/** One catalog entry, `  - tools.<path>(<input>): Promise<<output>> // <description>`, as path, argument names, description. */
function entry(block: ReadonlyArray<string>) {
  const head = /^ {2}- (tools[^(]*)\((.*)$/.exec(block[0]!)
  if (head === null) return undefined
  const last = block.at(-1)!
  const cut = last.lastIndexOf(" // ")
  const description = cut < 0 ? "" : last.slice(cut)
  const args = argumentsOf(head[2]!, block)
  return args === undefined ? undefined : `  - ${head[1]}(${args})${description}`
}

function argumentsOf(rest: string, block: ReadonlyArray<string>) {
  if (rest.startsWith(")")) return ""
  // Core prints an object input one field per line, its own fields at two spaces, until the line that closes it.
  if (rest === "{") {
    const end = block.findIndex((line) => line.startsWith("})"))
    if (end < 0) return undefined
    const names = block.slice(1, end).flatMap((line) => /^ {2}([A-Za-z_$][\w$]*\??):/.exec(line)?.[1] ?? [])
    return `{ ${names.join(", ")} }`
  }
  const inline = /^\{ ((?:[A-Za-z_$][\w$]*\??: [^,{}()]+(?:, )?)*) \}\)/.exec(rest)
  if (inline === null) return undefined
  const names = inline[1]!.split(", ").map((field) => field.slice(0, field.indexOf(":")))
  return `{ ${names.join(", ")} }`
}
