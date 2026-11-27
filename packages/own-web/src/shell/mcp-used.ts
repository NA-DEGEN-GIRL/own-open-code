// MCP servers a session's tool calls used (03 §8 "MCP 인증 필요", 18.14): the session banner asks the MCP module
// whether any of them needs a sign-in now. Direct MCP tools are `<server>_<tool>`; Code Mode calls name
// `<server>.<tool>(…)` in the `execute` code. Candidates only: names that are no MCP server match nothing there.
import type { SessionMessageInfo } from "@opencode/client"
import { perSettledMessage } from "@/data/settled"

export function mcpServersUsed(messages: readonly SessionMessageInfo[]) {
  return [...new Set(messages.flatMap(namesOf))].sort()
}

const namesOf = perSettledMessage((message) => {
  const names: string[] = []
  if (message.type !== "assistant") return names
  for (const content of message.content) {
    if (content.type !== "tool") continue
    const split = content.name.indexOf("_")
    if (split > 0) names.push(content.name.slice(0, split))
    const input = content.name === "execute" ? content.state.input : undefined
    const code = typeof input === "object" && input && "code" in input ? input.code : undefined
    if (typeof code === "string")
      for (const match of code.matchAll(/\b([A-Za-z][\w-]*)\.[A-Za-z_]\w*\s*\(/g)) names.push(match[1]!)
  }
  return names
})
