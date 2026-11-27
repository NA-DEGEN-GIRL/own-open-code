// 설정 > GitHub (16, GH 2026-10-31; lazy, `/settings/github`). The GitHub accounts own connected (own.accounts
// `github.*`): the account in use for the project on screen and why, the accounts with their tags and actions, adding
// one by token or by a browser login with the user's own app, which account the default, a project folder (a team
// area's folder too) and each conversation of the project use, the tools GitHub's MCP server gives, git's logins and
// the browser login app's client ID. Tokens go in once and never come back: the page shows their last four characters.
// Adding, tokens and settings are this PC's windows' (`local`); a phone sees the list and changes choices (`admin`).
// On an SSH host's session or project (16 §8) the page keeps this PC's choices for that host's folders and
// conversations: the host's GitHub tools and git go through this PC with the account chosen here. A host only reads
// until this PC's window allows it to write (`writeHosts`, GH-49): the switch for the host on screen and the list.
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { OwnGitHub } from "@own/protocol"
import { errorData, errorType } from "@/accounts/errors"
import { useData, type ServerRuntime } from "@/data"
import type { SessionRow } from "@/data/session-cache"
import { useHost } from "@/host"
import { Dialog, Notice, Segmented, Spinner, StatusLine, Tag, TextField, createStatus } from "@/limits/kit"
import { createProjectChoice, ProjectPicker } from "@/projects/choice"
import { samePath } from "@/projects/path"
import {
  accountName,
  accountTags,
  choiceOf,
  choiceValue,
  errorText,
  hostWrites,
  inUseText,
  projectChoiceAt,
  sessionChoice,
  TOOLSETS,
  writeHostsWith,
  type Text,
} from "./model"
import { useGitHubText } from "./strings"

const TOKEN_PAGE = "https://github.com/settings/personal-access-tokens/new"
const APP_PAGE = "https://github.com/settings/applications/new"

export interface GitHubSettingsProps {
  /**
   * The server and project to start on (the session or project on screen): this PC's, or an SSH host's (`host`, its
   * id), whose folders and conversations the choices are about.
   */
  readonly place?: { readonly runtime: ServerRuntime; readonly directory?: string; readonly host?: string }
}

export default function GitHubSettings(props: GitHubSettingsProps) {
  const data = useData()
  const text = useGitHubText()
  /** The accounts and choices are this PC's: every call goes to it. */
  const runtime = () => data.local()
  /** The server whose projects and conversations the page lists. */
  const server = () => props.place?.runtime ?? data.local()
  const host = () => props.place?.host
  const choice = createProjectChoice({ runtime: server, directory: () => props.place?.directory })
  const local = () => runtime().rpc.allowed("github.add.token")
  const status = createStatus()
  const [view, { refetch, mutate }] = createResource(
    () => ({ directory: choice.directory(), host: host() }),
    (source) =>
      runtime().rpc.call("github.view", {
        ...(source.directory ? { directory: source.directory } : {}),
        ...(source.host ? { host: source.host } : {}),
      }),
  )
  onCleanup(runtime().own.on("github.changed", () => void refetch()))
  /** Runs one change: the answer replaces the view, a failure shows its words. */
  const change = async (run: () => Promise<OwnGitHub.View | undefined>, done?: string) => {
    status.clear()
    const answer = await run().catch((error: unknown) => {
      status.error(errorText(errorType(error), errorData(error), String(error), text))
      return undefined
    })
    if (!answer) return false
    mutate({ ...answer, ...(view.latest?.inUse ? { inUse: view.latest.inUse } : {}) })
    void refetch()
    if (done) status.ok(done)
    return true
  }
  const call = runtime().rpc.call
  return (
    <div class="flex flex-col gap-4" data-testid="settings-github-page">
      <p class="m-0 text-[13px] text-own-muted">{text("own.gh.lead")}</p>
      <ProjectPicker choice={choice} label={text("own.gh.project")} testid="github-project" />
      <Show when={host()}>
        {(id) => (
          <p class="m-0 text-[12.5px] text-own-muted" data-testid="github-host">
            {text("own.gh.host", { host: server().entry()?.label ?? id() })}
          </p>
        )}
      </Show>
      <Show when={view.latest} fallback={<Spinner />}>
        {(current) => (
          <>
            <Notice testid="github-in-use">
              <b>{text("own.gh.inUse")}</b> · {inUseText(current(), text)}
            </Notice>
            <StatusLine status={status} testid="github-status" />
            <Accounts view={current()} text={text} local={local()} change={change} call={call} />
            <Show when={local()} fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.gh.localOnly")}</p>}>
              <AddAccount view={current()} text={text} change={change} call={call} status={status} />
            </Show>
            <Choices
              view={current()}
              text={text}
              directory={choice.directory()}
              runtime={server()}
              host={host()}
              change={change}
              call={call}
            />
            <Show when={local()}>
              <HostWrites
                view={current()}
                text={text}
                host={host()}
                label={(id) => data.get(id)?.entry()?.label ?? id}
                change={change}
                call={call}
              />
            </Show>
            <Tools view={current()} text={text} local={local()} change={change} call={call} status={status} />
          </>
        )}
      </Show>
    </div>
  )
}

type Call = ReturnType<ReturnType<typeof useData>["local"]>["rpc"]["call"]
type Change = (run: () => Promise<OwnGitHub.View | undefined>, done?: string) => Promise<boolean>

function Section(props: { readonly title: string; readonly note?: string; readonly children: unknown }) {
  return (
    <section class="flex flex-col gap-2 border-t border-own-border pt-3">
      <h2 class="m-0 text-[14px] font-semibold">{props.title}</h2>
      <Show when={props.note}>
        <p class="m-0 text-[12.5px] text-own-muted">{props.note}</p>
      </Show>
      {props.children as never}
    </section>
  )
}

function Accounts(props: {
  readonly view: OwnGitHub.View
  readonly text: Text
  readonly local: boolean
  readonly change: Change
  readonly call: Call
}) {
  const [removing, setRemoving] = createSignal<OwnGitHub.Account>()
  const [editing, setEditing] = createSignal<{
    readonly account: OwnGitHub.Account
    readonly kind: "label" | "token"
  }>()
  const [draft, setDraft] = createSignal("")
  const text = props.text
  return (
    <Section title={text("own.gh.accounts")}>
      <Show
        when={props.view.accounts.length > 0}
        fallback={<p class="m-0 text-[13px]">{text("own.gh.accounts.empty")}</p>}
      >
        <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="github-accounts">
          <For each={props.view.accounts}>
            {(account) => (
              <li class="flex flex-col gap-1.5 rounded-md border border-own-border p-2.5" data-testid="github-account">
                <div class="flex flex-wrap items-center gap-1.5">
                  <b class="text-[13.5px]">{accountName(account)}</b>
                  <For each={accountTags(account, props.view, text)}>{(tag) => <Tag tone="soft">{tag}</Tag>}</For>
                  <Show when={account.problem}>
                    {(problem) => <Tag tone="danger">{text(`own.gh.problem.${problem()}`)}</Tag>}
                  </Show>
                </div>
                <div class="flex flex-wrap gap-1.5">
                  <Show when={props.view.default !== account.id}>
                    <Button
                      testid="github-make-default"
                      onClick={() =>
                        props.change(() =>
                          props.call("github.bind", { target: { type: "default" }, account: account.id }),
                        )
                      }
                    >
                      {text("own.gh.makeDefault")}
                    </Button>
                  </Show>
                  <Show when={props.local}>
                    <Button
                      testid="github-write"
                      onClick={() =>
                        props.change(() => props.call("github.update", { id: account.id, write: !account.write }))
                      }
                    >
                      {text(account.write ? "own.gh.readOnly" : "own.gh.allowWrite")}
                    </Button>
                    <Button
                      testid="github-rename"
                      onClick={() => {
                        setDraft(account.label)
                        setEditing({ account, kind: "label" })
                      }}
                    >
                      {text("own.gh.rename")}
                    </Button>
                    <Button
                      testid="github-replace"
                      onClick={() => {
                        setDraft("")
                        setEditing({ account, kind: "token" })
                      }}
                    >
                      {text("own.gh.replace")}
                    </Button>
                    <Button
                      testid="github-check"
                      onClick={() =>
                        props.change(async () => {
                          await props.call("github.test", { id: account.id })
                          return props.call("github.view", {})
                        })
                      }
                    >
                      {text("own.gh.check")}
                    </Button>
                    <Button testid="github-remove" onClick={() => setRemoving(account)}>
                      {text("own.gh.remove")}
                    </Button>
                  </Show>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Dialog
        open={removing() !== undefined}
        title={text("own.gh.remove")}
        onClose={() => setRemoving(undefined)}
        testid="github-remove-dialog"
        footer={
          <>
            <Button testid="github-remove-cancel" onClick={() => setRemoving(undefined)}>
              {text("own.gh.cancel")}
            </Button>
            <Button
              testid="github-remove-yes"
              tone="danger"
              onClick={async () => {
                const account = removing()
                setRemoving(undefined)
                if (account) await props.change(() => props.call("github.remove", { id: account.id }))
              }}
            >
              {text("own.gh.removeYes")}
            </Button>
          </>
        }
      >
        <p class="m-0 text-[13px]">{text("own.gh.removeConfirm", { label: removing()?.label ?? "" })}</p>
      </Dialog>
      <Dialog
        open={editing() !== undefined}
        title={text(editing()?.kind === "token" ? "own.gh.replace" : "own.gh.rename")}
        onClose={() => setEditing(undefined)}
        testid="github-edit-dialog"
        footer={
          <>
            <Button testid="github-edit-cancel" onClick={() => setEditing(undefined)}>
              {text("own.gh.cancel")}
            </Button>
            <Button
              testid="github-edit-save"
              tone="accent"
              onClick={async () => {
                const edit = editing()
                const value = draft().trim()
                if (!edit || !value) return
                const saved = await props.change(() =>
                  props.call(
                    "github.update",
                    edit.kind === "token"
                      ? { id: edit.account.id, token: value }
                      : { id: edit.account.id, label: value },
                  ),
                )
                setDraft("")
                if (saved) setEditing(undefined)
              }}
            >
              {text("own.gh.save")}
            </Button>
          </>
        }
      >
        <TextField
          label={text(editing()?.kind === "token" ? "own.gh.token" : "own.gh.label")}
          value={draft()}
          onValue={setDraft}
          type={editing()?.kind === "token" ? "password" : "text"}
          autocomplete="off"
          testid="github-edit-value"
        />
      </Dialog>
    </Section>
  )
}

function AddAccount(props: {
  readonly view: OwnGitHub.View
  readonly text: Text
  readonly change: Change
  readonly call: Call
  readonly status: ReturnType<typeof createStatus>
}) {
  const host = useHost()
  const text = props.text
  const [mode, setMode] = createSignal<"token" | "device">("token")
  const [label, setLabel] = createSignal("")
  const [token, setToken] = createSignal("")
  const [site, setSite] = createSignal("")
  const [write, setWrite] = createSignal(false)
  const [device, setDevice] = createSignal<{
    readonly start: OwnGitHub.DeviceStart
    readonly state: OwnGitHub.DeviceState
    readonly message?: string
  }>()
  const input = () => ({
    ...(label().trim() ? { label: label().trim() } : {}),
    ...(site().trim() ? { site: site().trim().replace(/\/+$/, "") } : {}),
    write: write(),
  })
  const connect = async () => {
    const value = token().trim()
    if (!value) return
    // The token leaves the page as soon as it is sent, whatever GitHub answers.
    setToken("")
    const done = await props.change(
      () => props.call("github.add.token", { token: value, ...input() }),
      text("own.gh.saved"),
    )
    if (!done) return
    setLabel("")
    setSite("")
  }
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  onCleanup(() => clearTimeout(timer.id))
  const poll = (start: OwnGitHub.DeviceStart) => {
    timer.id = setTimeout(async () => {
      const answer = await props.call("github.device.status", { nonce: start.nonce }).catch(() => undefined)
      if (!answer) return
      setDevice({ start, state: answer.state, ...(answer.message ? { message: answer.message } : {}) })
      if (answer.state === "waiting") return poll(start)
      if (answer.state === "done" && answer.view) await props.change(async () => answer.view)
    }, start.intervalMs)
  }
  const startDevice = async () => {
    props.status.clear()
    const start = await props.call("github.device.start", input()).catch((error: unknown) => {
      props.status.error(errorText(errorType(error), errorData(error), String(error), text))
      return undefined
    })
    if (!start) return
    setDevice({ start, state: "waiting" })
    host.openExternal(start.verificationUri)
    poll(start)
  }
  const cancelDevice = async () => {
    const current = device()
    clearTimeout(timer.id)
    setDevice(undefined)
    if (current) await props.call("github.device.cancel", { nonce: current.start.nonce }).catch(() => undefined)
  }
  return (
    <Section title={text("own.gh.add")}>
      <Segmented
        label={text("own.gh.add")}
        value={mode()}
        options={[
          { value: "token", label: text("own.gh.add.token") },
          { value: "device", label: text("own.gh.add.device") },
        ]}
        onChange={setMode}
        testid="github-add-mode"
      />
      <TextField label={text("own.gh.label")} value={label()} onValue={setLabel} testid="github-add-label" />
      <TextField
        label={text("own.gh.site")}
        hint={text("own.gh.site.hint")}
        value={site()}
        onValue={setSite}
        placeholder="https://github.example.com"
        testid="github-add-site"
      />
      <label class="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={write()}
          onChange={(event) => setWrite(event.currentTarget.checked)}
          data-testid="github-add-write"
        />
        {text("own.gh.writeBox")}
      </label>
      <Show
        when={mode() === "token"}
        fallback={
          <Show
            when={props.view.settings.clientID}
            fallback={<Notice tone="warn">{text("own.gh.device.needsApp")}</Notice>}
          >
            <Show
              when={device()}
              fallback={
                <Button testid="github-device-start" tone="accent" onClick={() => void startDevice()}>
                  {text("own.gh.device.start")}
                </Button>
              }
            >
              {(current) => (
                <div class="flex flex-col gap-1.5" data-testid="github-device">
                  <span class="text-[13px]">{text("own.gh.device.code")}</span>
                  <code class="text-[18px] font-semibold tracking-widest" data-testid="github-device-code">
                    {current().start.userCode}
                  </code>
                  <div class="flex flex-wrap gap-1.5">
                    <Button onClick={() => host.openExternal(current().start.verificationUri)}>
                      {text("own.gh.device.open")}
                    </Button>
                    <Button testid="github-device-cancel" onClick={() => void cancelDevice()}>
                      {text("own.gh.cancel")}
                    </Button>
                  </div>
                  <span class="text-[12.5px] text-own-muted" data-testid="github-device-state">
                    {deviceText(current().state, current().message, text)}
                  </span>
                </div>
              )}
            </Show>
          </Show>
        }
      >
        <TextField
          label={text("own.gh.token")}
          hint={text("own.gh.token.hint")}
          value={token()}
          onValue={setToken}
          onEnter={() => void connect()}
          type="password"
          autocomplete="off"
          testid="github-add-token"
        />
        <div class="flex flex-wrap gap-1.5">
          <Button testid="github-add-connect" tone="accent" onClick={() => void connect()}>
            {text("own.gh.connect")}
          </Button>
          <Button onClick={() => host.openExternal(TOKEN_PAGE)}>{text("own.gh.token.make")}</Button>
        </div>
      </Show>
    </Section>
  )
}

function deviceText(state: OwnGitHub.DeviceState, message: string | undefined, text: Text) {
  if (state === "waiting") return text("own.gh.device.waiting")
  if (state === "done") return text("own.gh.saved")
  if (state === "failed") return text("own.gh.device.failed", { message: message ?? "" })
  return text(`own.gh.device.${state}`)
}

function Choices(props: {
  readonly view: OwnGitHub.View
  readonly text: Text
  readonly directory: string | undefined
  /** The server whose conversations are listed (this PC's, or the SSH host's on screen). */
  readonly runtime: ServerRuntime
  /** The SSH host the folder and conversations are on (16 §8). */
  readonly host: string | undefined
  readonly change: Change
  readonly call: Call
}) {
  const text = props.text
  /** The project's root conversations, newest first (the sidebar's list). */
  const sessions = createMemo(() => {
    const directory = props.directory
    if (!directory) return []
    const state = props.runtime.sessions.state
    return state.order
      .map((id) => state.sessions[id])
      .filter((row): row is SessionRow => row !== undefined && !row.parentID && samePath(row.directory, directory))
      .slice(0, 30)
  })
  const options = (withOff: boolean) => [
    { value: "", label: text("own.gh.inherit") },
    ...props.view.accounts.map((account) => ({ value: account.id, label: accountName(account) })),
    ...(withOff ? [{ value: "off", label: text("own.gh.off") }] : []),
  ]
  const bind = (target: OwnGitHub.Target, value: string) =>
    props.change(() => props.call("github.bind", { target, account: choiceOf(value) }))
  return (
    <Section title={text("own.gh.choices")} note={text("own.gh.choices.note")}>
      <Pick
        label={text("own.gh.defaultAccount")}
        value={props.view.default ?? ""}
        options={[{ value: "", label: text("own.gh.none") }, ...options(false).slice(1)]}
        onChange={(value) => bind({ type: "default" }, value)}
        testid="github-default"
      />
      <Show when={props.directory}>
        {(directory) => (
          <Pick
            label={text("own.gh.projectChoice")}
            value={choiceValue(projectChoiceAt(props.view, directory(), props.host))}
            options={options(true)}
            onChange={(value) => bind(projectTarget(directory(), props.host), value)}
            testid="github-project-choice"
          />
        )}
      </Show>
      <h3 class="m-0 mt-1 text-[13px] font-semibold">{text("own.gh.projects")}</h3>
      <Show
        when={props.view.projects.length > 0}
        fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.gh.projects.empty")}</p>}
      >
        <ul class="m-0 flex list-none flex-col gap-1 p-0" data-testid="github-projects">
          <For each={props.view.projects}>
            {(item) => (
              <li class="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span class="min-w-0 flex-1 break-all">{item.directory}</span>
                <Show when={item.host}>{(id) => <Tag tone="soft">{text("own.gh.hostTag", { host: id() })}</Tag>}</Show>
                <Tag tone="soft">
                  {item.account === "off"
                    ? text("own.gh.off")
                    : (accountLabel(props.view, item.account) ?? item.account)}
                </Tag>
                <Button onClick={() => bind(projectTarget(item.directory, item.host), "")}>
                  {text("own.gh.clear")}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3 class="m-0 mt-1 text-[13px] font-semibold">{text("own.gh.sessions")}</h3>
      <p class="m-0 text-[12.5px] text-own-muted">{text("own.gh.sessions.note")}</p>
      <Show
        when={sessions().length > 0}
        fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.gh.sessions.empty")}</p>}
      >
        <ul class="m-0 flex list-none flex-col gap-1 p-0" data-testid="github-sessions">
          <For each={sessions()}>
            {(row) => (
              <li class="flex flex-wrap items-center gap-2">
                <Pick
                  label={row.title || text("own.gh.untitled")}
                  value={choiceValue(sessionChoice(props.view, row.id, props.host))}
                  options={options(true)}
                  onChange={(value) =>
                    bind(
                      {
                        type: "session",
                        sessionID: row.id,
                        directory: row.directory,
                        ...(props.host === undefined ? {} : { host: props.host }),
                      },
                      value,
                    )
                  }
                  testid="github-session-choice"
                />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  )
}

/** A project folder's target: this PC's, or with `host` that SSH host's. */
function projectTarget(directory: string, host: string | undefined): OwnGitHub.Target {
  return { type: "project", directory, ...(host === undefined ? {} : { host }) }
}

/**
 * Which SSH hosts may write on GitHub through this PC (16 §8.11, GH-49): the host on screen's switch and the hosts
 * allowed so far, each with its take-back. This PC's windows only (`github.settings.set` is `local`).
 */
function HostWrites(props: {
  readonly view: OwnGitHub.View
  readonly text: Text
  /** The SSH host on screen, if any. */
  readonly host: string | undefined
  readonly label: (host: string) => string
  readonly change: Change
  readonly call: Call
}) {
  const text = props.text
  const set = (host: string, on: boolean) =>
    props.change(
      () => props.call("github.settings.set", { writeHosts: writeHostsWith(props.view, host, on) }),
      text("own.gh.saved"),
    )
  return (
    <Section title={text("own.gh.hostWrite")} note={text("own.gh.hostWrite.note")}>
      <Show when={props.host}>
        {(host) => (
          <label class="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={hostWrites(props.view, host())}
              onChange={(event) => void set(host(), event.currentTarget.checked)}
              data-testid="github-host-write"
            />
            {text("own.gh.hostWrite.label", { host: props.label(host()) })}
          </label>
        )}
      </Show>
      <Show
        when={(props.view.settings.writeHosts ?? []).length > 0}
        fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.gh.hostWrite.empty")}</p>}
      >
        <ul class="m-0 flex list-none flex-col gap-1 p-0" data-testid="github-host-writes">
          <For each={props.view.settings.writeHosts ?? []}>
            {(host) => (
              <li class="flex flex-wrap items-center gap-2 text-[12.5px]">
                <span class="min-w-0 flex-1 break-all">{props.label(host)}</span>
                <Tag tone="soft">{text("own.gh.hostTag", { host })}</Tag>
                <Button testid="github-host-write-remove" onClick={() => void set(host, false)}>
                  {text("own.gh.hostWrite.remove")}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  )
}

function Tools(props: {
  readonly view: OwnGitHub.View
  readonly text: Text
  readonly local: boolean
  readonly change: Change
  readonly call: Call
  readonly status: ReturnType<typeof createStatus>
}) {
  const host = useHost()
  const text = props.text
  const settings = () => props.view.settings
  const server = settings().server
  const [command, setCommand] = createSignal(server.type === "local" ? server.command : "")
  const [clientID, setClientID] = createSignal(settings().clientID ?? "")
  const save = (input: OwnGitHub.SettingsInput) =>
    props.change(() => props.call("github.settings.set", input), text("own.gh.saved"))
  const toggleToolset = (name: string, on: boolean) =>
    save({ toolsets: on ? [...settings().toolsets, name] : settings().toolsets.filter((item) => item !== name) })
  return (
    <>
      <Section title={text("own.gh.tools")} note={text("own.gh.tools.note")}>
        <p class="m-0 text-[13px]" data-testid="github-tools">
          {props.view.catalog
            ? text("own.gh.tools.count", {
                read: props.view.catalog.read.length,
                write: props.view.catalog.write.length,
                server: props.view.catalog.server ?? "",
              })
            : text("own.gh.tools.none")}
        </p>
        <Show when={props.local}>
          <Show when={props.view.default ?? props.view.accounts[0]?.id}>
            {(id) => (
              <Button
                testid="github-tools-reload"
                onClick={() =>
                  props.change(async () => {
                    await props.call("github.test", { id: id() })
                    return props.call("github.view", {})
                  })
                }
              >
                {text("own.gh.tools.reload")}
              </Button>
            )}
          </Show>
          <fieldset class="m-0 flex flex-wrap gap-x-3 gap-y-1 border-0 p-0" data-testid="github-toolsets">
            <legend class="mb-1 text-[12.5px] text-own-muted">{text("own.gh.toolsets")}</legend>
            <For each={TOOLSETS}>
              {(name) => (
                <label class="flex items-center gap-1 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={settings().toolsets.includes(name)}
                    onChange={(event) => void toggleToolset(name, event.currentTarget.checked)}
                  />
                  {name}
                </label>
              )}
            </For>
          </fieldset>
          <Segmented
            label={text("own.gh.server")}
            value={settings().server.type}
            options={[
              { value: "remote", label: text("own.gh.server.hosted") },
              { value: "local", label: text("own.gh.server.local") },
            ]}
            onChange={(type) =>
              void save({
                server:
                  type === "remote"
                    ? { type: "remote", url: "https://api.githubcopilot.com/mcp/" }
                    : { type: "local", command: command().trim() || "github-mcp-server", args: ["stdio"] },
              })
            }
            testid="github-server"
          />
          <Show when={settings().server.type === "local"}>
            <TextField
              label={text("own.gh.server.command")}
              value={command()}
              onValue={setCommand}
              onEnter={() =>
                void save({
                  server: { type: "local", command: command().trim() || "github-mcp-server", args: ["stdio"] },
                })
              }
              testid="github-server-command"
            />
          </Show>
        </Show>
      </Section>
      <Show when={props.local}>
        <Section title={text("own.gh.git")} note={text("own.gh.git.note")}>
          <label class="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={settings().git}
              onChange={(event) => void save({ git: event.currentTarget.checked })}
              data-testid="github-git"
            />
            {text("own.gh.git.label")}
          </label>
        </Section>
        <Section title={text("own.gh.app")} note={text("own.gh.app.note")}>
          <TextField
            label={text("own.gh.clientID")}
            value={clientID()}
            onValue={setClientID}
            onEnter={() => void save({ clientID: clientID().trim() || null })}
            testid="github-client-id"
          />
          <div class="flex flex-wrap gap-1.5">
            <Button testid="github-client-id-save" onClick={() => void save({ clientID: clientID().trim() || null })}>
              {text("own.gh.save")}
            </Button>
            <Button onClick={() => host.openExternal(APP_PAGE)}>{text("own.gh.app.make")}</Button>
          </div>
        </Section>
      </Show>
    </>
  )
}

function accountLabel(view: OwnGitHub.View, id: string) {
  const account = view.accounts.find((item) => item.id === id)
  return account ? accountName(account) : undefined
}

function Pick(props: {
  readonly label: string
  readonly value: string
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  readonly onChange: (value: string) => void
  readonly testid: string
}) {
  return (
    <label class="flex w-full flex-wrap items-center gap-2 text-[13px]">
      <span class="min-w-[160px] flex-1 truncate">{props.label}</span>
      <select
        class="own-input h-8 max-w-full min-w-0"
        data-testid={props.testid}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        <For each={props.options}>
          {(option) => (
            <option value={option.value} selected={option.value === props.value}>
              {option.label}
            </option>
          )}
        </For>
      </select>
    </label>
  )
}

function Button(props: {
  readonly onClick: () => unknown
  readonly testid?: string
  readonly tone?: "accent" | "danger"
  readonly children: unknown
}) {
  return (
    <button
      type="button"
      class="own-btn"
      data-variant={props.tone === "accent" ? "primary" : props.tone}
      data-testid={props.testid}
      onClick={() => void props.onClick()}
    >
      {props.children as never}
    </button>
  )
}
