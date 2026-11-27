// 설정 > MCP 서버 `SSH 호스트에서 쓰기` (04 §13 "MCP", 03 §18.14, MH 2026-11-26). Lazy chunk of the settings page.
//
// - Reads every SSH host the window knows: a connected one's installed servers (`mcp.host.view`) and what it has
//   (`mcp.host.probe`, in the host service's environment), and this PC's records of values sent (`mcp.hosts.view`).
//   A host whose service predates `mcp.host.*` answers `rpc.method_not_found`: `호스트 최신 아님`.
// - Analyses every server this PC knows (own's and the config files', disabled ones too) per host (`McpHostRules`)
//   and keeps it calm: one summary line per host, the servers' rows on demand, details under each row.
// - Installs: `mcp.host.save` with the translated definition (no value), then the user's own send step for values
//   (`mcp.hosts.send`, never by default), a pre-fetch, and the host's connection test. `AI에게 설치 맡기기` starts a new
//   conversation on the host with a self-contained brief (`McpHostRules.brief`) and the install job.
// - A phone or another PC sees each host's installed servers only (`mcp.host.view` is `read`); installing, sending
//   and the probe are `local`.
import type { ConfigEntry } from "@opencode/client"
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { requestStart } from "@/composer/start-intent"
import { OwnRpcError, useData, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Spinner, Tag, type TagTone } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { remoteStore } from "@/servers"
import { showToast } from "@/switcher/toast"
import { fileTransport } from "./manage-model"
import { mcpHostTarget, setHostLines, setMcpHostTarget } from "./hosts-line"
import {
  direct,
  hostInputs,
  job,
  orphans,
  rows,
  shown,
  summary,
  type HostData,
  type HostServer,
  type HostView,
  type Probe,
  type Row,
  type RowState,
  type Send,
  type Source,
} from "./hosts-model"
import { useMcpHostsText, type McpHostsKey } from "./hosts-strings"

export interface McpHostsProps {
  readonly sources: ReadonlyArray<Source>
  readonly entries: ReadonlyArray<ConfigEntry>
  readonly project?: string
}

const TONE: Readonly<Record<RowState, TagTone>> = {
  installed: "ok",
  differs: "warn",
  ready: "accent",
  prepare: "soft",
  assist: "soft",
  "pc-only": "plain",
  unknown: "dashed",
  old: "warn",
  offline: "dashed",
}

export default function McpHosts(props: McpHostsProps) {
  const data = useData()
  const text = useMcpHostsText()
  const i18n = useI18n()
  const router = useRouter()
  const remote = remoteStore
  const local = () => data.local().rpc.allowed("mcp.hosts.send")
  const hostIds = () => remote()?.state.order ?? []
  const hostName = (id: string) => remote()?.host(id)?.name ?? id
  const [selected, setSelected] = createSignal<string>()
  const chosen = () => {
    const pick = selected()
    if (pick && hostIds().includes(pick)) return pick
    return hostIds().find((id) => remote()?.host(id)?.stage === "ready") ?? hostIds()[0]
  }
  createEffect(() => {
    const target = mcpHostTarget()
    if (target === undefined) return
    setSelected(target)
    setMcpHostTarget(undefined)
    requestAnimationFrame(() => document.querySelector('[data-testid="mcp-hosts"]')?.scrollIntoView({ block: "start" }))
  })
  const [home] = createResource(() =>
    data
      .local()
      .rpc.call("folderPicker.get", {})
      .then((view) => view.home)
      .catch(() => ""),
  )
  const [sends, { refetch: refetchSends }] = createResource(
    () => (data.local().rpc.allowed("mcp.hosts.view") ? true : undefined),
    () =>
      data
        .local()
        .rpc.call("mcp.hosts.view", {})
        .then((view) => view.sends as ReadonlyArray<Send>)
        .catch(() => [] as ReadonlyArray<Send>),
  )
  onCleanup(data.local().own.on("mcp.changed", () => void refetchSends()))

  // Per host: what it has and holds. Read again on its `mcp.changed` and when it connects.
  const [hosts, setHosts] = createStore<Record<string, HostData>>({})
  const binaries = createMemo(() => [
    ...new Set(
      props.sources.flatMap((source) => McpHostRules.analyze(source, { home: home() ?? "" }).binaries),
    ),
  ])
  const runtimeOf = (id: string): ServerRuntime | undefined => {
    const view = remote()?.host(id)
    const runtime = remote()?.runtime(id)
    return view?.stage === "ready" && runtime?.connection.status() === "connected" ? runtime : undefined
  }
  async function load(id: string) {
    // A host running another build (it needs the update, or drains): its broker gives no values and its service may
    // predate `mcp.host.*`.
    const record = remote()?.host(id)
    if (record && (record.versions.skew || record.stage === "incompatible" || record.broker.mode === "drain"))
      return setHosts(id, { status: "old" })
    const runtime = runtimeOf(id)
    if (!runtime) return setHosts(id, { status: "offline" })
    if (hosts[id]?.status !== "ready") setHosts(id, { status: "loading" })
    const old = (error: unknown) => error instanceof OwnRpcError && error.type === "rpc.method_not_found"
    const view = await runtime.rpc.call("mcp.host.view", {}).catch((error: unknown) => (old(error) ? "old" : undefined))
    if (view === "old") return setHosts(id, { status: "old" })
    if (view === undefined) return setHosts(id, { status: "error" })
    const probe = runtime.rpc.allowed("mcp.host.probe")
      ? await runtime.rpc.call("mcp.host.probe", { binaries: binaries() }).catch(() => undefined)
      : undefined
    setHosts(id, { status: "ready", view: view as HostView, ...(probe ? { probe: probe as Probe } : {}) })
  }
  createEffect(() => {
    void binaries()
    for (const id of hostIds()) {
      // Tracks the host's record (stage, versions) and its runtime's connection; the read itself is untracked, so its
      // own writes to `hosts` never run this again.
      void remote()?.host(id)
      const live = runtimeOf(id)
      untrack(() => void load(id))
      if (live) onCleanup(live.own.on("mcp.changed", () => void load(id)))
    }
  })

  const rowsOf = (id: string) =>
    rows(props.sources, hosts[id] ?? { status: "loading" }, sends() ?? [], {
      home: home() ?? "",
      ...(props.project ? { project: props.project } : {}),
      hostId: id,
    })
  // The page's per-server host line.
  createEffect(() => {
    const lines = new Map<string, { hostId: string; host: string; state: RowState }[]>()
    for (const id of hostIds())
      for (const row of rowsOf(id))
        lines.set(row.source.key, [...(lines.get(row.source.key) ?? []), { hostId: id, host: hostName(id), state: row.state }])
    setHostLines(lines)
  })
  onCleanup(() => setHostLines(new Map()))

  const [open, setOpen] = createSignal(false)
  const [reviewing, setReviewing] = createSignal(false)
  const [assisting, setAssisting] = createSignal<Row>()
  const [removing, setRemoving] = createSignal<{ readonly server: HostServer; readonly row?: Row }>()
  const [busy, setBusy] = createStore<Record<string, boolean>>({})

  const sourceRef = (source: Source) =>
    source.origin === "own"
      ? { type: "own" as const, id: source.key.slice("own:".length) }
      : (() => {
          const transport = fileTransport(props.entries, source.name)
          return transport ? { type: "file" as const, name: source.name, transport } : undefined
        })()

  /** Installs or updates one row on the host: definition, the values the user chose, pre-fetch, connection test. */
  async function install(
    id: string,
    row: Row,
    choice: { readonly fills?: Readonly<Record<number, string>>; readonly cwd?: string; readonly send?: ReadonlyArray<string> },
  ) {
    const runtime = runtimeOf(id)
    const host = hosts[id]
    if (!runtime || host?.status !== "ready") return undefined
    const transport = McpHostRules.translate(row.source, row.analysis, {
      ...(host.probe ? { probe: host.probe } : {}),
      ...(choice.fills ? { args: choice.fills } : {}),
      ...(choice.cwd ? { cwd: choice.cwd } : {}),
    })
    if (!transport) throw new Error("not translatable")
    const saved = await runtime.rpc.call("mcp.host.save", {
      ...(row.installed ? { id: row.installed.id as never } : {}),
      name: row.source.name as never,
      transport: transport as never,
      pc: { key: row.source.key, hash: McpHostRules.hash(row.source), at: Date.now() },
    })
    const server = (saved.servers as ReadonlyArray<HostServer>).find((item) => item.name === row.source.name)
    if (!server) throw new Error("not saved")
    // An update sends again what was sent before; a new install only what the user checked now.
    const names = choice.send ?? row.send?.names ?? []
    const ref = sourceRef(row.source)
    if (names.length > 0 && ref)
      await data.local().rpc.call("mcp.hosts.send", { hostId: id as never, server: server.id as never, source: ref as never, names: [...names] })
    if (transport.type === "local") await runtime.rpc.call("mcp.host.prefetch", { id: server.id as never }).catch(() => undefined)
    const check = await runtime.rpc.call("mcp.host.test", { id: server.id as never })
    void load(id)
    void refetchSends()
    return check
  }

  async function installOne(id: string, row: Row, choice: Parameters<typeof install>[2]) {
    if (busy[row.source.key]) return
    setBusy(row.source.key, true)
    const done = await install(id, row, choice).then(
      (check) => check,
      (error: unknown) => {
        showToast({ tone: "danger", message: text("own.mcph.toast.failed", { reason: reasonOf(error) }) })
        return null
      },
    )
    setBusy(row.source.key, false)
    if (done === null) return
    showToast({
      tone: done?.ok === false ? "danger" : undefined,
      message: text(done?.ok === false ? "own.mcph.toast.installedFailed" : "own.mcph.toast.installed", {
        name: row.source.name,
        host: hostName(id),
      }),
    })
  }

  async function remove(id: string, server: HostServer) {
    const runtime = runtimeOf(id)
    if (!runtime) return
    const done = await runtime.rpc.call("mcp.host.remove", { id: server.id as never }).then(
      () => true,
      () => false,
    )
    await data
      .local()
      .rpc.call("mcp.hosts.unsend", { hostId: id as never, server: server.id as never })
      .catch(() => undefined)
    setRemoving(undefined)
    void load(id)
    void refetchSends()
    showToast({
      tone: done ? undefined : "danger",
      message: done
        ? text("own.mcph.toast.removed", { name: server.name, host: hostName(id) })
        : text("own.mcph.toast.failed", { reason: server.name }),
    })
  }

  async function send(id: string, row: Row, names: ReadonlyArray<string>) {
    const ref = sourceRef(row.source)
    if (!row.installed || !ref) return
    const done = await data
      .local()
      .rpc.call("mcp.hosts.send", { hostId: id as never, server: row.installed.id as never, source: ref as never, names: [...names] })
      .then(
        () => true,
        () => false,
      )
    void refetchSends()
    void load(id)
    showToast({
      tone: done ? undefined : "danger",
      message: done
        ? text("own.mcph.toast.sent", { name: row.source.name, host: hostName(id) })
        : text("own.mcph.toast.failed", { reason: row.source.name }),
    })
  }

  async function unsend(id: string, row: Row) {
    if (!row.installed) return
    await data
      .local()
      .rpc.call("mcp.hosts.unsend", { hostId: id as never, server: row.installed.id as never })
      .catch(() => undefined)
    void refetchSends()
    void load(id)
    showToast({ message: text("own.mcph.toast.unsent", { name: row.source.name }) })
  }

  async function test(id: string, server: HostServer) {
    const runtime = runtimeOf(id)
    if (!runtime) return
    await runtime.rpc.call("mcp.host.test", { id: server.id as never }).catch(() => undefined)
    void load(id)
  }

  function briefOf(id: string, row: Row) {
    const host = hosts[id]
    return McpHostRules.brief({
      locale: i18n.locale() === "en" ? "en" : "ko",
      host: hostName(id),
      source: row.source,
      analysis: row.analysis,
      ...(host?.status === "ready" && host.probe ? { probe: host.probe } : {}),
      shown: shown(row.source),
      tool: McpHostRules.TOOL,
    })
  }

  function startAssist(id: string, row: Row) {
    const work = job(row.source)
    if (!work) return
    setAssisting(undefined)
    requestStart({
      serverKey: id,
      text: briefOf(id, row),
      metadata: { own: { mcpInstall: work } },
      permissions: [{ action: McpHostRules.TOOL, resource: "*", effect: "allow" }],
    })
    showToast({ message: text("own.mcph.toast.assist", { host: hostName(id) }) })
    router.navigate({ name: "home", serverKey: id })
  }

  const current = () => chosen()
  const currentRows = createMemo(() => {
    const id = current()
    return id ? rowsOf(id) : []
  })
  const currentHost = (): HostData => {
    const id = current()
    return (id && hosts[id]) || { status: "loading" }
  }

  return (
    <Show when={hostIds().length > 0}>
      <section class="flex flex-col gap-2 border-t border-own-border pt-3" data-testid="mcp-hosts">
        <div>
          <b class="block text-[13.5px] font-semibold">{text("own.mcph.title")}</b>
          <span class="text-[12px] text-own-muted">{text("own.mcph.lead")}</span>
        </div>
        <div class="flex flex-wrap gap-1.5" role="group" aria-label={text("own.mcph.host")} data-testid="mcp-hosts-pick">
          <For each={hostIds()}>
            {(id) => (
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                aria-pressed={current() === id}
                data-variant={current() === id ? "primary" : undefined}
                data-testid="mcp-hosts-host"
                data-host={id}
                onClick={() => setSelected(id)}
              >
                <span class="max-w-[14rem] truncate">{hostName(id)}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={current()}>
          {(id) => (
            <HostPanel
              hostId={id()}
              name={hostName(id())}
              host={currentHost()}
              rows={currentRows()}
              orphans={orphans(props.sources, currentHost())}
              local={local()}
              open={open()}
              busy={busy}
              onToggle={() => setOpen((value) => !value)}
              onConnect={() => void remote()?.connect(id())}
              onInstall={(row, choice) => void installOne(id(), row, choice)}
              onAssist={(row) => setAssisting(row)}
              onRemove={(server, row) => setRemoving({ server, ...(row ? { row } : {}) })}
              onSend={(row, names) => void send(id(), row, names)}
              onUnsend={(row) => void unsend(id(), row)}
              onTest={(server) => void test(id(), server)}
              onReview={() => setReviewing(true)}
            />
          )}
        </Show>
        <Show when={reviewing() && current()}>
          {(id) => (
            <Review
              hostId={id()}
              name={hostName(id())}
              rows={currentRows()}
              onClose={() => setReviewing(false)}
              onInstall={async (picks) => {
                // Read once: closing the review unmounts this branch, and its accessor goes stale.
                const host = id()
                const results = await Promise.all(
                  picks.map((pick) => install(host, pick.row, { send: pick.send }).then(
                    (check) => check?.ok !== false,
                    () => false,
                  )),
                )
                setReviewing(false)
                showToast({ message: text("own.mcph.review.done", { n: results.filter(Boolean).length, host: hostName(host) }) })
              }}
            />
          )}
        </Show>
        <Dialog
          open={assisting() !== undefined}
          title={text("own.mcph.assistConfirm.title")}
          onClose={() => setAssisting(undefined)}
          size="wide"
          testid="mcp-hosts-assist"
          footer={
            <>
              <button type="button" class="own-btn" data-size="sm" onClick={() => setAssisting(undefined)}>
                {text("own.mcph.cancel")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-variant="primary"
                data-testid="mcp-hosts-assist-start"
                onClick={() => {
                  const row = assisting()
                  const id = current()
                  if (row && id) startAssist(id, row)
                }}
              >
                {text("own.mcph.assistConfirm.start")}
              </button>
            </>
          }
        >
          <Show when={assisting() && current() ? { row: assisting()!, id: current()! } : undefined}>
            {(pick) => (
              <div class="flex flex-col gap-2">
                <p class="m-0 text-[12.5px]">
                  {text("own.mcph.assistConfirm.lead", { host: hostName(pick().id), name: pick().row.source.name })}
                </p>
                <pre
                  class="own-mono m-0 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-own-border p-2 text-[11.5px] wrap-anywhere"
                  data-testid="mcp-hosts-brief"
                >
                  {briefOf(pick().id, pick().row)}
                </pre>
              </div>
            )}
          </Show>
        </Dialog>
        <Dialog
          open={removing() !== undefined}
          title={text("own.mcph.remove")}
          onClose={() => setRemoving(undefined)}
          testid="mcp-hosts-remove"
          footer={
            <>
              <button type="button" class="own-btn" data-size="sm" onClick={() => setRemoving(undefined)}>
                {text("own.mcph.cancel")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-variant="danger"
                data-testid="mcp-hosts-remove-yes"
                onClick={() => {
                  const pick = removing()
                  const id = current()
                  if (pick && id) void remove(id, pick.server)
                }}
              >
                {text("own.mcph.removeYes")}
              </button>
            </>
          }
        >
          <p class="m-0">
            {text("own.mcph.removeConfirm", { name: removing()?.server.name ?? "", host: hostName(current() ?? "") })}
          </p>
        </Dialog>
      </section>
    </Show>
  )
}

function reasonOf(error: unknown) {
  if (error instanceof OwnRpcError) return error.type
  return error instanceof Error ? error.message : String(error)
}

type Choice = { readonly fills?: Readonly<Record<number, string>>; readonly cwd?: string; readonly send?: ReadonlyArray<string> }

/** One host: its state line, the summary, the bulk install, and the servers' rows on demand. */
function HostPanel(props: {
  readonly hostId: string
  readonly name: string
  readonly host: HostData
  readonly rows: ReadonlyArray<Row>
  readonly orphans: ReadonlyArray<HostServer>
  readonly local: boolean
  readonly open: boolean
  readonly busy: Readonly<Record<string, boolean>>
  readonly onToggle: () => void
  readonly onConnect: () => void
  readonly onInstall: (row: Row, choice: Choice) => void
  readonly onAssist: (row: Row) => void
  readonly onRemove: (server: HostServer, row?: Row) => void
  readonly onSend: (row: Row, names: ReadonlyArray<string>) => void
  readonly onUnsend: (row: Row) => void
  readonly onTest: (server: HostServer) => void
  readonly onReview: () => void
}) {
  const text = useMcpHostsText()
  const counts = () => summary(props.rows)
  const rowOf = (key: string) => props.rows.find((row) => row.source.key === key)!
  const installable = () => props.rows.filter((row) => row.state === "ready" || row.state === "differs").length
  return (
    <div class="flex flex-col gap-2" data-testid="mcp-hosts-panel" data-host={props.hostId} data-status={props.host.status}>
      <div class="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span class="text-own-muted" data-testid="mcp-hosts-status">
          {text(`own.mcph.status.${props.host.status}` as McpHostsKey)}
        </span>
        <Show when={props.host.status === "loading"}>
          <Spinner />
        </Show>
        <Show when={props.host.status === "offline" && props.local}>
          <button type="button" class="own-btn" data-size="sm" data-testid="mcp-hosts-connect" onClick={() => props.onConnect()}>
            {text("own.mcph.connect")}
          </button>
        </Show>
      </div>
      <Show when={props.host.status === "old"}>
        <Notice tone="warn" testid="mcp-hosts-old">
          {text("own.mcph.oldNote")}
        </Notice>
      </Show>
      <Show when={props.host.status === "offline"}>
        <p class="m-0 text-[12px] text-own-muted">{text("own.mcph.offlineNote")}</p>
      </Show>
      <Show when={props.host.status === "error"}>
        <Notice tone="warn">{text("own.mcph.errorNote")}</Notice>
      </Show>
      <Show when={!props.local && props.host.status === "ready" ? props.host.view.servers : undefined}>
        {(servers) => (
          <>
            <p class="m-0 text-[12px] text-own-muted">{text("own.mcph.local")}</p>
            <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
              <For each={servers()}>
                {(server) => (
                  <li class="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="mcp-hosts-installed" data-name={server.name}>
                    <span class="own-mono min-w-0 flex-1 truncate text-[13px]">{server.name}</span>
                    <Tag tone="ok">{text("own.mcph.state.installed")}</Tag>
                    <Show when={server.values === "missing"}>
                      <Tag tone="warn">{text("own.mcph.offUntilSent")}</Tag>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
      <Show
        when={props.local && props.rows.length > 0}
        fallback={
          <Show when={props.local}>
            <p class="m-0 text-[12px] text-own-muted">{text("own.mcph.summaryNone")}</p>
          </Show>
        }
      >
        <div class="flex flex-wrap items-center gap-1.5" data-testid="mcp-hosts-summary">
          <For each={counts()}>
            {(item) => (
              <Tag tone={TONE[item.state]} testid="mcp-hosts-count">
                <span data-state={item.state}>
                  {text(`own.mcph.state.${item.state}` as McpHostsKey)} {item.count}
                </span>
              </Tag>
            )}
          </For>
          <Show when={props.orphans.length > 0}>
            <Tag tone="warn">
              {text("own.mcph.orphan")} {props.orphans.length}
            </Tag>
          </Show>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.local && props.host.status === "ready" && installable() > 0}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="primary"
              aria-haspopup="dialog"
              data-testid="mcp-hosts-install-all"
              onClick={() => props.onReview()}
            >
              {text("own.mcph.installAll", { host: props.name })}
            </button>
          </Show>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            aria-expanded={props.open}
            data-testid="mcp-hosts-toggle"
            onClick={() => props.onToggle()}
          >
            {text(props.open ? "own.mcph.detailsHide" : "own.mcph.details")}
          </button>
        </div>
      </Show>
      <Show when={props.open}>
        <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
          {/* By key: a row object is new after every read of the host, and its details, typed host values and picks
          must stay open across them. */}
          <For each={props.rows.map((row) => row.source.key)}>
            {(key) => (
              <HostRow
                hostId={props.hostId}
                name={props.name}
                row={props.rows.find((row) => row.source.key === key)!}
                host={props.host}
                local={props.local}
                busy={props.busy[key] === true}
                onInstall={(choice) => props.onInstall(rowOf(key), choice)}
                onAssist={() => props.onAssist(rowOf(key))}
                onRemove={(server) => props.onRemove(server, rowOf(key))}
                onSend={(names) => props.onSend(rowOf(key), names)}
                onUnsend={() => props.onUnsend(rowOf(key))}
                onTest={(server) => props.onTest(server)}
              />
            )}
          </For>
          <For each={props.orphans}>
            {(server) => (
              <li class="flex flex-wrap items-center gap-2 px-3 py-2.5" data-testid="mcp-hosts-orphan" data-name={server.name}>
                <span class="own-mono min-w-0 flex-1 truncate text-[13px]">{server.name}</span>
                <Tag tone="warn">{text("own.mcph.orphan")}</Tag>
                <Show when={props.local}>
                  <button type="button" class="own-btn" data-size="sm" aria-haspopup="dialog" onClick={() => props.onRemove(server)}>
                    {text("own.mcph.remove")}
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/** One server on one host: its state, the next step, and on demand why and how. */
function HostRow(props: {
  readonly hostId: string
  readonly name: string
  readonly row: Row
  readonly host: HostData
  readonly local: boolean
  readonly busy: boolean
  readonly onInstall: (choice: Choice) => void
  readonly onAssist: () => void
  readonly onRemove: (server: HostServer) => void
  readonly onSend: (names: ReadonlyArray<string>) => void
  readonly onUnsend: () => void
  readonly onTest: (server: HostServer) => void
}) {
  const text = useMcpHostsText()
  const [expanded, setExpanded] = createSignal(false)
  const [fills, setFills] = createStore<Record<number, string>>({})
  const [cwd, setCwd] = createSignal("")
  const [picked, setPicked] = createStore<Record<string, boolean>>({})
  const row = () => props.row
  const inputs = () => hostInputs(row().analysis)
  const canDirect = () => direct(row(), { ...fills }, cwd())
  const assistable = () =>
    row().source.transport.type === "local" &&
    (row().state === "prepare" || row().state === "assist" || row().state === "unknown")
  const action = () => {
    const state = row().state
    if (state === "ready") return "install" as const
    if (state === "differs") return "update" as const
    return undefined
  }
  const pkg = () => row().analysis.package
  const check = () => row().installed?.check
  const choice = (): Choice => ({
    ...(inputs().args.length ? { fills: { ...fills } } : {}),
    ...(cwd().trim() ? { cwd: cwd().trim() } : {}),
    ...(row().installed ? {} : { send: Object.keys(picked).filter((name) => picked[name]) }),
  })
  return (
    <li
      class="flex flex-col gap-1 px-3 py-2.5"
      data-testid="mcp-hosts-row"
      data-name={row().source.name}
      data-state={row().state}
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="own-mono min-w-0 flex-1 truncate text-[13px]" title={row().source.name}>
          {row().source.name}
        </span>
        <Show when={row().source.origin === "file"}>
          <Tag tone="plain">{text("own.mcph.fromFile")}</Tag>
        </Show>
        <Tag tone={TONE[row().state]} testid="mcp-hosts-state">
          {text(`own.mcph.state.${row().state}` as McpHostsKey)}
        </Tag>
        <Show when={props.local && action()}>
          {(kind) => (
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant={kind() === "install" ? "primary" : undefined}
              disabled={props.busy}
              data-testid={kind() === "install" ? "mcp-hosts-install" : "mcp-hosts-update"}
              onClick={() => props.onInstall(choice())}
            >
              <Show when={props.busy}>
                <Spinner />{" "}
              </Show>
              {text(props.busy ? "own.mcph.working" : kind() === "install" ? "own.mcph.install" : "own.mcph.update")}
            </button>
          )}
        </Show>
        <Show when={props.local && assistable()}>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            aria-haspopup="dialog"
            data-testid="mcp-hosts-assist-open"
            onClick={() => props.onAssist()}
          >
            {text("own.mcph.assist")}
          </button>
        </Show>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          aria-expanded={expanded()}
          data-testid="mcp-hosts-more"
          onClick={() => setExpanded((value) => !value)}
        >
          {text(expanded() ? "own.mcph.less" : "own.mcph.more")}
        </button>
      </div>
      <Show when={row().installed?.values === "missing"}>
        <span class="text-[12px] text-own-warn" data-testid="mcp-hosts-off">
          {text("own.mcph.offUntilSent")}
        </span>
      </Show>
      <Show when={row().changed}>
        {(changed) => (
          <span class="text-[12px] text-own-muted" data-testid="mcp-hosts-changed">
            {[
              changed().definition ? text("own.mcph.changedDefinition") : "",
              changed().values ? text("own.mcph.changedValues") : "",
            ]
              .filter(Boolean)
              .join(" ")}
          </span>
        )}
      </Show>
      <Show when={expanded()}>
        <div class="flex flex-col gap-1.5 text-[12px] text-own-muted" data-testid="mcp-hosts-details">
          <span>
            {text(row().analysis.kind === "local" ? "own.mcph.kind.local" : "own.mcph.kind.remote")}
            <Show when={row().analysis.kind === "local"}> · {text("own.mcph.runtime", { runtime: row().analysis.runtime })}</Show>
            <Show when={pkg()}>
              {(item) => (
                <>
                  {" · "}
                  {text(item().version ? "own.mcph.packageVersion" : "own.mcph.package", {
                    registry: item().registry,
                    name: item().name,
                    version: item().version ?? "",
                  })}
                </>
              )}
            </Show>
            <Show when={row().source.disabled}> · {text("own.mcph.disabledHere")}</Show>
          </span>
          <code class="own-mono break-all text-[11.5px] text-own-text">{shown(row().source)}</code>
          <ul class="m-0 flex list-disc flex-col gap-0.5 pl-4" data-testid="mcp-hosts-reasons">
            <For each={row().analysis.reasons}>{(reason) => <li>{reasonLine(text, reason)}</li>}</For>
          </ul>
          <Show when={props.local && !row().installed && (inputs().args.length > 0 || inputs().cwd !== undefined)}>
            <div class="flex flex-col gap-1.5">
              <For each={inputs().args}>
                {(item) => (
                  <label class="flex flex-col gap-0.5">
                    <span>{text("own.mcph.hostValue", { n: item.index + 1 })}</span>
                    <input
                      class="own-input own-mono text-[12px]"
                      placeholder={text("own.mcph.hostValueHint", { text: item.text })}
                      data-testid="mcp-hosts-fill"
                      onInput={(event) => setFills(item.index, event.currentTarget.value)}
                    />
                  </label>
                )}
              </For>
              <Show when={inputs().cwd}>
                {(from) => (
                  <label class="flex flex-col gap-0.5">
                    <span>{text("own.mcph.hostCwd")}</span>
                    <input
                      class="own-input own-mono text-[12px]"
                      placeholder={text("own.mcph.hostValueHint", { text: from() })}
                      onInput={(event) => setCwd(event.currentTarget.value)}
                    />
                  </label>
                )}
              </Show>
              <Show when={row().state === "assist" && canDirect()}>
                <button
                  type="button"
                  class="own-btn self-start"
                  data-size="sm"
                  data-variant="primary"
                  disabled={props.busy}
                  data-testid="mcp-hosts-install-filled"
                  onClick={() => props.onInstall(choice())}
                >
                  {text("own.mcph.install")}
                </button>
              </Show>
            </div>
          </Show>
          <Values
            host={props.name}
            row={row()}
            local={props.local}
            picked={picked}
            onPick={(name, value) => setPicked(name, value)}
            onSend={props.onSend}
            onUnsend={props.onUnsend}
          />
          <Show when={check()}>
            {(result) => (
              <span data-testid="mcp-hosts-check" data-ok={result().ok ? "" : undefined}>
                {result().ok
                  ? text("own.mcph.check.ok", { n: result().tools.length })
                  : text("own.mcph.check.failed", { reason: result().error ?? result().failure ?? "" })}
              </span>
            )}
          </Show>
          <Show when={props.local && row().installed}>
            {(server) => (
              <div class="flex flex-wrap gap-2 pt-0.5">
                <button type="button" class="own-btn" data-size="sm" data-testid="mcp-hosts-test" onClick={() => props.onTest(server())}>
                  {text("own.mcph.test")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  aria-haspopup="dialog"
                  data-testid="mcp-hosts-remove-open"
                  onClick={() => props.onRemove(server())}
                >
                  {text("own.mcph.remove")}
                </button>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </li>
  )
}

/**
 * The values step: each value with its name and whether it looks secret, never its value. Before an install the user
 * checks what goes (nothing is checked first); after it, `이 키를 <host>에 보내기` sends the values, and what was sent can
 * be withdrawn.
 */
function Values(props: {
  readonly host: string
  readonly row: Row
  readonly local: boolean
  readonly picked: Readonly<Record<string, boolean>>
  readonly onPick: (name: string, value: boolean) => void
  readonly onSend: (names: ReadonlyArray<string>) => void
  readonly onUnsend: () => void
}) {
  const text = useMcpHostsText()
  const list = () => props.row.analysis.values
  const sent = () => props.row.send
  return (
    <div class="flex flex-col gap-1" data-testid="mcp-hosts-values">
      <span class="font-medium text-own-text">{text("own.mcph.values")}</span>
      <Show when={list().length > 0} fallback={<span>{text("own.mcph.valuesNone")}</span>}>
        <For each={list()}>
          {(value) => (
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!props.local || props.row.installed !== undefined}
                checked={props.row.installed ? (sent()?.names.includes(value.name) ?? false) : props.picked[value.name] === true}
                data-testid="mcp-hosts-value"
                data-name={value.name}
                onChange={(event) => props.onPick(value.name, event.currentTarget.checked)}
              />
              <span class="own-mono">{value.name}</span>
              <Show when={value.secret}>
                <Tag tone="plain">{text("own.mcph.secret")}</Tag>
              </Show>
              <Show when={sent()?.names.includes(value.name)}>
                <Tag tone="ok">{text("own.mcph.sent")}</Tag>
              </Show>
            </label>
          )}
        </For>
        <span class="text-own-faint">{text("own.mcph.sendNote", { host: props.host })}</span>
        <Show when={props.local && props.row.installed}>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="mcp-hosts-send"
              onClick={() => props.onSend(list().map((value) => value.name))}
            >
              {text("own.mcph.send", { host: props.host })}
            </button>
            <Show when={sent()}>
              <button type="button" class="own-btn" data-size="sm" data-testid="mcp-hosts-unsend" onClick={() => props.onUnsend()}>
                {text("own.mcph.unsend")}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={sent()?.differs}>
          <span class="text-own-warn">{text("own.mcph.sentDiffers")}</span>
        </Show>
      </Show>
    </div>
  )
}

/** The bulk install's review: what goes, how, and which values (none checked first); then one confirm. */
function Review(props: {
  readonly hostId: string
  readonly name: string
  readonly rows: ReadonlyArray<Row>
  readonly onClose: () => void
  readonly onInstall: (picks: ReadonlyArray<{ readonly row: Row; readonly send: ReadonlyArray<string> }>) => Promise<void>
}) {
  const text = useMcpHostsText()
  const candidates = () => props.rows.filter((row) => row.state === "ready" || row.state === "differs")
  const [skip, setSkip] = createStore<Record<string, boolean>>({})
  const [values, setValues] = createStore<Record<string, Record<string, boolean>>>({})
  const [working, setWorking] = createSignal(false)
  const picks = () =>
    candidates()
      .filter((row) => !skip[row.source.key])
      .map((row) => ({
        row,
        send: row.installed ? (row.send?.names ?? []) : Object.keys(values[row.source.key] ?? {}).filter((name) => values[row.source.key]?.[name]),
      }))
  const others = () => props.rows.filter((row) => row.state === "prepare" || row.state === "assist").length
  return (
    <Dialog
      open
      size="wide"
      title={text("own.mcph.review.title", { host: props.name })}
      onClose={() => props.onClose()}
      testid="mcp-hosts-review"
      footer={
        <>
          <button type="button" class="own-btn" data-size="sm" onClick={() => props.onClose()}>
            {text("own.mcph.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            disabled={working() || picks().length === 0}
            data-testid="mcp-hosts-review-confirm"
            onClick={() => {
              setWorking(true)
              void props.onInstall(picks()).finally(() => setWorking(false))
            }}
          >
            <Show when={working()}>
              <Spinner />{" "}
            </Show>
            {text("own.mcph.review.confirm", { n: picks().length })}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-2 text-[12.5px]">
        <p class="m-0">{text("own.mcph.review.lead", { host: props.name })}</p>
        <Show when={candidates().length > 0} fallback={<p class="m-0 text-own-muted">{text("own.mcph.review.none")}</p>}>
          <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
            <For each={candidates()}>
              {(row) => (
                <li class="flex flex-col gap-1 px-3 py-2" data-testid="mcp-hosts-review-row" data-name={row.source.name}>
                  <label class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!skip[row.source.key]}
                      data-testid="mcp-hosts-review-pick"
                      onChange={(event) => setSkip(row.source.key, !event.currentTarget.checked)}
                    />
                    <span class="own-mono min-w-0 flex-1 truncate">{row.source.name}</span>
                    <Tag tone="plain">{text(row.installed ? "own.mcph.review.update" : "own.mcph.review.direct")}</Tag>
                  </label>
                  <code class="own-mono break-all text-[11.5px] text-own-muted">{shown(row.source)}</code>
                  <Show when={!row.installed && row.analysis.values.length > 0}>
                    <div class="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
                      <For each={row.analysis.values}>
                        {(value) => (
                          <label class="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={values[row.source.key]?.[value.name] === true}
                              data-testid="mcp-hosts-review-value"
                              data-name={value.name}
                              onChange={(event) =>
                                setValues(row.source.key, (current) => ({ ...current, [value.name]: event.currentTarget.checked }))
                              }
                            />
                            <span>{text("own.mcph.send", { host: props.name })}</span>
                            <span class="own-mono">{value.name}</span>
                          </label>
                        )}
                      </For>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <span class="text-[12px] text-own-faint">{text("own.mcph.sendNote", { host: props.name })}</span>
        </Show>
        <Show when={others() > 0}>
          <p class="m-0 text-[12px] text-own-muted">{text("own.mcph.review.later")}</p>
        </Show>
      </div>
    </Dialog>
  )
}

function reasonLine(text: ReturnType<typeof useMcpHostsText>, reason: McpHostRules.Reason) {
  switch (reason.code) {
    case "binary":
      return text(reason.found ? "own.mcph.reason.binary" : "own.mcph.reason.binaryMissing", { command: reason.command })
    case "host_value":
    case "mapped":
      return text(`own.mcph.reason.${reason.code}`, { args: reason.args.map((index) => index + 1).join(", ") })
    case "values":
      return text("own.mcph.reason.values", { n: reason.names.length, names: reason.names.join(", ") })
    case "windows_program":
    case "windows_shell":
    case "unknown_command":
      return text(`own.mcph.reason.${reason.code}`, { command: reason.command })
    case "windows_resource":
      return text("own.mcph.reason.windows_resource", { name: reason.name })
    case "script":
      return text("own.mcph.reason.script", { path: reason.path })
    case "python_module":
      return text("own.mcph.reason.python_module", { module: reason.module })
    case "runtime_missing":
    case "container_denied":
      return text(`own.mcph.reason.${reason.code}`, { runtime: reason.runtime })
    case "unwrapped":
      return text("own.mcph.reason.unwrapped", { shell: reason.shell })
    default:
      return text(`own.mcph.reason.${reason.code}`)
  }
}
