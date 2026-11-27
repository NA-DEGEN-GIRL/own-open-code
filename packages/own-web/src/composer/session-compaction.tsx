// "이 세션 압축 설정" (03 §5.8.5), a lazy dialog: the only per-session choice is to compact earlier than the
// account/model point. Range `[floorTokens, slotTriggerTokens)` from `cache.state.compaction`, checked before sending
// and again by the router (`setting_out_of_range{min, max}`). The number field follows the IME rules and accepts
// thousands separators (5.8.4).
import type { Compaction } from "@own/protocol"
import { createSignal, onMount, Show } from "solid-js"
import { OwnRpcError, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { createImeEnter } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard"
import { formatTokens } from "@/switcher/format"
import { showToast } from "@/switcher/toast"
import { sessionCompactionText } from "./session-compaction-strings"
import "./session-compaction.css"

export interface SessionCompactionProps {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly view: Compaction.View
  readonly onClose: () => void
}

/** `200,000` / `200 000` / `200000` → 200000; anything else → undefined. */
export function parseTokens(text: string) {
  const digits = text.replace(/[\s,._']/g, "")
  if (!/^\d+$/.test(digits)) return undefined
  return Number(digits)
}

/** Range message key for a value outside `[floor, slot)`; undefined when valid. */
export function rangeProblem(value: number, view: Pick<Compaction.View, "floorTokens" | "slotTriggerTokens">) {
  if (value >= view.slotTriggerTokens) return "above" as const
  if (value < view.floorTokens) return "below" as const
  return undefined
}

export default function SessionCompaction(props: SessionCompactionProps) {
  const i18n = useI18n()
  const text = sessionCompactionText.use()
  const [mode, setMode] = createSignal<"follow" | "earlier">(
    props.view.sessionTriggerTokens === null ? "follow" : "earlier",
  )
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  let field: HTMLInputElement | undefined
  let panel: HTMLDivElement | undefined

  const slot = () => formatTokens(props.view.slotTriggerTokens)
  const initial = () => {
    const value =
      props.view.sessionTriggerTokens ?? Math.max(props.view.floorTokens, props.view.slotTriggerTokens - 50_000)
    return i18n.number(value)
  }

  function validate(): number | null | undefined {
    if (mode() === "follow") return null
    const value = parseTokens(field?.value ?? "")
    if (value === undefined) {
      setError(text("own.compactSession.invalid"))
      return undefined
    }
    const problem = rangeProblem(value, props.view)
    if (problem === "above") {
      setError(i18n.t("own.compact.sessionOnlyEarlier", { tokens: slot() }))
      return undefined
    }
    if (problem === "below") {
      setError(i18n.t("own.compact.sessionFloor", { tokens: formatTokens(props.view.floorTokens) }))
      return undefined
    }
    setError(undefined)
    return value
  }

  async function save() {
    const value = validate()
    if (value === undefined || saving()) return
    setSaving(true)
    try {
      await props.runtime.rpc.call("compaction.setSession", { sessionID: props.sessionID, triggerTokens: value })
      showToast({ message: text("own.compactSession.saved") })
      props.onClose()
    } catch (failure) {
      const range = outOfRange(failure)
      setError(
        range
          ? i18n.t("own.compact.outOfRange", { min: i18n.number(range.min), max: i18n.number(range.max) })
          : i18n.t("own.switch.failed", { reason: failure instanceof Error ? failure.message : String(failure) }),
      )
    } finally {
      setSaving(false)
    }
  }

  const ime = createImeEnter({ onEnter: () => void save() })

  onMount(() => (mode() === "earlier" ? field : panel?.querySelector<HTMLElement>("input"))?.focus())

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) return
    const code = eventCode(event)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return props.onClose()
    }
    if (code !== "Tab" || !panel) return
    const items = Array.from(panel.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])"))
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div class="own-cp-dlg-layer" onClick={(event) => event.target === event.currentTarget && props.onClose()}>
      <div
        ref={panel}
        class="own-cp-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-cp-dlg-title"
        data-testid="session-compaction"
        onKeyDown={onKeyDown}
      >
        <h2 id="own-cp-dlg-title">{text("own.compactSession.title")}</h2>
        <p class="own-cp-dlg-sub">
          {i18n.t("own.compact.row", {
            window: formatTokens(props.view.windowTokens),
            trigger: slot(),
          })}{" "}
          ({i18n.t(`own.compact.source.${props.view.source === "session" ? "accountModel" : props.view.source}`)})
        </p>
        <label class="own-cp-dlg-choice">
          <input
            type="radio"
            name="own-cp-session-mode"
            checked={mode() === "follow"}
            onChange={() => {
              setMode("follow")
              setError(undefined)
            }}
          />
          {text("own.compactSession.follow", { tokens: slot() })}
        </label>
        <label class="own-cp-dlg-choice">
          <input
            type="radio"
            name="own-cp-session-mode"
            checked={mode() === "earlier"}
            onChange={() => {
              setMode("earlier")
              field?.focus()
            }}
          />
          {text("own.compactSession.earlier")}
        </label>
        <div class="own-cp-dlg-field">
          <input
            ref={field}
            type="text"
            inputMode="numeric"
            autocomplete="off"
            spellcheck={false}
            value={initial()}
            disabled={mode() !== "earlier"}
            aria-invalid={!!error()}
            aria-describedby="own-cp-dlg-error"
            data-testid="session-compaction-input"
            onKeyDown={(event) => void ime.keydown(event)}
            onKeyUp={(event) => ime.keyup(event)}
            onCompositionStart={() => ime.compositionstart()}
            onCompositionEnd={() => ime.compositionend()}
            onInput={() => ime.input()}
          />
          <span>{text("own.compactSession.unit")}</span>
        </div>
        <p id="own-cp-dlg-error" class="own-cp-dlg-error" role="alert">
          <Show when={error()}>{(text) => text()}</Show>
        </p>
        <p class="own-cp-dlg-note">
          {text("own.compactSession.range", {
            min: formatTokens(props.view.floorTokens),
            max: slot(),
          })}
        </p>
        <p class="own-cp-dlg-note">{i18n.t("own.compact.sessionLimit", { tokens: slot() })}</p>
        <div class="own-cp-dlg-foot">
          <button type="button" class="own-cp-btn" onClick={() => props.onClose()}>
            {i18n.t("own.switcher.cancel")}
          </button>
          <button
            type="button"
            class="own-cp-btn own-cp-btn-primary"
            disabled={saving()}
            data-testid="session-compaction-save"
            onClick={() => void save()}
          >
            {text("own.compactSession.save")}
          </button>
        </div>
      </div>
    </div>
  )
}

function outOfRange(error: unknown) {
  if (!(error instanceof OwnRpcError) || error.type !== "setting_out_of_range") return undefined
  const data = error.data
  if (typeof data !== "object" || data === null || !("min" in data) || !("max" in data)) return undefined
  return typeof data.min === "number" && typeof data.max === "number" ? { min: data.min, max: data.max } : undefined
}
