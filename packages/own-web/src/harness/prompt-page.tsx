// 설정 > 에이전트 방식 (10 §3.11): per 에이전트 방식, what it sends a model (the instructions part by part, monospace,
// searchable, copyable), its tools, what own changed from the original and why (before and after), and the editor of
// 내 지시문 with 저장 and 기본으로 되돌리기. The page reads this PC's service (own.harness `prompt.preview`) and writes
// with `prompt.custom.set` (scope `local`); a phone or another PC sees it read-only. Only the editable part (Codex's
// base instructions, Pi's opening paragraph) is the user's: the permissions text, the tools and the environment stay
// generated and read-only. OpenCode 기본 has nothing of its own to show; Claude Agent 기본 (02 §8.10) shows what it sends
// (Claude Code's own prompt, then OpenCode's role and rules) without variants, 비교 or 내 지시문. The logic is
// harness/prompt-state.ts.
// `비교`, beside the variant, shows two variants side by side instead of one (prompt-compare-view.tsx); each of own's
// changes links to its manual entry (`자세히`, 10.13). `하위 에이전트`, read only, says how each 에이전트 방식 hands
// work to a child and what comes back (subagent-view.ts): OpenCode 기본's from `prompt.subagent`, omo's in one line.
import type { OwnHarness } from "@own/protocol/rpc-harness"
import type { CustomHarnessID, HarnessID, PreviewHarnessID, PromptID } from "@own/protocol/rpc-harness-routing"
import { createEffect, createSignal, createUniqueId, For, onMount, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n, type I18nKey } from "@/i18n"
import { copyText, Dialog, Notice, Segmented, Tag, TextField } from "@/limits/kit"
import { usePresetEffortText } from "@/presets/pe-strings"
import { RoleGuide } from "@/presets/role-guide"
import { activeDirectory } from "@/projects/active"
import { useRouter } from "@/routing/router"
import { Setting } from "@/settings/sections"
import { newSessionDirectory, newSessionTarget } from "@/switcher/new-session"
import { showToast } from "@/switcher/toast"
import CompareView, { ManualMore } from "./prompt-compare-view"
import { promptPageState, searchPieces, type PromptPageState } from "./prompt-state"
import { variantHarness } from "./index"
import { omoText } from "./omo-strings"
import { usePromptsText, type PromptsKey } from "./prompt-strings"
import { subagentView } from "./subagent-view"
import "./prompts.css"

/** The tabs; omo (원본) and Claude Agent 기본 only while the service offers them (own/docs/15, 02 §8.10). */
const HARNESSES: readonly HarnessID[] = ["codex", "pi", "dsh", "omo", "claude-code", "opencode"]
const OFFERED_ONLY: ReadonlySet<HarnessID> = new Set(["omo", "claude-code"])
const MODES: readonly OwnHarness.ApprovalMode[] = ["full", "ask", "read-only"]
const MODE_LABEL: Record<OwnHarness.ApprovalMode, I18nKey> = {
  full: "own.approval.full",
  ask: "own.approval.ask",
  "read-only": "own.approval.readOnly",
}
/** The token 내 지시문 takes own's patch section in (own-harness `CodexVariant.PATCH_SLOT`). */
const PATCH_SLOT = "{{patch}}"

export default function PromptSettings() {
  const data = useData()
  const i18n = useI18n()
  const prompts = usePromptsText()
  const router = useRouter()
  const state = promptPageState({
    runtime: () => data.local(),
    t: prompts,
    toast: showToast,
    directory: () => activeDirectory(data.local(), router.route()),
    // What a new conversation would start on (the switcher's pick, the folder's last model, the account's default),
    // else the latest conversation's model.
    initialModel: () => {
      const runtime = data.local()
      const target = newSessionTarget(runtime, runtime.key, newSessionDirectory(runtime, router.route()))
      if (target) return { providerID: target.providerID, modelID: target.id }
      const index = runtime.sessions.state
      const latest = index.order.map((id) => index.sessions[id]?.model).find((model) => model !== undefined)
      return latest ? { providerID: latest.providerID, modelID: latest.id } : undefined
    },
  })
  onMount(() => void state.load())

  return (
    <div class="own-prompts" data-testid="settings-harness">
      <p class="own-prompts-intro">{prompts("own.prompts.intro")}</p>
      <Show
        when={state.list()}
        fallback={<ProblemNotice problem={state.problem()} onRetry={() => void state.load()} />}
      >
        <Setting title={prompts("own.prompts.harness")}>
          <Segmented
            label={prompts("own.prompts.harness")}
            value={state.tab()}
            options={HARNESSES.filter((id) => !OFFERED_ONLY.has(id) || state.list()?.harnesses.includes(id)).map(
              (id) => ({
                value: id,
                label: i18n.t(`own.harness.name.${id}`),
              }),
            )}
            onChange={(harness) => void state.choose({ harness })}
            testid="prompt-harness"
          />
        </Setting>
        <Show
          when={state.previewed()}
          fallback={
            <>
              <p class="own-prompts-note" data-testid="prompt-note">
                {state.tab() === "omo" ? omoText.text(i18n.locale(), "own.omo.page") : prompts("own.prompts.opencode")}
              </p>
              <Show
                when={state.tab() === "omo"}
                fallback={
                  <Show when={state.coreSubagent()}>
                    {(subagent) => <SubagentPart harness="opencode" subagent={subagent()} />}
                  </Show>
                }
              >
                <section class="own-psec" data-testid="prompt-subagent" data-kind="omo">
                  <div class="own-psec-head">
                    <h2>{prompts("own.prompts.subagent.title")}</h2>
                  </div>
                  <p class="own-prompts-note">{omoText.text(i18n.locale(), "own.omo.subagent")}</p>
                </section>
              </Show>
            </>
          }
        >
          {(harness) => <HarnessView state={state} harness={harness()} />}
        </Show>
      </Show>
    </div>
  )
}

/**
 * Why the page has nothing to show: a service that cannot show it (no own.harness, or one from before this page) says
 * so plainly as a note, not an error; any other failure offers `다시 시도` (the list again before it loaded, else the
 * preview).
 */
function ProblemNotice(props: {
  readonly problem: "unavailable" | "failed" | undefined
  readonly onRetry: () => void
}) {
  const prompts = usePromptsText()
  return (
    <Show when={props.problem}>
      {(problem) => (
        <Notice tone={problem() === "unavailable" ? "info" : "danger"} testid="prompt-problem">
          <span>{prompts(problem() === "unavailable" ? "own.prompts.unavailable" : "own.prompts.failed")}</span>
          <Show when={problem() === "failed"}>
            <button type="button" class="own-btn ml-2" data-size="sm" onClick={() => props.onRetry()}>
              {prompts("own.prompts.retry")}
            </button>
          </Show>
        </Notice>
      )}
    </Show>
  )
}

function HarnessView(props: { readonly state: PromptPageState; readonly harness: PreviewHarnessID }) {
  const i18n = useI18n()
  const prompts = usePromptsText()
  const state = props.state
  const preview = () => state.preview()
  const key = (model: { readonly providerID: string; readonly modelID: string }) =>
    `${model.providerID}/${model.modelID}`
  const tier = (): PromptsKey | undefined => {
    const current = preview()
    if (current === undefined) return undefined
    if (current.harness === "pi") return "own.prompts.tier.pi"
    if (current.harness === "dsh") return "own.prompts.tier.dsh"
    return current.tier === undefined ? undefined : `own.prompts.tier.${current.tier}`
  }
  return (
    <>
      <Show
        when={variantHarness(props.harness)}
        fallback={
          <p class="own-prompts-note" data-testid="prompt-note">
            {prompts("own.prompts.claudeCode")}
          </p>
        }
      >
        <Setting title={prompts("own.prompts.variant")}>
          <div class="own-prompts-variant">
            <Segmented
              label={prompts("own.prompts.variant")}
              value={state.prompt()}
              options={state
                .prompts()
                .map((id: PromptID) => ({ value: id, label: i18n.t(`own.harness.prompt.name.${id}`) }))}
              onChange={(prompt) => void state.choose({ prompt })}
              testid="prompt-variant"
            />
            <button
              type="button"
              class="own-btn own-prompts-compare-toggle"
              aria-pressed={state.compare()}
              data-testid="prompt-compare-toggle"
              onClick={() => void state.choose({ compare: !state.compare() })}
            >
              {prompts("own.prompts.compare")}
            </button>
          </div>
        </Setting>
      </Show>
      <Setting title={prompts("own.prompts.model")} note={tier() === undefined ? undefined : prompts(tier()!)}>
        <select
          class="own-input own-prompts-select"
          aria-label={prompts("own.prompts.model")}
          data-testid="prompt-model"
          value={state.model() === undefined ? "" : key(state.model()!)}
          onChange={(event) => {
            const chosen = preview()?.models.find((model) => key(model) === event.currentTarget.value)
            if (chosen) void state.choose({ model: { providerID: chosen.providerID, modelID: chosen.modelID } })
          }}
        >
          {/* The options arrive with a preview, after the model may be set: each option says whether it is the one. */}
          <For each={preview()?.models ?? []}>
            {(model) => (
              <option value={key(model)} selected={state.model() !== undefined && key(state.model()!) === key(model)}>
                {model.name === model.modelID ? model.modelID : `${model.name} · ${model.modelID}`}
              </option>
            )}
          </For>
        </select>
      </Setting>
      <Setting title={prompts("own.prompts.mode")}>
        <Segmented
          label={prompts("own.prompts.mode")}
          value={state.mode()}
          options={MODES.map((mode) => ({ value: mode, label: i18n.t(MODE_LABEL[mode]) }))}
          onChange={(mode) => void state.choose({ mode })}
          testid="prompt-mode"
        />
      </Setting>
      <Show when={preview()?.examples}>
        <p class="own-prompts-note">{prompts("own.prompts.examples")}</p>
      </Show>
      <ProblemNotice problem={state.problem()} onRetry={() => void state.refresh()} />
      <Show when={preview()}>
        {(current) => (
          <div
            class="own-prompts-body"
            data-testid="prompt-preview"
            data-loading={state.loading() ? "true" : undefined}
          >
            <Show when={variantHarness(props.harness)}>
              {(custom) => (
                <>
                  <Show when={state.prompt() === "custom" && current().applied !== "custom"}>
                    <Notice tone="warn" testid="prompt-custom-missing">
                      {prompts("own.prompts.customMissing")}
                    </Notice>
                  </Show>
                  <Show
                    when={state.supported() && state.prompt() === "custom"}
                    fallback={
                      <Show when={state.supported()}>
                        <p class="own-prompts-note">{prompts("own.prompts.pickCustom")}</p>
                      </Show>
                    }
                  >
                    <CustomEditor state={state} preview={current()} harness={custom()} />
                  </Show>
                </>
              )}
            </Show>
            <Show
              when={state.compare() && variantHarness(props.harness)}
              fallback={
                <>
                  <SentText preview={current()} />
                  <ToolList preview={current()} />
                  <Show when={variantHarness(props.harness)}>
                    {(custom) => <Changes preview={current()} prompt={state.prompt()} harness={custom()} />}
                  </Show>
                </>
              }
            >
              <Show
                when={state.comparison()}
                fallback={
                  <Show when={state.partnerFailed()}>
                    <Notice tone="danger" testid="prompt-compare-failed">
                      <span>{prompts("own.prompts.compare.failed")}</span>
                      <button type="button" class="own-btn ml-2" data-size="sm" onClick={() => void state.refresh()}>
                        {prompts("own.prompts.retry")}
                      </button>
                    </Notice>
                  </Show>
                }
              >
                {(pair) => <CompareView left={pair().left} right={pair().right} changes={pair().changes} />}
              </Show>
            </Show>
            <Show when={current().subagent}>
              {(subagent) => (
                <SubagentPart
                  harness={props.harness}
                  subagent={subagent()}
                  codex={{ tier: current().tier, applied: current().applied }}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}

function SentText(props: { readonly preview: OwnHarness.PromptPreview }) {
  const prompts = usePromptsText()
  const [query, setQuery] = createSignal("")
  const found = () =>
    query() === ""
      ? 0
      : props.preview.parts.reduce(
          (sum, part) => sum + searchPieces(part.text, query()).filter((piece) => piece.match).length,
          0,
        )
  const copy = (text: string) =>
    void copyText(text).then((ok) =>
      showToast(
        ok
          ? { message: prompts("own.prompts.copied") }
          : { message: prompts("own.prompts.copyFailed"), tone: "danger" },
      ),
    )
  return (
    <section class="own-psec" data-testid="prompt-sent">
      <div class="own-psec-head flex-wrap">
        <h2>{prompts("own.prompts.sent.title")}</h2>
        <div class="own-prompts-search">
          <TextField
            label={prompts("own.prompts.search")}
            placeholder={prompts("own.prompts.search")}
            hideLabel
            value={query()}
            onValue={setQuery}
            testid="prompt-search"
          />
          <Show when={query() !== ""}>
            <span class="own-prompts-found" role="status" data-testid="prompt-search-count">
              {found() === 0
                ? prompts("own.prompts.search.none")
                : prompts("own.prompts.search.count", { count: found() })}
            </span>
          </Show>
        </div>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-testid="prompt-copy-all"
          onClick={() => copy(props.preview.parts.map((part) => part.text).join("\n\n"))}
        >
          {prompts("own.prompts.copyAll")}
        </button>
      </div>
      <p class="own-prompts-note">{prompts("own.prompts.sent.note")}</p>
      <For each={props.preview.parts}>
        {(part) => (
          <details
            class="own-prompts-part"
            open={part.editable || (query() !== "" && part.text.toLowerCase().includes(query().toLowerCase()))}
            data-testid="prompt-part"
            data-kind={part.kind}
          >
            <summary>
              <span class="own-prompts-part-name">{prompts(`own.prompts.part.${part.kind}`)}</span>
              <Tag tone="plain">{prompts(`own.prompts.role.${part.role}`)}</Tag>
              <Tag tone={part.editable ? "default" : "dashed"}>
                {prompts(part.editable ? "own.prompts.editable" : "own.prompts.generated")}
              </Tag>
              <span class="own-prompts-count">
                {prompts("own.prompts.chars", { count: part.text.length.toLocaleString() })}
              </span>
              <button
                type="button"
                class="own-btn ml-auto"
                data-size="sm"
                data-variant="ghost"
                onClick={(event) => {
                  event.preventDefault()
                  copy(part.text)
                }}
              >
                {prompts("own.prompts.copy")}
              </button>
            </summary>
            <Show when={part.kind === "environment" || part.kind === "cwd" || part.kind === "time"}>
              <p class="own-prompts-note">{prompts("own.prompts.part.perConversation")}</p>
            </Show>
            <pre class="own-mono own-prompts-text" data-testid="prompt-part-text">
              <For each={searchPieces(part.text, query())}>
                {(piece) => (piece.match ? <mark>{piece.text}</mark> : piece.text)}
              </For>
            </pre>
          </details>
        )}
      </For>
    </section>
  )
}

function ToolList(props: { readonly preview: OwnHarness.PromptPreview }) {
  const prompts = usePromptsText()
  return (
    <section class="own-psec" data-testid="prompt-tools">
      <div class="own-psec-head">
        <h2>{prompts("own.prompts.tools.title", { count: props.preview.tools.length })}</h2>
      </div>
      <p class="own-prompts-note">{prompts("own.prompts.tools.note")}</p>
      <For each={props.preview.tools}>
        {(tool) => (
          <details class="own-prompts-part" data-testid="prompt-tool">
            <summary>
              <span class="own-mono own-prompts-part-name">{tool.name}</span>
              <span class="own-prompts-tool-line">{tool.description.split("\n")[0]}</span>
            </summary>
            <pre class="own-mono own-prompts-text">{tool.description}</pre>
          </details>
        )}
      </For>
    </section>
  )
}

/** `하위 에이전트`: the delegation tool as sent, a new child's first message, what is added and what comes back. */
function SubagentPart(props: {
  readonly harness: HarnessID
  readonly subagent: OwnHarness.PromptSubagent
  readonly codex?: { readonly tier?: "catalog" | "lean" | "fallback"; readonly applied: PromptID }
}) {
  const prompts = usePromptsText()
  const pe = usePresetEffortText()
  const view = () =>
    subagentView(
      { harness: props.harness, subagent: props.subagent, ...(props.codex ? { codex: props.codex } : {}) },
      prompts,
    )
  return (
    <section class="own-psec" data-testid="prompt-subagent" data-kind={props.subagent.kind}>
      <div class="own-psec-head">
        <h2>{prompts("own.prompts.subagent.title")}</h2>
      </div>
      <p class="own-prompts-note">{prompts("own.prompts.subagent.note")}</p>
      <Show when={view().tool}>
        {(tool) => (
          <>
            <details class="own-prompts-part" data-testid="prompt-subagent-tool">
              <summary>
                <span class="own-prompts-part-name">{prompts("own.prompts.subagent.tool")}</span>
                <Tag tone="plain">
                  <span class="own-mono">{tool().name}</span>
                </Tag>
              </summary>
              <pre class="own-mono own-prompts-text">{tool().description}</pre>
            </details>
            <For each={tool().notes}>{(note) => <p class="own-prompts-note">{note}</p>}</For>
          </>
        )}
      </Show>
      {/* The roles are agents of core's subagent tool (07 §2.4); Codex's own spawn_agent and omo take none. */}
      <Show when={props.subagent.kind === "core"}>
        <h3 class="own-prompts-subhead">{pe("own.pe.roles")}</h3>
        <RoleGuide testid="prompt-subagent-roles" />
        <p class="own-prompts-note">{pe("own.pe.harnessRoles")}</p>
      </Show>
      <h3 class="own-prompts-subhead">{prompts("own.prompts.subagent.first")}</h3>
      <pre class="own-mono own-prompts-text own-prompts-box" data-testid="prompt-subagent-first">
        {view().first.text}
      </pre>
      <p class="own-prompts-note">{view().first.note}</p>
      <h3 class="own-prompts-subhead">{prompts("own.prompts.subagent.sends")}</h3>
      <ul class="own-prompts-facts">
        <For each={view().sends}>{(line) => <li>{line}</li>}</For>
      </ul>
      <Show when={view().role}>
        {(role) => (
          <details class="own-prompts-part" data-testid="prompt-subagent-role">
            <summary>
              <span class="own-prompts-part-name">{prompts("own.prompts.subagent.role")}</span>
            </summary>
            <pre class="own-mono own-prompts-text">{role()}</pre>
          </details>
        )}
      </Show>
      <h3 class="own-prompts-subhead">{prompts("own.prompts.subagent.returns")}</h3>
      <ul class="own-prompts-facts" data-testid="prompt-subagent-returns">
        <For each={view().returns}>{(line) => <li>{line}</li>}</For>
      </ul>
    </section>
  )
}

function Changes(props: {
  readonly preview: OwnHarness.PromptPreview
  readonly prompt: PromptID
  readonly harness: CustomHarnessID
}) {
  const prompts = usePromptsText()
  const applying = () => props.preview.changes.filter((change) => change.applies)
  const others = () => props.preview.changes.filter((change) => !change.applies)
  const note = () => {
    if (applying().length === 0) return prompts("own.prompts.changes.none")
    if (props.prompt === "reference") return prompts("own.prompts.changes.reference", { count: applying().length })
    if (props.prompt === "custom") return prompts(`own.prompts.changes.custom.${props.harness}`)
    return prompts("own.prompts.changes.own", { count: applying().length })
  }
  return (
    <section class="own-psec" data-testid="prompt-changes">
      <div class="own-psec-head">
        <h2>{prompts("own.prompts.changes.title")}</h2>
      </div>
      <p class="own-prompts-note">{note()}</p>
      <For each={applying()}>{(change) => <ChangeView change={change} />}</For>
      <Show when={others().length > 0}>
        <details class="own-prompts-others" data-testid="prompt-changes-others">
          <summary>{prompts("own.prompts.changes.others", { count: others().length })}</summary>
          <For each={others()}>{(change) => <ChangeView change={change} />}</For>
        </details>
      </Show>
    </section>
  )
}

function ChangeView(props: { readonly change: OwnHarness.PromptChange }) {
  const prompts = usePromptsText()
  return (
    <article class="own-prompts-change" data-testid="prompt-change" data-id={props.change.id}>
      <h3>{props.change.title}</h3>
      <p>
        {props.change.why} <ManualMore change={props.change} />
      </p>
      <Show when={props.change.before !== "" || props.change.after !== ""}>
        <div class="own-prompts-diff">
          <div data-side="before">
            <span>{prompts("own.prompts.changes.before")}</span>
            <pre class="own-mono own-prompts-text">
              {props.change.before === "" ? prompts("own.prompts.changes.added") : props.change.before}
            </pre>
          </div>
          <div data-side="after">
            <span>{prompts("own.prompts.changes.after")}</span>
            <pre class="own-mono own-prompts-text">
              {props.change.after === "" ? prompts("own.prompts.changes.removed") : props.change.after}
            </pre>
          </div>
        </div>
      </Show>
    </article>
  )
}

function CustomEditor(props: {
  readonly state: PromptPageState
  readonly preview: OwnHarness.PromptPreview
  readonly harness: CustomHarnessID
}) {
  const i18n = useI18n()
  const prompts = usePromptsText()
  const state = props.state
  const id = createUniqueId()
  const [confirm, setConfirm] = createSignal(false)
  let editor: HTMLTextAreaElement | undefined
  // Write only real changes (a reset, a copy of another variant); never echo what the user is composing (12장 rule 5).
  createEffect(() => {
    const value = state.text()
    if (editor && editor.value !== value) editor.value = value
  })
  const harnessName = () => i18n.t(`own.harness.name.${props.harness}`)
  const problem = () => state.invalid()
  return (
    <section class="own-psec" data-testid="prompt-custom">
      <div class="own-psec-head">
        <h2>{prompts("own.prompts.custom.title")}</h2>
      </div>
      <p class="own-prompts-note">{prompts(`own.prompts.custom.note.${props.harness}`)}</p>
      {/* Only where the text has the slot: Codex's revised texts outside its catalog, or a text that kept it. */}
      <Show when={props.preview.starts.own.includes(PATCH_SLOT) || state.text().includes(PATCH_SLOT)}>
        <p class="own-prompts-note">{prompts("own.prompts.custom.patch", { slot: PATCH_SLOT })}</p>
      </Show>
      <Show when={!state.editable()}>
        <p class="own-prompts-note" data-testid="prompt-custom-readonly">
          {prompts("own.prompts.custom.readOnly")}
        </p>
      </Show>
      <Show
        when={state.started()}
        fallback={
          <div class="own-prompts-start">
            <p class="own-prompts-note">{prompts("own.prompts.custom.start", { model: props.preview.model.name })}</p>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="own-btn"
                data-variant="primary"
                data-testid="prompt-custom-from-own"
                disabled={!state.editable()}
                onClick={() => state.start("own")}
              >
                {prompts("own.prompts.custom.fromOwn")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-testid="prompt-custom-from-reference"
                disabled={!state.editable()}
                onClick={() => state.start("reference")}
              >
                {prompts("own.prompts.custom.fromReference")}
              </button>
            </div>
          </div>
        }
      >
        <label class="own-sr-only" for={id}>
          {prompts("own.prompts.custom.label")}
        </label>
        <textarea
          ref={(element) => {
            editor = element
            element.value = state.text()
          }}
          id={id}
          class="own-input own-mono own-prompts-editor"
          rows={18}
          spellcheck={false}
          readOnly={!state.editable()}
          aria-invalid={problem() !== undefined ? true : undefined}
          data-testid="prompt-custom-text"
          onInput={(event) => state.edit(event.currentTarget.value)}
        />
        <div class="own-prompts-editor-row">
          <span data-testid="prompt-custom-count">
            {prompts("own.prompts.custom.count", {
              count: state.text().length.toLocaleString(),
              limit: state.limit().toLocaleString(),
            })}
          </span>
          <Show when={state.dirty() && problem() !== undefined}>
            <span class="text-own-danger" role="alert">
              {problem() === "empty"
                ? prompts("own.prompts.custom.empty")
                : prompts("own.prompts.custom.tooLong", { limit: state.limit().toLocaleString() })}
            </span>
          </Show>
          <Show when={state.dirty() && problem() === undefined}>
            <span class="text-own-muted">{prompts("own.prompts.custom.unsaved")}</span>
          </Show>
        </div>
        <Show when={state.editable()}>
          <div class="own-prompts-actions">
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              data-testid="prompt-custom-save"
              disabled={!state.dirty() || problem() !== undefined || state.busy()}
              onClick={() => void state.save()}
            >
              {prompts("own.prompts.custom.save")}
            </button>
            <Show when={state.dirty()}>
              <button type="button" class="own-btn" data-testid="prompt-custom-discard" onClick={() => state.discard()}>
                {prompts("own.prompts.custom.discard")}
              </button>
            </Show>
            <button type="button" class="own-btn" data-variant="ghost" onClick={() => state.start("own")}>
              {prompts("own.prompts.custom.copyOwn")}
            </button>
            <button type="button" class="own-btn" data-variant="ghost" onClick={() => state.start("reference")}>
              {prompts("own.prompts.custom.copyReference")}
            </button>
            <Show when={state.saved() !== undefined}>
              <button
                type="button"
                class="own-btn ml-auto"
                data-variant="danger"
                data-testid="prompt-custom-reset"
                disabled={state.busy()}
                onClick={() => setConfirm(true)}
              >
                {prompts("own.prompts.custom.reset")}
              </button>
            </Show>
          </div>
        </Show>
        <p class="own-prompts-note" data-testid="prompt-custom-cache">
          {prompts("own.prompts.custom.cache")}
        </p>
        <p class="own-prompts-note">{prompts("own.prompts.custom.use")}</p>
      </Show>
      <Dialog
        open={confirm()}
        title={prompts("own.prompts.custom.resetTitle")}
        onClose={() => setConfirm(false)}
        testid="prompt-custom-reset-dialog"
        footer={
          <>
            <button type="button" class="own-btn" onClick={() => setConfirm(false)}>
              {i18n.t("own.kit.cancel")}
            </button>
            <button
              type="button"
              class="own-btn"
              data-variant="danger"
              data-testid="prompt-custom-reset-confirm"
              onClick={() => {
                setConfirm(false)
                void state.reset()
              }}
            >
              {prompts("own.prompts.custom.resetConfirm")}
            </button>
          </>
        }
      >
        <p class="m-0">{prompts("own.prompts.custom.resetBody", { harness: harnessName() })}</p>
      </Dialog>
    </section>
  )
}
