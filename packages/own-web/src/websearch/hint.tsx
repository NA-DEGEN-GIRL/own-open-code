// The one-time hint above the composer (03 §18.2, §8, WM 2026-10-19): this conversation's searches went to a free
// keyless service while the server also lists the user's ChatGPT service, so `웹 검색이 무료 서비스(Parallel)로 가고
// 있어요 · ChatGPT 구독으로 바꿀까요?` with `ChatGPT로 바꾸기` (`websearch.set`, a choice the user makes here), `웹 검색 설정`
// and `닫기`. It never changes a choice by itself. Closed, or answered by a choice here or in 설정 > 웹 검색, it does not
// come back in this browser. It also stays away once ChatGPT answers searches now. Loaded by the session banners
// (shell/session-banners.tsx) only when such a search is in the conversation and the hint was not closed.
import { createMemo, createSignal, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { current, freeWhileChatGPT, serviceName } from "./services"
import { webSearchInfo } from "./state"
import { useWebSearchText } from "./strings"
import { CHATGPT, dismissHint } from "./used"
import "@/limits/kit.css"
import "./websearch.css"

export default function WebSearchHint(props: {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly used: readonly string[]
}) {
  const data = useData()
  const router = useRouter()
  const text = useWebSearchText()
  const runtime = () => data.get(props.serverKey)
  const info = () => {
    const server = runtime()
    return server ? webSearchInfo(server) : undefined
  }
  const directory = () => runtime()?.data.session.get(props.sessionID)?.location.directory
  const [busy, setBusy] = createSignal(false)
  const service = createMemo(() => {
    const listed = info()?.listed(directory())
    const state = info()?.state()
    if (!listed || !state) return undefined
    const now = current(state.choice, listed)
    // ChatGPT answers now, or the user chose to ask several services together (MS): nothing to suggest.
    if ((now.type === "service" && now.id === CHATGPT) || now.type === "multi") return undefined
    const found = freeWhileChatGPT(props.used, listed, state.keys)
    return found ? serviceName(found, listed) : undefined
  })

  async function switchToChatGPT() {
    const target = info()
    if (!target || busy()) return
    setBusy(true)
    await target.set({ type: "service", id: CHATGPT }).then(
      () => {
        dismissHint()
        showToast({ message: text("own.ws.saved", { choice: "ChatGPT" }) })
      },
      (error: unknown) => {
        console.error("[own-web] websearch.set failed", error)
        showToast({ message: text("own.ws.failed"), tone: "danger" })
      },
    )
    setBusy(false)
  }

  return (
    <Show when={service()}>
      {(name) => (
        <div class="own-ws-hint" role="note" data-testid="websearch-hint">
          <p>{text("own.ws.hint", { name: name() })}</p>
          <div class="own-ws-hint-actions">
            <Show when={runtime()?.rpc.allowed("websearch.set")}>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-testid="websearch-hint-switch"
                disabled={busy()}
                onClick={() => void switchToChatGPT()}
              >
                {text("own.ws.hint.switch")}
              </button>
            </Show>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="websearch-hint-settings"
              onClick={() => router.navigate({ name: "settings", section: "websearch" })}
            >
              {text("own.ws.hint.settings")}
            </button>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="ghost"
              data-testid="websearch-hint-dismiss"
              onClick={() => dismissHint()}
            >
              {text("own.ws.hint.dismiss")}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}
