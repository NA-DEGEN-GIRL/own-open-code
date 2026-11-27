// Cross-module requests sent as window events (accounts/limits → switcher, new session; contract in
// `limits/intents.ts`). The shell owns the routes, so it resolves them here: the switcher opens for the session named
// in the event (navigating there first when another one is on screen), and "이 계정으로 새 세션" (03 §5.4 step 3)
// makes that account the next new session's combination and moves to the new-session screen with the composer focused.
// `own:open-session-info` waits for the session info drawer (03 §5.6), which is not built yet. The review tab opens on
// `own:open-review` (review/intents.ts) and on the restore bar's `own:revert-view-changes` (revert/events.ts).
// P7: `own:open-file` and `own:quick-open` (files/intents.ts) open the files tab. Settings 팀 (team/intents.ts
// `openTeamSettings`) registers here, not on the lazy settings page, so the request navigates from any screen; the page
// reads its team from the route.
import { onCleanup, onMount } from "solid-js"
import { useData } from "@/data"
import { FILE_INTENT, QUICK_OPEN_INTENT, type OpenFileRequest } from "@/files"
import { INTENT, type NewSessionIntent, type SwitcherIntent } from "@/limits/intents"
import { REVERT_VIEW_CHANGES, type RevertViewChangesDetail } from "@/revert/events"
import { openReview, REVIEW_INTENT, type ReviewIntent } from "@/review/intents"
import { useRouter } from "@/routing/router"
import { teamSettingsRoute } from "@/routing/routes"
import { openSwitcher, switcherControl } from "@/switcher"
import { providerModels } from "@/switcher/labels"
import { newSessionTarget } from "@/switcher/new-session"
import { modelForAccount } from "@/switcher/picker"
import { teamIntents } from "@/team/intents"
import { useShell } from "./context"
import { inFocusedPane } from "./pane-context"

export function ShellIntents() {
  const router = useRouter()
  const data = useData()
  const shell = useShell()

  onMount(() => {
    const onSwitcher = (event: Event) => {
      const detail = (event as CustomEvent<SwitcherIntent>).detail
      const route = router.route()
      const here =
        route.name === "session" && route.serverKey === detail.serverKey && route.sessionID === detail.sessionID
      if (!here) router.navigate({ name: "session", serverKey: detail.serverKey, sessionID: detail.sessionID })
      // After the route change settles: the switcher closes a popover that belongs to the previous session.
      requestAnimationFrame(() =>
        openSwitcher({
          accountID: detail.accountID,
          anchor: inFocusedPane('[data-testid="composer-switcher"]'),
        }),
      )
    }
    const onNewSession = (event: Event) => {
      const detail = (event as CustomEvent<NewSessionIntent>).detail
      const runtime = data.local()
      // Keep the model and effort the new session would use now when the account has them, else the account's group
      // default with its effort (07 §2.2), else its first model.
      const current = newSessionTarget(runtime, runtime.key, undefined)
      const kind = runtime.own.accountFor(detail.providerID)?.kind
      const groupDefault = kind === undefined ? undefined : runtime.own.state.groupDefaults[kind]
      const models = providerModels(runtime, detail.providerID).map((model) => ({
        id: model.id,
        name: model.name,
        variants: model.variants.map((variant) => variant.id),
      }))
      const chosen = modelForAccount(current, models, groupDefault)
      // A just-added account's models may not be in the catalog yet: its group default (else the current model) then.
      const model = chosen ? { id: chosen.model.id, variant: chosen.variant } : (groupDefault ?? current)
      if (model)
        switcherControl.setNewSessionTarget(runtime.key, {
          providerID: detail.providerID,
          id: model.id,
          variant: model.variant,
        })
      router.navigate({ name: "home" })
      requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus())
    }
    // 18.5 `변경 3개 · 리뷰 →`, `/review`: the review tab of that session (navigating there first).
    const onReview = (event: Event) => {
      const detail = (event as CustomEvent<ReviewIntent>).detail
      const route = router.route()
      const here =
        route.name === "session" && route.serverKey === detail.serverKey && route.sessionID === detail.sessionID
      if (!here) router.navigate({ name: "session", serverKey: detail.serverKey, sessionID: detail.sessionID })
      shell.openTab("review")
    }
    // 18.7 `변경 보기` on the restore bar: the review tab's "files put back by restore" mode.
    const onRevertChanges = (event: Event) => {
      const detail = (event as CustomEvent<RevertViewChangesDetail>).detail
      openReview({ serverKey: detail.serverKey, sessionID: detail.sessionID, mode: "reverted" })
    }
    // 19.4 a file link, a tool card or the review's `파일 탭에서 열기`: that session's files tab (navigating there
    // first); the request itself waits in files/intents.ts until the tab (a lazy chunk) takes it.
    const onFile = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileRequest>).detail
      const route = router.route()
      const here =
        route.name === "session" && route.serverKey === detail.serverKey && route.sessionID === detail.sessionID
      if (!here) router.navigate({ name: "session", serverKey: detail.serverKey, sessionID: detail.sessionID })
      shell.openTab("files")
    }
    // 19.4 Ctrl+P and the palette: the files tab of the session on screen with the quick open box.
    const onQuickOpen = () => shell.openTab("files")
    window.addEventListener(INTENT.switcher, onSwitcher)
    window.addEventListener(INTENT.newSession, onNewSession)
    window.addEventListener(REVIEW_INTENT, onReview)
    window.addEventListener(REVERT_VIEW_CHANGES, onRevertChanges)
    window.addEventListener(FILE_INTENT, onFile)
    window.addEventListener(QUICK_OPEN_INTENT, onQuickOpen)
    const releaseTeamSettings = teamIntents.teamSettings.register((target) =>
      router.navigate(teamSettingsRoute(target)),
    )
    onCleanup(() => {
      releaseTeamSettings()
      window.removeEventListener(INTENT.switcher, onSwitcher)
      window.removeEventListener(INTENT.newSession, onNewSession)
      window.removeEventListener(REVIEW_INTENT, onReview)
      window.removeEventListener(REVERT_VIEW_CHANGES, onRevertChanges)
      window.removeEventListener(FILE_INTENT, onFile)
      window.removeEventListener(QUICK_OPEN_INTENT, onQuickOpen)
    })
  })

  return null
}
