// 설정 > 기기 (03 §5.7, §21.2; 05 §13.3–13.5), lazy page. PC windows only (the settings page hides it for
// `auth: "device"`, and the gateway refuses `devices.*`/`gateway.*` from devices anyway).
// - Gateway line: `gateway.status` + `gateway.state` events; on = `gateway.configure.plan → execute{nonce}`, off =
//   `gateway.disable`. Tailscale is detected only: install/sign-in guidance, or the `tailscale serve` command to copy,
//   and the Tailnet Lock state (08 §2).
// - 앱 연결 (08): the pinned-TLS app listener (on = plan → confirm → execute with `app`), its routes, the
//   `tailscale serve --tcp` command and the DDNS route's portproxy/firewall commands, all for the user to run.
// - 새 기기 연결: name, scopes (05 §13.5 table, scopes.ts; 터미널/관리 warn; 브라우저 is never ticked for the user,
//   05 §8.10.2), servers, expiry → `devices.pair.start` → QR drawn
//   locally (uqr) + link + 5-minute countdown. The device opening it raises `device.pairing.pending`: a dialog with
//   the SAS, [허용] = `devices.pair.approve{pairingId, sas}`, [거부] = `devices.pair.cancel`, 2-minute countdown.
// - 모바일 미리보기 (08 §4.3, desktop shell only): remote-pcs/preview-section.tsx; its device is tagged in the list.
// - Device list: kind, scopes, servers, last seen, expiry; change scopes, revoke (one confirmation), revoke all.
// Countdowns tick once a second only while a QR or a request is on screen (an R9 exception like 19.7's viewer).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  OwnRpcError,
  remoteEvent,
  useData,
  type DeviceScope,
  type DeviceView,
  type GatewayView,
  type PairingView,
  type RemoteInput,
  type ServerScope,
} from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { copyText, createStatus, Dialog, Notice, Segmented, StatusLine, Tag, TextField } from "@/limits/kit"
import { remoteStore } from "@/servers"
import { createPreviewStatus } from "@/remote-pcs/preview-flow"
import { MobilePreviewSection } from "@/remote-pcs/preview-section"
import { minuteNow } from "@/shell/clock"
import { relativeTime } from "@/shell/format"
import { QrCode } from "./qr"
import { DEFAULT_SCOPES, RISKY, scopeList, SCOPES, TARGET_SCOPES, toggleScope, type Target } from "./scopes"
import { usePairingText, type PairingKey } from "./strings"

const EXPIRY_DAYS = ["7", "30", "90"] as const
const IDLE_DAYS = 14

interface Pending {
  readonly pairingId: string
  readonly name: string
  readonly sas: string
  readonly userAgent: string | null
  readonly expiresAt: number
}

export default function DevicesSettings() {
  const data = useData()
  const host = useHost()
  const text = usePairingText()
  const status = createStatus()
  const previewApi = host.capabilities.mobilePreview ? host.mobilePreview : undefined
  const preview = previewApi ? createPreviewStatus(previewApi) : undefined
  if (preview) onCleanup(preview.dispose)
  const previewDevice = () => {
    const current = preview?.preview()
    return current && current.state !== "none" ? current.deviceId : undefined
  }
  const [gateway, setGateway] = createSignal<GatewayView>()
  const [devices, setDevices] = createSignal<readonly DeviceView[]>([])
  const [unavailable, setUnavailable] = createSignal(false)
  const [pending, setPending] = createSignal<Pending>()
  const [link, setLink] = createSignal<PairingLinkState>()
  const [waitingClaim, setWaitingClaim] = createSignal<string>()

  const fail = (error: unknown) => {
    // Without own-remote the page shows only the unavailable line, not a second raw error under it.
    if (error instanceof OwnRpcError && /^(rpc\.method_not_found|rpc\.unavailable)$/.test(error.type))
      return void setUnavailable(true)
    status.error(text("own.pairing.failed", { reason: error instanceof OwnRpcError ? error.type : error instanceof Error ? error.message : String(error) }))
  }

  const refresh = async () => {
    try {
      const [view, list] = await Promise.all([data.remote.call("gateway.status", {}), data.remote.call("devices.list", {})])
      setGateway(view)
      setDevices(list.devices)
      const open = list.pairings.find((pairing: PairingView) => pairing.state === "pending" && pairing.sas)
      if (open && !pending())
        setPending({ pairingId: open.pairingId, name: open.name, sas: open.sas!, userAgent: open.userAgent, expiresAt: open.expiresAt })
      if (link() && !list.pairings.some((pairing: PairingView) => pairing.pairingId === link()!.pairingId)) setLink(undefined)
    } catch (error) {
      fail(error)
    }
  }

  onMount(() => void refresh())
  const stop = data.local().bus.listen((raw) => {
    if (raw.type === "server.connected") return void refresh()
    const event = remoteEvent(raw)
    if (!event) return
    switch (event.name) {
      case "gateway.state":
        return void refresh()
      case "device.pairing.pending": {
        const { pairingId, name, sas, userAgent, expiresAt } = event.data
        setPending({ pairingId, name, sas, userAgent, expiresAt })
        if (link()?.pairingId === pairingId) setLink(undefined)
        return
      }
      case "device.pairing.ended":
        if (pending()?.pairingId === event.data.pairingId) setPending(undefined)
        if (link()?.pairingId === event.data.pairingId) setLink(undefined)
        if (waitingClaim() === event.data.pairingId && event.data.reason !== "claimed") setWaitingClaim(undefined)
        return
      case "device.paired":
        setWaitingClaim(undefined)
        status.ok(text("own.pairing.paired", { name: event.data.name }))
        return void refresh()
      case "device.revoked":
        return void refresh()
    }
  })
  onCleanup(stop)

  return (
    <div class="flex flex-col gap-5" data-testid="settings-devices">
      <Show when={!unavailable()} fallback={<p class="own-placeholder px-0">{text("own.pairing.unavailable")}</p>}>
        <GatewaySection view={gateway()} onChanged={setGateway} onError={fail} />
        <Show when={gateway()}>{(view) => <TailscaleSection view={view()} />}</Show>
        <Show when={gateway()?.app && gateway()?.enabled && gateway()}>
          {(view) => (
            <AppAccessSection
              view={view()}
              onChanged={setGateway}
              onError={fail}
              onSaved={() => status.ok(text("own.pairing.app.saved"))}
            />
          )}
        </Show>
        <Show when={previewApi}>
          {(api) => <MobilePreviewSection api={api()} preview={preview?.preview()} gateway={gateway()} />}
        </Show>
        <NewDevice
          gateway={gateway()}
          link={link()}
          onLink={setLink}
          onError={fail}
        />
        <DeviceList devices={devices()} previewDevice={previewDevice()} onChanged={refresh} onError={fail} status={status} />
      </Show>
      <StatusLine status={status} testid="pairing-status" />
      <Show when={waitingClaim()}>
        <Notice testid="pairing-finishing">{text("own.pairing.approve.done", { name: pending()?.name ?? "" })}</Notice>
      </Show>
      <Show when={pending()} keyed>
        {(request) => (
          <ApproveDialog
            request={request}
            onDone={(result) => {
              setPending(undefined)
              if (result === "approved") setWaitingClaim(request.pairingId)
              if (result === "rejected") status.error(text("own.pairing.approve.rejected"))
              if (result === "expired") status.error(text("own.pairing.approve.expired"))
              void refresh()
            }}
            onError={fail}
          />
        )}
      </Show>
    </div>
  )
}

// ---- gateway

function GatewaySection(props: {
  readonly view: GatewayView | undefined
  readonly onChanged: (view: GatewayView) => void
  readonly onError: (error: unknown) => void
}) {
  const data = useData()
  const text = usePairingText()
  const [port, setPort] = createSignal("")
  const [plan, setPlan] = createSignal<{ nonce: string; url: string }>()
  const [confirmOff, setConfirmOff] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [rejected, setRejected] = createSignal<string>()
  createEffect(() => {
    const view = props.view
    if (view && port() === "") setPort(String(view.port ?? 28539))
  })
  const line = () => {
    const view = props.view
    if (!view) return "…"
    if (view.state === "listening") return text("own.pairing.state.listening", { url: view.url ?? "" })
    if (view.state === "error")
      return text("own.pairing.state.error", {
        problem: text(`own.pairing.problem.${view.problem ?? "bind_failed"}` as PairingKey, { port: view.port ?? "" }),
      })
    return text("own.pairing.state.off")
  }
  const start = async () => {
    setBusy(true)
    setRejected(undefined)
    try {
      const value = Number(port())
      const planned = await data.remote.call("gateway.configure.plan", Number.isInteger(value) && value > 0 ? { port: value } : {})
      setPlan({ nonce: planned.nonce, url: planned.url })
    } catch (error) {
      if (error instanceof OwnRpcError && error.type === "bind_rejected_lan")
        setRejected(text("own.pairing.bindRejected", { address: String((error.data as { address?: string })?.address ?? "") }))
      else props.onError(error)
    } finally {
      setBusy(false)
    }
  }
  const execute = async () => {
    const current = plan()
    if (!current) return
    setBusy(true)
    try {
      props.onChanged(await data.remote.call("gateway.configure.execute", { nonce: current.nonce }))
      setPlan(undefined)
    } catch (error) {
      props.onError(error)
      setPlan(undefined)
    } finally {
      setBusy(false)
    }
  }
  const off = async () => {
    setBusy(true)
    try {
      props.onChanged(await data.remote.call("gateway.disable", {}))
    } catch (error) {
      props.onError(error)
    } finally {
      setBusy(false)
      setConfirmOff(false)
    }
  }
  return (
    <section class="own-psec" data-testid="pairing-gateway">
      <div class="own-psec-head">
        <h2>{text("own.pairing.gateway")}</h2>
      </div>
      <p class="m-0 mb-2 text-[12.5px] text-own-muted">{text("own.pairing.gateway.note")}</p>
      <div class="flex flex-wrap items-end gap-2">
        <span
          class="min-w-0 flex-1 break-all text-[13px]"
          data-testid="pairing-gateway-state"
          data-state={props.view?.state ?? "loading"}
        >
          {line()}
        </span>
        <Show
          when={props.view?.enabled}
          fallback={
            <>
              <div class="w-[96px]">
                <TextField label={text("own.pairing.port")} value={port()} onValue={setPort} inputMode="numeric" testid="pairing-port" />
              </div>
              <button type="button" class="own-btn own-target" data-variant="primary" data-size="sm" disabled={busy()} data-testid="pairing-enable" onClick={() => void start()}>
                {text("own.pairing.enable")}
              </button>
            </>
          }
        >
          <button type="button" class="own-btn own-target" data-size="sm" disabled={busy()} data-testid="pairing-disable" onClick={() => setConfirmOff(true)}>
            {text("own.pairing.disable")}
          </button>
        </Show>
      </div>
      <Show when={rejected()}>{(message) => <Notice tone="danger">{message()}</Notice>}</Show>
      <Dialog
        open={plan() !== undefined}
        title={text("own.pairing.plan.title")}
        onClose={() => setPlan(undefined)}
        testid="pairing-plan"
        footer={
          <>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => setPlan(undefined)}>
              {text("own.pairing.plan.cancel")}
            </button>
            <button type="button" class="own-btn own-target" data-variant="primary" data-size="sm" disabled={busy()} data-testid="pairing-plan-confirm" onClick={() => void execute()}>
              {text("own.pairing.plan.confirm")}
            </button>
          </>
        }
      >
        <p class="m-0 text-[13px]">{text("own.pairing.plan.body", { url: plan()?.url ?? "" })}</p>
      </Dialog>
      <Dialog
        open={confirmOff()}
        title={text("own.pairing.disable")}
        onClose={() => setConfirmOff(false)}
        testid="pairing-disable-confirm"
        footer={
          <>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => setConfirmOff(false)}>
              {text("own.pairing.plan.cancel")}
            </button>
            <button type="button" class="own-btn own-target" data-variant="danger" data-size="sm" disabled={busy()} data-testid="pairing-disable-ok" onClick={() => void off()}>
              {text("own.pairing.disable")}
            </button>
          </>
        }
      >
        <p class="m-0 text-[13px]">{text("own.pairing.disableConfirm")}</p>
      </Dialog>
    </section>
  )
}

function TailscaleSection(props: { readonly view: GatewayView }) {
  const text = usePairingText()
  const host = useHost()
  const [copied, setCopied] = createSignal(false)
  const tailscale = () => props.view.tailscale
  return (
    <section class="own-psec" data-testid="pairing-tailscale" data-state={tailscale().state}>
      <div class="own-psec-head">
        <h2>{text("own.pairing.tailscale")}</h2>
      </div>
      <Show when={tailscale().state === "missing"}>
        <p class="m-0 text-[13px]">{text("own.pairing.tailscale.missing")}</p>
        <button type="button" class="own-btn own-target mt-2 self-start" data-size="sm" onClick={() => host.openExternal("https://tailscale.com/download")}>
          {text("own.pairing.tailscale.download")}
        </button>
      </Show>
      <Show when={tailscale().state === "stopped" || tailscale().state === "logged_out" || tailscale().state === "unknown"}>
        <p class="m-0 text-[13px]">{text(`own.pairing.tailscale.${tailscale().state}` as PairingKey)}</p>
      </Show>
      <Show when={tailscale().state === "running"}>
        <p class="m-0 text-[13px]">{text("own.pairing.tailscale.running", { name: tailscale().dnsName ?? "" })}</p>
        <Show when={tailscale().serving === true && props.view.publicOrigin}>
          <p class="m-0 mt-1 text-[13px]" data-testid="pairing-serving">
            {text("own.pairing.tailscale.serving", { url: props.view.publicOrigin! })}
          </p>
        </Show>
        <Show when={tailscale().lock === "on"}>
          <p class="m-0 mt-1 text-[12.5px] text-own-muted" data-testid="pairing-lock" data-lock="on">
            {text("own.pairing.tailscale.lockOn")}
          </p>
        </Show>
        <Show when={tailscale().lock === "off"}>
          <Notice tone="warn" testid="pairing-lock-off">
            {text("own.pairing.tailscale.lockOff")}
          </Notice>
          <button
            type="button"
            class="own-btn own-target mt-1 self-start"
            data-size="sm"
            onClick={() => host.openExternal("https://tailscale.com/kb/1226/tailnet-lock")}
          >
            {text("own.pairing.tailscale.lockHow")}
          </button>
        </Show>
      </Show>
      <Show when={tailscale().serveCommand && tailscale().serving !== true}>
        <p class="m-0 mt-2 text-[12.5px] text-own-muted">{text("own.pairing.tailscale.serve")}</p>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <code class="own-mono min-w-0 flex-1 break-all rounded-md bg-own-hover px-2 py-1.5 text-[12.5px]" data-testid="pairing-serve-command">
            {tailscale().serveCommand}
          </code>
          <button
            type="button"
            class="own-btn own-target"
            data-size="sm"
            onClick={() => void copyText(tailscale().serveCommand!).then((ok) => setCopied(ok))}
          >
            {copied() ? text("own.pairing.copied") : text("own.pairing.copy")}
          </button>
        </div>
        <p class="m-0 mt-1 text-[12px] text-own-faint">{text("own.pairing.tailscale.noFunnel")}</p>
      </Show>
    </section>
  )
}

// ---- app connections (08)

function AppAccessSection(props: {
  readonly view: GatewayView
  readonly onChanged: (view: GatewayView) => void
  readonly onError: (error: unknown) => void
  readonly onSaved: () => void
}) {
  const data = useData()
  const text = usePairingText()
  const app = () => props.view.app
  const [host, setHost] = createSignal("")
  const [port, setPort] = createSignal("")
  const [plan, setPlan] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  createEffect(() => {
    const current = app()
    if (!current) return
    if (host() === "" && current.direct.host) setHost(current.direct.host)
    if (port() === "") setPort(String(current.direct.port ?? 28541))
  })
  const configure = async (input: NonNullable<RemoteInput<"gateway.configure.plan">["app"]>, confirm: boolean) => {
    setBusy(true)
    try {
      const planned = await data.remote.call("gateway.configure.plan", { app: input })
      if (confirm) return setPlan(planned.nonce)
      props.onChanged(await data.remote.call("gateway.configure.execute", { nonce: planned.nonce }))
      props.onSaved()
    } catch (error) {
      props.onError(error)
    } finally {
      setBusy(false)
    }
  }
  const execute = async () => {
    const nonce = plan()
    setPlan(undefined)
    if (!nonce) return
    setBusy(true)
    try {
      props.onChanged(await data.remote.call("gateway.configure.execute", { nonce }))
    } catch (error) {
      props.onError(error)
    } finally {
      setBusy(false)
    }
  }
  const saveDirect = () => {
    const value = Number(port())
    void configure(
      { enabled: true, directHost: host().trim() || null, ...(Number.isInteger(value) && value > 0 ? { directPort: value } : {}) },
      false,
    )
  }
  const line = () => {
    const current = app()
    if (!current || current.state === "off") return text("own.pairing.app.state.off")
    if (current.state === "listening") return text("own.pairing.app.state.listening", { port: current.port ?? "" })
    return text("own.pairing.app.state.error", {
      problem: text(`own.pairing.app.problem.${current.problem ?? "bind_failed"}` as PairingKey, { port: current.port ?? "" }),
    })
  }
  const routeState = (ready: boolean | null) =>
    ready === true ? text("own.pairing.app.route.ready") : ready === false ? text("own.pairing.app.route.notReady") : text("own.pairing.app.route.unknown")
  return (
    <section class="own-psec" data-testid="pairing-app" data-state={app()?.state ?? "off"}>
      <div class="own-psec-head">
        <h2>{text("own.pairing.app")}</h2>
      </div>
      <p class="m-0 mb-2 text-[12.5px] text-own-muted">{text("own.pairing.app.note")}</p>
      <div class="flex flex-wrap items-center gap-2">
        <span class="min-w-0 flex-1 break-all text-[13px]" data-testid="pairing-app-state">
          {line()}
        </span>
        <Show
          when={app()?.enabled}
          fallback={
            <button
              type="button"
              class="own-btn own-target"
              data-variant="primary"
              data-size="sm"
              disabled={busy() || props.view.state !== "listening"}
              data-testid="pairing-app-enable"
              onClick={() => void configure({ enabled: true }, true)}
            >
              {text("own.pairing.app.enable")}
            </button>
          }
        >
          <button type="button" class="own-btn own-target" data-size="sm" disabled={busy()} data-testid="pairing-app-disable" onClick={() => void configure({ enabled: false }, false)}>
            {text("own.pairing.app.disable")}
          </button>
        </Show>
      </div>
      <Show when={app()?.enabled && app()}>
        {(current) => (
          <div class="mt-2 flex flex-col gap-3">
            <Show when={current().pin}>
              {(pin) => (
                <span class="own-mono text-[12px] text-own-faint" data-testid="pairing-app-pin">
                  {text("own.pairing.app.pin", { pin: shortPin(pin()) })}
                </span>
              )}
            </Show>
            <div class="flex flex-col gap-1">
              <span class="text-[12.5px] font-semibold">{text("own.pairing.app.routes")}</span>
              <Show when={current().routes.length > 0} fallback={<span class="text-[12.5px] text-own-muted">{text("own.pairing.app.routes.none")}</span>}>
                <For each={current().routes}>
                  {(route) => (
                    <span class="flex flex-wrap items-center gap-2 text-[13px]" data-testid="pairing-app-route" data-kind={route.kind}>
                      <Tag tone="soft">{route.kind === "tailnet" ? "Tailscale" : "DDNS"}</Tag>
                      <code class="own-mono break-all text-[12.5px]">{route.address}</code>
                      <span class="text-[12px] text-own-muted">{routeState(route.ready)}</span>
                    </span>
                  )}
                </For>
              </Show>
            </div>
            <div class="flex flex-col gap-1" data-testid="pairing-app-tailnet">
              <span class="text-[12.5px] font-semibold">{text("own.pairing.app.tailnet")}</span>
              <Show
                when={props.view.tailscale.state === "running"}
                fallback={<span class="text-[12.5px] text-own-muted">{text("own.pairing.app.tailnet.needTailscale")}</span>}
              >
                <Show when={props.view.tailscale.appServing !== true && current().tailnetCommand}>
                  {(command) => (
                    <>
                      <span class="text-[12.5px] text-own-muted">{text("own.pairing.app.tailnet.note")}</span>
                      <Commands lines={[command()]} testid="pairing-app-tailnet-command" />
                    </>
                  )}
                </Show>
              </Show>
            </div>
            <div class="flex flex-col gap-2" data-testid="pairing-app-direct">
              <span class="text-[12.5px] font-semibold">{text("own.pairing.app.direct")}</span>
              <span class="text-[12.5px] text-own-muted">{text("own.pairing.app.direct.note")}</span>
              <div class="flex flex-wrap items-end gap-2">
                <div class="min-w-[220px] flex-1">
                  <TextField label={text("own.pairing.app.direct.host")} value={host()} onValue={setHost} onEnter={saveDirect} maxLength={253} testid="pairing-app-host" />
                </div>
                <div class="w-[96px]">
                  <TextField label={text("own.pairing.app.direct.port")} value={port()} onValue={setPort} inputMode="numeric" testid="pairing-app-port" />
                </div>
                <button type="button" class="own-btn own-target" data-size="sm" disabled={busy()} data-testid="pairing-app-save" onClick={saveDirect}>
                  {text("own.pairing.app.direct.save")}
                </button>
              </div>
              <Show when={current().direct.host && current().direct.port}>
                <span class="text-[12.5px]">{text("own.pairing.app.direct.setup")}</span>
                <Commands lines={current().direct.setupCommands} testid="pairing-app-setup" />
                <span class="text-[12.5px]">{text("own.pairing.app.direct.router", { port: current().direct.port ?? "" })}</span>
                <Show when={current().direct.portproxy !== null}>
                  <span class="text-[12px] text-own-muted" data-testid="pairing-app-portproxy">
                    {current().direct.portproxy ? text("own.pairing.app.direct.portproxy.on") : text("own.pairing.app.direct.portproxy.off")}
                  </span>
                </Show>
                <details class="text-[12.5px]">
                  <summary class="own-target cursor-pointer">{text("own.pairing.app.direct.remove")}</summary>
                  <Commands lines={current().direct.removeCommands} testid="pairing-app-remove" />
                </details>
                <button
                  type="button"
                  class="own-btn own-target self-start"
                  data-size="sm"
                  disabled={busy()}
                  onClick={() => {
                    setHost("")
                    void configure({ enabled: true, directHost: null }, false)
                  }}
                >
                  {text("own.pairing.app.direct.clear")}
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>
      <Dialog
        open={plan() !== undefined}
        title={text("own.pairing.app.plan.title")}
        onClose={() => setPlan(undefined)}
        testid="pairing-app-plan"
        footer={
          <>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => setPlan(undefined)}>
              {text("own.pairing.plan.cancel")}
            </button>
            <button type="button" class="own-btn own-target" data-variant="primary" data-size="sm" disabled={busy()} data-testid="pairing-app-plan-confirm" onClick={() => void execute()}>
              {text("own.pairing.plan.confirm")}
            </button>
          </>
        }
      >
        <p class="m-0 text-[13px]">{text("own.pairing.app.plan.body")}</p>
      </Dialog>
    </section>
  )
}

/** Commands to copy (the user runs them; own-open-code never does, 08 §3.8). */
function Commands(props: { readonly lines: readonly string[]; readonly testid: string }) {
  const text = usePairingText()
  const [copied, setCopied] = createSignal(false)
  return (
    <div class="flex flex-wrap items-start gap-2">
      <code class="own-mono min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md bg-own-hover px-2 py-1.5 text-[12.5px]" data-testid={props.testid}>
        {props.lines.join("\n")}
      </code>
      <button type="button" class="own-btn own-target" data-size="sm" onClick={() => void copyText(props.lines.join("\n")).then(setCopied)}>
        {copied() ? text("own.pairing.copied") : props.lines.length > 1 ? text("own.pairing.app.copyAll") : text("own.pairing.copy")}
      </button>
    </div>
  )
}

/** `ABCD EFGH IJKL MNOP`: the first 16 characters of the pin, enough to compare by eye. */
export function shortPin(pin: string) {
  return (pin.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ")
}

// ---- new device

export interface PairingLinkState {
  readonly pairingId: string
  readonly url: string
  readonly appLink: string | null
  readonly expiresAt: number
  readonly target: Target
}

function NewDevice(props: {
  readonly gateway: GatewayView | undefined
  readonly link: PairingLinkState | undefined
  readonly onLink: (link: PairingLinkState | undefined) => void
  readonly onError: (error: unknown) => void
}) {
  const data = useData()
  const text = usePairingText()
  const [picked, setPicked] = createSignal<Target>()
  const [name, setName] = createSignal(text("own.pairing.name.default"))
  const [scopes, setScopes] = createSignal<ReadonlySet<DeviceScope>>(new Set(DEFAULT_SCOPES))
  const appOn = () => props.gateway?.app?.state === "listening"
  // Until the user picks: the Android app while app connections are on, else the browser (the M1 flow as before).
  const target = () => picked() ?? (appOn() ? "android" : "browser")
  const choose = (next: Target) => {
    const defaults = [text("own.pairing.name.default"), text("own.pairing.name.desktop")]
    if (defaults.includes(name())) setName(next === "desktop" ? text("own.pairing.name.desktop") : text("own.pairing.name.default"))
    setScopes(new Set(TARGET_SCOPES[next]))
    setPicked(next)
  }
  const [serverMode, setServerMode] = createSignal<"all" | "only">("all")
  const [servers, setServers] = createSignal<ReadonlySet<string>>(new Set(["local"]))
  const [days, setDays] = createSignal<(typeof EXPIRY_DAYS)[number]>("30")
  const [busy, setBusy] = createSignal(false)
  const listening = () => props.gateway?.state === "listening"
  const hosts = createMemo(() => {
    const store = remoteStore()
    return (store?.state.order ?? []).map((id) => ({ id, name: store!.state.hosts[id]?.name ?? id }))
  })
  const risky = () => [...scopes()].some((scope) => RISKY.has(scope))
  const toggle = (scope: DeviceScope) => setScopes((current) => toggleScope(current, scope))
  const toggleServer = (key: string) =>
    setServers((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next.size === 0 ? current : next
    })
  const create = async () => {
    setBusy(true)
    try {
      const scope: ServerScope = serverMode() === "all" ? { mode: "all" } : { mode: "only", keys: [...servers()] }
      const started = await data.remote.call("devices.pair.start", {
        name: name().trim() || text("own.pairing.name.default"),
        scopes: scopeList(scopes()),
        servers: scope,
        expiresDays: Number(days()),
      })
      props.onLink({
        pairingId: started.pairingId,
        url: started.url,
        appLink: started.appLink ?? null,
        expiresAt: started.expiresAt,
        target: target(),
      })
    } catch (error) {
      props.onError(error)
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    const current = props.link
    props.onLink(undefined)
    if (current) await data.remote.call("devices.pair.cancel", { pairingId: current.pairingId }).catch(() => undefined)
  }
  return (
    <section class="own-psec" data-testid="pairing-new">
      <div class="own-psec-head">
        <h2>{text("own.pairing.new")}</h2>
      </div>
      <Show when={listening()} fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.pairing.needGateway")}</p>}>
        <Show
          when={props.link}
          keyed
          fallback={
            <div class="flex flex-col gap-3">
              <div class="flex flex-col gap-1">
                <span class="text-[12.5px] font-semibold">{text("own.pairing.kind")}</span>
                <Segmented
                  label={text("own.pairing.kind")}
                  value={target()}
                  options={[
                    { value: "android", label: text("own.pairing.kind.target.android") },
                    { value: "desktop", label: text("own.pairing.kind.target.desktop") },
                    { value: "browser", label: text("own.pairing.kind.target.browser") },
                  ]}
                  onChange={choose}
                  testid="pairing-target"
                />
                <Show when={target() !== "browser" && !appOn()}>
                  <span class="text-[12.5px] text-own-warn" data-testid="pairing-need-app">
                    {text("own.pairing.needApp")}
                  </span>
                </Show>
              </div>
              <div class="max-w-[320px]">
                <TextField label={text("own.pairing.name")} value={name()} onValue={setName} maxLength={60} testid="pairing-name" />
              </div>
              <fieldset class="m-0 flex flex-col gap-1 border-0 p-0">
                <legend class="mb-1 text-[12.5px] font-semibold">{text("own.pairing.scopes")}</legend>
                <For each={SCOPES}>
                  {(scope) => (
                    <label class="own-target flex cursor-pointer items-center gap-2 text-[13px]" data-testid={`pairing-scope-${scope}`}>
                      <input type="checkbox" checked={scopes().has(scope)} onChange={() => toggle(scope)} />
                      <span class="font-medium">{text(`own.pairing.scope.${scope}` as PairingKey)}</span>
                      <span class="min-w-0 text-[12px] text-own-muted">{text(`own.pairing.scope.${scope}.note` as PairingKey)}</span>
                    </label>
                  )}
                </For>
                <Show when={risky()}>
                  <Notice tone="warn" testid="pairing-risky">
                    {text("own.pairing.risky")}
                  </Notice>
                </Show>
              </fieldset>
              <div class="flex flex-col gap-1">
                <span class="text-[12.5px] font-semibold">{text("own.pairing.servers")}</span>
                <Segmented
                  label={text("own.pairing.servers")}
                  value={serverMode()}
                  options={[
                    { value: "all", label: text("own.pairing.servers.all") },
                    { value: "only", label: text("own.pairing.servers.only") },
                  ]}
                  onChange={setServerMode}
                  testid="pairing-servers"
                />
                <Show when={serverMode() === "only"}>
                  <div class="flex flex-wrap gap-x-4">
                    <For each={[{ id: "local", name: text("own.pairing.server.local") }, ...hosts()]}>
                      {(server) => (
                        <label class="own-target flex cursor-pointer items-center gap-2 text-[13px]">
                          <input type="checkbox" checked={servers().has(server.id)} onChange={() => toggleServer(server.id)} />
                          {server.name}
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-[12.5px] font-semibold">{text("own.pairing.expires")}</span>
                <Segmented
                  label={text("own.pairing.expires")}
                  value={days()}
                  options={EXPIRY_DAYS.map((value) => ({ value, label: text("own.pairing.expires.days", { days: value }) }))}
                  onChange={setDays}
                  testid="pairing-expiry"
                />
                <span class="text-[12px] text-own-muted">{text("own.pairing.expires.note", { idle: IDLE_DAYS })}</span>
              </div>
              <button
                type="button"
                class="own-btn own-target self-start"
                data-variant="primary"
                data-size="sm"
                disabled={busy() || (target() !== "browser" && !appOn())}
                data-testid="pairing-create"
                onClick={() => void create()}
              >
                {text("own.pairing.create")}
              </button>
            </div>
          }
        >
          {(current) => <PairingLink link={current} local={!props.gateway?.publicOrigin} onAgain={() => void create()} onCancel={() => void cancel()} />}
        </Show>
      </Show>
    </section>
  )
}

function PairingLink(props: {
  readonly link: PairingLinkState
  readonly local: boolean
  readonly onAgain: () => void
  readonly onCancel: () => void
}) {
  const text = usePairingText()
  const left = countdown(() => props.link.expiresAt)
  const [copied, setCopied] = createSignal(false)
  // Apps get `ownpc://…` (pin + routes, 08 §3.3); browsers the https link of the Tailscale route.
  const value = () => (props.link.target === "browser" ? props.link.url : props.link.appLink)
  return (
    <div class="flex flex-col items-start gap-2" data-testid="pairing-link" data-target={props.link.target}>
      <Show
        when={left() > 0}
        fallback={
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[13px] text-own-muted">{text("own.pairing.qr.expired")}</span>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => props.onAgain()}>
              {text("own.pairing.qr.again")}
            </button>
          </div>
        }
      >
        <Show when={value()} fallback={<Notice tone="warn" testid="pairing-no-route">{text("own.pairing.noRoute")}</Notice>}>
          {(shown) => (
            <>
              <Show when={props.link.target !== "desktop"}>
                <QrCode value={shown()} label={text("own.pairing.qr.label")} />
                <span class="text-[12.5px] text-own-muted">
                  {props.link.target === "android" ? text("own.pairing.qr.app") : text("own.pairing.qr.label")}
                </span>
              </Show>
              <span class="text-[12.5px] text-own-muted">
                {props.link.target === "desktop" ? text("own.pairing.link.desktop") : text("own.pairing.qr.link")}
              </span>
              <div class="flex w-full flex-wrap items-center gap-2">
                <code class="own-mono min-w-0 flex-1 break-all text-[12px]" data-testid="pairing-url">
                  {shown()}
                </code>
                <button type="button" class="own-btn own-target" data-size="sm" onClick={() => void copyText(shown()).then(setCopied)}>
                  {copied() ? text("own.pairing.copied") : text("own.pairing.copy")}
                </button>
              </div>
            </>
          )}
        </Show>
        <span class="text-[12px] text-own-faint" data-testid="pairing-countdown">
          {text("own.pairing.qr.once", { time: clock(left()) })}
        </span>
        <Show when={props.local && props.link.target === "browser"}>
          <span class="text-[12px] text-own-warn">{text("own.pairing.qr.local")}</span>
        </Show>
        <button type="button" class="own-btn own-target" data-size="sm" onClick={() => props.onCancel()}>
          {text("own.pairing.qr.cancel")}
        </button>
      </Show>
    </div>
  )
}

// ---- approval (05 §13.5 양쪽 확인)

function ApproveDialog(props: {
  readonly request: Pending
  readonly onDone: (result: "approved" | "denied" | "rejected" | "expired") => void
  readonly onError: (error: unknown) => void
}) {
  const data = useData()
  const text = usePairingText()
  const i18n = useI18n()
  const left = countdown(() => props.request.expiresAt)
  const [busy, setBusy] = createSignal(false)
  createEffect(() => {
    if (left() <= 0) props.onDone("expired")
  })
  const allow = async () => {
    setBusy(true)
    try {
      await data.remote.call("devices.pair.approve", { pairingId: props.request.pairingId as never, sas: props.request.sas })
      props.onDone("approved")
    } catch (error) {
      if (error instanceof OwnRpcError && error.type === "pairing_rejected") props.onDone("rejected")
      else if (error instanceof OwnRpcError && error.type === "pairing_expired") props.onDone("expired")
      else props.onError(error)
    } finally {
      setBusy(false)
    }
  }
  const deny = async () => {
    await data.remote.call("devices.pair.cancel", { pairingId: props.request.pairingId as never }).catch(() => undefined)
    props.onDone("denied")
  }
  const device = () => props.request.userAgent ?? text("own.pairing.approve.unknownDevice")
  return (
    <Dialog
      open
      title={text("own.pairing.approve.title")}
      onClose={() => void deny()}
      testid="pairing-approve"
      footer={
        <>
          <button type="button" class="own-btn own-target" data-size="sm" disabled={busy()} data-testid="pairing-deny" onClick={() => void deny()}>
            {text("own.pairing.approve.deny")}
          </button>
          <button type="button" class="own-btn own-target" data-variant="primary" data-size="sm" disabled={busy()} data-testid="pairing-allow" onClick={() => void allow()}>
            {text("own.pairing.approve.allow")}
          </button>
        </>
      }
    >
      <p class="m-0 text-[13.5px]">{i18n.t("own.device.sas", { device: device(), sas: props.request.sas })}</p>
      <p class="m-0 my-3 text-center font-mono text-[40px] font-semibold tracking-[0.3em]" data-testid="pairing-sas">
        {props.request.sas}
      </p>
      <p class="m-0 text-[12.5px] text-own-muted">{text("own.pairing.approve.check")}</p>
      <p class="m-0 mt-1 text-[12px] text-own-faint">
        {props.request.name} · {text("own.pairing.approve.left", { time: clock(left()) })}
      </p>
    </Dialog>
  )
}

// ---- device list

function DeviceList(props: {
  readonly devices: readonly DeviceView[]
  /** The 모바일 미리보기 device of this shell (08 §4.3), tagged in the list. */
  readonly previewDevice?: string
  readonly onChanged: () => Promise<void>
  readonly onError: (error: unknown) => void
  readonly status: ReturnType<typeof createStatus>
}) {
  const data = useData()
  const text = usePairingText()
  const i18n = useI18n()
  const [editing, setEditing] = createSignal<string>()
  const [confirm, setConfirm] = createSignal<{ readonly deviceId: string; readonly name: string } | "all">()
  const active = () => props.devices.filter((device) => device.state === "active")
  const revoke = async () => {
    const target = confirm()
    setConfirm(undefined)
    try {
      if (target === "all") await data.remote.call("devices.revokeAll", {})
      else if (target) {
        await data.remote.call("devices.revoke", { deviceId: target.deviceId as never })
        props.status.ok(text("own.pairing.revoked", { name: target.name }))
      }
    } catch (error) {
      props.onError(error)
    }
    await props.onChanged()
  }
  return (
    <section class="own-psec" data-testid="pairing-devices">
      <div class="own-psec-head flex items-center gap-2">
        <h2 class="flex-1">{text("own.pairing.devices")}</h2>
        <Show when={active().length > 0}>
          <button type="button" class="own-btn own-target" data-variant="danger" data-size="sm" data-testid="pairing-revoke-all" onClick={() => setConfirm("all")}>
            {i18n.t("own.device.revokeAll")}
          </button>
        </Show>
      </div>
      <Show when={props.devices.length > 0} fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.pairing.devices.empty")}</p>}>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <For each={props.devices}>
            {(device) => (
              <li class="rounded-lg border border-own-border p-3" data-testid="pairing-device" data-device={device.deviceId} data-state={device.state}>
                <div class="flex flex-wrap items-center gap-2">
                  <b class="min-w-0 flex-1 truncate text-[13.5px]">{device.name}</b>
                  <Tag tone="soft">{text(`own.pairing.kind.${device.kind}` as PairingKey)}</Tag>
                  <Show when={device.deviceId === props.previewDevice}>
                    <Tag tone="accent" testid="pairing-device-preview">
                      {text("own.pairing.device.preview")}
                    </Tag>
                  </Show>
                  <Show when={device.state !== "active"}>
                    <Tag tone={device.state === "revoked" ? "danger" : "warn"}>
                      {text(device.state === "revoked" ? "own.pairing.state.revoked" : "own.pairing.state.expired")}
                    </Tag>
                  </Show>
                </div>
                <div class="mt-1 flex flex-wrap gap-1">
                  <For each={device.scopes}>{(scope) => <Tag>{text(`own.pairing.scope.${scope}` as PairingKey)}</Tag>}</For>
                  <Tag tone="plain">
                    {device.servers.mode === "all"
                      ? text("own.pairing.servers.all")
                      : device.servers.keys.map((key) => (key === "local" ? text("own.pairing.server.local") : (remoteStore()?.state.hosts[key]?.name ?? key))).join(", ")}
                  </Tag>
                </div>
                <p class="m-0 mt-1 text-[12px] text-own-muted">
                  {device.lastSeenAt ? text("own.pairing.lastSeen", { time: relativeTime(i18n, minuteNow(), device.lastSeenAt) }) : text("own.pairing.lastSeen.never")}
                  {device.userAgent ? ` · ${device.userAgent}` : ""}
                  {" · "}
                  {text("own.pairing.expiresAt", { date: new Date(device.expiresAt).toLocaleDateString(i18n.locale() === "ko" ? "ko-KR" : "en-US") })}
                </p>
                <Show when={device.state === "active"}>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button type="button" class="own-btn own-target" data-size="sm" data-testid="pairing-edit" onClick={() => setEditing(editing() === device.deviceId ? undefined : device.deviceId)}>
                      {text("own.pairing.edit")}
                    </button>
                    <button
                      type="button"
                      class="own-btn own-target"
                      data-variant="danger"
                      data-size="sm"
                      data-testid="pairing-revoke"
                      onClick={() => setConfirm({ deviceId: device.deviceId, name: device.name })}
                    >
                      {i18n.t("own.device.revoke")}
                    </button>
                  </div>
                  <Show when={editing() === device.deviceId}>
                    <ScopeEditor
                      device={device}
                      onSaved={async () => {
                        setEditing(undefined)
                        await props.onChanged()
                      }}
                      onError={props.onError}
                    />
                  </Show>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Dialog
        open={confirm() !== undefined}
        title={confirm() === "all" ? i18n.t("own.device.revokeAll") : i18n.t("own.device.revoke")}
        onClose={() => setConfirm(undefined)}
        testid="pairing-revoke-confirm"
        footer={
          <>
            <button type="button" class="own-btn own-target" data-size="sm" onClick={() => setConfirm(undefined)}>
              {text("own.pairing.plan.cancel")}
            </button>
            <button type="button" class="own-btn own-target" data-variant="danger" data-size="sm" data-testid="pairing-revoke-ok" onClick={() => void revoke()}>
              {confirm() === "all" ? i18n.t("own.device.revokeAll") : i18n.t("own.device.revoke")}
            </button>
          </>
        }
      >
        <p class="m-0 text-[13px]">
          {(() => {
            const target = confirm()
            return target === "all" ? text("own.pairing.revokeAll.confirm") : target ? text("own.pairing.revoke.confirm", { name: target.name }) : ""
          })()}
        </p>
      </Dialog>
    </section>
  )
}

function ScopeEditor(props: { readonly device: DeviceView; readonly onSaved: () => Promise<void>; readonly onError: (error: unknown) => void }) {
  const data = useData()
  const text = usePairingText()
  const [scopes, setScopes] = createSignal<ReadonlySet<DeviceScope>>(new Set(props.device.scopes))
  const save = async () => {
    try {
      await data.remote.call("devices.update", { deviceId: props.device.deviceId as never, scopes: scopeList(scopes()) })
      await props.onSaved()
    } catch (error) {
      props.onError(error)
    }
  }
  return (
    <div class="mt-2 flex flex-col gap-1" data-testid="pairing-scope-editor">
      <For each={SCOPES}>
        {(scope) => (
          <label class="own-target flex cursor-pointer items-center gap-2 text-[13px]" data-testid={`pairing-edit-scope-${scope}`}>
            <input type="checkbox" checked={scopes().has(scope)} onChange={() => setScopes((current) => toggleScope(current, scope))} />
            <span>{text(`own.pairing.scope.${scope}` as PairingKey)}</span>
            {/* 05 §8.10.2: an existing device gets 브라우저 only here, so this row says what leaves the PC. */}
            <Show when={scope === "browser"}>
              <span class="min-w-0 text-[12px] text-own-muted">{text("own.pairing.scope.browser.note")}</span>
            </Show>
          </label>
        )}
      </For>
      <Show when={[...scopes()].some((scope) => RISKY.has(scope))}>
        <Notice tone="warn">{text("own.pairing.risky")}</Notice>
      </Show>
      <button type="button" class="own-btn own-target self-start" data-variant="primary" data-size="sm" data-testid="pairing-scope-save" onClick={() => void save()}>
        {text("own.pairing.save")}
      </button>
    </div>
  )
}

// ---- countdowns

/** Seconds left, ticking once a second while mounted (a QR or a request on screen). */
function countdown(until: () => number) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return () => Math.max(0, Math.ceil((until() - now()) / 1000))
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
