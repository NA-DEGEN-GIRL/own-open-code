// 설정 > 기기 `모바일 미리보기` (08 §4.3), after 앱 연결, in hosts with `capabilities.mobilePreview` (the desktop shell):
//
//   모바일 미리보기
//   Android 앱이 받는 이 PC의 화면을 …
//   [off]    게이트웨이를 먼저 켜세요 / 앱 연결을 먼저 켜세요
//   [none]   만료 (7일 | 30일)  [미리보기 기기 만들기]   → 확인 번호 1234 · … [허용]을 누르세요  [취소]
//   [ready]  연결됨 · 2026-10-09에 만료              [열기] [지우기]
//   [stale]  미리보기 기기가 폐기되었거나 …           [다시 만들기] [지우기]
//
// The pairing link never reaches the page's state (preview-flow.ts); approval is the page's normal ApproveDialog.
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useData, type GatewayView } from "@/data"
import type { HostMobilePreview, MobilePreview } from "@/host/types"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Segmented, Tag } from "@/limits/kit"
import { createPreviewFlow, previewView, PREVIEW_EXPIRY_DAYS, PREVIEW_SCOPES, type PreviewStep } from "./preview-flow"
import { usePreviewText, type PreviewKey } from "./preview-strings"

export function MobilePreviewSection(props: {
  readonly api: HostMobilePreview
  readonly preview: MobilePreview | undefined
  readonly gateway: GatewayView | undefined
}) {
  const data = useData()
  const text = usePreviewText()
  const i18n = useI18n()
  const [days, setDays] = createSignal<(typeof PREVIEW_EXPIRY_DAYS)[number]>("7")
  const [confirm, setConfirm] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const flow = createPreviewFlow(props.api, {
    start: (expiresDays) =>
      data.remote.call("devices.pair.start", {
        name: text("own.preview.deviceName"),
        scopes: [...PREVIEW_SCOPES],
        servers: { mode: "all" },
        expiresDays,
        appRoute: "loopback",
      }),
    cancel: async (pairingId) => {
      await data.remote.call("devices.pair.cancel", { pairingId: pairingId as never })
    },
  })
  onCleanup(() => {
    const step = flow.state().step
    if (step === "starting" || step === "waiting") flow.cancel()
  })
  const view = createMemo(() => previewView(props.preview, props.gateway))
  const off = () => {
    const current = view()
    return current.kind === "off" ? current : undefined
  }
  const stale = () => {
    const current = view()
    return current.kind === "stale" ? current : undefined
  }
  const working = () => {
    const step = flow.state().step
    return step === "starting" || step === "waiting"
  }
  const open = () => {
    const port = props.gateway?.app?.port
    if (port) void props.api.open({ port }).catch(() => undefined)
  }
  const remove = async () => {
    setConfirm(false)
    setBusy(true)
    await props.api.remove().catch(() => false)
    setBusy(false)
  }
  const date = (at: number) => new Date(at).toLocaleDateString(i18n.locale() === "ko" ? "ko-KR" : "en-US")
  return (
    <section class="own-psec" data-testid="pairing-preview" data-view={view().kind}>
      <div class="own-psec-head">
        <h2>{text("own.preview.title")}</h2>
      </div>
      <p class="m-0 mb-2 text-[12.5px] text-own-muted">{text("own.preview.note")}</p>
      <Show when={view().kind === "loading"}>
        <span class="text-[12.5px] text-own-muted">{text("own.preview.loading")}</span>
      </Show>
      <Show when={off()}>
        {(current) => (
          <span class="text-[12.5px] text-own-muted" data-testid="pairing-preview-off">
            {text(current().reason === "gateway" ? "own.preview.off.gateway" : "own.preview.off.app")}
          </span>
        )}
      </Show>
      <Show when={view().kind === "none" || view().kind === "stale" || working() || flow.state().step === "failed"}>
        <Creator
          step={flow.state()}
          recreate={view().kind === "stale"}
          days={days()}
          onDays={setDays}
          onCreate={() => void flow.create(Number(days()), view().kind === "stale")}
          onCancel={() => flow.cancel()}
          disabled={busy() || (view().kind !== "none" && view().kind !== "stale")}
        />
      </Show>
      <Show when={device(view())}>
        {(current) => (
          <div class="mt-1 flex flex-col gap-2" data-testid="pairing-preview-device" data-state={current().state}>
            <div class="flex flex-wrap items-center gap-2 text-[13px]">
              <b>{text("own.preview.deviceName")}</b>
              <Tag tone={current().state === "connected" ? "ok" : current().state === "reauth" ? "warn" : "soft"}>
                {text(`own.preview.state.${current().state}` as PreviewKey)}
              </Tag>
              <Show when={current().open}>
                <Tag tone="plain">{text("own.preview.open.window")}</Tag>
              </Show>
              <span class="text-[12px] text-own-muted">{text("own.preview.expiresAt", { date: date(current().expiresAt) })}</span>
            </div>
            <Show when={stale()}>
              {(current) => (
                <Notice tone="warn" testid="pairing-preview-stale">
                  {text(current().why === "mismatch" ? "own.preview.stale.mismatch" : "own.preview.stale.reauth")}
                </Notice>
              )}
            </Show>
            <div class="flex flex-wrap gap-2">
              <Show when={view().kind === "ready"}>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-variant="primary"
                  data-size="sm"
                  disabled={busy()}
                  data-testid="pairing-preview-open"
                  onClick={open}
                >
                  {text("own.preview.open")}
                </button>
              </Show>
              <button
                type="button"
                class="own-btn own-target"
                data-variant="danger"
                data-size="sm"
                disabled={busy() || working()}
                data-testid="pairing-preview-remove"
                onClick={() => setConfirm(true)}
              >
                {text("own.preview.remove")}
              </button>
            </div>
          </div>
        )}
      </Show>
      <Dialog
        open={confirm()}
        title={text("own.preview.removeTitle")}
        onClose={() => setConfirm(false)}
        testid="pairing-preview-remove-confirm"
        footer={
          <>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => setConfirm(false)}>
              {text("own.preview.cancel")}
            </button>
            <button
              type="button"
              class="own-btn own-target"
              data-variant="danger"
              data-size="sm"
              data-testid="pairing-preview-remove-ok"
              onClick={() => void remove()}
            >
              {text("own.preview.removeConfirm")}
            </button>
          </>
        }
      >
        <p class="m-0 text-[13px]">{text("own.preview.removeBody")}</p>
      </Dialog>
    </section>
  )
}

function Creator(props: {
  readonly step: PreviewStep
  /** 다시 만들기: the stale device is removed first. */
  readonly recreate: boolean
  readonly days: (typeof PREVIEW_EXPIRY_DAYS)[number]
  readonly onDays: (days: (typeof PREVIEW_EXPIRY_DAYS)[number]) => void
  readonly onCreate: () => void
  readonly onCancel: () => void
  readonly disabled: boolean
}) {
  const text = usePreviewText()
  return (
    <div class="flex flex-col gap-2" data-testid="pairing-preview-create" data-step={props.step.step}>
      <Show
        when={props.step.step === "waiting" && props.step}
        fallback={
          <Show
            when={props.step.step === "starting"}
            fallback={
              <>
                <Show when={!props.recreate}>
                  <span class="text-[12.5px] text-own-muted">{text("own.preview.none")}</span>
                </Show>
                <span class="text-[12px] text-own-muted">{text("own.preview.scopes")}</span>
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-[12.5px] font-semibold">{text("own.preview.expires")}</span>
                  <Segmented
                    label={text("own.preview.expires")}
                    value={props.days}
                    options={PREVIEW_EXPIRY_DAYS.map((value) => ({ value, label: text("own.preview.expires.days", { days: value }) }))}
                    onChange={props.onDays}
                    testid="pairing-preview-expiry"
                  />
                  <button
                    type="button"
                    class="own-btn own-target"
                    data-variant="primary"
                    data-size="sm"
                    disabled={props.disabled}
                    data-testid={props.recreate ? "pairing-preview-recreate" : "pairing-preview-make"}
                    onClick={() => props.onCreate()}
                  >
                    {text(props.recreate ? "own.preview.recreate" : "own.preview.create")}
                  </button>
                </div>
              </>
            }
          >
            <span class="text-[12.5px] text-own-muted">{text("own.preview.starting")}</span>
          </Show>
        }
      >
        {(waiting) => (
          <div class="flex flex-wrap items-center gap-2">
            <span class="min-w-0 flex-1 text-[13px]" data-testid="pairing-preview-sas">
              {text("own.preview.waiting", { sas: waiting().sas })}
            </span>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => props.onCancel()}>
              {text("own.preview.cancel")}
            </button>
          </div>
        )}
      </Show>
      <Show when={props.step.step === "failed" && props.step}>
        {(failed) => (
          <Notice tone="danger" testid="pairing-preview-error">
            {text(`own.preview.error.${failed().error}` as PreviewKey, { detail: failed().detail ?? "—" })}
          </Notice>
        )}
      </Show>
      <Show when={props.step.step === "done"}>
        <Notice tone="ok">{text("own.preview.done")}</Notice>
      </Show>
    </div>
  )
}

function device(view: ReturnType<typeof previewView>) {
  if (view.kind === "ready" || view.kind === "stale") return view.device
  if (view.kind === "off") return view.device
  return undefined
}
