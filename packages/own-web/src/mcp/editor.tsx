// `＋ 서버 추가…` and `고치기…` of 설정 > MCP 서버 (03 §18.14, SM 2026-10-24), a lazy chunk of the page. One form for a
// command this PC runs (command, arguments one per line, working folder, environment variables) or a remote address
// (Streamable HTTP, headers, OAuth sign-in), where it is used (every project, the server's own project, or the page's;
// an edit keeps the server's scope until another is picked), its Code Mode, `JSON 붙여넣기` for a README's
// `mcpServers` snippet, `연결 시험` of the form as it is, and `저장` (own.accounts `mcp.save`). A form filled from the
// MCP Registry (`찾아서 설치…`) says so and keeps `{parts}` to fill. Values are password fields that empty themselves
// once sent (a registry value that is not secret shows as text); a stored value shows its name and last four
// characters only, and an empty field keeps it. IME: no field submits during a composition (TextField).
import { createMemo, createSignal, For, Index, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Segmented, Spinner, TextField } from "@/limits/kit"
import { baseName, samePath } from "@/projects/path"
import {
  parseServerJson,
  problems,
  sameScope,
  saveInput,
  scopeChoices,
  suggestName,
  transportInput,
  type Check,
  type CodeMode,
  type FileServer,
  type Form,
  type Server,
  type ValueRow,
} from "./manage-model"
import { useMcpManageText } from "./manage-strings"
import { CheckLine, errorText } from "./manage-parts"

export interface McpEditorProps {
  readonly runtime: ServerRuntime
  readonly form: Form
  /** The page's project. */
  readonly directory: string | undefined
  readonly files: ReadonlyArray<FileServer>
  readonly own: ReadonlyArray<Server>
  readonly onClose: () => void
  readonly onSaved: (name: string) => void
}

let rowKeys = 1000

/** The form as the editor changes it. */
type Draft = { -readonly [K in keyof Form]: Form[K] extends ReadonlyArray<infer Row> ? Row[] : Form[K] }

/** Problems the form shows under its fields; the others in the list below them. */
const INLINE = new Set(["name", "command", "url"])

export default function McpEditor(props: McpEditorProps) {
  const text = useMcpManageText()
  const i18n = useI18n()
  const [form, setForm] = createStore<Draft>({
    ...props.form,
    env: props.form.env.map((row) => ({ ...row })),
    headers: props.form.headers.map((row) => ({ ...row })),
    fill: [...props.form.fill],
  })
  const [pasteOpen, setPasteOpen] = createSignal(false)
  const [pasted, setPasted] = createSignal("")
  const [pasteNote, setPasteNote] = createSignal<{ readonly tone: "ok" | "danger"; readonly text: string }>()
  const [check, setCheck] = createSignal<Check | "testing">()
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [shown, setShown] = createSignal(false)
  const found = createMemo(() => problems(form))
  const editing = () => form.id !== undefined
  const clash = () => props.files.some((server) => server.name === form.name.trim())
  // An edit offers the server's own scope (kept unless another is picked) beside every project and the page's.
  const choices = createMemo(() => scopeChoices(form, editing() ? props.form.scope : undefined, props.directory))
  const scopeLabel = (index: number) => {
    const scope = choices()[index]!
    if (scope.type === "global") return text("own.mcpm.editor.scope.global")
    const name = baseName(scope.directory)
    return props.directory !== undefined && samePath(scope.directory, props.directory)
      ? `${text("own.mcpm.editor.scope.project")} (${name})`
      : text("own.mcpm.editor.scope.folder", { name })
  }
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(i18n.locale() === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit" })

  function fill() {
    const result = parseServerJson(pasted())
    if (!result.ok) return setPasteNote({ tone: "danger", text: text(`own.mcpm.editor.paste.${result.reason}`) })
    const first = result.servers[0]!
    const taken = props.own.filter((server) => server.id !== form.id).map((server) => server.name)
    const name = form.name.trim() || suggestName(first.name, taken)
    setForm(
      produce((draft) => {
        draft.name = name
        draft.type = first.form.type
        draft.command = first.form.command
        draft.args = first.form.args
        draft.cwd = first.form.cwd
        draft.url = first.form.url
        draft.oauth = first.form.oauth
        draft.env = first.form.env.map(([key, value]) => ({ key: rowKeys++, name: key, value }))
        draft.headers = first.form.headers.map(([key, value]) => ({ key: rowKeys++, name: key, value }))
      }),
    )
    // The pasted text may hold values: it leaves the box once the form has them.
    setPasted("")
    setPasteOpen(false)
    setPasteNote({
      tone: "ok",
      text:
        result.servers.length > 1
          ? text("own.mcpm.editor.pasteMany", { n: result.servers.length, name: first.name ?? name })
          : text("own.mcpm.editor.pasteDone", { name: first.name ?? name }),
    })
  }

  async function test() {
    if (check() === "testing") return
    setCheck("testing")
    const result = await props.runtime.rpc
      .call("mcp.test", {
        ...(form.id ? { id: form.id } : {}),
        transport: transportInput(form),
        ...(props.directory ? { directory: props.directory } : {}),
      })
      .catch((error: unknown) => {
        setFailure(errorText(text, error, form.name))
        return undefined
      })
    setCheck(result)
  }

  async function save() {
    setShown(true)
    if (found().length > 0 || saving()) return
    setSaving(true)
    setFailure(undefined)
    const input = saveInput(form)
    const saved = await props.runtime.rpc.call("mcp.save", input).then(
      () => true,
      (error: unknown) => {
        setFailure(errorText(text, error, input.name))
        return false
      },
    )
    setSaving(false)
    if (!saved) return
    // Values typed into the form leave it as soon as they are stored.
    setForm(
      produce((draft) => {
        draft.env = draft.env.map((row) => ({ ...row, value: "" }))
        draft.headers = draft.headers.map((row) => ({ ...row, value: "" }))
      }),
    )
    props.onSaved(input.name)
  }

  const addRow = (field: "env" | "headers") =>
    setForm(field, (list) => [...list, { key: rowKeys++, name: "", value: "" }])

  return (
    <Dialog
      open
      size="wide"
      title={
        editing() ? text("own.mcpm.editor.editTitle", { name: props.form.name }) : text("own.mcpm.editor.addTitle")
      }
      onClose={() => props.onClose()}
      testid="mcp-editor"
      footer={
        <>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            disabled={check() === "testing" || found().some((problem) => problem !== "name")}
            data-testid="mcp-editor-test"
            onClick={() => void test()}
          >
            <Show when={check() === "testing"}>
              <Spinner />{" "}
            </Show>
            {text(check() === "testing" ? "own.mcpm.testing" : "own.mcpm.test")}
          </button>
          <span class="flex-1" />
          <button type="button" class="own-btn" data-size="sm" onClick={() => props.onClose()}>
            {text("own.mcpm.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            disabled={saving()}
            data-testid="mcp-editor-save"
            onClick={() => void save()}
          >
            {text("own.mcpm.editor.save")}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-3" data-testid="mcp-editor-body">
        <Show when={form.registry}>
          {(registry) => (
            <Notice tone="warn" testid="mcp-editor-registry">
              <span class="wrap-anywhere">
                {text("own.mcpm.editor.registryNote", {
                  name: [registry().name, registry().version].filter(Boolean).join(" "),
                })}
              </span>
            </Notice>
          )}
        </Show>
        <Show when={!editing() && !form.registry}>
          <details
            class="rounded-lg border border-own-border px-3 py-2"
            open={pasteOpen()}
            onToggle={(event) => setPasteOpen(event.currentTarget.open)}
            data-testid="mcp-editor-paste"
          >
            <summary class="cursor-pointer text-[13px] select-none">{text("own.mcpm.editor.paste")}</summary>
            <p class="m-0 mt-1 text-[12px] text-own-muted">{text("own.mcpm.editor.pasteHint")}</p>
            <label class="mt-2 flex flex-col gap-1 text-[12.5px]">
              <span class="sr-only">{text("own.mcpm.editor.pasteLabel")}</span>
              <textarea
                class="own-input own-mono min-h-24 w-full p-2 text-[12px]"
                spellcheck={false}
                autocomplete="off"
                value={pasted()}
                data-testid="mcp-editor-paste-text"
                onInput={(event) => setPasted(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              class="own-btn mt-2"
              data-size="sm"
              disabled={!pasted().trim()}
              data-testid="mcp-editor-paste-fill"
              onClick={fill}
            >
              {text("own.mcpm.editor.pasteFill")}
            </button>
          </details>
        </Show>
        <Show when={pasteNote()}>
          {(note) => (
            <Notice tone={note().tone} testid="mcp-editor-paste-note">
              {note().text}
            </Notice>
          )}
        </Show>
        <TextField
          label={text("own.mcpm.editor.name")}
          value={form.name}
          onValue={(value) => setForm("name", value)}
          hint={text("own.mcpm.editor.nameHint")}
          error={shown() && found().includes("name") ? text("own.mcpm.editor.problem.name") : undefined}
          spellcheck={false}
          autocomplete="off"
          testid="mcp-editor-name"
        />
        <Show when={clash()}>
          <Notice tone="warn" testid="mcp-editor-clash">
            {text("own.mcpm.editor.fileClash", { name: form.name.trim() })}
          </Notice>
        </Show>
        <div class="flex flex-col gap-1">
          <span class="text-[12.5px] text-own-muted">{text("own.mcpm.editor.scope")}</span>
          <Segmented
            label={text("own.mcpm.editor.scope")}
            value={String(Math.max(0, choices().findIndex((scope) => sameScope(scope, form.scope))))}
            options={[
              ...choices().map((_, index) => ({ value: String(index), label: scopeLabel(index) })),
              // No project open and none of its own: the choice shows, unavailable.
              ...(choices().length === 1
                ? [{ value: "none", label: text("own.mcpm.editor.scope.project"), disabled: true }]
                : []),
            ]}
            onChange={(value) => {
              const scope = choices()[Number(value)]
              if (scope) setForm("scope", scope)
            }}
            testid="mcp-editor-scope"
          />
          <Show when={editing()}>
            <span class="text-[12px] text-own-faint">{text("own.mcpm.editor.scopeKept")}</span>
          </Show>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-[12.5px] text-own-muted">{text("own.mcpm.editor.type")}</span>
          <Segmented
            label={text("own.mcpm.editor.type")}
            value={form.type}
            options={[
              {
                value: "local",
                label: text("own.mcpm.editor.type.local"),
                disabled: editing() && props.form.type === "remote",
              },
              {
                value: "remote",
                label: text("own.mcpm.editor.type.remote"),
                disabled: editing() && props.form.type === "local",
              },
            ]}
            onChange={(value) => setForm("type", value)}
            testid="mcp-editor-type"
          />
        </div>
        <Show
          when={form.type === "local"}
          fallback={
            <>
              <TextField
                label={text("own.mcpm.editor.url")}
                value={form.url}
                onValue={(value) => setForm("url", value)}
                placeholder={form.storedURL ?? "https://example.com/mcp"}
                hint={form.storedURL ? text("own.mcpm.editor.urlKept", { url: form.storedURL }) : undefined}
                error={shown() && found().includes("url") ? text("own.mcpm.editor.problem.url") : undefined}
                spellcheck={false}
                autocomplete="off"
                testid="mcp-editor-url"
              />
              <Values
                field="headers"
                rows={form.headers}
                title={text("own.mcpm.editor.headers")}
                add={text("own.mcpm.editor.headerAdd")}
                onAdd={() => addRow("headers")}
                onChange={(index, row) => setForm("headers", index, row)}
                onRemove={(index) => setForm("headers", (list) => list.filter((_, at) => at !== index))}
              />
              <label class="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={form.oauth}
                  data-testid="mcp-editor-oauth"
                  onChange={(event) => setForm("oauth", event.currentTarget.checked)}
                />
                {text("own.mcpm.editor.oauth")}
              </label>
            </>
          }
        >
          <TextField
            label={text("own.mcpm.editor.command")}
            value={form.command}
            onValue={(value) => setForm("command", value)}
            hint={text("own.mcpm.editor.commandHint")}
            error={shown() && found().includes("command") ? text("own.mcpm.editor.problem.command") : undefined}
            spellcheck={false}
            autocomplete="off"
            testid="mcp-editor-command"
          />
          <label class="own-field">
            <span class="own-field-label">{text("own.mcpm.editor.args")}</span>
            <textarea
              class="own-input own-mono min-h-24 w-full resize-y p-2 text-[12px]"
              spellcheck={false}
              autocomplete="off"
              value={form.args}
              data-testid="mcp-editor-args"
              onInput={(event) => setForm("args", event.currentTarget.value)}
            />
            <span class="text-[12px] text-own-faint">{text("own.mcpm.editor.argsHint")}</span>
          </label>
          <TextField
            label={text("own.mcpm.editor.cwd")}
            value={form.cwd}
            onValue={(value) => setForm("cwd", value)}
            hint={text("own.mcpm.editor.cwdHint")}
            spellcheck={false}
            autocomplete="off"
            testid="mcp-editor-cwd"
          />
          <Values
            field="env"
            rows={form.env}
            title={text("own.mcpm.editor.env")}
            add={text("own.mcpm.editor.envAdd")}
            onAdd={() => addRow("env")}
            onChange={(index, row) => setForm("env", index, row)}
            onRemove={(index) => setForm("env", (list) => list.filter((_, at) => at !== index))}
          />
          <p class="m-0 text-[12px] text-own-warn">{text("own.mcpm.editor.runNote")}</p>
        </Show>
        <div class="flex flex-col gap-1">
          <span class="text-[12.5px] text-own-muted">{text("own.mcpm.editor.codemode")}</span>
          <Segmented
            label={text("own.mcpm.editor.codemode")}
            value={form.codemode}
            options={(["default", "on", "off"] as const).map((value) => ({
              value,
              label: text(`own.mcpm.editor.codemode.${value}`),
            }))}
            onChange={(value: CodeMode) => setForm("codemode", value)}
            testid="mcp-editor-codemode"
          />
          <span class="text-[12px] text-own-faint">{text("own.mcpm.editor.codemodeHint")}</span>
        </div>
        <Show when={shown() && found().some((problem) => !INLINE.has(problem))}>
          <Notice tone="danger" testid="mcp-editor-problems">
            <For each={found().filter((problem) => !INLINE.has(problem))}>
              {(problem) => (
                <p class="m-0 wrap-anywhere">
                  {text(`own.mcpm.editor.problem.${problem}`, { names: form.fill.join(", ") })}
                </p>
              )}
            </For>
          </Notice>
        </Show>
        <p class="m-0 text-[12px] text-own-muted">{text("own.mcpm.editor.secretNote")}</p>
        <div data-testid="mcp-editor-check">
          <Show when={check() === "testing"}>
            <p class="m-0 text-[12.5px]" role="status">
              <Spinner /> {text("own.mcpm.testing")}
            </p>
          </Show>
          <CheckLine check={check()} time={time} />
        </div>
        <Show when={failure()}>
          {(message) => (
            <Notice tone="danger" testid="mcp-editor-failed">
              {message()}
            </Notice>
          )}
        </Show>
      </div>
    </Dialog>
  )
}

/** Environment variables or headers: a name and a password field per line; a stored value shows its hint. */
function Values(props: {
  readonly field: "env" | "headers"
  readonly rows: ReadonlyArray<ValueRow>
  readonly title: string
  readonly add: string
  readonly onAdd: () => void
  readonly onChange: (index: number, row: ValueRow) => void
  readonly onRemove: (index: number) => void
}) {
  const text = useMcpManageText()
  return (
    // `min-w-0`: a fieldset is as wide as its longest word by default, and a registry's note may be one long word.
    <fieldset class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" data-testid={`mcp-editor-${props.field}`}>
      <legend class="mb-1 p-0 text-[12.5px] text-own-muted">{props.title}</legend>
      <Index each={props.rows}>
        {(row, index) => (
          <div class="flex flex-wrap items-start gap-2" data-testid={`mcp-editor-${props.field}-row`}>
            <div class="min-w-[140px] flex-1">
              <TextField
                label={text("own.mcpm.editor.valueName")}
                hideLabel
                placeholder={text("own.mcpm.editor.valueName")}
                value={row().name}
                onValue={(name) => props.onChange(index, { ...row(), name })}
                spellcheck={false}
                autocomplete="off"
                class="own-mono"
                testid={`mcp-editor-${props.field}-name`}
              />
            </div>
            <div class="min-w-[180px] flex-[2]">
              <TextField
                label={text("own.mcpm.editor.value")}
                hideLabel
                type={row().plain ? "text" : "password"}
                placeholder={
                  row().stored
                    ? row().stored!.hint
                      ? text("own.mcpm.editor.valueKept", { hint: row().stored!.hint! })
                      : text("own.mcpm.editor.valueKeptPlain")
                    : (row().template ??
                      (row().optional ? text("own.mcpm.editor.valueOptional") : text("own.mcpm.editor.value")))
                }
                value={row().value}
                onValue={(value) => props.onChange(index, { ...row(), value })}
                spellcheck={false}
                autocomplete="new-password"
                testid={`mcp-editor-${props.field}-value`}
              />
            </div>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              aria-label={text("own.mcpm.editor.removeRow", { name: row().name || "—" })}
              onClick={() => props.onRemove(index)}
            >
              ✕
            </button>
            <Show when={row().note}>
              <span class="w-full text-[12px] text-own-faint wrap-anywhere" data-testid={`mcp-editor-${props.field}-note`}>
                {row().note}
              </span>
            </Show>
          </div>
        )}
      </Index>
      <div>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-testid={`mcp-editor-${props.field}-add`}
          onClick={() => props.onAdd()}
        >
          {props.add}
        </button>
      </div>
    </fieldset>
  )
}
