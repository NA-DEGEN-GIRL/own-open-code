// CompactionImpactDialog (03 §5.8.4 step 3–5): the sessions a new threshold would compact at their next step, from
// the `dryRun` answer. `그대로 적용` saves; `먼저 지금 기준으로 압축한 뒤 적용` first sends `POST /compact` for the chosen
// sessions (still under the old threshold, so the summary budget is the old one), waits for their
// `session.compaction.ended`, then saves. Sessions with a staged revert are never chosen by default (`POST /compact`
// would commit the revert). A failed compaction keeps its row and asks again.
import type { Compaction } from "@own/protocol"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { errorMessage } from "@/accounts/errors"
import { tokens } from "@/limits/format"
import { Dialog, Spinner, createStatus, StatusLine } from "@/limits/kit"

export interface ImpactRequest {
  /** Row name for messages. */
  readonly label: string
  /** The same write with and without `dryRun`; resolves the router's `compactionImpact`. */
  readonly run: (dryRun: boolean) => Promise<Compaction.Impact | undefined>
  readonly onError?: (error: unknown) => void
  /** The `dryRun` answer that opened the dialog. */
  readonly impact?: Compaction.Impact
}

export function CompactionImpactDialog(props: {
  readonly request: ImpactRequest | undefined
  /** `applied`: sessions the saved setting compacts next; `undefined` when cancelled. */
  readonly onClose: (applied: number | undefined) => void
}) {
  return (
    <Show when={props.request?.impact}>
      {(impact) => <ImpactForm request={props.request!} impact={impact()} onClose={props.onClose} />}
    </Show>
  )
}

function ImpactForm(props: {
  readonly request: ImpactRequest
  readonly impact: Compaction.Impact
  readonly onClose: (applied: number | undefined) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const local = data.local()
  const own = local.own
  const [chosen, setChosen] = createStore<Record<string, boolean>>(
    Object.fromEntries(props.impact.sessions.map((session) => [session.sessionID, !session.revertStaged])),
  )
  const [progress, setProgress] = createStore<{ total: number; done: string[]; failed: string[] }>({
    total: 0,
    done: [],
    failed: [],
  })
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const listeners: (() => void)[] = []
  onCleanup(() => listeners.splice(0).forEach((unsubscribe) => unsubscribe()))
  const truncates = () => props.impact.sessions.some((session) => session.truncates)
  const selected = () =>
    props.impact.sessions.filter((session) => chosen[session.sessionID]).map((session) => session.sessionID)
  const running = () => progress.total > 0 && progress.done.length + progress.failed.length < progress.total

  const apply = async () => {
    if (busy()) return
    setBusy(true)
    status.clear()
    await props.request
      .run(false)
      .then((final) => props.onClose(final?.sessions.length ?? 0))
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }

  const compactFirst = async () => {
    const ids = selected()
    if (!ids.length || busy()) return
    const pending = new Set<string>(ids)
    setProgress({ total: ids.length, done: [], failed: [] })
    const finish = (sessionID: string, ok: boolean) => {
      if (!pending.delete(sessionID)) return
      setProgress(ok ? "done" : "failed", (list) => [...list, sessionID])
      if (pending.size) return
      stop()
      if (progress.failed.length)
        return status.error(i18n.t("own.set.compactFailedRows", { n: progress.failed.length }))
      void apply()
    }
    listeners.push(
      local.bus.on("session.compaction.ended", (event) => finish(event.data.sessionID, true)),
      local.bus.on("session.compaction.failed", (event) => finish(event.data.sessionID, false)),
    )
    const stop = () => listeners.splice(0).forEach((unsubscribe) => unsubscribe())
    for (const sessionID of ids)
      await local
        .client()
        .session.compact({ sessionID })
        .catch(() => finish(sessionID, false))
  }

  return (
    <Dialog
      open
      title={i18n.t("own.compact.impactTitle")}
      onClose={() => props.onClose(undefined)}
      size="wide"
      testid="compaction-impact"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose(undefined)}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant={truncates() ? undefined : "primary"}
            disabled={busy() || running()}
            onClick={() => void apply()}
            data-testid="impact-apply"
          >
            {i18n.t("own.compact.applyAnyway")}
          </button>
          <Show when={own.rpc.can("prompt")}>
            <button
              type="button"
              class="own-btn"
              data-variant={truncates() ? "primary" : undefined}
              disabled={busy() || running() || !selected().length}
              onClick={() => void compactFirst()}
              data-testid="impact-compact-first"
            >
              <Show when={running()}>
                <Spinner />
              </Show>
              {running()
                ? i18n.t("own.compact.compactFirstProgress", {
                    k: progress.done.length + progress.failed.length,
                    n: progress.total,
                  })
                : i18n.t("own.compact.compactFirst")}
            </button>
          </Show>
        </>
      }
    >
      <p class="m-0 mb-2 text-own-muted">{i18n.t("own.set.impactLead", { name: props.request.label })}</p>
      <table class="own-tbl">
        <thead>
          <tr>
            <th scope="col">
              <span class="sr-only">{i18n.t("own.compact.compactFirst")}</span>
            </th>
            <th scope="col">{i18n.t("own.lim.col.session")}</th>
            <th scope="col" class="own-r">
              {i18n.t("own.set.impactNow")}
            </th>
            <th scope="col" class="own-r">
              {i18n.t("own.set.impactNew")}
            </th>
            <th scope="col">{i18n.t("own.set.impactNote")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.impact.sessions}>
            {(session) => (
              <tr data-testid="impact-row" data-failed={progress.failed.includes(session.sessionID) ? "" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={i18n.t("own.compact.compactFirst")}
                    checked={chosen[session.sessionID]}
                    disabled={running()}
                    onChange={(event) => setChosen(session.sessionID, event.currentTarget.checked)}
                  />
                </td>
                <td class="max-w-[260px] truncate">
                  {local.sessions.state.sessions[session.sessionID]?.title || session.sessionID}
                </td>
                <td class="own-r">{tokens(session.P)}</td>
                <td class="own-r">{tokens(session.triggerTokens)}</td>
                <td class="text-[12px]">
                  <Show when={session.truncates}>
                    <span class="block text-own-warn">{i18n.t("own.compact.impactTruncates")}</span>
                  </Show>
                  <Show when={session.revertStaged}>
                    <span class="block text-own-warn">{i18n.t("own.compact.impactRevert")}</span>
                  </Show>
                  <Show when={progress.done.includes(session.sessionID)}>
                    <span class="block text-own-ok">✓ {i18n.t("own.set.compacted")}</span>
                  </Show>
                  <Show when={progress.failed.includes(session.sessionID)}>
                    <span class="block text-own-danger">{i18n.t("own.set.compactFailed")}</span>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <StatusLine status={status} />
    </Dialog>
  )
}
