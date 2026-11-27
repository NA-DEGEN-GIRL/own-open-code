// Transcript module entry (03 §4.5, owner: transcript). First-chunk part only: the container, the home state and a
// lazy import of the session view (session-ui, virtualizer, transcript CSS; 03 §20.2 R5). The view chunk is fetched
// right away on a session route, otherwise when the browser is idle after the first paint, so opening the first
// session does not wait for the network.
// Contract kept by the shell: mounted once and kept mounted across tiers, routes and pages; the session changes
// through `sessionID()`.
import { lazy, onMount, Show, Suspense } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { isPage, routePath } from "@/routing/routes"

export { ChildSessionBreadcrumb, SessionTitle } from "./breadcrumb"
export { AccountDot, AccountName, ModelAccountChip, type AccountDisplay } from "./chip"

export interface TranscriptProps {
  readonly serverKey: () => ServerKey
  /** `undefined` on the home route (new-session screen). */
  readonly sessionID: () => string | undefined
  /** The pane is on screen (03 §4.1.1: a pane hidden in tabs mode stops measuring and drops its watch). */
  readonly visible?: () => boolean
}

const loadView = () => import("./view")
const TranscriptView = lazy(loadView)

export function Transcript(props: TranscriptProps) {
  const i18n = useI18n()
  const data = useData()
  const router = useRouter()
  const route = (sessionID: string) => ({ name: "session" as const, serverKey: props.serverKey(), sessionID })
  onMount(() => idle(() => void loadView().catch(() => undefined)))
  return (
    <div
      class="own-transcript relative flex min-h-0 flex-1 flex-col"
      data-testid="transcript"
      data-session-id={props.sessionID()}
    >
      <Show
        when={props.sessionID()}
        fallback={
          <div class="own-placeholder mx-auto w-full max-w-[var(--own-content-max)]">{i18n.t("own.empty.home")}</div>
        }
      >
        <Suspense
          fallback={
            <p class="own-placeholder mx-auto w-full max-w-[var(--own-content-max)]" role="status">
              {i18n.t("own.transcript.loading")}
            </p>
          }
        >
          <TranscriptView
            runtime={() => data.get(props.serverKey())}
            sessionID={() => props.sessionID() ?? ""}
            active={() => !isPage(router.route()) && (props.visible?.() ?? true)}
            onNavigate={(sessionID) => router.navigate(route(sessionID))}
            sessionHref={(sessionID) => routePath(route(sessionID))}
          />
        </Suspense>
      </Show>
    </div>
  )
}

function idle(fn: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 2_000 })
  else setTimeout(fn, 200)
}
