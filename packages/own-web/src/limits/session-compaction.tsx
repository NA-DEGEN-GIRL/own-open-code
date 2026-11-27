// "이 세션 압축 설정" (03 §5.8.5, SessionCompactionDialog): a session can only compact earlier than its account·model
// point. Range `[floorTokens, slotTriggerTokens)` of `cache.state.compaction`, checked before sending with the same
// wording the server's `setting_out_of_range` gets. `null` = follow the account·model setting.
import type { Compaction } from "@own/protocol"
import { createSignal, Show } from "solid-js"
import { OwnRpcError, useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { grouped, parseTokens, tokens } from "./format"
import { Dialog, Notice, Spinner, TextField } from "./kit"
import { SOURCE_LABEL } from "./meter"

export interface SessionCompactionProps {
  readonly open: boolean
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly compaction: Compaction.View
  readonly onClose: () => void
}

/** The form state starts from the values current when it opens. */
export function SessionCompactionDialog(props: SessionCompactionProps) {
  return (
    <Show when={props.open}>
      <SessionCompactionForm {...props} />
    </Show>
  )
}

function SessionCompactionForm(props: SessionCompactionProps) {
  const data = useData()
  const i18n = useI18n()
  const own = () => data.get(props.serverKey)?.own
  const [mode, setMode] = createSignal<"follow" | "earlier">(
    props.compaction.sessionTriggerTokens === null ? "follow" : "earlier",
  )
  const [text, setText] = createSignal(
    grouped(
      props.compaction.sessionTriggerTokens ??
        Math.max(props.compaction.floorTokens, Math.round(props.compaction.slotTriggerTokens * 0.8)),
    ),
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const value = () => parseTokens(text())
  const problem = () => {
    if (mode() === "follow") return undefined
    const tokensValue = value()
    if (tokensValue === undefined) return i18n.t("own.lim.numberNeeded")
    if (tokensValue >= props.compaction.slotTriggerTokens)
      return i18n.t("own.compact.sessionOnlyEarlier", { tokens: tokens(props.compaction.slotTriggerTokens) })
    if (tokensValue < props.compaction.floorTokens)
      return i18n.t("own.compact.sessionFloor", { tokens: tokens(props.compaction.floorTokens) })
    return undefined
  }
  const dueNow = () => {
    const tokensValue = value()
    return (
      mode() === "earlier" &&
      tokensValue !== undefined &&
      props.compaction.P !== null &&
      props.compaction.P >= tokensValue
    )
  }

  const save = async () => {
    const store = own()
    if (!store || problem() || busy()) return
    setBusy(true)
    setError(undefined)
    const triggerTokens = mode() === "follow" ? null : (value() ?? null)
    await store.rpc
      .call("compaction.setSession", { sessionID: props.sessionID, triggerTokens })
      .then(() => props.onClose())
      .catch((failure: unknown) => setError(errorText(failure)))
    setBusy(false)
  }

  const errorText = (failure: unknown) => {
    if (failure instanceof OwnRpcError && failure.type === "setting_out_of_range") {
      const range = failure.data as { min?: number | null; max?: number | null } | undefined
      return i18n.t("own.compact.outOfRange", {
        min: range?.min === null || range?.min === undefined ? "—" : tokens(range.min),
        max: range?.max === null || range?.max === undefined ? "—" : tokens(range.max),
      })
    }
    return i18n.t("own.lim.failed", { reason: failure instanceof Error ? failure.message : String(failure) })
  }

  return (
    <Dialog
      open
      title={i18n.t("own.lim.sessionCompactionTitle")}
      onClose={() => props.onClose()}
      testid="session-compaction-dialog"
      footer={
        <>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={!!problem() || busy()}
            data-testid="session-compaction-save"
            onClick={() => void save()}
          >
            <Show when={busy()}>
              <Spinner />
            </Show>
            {i18n.t("own.kit.save")}
          </button>
        </>
      }
    >
      <p class="m-0 mb-3 text-own-muted">
        {i18n.t("own.lim.sessionCompactionNow", {
          tokens: tokens(props.compaction.triggerTokens),
          source: i18n.t(SOURCE_LABEL[props.compaction.source]),
          model: props.compaction.modelID,
        })}
      </p>
      <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
        <legend class="sr-only">{i18n.t("own.lim.sessionCompactionTitle")}</legend>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            name="session-compaction"
            checked={mode() === "follow"}
            onChange={() => setMode("follow")}
            data-testid="session-compaction-follow"
          />
          {i18n.t("own.lim.sessionFollow", { tokens: tokens(props.compaction.slotTriggerTokens) })}
        </label>
        <label class="flex items-center gap-2">
          <input
            type="radio"
            name="session-compaction"
            checked={mode() === "earlier"}
            onChange={() => setMode("earlier")}
            data-testid="session-compaction-earlier"
          />
          {i18n.t("own.lim.sessionEarlier")}
        </label>
        <div class="pl-6">
          <TextField
            label={i18n.t("own.lim.sessionTokens")}
            value={text()}
            onValue={setText}
            onEnter={() => void save()}
            inputMode="numeric"
            disabled={mode() !== "earlier"}
            error={problem()}
            hint={i18n.t("own.lim.sessionRange", {
              min: grouped(props.compaction.floorTokens),
              max: grouped(props.compaction.slotTriggerTokens - 1),
            })}
            testid="session-compaction-input"
          />
        </div>
      </fieldset>
      <Show when={dueNow()}>
        <p class="m-0 mt-2 text-[12.5px] text-own-warn">{i18n.t("own.ctx.dueNext")}</p>
      </Show>
      <p class="m-0 mt-3 text-[12px] leading-[18px] text-own-muted">
        {i18n.t("own.compact.sessionLimit", { tokens: tokens(props.compaction.slotTriggerTokens) })}
      </p>
      <p class="m-0 mt-1 text-[12px] leading-[18px] text-own-muted">{i18n.t("own.ctx.cacheNote")}</p>
      <Show when={error()}>
        {(message) => (
          <div class="mt-3">
            <Notice tone="danger">{message()}</Notice>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
