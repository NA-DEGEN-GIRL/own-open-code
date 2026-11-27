// 설정 > 실험 > 컴퓨터 사용 (01 §10.2, 03 §5.7, lazy): the local service's `own.computer` status (driver, helper,
// app policy, the session holding the desktop, apps approved per session), the Stop button (kill switch for every
// session) and its reset, a helper restart, and the recent audit lines. The per-session switch lives in the session
// (`⋯` > 이 세션에서 컴퓨터 사용); this page only says where.
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { LOCAL, useData, type ComputerAuditEntry, type ComputerStatus } from "@/data"
import { useI18n } from "@/i18n"
import { createStatus, Notice, StatusLine, Tag } from "@/limits/kit"
import { RouteLink } from "@/routing/router"
import { computerStore, type ComputerStore } from "./state"
import { usePanelText, type PanelKey } from "./panel-strings"

const AUDIT_LIMIT = 20
/** Action events arrive per call; the audit list reloads at most this often while the page is open. */
const AUDIT_COALESCE_MS = 1_000

export default function ComputerSettings() {
  const i18n = useI18n()
  const text = usePanelText()
  // Asked again on open: the helper may have started or stopped since the last event.
  createEffect(on(computerStore, (store) => store?.refresh()))
  return (
    <div class="flex flex-col" data-testid="settings-experimental">
      <section class="own-psec !mt-0" data-testid="computer-panel">
        <div class="own-psec-head">
          <h2>{i18n.t("own.set.computerUse")}</h2>
          <span class="ml-auto">
            <StateTag />
          </span>
        </div>
        <p class="m-0 text-[12.5px] text-own-muted">{text("own.computer.intro")}</p>
        <Show when={computerStore()} fallback={<p class="own-placeholder px-0">{text("own.computer.loading")}</p>}>
          {(store) => (
            <Switch fallback={<p class="own-placeholder px-0">{text("own.computer.loading")}</p>}>
              <Match when={store().state.load === "missing"}>
                <div class="mt-3">
                  <Notice tone="warn" testid="computer-missing">
                    {text("own.computer.missing")}
                    <Show when={store().state.error}>
                      {(type) => <span class="own-mono ml-1 text-[11.5px] text-own-faint">({type()})</span>}
                    </Show>
                  </Notice>
                </div>
              </Match>
              <Match when={store().state.status?.available === false && store().state.status}>
                {(status) => (
                  <div class="mt-3">
                    <Notice tone="warn" testid="computer-unavailable">
                      {status().reason
                        ? text(`own.computer.reason.${status().reason!}`)
                        : text("own.computer.unavailable")}
                    </Notice>
                  </div>
                )}
              </Match>
              <Match when={store().state.status?.available && store().state.status}>
                {(status) => <Available store={store()} status={status()} />}
              </Match>
            </Switch>
          )}
        </Show>
      </section>
    </div>
  )
}

function StateTag() {
  const text = usePanelText()
  const state = () => {
    const store = computerStore()
    if (!store || store.state.load === "idle" || store.state.load === "loading") return undefined
    if (store.state.status?.killSwitch?.engaged) return "stopped" as const
    return store.available() ? ("available" as const) : ("unavailable" as const)
  }
  return (
    <Show when={state()}>
      {(current) => (
        <Tag tone={current() === "available" ? "ok" : "danger"} testid="computer-state-tag">
          {text(
            current() === "available"
              ? "own.computer.available"
              : current() === "stopped"
                ? "own.computer.stopped"
                : "own.computer.unavailable",
          )}
        </Tag>
      )}
    </Show>
  )
}

function Available(props: { readonly store: ComputerStore; readonly status: ComputerStatus }) {
  const data = useData()
  const i18n = useI18n()
  const text = usePanelText()
  const status = createStatus()
  const titleOf = (sessionID: string) =>
    data.local().data.session.get(sessionID)?.title ?? data.local().sessions.state.sessions[sessionID]?.title
  const run = (action: () => Promise<unknown>, done?: PanelKey) => {
    status.clear()
    return action().then(
      () => done && status.ok(text(done)),
      (error: unknown) =>
        status.error(text("own.computer.actionFailed", { message: error instanceof Error ? error.message : "" })),
    )
  }
  const killSwitch = () => props.status.killSwitch
  const helper = () => props.status.helper
  const policy = () => props.status.policy
  const list = (apps: readonly string[] | undefined, empty: PanelKey) => (apps?.length ? apps.join(", ") : text(empty))
  const at = (ms: number) => new Date(ms).toLocaleString(i18n.locale())
  return (
    <div class="mt-3 flex flex-col gap-4 text-[13px]">
      <Show
        when={killSwitch()?.engaged && killSwitch()}
        fallback={
          <Show when={props.store.allowed("killswitch.engage")}>
            <div class="flex flex-wrap items-center gap-3">
              <button
                type="button"
                class="own-btn px-5 text-[14px] font-semibold"
                data-variant="danger"
                data-testid="computer-stop-all"
                onClick={() => void run(() => props.store.engage())}
              >
                {text("own.computer.stopAll")}
              </button>
              <p class="m-0 min-w-[220px] flex-1 text-[12px] text-own-muted">{text("own.computer.stopAllNote")}</p>
            </div>
          </Show>
        }
      >
        {(engaged) => (
          <Notice tone="danger" testid="computer-stopped">
            <div class="flex flex-wrap items-center gap-2">
              <span class="min-w-0 flex-1">
                {text("own.computer.stoppedBy", {
                  reason: text(`own.computer.killReason.${engaged().reason ?? "rpc"}`),
                  at: engaged().at ? at(engaged().at!) : "—",
                })}
              </span>
              <Show when={props.store.allowed("killswitch.reset")}>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="computer-reset"
                  onClick={() => void run(() => props.store.reset())}
                >
                  {text("own.computer.reset")}
                </button>
              </Show>
            </div>
            <p class="m-0 mt-1 text-[12px]">{text("own.computer.resetNote")}</p>
          </Notice>
        )}
      </Show>

      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5" data-testid="computer-status">
        <Row label={text("own.computer.version")}>
          <span class="own-mono">
            {props.status.version} <span class="text-own-faint">({props.status.buildId})</span>
          </span>
        </Row>
        <Row label={text("own.computer.driver")}>
          {props.status.driver ? text(`own.computer.driver.${props.status.driver}`) : "—"}
        </Row>
        <Row label={text("own.computer.helper")}>
          <span class="flex flex-wrap items-center gap-2">
            <span data-testid="computer-helper">
              {helper()?.running
                ? text("own.computer.helperRunning", {
                    version: helper()?.version ?? "—",
                    protocol: helper()?.protocol ?? "—",
                  })
                : text("own.computer.helperIdle")}
            </span>
            <Show when={helper()?.running && props.store.allowed("helper.restart")}>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                onClick={() => void run(() => props.store.restartHelper(), "own.computer.helperRestarted")}
              >
                {text("own.computer.helperRestart")}
              </button>
            </Show>
          </span>
        </Row>
        <Show when={helper()?.running && helper()?.killChord !== undefined}>
          <Row label={text("own.computer.killChord")}>
            <Show
              when={helper()?.killChord}
              fallback={
                <span class="text-own-warn" data-testid="computer-kill-chord-missing">
                  {text("own.computer.killChordMissing")}
                </span>
              }
            >
              {text("own.computer.killChordOk")}
            </Show>
          </Row>
        </Show>
        <Row label={text("own.computer.approval")}>
          {text(
            props.status.approval === "question" ? "own.computer.approval.question" : "own.computer.approval.session",
          )}
        </Row>
        <Row label={text("own.computer.allowApps")}>
          <span class="own-mono" data-testid="computer-allow-apps">
            {list(policy()?.allowApps, "own.computer.allowAll")}
          </span>
        </Row>
        <Row label={text("own.computer.denyApps")}>
          <span class="own-mono">{list(policy()?.denyApps, "own.computer.none")}</span>
        </Row>
        <Row label={text("own.computer.terminals")}>
          {text(policy()?.allowTerminals ? "own.computer.allowed" : "own.computer.denied")}
        </Row>
        <Row label={text("own.computer.subagents")}>
          {text(policy()?.allowSubagents ? "own.computer.allowed" : "own.computer.denied")}
        </Row>
        <Row label={text("own.computer.lease")}>
          <Show when={props.status.lease?.holder} fallback={text("own.computer.none")}>
            {(holder) => <SessionLink sessionID={holder()} title={titleOf(holder())} />}
          </Show>
        </Row>
      </dl>

      <Show when={props.status.approval === "question" || props.status.grants?.length}>
        <section>
          <h3 class="m-0 mb-1.5 text-[13px] font-semibold">{text("own.computer.grants")}</h3>
          <For
            each={props.status.grants ?? []}
            fallback={<p class="m-0 text-[12.5px] text-own-faint">{text("own.computer.none")}</p>}
          >
            {(grant) => (
              <div class="flex flex-wrap items-center gap-2 py-1" data-testid="computer-grant">
                <SessionLink sessionID={grant.sessionID} title={titleOf(grant.sessionID)} />
                <span class="own-mono min-w-0 flex-1 truncate text-[12px]">{grant.apps.join(", ")}</span>
                <Show when={props.store.allowed("session.grants.revoke")}>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    onClick={() => void run(() => props.store.revoke(grant.sessionID))}
                  >
                    {text("own.computer.revoke")}
                  </button>
                </Show>
              </div>
            )}
          </For>
        </section>
      </Show>

      <StatusLine status={status} testid="computer-status-line" />

      <Show when={props.store.allowed("audit.list")}>
        <Audit store={props.store} titleOf={titleOf} />
      </Show>
    </div>
  )
}

function Audit(props: { readonly store: ComputerStore; readonly titleOf: (sessionID: string) => string | undefined }) {
  const i18n = useI18n()
  const text = usePanelText()
  const [entries, setEntries] = createSignal<readonly ComputerAuditEntry[]>()
  const [failed, setFailed] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  const load = () =>
    props.store.audit({ limit: AUDIT_LIMIT }).then(
      (next) => {
        setFailed(false)
        setEntries(next)
      },
      () => setFailed(true),
    )
  void load()
  onCleanup(
    props.store.onAction(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), AUDIT_COALESCE_MS)
    }),
  )
  onCleanup(() => clearTimeout(timer))
  const tone = (outcome: ComputerAuditEntry["outcome"]) =>
    outcome === "ok" ? ("ok" as const) : outcome === "denied" ? ("warn" as const) : ("danger" as const)
  return (
    <section data-testid="computer-audit">
      <div class="mb-1.5 flex items-center gap-2">
        <h3 class="m-0 text-[13px] font-semibold">{text("own.computer.audit")}</h3>
        <button type="button" class="own-btn ml-auto" data-size="sm" onClick={() => void load()}>
          {text("own.computer.refresh")}
        </button>
      </div>
      <p class="m-0 mb-2 text-[12px] text-own-muted">{text("own.computer.auditNote")}</p>
      <Show when={!failed()} fallback={<p class="m-0 text-[12.5px] text-own-danger">{text("own.computer.failed")}</p>}>
        <Show when={entries()} fallback={<p class="own-placeholder px-0">{text("own.computer.loading")}</p>}>
          {(list) => (
            <Show
              when={list().length}
              fallback={<p class="m-0 text-[12.5px] text-own-faint">{text("own.computer.auditEmpty")}</p>}
            >
              <table class="own-tbl">
                <thead>
                  <tr>
                    <th scope="col">{text("own.computer.col.time")}</th>
                    <th scope="col">{text("own.computer.col.session")}</th>
                    <th scope="col">{text("own.computer.col.tool")}</th>
                    <th scope="col">{text("own.computer.col.app")}</th>
                    <th scope="col">{text("own.computer.col.result")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={list()}>
                    {(entry) => (
                      <tr data-testid="computer-audit-row" data-outcome={entry.outcome}>
                        <td class="own-mono whitespace-nowrap text-[12px]">
                          {new Date(entry.ts).toLocaleTimeString(i18n.locale())}
                        </td>
                        <td class="max-w-[180px] truncate">
                          <SessionLink sessionID={entry.sessionID} title={props.titleOf(entry.sessionID)} />
                        </td>
                        <td class="own-mono text-[12px]">{entry.tool}</td>
                        <td class="own-mono text-[12px]">{entry.target?.app ?? "—"}</td>
                        <td>
                          <Tag tone={tone(entry.outcome)}>
                            {text(`own.computer.outcome.${entry.outcome}`)}
                            {entry.code ? ` · ${entry.code}` : ""}
                          </Tag>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          )}
        </Show>
      </Show>
    </section>
  )
}

function Row(props: { readonly label: string; readonly children: JSX.Element }) {
  return (
    <>
      <dt class="text-own-muted">{props.label}</dt>
      <dd class="m-0 min-w-0">{props.children}</dd>
    </>
  )
}

function SessionLink(props: { readonly sessionID: string; readonly title: string | undefined }) {
  return (
    <RouteLink
      to={{ name: "session", serverKey: LOCAL, sessionID: props.sessionID }}
      class="own-target text-own-accent-text no-underline hover:underline"
      title={props.sessionID}
    >
      {props.title ?? props.sessionID}
    </RouteLink>
  )
}
