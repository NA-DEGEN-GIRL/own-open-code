// The web search card in a conversation (03 §18.2, §4.5, WM 2026-10-19): its title names the service that answered
// and what it cost (`ChatGPT로 검색`, `Parallel로 검색 (무료)`, `Exa로 검색 (내 키)`; session-ui draws it, see
// transcript/tool-alias.ts), or for `여러 서비스 함께` the services that found its results (`여러 서비스로 검색 ·
// ChatGPT·Exa·Parallel`, MS), and a line under the card (or under the group of reads and searches that holds it) with
// how many results each of those found (`결과를 찾은 서비스: ChatGPT 4 · Exa 3`) leads to 설정 > 웹 검색
// (`검색 서비스 바꾸기`). An empty answer of a keyless service without a key says its free tier may be
// used up: Exa's and Firecrawl's keyless MCP servers answer an exhausted quota with an error text that core reads as
// no results (upstream #54311), so a search card is where the user can see it.
import { createEffect, on, Show } from "solid-js"
import type { ServerRuntime } from "@/data"
import { useRouter } from "@/routing/router"
import { cardTitle, costOf, foundBy, serviceName } from "./services"
import { webSearchInfo } from "./state"
import { useWebSearchText } from "./strings"
import "./websearch.css"

/**
 * A search of a row: the service id that answered (or answers) it, whether it found nothing, and the text of its
 * result (a multi-service search's `Found by` lines).
 */
export interface SearchPart {
  readonly provider?: string
  readonly empty: boolean
  readonly texts?: readonly string[]
}

/** The text parts of a tool state (`content: [{type:"text", text}]`), read as session-ui's renderer does. */
export function stateTexts(state: Readonly<Record<string, unknown>> | undefined) {
  const content = state?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((item: { readonly type?: unknown; readonly text?: unknown }) =>
    item?.type === "text" && typeof item.text === "string" ? [item.text] : [],
  )
}

/** core's text for a search without results (packages/core/src/tool/plugin/websearch.ts `NO_RESULTS`). */
export const NO_RESULTS = "No search results found. Please try a different query."

/** The card title for a service id, from the server's list and keys (reactive: read while session-ui draws). */
export function useWebSearchTitle(server: () => ServerRuntime | undefined, directory: () => string | undefined) {
  const text = useWebSearchText()
  return (provider: string, state: Readonly<Record<string, unknown>>) => {
    const runtime = server()
    const info = runtime && webSearchInfo(runtime)
    const found = costOf(provider) === "multi" ? foundBy(stateTexts(state)).map((item) => item.name) : []
    return cardTitle(provider, info?.listed(directory()), info?.state()?.keys, text, found)
  }
}

/** The line under a row with searches: `검색 서비스 바꾸기`, and the empty-free note when one applies. */
export function WebSearchLine(props: {
  readonly server: ServerRuntime | undefined
  readonly directory: string | undefined
  readonly searches: readonly SearchPart[]
  readonly onSizeChange?: () => void
}) {
  const text = useWebSearchText()
  const router = useRouter()
  const info = () => (props.server ? webSearchInfo(props.server) : undefined)
  const emptyFree = () => {
    const found = props.searches.find(
      (search) => search.empty && search.provider && costOf(search.provider, info()?.state()?.keys) === "free",
    )
    return found?.provider
  }
  /** How many merged results each service found, over the row's multi-service searches. */
  const found = () => {
    const counts = foundBy(
      props.searches.flatMap((search) =>
        search.provider && costOf(search.provider) === "multi" ? (search.texts ?? []) : [],
      ),
    )
    return counts.length > 0 ? counts.map((item) => `${item.name} ${item.count}`).join(" · ") : undefined
  }
  createEffect(on(emptyFree, () => props.onSizeChange?.(), { defer: true }))
  createEffect(on(found, () => props.onSizeChange?.(), { defer: true }))
  return (
    <div class="own-ws-line" data-testid="websearch-line">
      <Show when={found()}>
        {(counts) => <span data-testid="websearch-found">{text("own.ws.card.found", { counts: counts() })}</span>}
      </Show>
      <Show when={emptyFree()}>
        {(provider) => (
          <span data-testid="websearch-empty">
            {text("own.ws.card.empty", { name: serviceName(provider(), info()?.listed(props.directory)) })}
          </span>
        )}
      </Show>
      <button
        type="button"
        data-testid="websearch-change"
        onClick={() => router.navigate({ name: "settings", section: "websearch" })}
      >
        {text("own.ws.card.change")}
      </button>
    </div>
  )
}
