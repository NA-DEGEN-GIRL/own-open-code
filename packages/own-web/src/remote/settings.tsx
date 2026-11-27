// 설정 > 원격 호스트 (04 §17.5), lazy page section. A host list, then the status panel of the selected host:
// connection (stage, last error, `user@host:port` fetched only while the panel is open, local endpoint, epoch),
// versions (this PC / remote running / staged, update), broker (state, leases, accounts blocked on this host), list
// (remote event subscription, catalog time), account scope and lease, trust and environment (project settings off by
// default with the risk text, shell mode, token lifetime; changes are "설정 대기"), warnings, actions and diagnostics
// (copied without secrets). Everything goes through RemoteStore; nothing here keeps a token. The broker section names
// the Claude subscription's state on the host (04 §8.11.13); it is switched on the PC's Claude card, not here.
import { createEffect, createMemo, createResource, createSignal, For, lazy, on, Show, Suspense } from "solid-js"
import { OwnRpcError, useData, type HostView } from "@/data"
import { ExplorerSettings } from "@/explorer/settings"
import { Notice, Segmented, Tag } from "@/limits/kit"
import { ManualLink } from "@/manual/link"
import { FolderSettings } from "@/projects/folder-settings"
import { useFolderSettingsText } from "@/projects/folder-settings-strings"
import { claudeHostState } from "@/servers/claude"
import {
  hostStatus,
  openRemoteDialog,
  remoteStore,
  selectedHostPanel,
  selectHostPanel,
  useServersText,
  type RemoteStore,
} from "@/servers"
import { minuteNow } from "@/shell/clock"
import { relativeTime } from "@/shell/format"
import { useI18n } from "@/i18n"
import { warningText } from "./add-host"
import { PROJECT_STATES, useRemoteText } from "./strings"

/** 04 §13 "MCP" (MH): the host's MCP servers from this PC and the way to install more. */
const McpHostSummary = lazy(() => import("@/mcp/host-summary"))

export default function RemoteSettings() {
  const text = useRemoteText()
  const store = remoteStore
  const selected = createMemo(() => {
    const current = store()
    if (!current) return undefined
    const chosen = selectedHostPanel()
    return chosen && current.state.hosts[chosen] ? chosen : current.state.order[0]
  })
  return (
    <div class="flex flex-col gap-4" data-testid="remote-settings">
      <Show
        when={store()?.state.status !== "unavailable"}
        fallback={<p class="own-placeholder px-0">{text("own.remote.settings.unavailable")}</p>}
      >
        <div class="flex flex-wrap items-center gap-2">
          <For each={store()?.state.order ?? []}>
            {(hostId) => (
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                data-variant={selected() === hostId ? "primary" : undefined}
                aria-pressed={selected() === hostId}
                data-testid="remote-settings-host"
                onClick={() => selectHostPanel(hostId)}
              >
                {store()!.state.hosts[hostId]?.name}
              </button>
            )}
          </For>
          <button
            type="button"
            class="own-btn own-target"
            data-size="sm"
            data-testid="remote-settings-add"
            disabled={!store()?.allowed("hosts.add")}
            onClick={() => openRemoteDialog({ kind: "add" })}
          >
            ＋ {useServersText()("own.remote.add")}
          </button>
        </div>
        <Show
          when={selected() && store()}
          fallback={
            <>
              <p class="own-placeholder px-0">{text("own.remote.settings.empty")}</p>
              <ManualLink place="remote" label="own.discover.manual.remote" class="self-start" />
            </>
          }
        >
          <Show when={selected()} keyed>
            {(hostId) => <HostPanel store={store()!} hostId={hostId} />}
          </Show>
        </Show>
      </Show>
      {/* This PC's setting, not a host's: the program `탐색기에서 열기` starts for SSH conversations (desktop only). */}
      <ExplorerSettings />
    </div>
  )
}

function HostPanel(props: { readonly store: RemoteStore; readonly hostId: string }) {
  const text = useRemoteText()
  const states = useServersText()
  const folders = useFolderSettingsText()
  const i18n = useI18n()
  const data = useData()
  const store = props.store
  const host = () => store.state.hosts[props.hostId]
  const live = () =>
    store.state.endpoints[props.hostId] ? store.runtime(props.hostId)?.connection.status() : undefined
  const status = () => (host() ? hostStatus(host()!, live()) : undefined)
  const [detail] = createResource(
    () => props.hostId,
    (id) => store.detail(id),
  )
  const [draft, setDraft] = createSignal<Draft>(draftOf(host()))
  const [saved, setSaved] = createSignal<"saved" | string>()
  const [copied, setCopied] = createSignal(false)
  // A fresh draft when the host record changes from elsewhere (another window, the add flow).
  createEffect(
    on(
      () => host()?.pendingSettings,
      () => setDraft(draftOf(host())),
      { defer: true },
    ),
  )
  const accounts = () => data.local().own.state.accountOrder.flatMap((id) => data.local().own.state.accounts[id] ?? [])
  /** The host's own Claude login or claude-auth keeps it off the PC's slot (04 §8.11.5, its `health.claudeSlot`). */
  const claudeConflict = () => store.runtime(props.hostId)?.own.state.health?.claudeSlot?.conflict === true
  const changed = () => JSON.stringify(draft()) !== JSON.stringify(draftOf(host()))

  async function save() {
    const view = host()
    const next = draft()
    if (!view) return
    if (
      next.projectConfig === "trusted" &&
      view.projectConfig !== "trusted" &&
      !confirm(text("own.remote.projectConfig.warn"))
    )
      return
    try {
      await store.update({
        hostId: props.hostId,
        autoConnect: next.autoConnect,
        accounts: next.accountsMode === "all" ? { mode: "all" } : { mode: "only", ids: next.accountIDs },
        leaseSeconds: Math.round(next.leaseMinutes * 60),
        failClosedGraceSeconds: next.graceSeconds,
        tokenTtlHours: next.tokenTtlHours,
        projectConfig: next.projectConfig,
        shellEnv: next.shellEnv,
      })
      setSaved("saved")
    } catch (error) {
      setSaved(error instanceof OwnRpcError ? error.type : String(error))
    }
  }

  async function copyDiagnostics() {
    const result = await store.diagnostics(props.hostId).catch(() => undefined)
    if (!result) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(result, null, 2))
      setCopied(true)
    } catch {}
  }

  return (
    <Show when={host()}>
      {(view) => (
        <div class="flex flex-col gap-4 text-[13px]" data-testid="remote-host-panel" data-host={props.hostId}>
          <Section title={text("own.remote.settings.connection")}>
            <Row label={text("own.remote.settings.stage")}>
              <span data-testid="remote-panel-stage">
                {status() ? states(`own.remote.state.${status()!.key}`) : view().stage}
              </span>
            </Row>
            <Show when={view().error}>
              {(error) => (
                <Row label={text("own.remote.settings.lastError")}>{states(`own.remote.error.${error()}`)}</Row>
              )}
            </Show>
            <Row label={text("own.remote.settings.destination")}>
              <span class="own-mono" data-testid="remote-panel-destination">
                {detail()?.destination ?? view().target}
              </span>
            </Row>
            <Show when={view().broker.claude}>
              {(relay) => (
                <Row label={text("own.remote.settings.claude")}>
                  <span data-testid="remote-panel-claude" data-state={relay().state}>
                    {claudeConflict()
                      ? text("own.remote.claudeSlot.conflict")
                      : i18n.t(`own.claude.remote.state.${claudeHostState(relay().state, view(), minuteNow())}`)}
                  </span>
                  <span class="block text-[12px] text-own-faint">{text("own.remote.settings.claudeHint")}</span>
                </Row>
              )}
            </Show>
            {/* 04 §8.14: this PC's local models on the host, through this PC without a switch (a broker that relays). */}
            <Show when={view().broker.local}>
              {(relay) => (
                <Row label={text("own.remote.settings.local")}>
                  <span data-testid="remote-panel-local" data-error={relay().lastError ?? undefined}>
                    {relay().inflight > 0
                      ? text("own.remote.settings.localBusy", { n: relay().inflight })
                      : text("own.remote.settings.localValue")}
                  </span>
                  <span class="block text-[12px] text-own-faint">{text("own.remote.settings.localHint")}</span>
                </Row>
              )}
            </Show>
            <Show when={view().versions.skew || view().stage === "incompatible"}>
              <button
                type="button"
                class="own-btn own-target self-start"
                data-size="sm"
                onClick={() => openRemoteDialog({ kind: "update", hostId: props.hostId })}
              >
                {states("own.remote.action.update")}
              </button>
            </Show>
          </Section>

          {/* Addresses, versions, the account connection and the list state matter only when something is wrong. */}
          <details class="flex flex-col gap-4" data-testid="remote-panel-troubleshoot">
            <summary class="own-target cursor-pointer text-own-muted">{text("own.remote.settings.troubleshoot")}</summary>
            <Section title={text("own.remote.settings.connection")}>
              <Row label={text("own.remote.settings.endpoint")}>
                <span class="own-mono">{`${view().loopback}:${view().localPort}`}</span>
              </Row>
              <Row label={text("own.remote.settings.epoch")}>{view().epoch}</Row>
            </Section>

            <Section title={text("own.remote.settings.versions")}>
              <Row label={text("own.remote.settings.versionLocal")}>{view().versions.local}</Row>
              <Row label={text("own.remote.settings.versionRemote")}>{view().versions.remoteRunning ?? "—"}</Row>
              <Row label={text("own.remote.settings.versionStaged")}>
                {view().versions.remoteStaged.join(", ") || "—"}
              </Row>
            </Section>

            <Section title={text("own.remote.settings.broker")}>
              <Row label={text("own.remote.settings.stage")}>
                <span data-testid="remote-panel-broker" data-state={view().broker.state}>
                  {text(`own.remote.settings.brokerState.${view().broker.state}`)}
                </span>
              </Row>
              <Row label={text("own.remote.settings.leaseRow")}>
                {text("own.remote.settings.leases", { n: view().broker.leasesActive })}
              </Row>
              <Show when={view().broker.sourceStale.length}>
                <Row label={text("own.remote.settings.sourceStale")}>
                  {view()
                    .broker.sourceStale.map((id) => data.local().own.state.accounts[id]?.label ?? id)
                    .join(", ")}
                </Row>
              </Show>
            </Section>

            <Section title={text("own.remote.settings.list")}>
              <p class="m-0 text-own-muted">{text("own.remote.settings.events", { state: view().events.state })}</p>
              <Show when={view().events.catalogFetchedAt}>
                {(at) => (
                  <p class="m-0 text-own-muted">
                    {text("own.remote.settings.catalog", { time: relativeTime(i18n, minuteNow(), at()) })}
                  </p>
                )}
              </Show>
            </Section>
          </details>

          <Section title={text("own.remote.settings.accounts")}>
            <Segmented
              label={text("own.remote.settings.accounts")}
              value={draft().accountsMode}
              options={[
                { value: "all", label: text("own.remote.settings.accountsAll") },
                { value: "only", label: text("own.remote.settings.accountsOnly") },
              ]}
              onChange={(value) => setDraft((current) => ({ ...current, accountsMode: value }))}
            />
            <Show when={draft().accountsMode === "only"}>
              <div class="flex flex-wrap gap-2">
                <For each={accounts()}>
                  {(account) => (
                    <label class="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={draft().accountIDs.includes(account.id)}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            accountIDs: event.currentTarget.checked
                              ? [...current.accountIDs, account.id]
                              : current.accountIDs.filter((id) => id !== account.id),
                          }))
                        }
                      />
                      {account.label}
                    </label>
                  )}
                </For>
              </div>
            </Show>
            <NumberRow
              label={text("own.remote.settings.lease")}
              value={draft().leaseMinutes}
              min={1}
              max={240}
              onChange={(value) => setDraft((current) => ({ ...current, leaseMinutes: value }))}
            />
            <p class="m-0 text-[12px] text-own-faint">{text("own.remote.lease.help")}</p>
            <NumberRow
              label={text("own.remote.settings.grace")}
              value={draft().graceSeconds}
              min={0}
              max={600}
              onChange={(value) => setDraft((current) => ({ ...current, graceSeconds: value }))}
            />
          </Section>

          <Section title={text("own.remote.settings.trust")}>
            <Row label={text("own.remote.settings.projectConfig")}>
              <Segmented
                label={text("own.remote.settings.projectConfig")}
                value={draft().projectConfig}
                options={PROJECT_STATES.map((state) => ({ value: state.value, label: text(state.label) }))}
                onChange={(value) => setDraft((current) => ({ ...current, projectConfig: value }))}
                testid="remote-project-config"
              />
            </Row>
            <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12px]" data-testid="remote-project-config-help">
              <For each={PROJECT_STATES}>
                {(state) => (
                  <li
                    class={draft().projectConfig === state.value ? "text-own-muted" : "text-own-faint"}
                    data-state={state.value}
                    data-current={draft().projectConfig === state.value ? "" : undefined}
                  >
                    {text(state.help)}
                  </li>
                )}
              </For>
            </ul>
            <Show when={draft().projectConfig === "trusted"}>
              <Notice tone="warn">{text("own.remote.projectConfig.warn")}</Notice>
            </Show>
            <Row label={text("own.remote.settings.shellEnv")}>
              <Segmented
                label={text("own.remote.settings.shellEnv")}
                value={draft().shellEnv}
                options={[
                  { value: "login", label: text("own.remote.settings.shell.login") },
                  { value: "login-interactive", label: text("own.remote.settings.shell.loginInteractive") },
                  { value: "sh", label: text("own.remote.settings.shell.sh") },
                ]}
                onChange={(value) => setDraft((current) => ({ ...current, shellEnv: value }))}
              />
            </Row>
            <NumberRow
              label={text("own.remote.settings.tokenTtl")}
              value={draft().tokenTtlHours}
              min={8}
              max={24}
              onChange={(value) => setDraft((current) => ({ ...current, tokenTtlHours: value }))}
            />
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft().autoConnect}
                data-testid="remote-auto-connect"
                onChange={(event) => setDraft((current) => ({ ...current, autoConnect: event.currentTarget.checked }))}
              />
              {text("own.remote.settings.autoConnect")}
            </label>
            <Show when={view().pendingSettings}>
              <Tag tone="warn" testid="remote-pending">
                {text("own.remote.settings.pending")}
              </Tag>
            </Show>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="own-btn own-target"
                data-variant="primary"
                data-size="sm"
                data-testid="remote-settings-save"
                disabled={!changed()}
                onClick={() => void save()}
              >
                {text("own.remote.settings.save")}
              </button>
              <Show when={saved()}>
                {(value) => (
                  <span class="text-[12px] text-own-muted" role="status">
                    {value() === "saved"
                      ? text("own.remote.settings.saved")
                      : text("own.remote.op.failed", { reason: value() })}
                  </span>
                )}
              </Show>
            </div>
          </Section>

          {/* 03 §5.1 (2.2.6-own.16): the host's own default conversation folder, kept by its service. */}
          <Suspense>
            <McpHostSummary hostId={props.hostId} />
          </Suspense>
          <Section title={folders("own.project.folderSetting.hostTitle")}>
            <Show
              when={live() === "connected" ? store.runtime(props.hostId) : undefined}
              keyed
              fallback={
                <p class="m-0 text-[12px] text-own-faint" data-testid="remote-folder-offline">
                  {folders("own.project.folderSetting.hostOffline")}
                </p>
              }
            >
              {(runtime) => <FolderSettings runtime={runtime} host />}
            </Show>
          </Section>

          <Show when={view().warnings.length}>
            <Section title={text("own.remote.settings.warnings")}>
              <For each={view().warnings}>{(warning) => <Notice tone="warn">{warningText(text, warning)}</Notice>}</For>
            </Section>
          </Show>

          <Section title={text("own.remote.settings.actions")}>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                data-testid="remote-panel-reconnect"
                onClick={() => void store.connect(props.hostId).catch(() => undefined)}
              >
                {states("own.remote.action.reconnect")}
              </button>
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                data-testid="remote-panel-disconnect"
                onClick={() => void store.disconnect(props.hostId).catch(() => undefined)}
              >
                {states("own.remote.action.disconnect")}
              </button>
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                onClick={() => openRemoteDialog({ kind: "add", hostId: props.hostId, hostKey: true })}
              >
                {states("own.remote.action.checkHostKey")}
              </button>
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                onClick={() => openRemoteDialog({ kind: "drain", hostId: props.hostId })}
              >
                {states("own.remote.action.drain")}
              </button>
              <Show when={view().error === "other_owner"}>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-size="sm"
                  onClick={() => openRemoteDialog({ kind: "takeover", hostId: props.hostId })}
                >
                  {states("own.remote.action.takeover")}
                </button>
              </Show>
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                data-testid="remote-panel-diagnostics"
                onClick={() => void copyDiagnostics()}
              >
                {text("own.remote.settings.diagnostics")}
              </button>
              <button
                type="button"
                class="own-btn own-target"
                data-size="sm"
                data-variant="danger"
                onClick={() => openRemoteDialog({ kind: "forget", hostId: props.hostId })}
              >
                {states("own.remote.action.remove")}
              </button>
            </div>
            <Show when={copied()}>
              <p class="m-0 text-[12px] text-own-muted" role="status">
                {text("own.remote.settings.copied")}
              </p>
            </Show>
          </Section>
        </div>
      )}
    </Show>
  )
}

interface Draft {
  readonly autoConnect: boolean
  readonly accountsMode: "all" | "only"
  readonly accountIDs: readonly string[]
  readonly leaseMinutes: number
  readonly graceSeconds: number
  readonly tokenTtlHours: number
  readonly projectConfig: HostView["projectConfig"]
  readonly shellEnv: "login" | "login-interactive" | "sh"
}

function draftOf(view: HostView | undefined): Draft {
  return {
    autoConnect: view?.autoConnect ?? false,
    accountsMode: view?.accounts.mode ?? "all",
    accountIDs: view?.accounts.mode === "only" ? [...view.accounts.ids] : [],
    leaseMinutes: Math.round((view?.leaseSeconds ?? 900) / 60),
    graceSeconds: view?.failClosedGraceSeconds ?? 300,
    tokenTtlHours: view?.tokenTtlHours ?? 12,
    projectConfig: view?.projectConfig ?? "instructions",
    shellEnv: view?.shellEnv ?? "login",
  }
}

function Section(props: { readonly title: string; readonly children: unknown }) {
  return (
    <section class="flex flex-col gap-2 rounded-[var(--own-radius-card)] border border-own-border px-4 py-3">
      <h2 class="m-0 text-[13.5px] font-semibold">{props.title}</h2>
      {props.children as never}
    </section>
  )
}

function Row(props: { readonly label: string; readonly children: unknown }) {
  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="w-36 flex-none text-own-muted">{props.label}</span>
      <span class="min-w-0 flex-1 break-all">{props.children as never}</span>
    </div>
  )
}

function NumberRow(props: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly onChange: (value: number) => void
}) {
  return (
    <label class="flex items-center gap-3">
      <span class="w-36 flex-none text-own-muted">{props.label}</span>
      <input
        type="number"
        class="own-input h-8 w-24"
        min={props.min}
        max={props.max}
        value={props.value}
        onChange={(event) => {
          const value = Number(event.currentTarget.value)
          if (Number.isFinite(value)) props.onChange(Math.min(props.max, Math.max(props.min, Math.round(value))))
        }}
      />
    </label>
  )
}
