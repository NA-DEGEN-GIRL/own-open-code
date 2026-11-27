// Add-host flow (04 §17.3), also the "호스트 키 확인…" and "설치…" entry points of a listed host:
// 1. alias list from `hosts.discover` (~/.ssh/config read as files, nothing executed; added / forwards / loose host
//    key marked) or a typed target.
// 2. `연결 확인` → `hosts.add` → `connect{hostKeyPrompt:true}` (the only flows where an unknown host key can be
//    trusted, 04 §6.3); prompts appear as the prompt dialog on top.
// 3. `needs_install` → the plan card from `prepare.plan` (location, size, free space, no root, upstream untouched,
//    files written) → `prepare.execute`.
// 4. progress from `host.progress` and the stages until `ready`.
// 5. the check card: `agent.probe` result, shell-mode advice, warnings, project settings off → `폴더 열기`.
import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch } from "solid-js"
import { OwnRpcError, type HostStage, type RemoteOutput } from "@/data"
import { Dialog, Notice, Segmented, Spinner, Tag, TextField } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { openRemoteDialog, selectHostPanel, useServersText, type RemoteStore } from "@/servers"
import { PROJECT_STATES, useRemoteText, type RemoteKey } from "./strings"

type Phase = "choose" | "connecting" | "plan" | "installing" | "done" | "failed"
type Plan = RemoteOutput<"prepare.plan">
type Diagnostics = RemoteOutput<"diagnostics">

const ATTEMPT: ReadonlySet<HostStage> = new Set(["connecting", "checking", "authentication", "uploading", "starting"])
const STEPS: readonly HostStage[] = ["connecting", "checking", "authentication", "uploading", "starting", "ready"]

export function AddHostDialog(props: {
  readonly store: RemoteStore
  /** Resume for a listed host (install, host-key check). */
  readonly hostId?: string
  /** Start `connect{hostKeyPrompt:true}` right away (menu `호스트 키 확인…`). */
  readonly hostKey?: boolean
  readonly onClose: () => void
}) {
  const text = useRemoteText()
  const states = useServersText()
  const router = useRouter()
  const store = props.store
  const [hostId, setHostId] = createSignal(props.hostId)
  const [phase, setPhase] = createSignal<Phase>(props.hostId ? "connecting" : "choose")
  const [mode, setMode] = createSignal<"config" | "manual">("config")
  const [aliases, setAliases] = createSignal<RemoteOutput<"hosts.discover">["aliases"]>()
  const [picked, setPicked] = createSignal<string>()
  const [target, setTarget] = createSignal("")
  const [name, setName] = createSignal("")
  const [problem, setProblem] = createSignal<string>()
  const [plan, setPlan] = createSignal<Plan>()
  const [diagnostics, setDiagnostics] = createSignal<Diagnostics>()
  const [busy, setBusy] = createSignal(false)
  /** Terminal stages count only after this flow saw its own attempt run (the list may still show the old state). */
  const [attempted, setAttempted] = createSignal(false)
  const host = () => (hostId() ? store.state.hosts[hostId()!] : undefined)
  const stage = () => host()?.stage

  onMount(() => {
    if (!props.hostId) {
      void store
        .discover()
        .then((result) => {
          setAliases(result.aliases)
          if (!result.aliases.length) setMode("manual")
        })
        .catch(() => {
          setAliases([])
          setMode("manual")
        })
      return
    }
    if (props.hostKey || host()?.stage !== "needs_install") void connect(props.hostId)
    else void loadPlan(props.hostId)
  })

  async function connect(id: string) {
    setPhase("connecting")
    setProblem(undefined)
    setAttempted(false)
    try {
      const result = await store.connect(id, { hostKeyPrompt: true })
      setAttempted(true)
      if (result.stage === "ready") finish(id)
    } catch (error) {
      fail(error)
    }
  }

  async function start() {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    try {
      const known =
        mode() === "config" ? store.state.order.find((id) => store.state.hosts[id]?.alias === picked()) : undefined
      const id =
        known ??
        (
          await store.add(
            mode() === "config"
              ? { alias: picked()! }
              : { target: target().trim(), name: name().trim() || target().trim() },
          )
        ).id
      setHostId(id)
      await connect(id)
    } catch (error) {
      if (error instanceof OwnRpcError && error.type === "input_invalid")
        setProblem(text("own.remote.add.inputInvalid"))
      else fail(error)
    } finally {
      setBusy(false)
    }
  }

  async function loadPlan(id: string) {
    setPhase("plan")
    setPlan(undefined)
    try {
      setPlan(await store.call("prepare.plan", { hostId: id }))
    } catch (error) {
      fail(error)
    }
  }

  async function install() {
    const current = plan()
    if (!current || busy()) return
    setBusy(true)
    setAttempted(false)
    setPhase("installing")
    try {
      const result = await store.call("prepare.execute", { nonce: current.nonce })
      if (!result.ok) {
        const failed = result.steps.find((step) => !step.ok)
        setProblem(failed?.detail ?? failed?.step ?? "install_failed")
        setPhase("failed")
      }
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }

  function finish(id: string) {
    setPhase("done")
    void store
      .diagnostics(id)
      .then(setDiagnostics)
      .catch(() => undefined)
  }

  function fail(error: unknown) {
    setProblem(error instanceof OwnRpcError ? error.type : error instanceof Error ? error.message : String(error))
    setPhase("failed")
  }

  // Follow the host's stage while connecting or installing.
  createEffect(
    on(stage, (current) => {
      const id = hostId()
      if (!id || !current) return
      if (ATTEMPT.has(current)) setAttempted(true)
      if (phase() !== "connecting" && phase() !== "installing") return
      if (current === "ready") return finish(id)
      if (!attempted()) return
      if (current === "needs_install" && phase() === "connecting") return void loadPlan(id)
      const view = host()
      if (
        current === "incompatible" ||
        current === "failed" ||
        (current === "disconnected" && view?.paused && view.error)
      ) {
        setProblem(view?.error ?? undefined)
        setPhase("failed")
      }
    }),
  )

  const progress = createMemo(() =>
    (hostId() ? (store.state.progress[hostId()!] ?? []) : []).filter((item) => item.op === "install"),
  )
  const reached = (step: HostStage) => {
    const current = stage()
    if (!current) return false
    if (current === "ready") return true
    return STEPS.indexOf(step) <= STEPS.indexOf(current)
  }
  const errorText = () => {
    const code = problem() ?? host()?.error
    if (!code) return undefined
    if (code === "host_key" && host()?.detail === "changed") return states("own.remote.overlay.hostKeyChanged")
    const known = `own.remote.error.${code}`
    return known in errorKeys ? states(known as `own.remote.error.${keyof typeof errorKeys}`) : code
  }
  const interactiveOnly = () => {
    const shell = diagnostics()?.shellEnv
    if (!shell?.pathInteractive) return []
    const have = new Set((shell.pathLogin ?? "").split(":"))
    return shell.pathInteractive.split(":").filter((entry) => entry && !have.has(entry))
  }
  const probe = () => probeOf(diagnostics()?.probe)
  const warnings = () => (host()?.warnings ?? []).filter((warning) => warning !== "path_differs_interactive")

  return (
    <Dialog open size="wide" title={text("own.remote.add.title")} onClose={props.onClose} testid="remote-add-dialog">
      <div class="flex flex-col gap-3" data-phase={phase()}>
        <Switch>
          <Match when={phase() === "choose"}>
            <Segmented
              label={text("own.remote.add.title")}
              value={mode()}
              options={[
                { value: "config", label: text("own.remote.add.fromConfig") },
                { value: "manual", label: text("own.remote.add.manual") },
              ]}
              onChange={setMode}
              testid="remote-add-mode"
            />
            <Show when={mode() === "config"}>
              <Show
                when={aliases()}
                fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.remote.add.loading")}</p>}
              >
                {(list) => (
                  <Show
                    when={list().length}
                    fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.remote.add.empty")}</p>}
                  >
                    <div
                      role="radiogroup"
                      aria-label={text("own.remote.add.fromConfig")}
                      class="flex max-h-[300px] flex-col gap-1 overflow-auto"
                      data-testid="remote-aliases"
                    >
                      <For each={list()}>
                        {(item) => (
                          <label
                            class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 hover:bg-own-hover"
                            classList={{
                              // One border color at a time: .border-own-border sorts after .border-own-accent-text in
                              // the generated CSS, so keeping both would hide the picked ring.
                              "border-own-border": picked() !== item.alias,
                              "border-own-accent-text": picked() === item.alias,
                            }}
                            data-testid="remote-alias"
                            data-alias={item.alias}
                          >
                            <input
                              type="radio"
                              name="remote-alias"
                              value={item.alias}
                              checked={picked() === item.alias}
                              onChange={() => setPicked(item.alias)}
                            />
                            <span class="own-mono min-w-0 flex-1 truncate text-[13px]">{item.alias}</span>
                            <Show when={item.known}>
                              <Tag tone="soft">{text("own.remote.add.known")}</Tag>
                            </Show>
                            <Show when={item.forwards === "yes" && !item.localhostForward}>
                              <Tag tone="warn">{text("own.remote.add.forwards")}</Tag>
                            </Show>
                            <Show when={item.forwards === "maybe"}>
                              <Tag tone="dashed">{text("own.remote.add.forwardsMaybe")}</Tag>
                            </Show>
                            <Show when={item.localhostForward}>
                              <Tag tone="warn" title={text("own.remote.add.localhostForward")}>
                                localhost
                              </Tag>
                            </Show>
                            <Show when={item.looseHostKey}>
                              <Tag tone="danger" title={text("own.remote.hostKey.loose")}>
                                {text("own.remote.add.loose")}
                              </Tag>
                            </Show>
                          </label>
                        )}
                      </For>
                    </div>
                  </Show>
                )}
              </Show>
            </Show>
            <Show when={mode() === "manual"}>
              <TextField
                label={text("own.remote.add.target")}
                value={target()}
                onValue={setTarget}
                testid="remote-target"
                onEnter={() => void start()}
              />
              <TextField
                label={text("own.remote.add.name")}
                value={name()}
                onValue={setName}
                testid="remote-name"
                onEnter={() => void start()}
              />
            </Show>
            <Show when={problem()}>
              <Notice tone="danger" testid="remote-add-problem">
                {problem()}
              </Notice>
            </Show>
            <div class="flex justify-end gap-2">
              <button type="button" class="own-btn own-target" onClick={props.onClose}>
                {text("own.remote.add.cancel")}
              </button>
              <button
                type="button"
                class="own-btn own-target"
                data-variant="primary"
                data-testid="remote-add-check"
                disabled={busy() || (mode() === "config" ? !picked() : !target().trim())}
                onClick={() => void start()}
              >
                {text("own.remote.add.check")}
              </button>
            </div>
          </Match>

          <Match when={phase() === "connecting" || phase() === "installing"}>
            <p class="m-0 flex items-center gap-2 text-[13.5px] font-medium">
              <Spinner /> {host()?.name}
              <span class="text-own-muted">
                · {phase() === "installing" ? text("own.remote.install.running") : text("own.remote.add.check")}
              </span>
            </p>
            <ol class="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" data-testid="remote-steps">
              <For each={STEPS}>
                {(step) => (
                  <li
                    class="flex items-center gap-2"
                    classList={{ "text-own-faint": !reached(step) }}
                    data-step={step}
                    data-current={stage() === step}
                  >
                    <span aria-hidden="true" class="w-4 text-center">
                      {stage() === step ? "●" : reached(step) ? "✓" : "○"}
                    </span>
                    {text(`own.remote.step.${step}` as RemoteKey)}
                  </li>
                )}
              </For>
            </ol>
            <Show when={progress().length}>
              <ul
                class="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px] text-own-muted"
                data-testid="remote-progress"
              >
                <For each={progress()}>
                  {(item) => (
                    <li data-step={item.step} data-ok={item.ok === undefined ? undefined : String(item.ok)}>
                      {item.ok === false ? "✗" : "·"} {progressLabel(text, item.step)}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show
              when={stage() === "authentication" && host()?.owner.clientId && host()?.owner.clientId !== store.clientId}
            >
              <Notice tone="warn">{states("own.remote.elsewhere")}</Notice>
            </Show>
            <div class="flex justify-end">
              <button
                type="button"
                class="own-btn own-target"
                data-testid="remote-add-cancel"
                onClick={() => {
                  const id = hostId()
                  if (id && phase() === "connecting") void store.cancel(id).catch(() => undefined)
                  props.onClose()
                }}
              >
                {text("own.remote.add.cancel")}
              </button>
            </div>
          </Match>

          <Match when={phase() === "plan"}>
            <Show
              when={plan()}
              fallback={
                <p class="m-0 flex items-center gap-2 text-[13px]">
                  <Spinner /> {text("own.remote.op.planning")}
                </p>
              }
            >
              {(current) => (
                <div class="flex flex-col gap-2" data-testid="remote-install-plan">
                  <p class="m-0 text-[15px] font-semibold">{text("own.remote.install.title")}</p>
                  <p class="m-0 text-[13px]" data-testid="remote-install-dir">
                    {text("own.remote.install.noRoot", { dir: current().install.dir })}
                  </p>
                  <p class="m-0 text-[12.5px] text-own-muted">
                    {text("own.remote.install.platform", { target: current().platform.target })} ·{" "}
                    {text("own.remote.install.size", {
                      size: bytes(current().install.bytes),
                      need: bytes(current().install.needBytes),
                      free: current().install.freeBytes === null ? "?" : bytes(current().install.freeBytes!),
                    })}
                  </p>
                  <p class="m-0 text-[13px]" data-testid="remote-install-upstream">
                    {text("own.remote.install.upstream")}
                    <Show when={current().existing.upstreamOpencode}>
                      {" "}
                      — {text("own.remote.install.upstreamFound")}
                    </Show>
                  </p>
                  <details class="text-[12.5px]">
                    <summary class="cursor-pointer text-own-muted">{text("own.remote.install.writes")}</summary>
                    <ul class="own-mono m-0 mt-1 flex list-none flex-col gap-0.5 p-0 text-[12px]">
                      <For each={current().writes}>{(file) => <li>{file}</li>}</For>
                    </ul>
                  </details>
                  <div class="flex justify-end gap-2 pt-1">
                    <button type="button" class="own-btn own-target" onClick={props.onClose}>
                      {text("own.remote.add.cancel")}
                    </button>
                    <button
                      type="button"
                      class="own-btn own-target"
                      data-variant="primary"
                      data-testid="remote-install"
                      disabled={busy()}
                      onClick={() => void install()}
                    >
                      {text("own.remote.install.confirm")}
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </Match>

          <Match when={phase() === "done"}>
            <div class="flex flex-col gap-2" data-testid="remote-done">
              <p class="m-0 text-[15px] font-semibold">
                ✓ {text("own.remote.done.title")} · {host()?.name}
              </p>
              <Show
                when={probe()}
                fallback={<p class="m-0 text-[12.5px] text-own-muted">{text("own.remote.done.noProbe")}</p>}
              >
                {(result) => (
                  <div class="flex flex-col gap-1 text-[12.5px]" data-testid="remote-probe">
                    <span class="text-own-muted">{text("own.remote.done.tools")}</span>
                    <div class="flex flex-wrap gap-1">
                      <For each={Object.entries(result().found)}>
                        {([tool, found]) => <Tag tone={found ? "ok" : "dashed"}>{`${found ? "✓" : "✗"} ${tool}`}</Tag>}
                      </For>
                    </div>
                    <Show when={result().path}>
                      <span class="text-own-muted">{text("own.remote.done.path")}</span>
                      <code class="own-mono break-all text-[12px]">{result().path}</code>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={interactiveOnly().length}>
                <Notice tone="warn" testid="remote-shell-advice">
                  <p class="m-0">{text("own.remote.shellEnv.differs", { paths: interactiveOnly().join(", ") })}</p>
                  <button
                    type="button"
                    class="own-btn mt-2"
                    data-size="sm"
                    onClick={() =>
                      void store.update({ hostId: hostId()!, shellEnv: "login-interactive" }).catch(() => undefined)
                    }
                  >
                    {text("own.remote.shellEnv.write")}
                  </button>
                </Notice>
              </Show>
              <For each={warnings()}>
                {(warning) => (
                  <Notice tone="warn" testid="remote-warning">
                    {warningText(text, warning)}
                  </Notice>
                )}
              </For>
              <Show when={PROJECT_STATES.find((state) => state.value === host()?.projectConfig)}>
                {(current) => (
                  <div
                    class="flex flex-col gap-1 text-[12.5px] text-own-muted"
                    data-testid="remote-project-config"
                    data-state={current().value}
                  >
                    <p class="m-0 flex flex-wrap items-center gap-2">
                      {text("own.remote.projectConfig.current", { state: text(current().label) })}
                      <button
                        type="button"
                        class="own-link"
                        onClick={() => {
                          selectHostPanel(hostId())
                          props.onClose()
                          router.navigate({ name: "settings", section: "remote" })
                        }}
                      >
                        {text("own.remote.projectConfig.change")}
                      </button>
                    </p>
                    <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
                      <For each={PROJECT_STATES}>
                        {(state) => (
                          <li class={state.value === current().value ? undefined : "text-own-faint"}>
                            {text(state.help)}
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                )}
              </Show>
              <p class="m-0 text-[12px] text-own-faint">{text("own.remote.done.later")}</p>
              <div class="flex justify-end gap-2 pt-1">
                <button type="button" class="own-btn own-target" onClick={props.onClose}>
                  {text("own.remote.add.close")}
                </button>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-variant="primary"
                  data-testid="remote-open-folder"
                  onClick={() => openRemoteDialog({ kind: "picker", hostId: hostId()! })}
                >
                  {text("own.remote.done.openFolder")}
                </button>
              </div>
            </div>
          </Match>

          <Match when={phase() === "failed"}>
            <Notice tone="danger" testid="remote-add-failed">
              <p class="m-0 font-medium">{text("own.remote.add.failed")}</p>
              <Show when={errorText()}>
                <p class="m-0 mt-1 text-[12.5px]" data-testid="remote-add-error">
                  {errorText()}
                </p>
              </Show>
            </Notice>
            <div class="flex justify-end gap-2">
              <button type="button" class="own-btn own-target" onClick={props.onClose}>
                {text("own.remote.add.close")}
              </button>
              <Show when={stage() === "incompatible"}>
                <button
                  type="button"
                  class="own-btn own-target"
                  onClick={() => openRemoteDialog({ kind: "update", hostId: hostId()! })}
                >
                  {states("own.remote.action.update")}
                </button>
              </Show>
              <Show when={hostId()}>
                <button
                  type="button"
                  class="own-btn own-target"
                  data-variant="primary"
                  data-testid="remote-add-retry"
                  onClick={() => void connect(hostId()!)}
                >
                  {text("own.remote.add.retry")}
                </button>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}

const errorKeys = {
  input: 1,
  ssh_missing: 1,
  connection: 1,
  auth: 1,
  host_key: 1,
  host_identity_changed: 1,
  forwarding_disabled: 1,
  forward_conflict: 1,
  loopback_unavailable: 1,
  platform_unsupported: 1,
  noexec: 1,
  disk_full: 1,
  install_failed: 1,
  service_failed: 1,
  service_not_loopback: 1,
  service_unresponsive: 1,
  version_skew: 1,
  other_owner: 1,
  ops_pending: 1,
  broker_failed: 1,
} as const

const PROGRESS = new Set([
  "upload",
  "verify",
  "done",
  "draining",
  "stage",
  "stop",
  "start",
  "rollback",
  "failed",
  "timeout",
  "read",
])

export function progressLabel(text: ReturnType<typeof useRemoteText>, step: string) {
  return PROGRESS.has(step) ? text(`own.remote.progress.${step}` as RemoteKey) : step
}

const WARNINGS = new Set([
  "path_differs_interactive",
  "kill_user_processes",
  "loose_host_key",
  "clock_skew",
  "tmp_noexec",
  "upstream_opencode",
  "config_forward_localhost",
  "identity_unavailable",
  "loopback_fallback_port",
])

export function warningText(text: ReturnType<typeof useRemoteText>, warning: string) {
  return WARNINGS.has(warning) ? text(`own.remote.warning.${warning}` as RemoteKey) : warning
}

/** `agent.probe` output kept by own-remote (`diagnostics.probe`, untyped there). */
function probeOf(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined
  const found = "found" in value && typeof value.found === "object" && value.found !== null ? value.found : {}
  const path = "path" in value && typeof value.path === "string" ? value.path : ""
  return {
    found: Object.fromEntries(
      Object.entries(found).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    ),
    path,
  }
}

export function bytes(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)} KB`
  return `${value} B`
}
