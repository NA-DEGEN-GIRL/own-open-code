// 설정 > 셸·터미널 (03 §5.7, §19.8, [gap] 24; 01 §17.1 #24): the default shell of the agent's shell tool and of new
// terminals — one config value (`shell`), changed with `PATCH /api/experimental/config {shell}` after a confirmation
// that says what changes (19 "확인 단계에서 무엇이 바뀌는지 적는다", P3): the tool's shell, new terminals, the cache
// (the tool description names the shell; model.ts has the sources), and the global config file. Lazy with the
// settings page (20.2 R5).
//   - Config is per Location: the page reads and writes at the project on screen (else the control location), never
//     at a location the server would make up (G15); the request carries that directory.
//   - A project config that sets `shell` outranks the global value: the page says so after reading it back.
//   - Devices behind the gateway (`auth: device`) see the setting read-only; SSH hosts can be picked when attached.
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import { createStatus, Notice, Segmented, StatusLine, Tag } from "@/limits/kit"
import { activeDirectory, controlOf } from "@/projects"
import { useRouter } from "@/routing/router"
import {
  cacheEffect,
  configuredShell,
  projectOverride,
  selectedOption,
  shellKind,
  shellName,
  windowsServer,
  type ShellOption,
} from "./model"
import { useShellText } from "./strings"

type Choice = { readonly option: ShellOption | undefined }

export default function ShellSettings() {
  const data = useData()
  const router = useRouter()
  const text = useShellText()
  const status = createStatus()
  const [serverKey, setServerKey] = createSignal<ServerKey>(LOCAL)
  const runtime = () => data.get(serverKey()) ?? data.local()
  const connected = () => runtime().connection.status() === "connected"
  const directory = createMemo(() => activeDirectory(runtime(), router.route()) ?? controlOf(runtime()))
  const readOnly = () => runtime().entry()?.auth === "device"
  const [attempt, setAttempt] = createSignal(0)
  /** The location the requests act in (the server would otherwise use its own working directory). */
  const at = (folder: string | undefined) =>
    folder ? { headers: { "x-opencode-directory": encodeURIComponent(folder) } } : undefined

  const [shells] = createResource(
    () => connected() && { runtime: runtime(), directory: directory(), attempt: attempt() },
    (input) => input.runtime.client().config.shells(at(input.directory)),
  )
  const [config, { refetch }] = createResource(
    () => {
      const folder = directory()
      return connected() && folder ? { runtime: runtime(), directory: folder, attempt: attempt() } : false
    },
    (input) => input.runtime.client().config.get({ location: { directory: input.directory } }),
  )
  // Another window or an edit of the file (config.updated after the server reloads it).
  createEffect(() => {
    const current = runtime()
    onCleanup(current.bus.on("config.updated", () => void refetch()))
  })

  const options = () => (shells.state === "ready" ? shells() : undefined)
  const configured = () => (config.state === "ready" ? configuredShell(config()) : undefined)
  const selected = () => selectedOption(options() ?? [], configured())
  const [choice, setChoice] = createSignal<Choice>()
  const [busy, setBusy] = createSignal(false)
  /** What the radios show: the pending choice, else the current value (`auto` when nothing is set). */
  const checked = () => {
    const pending = choice()
    if (pending) return pending.option?.path ?? "auto"
    return selected()?.path ?? (configured() ? undefined : "auto")
  }
  const nameOf = (option: ShellOption | undefined) => {
    if (!option) return text("own.shellcfg.auto")
    const kind = shellKind(option)
    return kind === "other" ? option.name : text(`own.shellcfg.kind.${kind}`)
  }

  function choose(option: ShellOption | undefined) {
    status.clear()
    const same = option ? selected()?.path === option.path : !configured()
    setChoice(same ? undefined : { option })
  }

  async function apply() {
    const pending = choice()
    if (!pending) return
    setBusy(true)
    status.clear()
    const folder = directory()
    await runtime()
      .client()
      .config.update({ shell: pending.option?.path ?? null }, at(folder))
      .then(
        async () => {
          setChoice(undefined)
          await refetch()
          status.ok(text("own.shellcfg.applied", { name: nameOf(pending.option) }))
        },
        (error: unknown) =>
          status.error(text("own.shellcfg.failed", { reason: error instanceof Error ? error.message : String(error) })),
      )
    setBusy(false)
  }

  const override = () => {
    const value = configured()
    if (!projectOverride(value, directory())) return undefined
    return { path: value!.source!, name: nameOf(selectedOption(options() ?? [], value)) || value!.value }
  }

  return (
    <div class="flex flex-col" data-testid="settings-shell">
      <section class="own-psec mt-0" aria-labelledby="own-shell-title">
        <div class="own-psec-head">
          <h2 id="own-shell-title">{text("own.shellcfg.title")}</h2>
        </div>
        <p class="m-0 mb-3 text-[12.5px] text-own-muted">{text("own.shellcfg.intro")}</p>
        <Show when={data.servers.list().length > 1}>
          <div class="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span class="text-own-muted">{text("own.shellcfg.server")}</span>
            <Segmented
              label={text("own.shellcfg.server")}
              value={serverKey()}
              options={data.servers.list().map((entry) => ({
                value: entry.key,
                label: entry.key === LOCAL ? text("own.shellcfg.thisPc") : entry.label,
              }))}
              onChange={(key) => {
                setChoice(undefined)
                status.clear()
                setServerKey(key)
              }}
              testid="shell-server"
            />
          </div>
        </Show>
        <Show when={directory()}>
          {(folder) => (
            <p class="own-mono m-0 mb-2 truncate text-[11.5px] text-own-faint" title={folder()}>
              {text("own.shellcfg.project", { path: folder() })}
            </p>
          )}
        </Show>
        <Show when={readOnly()}>
          <Notice tone="info" testid="shell-readonly">
            {text("own.shellcfg.readOnly")}
          </Notice>
        </Show>

        <Show when={connected()} fallback={<p class="own-placeholder px-0">{text("own.shellcfg.notConnected")}</p>}>
          <Show when={shells.state !== "errored"} fallback={<LoadFailed onRetry={() => setAttempt((n) => n + 1)} />}>
            <Show
              when={options()}
              fallback={
                <p class="own-placeholder px-0" data-testid="shell-loading">
                  {text("own.shellcfg.loading")}
                </p>
              }
            >
              {(list) => (
                <div
                  class="flex flex-col gap-1"
                  role="radiogroup"
                  aria-labelledby="own-shell-title"
                  data-testid="shell-options"
                >
                  <ShellRow
                    value="auto"
                    title={text("own.shellcfg.auto")}
                    note={text(windowsServer(list()) ? "own.shellcfg.autoWindows" : "own.shellcfg.autoUnix")}
                    checked={checked() === "auto"}
                    current={config.state === "ready" && !configured()}
                    disabled={readOnly() || busy()}
                    onPick={() => choose(undefined)}
                  />
                  <For each={list()}>
                    {(option) => (
                      <ShellRow
                        value={option.path}
                        title={nameOf(option)}
                        path={option.path}
                        note={option.acceptable ? undefined : text("own.shellcfg.notForAgent")}
                        checked={checked() === option.path}
                        current={selected()?.path === option.path}
                        disabled={readOnly() || busy()}
                        onPick={() => choose(option)}
                      />
                    )}
                  </For>
                  <Show when={!list().length}>
                    <p class="own-placeholder px-0">{text("own.shellcfg.none")}</p>
                  </Show>
                  <Show when={configured() && !selected()}>
                    <p class="m-0 text-[12.5px] text-own-warn" data-testid="shell-unlisted">
                      {text("own.shellcfg.unlisted", { value: configured()!.value })}
                    </p>
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </Show>

        <Show when={choice()}>
          {(pending) => (
            <Confirm
              choice={pending()}
              from={selected()}
              configured={!!configured()}
              name={nameOf(pending().option)}
              fromName={selected() ? shellName(selected()!.path) : undefined}
              busy={busy()}
              onApply={() => void apply()}
              onCancel={() => setChoice(undefined)}
            />
          )}
        </Show>
        <Show when={override()}>
          {(value) => (
            <Notice tone="warn" testid="shell-overridden">
              {text("own.shellcfg.overridden", { path: value().path, name: value().name })}
            </Notice>
          )}
        </Show>
        <StatusLine status={status} testid="shell-status" />
      </section>

      <section class="own-psec" aria-labelledby="own-shell-terminal">
        <div class="own-psec-head">
          <h2 id="own-shell-terminal">{text("own.shellcfg.terminalTitle")}</h2>
        </div>
        <p class="m-0 text-[12.5px] text-own-muted">{text("own.shellcfg.terminalNote")}</p>
        <p class="m-0 mt-1 text-[12px] text-own-faint">{text("own.shellcfg.terminalLater")}</p>
      </section>
    </div>
  )
}

function ShellRow(props: {
  readonly value: string
  readonly title: string
  readonly path?: string
  readonly note?: string
  readonly checked: boolean
  readonly current: boolean
  readonly disabled: boolean
  readonly onPick: () => void
}) {
  const text = useShellText()
  return (
    <label
      class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-own-border px-3 py-2 hover:bg-own-hover has-[:checked]:border-own-accent-text has-[:checked]:bg-own-accent-soft has-[:disabled]:cursor-default"
      data-testid="shell-option"
      data-value={props.value}
      data-current={props.current ? "" : undefined}
    >
      <input
        type="radio"
        name="own-shell"
        class="mt-1 accent-[var(--own-accent)]"
        value={props.value}
        checked={props.checked}
        disabled={props.disabled}
        onChange={() => props.onPick()}
      />
      <span class="min-w-0 flex-1">
        <span class="flex flex-wrap items-center gap-1.5 text-[13.5px]">
          <b class="font-semibold">{props.title}</b>
          <Show when={props.current}>
            <Tag tone="ok">{text("own.shellcfg.current")}</Tag>
          </Show>
        </span>
        <Show when={props.path}>
          <span class="own-mono block truncate text-[11.5px] text-own-muted" title={props.path}>
            {props.path}
          </span>
        </Show>
        <Show when={props.note}>
          <span class="block text-[12px] text-own-muted">{props.note}</span>
        </Show>
      </span>
    </label>
  )
}

function Confirm(props: {
  readonly choice: Choice
  readonly from: ShellOption | undefined
  readonly configured: boolean
  readonly name: string
  readonly fromName: string | undefined
  readonly busy: boolean
  readonly onApply: () => void
  readonly onCancel: () => void
}) {
  const text = useShellText()
  const option = () => props.choice.option
  const effect = () => cacheEffect(props.from, option())
  return (
    <div
      class="mt-3 flex flex-col gap-2 rounded-lg border border-own-border bg-own-subtle p-3"
      role="group"
      aria-labelledby="own-shell-confirm"
      data-testid="shell-confirm"
      data-cache={effect()}
    >
      <b id="own-shell-confirm" class="text-[13.5px]">
        {option() ? text("own.shellcfg.confirmTitle", { name: props.name }) : text("own.shellcfg.confirmAuto")}
      </b>
      <ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px]">
        <li>
          {option()?.acceptable === false
            ? text("own.shellcfg.notForAgent")
            : text("own.shellcfg.confirm.agent", { name: props.name })}
        </li>
        <li>{text("own.shellcfg.confirm.terminal", { name: props.name })}</li>
        <li data-testid="shell-confirm-cache">
          <Show when={effect() !== "unknown"} fallback={text("own.shellcfg.confirm.cache")}>
            {effect() === "same"
              ? text("own.shellcfg.confirm.cacheSame", { name: props.fromName ?? "" })
              : text("own.shellcfg.confirm.cacheChanges", {
                  from: props.fromName ?? "",
                  to: shellName(option()!.path),
                })}
          </Show>
        </li>
        <li>{text(option() ? "own.shellcfg.confirm.write" : "own.shellcfg.confirm.remove")}</li>
      </ul>
      <div class="flex gap-2">
        <button
          type="button"
          class="own-btn"
          data-variant="primary"
          data-size="sm"
          disabled={props.busy}
          data-testid="shell-apply"
          onClick={() => props.onApply()}
        >
          {text(props.busy ? "own.shellcfg.applying" : "own.shellcfg.apply")}
        </button>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          disabled={props.busy}
          data-testid="shell-cancel"
          onClick={() => props.onCancel()}
        >
          {text("own.shellcfg.cancel")}
        </button>
      </div>
    </div>
  )
}

function LoadFailed(props: { readonly onRetry: () => void }) {
  const text = useShellText()
  return (
    <div class="flex items-center gap-2 text-[12.5px]" data-testid="shell-failed">
      <span class="text-own-danger" role="alert">
        {text("own.shellcfg.loadFailed")}
      </span>
      <button type="button" class="own-btn" data-size="sm" onClick={() => props.onRetry()}>
        {text("own.shellcfg.retry")}
      </button>
    </div>
  )
}
