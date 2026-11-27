// 설정 > 업데이트 (05 §20, UPD 2026-11-04; lazy, `/settings/updates`). The programs own runs on this PC that the user
// installed (own.accounts `tools.view`): each one's installed and newest version, its status (최신 / 업데이트 권장 with
// the reason / 필요 when a feature refuses it) and how it updates. `업데이트` opens the card that shows the exact command
// and its source (confirm.tsx); a program installed for all users, bundled or without an updater gets manual steps
// with the command to copy. `새 버전 확인` turns the daily release reads off. Local model servers show their version
// only. SSH hosts show what own installed there and update through own.remote's own host update (`update.plan`).
import { createResource, createSignal, For, lazy, Show, Suspense } from "solid-js"
import type { ToolUpdates } from "@own/protocol"
import { useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { copyText, Segmented, Spinner, Tag, type TagTone } from "@/limits/kit"
import { remoteStore } from "@/servers"
import { relativeTime } from "@/shell/format"
import { UpdateDialog } from "./confirm"
import { TOOL_NAMES, useToolUpdatesText, type ToolUpdatesKey } from "./strings"

const HostUpdate = lazy(() => import("@/remote/operations").then((module) => ({ default: module.OperationDialog })))

const TONES: Readonly<Record<ToolUpdates.Status, TagTone>> = {
  current: "ok",
  recommended: "warn",
  required: "danger",
  missing: "plain",
  unknown: "dashed",
}

export default function ToolUpdateSettings() {
  const text = useToolUpdatesText()
  const data = useData()
  const runtime = () => data.local()
  const allowed = () => runtime().rpc.allowed("tools.view")
  const [refresh, setRefresh] = createSignal(false)
  const [view, { mutate, refetch }] = createResource(
    () => (allowed() ? { refresh: refresh() } : false),
    (input) => runtime().rpc.call("tools.view", input.refresh ? { refresh: true } : {}),
  )
  const [open, setOpen] = createSignal<ToolUpdates.Component>()
  const [hostOpen, setHostOpen] = createSignal<string>()
  const checkNow = () => {
    if (refresh()) return void refetch()
    setRefresh(true)
  }
  const setCheck = async (checkLatest: boolean) => {
    const answer = await runtime().rpc.call("tools.settings.set", { checkLatest })
    mutate(answer)
  }
  return (
    <div class="flex flex-col gap-3" data-testid="settings-updates">
      <Show when={allowed()} fallback={<p class="own-placeholder px-0">{text("own.upd.localOnly")}</p>}>
        <p class="m-0 text-[13px] text-own-muted">{text("own.upd.lead")}</p>
        <Show when={view.error}>
          {(error) => (
            <p class="m-0 text-[12.5px] text-own-danger" role="alert" data-testid="updates-error">
              {text("own.upd.loadFailed", { error: String(error()) })}
            </p>
          )}
        </Show>
        <Show
          when={view.latest}
          fallback={
            <p class="m-0 flex items-center gap-2 text-[13px] text-own-muted">
              <Spinner /> {text("own.upd.loading")}
            </p>
          }
        >
          {(current) => (
            <>
              <CheckRow view={current()} busy={view.loading} onSet={(value) => void setCheck(value)} onCheck={checkNow} />
              <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="updates-list">
                <For each={current().items}>
                  {(item) => (
                    <ItemRow
                      item={item}
                      running={current().job?.state === "running" ? current().job!.component : undefined}
                      onUpdate={setOpen}
                    />
                  )}
                </For>
              </ul>
              <Show when={current().servers.length > 0}>
                <Servers servers={current().servers} />
              </Show>
              <Hosts lfs={current().hostGitLfs} onUpdate={setHostOpen} />
            </>
          )}
        </Show>
      </Show>
      <Show when={open()}>
        {(component) => (
          <UpdateDialog
            runtime={runtime()}
            component={component()}
            onClose={() => {
              setOpen(undefined)
              // An update left running shows as such on its row (`진행 보기`).
              void refetch()
            }}
            onEnded={() => void refetch()}
          />
        )}
      </Show>
      <Show when={hostOpen() && remoteStore()}>
        <Suspense>
          <HostUpdate store={remoteStore()!} hostId={hostOpen()!} kind="update" onClose={() => setHostOpen(undefined)} />
        </Suspense>
      </Show>
    </div>
  )
}

function CheckRow(props: {
  readonly view: ToolUpdates.View
  readonly busy: boolean
  readonly onSet: (checkLatest: boolean) => void
  readonly onCheck: () => void
}) {
  const text = useToolUpdatesText()
  const i18n = useI18n()
  const checked = () => {
    const at = props.view.checkedAt
    if (!props.view.checkLatest) return text("own.upd.checkOff")
    return at === undefined
      ? text("own.upd.neverChecked")
      : text("own.upd.checkedAt", { time: relativeTime(i18n, Date.now(), at) })
  }
  return (
    <div class="flex flex-col gap-1.5 border-b border-own-border pb-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div class="min-w-[220px] flex-1">
          <b class="block text-[13.5px] font-semibold">{text("own.upd.check")}</b>
          <span class="text-[12px] text-own-muted">{text("own.upd.checkNote")}</span>
        </div>
        <Segmented
          label={text("own.upd.check")}
          value={props.view.checkLatest ? "on" : "off"}
          options={[
            { value: "on", label: text("own.upd.on") },
            { value: "off", label: text("own.upd.off") },
          ]}
          onChange={(value) => props.onSet(value === "on")}
          testid="updates-check"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2 text-[12px] text-own-muted">
        <span data-testid="updates-checked">{checked()}</span>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-testid="updates-refresh"
          disabled={props.busy}
          onClick={() => props.onCheck()}
        >
          {text("own.upd.refresh")}
        </button>
        <Show when={props.busy}>
          <Spinner />
        </Show>
      </div>
      <Show when={props.view.failed.length > 0}>
        <span class="text-[12px] text-own-muted" data-testid="updates-failed">
          {text("own.upd.failed", { names: props.view.failed.map((id) => TOOL_NAMES[id]).join(", ") })}
        </span>
      </Show>
    </div>
  )
}

function ItemRow(props: {
  readonly item: ToolUpdates.Item
  /** The component whose update runs (the card was closed while it ran): its button opens the card that follows it. */
  readonly running: ToolUpdates.Component | undefined
  readonly onUpdate: (component: ToolUpdates.Component) => void
}) {
  const text = useToolUpdatesText()
  const item = () => props.item
  const why = () => {
    const reason = item().why
    if (!reason) return undefined
    return text(`own.upd.why.${reason}` as ToolUpdatesKey, {
      version: item().threshold ?? "",
      minimum: item().minimum ?? "",
      latest: item().latest ?? "",
    })
  }
  const following = () => props.running === item().id
  const offered = () =>
    following() || (item().update.type === "run" && ["recommended", "required", "unknown"].includes(item().status))
  return (
    <li
      class="flex flex-col gap-1 rounded-md border border-own-border px-3 py-2.5"
      data-testid="updates-item"
      data-id={item().id}
      data-status={item().status}
    >
      <div class="flex flex-wrap items-center gap-2">
        <b class="text-[13.5px] font-semibold">{TOOL_NAMES[item().id]}</b>
        <Tag tone={TONES[item().status]} testid="updates-status">
          {text(`own.upd.status.${item().status}`)}
        </Tag>
        <span class="flex-1" />
        <Show when={offered()}>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            data-testid="updates-update"
            disabled={props.running !== undefined && !following()}
            onClick={() => props.onUpdate(item().id)}
          >
            {text(following() ? "own.upd.progress" : "own.upd.update")}
          </button>
        </Show>
      </div>
      <Show when={item().path !== null || item().installed !== null}>
        <span class="text-[12.5px]" data-testid="updates-versions">
          {item().installed === null
            ? text("own.upd.installedUnknown")
            : text("own.upd.installed", { version: item().installed! })}
          {" · "}
          {item().latest === null ? text("own.upd.latestUnknown") : text("own.upd.latest", { version: item().latest! })}
        </span>
      </Show>
      <Show when={why()}>
        {(line) => (
          <span class="text-[12.5px]" data-testid="updates-why">
            {line()}
          </span>
        )}
      </Show>
      <Show when={item().reviewed && item().installed !== item().reviewed}>
        <span class="text-[12px] text-own-muted">{text("own.upd.reviewed", { version: item().reviewed! })}</span>
      </Show>
      <Show when={item().path}>
        {(location) => (
          <span class="break-all text-[11.5px] text-own-muted" data-testid="updates-path">
            {text("own.upd.path", { path: location() })}
          </span>
        )}
      </Show>
      <Show when={item().update.type === "manual" && item().why !== "own_copy" && item().status !== "current"}>
        <Manual method={item().update as Extract<ToolUpdates.Method, { type: "manual" }>} />
      </Show>
    </li>
  )
}

function Manual(props: { readonly method: Extract<ToolUpdates.Method, { type: "manual" }> }) {
  const text = useToolUpdatesText()
  const host = useHost()
  const [copied, setCopied] = createSignal(false)
  return (
    <div class="mt-1 flex flex-col gap-1 text-[12.5px]" data-testid="updates-manual" data-why={props.method.why}>
      <span>{text(`own.upd.manual.${props.method.why}`)}</span>
      <Show when={props.method.command}>
        {(command) => (
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-own-muted">{text("own.upd.command")}</span>
            <code class="rounded border border-own-border px-1.5 py-0.5 font-mono" data-testid="updates-command">
              {command()}
            </code>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="updates-copy"
              onClick={() => void copyText(command()).then(setCopied)}
            >
              {text(copied() ? "own.upd.copied" : "own.upd.copy")}
            </button>
          </div>
        )}
      </Show>
      <div>
        <button
          type="button"
          class="own-target border-0 bg-transparent p-0 text-own-accent-text underline"
          data-testid="updates-source"
          onClick={() => host.openExternal(props.method.source)}
        >
          {text("own.upd.source")} ↗
        </button>
      </div>
    </div>
  )
}

function Servers(props: { readonly servers: ReadonlyArray<ToolUpdates.Server> }) {
  const text = useToolUpdatesText()
  return (
    <section class="flex flex-col gap-1.5 pt-2" data-testid="updates-servers">
      <b class="text-[13.5px] font-semibold">{text("own.upd.servers")}</b>
      <span class="text-[12px] text-own-muted">{text("own.upd.serversNote")}</span>
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        <For each={props.servers}>
          {(server) => (
            <li class="text-[12.5px]" data-testid="updates-server">
              {server.label} · {server.url} ·{" "}
              {server.version === null
                ? text("own.upd.serverUnknown")
                : text("own.upd.serverVersion", { version: server.version })}
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

/** The SSH hosts' own bundle (and with it the git-lfs own put there): updated only by own.remote's host update. */
function Hosts(props: { readonly lfs: string; readonly onUpdate: (hostId: string) => void }) {
  const text = useToolUpdatesText()
  const hosts = () => {
    const store = remoteStore()
    return store ? store.state.order.flatMap((id) => (store.state.hosts[id] ? [store.state.hosts[id]!] : [])) : []
  }
  return (
    <section class="flex flex-col gap-1.5 pt-2" data-testid="updates-hosts">
      <b class="text-[13.5px] font-semibold">{text("own.upd.hosts")}</b>
      <span class="text-[12px] text-own-muted">{text("own.upd.hostsNote", { lfs: props.lfs })}</span>
      <Show when={hosts().length > 0} fallback={<span class="text-[12.5px] text-own-muted">{text("own.upd.hostsNone")}</span>}>
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
          <For each={hosts()}>
            {(host) => (
              <li
                class="flex flex-wrap items-center gap-2 text-[12.5px]"
                data-testid="updates-host"
                data-skew={host.versions.skew ? "" : undefined}
              >
                <b class="font-semibold">{host.name}</b>
                <span>
                  {host.versions.remoteRunning === null
                    ? text("own.upd.hostNotInstalled")
                    : text("own.upd.hostVersion", { remote: host.versions.remoteRunning, local: host.versions.local })}
                </span>
                <Show
                  when={host.versions.skew}
                  fallback={
                    <Show when={host.versions.remoteRunning !== null}>
                      <Tag tone="ok">{text("own.upd.hostCurrent")}</Tag>
                    </Show>
                  }
                >
                  <Tag tone="danger">{text("own.upd.status.required")}</Tag>
                  <span class="text-own-muted">{text("own.upd.hostSkew")}</span>
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    data-testid="updates-host-update"
                    onClick={() => props.onUpdate(host.id)}
                  >
                    {text("own.upd.hostUpdate")}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
