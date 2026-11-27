// Subagent (child session) module entry (03 §18.11, gap 11):
//   - `SubagentBreadcrumb`: `계정 라우터 RPC 설계 › 하위 에이전트 explore` in the header title slot, every ancestor of a
//     nested subagent included; each ancestor navigates there.
//   - `ChildSessionNotice`: the disabled composer of a child session — `하위 에이전트 세션은 부모 세션이 제어합니다`,
//     `부모 세션으로`, the child's state and its waiting requests.
//   - `SubagentStrip`: in a parent session, the children that run or wait on the user, each with a `?` request badge
//     and `열기 →` (a child's request that nobody sees stops the turn, 18.1).
//   - `ChildRequestBadge`: `? n` for one session and its descendants (tool cards, breadcrumb).
// The child's own account chip, context meter and review stay as they are (18.11); only navigation and input differ.
// 07 §5.5, §7.3 자식 화면: the child's role chip `리뷰 · Claude 구독 · Opus 5.5 · high` (role, the account it runs on,
// its model and the effort it actually runs at, `(요청)` when the call asked for that effort, 07 §2.3) next to its
// state in the child's notice. The account is the one that signed the child's latest step (its ledger line, SL-8:
// several Claude accounts share `anthropic`), else the account the child's tree runs on.
//
// Wiring (integrator): the header renders `<SubagentBreadcrumb>` for child sessions (or keeps the transcript's
// `SessionTitle`, which covers one level); the composer shows `<ChildSessionNotice>` instead of its back link for child
// sessions; the main column places `<SubagentStrip>` above the dock (or inside it), `serverKey`/`sessionID` accessors.
import type { Ledger } from "@own/protocol"
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { roleKey } from "@/presets/session-view"
import { usePresetsBootText } from "@/presets/boot-strings"
import { useRouter } from "@/routing/router"
import { accountOf, catalog, modelName, variantName } from "@/switcher/labels"
import { childRowsOf, facts, familyRequests, latestLine, ownRequests, watchFamily } from "./data"
import { agentOf, ancestry, childState, requestedEffort, roleEffort, type ChildState } from "./model"
import { useSubagentText, type SubagentKey } from "./strings"
import "./subagent.css"

export { agentOf, ancestry, childRows, childState, taskTitle, type ChildRow, type ChildState } from "./model"
export { childRowsOf, familyRequests, ownRequests } from "./data"
export { subagentEn, subagentKo } from "./strings"

export interface SessionProps {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}

const STATE_SYMBOL: Record<ChildState, string> = {
  running: "●",
  succeeded: "✓",
  failed: "!",
  interrupted: "■",
  idle: "○",
}

function useSession(props: SessionProps) {
  const data = useData()
  const router = useRouter()
  const runtime = () => data.get(props.serverKey())
  const open = (sessionID: string) => router.navigate({ name: "session", serverKey: props.serverKey(), sessionID })
  return { runtime, open }
}

/**
 * `리뷰 · Claude 구독 · Opus 5.5 · high` (07 §5.5, §7.3): a child's role, the account its model runs on (the one that
 * signed its latest step, `signed`, else its tree's; a provider without an account by its id), the model and the effort
 * the child's own Ref carries (never what was asked: 07 §2.3 fits and may lower it). `(요청)` follows the effort when
 * the parent's call asked for one (`requestedEffort`, from the parent's loaded messages); a model without levels then
 * says so. `undefined` for an agent that is no preset role or a
 * child whose model is not known.
 */
function useRoleLine() {
  const i18n = useI18n()
  const text = useSubagentText()
  const names = usePresetsBootText()
  return (runtime: ServerRuntime, sessionID: string, agent: string | undefined, signed?: Ledger.Line) => {
    const key = roleKey(agent)
    const info = runtime.data.session.get(sessionID)
    const ref = info?.model ?? runtime.own.state.binding[sessionID]?.model
    if (!key || !ref) return undefined
    // SL-8: the provider names only the first of the Claude accounts on `anthropic`.
    const signer =
      signed?.providerID === ref.providerID && signed.accountID
        ? runtime.own.state.accounts[signed.accountID]
        : undefined
    const line = {
      role: names(key),
      account: (signer ?? accountOf(runtime, ref.providerID, sessionID))?.label ?? ref.providerID,
      model: modelName(runtime, ref),
    }
    const asked = info?.parentID
      ? requestedEffort(runtime.data.session.message.list(info.parentID), sessionID)
      : undefined
    const listed = catalog(runtime).find((model) => model.providerID === ref.providerID && model.id === ref.id)
    const part = roleEffort({
      ...(ref.variant === undefined ? {} : { variant: ref.variant }),
      ...(asked === undefined ? {} : { asked }),
      levels: listed?.variants.length ?? 0,
    })
    if (!part) return text("own.subagent.role", line)
    const effort = part.none ? text("own.subagent.effortNone") : variantName(i18n, part.variant)
    return text("own.subagent.roleEffort", {
      ...line,
      effort: part.asked ? text("own.subagent.effortRequested", { effort }) : effort,
    })
  }
}

/** `? n` when the session or one of its subagents waits on an approval or a question. */
export function ChildRequestBadge(props: { readonly serverKey: () => ServerKey; readonly sessionID: () => string }) {
  const data = useData()
  const text = useSubagentText()
  const count = () => {
    const runtime = data.get(props.serverKey())
    return runtime ? familyRequests(runtime, props.sessionID()) : 0
  }
  return (
    <Show when={count() > 0}>
      <span
        class="own-sa-badge"
        role="status"
        title={text("own.subagent.requests", { n: count() })}
        aria-label={text("own.subagent.requests", { n: count() })}
        data-testid="child-request-badge"
      >
        ? {count()}
      </span>
    </Show>
  )
}

/** Header title slot of a child session: every ancestor, the last segment is this subagent. */
export function SubagentBreadcrumb(props: SessionProps) {
  const i18n = useI18n()
  const text = useSubagentText()
  const session = useSession(props)
  watchFamily(session.runtime, props.sessionID)
  const chain = createMemo(() => {
    const runtime = session.runtime()
    const id = props.sessionID()
    return runtime && id ? ancestry((item) => facts(runtime, item), id) : []
  })
  // Ancestors the page never loaded (a deep link into a nested subagent): fetch the first unknown one; the chain grows.
  createEffect(() => {
    const runtime = session.runtime()
    const first = chain()[0]
    if (!runtime || !first || first.title !== undefined || runtime.connection.status() !== "connected") return
    untrack(() => void runtime.data.session.sync(first.id).catch(() => undefined))
  })
  const label = (item: { title?: string; agent?: string }, index: number) =>
    index === 0
      ? (item.title ?? i18n.t("own.shell.untitled"))
      : text("own.subagent.agent", { agent: agentOf(item) ?? text("own.subagent.fallbackAgent") })
  return (
    <Show when={chain().length > 1}>
      <nav class="own-sa-crumbs" aria-label={text("own.subagent.path")} data-testid="subagent-breadcrumb">
        <For each={chain()}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <span class="own-sa-sep" aria-hidden="true">
                  ›
                </span>
              </Show>
              <Show
                when={index() < chain().length - 1}
                fallback={
                  <span class="own-sa-crumb" aria-current="page">
                    {label(item, index())}
                  </span>
                }
              >
                <button type="button" class="own-sa-crumb own-sa-crumb-link" onClick={() => session.open(item.id)}>
                  {label(item, index())}
                </button>
              </Show>
            </>
          )}
        </For>
      </nav>
    </Show>
  )
}

/** The composer of a child session: disabled, with the way back to the parent (18.11). */
export function ChildSessionNotice(props: SessionProps) {
  const i18n = useI18n()
  const text = useSubagentText()
  const session = useSession(props)
  const info = () => {
    const runtime = session.runtime()
    const id = props.sessionID()
    return runtime && id ? facts(runtime, id) : undefined
  }
  const state = () => {
    const runtime = session.runtime()
    const id = props.sessionID()
    return childState(info(), !!runtime && !!id && runtime.data.session.status(id) === "running")
  }
  const waiting = () => {
    const runtime = session.runtime()
    const id = props.sessionID()
    return runtime && id ? ownRequests(runtime, id) : 0
  }
  const roleLine = useRoleLine()
  const signed = latestLine(session.runtime, props.sessionID)
  const role = () => {
    const runtime = session.runtime()
    const id = props.sessionID()
    return runtime && id ? roleLine(runtime, id, agentOf(info()), signed()) : undefined
  }
  return (
    <Show when={info()?.parentID}>
      {(parentID) => (
        <div class="own-sa-notice" role="note" data-testid="child-notice" data-state={state()}>
          <span class="own-sa-state" data-state={state()}>
            <span aria-hidden="true">{STATE_SYMBOL[state()]}</span>{" "}
            {text(`own.subagent.state.${state()}` as SubagentKey)}
          </span>
          <Show when={role()}>
            {(line) => (
              <span class="own-sw-tag" data-testid="child-role">
                {line()}
              </span>
            )}
          </Show>
          <span class="own-sa-notice-text">{i18n.t("own.child.composerDisabled")}</span>
          <button type="button" class="own-sa-back" data-testid="child-back" onClick={() => session.open(parentID())}>
            ← {i18n.t("own.child.backToParent")}
          </button>
          <Show when={waiting() > 0}>
            <p class="own-sa-notice-requests" role="status">
              {text("own.subagent.requestsHere", { n: waiting() })}
            </p>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Children of the open session that run or wait on the user, with `?` badges and `열기 →`. */
export function SubagentStrip(props: SessionProps & { readonly limit?: number }) {
  const text = useSubagentText()
  const session = useSession(props)
  const [expanded, setExpanded] = createSignal(false)
  watchFamily(session.runtime, props.sessionID)
  const view = createMemo(() => {
    const runtime = session.runtime()
    const id = props.sessionID()
    return runtime && id ? childRowsOf(runtime, id) : { rows: [], active: false }
  })
  const limit = () => props.limit ?? 3
  const visible = () => {
    const active = view().rows.filter((row) => row.requests > 0 || row.state === "running")
    return expanded() ? active : active.slice(0, limit())
  }
  const hidden = () =>
    Math.max(0, view().rows.filter((row) => row.requests > 0 || row.state === "running").length - limit())
  return (
    <Show when={view().active}>
      <section
        class="own-sa-strip"
        aria-label={text("own.subagent.title", { n: view().rows.length })}
        data-testid="subagent-strip"
      >
        <For each={visible()}>
          {(row) => (
            <div class="own-sa-row" data-testid="subagent-row" data-state={row.state} data-session-id={row.id}>
              <span class="own-sa-state" data-state={row.state} aria-hidden="true">
                {STATE_SYMBOL[row.state]}
              </span>
              <b class="own-sa-agent">
                {text("own.subagent.agent", { agent: row.agent ?? text("own.subagent.fallbackAgent") })}
              </b>
              <span class="own-sa-task" title={row.task}>
                {row.task}
              </span>
              <Show when={row.requests > 0}>
                <span
                  class="own-sa-badge"
                  role="status"
                  aria-label={text("own.subagent.requests", { n: row.requests })}
                  data-testid="child-request-badge"
                >
                  ? {row.requests}
                </span>
              </Show>
              <button
                type="button"
                class="own-sa-open"
                data-testid="subagent-open"
                aria-label={text("own.subagent.openNamed", { agent: row.agent ?? text("own.subagent.fallbackAgent") })}
                onClick={() => session.open(row.id)}
              >
                {text("own.subagent.open")}
              </button>
            </div>
          )}
        </For>
        <Show when={hidden() > 0 || expanded()}>
          <button type="button" class="own-sa-more" onClick={() => setExpanded((value) => !value)}>
            {expanded() ? text("own.subagent.less") : text("own.subagent.more", { n: hidden() })}
          </button>
        </Show>
      </section>
    </Show>
  )
}

/** Whether a session is a subagent session (composer disabled, 18.11). */
export function isChildSession(runtime: ServerRuntime | undefined, sessionID: string | undefined) {
  return !!(runtime && sessionID && facts(runtime, sessionID)?.parentID)
}
