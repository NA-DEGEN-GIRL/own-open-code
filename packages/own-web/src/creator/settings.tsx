// 설정 > 확장 (17 §8.1), lazy with the settings page: the extensions creator mode made (own.creator `list`), each with
// what it does and its cache effect, its problems, the on/off switch, its project folders (`scope.set`), the approval
// of its allow rules (`loosen.set`, the only way they turn on), its versions with `이 판으로 되돌리기` (`rollback`) and
// a version's file (`version.get`), and `지우기` with a confirm. C2 servers have 멈추기/다시 시작 (`mcp.stop`,
// `mcp.start`) and their log (`log.get`); C3 code plugins sit behind the page's switch (`plugins.set`, off by default,
// with the risk spelled out), and each version waits for `이 판 승인` (`trust.set`); a plugin that threw in a folder is
// listed there with `다시 켜기` (`crashes.clear`). Each card's SSH hosts (17 §10, hosts.tsx): which hosts have it, the
// host selection, host folders, and a code plugin's per-host allowance. Writes are `local` methods: this PC's windows only. Another window's
// or creator mode's change arrives as `rpc.own.ext.changed` and reloads the list.
import { createResource, createSignal, For, Index, onCleanup, Show } from "solid-js"
import { creatorChanged, creatorRpcOf, type CreatorInput, type CreatorOutput } from "@/data/creator-rpc"
import { useData } from "@/data"
import { createStatus, StatusLine, Tag, TextField } from "@/limits/kit"
import { isAbsolutePath, normalizeInput } from "@/projects/path"
import { ToggleSwitch } from "@/shell/switch"
import {
  cacheKey,
  failure,
  globalOnly,
  kindKey,
  STATUS,
  TONE,
  trustState,
  typeKey,
  versions,
  when,
  withFolder,
  withoutFolder,
  type View,
} from "./model"
import { ExtensionHosts } from "./hosts"
import { useCreatorText } from "./strings"

export default function CreatorSettings() {
  const runtime = useData().local()
  const rpc = creatorRpcOf(runtime)
  const text = useCreatorText()
  const status = createStatus()
  const [busy, setBusy] = createSignal(false)
  const [list, { mutate, refetch }] = createResource(() => rpc.call("list", {}))
  const editable = () => rpc.allowed("enabled.set")
  onCleanup(
    runtime.bus.listen((event) => {
      if (event.type === "server.connected" || creatorChanged(event)) void refetch()
    }),
  )

  async function write(run: () => Promise<List>, done: string) {
    setBusy(true)
    status.clear()
    const result = await run().catch((error: unknown) => {
      const failed = failure(error)
      status.error(text(failed.key, { problems: failed.problems ?? "" }))
      return undefined
    })
    setBusy(false)
    if (!result) return false
    mutate(result)
    status.ok(done)
    return true
  }

  return (
    <div class="flex flex-col gap-3" data-testid="settings-creator">
      <p class="m-0 text-[12.5px] text-own-muted">{text("own.ext.lead")}</p>
      <Show
        when={!list.error}
        fallback={
          <div class="flex items-center gap-2">
            <p class="own-placeholder m-0 px-0" data-testid="settings-creator-unavailable">
              {text("own.ext.unavailable")}
            </p>
            <button type="button" class="own-btn" data-size="sm" onClick={() => void refetch()}>
              {text("own.ext.retry")}
            </button>
          </div>
        }
      >
        <Show when={list()} fallback={<p class="own-placeholder px-0">{text("own.ext.loading")}</p>}>
          {(loaded) => (
            <>
              <p class="m-0 text-[12px] text-own-muted">
                {text("own.ext.folder")} <span class="font-mono">{loaded().root}</span>
              </p>
              <Show when={!editable()}>
                <p class="m-0 text-[12.5px] text-own-muted">{text("own.ext.deviceOnly")}</p>
              </Show>
              <div
                class="flex flex-col gap-1 rounded-lg border border-own-border px-3 py-2.5"
                data-testid="settings-creator-plugins"
              >
                <div class="flex items-center gap-2">
                  <b class="text-[13px] font-semibold">{text("own.ext.plugins.title")}</b>
                  <span class="flex-1" />
                  <Show when={editable()}>
                    <ToggleSwitch
                      checked={loaded().settings.plugins}
                      label={text("own.ext.plugins.label")}
                      testid="settings-creator-plugins-switch"
                      onChange={(enabled) =>
                        void write(
                          () => rpc.call("plugins.set", { enabled }),
                          text(enabled ? "own.ext.done.plugins.on" : "own.ext.done.plugins.off"),
                        )
                      }
                    />
                  </Show>
                </div>
                <p class="m-0 text-[12.5px] text-own-warn" data-testid="settings-creator-plugins-risk">
                  {text("own.ext.plugins.risk")}
                </p>
                <Show when={!loaded().settings.plugins}>
                  <p class="m-0 text-[12px] text-own-muted">{text("own.ext.plugins.off")}</p>
                </Show>
              </div>
              <Show
                when={loaded().extensions.length > 0}
                fallback={
                  <p class="own-placeholder px-0" data-testid="settings-creator-empty">
                    {text("own.ext.empty")}
                  </p>
                }
              >
                <ul class="m-0 flex list-none flex-col gap-3 p-0">
                  <Index each={loaded().extensions}>
                    {(view) => (
                      <Extension
                        view={view()}
                        stopped={loaded().stopped.includes(view().id)}
                        hosts={loaded().hosts}
                        busy={busy()}
                        editable={editable()}
                        write={write}
                        rpc={rpc}
                      />
                    )}
                  </Index>
                </ul>
              </Show>
            </>
          )}
        </Show>
      </Show>
      <StatusLine status={status} testid="settings-creator-status" />
    </div>
  )
}

type Rpc = ReturnType<typeof creatorRpcOf>
type List = CreatorOutput<"list">
/** The writes; each answers the new list. */
type WriteMethod =
  | "enabled.set"
  | "rollback"
  | "remove"
  | "scope.set"
  | "hosts.set"
  | "hostTrust.set"
  | "loosen.set"
  | "trust.set"
  | "mcp.stop"
  | "mcp.start"
  | "crashes.clear"

function Extension(props: {
  readonly view: View
  readonly stopped: boolean
  readonly hosts: List["hosts"]
  readonly busy: boolean
  readonly editable: boolean
  readonly write: (run: () => Promise<List>, done: string) => Promise<boolean>
  readonly rpc: Rpc
}) {
  const text = useCreatorText()
  const [folder, setFolder] = createSignal("")
  const [folderProblem, setFolderProblem] = createSignal<string>()
  const [confirming, setConfirming] = createSignal(false)
  const [shown, setShown] = createSignal<number>()
  const [file] = createResource(shown, (n) =>
    props.rpc
      .call("version.get", { id: props.view.id, version: n })
      .then((detail) => JSON.stringify(detail.extension, null, 2)),
  )
  const [logShown, setLogShown] = createSignal(false)
  const [log, { refetch: refetchLog }] = createResource(logShown, (shownNow) =>
    shownNow ? props.rpc.call("log.get", { id: props.view.id }).then((answer) => answer.lines) : Promise.resolve([]),
  )
  const title = () => props.view.title
  const trust = () => trustState(props.view)
  const call = <M extends WriteMethod>(method: M, input: CreatorInput<M>, done: string) =>
    // SAFETY: every write method's output is the list (OwnCreator.Definition).
    props.write(() => props.rpc.call(method, input) as Promise<List>, done)

  function addFolder() {
    const value = normalizeInput(folder())
    if (!value || !isAbsolutePath(value)) return setFolderProblem(text("own.ext.scope.relative"))
    setFolderProblem(undefined)
    void call(
      "scope.set",
      { id: props.view.id, projects: withFolder(props.view.projects, value) },
      text("own.ext.done.scope", { title: title() }),
    ).then((done) => done && setFolder(""))
  }

  return (
    <li
      class="flex flex-col gap-2 rounded-lg border border-own-border px-3 py-2.5"
      data-testid="creator-extension"
      data-id={props.view.id}
      data-status={props.view.status}
    >
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <b class="text-[13.5px] font-semibold">{props.view.title}</b>
        <span class="font-mono text-[12px] text-own-muted">{props.view.id}</span>
        <Tag tone={TONE[props.view.status]} testid="creator-extension-status">
          {text(STATUS[props.view.status])}
        </Tag>
        <Tag tone="plain">{text("own.ext.version", { n: props.view.active })}</Tag>
        <Show when={props.view.kind !== "declarative"}>
          <Tag tone="accent" testid="creator-extension-kind">
            {text(kindKey(props.view.kind))}
          </Tag>
        </Show>
        <span class="flex-1" />
        <Show when={props.editable}>
          <ToggleSwitch
            checked={props.view.enabled}
            label={text("own.ext.enabled")}
            testid="creator-extension-enabled"
            onChange={(enabled) =>
              void call(
                "enabled.set",
                { id: props.view.id, enabled },
                text(enabled ? "own.ext.done.enabled" : "own.ext.done.disabled", { title: title() }),
              )
            }
          />
        </Show>
      </div>
      <Show when={props.view.description}>
        <p class="m-0 text-[12.5px]">{props.view.description}</p>
      </Show>
      <Show when={props.view.effects.length > 0}>
        <div>
          <span class="text-[12px] font-semibold text-own-muted">{text("own.ext.effects")}</span>
          <ul class="m-0 list-none p-0" data-testid="creator-extension-effects">
            <For each={props.view.effects}>
              {(effect) => (
                <li class="text-[12.5px]" data-type={effect.type}>
                  {text(typeKey(effect.type))} <span class="font-mono">{effect.name}</span>{" "}
                  <span class="text-own-muted">· {text(cacheKey(effect.cache))}</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={props.view.problems.length > 0}>
        <div role="alert" data-testid="creator-extension-problems">
          <span class="text-[12px] font-semibold text-own-danger">{text("own.ext.problems")}</span>
          <ul class="m-0 list-none p-0">
            <For each={props.view.problems}>
              {(problem) => (
                <li class="text-[12.5px]">
                  <Show when={problem.path}>
                    <span class="font-mono">{problem.path}</span>{" "}
                  </Show>
                  {problem.message}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={props.view.kind === "mcp"}>
        <div class="flex flex-wrap items-center gap-2" data-testid="creator-extension-server">
          <span class="text-[12.5px]">
            {text(props.stopped ? "own.ext.server.stopped" : "own.ext.server.process")}
          </span>
          <Show when={props.editable}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              disabled={props.busy}
              data-testid="creator-extension-server-button"
              onClick={() =>
                void call(
                  props.stopped ? "mcp.start" : "mcp.stop",
                  { id: props.view.id },
                  text(props.stopped ? "own.ext.done.start" : "own.ext.done.stop", { title: title() }),
                ).then(() => logShown() && void refetchLog())
              }
            >
              {text(props.stopped ? "own.ext.server.start" : "own.ext.server.stop")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={trust()}>
        {(state) => (
          <div class="flex flex-wrap items-center gap-2" data-testid="creator-extension-trust">
            <span class="text-[12.5px]" classList={{ "text-own-warn": state() === "pending" }}>
              {text(state() === "pending" ? "own.ext.trust.pending" : "own.ext.trust.trusted")}
            </span>
            <Show when={props.editable}>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                disabled={props.busy}
                data-testid="creator-extension-trust-button"
                onClick={() =>
                  void call(
                    "trust.set",
                    { id: props.view.id, version: props.view.active, trusted: state() === "pending" },
                    text("own.ext.done.trust", { title: title(), n: props.view.active }),
                  )
                }
              >
                {text(state() === "pending" ? "own.ext.trust.approve" : "own.ext.trust.revoke")}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={props.view.crashes.length > 0}>
        <div role="alert" data-testid="creator-extension-crashes">
          <span class="text-[12px] font-semibold text-own-danger">{text("own.ext.crashes")}</span>
          <ul class="m-0 list-none p-0">
            <For each={props.view.crashes}>
              {(crash) => (
                <li class="text-[12.5px]">
                  <span class="font-mono">{crash.directory}</span> · {text("own.ext.version", { n: crash.version })} ·{" "}
                  {crash.hook}: {crash.message}
                </li>
              )}
            </For>
          </ul>
          <Show when={props.editable}>
            <button
              type="button"
              class="own-btn mt-1"
              data-size="sm"
              disabled={props.busy}
              data-testid="creator-extension-crashes-clear"
              onClick={() =>
                void call("crashes.clear", { id: props.view.id }, text("own.ext.done.crashes", { title: title() }))
              }
            >
              {text("own.ext.crashes.clear")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.view.effects.some((effect) => effect.loosens)}>
        <div class="flex flex-wrap items-center gap-2" data-testid="creator-extension-loosen">
          <span class="text-[12.5px]" classList={{ "text-own-warn": props.view.loosenPending }}>
            {text(props.view.loosenPending ? "own.ext.loosen.pending" : "own.ext.loosen.approved")}
          </span>
          <Show when={props.editable}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              disabled={props.busy}
              data-testid="creator-extension-loosen-button"
              onClick={() =>
                void call(
                  "loosen.set",
                  { id: props.view.id, version: props.view.active, approved: props.view.loosenPending },
                  text("own.ext.done.loosen", { title: title() }),
                )
              }
            >
              {text(props.view.loosenPending ? "own.ext.loosen.approve" : "own.ext.loosen.revoke")}
            </button>
          </Show>
        </div>
      </Show>
      <div class="flex flex-col gap-1" data-testid="creator-extension-scope">
        <span class="text-[12px] font-semibold text-own-muted">{text("own.ext.scope")}</span>
        <Show
          when={props.view.projects.length > 0}
          fallback={<span class="text-[12.5px]">{text("own.ext.scope.all")}</span>}
        >
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <For each={props.view.projects}>
              {(project) => (
                <li class="flex items-center gap-2" data-testid="creator-extension-project">
                  <span class="min-w-0 flex-1 truncate font-mono text-[12px]" title={project}>
                    {project}
                  </span>
                  <Show when={props.editable}>
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      disabled={props.busy}
                      onClick={() =>
                        void call(
                          "scope.set",
                          { id: props.view.id, projects: withoutFolder(props.view.projects, project) },
                          text("own.ext.done.scope", { title: title() }),
                        )
                      }
                    >
                      {text("own.ext.scope.remove")}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={props.editable && globalOnly(props.view)}>
          <span class="text-[12px] text-own-muted">{text("own.ext.scope.globalOnly")}</span>
        </Show>
        <Show when={props.editable && !globalOnly(props.view)}>
          <div class="flex flex-wrap items-end gap-2">
            <div class="min-w-[240px] flex-1">
              <TextField
                label={text("own.ext.scope.folder")}
                value={folder()}
                onValue={setFolder}
                onEnter={addFolder}
                error={folderProblem()}
                spellcheck={false}
                autocomplete="off"
                testid="creator-extension-folder"
              />
            </div>
            <button
              type="button"
              class="own-btn"
              disabled={props.busy || !folder().trim()}
              data-testid="creator-extension-folder-add"
              onClick={addFolder}
            >
              {text("own.ext.scope.add")}
            </button>
            <Show when={props.view.projects.length > 0}>
              <button
                type="button"
                class="own-btn"
                disabled={props.busy}
                data-testid="creator-extension-scope-reset"
                onClick={() =>
                  void call(
                    "scope.set",
                    { id: props.view.id, projects: [] },
                    text("own.ext.done.scope", { title: title() }),
                  )
                }
              >
                {text("own.ext.scope.reset")}
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <ExtensionHosts
        view={props.view}
        hosts={props.hosts}
        busy={props.busy}
        editable={props.editable}
        call={call}
      />
      <Show when={props.view.kind !== "declarative"}>
        <div class="flex flex-col gap-1" data-testid="creator-extension-log">
          <div>
            <button type="button" class="own-btn" data-size="sm" onClick={() => setLogShown(!logShown())}>
              {text(logShown() ? "own.ext.log.hide" : "own.ext.log.show")}
            </button>
          </div>
          <Show when={logShown()}>
            <pre
              class="m-0 max-h-[240px] overflow-auto rounded border border-own-border p-2 text-[11.5px]"
              data-testid="creator-extension-log-lines"
            >
              {(log() ?? []).length === 0 ? text("own.ext.log.empty") : (log() ?? []).join("\n")}
            </pre>
          </Show>
        </div>
      </Show>
      <details data-testid="creator-extension-history">
        <summary class="cursor-pointer text-[12px] font-semibold text-own-muted">
          {text("own.ext.history")} ({props.view.versions.length})
        </summary>
        <ul class="m-0 mt-1 flex list-none flex-col gap-1 p-0">
          <For each={versions(props.view)}>
            {(version) => (
              <li class="flex flex-col gap-1" data-testid="creator-extension-version" data-n={version.n}>
                <div class="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <b>{text("own.ext.version", { n: version.n })}</b>
                  <span class="text-own-muted">{when(version.createdAt)}</span>
                  <span class="text-own-muted">
                    {text(version.by === "model" ? "own.ext.history.by.model" : "own.ext.history.by.user")}
                  </span>
                  <Show when={version.note}>
                    <span>{version.note}</span>
                  </Show>
                  <Show when={version.current}>
                    <Tag tone="accent">{text("own.ext.history.current")}</Tag>
                  </Show>
                  <span class="flex-1" />
                  <button
                    type="button"
                    class="own-btn"
                    data-size="sm"
                    onClick={() => setShown(shown() === version.n ? undefined : version.n)}
                  >
                    {text(shown() === version.n ? "own.ext.history.hide" : "own.ext.history.view")}
                  </button>
                  <Show when={props.editable && !version.current}>
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      disabled={props.busy}
                      data-testid="creator-extension-rollback"
                      onClick={() =>
                        void call(
                          "rollback",
                          { id: props.view.id, version: version.n },
                          text("own.ext.done.rollback", { title: title(), n: version.n }),
                        )
                      }
                    >
                      {text("own.ext.history.rollback")}
                    </button>
                  </Show>
                </div>
                <Show when={shown() === version.n && file()}>
                  <pre class="m-0 max-h-[320px] overflow-auto rounded border border-own-border p-2 text-[11.5px]">
                    {file()}
                  </pre>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </details>
      <Show when={props.editable}>
        <div class="flex items-center gap-2">
          <Show
            when={confirming()}
            fallback={
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                disabled={props.busy}
                data-testid="creator-extension-remove"
                onClick={() => setConfirming(true)}
              >
                {text("own.ext.remove")}
              </button>
            }
          >
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="danger"
              disabled={props.busy}
              data-testid="creator-extension-remove-confirm"
              onClick={() =>
                void call("remove", { id: props.view.id }, text("own.ext.done.removed", { title: title() }))
              }
            >
              {text("own.ext.remove.confirm")}
            </button>
            <button type="button" class="own-btn" data-size="sm" onClick={() => setConfirming(false)}>
              {text("own.ext.remove.cancel")}
            </button>
          </Show>
        </div>
      </Show>
    </li>
  )
}
