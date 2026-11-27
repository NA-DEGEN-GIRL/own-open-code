// Review line comments (03 §19.1), Git actions (§19.2) and the branch chip (§19.15) on the production data path: web
// host → createDataLayer → Vite proxy → the real server of e2e/review-git/backend.ts. Mounted like the app does:
//   - the header chip `GitStatusChip` (the integrator puts it next to the session title),
//   - the review tab through the real adapter composition (`@/adapter/review`, lazy, PanelTabProps + `visible()`),
//     inside a <ShortcutProvider> so `Ctrl+Shift+L` reaches the tab,
//   - a stand-in composer: `ReviewCommentChips` above a textarea whose send button does what the composer wiring
//     does (`reviewComments.take` → `withReviewComments` → `session.prompt`).
// `own:open-review` and `own:composer-add-mention` are recorded on the page for the assertions.
import "@/styles/index.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createSignal, For, lazy, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL, useData } from "@/data"
import { GitStatusChip } from "@/git"
import { HostProvider } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { ShortcutProvider } from "@/keyboard"
import { MENTION_INTENT, type MentionIntent } from "@/mentions/intents"
import { REVIEW_INTENT, ReviewCommentChips, reviewComments, withReviewComments } from "@/review"
import { seedColorScheme } from "@/shell/theme-default"
import { Toasts } from "@/switcher/toast"

const params = new URLSearchParams(location.search)
const session = params.get("session") ?? undefined
const [visible, setVisible] = createSignal(true)
const [mentions, setMentions] = createSignal<MentionIntent[]>([])
const [reviews, setReviews] = createSignal(0)
const ReviewTab = lazy(() => import("@/adapter/review"))

declare global {
  interface Window {
    __rg: { setVisible(value: boolean): void }
  }
}
window.__rg = { setVisible }
window.addEventListener(MENTION_INTENT, (event) =>
  setMentions((list) => [...list, (event as CustomEvent<MentionIntent>).detail]),
)
window.addEventListener(REVIEW_INTENT, () => {
  setReviews((count) => count + 1)
  setVisible(true)
})

function Composer() {
  const data = useData()
  const [status, setStatus] = createSignal("")
  const box = { element: undefined as HTMLTextAreaElement | undefined }
  const send = async () => {
    const runtime = data.get(LOCAL)
    if (!runtime || !session) return
    const typed = box.element?.value ?? ""
    const comments = reviewComments.take(LOCAL, session)
    const parts = withReviewComments({ text: typed, files: [] }, { typed, comments })
    setStatus("sending")
    try {
      await runtime.data.session.prompt({
        sessionID: session,
        text: parts.text,
        files: parts.files.length ? [...parts.files] : undefined,
        metadata: parts.metadata,
      })
      setStatus("sent")
    } catch (error) {
      reviewComments.restore(LOCAL, session, comments)
      setStatus(`failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <div data-testid="composer" style={{ border: "1px solid var(--own-border)", "border-radius": "10px" }}>
      <ReviewCommentChips serverKey={() => LOCAL} sessionID={() => session} />
      <div style={{ display: "flex", gap: "8px", padding: "8px 12px" }}>
        <textarea
          ref={(element) => (box.element = element)}
          data-testid="composer-input"
          rows={2}
          style={{ flex: 1 }}
        />
        <button type="button" data-testid="composer-send" onClick={() => void send()}>
          send
        </button>
      </div>
      <p data-testid="composer-status">{status()}</p>
    </div>
  )
}

function Harness() {
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "8px", color: "var(--own-text)" }}>
      <header style={{ display: "flex", gap: "8px", "align-items": "center" }} data-testid="header">
        <strong>Git 동작</strong>
        <GitStatusChip serverKey={() => LOCAL} sessionID={() => session} />
        <span data-testid="review-intents">{reviews()}</span>
      </header>
      <div style={{ display: "flex", gap: "12px", "align-items": "flex-start" }}>
        <div style={{ flex: "1 1 0", "min-width": "0", display: "flex", "flex-direction": "column", gap: "8px" }}>
          <Composer />
          <pre data-testid="mentions">
            <For each={mentions()}>{(item) => `${JSON.stringify(item.chip)}\n`}</For>
          </pre>
        </div>
        <div
          class="own-tabpanel"
          data-testid="panel"
          style={{
            width: `${Number(params.get("width") ?? 560)}px`,
            height: "820px",
            flex: "none",
            display: "flex",
            "flex-direction": "column",
            background: "var(--own-bg-subtle)",
            border: "1px solid var(--own-border)",
          }}
          hidden={!visible()}
        >
          <Suspense fallback={<p data-testid="chunk-loading">…</p>}>
            <ReviewTab serverKey={() => LOCAL} sessionID={() => session} visible={visible} tab="review" />
          </Suspense>
        </div>
      </div>
      <Toasts />
    </div>
  )
}

seedColorScheme()
const host = createWebHost()
render(
  () => (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={createDataLayer({ host })}>
            <ShortcutProvider>
              <Harness />
            </ShortcutProvider>
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  ),
  document.getElementById("root")!,
)
