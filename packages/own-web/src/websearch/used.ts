// Which web search services a conversation's searches used (03 §18.2, WM 2026-10-19), for the one-time hint above
// the composer. Kept tiny and free of UI imports: the session banners (first chunk) read it on every message list
// change and load the hint's chunk only when a free service answered and the hint is still wanted.
import type { SessionMessageInfo } from "@opencode/client"
import { createSignal } from "solid-js"
import { perSettledMessage } from "@/data/settled"

/** own-accounts' ChatGPT web search service (02 §9.2). */
export const CHATGPT = "own-chatgpt"

/** Core's keyless services (packages/core/src/plugin/websearch/): free without a key, within limits. */
export const KEYLESS = ["exa", "firecrawl", "parallel", "tavily", "tinyfish"] as const
export type Keyless = (typeof KEYLESS)[number]

export function isKeyless(id: string): id is Keyless {
  return (KEYLESS as readonly string[]).includes(id)
}

/**
 * The services that answered (or were answering) this conversation's `websearch` calls, oldest first, once each:
 * core puts the service's id in the tool's metadata (`provider`) while it runs, on its result and on a failure.
 */
export function webSearchUsed(messages: readonly SessionMessageInfo[]) {
  return [...new Set(messages.flatMap(providersOf))]
}

const providersOf = perSettledMessage((message) => {
  const used: string[] = []
  if (message.type !== "assistant") return used
  for (const content of message.content) {
    if (content.type !== "tool" || content.name !== "websearch" || content.state.status === "streaming") continue
    const provider = content.state.metadata?.provider
    if (typeof provider === "string") used.push(provider)
  }
  return used
})

const HINT_KEY = "own.web.websearch.hint"

const [dismissed, setDismissed] = createSignal(stored())

/**
 * The hint was closed, or a service was chosen in 설정 > 웹 검색 or from the hint: then it never shows again in this
 * browser (lost storage shows it once more). Reactive.
 */
export const hintDismissed = dismissed

export function dismissHint() {
  setDismissed(true)
  try {
    localStorage.setItem(HINT_KEY, "done")
  } catch {}
}

function stored() {
  try {
    return localStorage.getItem(HINT_KEY) === "done"
  } catch {
    return false
  }
}
