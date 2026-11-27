// `다른 도구에서 가져오기…` of 설정 > MCP 서버 (03 §18.14, SM 2026-10-24), a lazy chunk of the page. own.accounts reads
// the other tools' MCP settings only now (`mcp.import.scan`: Codex `config.toml`, Claude Code `.claude.json` and the
// project's `.mcp.json`) and answers names of values only; the user picks servers, their names here and where they
// are used, and `mcp.import.apply` adds them with the values it read (the scan's nonce, once). The same server in
// several tools is one row (`also`); when its values differ there (`값이 달라요`, SM-22) the user picks whose to take
// (`place`); a server this app already has is `이미 있음` and not picked; a name a config file's server has here is
// warned about (this app's server replaces it). Nothing of the other tools' files changes.
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { errorType } from "@/accounts/errors"
import type { ServerRuntime } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { Dialog, Notice, Spinner, Tag } from "@/limits/kit"
import { baseName } from "@/projects/path"
import { NAME_PATTERN, secretsOf, transportLine, type FileServer } from "./manage-model"
import { errorText } from "./manage-parts"
import { useMcpManageText } from "./manage-strings"

export interface McpImportProps {
  readonly runtime: ServerRuntime
  readonly directory: string | undefined
  /** The page project's config file servers, whose names an imported server would replace. */
  readonly files: ReadonlyArray<FileServer>
  readonly onClose: () => void
  /** Called with how many servers were imported. */
  readonly onDone: (count: number) => void
}

type Scan = OwnOutput<"mcp.import.scan">
type Candidate = Scan["candidates"][number]

interface Choice {
  picked: boolean
  name: string
  scope: "global" | "project"
  /** Whose values to take: `0` the row's first place, `n` its `also[n - 1]`. */
  place: number
}

export default function McpImport(props: McpImportProps) {
  const text = useMcpManageText()
  const rpc = props.runtime.rpc
  const [scan, { refetch }] = createResource(() =>
    rpc.call("mcp.import.scan", props.directory ? { directory: props.directory } : {}),
  )
  const [choices, setChoices] = createStore<Record<string, Choice>>({})
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const importable = (item: Candidate) => item.transport !== undefined && item.problem === undefined
  const choiceOf = (item: Candidate): Choice =>
    choices[item.key] ?? {
      picked: importable(item) && item.enabled && !item.imported,
      name: item.suggested,
      scope: item.scope.type,
      place: 0,
    }
  const set = (item: Candidate, change: Partial<Choice>) => setChoices(item.key, { ...choiceOf(item), ...change })
  const candidates = () => scan.latest?.candidates ?? []
  const groups = createMemo(() =>
    (["codex", "claude-user", "claude-project", "project-file"] as const)
      .map((source) => ({ source, items: candidates().filter((item) => item.source === source) }))
      .filter((group) => group.items.length > 0),
  )
  const picked = () => candidates().filter((item) => importable(item) && choiceOf(item).picked)
  /** Picked names that are not valid or meet twice where both would run. */
  const clashing = createMemo(() => {
    const names = picked().map((item) => ({ key: item.key, name: choiceOf(item).name.trim().toLowerCase() }))
    return new Set(
      picked()
        .filter((item) => {
          const name = choiceOf(item).name.trim()
          if (!NAME_PATTERN.test(name)) return true
          return names.filter((other) => other.name === name.toLowerCase()).length > 1
        })
        .map((item) => item.key),
    )
  })

  async function apply() {
    const nonce = scan.latest?.nonce
    if (!nonce || busy() || picked().length === 0 || clashing().size > 0) return
    setBusy(true)
    setFailure(undefined)
    const result = await rpc
      .call("mcp.import.apply", {
        nonce,
        picks: picked().map((item) => {
          const choice = choiceOf(item)
          return {
            key: item.key,
            name: choice.name.trim(),
            scope:
              choice.scope === "project" && props.directory
                ? { type: "project" as const, directory: props.directory }
                : { type: "global" as const },
            ...(choice.place > 0 ? { place: choice.place } : {}),
          }
        }),
      })
      .catch((error: unknown) => {
        if (errorType(error) === "nonce_invalid") {
          setFailure(text("own.mcpm.import.expired"))
          void refetch()
          return undefined
        }
        setFailure(errorText(text, error, ""))
        return undefined
      })
    setBusy(false)
    if (result) props.onDone(result.imported.length)
  }

  return (
    <Dialog
      open
      size="wide"
      title={text("own.mcpm.import.title")}
      onClose={() => props.onClose()}
      testid="mcp-import"
      footer={
        <>
          <button type="button" class="own-btn" data-size="sm" onClick={() => props.onClose()}>
            {text("own.mcpm.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            disabled={busy() || picked().length === 0 || clashing().size > 0}
            data-testid="mcp-import-apply"
            onClick={() => void apply()}
          >
            {text("own.mcpm.import.apply", { n: picked().length })}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-testid="mcp-import-body">
        <p class="m-0 text-[12.5px] text-own-muted">{text("own.mcpm.import.lead")}</p>
        <Show
          when={!scan.loading || scan.latest}
          fallback={
            <p class="m-0 text-[12.5px]" role="status">
              <Spinner /> {text("own.mcpm.import.scanning")}
            </p>
          }
        >
          <Show when={!scan.error} fallback={<Notice tone="danger">{text("own.mcpm.import.failed")}</Notice>}>
            <Show
              when={groups().length > 0}
              fallback={
                <p class="m-0 text-[12.5px] text-own-muted" data-testid="mcp-import-none">
                  {text("own.mcpm.import.none")}
                </p>
              }
            >
              <p class="m-0 text-[12px] text-own-warn">{text("own.mcpm.import.trust")}</p>
              <For each={groups()}>
                {(group) => (
                  <section class="flex flex-col gap-1.5" data-testid="mcp-import-group" data-source={group.source}>
                    <b class="text-[13px] font-semibold">{text(`own.mcpm.import.source.${group.source}`)}</b>
                    <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
                      <For each={group.items}>
                        {(item) => (
                          <CandidateRow
                            item={item}
                            choice={choiceOf(item)}
                            importable={importable(item)}
                            clash={clashing().has(item.key)}
                            replaces={props.files.some((server) => server.name === choiceOf(item).name.trim())}
                            projectName={props.directory ? baseName(props.directory) : undefined}
                            onChange={(change) => set(item, change)}
                          />
                        )}
                      </For>
                    </ul>
                  </section>
                )}
              </For>
            </Show>
            <details class="text-[12px] text-own-muted" data-testid="mcp-import-files">
              <summary class="cursor-pointer select-none">{text("own.mcpm.import.files")}</summary>
              <ul class="m-0 mt-1 flex list-none flex-col gap-0.5 p-0">
                <For each={scan.latest?.files ?? []}>
                  {(file) => (
                    <li class="break-all">
                      {text(`own.mcpm.import.source.${file.source}`)} · <span class="own-mono">{file.path}</span> ·{" "}
                      {text(`own.mcpm.import.file.${file.state}`, { n: file.count })}
                    </li>
                  )}
                </For>
              </ul>
            </details>
          </Show>
        </Show>
        <Show when={failure()}>
          {(message) => (
            <Notice tone="danger" testid="mcp-import-failed">
              {message()}
            </Notice>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

function CandidateRow(props: {
  readonly item: Candidate
  readonly choice: Choice
  readonly importable: boolean
  readonly clash: boolean
  /** A config file's server here has the chosen name. */
  readonly replaces: boolean
  readonly projectName: string | undefined
  readonly onChange: (change: Partial<Choice>) => void
}) {
  const text = useMcpManageText()
  const summary = () => (props.item.transport ? transportLine(props.item.transport) : undefined)
  const where = (place: { readonly source: Candidate["source"]; readonly name: string }) =>
    place.name === props.item.name
      ? text(`own.mcpm.import.source.${place.source}`)
      : `${text(`own.mcpm.import.source.${place.source}`)} (${place.name})`
  const also = () => props.item.also.map(where).join(", ")
  const first = () => {
    const transport = props.item.transport
    if (!transport) return []
    return transport.type === "local" ? transport.env : transport.headers
  }
  const differs = () => props.item.also.some((place) => place.differs)
  /** Each place with the hints of its values (a place whose values are the first's has the first's). */
  const places = () => [
    { label: where(props.item), values: first() },
    ...props.item.also.map((place) => ({ label: where(place), values: place.values ?? first() })),
  ]
  const values = () => secretsOf(places()[props.choice.place]?.values ?? first())
  return (
    <li
      class="flex flex-col gap-1.5 px-3 py-2.5"
      data-testid="mcp-import-row"
      data-name={props.item.name}
      data-importable={props.importable ? "" : undefined}
    >
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex min-w-0 flex-1 items-center gap-2">
          <input
            type="checkbox"
            checked={props.importable && props.choice.picked}
            disabled={!props.importable}
            aria-label={text("own.mcpm.import.pick", { name: props.item.name })}
            data-testid="mcp-import-pick"
            onChange={(event) => props.onChange({ picked: event.currentTarget.checked })}
          />
          <span class="own-mono truncate text-[13px]">{props.item.name}</span>
        </label>
        <Show when={props.item.imported}>
          <Tag tone="plain" testid="mcp-import-imported">
            {text("own.mcpm.import.imported")}
          </Tag>
        </Show>
        <Show when={differs()}>
          <Tag tone="warn" testid="mcp-import-differs">
            {text("own.mcpm.import.differs")}
          </Tag>
        </Show>
        <Show when={props.item.problem}>
          {(problem) => <Tag tone="warn">{text(`own.mcpm.import.problem.${problem()}`)}</Tag>}
        </Show>
      </div>
      <Show when={summary()}>
        <code class="own-mono break-all text-[11.5px]" data-testid="mcp-import-summary">
          {summary()}
        </code>
      </Show>
      <Show when={props.item.also.length > 0}>
        <span class="text-[12px] text-own-muted wrap-anywhere" data-testid="mcp-import-also">
          {text("own.mcpm.import.also", { places: also() })}
        </span>
      </Show>
      <Show when={values().length > 0}>
        <span class="own-mono break-all text-[11.5px] text-own-muted" data-testid="mcp-import-values">
          {text("own.mcpm.import.values", { n: values().length, names: values().join(", ") })}
        </span>
      </Show>
      <Show when={props.item.notes.length > 0}>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px] text-own-muted">
          <For each={props.item.notes}>{(note) => <li>{text(`own.mcpm.import.note.${note}`)}</li>}</For>
        </ul>
      </Show>
      <Show when={props.importable && props.choice.picked}>
        <div class="flex flex-wrap items-center gap-2 text-[12.5px]">
          <label class="flex items-center gap-1.5">
            <span class="whitespace-nowrap text-own-muted">{text("own.mcpm.import.as")}</span>
            <input
              class="own-input own-mono h-7 w-44"
              value={props.choice.name}
              spellcheck={false}
              autocomplete="off"
              aria-invalid={props.clash ? true : undefined}
              data-testid="mcp-import-name"
              onInput={(event) => props.onChange({ name: event.currentTarget.value })}
            />
          </label>
          <select
            class="own-input h-7 w-auto"
            value={props.choice.scope}
            aria-label={text("own.mcpm.editor.scope")}
            data-testid="mcp-import-scope"
            onChange={(event) =>
              props.onChange({ scope: event.currentTarget.value === "project" ? "project" : "global" })
            }
          >
            <option value="global">{text("own.mcpm.editor.scope.global")}</option>
            <Show when={props.projectName}>
              {(name) => (
                <option value="project">
                  {text("own.mcpm.editor.scope.project")} ({name()})
                </option>
              )}
            </Show>
          </select>
          <Show when={props.clash}>
            <span class="text-own-danger" role="alert">
              {text("own.mcpm.import.nameProblem")}
            </span>
          </Show>
        </div>
        <Show when={differs()}>
          <label class="flex min-w-0 flex-col gap-1 text-[12.5px]">
            <span class="text-own-muted">{text("own.mcpm.import.place")}</span>
            <select
              class="own-input h-7 w-full min-w-0"
              value={String(props.choice.place)}
              data-testid="mcp-import-place"
              onChange={(event) => props.onChange({ place: Number(event.currentTarget.value) })}
            >
              <For each={places()}>
                {(place, index) => (
                  <option value={String(index())}>
                    {[place.label, secretsOf(place.values).join(", ")].filter(Boolean).join(" · ")}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <Show when={props.replaces}>
          <Notice tone="warn" testid="mcp-import-clash">
            {text("own.mcpm.import.fileClash", { name: props.choice.name.trim() })}
          </Notice>
        </Show>
      </Show>
    </li>
  )
}
