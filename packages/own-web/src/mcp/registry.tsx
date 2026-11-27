// `찾아서 설치…` of 설정 > MCP 서버 (03 §18.14, SM 2026-10-24), a lazy chunk of the page: the official MCP Registry,
// asked by own.accounts on this PC (`mcp.registry.search`, `local`). A search by name shows each server's title,
// publisher, version and links; its details show each way to install it (an npm, PyPI or OCI package, or a remote
// address) with the exact command this PC would run or the address it connects to, and the values and headers it
// asks for. `추가 양식에 채우기` fills the add form (./editor) with the chosen way; nothing is installed, saved or run
// here, and `연결 시험` there runs only on a click. Every entry is someone else's code, which the dialog says first.
// Its text is someone else's too: every value wraps anywhere (`wrap-anywhere`), so no field widens the dialog at any
// window width (SM-22), and a version the entry does not give is not shown.
import { createSignal, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { errorData, errorType } from "@/accounts/errors"
import type { ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Spinner, Tag, TextField } from "@/limits/kit"
import type { OwnMcp } from "@own/protocol"
import { commandLine, registryForm, type Form } from "./manage-model"
import { useMcpManageText } from "./manage-strings"

export interface McpRegistryProps {
  readonly runtime: ServerRuntime
  readonly onClose: () => void
  /** The add form of the chosen way to install a server. */
  readonly onPick: (form: Form) => void
}

type Entry = OwnMcp.RegistryEntry
type Option = OwnMcp.RegistryOption

interface State {
  phase: "searching" | "done" | "failed"
  entries: Entry[]
  next?: string
  registry?: string
  failure?: string
  /** A page after the first is being read. */
  more: boolean
}

export default function McpRegistry(props: McpRegistryProps) {
  const text = useMcpManageText()
  const i18n = useI18n()
  const [query, setQuery] = createSignal("")
  const [state, setState] = createStore<State>({ phase: "searching", entries: [], more: false })
  const [open, setOpen] = createSignal<string>()
  const [chosen, setChosen] = createStore<Record<string, number>>({})
  const asked = { query: "", token: 0 }

  async function search(more = false) {
    const token = ++asked.token
    if (!more) asked.query = query().trim()
    setState(more ? { more: true } : { phase: "searching", entries: [], next: undefined, failure: undefined })
    const page = await props.runtime.rpc
      .call("mcp.registry.search", {
        ...(asked.query ? { query: asked.query } : {}),
        ...(more && state.next ? { cursor: state.next } : {}),
      })
      .catch((error: unknown) => {
        if (token === asked.token) setState({ phase: "failed", failure: failureText(error), more: false })
        return undefined
      })
    if (page === undefined || token !== asked.token) return
    setState({
      phase: "done",
      entries: more ? [...state.entries, ...page.entries] : [...page.entries],
      next: page.nextCursor,
      registry: page.registry,
      more: false,
    })
  }

  function failureText(error: unknown) {
    if (errorType(error) !== "mcp_registry_unavailable")
      return text("own.mcpm.reg.failed.other", { message: error instanceof Error ? error.message : String(error) })
    const data = errorData<{ reason?: "offline" | "status" | "invalid" | "disabled"; status?: number }>(error)
    return text(`own.mcpm.reg.failed.${data.reason ?? "offline"}`, { status: data.status ?? "" })
  }

  onMount(() => void search())

  return (
    <Dialog
      open
      size="wide"
      title={text("own.mcpm.reg.title")}
      onClose={() => props.onClose()}
      testid="mcp-registry"
      footer={
        <>
          <Show when={state.registry}>
            {(registry) => (
              <span class="text-[12px] text-own-faint" data-testid="mcp-registry-source">
                {text("own.mcpm.reg.from", { registry: new URL(registry()).host })}
              </span>
            )}
          </Show>
          <span class="flex-1" />
          <button type="button" class="own-btn" data-size="sm" onClick={() => props.onClose()}>
            {i18n.t("own.kit.close")}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-testid="mcp-registry-body">
        <p class="m-0 text-[12.5px] text-own-muted">{text("own.mcpm.reg.lead")}</p>
        <Notice tone="warn" testid="mcp-registry-trust">
          {text("own.mcpm.reg.trust")}
        </Notice>
        <div class="flex flex-wrap items-end gap-2">
          <div class="min-w-[200px] flex-1">
            <TextField
              label={text("own.mcpm.reg.search")}
              value={query()}
              onValue={setQuery}
              onEnter={() => void search()}
              placeholder={text("own.mcpm.reg.searchPlaceholder")}
              spellcheck={false}
              autocomplete="off"
              testid="mcp-registry-search"
            />
          </div>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            data-testid="mcp-registry-go"
            onClick={() => void search()}
          >
            {text("own.mcpm.reg.go")}
          </button>
        </div>
        <Show when={state.phase === "searching"}>
          <p class="m-0 text-[12.5px]" role="status">
            <Spinner /> {text("own.mcpm.reg.searching")}
          </p>
        </Show>
        <Show when={state.phase === "failed"}>
          <Notice tone="danger" testid="mcp-registry-failed">
            <p class="m-0">{state.failure}</p>
            <button type="button" class="own-btn mt-2" data-size="sm" onClick={() => void search()}>
              {text("own.mcpm.reg.retry")}
            </button>
          </Notice>
        </Show>
        <Show when={state.phase === "done" && state.entries.length === 0}>
          <p class="m-0 text-[12.5px] text-own-muted" data-testid="mcp-registry-none">
            {text("own.mcpm.reg.none")}
          </p>
        </Show>
        <Show when={state.entries.length > 0}>
          <ul class="m-0 flex list-none flex-col divide-y divide-own-border rounded-lg border border-own-border p-0">
            <For each={state.entries}>
              {(entry) => (
                <EntryRow
                  entry={entry}
                  open={open() === entry.name}
                  chosen={chosen[entry.name] ?? firstUsable(entry)}
                  onToggle={() => setOpen(open() === entry.name ? undefined : entry.name)}
                  onChoose={(index) => setChosen(entry.name, index)}
                  onUse={(option) => props.onPick(registryForm(entry, option))}
                />
              )}
            </For>
          </ul>
        </Show>
        <Show when={state.next && state.phase === "done"}>
          <div>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              disabled={state.more}
              data-testid="mcp-registry-more"
              onClick={() => void search(true)}
            >
              <Show when={state.more}>
                <Spinner />{" "}
              </Show>
              {text("own.mcpm.reg.more")}
            </button>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}

/** The first way to install that own can set up as it is, else the first. */
function firstUsable(entry: Entry) {
  return Math.max(
    0,
    entry.options.findIndex((option) => option.problem === undefined),
  )
}

function EntryRow(props: {
  readonly entry: Entry
  readonly open: boolean
  readonly chosen: number
  readonly onToggle: () => void
  readonly onChoose: (index: number) => void
  readonly onUse: (option: Option) => void
}) {
  const text = useMcpManageText()
  const option = () => props.entry.options[props.chosen] ?? props.entry.options[0]!
  return (
    <li class="flex flex-col gap-1.5 px-3 py-2.5" data-testid="mcp-registry-row" data-name={props.entry.name}>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex min-w-0 flex-1 flex-col">
          <b class="truncate text-[13.5px] font-semibold">{props.entry.title ?? props.entry.name}</b>
          <span class="own-mono truncate text-[11.5px] text-own-muted">{props.entry.name}</span>
        </div>
        <Show when={props.entry.status === "deprecated"}>
          <Tag tone="warn">{text("own.mcpm.reg.deprecated")}</Tag>
        </Show>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          aria-expanded={props.open}
          aria-label={text("own.mcpm.reg.pick", { name: props.entry.title ?? props.entry.name })}
          data-testid="mcp-registry-open"
          onClick={() => props.onToggle()}
        >
          {props.open ? "▴" : "▾"}
        </button>
      </div>
      <span class="flex flex-wrap gap-x-3 text-[12px] text-own-muted" data-testid="mcp-registry-meta">
        <span class="min-w-0 wrap-anywhere">{text("own.mcpm.reg.publisher", { publisher: props.entry.publisher })}</span>
        <Show when={props.entry.version}>
          {(version) => <span class="min-w-0 wrap-anywhere">{text("own.mcpm.reg.version", { version: version() })}</span>}
        </Show>
      </span>
      <Show when={props.entry.description}>
        <p class="m-0 text-[12.5px] wrap-anywhere">{props.entry.description}</p>
      </Show>
      <Show when={props.open}>
        <div class="flex flex-col gap-2 rounded-lg bg-own-subtle p-2.5" data-testid="mcp-registry-details">
          <span class="flex flex-wrap gap-3 text-[12px]">
            <Show when={props.entry.repository}>
              {(url) => (
                <a class="text-own-accent-text underline" href={url()} target="_blank" rel="noopener noreferrer">
                  {text("own.mcpm.reg.repository")}
                </a>
              )}
            </Show>
            <Show when={props.entry.website}>
              {(url) => (
                <a class="text-own-accent-text underline" href={url()} target="_blank" rel="noopener noreferrer">
                  {text("own.mcpm.reg.website")}
                </a>
              )}
            </Show>
          </span>
          <Show when={props.entry.options.length > 1}>
            <fieldset class="m-0 flex min-w-0 flex-col gap-1 border-0 p-0" data-testid="mcp-registry-options">
              <legend class="mb-1 p-0 text-[12.5px] text-own-muted">{text("own.mcpm.reg.options")}</legend>
              <For each={props.entry.options}>
                {(item, index) => (
                  <label class="flex items-center gap-2 text-[12.5px]">
                    <input
                      type="radio"
                      name={`mcp-registry-${props.entry.name}`}
                      checked={props.chosen === index()}
                      data-testid="mcp-registry-option"
                      onChange={() => props.onChoose(index())}
                    />
                    <span class="min-w-0 break-all">{optionLabel(text, item)}</span>
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
          <OptionDetails option={option()} />
          <div>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="primary"
              aria-haspopup="dialog"
              disabled={option().problem !== undefined}
              data-testid="mcp-registry-use"
              onClick={() => props.onUse(option())}
            >
              {text("own.mcpm.reg.use")}
            </button>
          </div>
        </div>
      </Show>
    </li>
  )
}

type Text = ReturnType<typeof useMcpManageText>

/** The registries' own names (`registryType` is lower case in `server.json`). */
const REGISTRIES: Readonly<Record<string, string>> = { npm: "npm", pypi: "PyPI", oci: "Docker(OCI)", nuget: "NuGet" }

function optionLabel(text: Text, option: Option) {
  if (option.type === "remote") return `${text("own.mcpm.reg.remote")} · ${option.url}`
  const type = REGISTRIES[option.registryType] ?? option.registryType
  return text("own.mcpm.reg.package", { type, identifier: option.identifier })
}

function OptionDetails(props: { readonly option: Option }) {
  const text = useMcpManageText()
  const values = () => (props.option.type === "package" ? props.option.env : props.option.headers)
  return (
    <div class="flex flex-col gap-1.5 text-[12px]" data-testid="mcp-registry-option-details">
      <Show when={props.option.problem}>
        {(problem) => <Tag tone="warn">{text(`own.mcpm.reg.problem.${problem()}`)}</Tag>}
      </Show>
      <Show
        when={props.option.type === "package" ? props.option : undefined}
        fallback={
          <>
            <span class="text-own-muted">{text("own.mcpm.reg.address")}</span>
            <code class="own-mono break-all text-[11.5px] text-own-text" data-testid="mcp-registry-command">
              {props.option.type === "remote" ? props.option.url : ""}
            </code>
          </>
        }
      >
        {(pkg) => (
          <Show when={pkg().command}>
            {(command) => (
              <>
                <span class="text-own-muted">{text("own.mcpm.reg.command")}</span>
                <code class="own-mono break-all text-[11.5px] text-own-text" data-testid="mcp-registry-command">
                  {commandLine(command(), pkg().args)}
                </code>
              </>
            )}
          </Show>
        )}
      </Show>
      <Show when={props.option.fill.length > 0}>
        <span class="text-own-warn wrap-anywhere">{text("own.mcpm.reg.fill", { names: props.option.fill.join(", ") })}</span>
      </Show>
      <Show when={values().length > 0}>
        <span class="text-own-muted">{text("own.mcpm.reg.values")}</span>
        <ul class="m-0 flex list-none flex-col gap-1 p-0" data-testid="mcp-registry-values">
          <For each={values()}>
            {(value) => (
              <li class="flex flex-wrap items-center gap-1.5">
                <span class="own-mono min-w-0 wrap-anywhere">{value.name}</span>
                <Tag tone={value.required ? "warn" : "plain"}>
                  {text(value.required ? "own.mcpm.reg.required" : "own.mcpm.reg.optional")}
                </Tag>
                <Show when={value.secret}>
                  <Tag tone="plain">{text("own.mcpm.reg.secret")}</Tag>
                </Show>
                <Show when={value.value}>
                  {(given) => (
                    <span class="min-w-0 text-own-muted wrap-anywhere">
                      {text("own.mcpm.reg.default", { value: given() })}
                    </span>
                  )}
                </Show>
                <Show when={value.template}>
                  {(template) => (
                    <span class="own-mono min-w-0 text-own-muted wrap-anywhere">
                      {text("own.mcpm.reg.template", { template: template() })}
                    </span>
                  )}
                </Show>
                <Show when={value.description}>
                  <span class="w-full text-own-muted wrap-anywhere">{value.description}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
