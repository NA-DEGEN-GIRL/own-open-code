// ContextMeter (03 §4.4, §5.8.3): a ring filled to P / window with the auto-compaction tick(s) and the tokens in it
// beside it (`6k`, from 720 px of composer, UX 2026-10-26), the caution color from
// 85 % of the point and `다음 단계 전에 압축` past it. Pressing it opens a small popover: `지금 압축`, `이 세션 압축
// 설정…` (a lazy dialog, 5.8.5) and `자동 압축 설정 열기` (settings > 자동 압축). Values only from `cache.state`.
import { createMemo, createSignal, For, lazy, onCleanup, Show, Suspense } from "solid-js"
import type { ServerRuntime } from "@/data"
import { useCompactNow } from "@/forking"
import { useI18n } from "@/i18n"
import { eventCode } from "@/keyboard"
import { useRouter } from "@/routing/router"
import { formatTokens } from "@/switcher/format"
import { modelInfo } from "@/switcher/labels"
import { fitMenu } from "./fit"
import { meterModel, meterSpeech, meterTitle } from "./meter"

const SessionCompaction = lazy(() => import("./session-compaction"))

const SIZE = 20
const RADIUS = 8
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface ContextMeterProps {
  readonly runtime: ServerRuntime
  readonly sessionID: string
}

export function ContextMeter(props: ContextMeterProps) {
  const i18n = useI18n()
  const router = useRouter()
  const own = () => props.runtime.own
  const view = () => own().state.cache[props.sessionID]?.compaction
  const model = createMemo(() => {
    const current = view()
    if (current) return meterModel(current)
    // No router data (or `compaction: null`): the registered limit on a faint track (03 §4.4).
    const ref = own().state.binding[props.sessionID]?.model ?? props.runtime.data.session.get(props.sessionID)?.model
    const info = ref ? modelInfo(props.runtime, ref) : undefined
    return meterModel(undefined, info?.limit)
  })
  const mismatch = () =>
    own().state.alerts.some(
      (alert) => alert.code === "compaction_threshold_mismatch" && alert.sessionID === props.sessionID,
    )
  const directory = () => props.runtime.data.session.get(props.sessionID)?.location.directory ?? ""
  const [open, setOpen] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  let wrap: HTMLSpanElement | undefined
  let button: HTMLButtonElement | undefined
  let popover: HTMLDivElement | undefined

  const close = () => {
    setOpen(false)
    stopListening()
  }
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && wrap?.contains(event.target)) return
    close()
  }
  const escape = (event: KeyboardEvent) => {
    if (eventCode(event) !== "Escape" || event.isComposing) return
    event.stopPropagation()
    close()
    button?.focus()
  }
  const stopListening = () => {
    document.removeEventListener("pointerdown", outside, true)
    document.removeEventListener("keydown", escape, true)
  }
  onCleanup(stopListening)
  const toggle = () => {
    if (open()) return close()
    setOpen(true)
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", escape, true)
    queueMicrotask(() => fitMenu(popover))
  }

  // 19.12: the same path as the header `⋯` and `/compact` (forking module). The composer's `압축 중…` chip shows the
  // progress and its failure banner offers `다시 시도`, so there is no toast here.
  const compactRun = useCompactNow()
  function compactNow() {
    close()
    compactRun(props.runtime, props.sessionID)
  }

  const revertStaged = () => !!props.runtime.data.session.get(props.sessionID)?.revert

  return (
    <Show when={model()}>
      {(meter) => (
        <span ref={wrap} class="own-cp-meter-wrap">
          <Show when={meter().tone === "over"}>
            <span class="own-cp-meter-due">{i18n.t("own.ctx.dueNext")}</span>
          </Show>
          <button
            ref={button}
            type="button"
            class="own-cp-meter own-target"
            data-tone={meter().tone}
            data-mode={meter().mode}
            data-testid="context-meter"
            aria-haspopup="dialog"
            aria-expanded={open()}
            aria-label={meterSpeech(i18n, meter())}
            title={meterTitle(i18n, meter())}
            onClick={toggle}
          >
            <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
              <circle class="own-cp-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} />
              <circle
                class="own-cp-ring-fill"
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                stroke-dasharray={`${meter().fill * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
                transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              />
              <For each={meter().marks}>
                {(mark) => (
                  <line
                    class="own-cp-ring-mark"
                    data-strong={mark.strong ? "" : undefined}
                    x1={SIZE / 2}
                    y1={SIZE / 2 - RADIUS - 2.5}
                    x2={SIZE / 2}
                    y2={SIZE / 2 - RADIUS + 2.5}
                    transform={`rotate(${mark.at * 360} ${SIZE / 2} ${SIZE / 2})`}
                  />
                )}
              </For>
            </svg>
            <Show when={mismatch()}>
              <span class="own-cp-meter-alert" aria-hidden="true">
                !
              </span>
            </Show>
            {/* The tokens in the context beside the ring (UX 2026-10-26), the same number as the 이 대화 card's
                `6k / 272k`; none while P is unknown. The label above reads the whole sentence. */}
            <Show when={meter().used !== null}>
              <span class="own-cp-meter-num own-num" aria-hidden="true" data-testid="context-meter-used">
                {formatTokens(meter().used ?? 0)}
              </span>
            </Show>
          </button>
          <Show when={open()}>
            <div
              ref={popover}
              class="own-cp-pop"
              role="dialog"
              aria-label={i18n.t("own.ctx.label")}
              data-testid="context-meter-popover"
            >
              <p class="own-cp-pop-title">{meterTitle(i18n, meter())}</p>
              <Show when={meter().mode === "router" && view()}>
                {(current) => (
                  <dl class="own-cp-pop-facts">
                    <dt>{i18n.t("own.compact.keep")}</dt>
                    <dd>
                      {current().keepTokens === null
                        ? i18n.t("own.cache.unknown")
                        : i18n.t("own.ctx.keepValue", { tokens: formatTokens(current().keepTokens ?? 0) })}
                    </dd>
                  </dl>
                )}
              </Show>
              <Show when={mismatch()}>
                <p class="own-cp-pop-warn">⚠ {i18n.t("own.compact.thresholdMismatch", { directory: directory() })}</p>
              </Show>
              <Show when={revertStaged()}>
                <p class="own-cp-pop-warn">⚠ {i18n.t("own.compact.impactRevert")}</p>
              </Show>
              <div class="own-cp-pop-actions">
                <Show when={own().rpc.can("prompt")}>
                  <button type="button" class="own-cp-btn" data-testid="compact-now" onClick={() => compactNow()}>
                    {i18n.t("own.ctx.compactNow")}
                  </button>
                </Show>
                <Show when={meter().mode === "router" && own().rpc.allowed("compaction.setSession")}>
                  <button
                    type="button"
                    class="own-cp-btn"
                    data-testid="compact-session-settings"
                    onClick={() => {
                      close()
                      setEditing(true)
                    }}
                  >
                    {i18n.t("own.ctx.sessionSettings")}
                  </button>
                </Show>
                <button
                  type="button"
                  class="own-cp-btn"
                  onClick={() => {
                    close()
                    router.navigate({ name: "settings", section: "compaction" })
                  }}
                >
                  {i18n.t("own.ctx.openSettings")}
                </button>
              </div>
              <p class="own-cp-pop-note">{i18n.t("own.ctx.cacheNote")}</p>
            </div>
          </Show>
          <Show when={editing() && view()}>
            {(current) => (
              <Suspense>
                <SessionCompaction
                  runtime={props.runtime}
                  sessionID={props.sessionID}
                  view={current()}
                  onClose={() => {
                    setEditing(false)
                    button?.focus()
                  }}
                />
              </Suspense>
            )}
          </Show>
        </span>
      )}
    </Show>
  )
}
