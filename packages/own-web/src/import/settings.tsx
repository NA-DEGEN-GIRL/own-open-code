// 설정 > 다른 도구 (09 §2.1, §6), lazy with the settings page. The roots own.import reads (`sources.list`: the default
// Codex and Claude Code folders and the added ones, each with its problem and the conversations found), `찾을 곳
// 더하기` and removing an added root (`sources.configure`, a `local` method: only this PC's windows), and the
// per-viewer `사이드바에 보이기`. own.import checks every folder (09 §2.1) and answers the new list; the page never
// reads or writes another tool's files itself.
import { createResource, createSignal, For, Show } from "solid-js"
import { OwnRpcError, useData, type ImportKind, type ImportOutput } from "@/data"
import { useHost } from "@/host"
import { createStatus, Segmented, StatusLine, Tag, TextField } from "@/limits/kit"
import { isAbsolutePath, normalizeInput, samePath } from "@/projects/path"
import { Setting } from "@/settings/sections"
import { ToggleSwitch } from "@/shell/switch"
import { TOOL_NAME } from "./model"
import { importGates, importSidebarShown, importStore, setImportSidebarShown } from "./store"
import { useImportText, type ImportKey } from "./strings"

/** `sources.configure` takes at most this many added roots (09 §5.2). */
const MAX_ADDED = 32

type Root = ImportOutput<"sources.list">["roots"][number]

const ROOT_PROBLEM = {
  missing: "own.otherTools.set.rootProblem.missing",
  unreadable: "own.otherTools.set.rootProblem.unreadable",
  path_denied: "own.otherTools.set.rootProblem.path_denied",
} as const satisfies Record<NonNullable<Root["problem"]>, ImportKey>

export default function ImportSettings() {
  const data = useData()
  const host = useHost()
  const text = useImportText()
  const runtime = data.local()
  const store = importStore(runtime)
  const [health] = createResource(() => store.ensure())
  const gates = () => importGates(health(), runtime.imports.allowed)
  const [roots, { mutate }] = createResource(
    () => (gates().roots ? true : undefined),
    () => runtime.imports.call("sources.list", {}).then((output) => output.roots),
  )
  const [kind, setKind] = createSignal<ImportKind>("codex")
  const [folder, setFolder] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const added = () => (roots() ?? []).filter((root) => root.added)
  const canPick = () => host.capabilities.nativeDirectoryPicker && !!host.files?.pickDirectory

  async function configure(extraRoots: readonly { readonly kind: ImportKind; readonly directory: string }[]) {
    setBusy(true)
    status.clear()
    const result = await runtime.imports.call("sources.configure", { extraRoots: [...extraRoots] }).then(
      (output) => output.roots,
      (error: unknown) => {
        status.error(text("own.otherTools.set.failed", { reason: reason(error) }))
        return undefined
      },
    )
    setBusy(false)
    if (!result) return false
    mutate(result)
    status.ok(text("own.otherTools.set.addDone"))
    return true
  }

  function add() {
    const directory = normalizeInput(folder())
    const problem = addProblem(directory)
    if (problem) return status.error(problem)
    void configure([...current(), { kind: kind(), directory }]).then((done) => {
      if (done) setFolder("")
    })
  }

  function addProblem(directory: string) {
    if (!directory || !isAbsolutePath(directory)) return text("own.otherTools.set.relative")
    if ((roots() ?? []).some((root) => root.kind === kind() && samePath(root.directory, directory)))
      return text("own.otherTools.set.duplicate")
    if (added().length >= MAX_ADDED) return text("own.otherTools.set.full", { n: MAX_ADDED })
    return undefined
  }

  const current = () => added().map((root) => ({ kind: root.kind, directory: root.directory }))

  async function pick() {
    const chosen = await host.files?.pickDirectory?.().catch(() => null)
    if (chosen) setFolder(chosen)
  }

  function reason(error: unknown) {
    if (error instanceof OwnRpcError && error.type === "own.scope_denied") return text("own.otherTools.error.scope")
    return text("own.otherTools.error.other")
  }

  return (
    <div class="flex flex-col" data-testid="settings-import">
      <Show
        when={health.state === "ready"}
        fallback={<p class="own-placeholder px-0">{text("own.otherTools.checking")}</p>}
      >
        <Show
          when={gates().roots}
          fallback={
            <p class="own-placeholder px-0" data-testid="settings-import-unavailable">
              {health() ? text("own.otherTools.deviceOnly") : text("own.otherTools.unavailable")}
            </p>
          }
        >
          <section class="border-b border-own-border py-3" data-testid="settings-import-roots">
            <b class="block text-[13.5px] font-semibold">{text("own.otherTools.set.roots")}</b>
            <span class="text-[12px] text-own-muted">{text("own.otherTools.set.rootsNote")}</span>
            <ul class="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
              <For each={roots() ?? []}>
                {(root) => (
                  <li
                    class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-own-border px-3 py-2"
                    data-testid="settings-import-root"
                    data-available={root.available ? "" : undefined}
                  >
                    <span class="flex-none text-[12.5px] font-semibold">{TOOL_NAME[root.kind]}</span>
                    <span class="min-w-0 flex-1 truncate font-mono text-[12px]" title={root.directory}>
                      {root.directory}
                    </span>
                    <Tag tone="plain">
                      {text(root.added ? "own.otherTools.set.added" : "own.otherTools.set.default")}
                    </Tag>
                    <Show
                      when={root.problem}
                      fallback={
                        <span class="text-[12px] text-own-muted">
                          {root.sessions === undefined
                            ? text("own.otherTools.set.notScanned")
                            : text("own.otherTools.set.sessions", { n: root.sessions })}
                        </span>
                      }
                    >
                      {(problem) => (
                        <Tag tone="warn" testid="settings-import-root-problem">
                          {text(ROOT_PROBLEM[problem()])}
                        </Tag>
                      )}
                    </Show>
                    <Show when={root.added && gates().configure}>
                      <button
                        type="button"
                        class="own-btn"
                        data-size="sm"
                        disabled={busy()}
                        title={text("own.otherTools.set.removeTitle", { folder: root.directory })}
                        data-testid="settings-import-remove"
                        onClick={() =>
                          void configure(
                            current().filter(
                              (item) => !(item.kind === root.kind && samePath(item.directory, root.directory)),
                            ),
                          )
                        }
                      >
                        {text("own.otherTools.set.remove")}
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
          <Show
            when={gates().configure}
            fallback={<p class="m-0 py-3 text-[12.5px] text-own-muted">{text("own.otherTools.set.localOnly")}</p>}
          >
            <section class="flex flex-col gap-2 border-b border-own-border py-3" data-testid="settings-import-add">
              <div>
                <b class="block text-[13.5px] font-semibold">{text("own.otherTools.set.add")}</b>
                <span class="text-[12px] text-own-muted">{text("own.otherTools.set.addNote")}</span>
              </div>
              <Segmented
                label={text("own.otherTools.set.kind")}
                value={kind()}
                options={(["codex", "claude-code"] as const).map((value) => ({ value, label: TOOL_NAME[value] }))}
                onChange={setKind}
                testid="settings-import-kind"
              />
              <div class="flex flex-wrap items-end gap-2">
                <div class="min-w-[240px] flex-1">
                  <TextField
                    label={text("own.otherTools.set.folder")}
                    value={folder()}
                    onValue={setFolder}
                    onEnter={add}
                    spellcheck={false}
                    autocomplete="off"
                    testid="settings-import-folder"
                  />
                </div>
                <Show when={canPick()}>
                  <button type="button" class="own-btn" disabled={busy()} onClick={() => void pick()}>
                    {text("own.otherTools.set.pick")}
                  </button>
                </Show>
                <button
                  type="button"
                  class="own-btn"
                  data-variant="primary"
                  disabled={busy() || !folder().trim()}
                  data-testid="settings-import-add-button"
                  onClick={add}
                >
                  {text("own.otherTools.set.addButton")}
                </button>
              </div>
              <StatusLine status={status} testid="settings-import-status" />
            </section>
          </Show>
        </Show>
      </Show>
      <Setting title={text("own.otherTools.set.sidebar")} note={text("own.otherTools.set.sidebarNote")}>
        <ToggleSwitch
          checked={importSidebarShown()}
          label={text("own.otherTools.set.sidebar")}
          testid="settings-import-sidebar"
          onChange={setImportSidebarShown}
        />
      </Setting>
    </div>
  )
}
