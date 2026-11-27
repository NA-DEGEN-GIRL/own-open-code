// 설정 > 승인·권한 (03 §5.7, lazy): the new-session default approval mode (5.1, 18.8), the files and folders agents
// cannot open (01 §13, PP, protected/section.tsx), the saved "항상 허용" rules with
// `취소` (`GET /api/permission/saved`, `DELETE /api/permission/saved/:id`, packages/protocol/src/groups/permission.ts:
// 37-60), and a link to 설정 > 웹 검색, where the server's web search service is chosen (18.2, moved there 2026-10-19).
import type { PermissionSavedInfo } from "@opencode/client"
import { createEffect, createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { LOCAL, useData, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { current, serviceName } from "@/websearch/services"
import { webSearchInfo } from "@/websearch/state"
import { useWebSearchText } from "@/websearch/strings"
import { createModeChoice, MODE_KEY, MODES, newSessionApproval } from "./approval"
import { ProtectedPathsSection } from "./protected/section"
import { actionKind } from "./describe"
import { useRequestsText } from "./strings"
import "./requests.css"

export default function ApprovalSettings() {
  const data = useData()
  const runtime = () => data.get(LOCAL)
  return (
    <div data-testid="settings-approval">
      <NewSessionMode />
      <ProtectedPathsSection />
      <Show when={runtime()}>{(current) => <SavedRules runtime={current()} />}</Show>
      <Show when={runtime()}>{(current) => <WebSearchLink runtime={current()} />}</Show>
    </div>
  )
}

function NewSessionMode() {
  const i18n = useI18n()
  const text = useRequestsText()
  const choice = createModeChoice((mode) => newSessionApproval.set(mode))
  return (
    <section class="own-as-section" aria-labelledby="own-as-new">
      <h2 id="own-as-new">{text("own.requests.approval.newSession")}</h2>
      <p class="own-rq-note">{text("own.requests.approval.newSessionNote")}</p>
      <div class="own-as-modes" role="radiogroup" aria-labelledby="own-as-new">
        <For each={MODES}>
          {(mode) => (
            <button
              type="button"
              class="own-as-mode"
              role="radio"
              aria-checked={newSessionApproval.value() === mode}
              data-mode={mode}
              data-testid={`settings-approval-${mode}`}
              onClick={() => void choice.choose(mode)}
            >
              <b class="text-[13px]">{i18n.t(MODE_KEY[mode])}</b>
              <span class="own-rq-option-desc">
                {mode === "read-only"
                  ? i18n.t("own.approval.readOnlyNote")
                  : mode === "full"
                    ? i18n.t("own.approval.fullWarn")
                    : text("own.requests.approval.askNote")}
              </span>
            </button>
          )}
        </For>
      </div>
      <Show when={choice.confirming()}>
        <div class="own-am-confirm" role="alertdialog" data-testid="settings-approval-confirm">
          <p class="own-rq-warn">{i18n.t("own.approval.fullWarn")}</p>
          <div class="own-rq-actions justify-start">
            <button type="button" class="own-rq-btn" data-variant="ghost" onClick={() => choice.cancel()}>
              {text("own.requests.approval.cancel")}
            </button>
            <button type="button" class="own-rq-btn" data-variant="primary" onClick={() => void choice.confirm()}>
              {text("own.requests.approval.confirm")}
            </button>
          </div>
        </div>
      </Show>
    </section>
  )
}

/** Saved rules of every project (`projectID` omitted), newest first; `취소` removes one (asks again next time). */
function SavedRules(props: { readonly runtime: ServerRuntime }) {
  const i18n = useI18n()
  const text = useRequestsText()
  const [removed, setRemoved] = createStore<Record<string, boolean | undefined>>({})
  const connected = () => props.runtime.connection.status() === "connected"
  const [rules, { refetch }] = createResource(connected, async (online) => {
    if (!online) return undefined
    const list = await props.runtime.client().permission.saved.list({})
    return [...list].sort((a, b) => Number(b.time.updated) - Number(a.time.updated))
  })
  // A reply "always" in any window adds rules; there is no saved-rule event, so refresh when one is answered.
  createEffect(() => {
    onCleanup(
      props.runtime.bus.on("permission.replied", (event) => {
        if (event.data.reply === "always") void refetch()
      }),
    )
  })
  const visible = createMemo(() => (rules() ?? []).filter((rule) => !removed[rule.id]))
  const project = (rule: PermissionSavedInfo) => {
    const known = props.runtime.sessions.state.projects[rule.projectID]
    if (known) return known.name || baseName(known.directory)
    const info = props.runtime.data.project.get(rule.projectID)
    return info?.name || (info ? baseName(info.canonical) : rule.projectID)
  }
  const action = (rule: PermissionSavedInfo) => {
    const kind = actionKind(rule.action)
    return kind === "other" ? rule.action : text(`own.requests.noun.${kind}`)
  }

  async function remove(rule: PermissionSavedInfo) {
    setRemoved(rule.id, true)
    try {
      await props.runtime.client().permission.saved.remove({ id: rule.id })
      showToast({ message: text("own.requests.saved.removed") })
    } catch (error) {
      console.error("[own-web] permission.saved.remove failed", error)
      setRemoved(rule.id, undefined)
      showToast({ message: text("own.requests.saved.removeFailed"), tone: "danger" })
    }
  }

  return (
    <section class="own-as-section" aria-labelledby="own-as-saved" data-testid="saved-rules">
      <h2 id="own-as-saved">{i18n.t("own.perm.savedTitle")}</h2>
      <p class="own-rq-note">{text("own.requests.saved.note")}</p>
      <Show when={!rules.loading || rules()} fallback={<p class="own-rq-note">{text("own.requests.saved.loading")}</p>}>
        <Show when={!rules.error} fallback={<p class="own-rq-problem">{text("own.requests.saved.loadFailed")}</p>}>
          <Show
            when={visible().length > 0}
            fallback={
              <p class="own-rq-note" data-testid="saved-rules-empty">
                {text("own.requests.saved.empty")}
              </p>
            }
          >
            <ul class="own-as-rules">
              <li class="own-as-rule" data-head aria-hidden="true">
                <span>{text("own.requests.saved.action")}</span>
                <span>{text("own.requests.saved.resource")}</span>
                <span>{text("own.requests.saved.project")}</span>
                <span />
              </li>
              <For each={visible()}>
                {(rule) => (
                  <li class="own-as-rule" data-testid="saved-rule" data-rule-id={rule.id}>
                    <span>{action(rule)}</span>
                    <span class="own-as-mono">{rule.resource}</span>
                    <span class="truncate text-own-muted">{project(rule)}</span>
                    <button
                      type="button"
                      class="own-rq-btn"
                      data-variant="ghost"
                      data-testid="saved-rule-remove"
                      aria-label={text("own.requests.saved.remove", { resource: rule.resource })}
                      onClick={() => void remove(rule)}
                    >
                      {i18n.t("own.perm.savedRemove")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </Show>
    </section>
  )
}

/**
 * 18.2: the web search service moved to its own page, 설정 > 웹 검색 (WM 2026-10-19); this section names the service in
 * use and leads there, for whoever still looks for it here.
 */
function WebSearchLink(props: { readonly runtime: ServerRuntime }) {
  const i18n = useI18n()
  const text = useWebSearchText()
  const router = useRouter()
  const info = webSearchInfo(props.runtime)
  const directory = () => props.runtime.entry()?.controlDir ?? props.runtime.sessions.directories()[0]
  const name = () => {
    const listed = info.listed(directory())
    const state = info.state()
    if (!listed || !state) return undefined
    const now = current(state.choice, listed)
    if (now.type === "service") return serviceName(now.id, listed)
    if (now.type === "any") return text("own.ws.any")
    if (now.type === "multi") return text("own.ws.mode.multi")
    if (now.type === "off") return text("own.ws.now.off")
    return text("own.ws.now.unset")
  }
  return (
    <section class="own-as-section" aria-labelledby="own-as-websearch" data-testid="settings-websearch-link">
      <h2 id="own-as-websearch">{i18n.t("own.settings.websearch")}</h2>
      <p class="own-rq-note">
        {text("own.ws.moved")}
        <Show when={name()}>
          {(value) => (
            <>
              {" "}
              <span data-testid="settings-websearch-link-now">
                {text("own.ws.now")}: {value()}
              </span>
            </>
          )}
        </Show>
      </p>
      <div class="own-rq-actions justify-start">
        <button
          type="button"
          class="own-rq-btn"
          data-testid="settings-websearch-open"
          onClick={() => router.navigate({ name: "settings", section: "websearch" })}
        >
          {text("own.ws.open")} →
        </button>
      </div>
    </section>
  )
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
