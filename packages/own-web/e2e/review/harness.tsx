// Review harness: mounts the review tab module (e2e/review/kit.tsx = src/adapter/review.tsx) exactly as the work
// panel does (lazy import, PanelTabProps, `visible()`), on the production data path: web host → createDataLayer →
// Vite proxy → real server of e2e/review/backend.ts. Also mounts the light hooks the shell and transcript wire: the
// tab badge (`watchReviewTurns` + `reviewBadgeCount`) and the footer link, whose `own:open-review` intent the harness
// resolves like the shell would. `window.__review` lets Playwright switch session, width and visibility.
import "@/styles/index.css"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createSignal, lazy, Show, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createDataLayer, DataProvider, LOCAL } from "@/data"
import { HostProvider } from "@/host"
import { createWebHost } from "@/host/web"
import { createI18n, I18nProvider } from "@/i18n"
import { REVIEW_INTENT, reviewBadgeCount, ReviewChangesLink, watchReviewTurns } from "@/review"

const params = new URLSearchParams(location.search)
const [session, setSession] = createSignal(params.get("session") ?? undefined)
const [visible, setVisible] = createSignal(params.get("hidden") !== "1")
const [width, setWidth] = createSignal(Number(params.get("width") ?? 420))
const [opened, setOpened] = createSignal(params.get("open") !== "0")
const ReviewTab = lazy(() => import("./kit"))

declare global {
  interface Window {
    __review: {
      setSession(id: string): void
      setVisible(value: boolean): void
      setWidth(value: number): void
      open(): void
    }
  }
}

window.__review = {
  setSession,
  setVisible,
  setWidth,
  open: () => setOpened(true),
}
window.addEventListener(REVIEW_INTENT, () => {
  setOpened(true)
  setVisible(true)
})

function Harness() {
  watchReviewTurns({ serverKey: () => LOCAL, sessionID: session })
  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "8px" }}>
      <div style={{ display: "flex", gap: "12px", "font-size": "12px" }}>
        <span data-testid="badge">{(session() && reviewBadgeCount(LOCAL, session()!)) || ""}</span>
        <Show when={session()}>{(id) => <ReviewChangesLink serverKey={LOCAL} sessionID={id()} />}</Show>
      </div>
      <div
        class="own-tabpanel"
        data-testid="panel"
        style={{ width: `${width()}px`, height: "760px", flex: "none", display: "flex", "flex-direction": "column" }}
        hidden={!visible()}
      >
        <Show when={opened()}>
          <Suspense fallback={<p data-testid="chunk-loading">…</p>}>
            <ReviewTab serverKey={() => LOCAL} sessionID={session} visible={visible} tab="review" />
          </Suspense>
        </Show>
      </div>
    </div>
  )
}

const host = createWebHost()
render(
  () => (
    <HostProvider value={host}>
      <ThemeProvider>
        <I18nProvider value={createI18n("ko")}>
          <DataProvider value={createDataLayer({ host })}>
            <Harness />
          </DataProvider>
        </I18nProvider>
      </ThemeProvider>
    </HostProvider>
  ),
  document.getElementById("root")!,
)
