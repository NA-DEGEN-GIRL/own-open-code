// 설정 > MCP 서버 (03 §5.7, §18.14; SM 2026-10-24). Lazy page chunk. MCP servers run per Location, so the page works on
// one project at a time: the project on screen when settings opened (`directory` from the integrator), else the most
// recent one. The list is the one the Ctrl+; dialog shows (`McpServerList`: status, the switch, `로그인…`, the error
// folded), with what only this page adds under each row: where the server comes from (own's own list or a config
// file), its definition (names of values only), the tools of its last connection test, and on this PC `연결 시험`,
// `고치기…` and `지우기…`. `＋ 서버 추가…` (./editor), `다른 도구에서 가져오기…` (./import) and `찾아서 설치…`
// (./registry, the MCP Registry) are own.accounts `mcp.*` methods, `local` like skills import: a phone or another PC
// sees the list, with where own's servers come from by name only (`mcp.summary`, read). Core's error text of own's
// servers is shown as own.accounts gives it, with their stored values cut out (`mcp.list` `errors`, SM-22).
//
// Global first (SG 2026-10-26): `모든 프로젝트` lists own's servers used everywhere with the global switch
// (`mcp.enable{name, enabled}`), the projects that differ (a click picks one), `모든 프로젝트에서 꺼 둠`, `고치기…` and
// `지우기…`, with no project needed. `프로젝트별 설정` is the project's live list, its rows tagged with what decides them
// there (`되돌리기` deletes a project's own switch), and the servers only other projects use.
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { errorType } from "@/accounts/errors"
import { useData } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Spinner, Tag } from "@/limits/kit"
import { createProjectChoice, ProjectPicker } from "@/projects/choice"
import { baseName, samePath } from "@/projects/path"
import { takeSettingsIntent } from "@/settings/intent"
import { showToast } from "@/switcher/toast"
import { McpServerList, type McpSwitches } from "./list"
import { useMcpListText } from "./list-strings"
import {
  codeModes,
  defined,
  elsewhere,
  emptyForm,
  fileServers,
  fileTransport,
  formOf,
  globalRows,
  globalSwitch,
  reaches,
  secretsOf,
  sourceOf,
  summaryOf,
  type Check,
  type FileServer,
  type Form,
  type Server,
  type Source,
  type Summary,
} from "./manage-model"
import { CheckLine, errorText } from "./manage-parts"
import { useMcpManageText } from "./manage-strings"
import type { McpRow } from "./model"
import { createMcpServers, keeps } from "./store"
import { hostLines, setMcpHostTarget } from "./hosts-line"
import { fileSources, ownSource } from "./hosts-model"
import { useMcpHostsText, type McpHostsKey } from "./hosts-strings"
import { remoteStore } from "@/servers"

const McpEditor = lazy(() => import("./editor"))
const McpImport = lazy(() => import("./import"))
const McpRegistry = lazy(() => import("./registry"))
const McpHosts = lazy(() => import("./hosts"))

export interface McpSettingsProps {
  /** The project to start on (the session or project on screen). */
  readonly directory?: string
}

export default function McpSettings(props: McpSettingsProps) {
  const data = useData()
  const host = useHost()
  const listText = useMcpListText()
  const text = useMcpManageText()
  const runtime = () => data.local()
  const choice = createProjectChoice({ runtime, directory: () => props.directory })
  const directory = choice.directory
  const local = () => runtime().rpc.allowed("mcp.save")
  // The list's rows; own's servers among them show own.accounts' error text (`errors`), with values cut out.
  const mcp = createMcpServers({
    runtime,
    directory,
    host,
    codemode: () => codeModes(own(), directory()),
    own: () => {
      // `error` first: a resource's `latest` throws its error.
      const known = local() ? view.error || view.latest !== undefined : summary.error || summary.latest !== undefined
      if (!known) return { names: "all" }
      return {
        names: own().flatMap((server) => (reaches(server.scope, directory()) ? [server.name] : [])),
        ...(local() && !view.error ? { errors: view.latest?.errors } : {}),
      }
    },
  })
  // Read again when a server fails anew too, for its masked text.
  const [view, { refetch }] = createResource(
    () => (local() ? { directory: directory(), failures: mcp.failures() } : undefined),
    (source) => runtime().rpc.call("mcp.list", source.directory ? { directory: source.directory } : {}),
  )
  // A phone or another PC reads names, scopes and sources only, for the rows' source line.
  const [summary, { refetch: refetchSummary }] = createResource(
    () => (!local() && runtime().rpc.allowed("mcp.summary") ? true : undefined),
    () => runtime().rpc.call("mcp.summary", {}),
  )
  onCleanup(
    runtime().own.on("mcp.changed", () => {
      if (local()) void refetch()
      else void refetchSummary()
    }),
  )
  /** This PC's servers (`mcp.list`, with definitions); every own server's summary elsewhere. */
  const mine = () => (view.error ? [] : (view.latest?.servers ?? []))
  const own = (): ReadonlyArray<Server | Summary> =>
    local() ? mine() : summary.error ? [] : (summary.latest?.servers ?? [])
  /** The kept switches (SG): this PC's list, or the summary elsewhere; `undefined` until read. */
  const overrides = () => {
    if (local()) return view.error ? undefined : view.latest?.overrides
    return summary.error ? undefined : summary.latest?.overrides
  }
  const switchable = () => keeps(runtime())
  const switches: McpSwitches = {
    overrides,
    projectOnly: (name) => {
      const where = directory()
      return own().some(
        (server) =>
          server.name === name &&
          server.scope.type === "project" &&
          where !== undefined &&
          samePath(server.scope.directory, where),
      )
    },
    canReset: switchable,
  }
  const everywhere = createMemo(() => globalRows(own(), overrides() ?? []))
  const [sending, setSending] = createSignal(false)

  /** The global switch of one of own's servers; its toast offers `되돌리기` (the switch as it was). */
  async function setGlobal(name: string, enabled: boolean, undo?: boolean | null) {
    if (sending()) return
    const before = globalSwitch(overrides() ?? [], name)
    setSending(true)
    const done = await runtime()
      .rpc.call("mcp.enable", { name, enabled: undo === undefined ? enabled : undo })
      .then(
        () => true,
        (error: unknown) => {
          console.error("[own-web] mcp.enable", errorType(error) ?? error)
          return false
        },
      )
    setSending(false)
    if (!done) return showToast({ tone: "danger", message: text("own.mcpm.toast.failed") })
    void refetch()
    void refetchSummary()
    mcp.refresh()
    if (undo !== undefined) return showToast({ message: text("own.mcpm.toast.reverted") })
    showToast({
      message: text(enabled ? "own.mcpm.toast.onAll" : "own.mcpm.toast.offAll", { name }),
      action: { label: text("own.mcpm.toast.undo"), run: () => void setGlobal(name, enabled, before) },
    })
  }
  const entries = () => {
    const where = directory()
    return where ? (runtime().data.location.config.list({ directory: where }) ?? []) : []
  }
  const files = createMemo(() => fileServers(entries()))
  const [editing, setEditing] = createSignal<Form>()
  const [importing, setImporting] = createSignal(false)
  const [finding, setFinding] = createSignal(false)
  const [removing, setRemoving] = createSignal<Server>()
  const [busy, setBusy] = createSignal(false)
  /** Tests run from this page: own's are kept in the list too (`check`), a config file's only here. */
  const [checks, setChecks] = createStore<Record<string, Check | "testing" | undefined>>({})

  createEffect(() => {
    if (!local()) return
    const intent = takeSettingsIntent(["mcp.add", "mcp.import", "mcp.hosts"])
    if (intent === "mcp.add") setEditing(emptyForm())
    if (intent === "mcp.import") setImporting(true)
    if (intent === "mcp.hosts") {
      const store = remoteStore()
      const ready = store?.state.order.find((id) => store.host(id)?.stage === "ready")
      setMcpHostTarget(ready ?? store?.state.order[0])
    }
  })
  // 04 §13 "MCP" (MH): every server this PC knows, for `SSH 호스트에서 쓰기` (own's with definitions on this PC only).
  const hostSources = createMemo(() => (local() ? [...mine().map(ownSource), ...fileSources(entries(), mine())] : []))
  const hasHosts = () => (remoteStore()?.state.order.length ?? 0) > 0

  async function test(name: string, source: Source) {
    const where = directory()
    if (source.type === "other" || checks[name] === "testing") return
    const server = source.type === "own" && defined(source.server) ? source.server : undefined
    const transport = source.type === "file" ? fileTransport(entries(), name) : undefined
    if (server === undefined && transport === undefined) return
    setChecks(name, "testing")
    const result = await runtime()
      .rpc.call("mcp.test", {
        ...(server ? { id: server.id } : { transport: transport! }),
        ...(where ? { directory: where } : {}),
      })
      .catch((error: unknown) => {
        console.error("[own-web] mcp.test", errorType(error) ?? error)
        return undefined
      })
    setChecks(name, result)
    if (result === undefined) showToast({ tone: "danger", message: text("own.mcpm.check.failed") })
  }

  async function remove(server: Server) {
    setBusy(true)
    const done = await runtime()
      .rpc.call("mcp.remove", { id: server.id })
      .then(
        () => true,
        (error: unknown) => {
          showToast({ tone: "danger", message: errorText(text, error, server.name) })
          return false
        },
      )
    setBusy(false)
    setRemoving(undefined)
    if (!done) return
    showToast({ message: text("own.mcpm.removed", { name: server.name }) })
    void refetch()
    mcp.refresh()
  }

  const details = (row: McpRow) => {
    const source = () => sourceOf(row.name, own(), files(), directory())
    const check = () => {
      const here = checks[row.name]
      if (here !== undefined) return here
      const found = source()
      return found.type === "own" && defined(found.server) ? found.server.check : undefined
    }
    return (
      <RowDetails
        source={source()}
        check={check()}
        local={local()}
        onTest={() => void test(row.name, source())}
        onEdit={(server) => setEditing(formOf(server))}
        onRemove={(server) => setRemoving(server)}
      />
    )
  }

  return (
    <div class="flex flex-col gap-4" data-testid="settings-mcp">
      <p class="m-0 text-[13px] leading-5 text-own-muted">{text("own.mcpm.lead")}</p>
      <Show when={!switchable()}>
        <p class="m-0 text-[12.5px] text-own-muted" data-testid="mcp-keeps">
          {text("own.mcpm.runtimeOnly")}
        </p>
      </Show>
      <Show when={local()} fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.mcpm.localOnly")}</p>}>
        <div class="flex flex-wrap gap-2" data-testid="mcp-actions">
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            aria-haspopup="dialog"
            data-testid="mcp-add"
            onClick={() => setEditing(emptyForm())}
          >
            {text("own.mcpm.add")}
          </button>
          <button
            type="button"
            class="own-btn"
            aria-haspopup="dialog"
            data-testid="mcp-import-open"
            onClick={() => setImporting(true)}
          >
            {text("own.mcpm.import")}
          </button>
          <button
            type="button"
            class="own-btn"
            aria-haspopup="dialog"
            data-testid="mcp-registry-find"
            onClick={() => setFinding(true)}
          >
            {text("own.mcpm.registry")}
          </button>
        </div>
        <Show when={view.error}>
          <Notice tone="danger" testid="mcp-own-failed">
            {text("own.mcpm.loadFailed")}
          </Notice>
        </Show>
        <Show when={view.latest?.vault === "unavailable"}>
          <Notice tone="warn" testid="mcp-vault-unavailable">
            {text("own.mcpm.vaultUnavailable")}
          </Notice>
        </Show>
      </Show>
      <Show when={hasHosts()}>
        <Suspense>
          <McpHosts sources={hostSources()} entries={entries()} {...(directory() ? { project: directory()! } : {})} />
        </Suspense>
      </Show>
      <section class="flex flex-col gap-2" data-testid="mcp-global">
        <div>
          <b class="block text-[13.5px] font-semibold">{text("own.mcpm.all")}</b>
          <span class="text-[12px] text-own-muted">{text("own.mcpm.allNote")}</span>
        </div>
        <Show
          when={everywhere().length > 0}
          fallback={
            <p class="m-0 text-[12.5px] text-own-muted" data-testid="mcp-global-empty">
              {text("own.mcpm.allEmpty")}
            </p>
          }
        >
          <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
            <For each={everywhere()}>
              {(item) => (
                <li
                  class="flex flex-col gap-1 px-3 py-2.5"
                  data-testid="mcp-global-row"
                  data-name={item.server.name}
                  data-off={item.off ? "" : undefined}
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="own-mono min-w-0 flex-1 truncate text-[13px]" title={item.server.name}>
                      {item.server.name}
                    </span>
                    <Show when={item.server.from}>
                      {(from) => <Tag tone="plain">{text(`own.mcpm.from.${from()}`)}</Tag>}
                    </Show>
                    <Show when={item.off}>
                      <Tag tone="warn" testid="mcp-global-off">
                        {text("own.mcpm.offAll")}
                      </Tag>
                    </Show>
                    <Show when={switchable()}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!item.off}
                        aria-label={text("own.mcpm.switchAll", { name: item.server.name })}
                        aria-disabled={sending()}
                        class="group own-target relative inline-flex h-5 w-9 flex-none items-center rounded-full border border-own-border-input bg-own-subtle transition-colors aria-checked:border-own-accent aria-checked:bg-own-accent aria-disabled:opacity-50"
                        data-testid="mcp-global-toggle"
                        onClick={() => {
                          if (!sending()) void setGlobal(item.server.name, item.off)
                        }}
                      >
                        <span
                          aria-hidden="true"
                          class="inline-block h-3.5 w-3.5 translate-x-0.5 rounded-full bg-own-muted transition-transform group-aria-checked:translate-x-[18px] group-aria-checked:bg-own-on-accent"
                        />
                      </button>
                    </Show>
                  </div>
                  <Show when={item.exceptions.off.length > 0}>
                    <ProjectsLine
                      directories={item.exceptions.off}
                      text={(projects) => text("own.mcpm.offIn", { projects })}
                      more={(n) => text("own.mcpm.more", { n })}
                      kind="off"
                      onPick={(where) => choice.choose(where)}
                    />
                  </Show>
                  <Show when={item.exceptions.only.length > 0}>
                    <ProjectsLine
                      directories={item.exceptions.only}
                      text={(projects) => text("own.mcpm.onlyIn", { projects })}
                      more={(n) => text("own.mcpm.more", { n })}
                      kind="only"
                      onPick={(where) => choice.choose(where)}
                    />
                  </Show>
                  <Show when={local() && defined(item.server) ? item.server : undefined}>
                    {(server) => (
                      <div class="flex flex-wrap items-center gap-2 pt-0.5">
                        <button
                          type="button"
                          class="own-btn"
                          data-size="sm"
                          aria-haspopup="dialog"
                          data-testid="mcp-edit"
                          onClick={() => setEditing(formOf(server()))}
                        >
                          {text("own.mcpm.edit")}
                        </button>
                        <button
                          type="button"
                          class="own-btn"
                          data-size="sm"
                          aria-haspopup="dialog"
                          data-testid="mcp-remove"
                          onClick={() => setRemoving(server())}
                        >
                          {text("own.mcpm.remove")}
                        </button>
                      </div>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <section class="flex flex-col gap-2 border-t border-own-border pt-3" data-testid="mcp-per-project">
        <div>
          <b class="block text-[13.5px] font-semibold">{text("own.mcpm.perProject")}</b>
          <span class="text-[12px] text-own-muted" data-testid="mcp-project-note">
            {text("own.mcpm.projectNote")}
          </span>
        </div>
        <ProjectPicker choice={choice} label={listText("own.mcp.project")} testid="mcp-project" />
        <McpServerList
          mcp={mcp}
          details={details}
          switches={switches}
          empty={
            <div class="flex flex-col gap-1" data-testid="mcp-empty">
              <p class="m-0 text-[12.5px] text-own-muted">{listText("own.mcp.empty")}</p>
              <Show when={local()}>
                <p class="m-0 text-[12px] text-own-faint">{text("own.mcpm.emptyHint")}</p>
              </Show>
            </div>
          }
        />
        <Show when={local() && elsewhere(mine(), directory()).length > 0}>
          <section class="flex flex-col gap-2 pt-1" data-testid="mcp-elsewhere">
            <div>
              <b class="block text-[13.5px] font-semibold">{text("own.mcpm.elsewhere")}</b>
              <span class="text-[12px] text-own-muted">{text("own.mcpm.elsewhereNote")}</span>
            </div>
            <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
              <For each={elsewhere(mine(), directory())}>
                {(server) => (
                  <li class="flex flex-col gap-1 px-3 py-2.5" data-testid="mcp-elsewhere-row" data-name={server.name}>
                    <span class="own-mono truncate text-[13px]">{server.name}</span>
                    <RowDetails
                      source={{ type: "own", server }}
                      check={checks[server.name] ?? server.check}
                      local
                      onTest={() => void test(server.name, { type: "own", server })}
                      onEdit={(item) => setEditing(formOf(item))}
                      onRemove={(item) => setRemoving(item)}
                    />
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </section>
      <Show when={editing()}>
        {(form) => (
          <Suspense>
            <McpEditor
              runtime={runtime()}
              form={form()}
              directory={directory()}
              files={files()}
              own={mine()}
              onClose={() => setEditing(undefined)}
              onSaved={(name) => {
                setEditing(undefined)
                setChecks(name, undefined)
                showToast({ message: text("own.mcpm.editor.saved", { name }) })
                void refetch()
                mcp.refresh()
              }}
            />
          </Suspense>
        )}
      </Show>
      <Show when={importing()}>
        <Suspense>
          <McpImport
            runtime={runtime()}
            directory={directory()}
            files={files()}
            onClose={() => setImporting(false)}
            onDone={(count) => {
              setImporting(false)
              showToast({ message: text("own.mcpm.import.done", { n: count }) })
              void refetch()
              mcp.refresh()
            }}
          />
        </Suspense>
      </Show>
      <Show when={finding()}>
        <Suspense>
          <McpRegistry
            runtime={runtime()}
            onClose={() => setFinding(false)}
            onPick={(form) => {
              setFinding(false)
              setEditing(form)
            }}
          />
        </Suspense>
      </Show>
      <Dialog
        open={removing() !== undefined}
        title={text("own.mcpm.remove").replace("…", "")}
        onClose={() => setRemoving(undefined)}
        testid="mcp-remove-dialog"
        footer={
          <>
            <button type="button" class="own-btn" data-size="sm" onClick={() => setRemoving(undefined)}>
              {text("own.mcpm.cancel")}
            </button>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="danger"
              disabled={busy()}
              data-testid="mcp-remove-confirm"
              onClick={() => {
                const server = removing()
                if (server) void remove(server)
              }}
            >
              {text("own.mcpm.removeYes")}
            </button>
          </>
        }
      >
        <p class="m-0">{text("own.mcpm.removeConfirm", { name: removing()?.name ?? "" })}</p>
      </Dialog>
    </div>
  )
}

/** `SSH 호스트: build-host 설치됨 · lab 설치 가능` (MH): each host name opens the host section on that host. */
function HostLine(props: { readonly source: Source }) {
  const text = useMcpHostsText()
  const key = () => {
    const source = props.source
    if (source.type === "own") return defined(source.server) ? `own:${source.server.id}` : undefined
    if (source.type === "file") return `file:${source.server.name}`
    return undefined
  }
  const items = () => {
    const found = key()
    return found ? (hostLines().get(found) ?? []) : []
  }
  return (
    <Show when={items().length > 0}>
      <span class="flex flex-wrap items-center gap-1" data-testid="mcp-host-line">
        <span>{text("own.mcph.rowLine")}:</span>
        <For each={items()}>
          {(item, index) => (
            <>
              {index() > 0 ? " · " : ""}
              <button
                type="button"
                class="own-sk-link"
                data-host={item.hostId}
                data-state={item.state}
                onClick={() => setMcpHostTarget(item.hostId)}
              >
                {item.host} {text(`own.mcph.state.${item.state}` as McpHostsKey)}
              </button>
            </>
          )}
        </For>
      </span>
    </Show>
  )
}

/** `{projects}에서 꺼 둠` / `{projects}에서만 켬` of a `모든 프로젝트` row: each name picks that project below. */
function ProjectsLine(props: {
  readonly directories: ReadonlyArray<string>
  readonly text: (projects: string) => string
  readonly more: (n: number) => string
  readonly kind: "off" | "only"
  readonly onPick: (directory: string) => void
}) {
  const shown = () => props.directories.slice(0, 3)
  const rest = () => Math.max(0, props.directories.length - 3)
  const parts = () => props.text("\u0000").split("\u0000")
  const names = (): JSX.Element => (
    <>
      <For each={shown()}>
        {(directory, index) => (
          <>
            {index() > 0 ? ", " : ""}
            <button type="button" class="own-sk-link" title={directory} onClick={() => props.onPick(directory)}>
              {baseName(directory)}
            </button>
          </>
        )}
      </For>
      {rest() > 0 ? ` ${props.more(rest())}` : ""}
    </>
  )
  return (
    <span class="text-[12px] text-own-muted" data-testid="mcp-global-exceptions" data-kind={props.kind}>
      {parts()[0]}
      {names()}
      {parts()[1]}
    </span>
  )
}

/** What the page shows under a row: where it comes from, its definition and tools, and on this PC its actions. */
function RowDetails(props: {
  readonly source: Source
  readonly check: Check | "testing" | undefined
  readonly local: boolean
  readonly onTest: () => void
  readonly onEdit: (server: Server) => void
  readonly onRemove: (server: Server) => void
}) {
  const text = useMcpManageText()
  const i18n = useI18n()
  const listed = () => (props.source.type === "own" ? props.source.server : undefined)
  /** own's server with its definition; elsewhere a summary, whose definition is not shown (it is not known there). */
  const ownServer = () => {
    const server = listed()
    return server && defined(server) ? server : undefined
  }
  const fileServer = (): FileServer | undefined => (props.source.type === "file" ? props.source.server : undefined)
  const label = () => {
    const source = props.source
    if (source.type === "file")
      return `${text("own.mcpm.source.file")} · ${source.server.path ?? ""}`.replace(/ · $/, "")
    if (source.type === "other") return text("own.mcpm.source.other")
    return text(source.server.scope.type === "global" ? "own.mcpm.source.ownGlobal" : "own.mcpm.source.ownProject")
  }
  const summary = () => {
    const server = ownServer()
    if (server) return summaryOf(server)
    return fileServer()?.summary
  }
  const values = () => {
    const server = ownServer()
    if (server)
      return server.transport.type === "local"
        ? { key: "own.mcpm.env" as const, names: secretsOf(server.transport.env) }
        : { key: "own.mcpm.headers" as const, names: secretsOf(server.transport.headers) }
    const file = fileServer()
    if (!file) return undefined
    return file.type === "local"
      ? { key: "own.mcpm.env" as const, names: file.env }
      : { key: "own.mcpm.headers" as const, names: file.headers }
  }
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(i18n.locale() === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" })
  return (
    <div
      class="flex flex-col gap-1 text-[12px] text-own-muted"
      data-testid="mcp-row-details"
      data-source={props.source.type}
    >
      <span class="flex flex-wrap items-center gap-1.5" data-testid="mcp-source">
        <span class="min-w-0 break-all">{label()}</span>
        <Show when={listed()?.from}>{(from) => <Tag tone="plain">{text(`own.mcpm.from.${from()}`)}</Tag>}</Show>
        <Show when={ownServer()?.registry}>
          {(registry) => (
            <span class="own-mono break-all text-[11.5px]" data-testid="mcp-registry-ref">
              {[registry().name, registry().version].filter(Boolean).join(" ")}
            </span>
          )}
        </Show>
      </span>
      <Show when={listed()?.missing}>
        <Notice tone="warn" testid="mcp-missing">
          {text("own.mcpm.missing")}
        </Notice>
      </Show>
      <Show when={summary()}>
        <code class="own-mono break-all text-[11.5px] text-own-text" data-testid="mcp-definition">
          {summary()}
        </code>
      </Show>
      <Show when={values()?.names.length}>
        <span class="own-mono break-all text-[11.5px]" data-testid="mcp-values">
          {text(values()!.key, { names: values()!.names.join(", ") })}
        </span>
      </Show>
      <CheckLine check={props.check} time={time} />
      <HostLine source={props.source} />
      <Show when={props.local && props.source.type !== "other"}>
        <div class="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            disabled={props.check === "testing"}
            data-testid="mcp-test"
            onClick={() => props.onTest()}
          >
            <Show when={props.check === "testing"}>
              <Spinner />{" "}
            </Show>
            {text(props.check === "testing" ? "own.mcpm.testing" : "own.mcpm.test")}
          </button>
          <Show when={ownServer()}>
            {(server) => (
              <>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  aria-haspopup="dialog"
                  data-testid="mcp-edit"
                  onClick={() => props.onEdit(server())}
                >
                  {text("own.mcpm.edit")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  aria-haspopup="dialog"
                  data-testid="mcp-remove"
                  onClick={() => props.onRemove(server())}
                >
                  {text("own.mcpm.remove")}
                </button>
              </>
            )}
          </Show>
          <Show when={fileServer()}>
            <span class="text-own-faint">{text("own.mcpm.fileNote")}</span>
          </Show>
        </div>
      </Show>
    </div>
  )
}
