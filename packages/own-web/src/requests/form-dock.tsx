// Question and form dock (03 §18.2): the `question` tool, MCP elicitations and other server forms. Every field type
// of packages/schema/src/form.ts is drawn as it is (choice, multi choice with "직접 입력", text, number, yes/no, external
// link), fields with `when` appear when their conditions hold, `보내기` (Ctrl+Enter) / `건너뛰기` (cancel). Text
// inputs follow the IME rules (03 §12): uncontrolled, Enter only after the composition commits.
// Option rows adapted from packages/app/src/session/requests/session-question-dock.tsx @ 00d179015f (MIT, the
// "field renderer" part of 03 §15.2); the tabbed stepper, springs and upstream command registry are not used.
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerKey } from "@/data"
import { nextFrame } from "@/data/frame"
import { useHost } from "@/host"
import { commitComposition, createImeEnter } from "@/ime/ime-enter"
import { mcpInfo } from "./describe"
import { composing, frameRef, Head, isEnterKey, isEscapeKey, Kbd, MOD_ENTER, titleID } from "./dock-parts"
import {
  activeFields,
  bound,
  buildAnswer,
  initialDraft,
  problems,
  type Draft,
  type FormField,
  type Problem,
} from "./form-model"
import type { RequestItem, RequestModel } from "./model"
import { useRequestsText, type RequestsText } from "./strings"
import { DockPrompt } from "@/adapter/dock-prompt"

type FormItem = Extract<RequestItem, { kind: "form" }>
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends Readonly<Record<string, infer V>> ? Record<string, V> : T[K]
}

export function FormDock(props: {
  readonly item: FormItem
  readonly model: RequestModel
  readonly serverKey: ServerKey
  readonly onDone: (hadFocus: boolean) => void
}) {
  const text = useRequestsText()
  const id = titleID()
  const form = () => props.item.form
  const busy = () => props.model.busy(props.item.key)
  const [draft, setDraft] = createStore<Mutable<Draft>>(copy(initialDraft(form())))
  const [tried, setTried] = createSignal(false)
  const active = createMemo(() => activeFields(form(), draft))
  const found = createMemo(() => problems(form(), draft))
  const external = () => form().fields.some((field) => field.type === "external")
  const inputs = new Map<string, HTMLInputElement>()
  let root: HTMLDivElement | undefined

  const title = () => {
    if (props.item.flavor === "mcp") return text("own.requests.form.mcp", { server: mcpInfo(form()).server })
    if (props.item.flavor === "question")
      return form().fields.length > 1
        ? text("own.requests.form.questions", { n: form().fields.length })
        : text("own.requests.form.question")
    return form().title
  }

  async function submit() {
    setTried(true)
    const first = active().find((field) => found()[field.key])
    if (first) return focusField(first.key)
    const hadFocus = !!root?.contains(document.activeElement)
    if (await props.model.reply(form(), buildAnswer(form(), draft))) props.onDone(hadFocus)
  }

  async function skip() {
    const hadFocus = !!root?.contains(document.activeElement)
    if (await props.model.cancel(form())) props.onDone(hadFocus)
  }

  function focusField(key: string) {
    nextFrame(() => {
      const target = inputs.get(key) ?? root?.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"] button`)
      target?.focus()
    })
  }

  /** Enter in a text field moves to the next field, and sends from the last one. */
  function next(key: string) {
    const list = active()
    const index = list.findIndex((field) => field.key === key)
    const following = list[index + 1]
    if (following) return focusField(following.key)
    void submit()
  }

  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || composing(event)) return
    const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    if (isEnterKey(event) && mod) {
      event.preventDefault()
      const target = event.target
      const commit = target instanceof HTMLInputElement ? commitComposition(target, false) : Promise.resolve()
      return void commit.then(submit)
    }
    // Esc never dismisses (that stops the turn); it hands focus back to the composer.
    if (isEscapeKey(event) && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault()
      document.getElementById("own-composer-input")?.focus()
    }
  }

  const field = (key: string) => ({
    draft,
    busy: busy(),
    problem: tried() ? found()[key] : undefined,
    text,
    register: (element: HTMLInputElement) => inputs.set(key, element),
    next: () => next(key),
    set: (update: (draft: Mutable<Draft>) => void) => setDraft(produce(update)),
  })

  return (
    <DockPrompt
      kind="question"
      ref={(element) => {
        root = element
        frameRef(id, MOD_ENTER)(element)
        element.dataset.testid = "form-dock"
        element.dataset.flavor = props.item.flavor
      }}
      onKeyDown={keydown}
      header={
        <Head id={id} kind="question" title={title()} origin={props.item.origin} serverKey={props.serverKey}>
          <Show when={props.item.flavor === "mcp" && mcpInfo(form()).message}>
            <p class="own-rq-note">{mcpInfo(form()).message}</p>
          </Show>
        </Head>
      }
      footer={
        <>
          <Show when={tried() && Object.keys(found()).length > 0}>
            <p class="own-rq-problem" role="alert">
              {text("own.requests.form.missing")}
            </p>
          </Show>
          <div class="own-rq-actions">
            <Show when={props.item.flavor === "question"}>
              <span class="own-rq-grow own-rq-note">{text("own.requests.form.skipEffect")}</span>
            </Show>
            <button
              type="button"
              class="own-rq-btn"
              data-variant="ghost"
              data-testid="form-skip"
              disabled={busy()}
              onClick={() => void skip()}
            >
              {text("own.requests.form.skip")}
            </button>
            <button
              type="button"
              class="own-rq-btn"
              data-variant="primary"
              data-testid="form-submit"
              disabled={busy()}
              aria-keyshortcuts={MOD_ENTER}
              onClick={() => void submit()}
            >
              {external() ? text("own.requests.form.externalDone") : text("own.requests.form.submit")}{" "}
              <Kbd keys="modEnter" />
            </button>
          </div>
        </>
      }
    >
      <For each={active()}>{(item) => <Field field={item} {...field(item.key)} />}</For>
    </DockPrompt>
  )
}

interface FieldProps {
  readonly field: FormField
  readonly draft: Draft
  readonly busy: boolean
  readonly problem?: Problem
  readonly text: RequestsText
  readonly register: (element: HTMLInputElement) => void
  readonly next: () => void
  readonly set: (update: (draft: Mutable<Draft>) => void) => void
}

function Field(props: FieldProps) {
  const label = () => props.field.title ?? ""
  const description = () => ("description" in props.field ? props.field.description : undefined)
  const required = () => "required" in props.field && props.field.required === true
  return (
    <fieldset class="own-rq-field" data-field={props.field.key} data-testid="form-field">
      <Show when={label()}>
        <legend class="own-rq-field-title">
          {label()}
          <Show when={required()}>
            <span class="own-rq-required">{props.text("own.requests.form.required")}</span>
          </Show>
        </legend>
      </Show>
      <Show when={description()}>
        <p class="own-rq-field-desc">{description()}</p>
      </Show>
      <Switch>
        <Match
          when={props.field.type === "multiselect" || (props.field.type === "string" && props.field.options?.length)}
        >
          <Choices {...props} />
        </Match>
        <Match when={props.field.type === "string"}>
          <TextInput {...props} />
        </Match>
        <Match when={props.field.type === "number" || props.field.type === "integer"}>
          <NumberInput {...props} />
        </Match>
        <Match when={props.field.type === "boolean"}>
          <YesNo {...props} />
        </Match>
        <Match when={props.field.type === "external"}>
          <External url={(props.field as Extract<FormField, { type: "external" }>).url} text={props.text} />
        </Match>
      </Switch>
      <Show when={props.problem}>
        {(problem) => <p class="own-rq-problem">{problemText(props.text, props.field, problem())}</p>}
      </Show>
    </fieldset>
  )
}

function Choices(props: FieldProps) {
  const multi = () => props.field.type === "multiselect"
  const options = () =>
    props.field.type === "multiselect" || props.field.type === "string" ? (props.field.options ?? []) : []
  const custom = () =>
    (props.field.type === "multiselect" || props.field.type === "string") && props.field.custom === true
  const key = () => props.field.key
  const picked = (value: string) =>
    multi()
      ? (props.draft.picked[key()] ?? []).includes(value)
      : !props.draft.customOn[key()] && props.draft.values[key()] === value
  const customOn = () => props.draft.customOn[key()] === true
  const [editing, setEditing] = createSignal(customOn())

  const pick = (value: string) =>
    props.set((draft) => {
      if (!multi()) {
        draft.values[key()] = value
        draft.customOn[key()] = false
        return
      }
      const current = draft.picked[key()] ?? []
      draft.picked[key()] = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    })

  const toggleCustom = () => {
    const on = multi() ? !customOn() : true
    props.set((draft) => {
      draft.customOn[key()] = on
    })
    setEditing(on)
  }

  return (
    <div
      class="own-rq-options"
      role={multi() ? "group" : "radiogroup"}
      aria-label={props.field.title ?? props.field.key}
    >
      <p class="own-rq-note">
        {multi() ? props.text("own.requests.form.multi") : props.text("own.requests.form.single")}
      </p>
      <For each={options()}>
        {(option) => (
          <button
            type="button"
            class="own-rq-option"
            role={multi() ? "checkbox" : "radio"}
            aria-checked={picked(option.value)}
            data-picked={picked(option.value) ? "" : undefined}
            data-testid="form-option"
            disabled={props.busy}
            onClick={() => pick(option.value)}
          >
            <span class="own-rq-check" data-type={multi() ? "checkbox" : "radio"} aria-hidden="true">
              {picked(option.value) ? "✓" : ""}
            </span>
            <span class="own-rq-option-main">
              <span>{option.label}</span>
              <Show when={option.description}>
                <span class="own-rq-option-desc">{option.description}</span>
              </Show>
            </span>
          </button>
        )}
      </For>
      <Show when={custom()}>
        <button
          type="button"
          class="own-rq-option"
          role={multi() ? "checkbox" : "radio"}
          aria-checked={customOn()}
          data-picked={customOn() ? "" : undefined}
          data-testid="form-custom"
          disabled={props.busy}
          onClick={toggleCustom}
        >
          <span class="own-rq-check" data-type={multi() ? "checkbox" : "radio"} aria-hidden="true">
            {customOn() ? "✓" : ""}
          </span>
          <span class="own-rq-option-main">
            <span>{props.text("own.requests.form.custom")}</span>
          </span>
        </button>
        <Show when={editing() && customOn()}>
          <ImeInput
            {...props}
            initial={props.draft.custom[key()] ?? ""}
            placeholder={props.text("own.requests.form.customPlaceholder")}
            testid="form-custom-input"
            focus
            onValue={(value) =>
              props.set((draft) => {
                draft.custom[key()] = value
              })
            }
          />
        </Show>
      </Show>
    </div>
  )
}

function TextInput(props: FieldProps) {
  const field = () => props.field as Extract<FormField, { type: "string" }>
  const type = () => {
    const format = field().format
    if (format === "email") return "email"
    if (format === "uri") return "url"
    if (format === "date") return "date"
    if (format === "date-time") return "datetime-local"
    return "text"
  }
  return (
    <ImeInput
      {...props}
      type={type()}
      initial={
        typeof props.draft.values[props.field.key] === "string" ? String(props.draft.values[props.field.key]) : ""
      }
      placeholder={field().placeholder}
      maxLength={field().maxLength}
      testid="form-text"
      onValue={(value) =>
        props.set((draft) => {
          draft.values[props.field.key] = value
        })
      }
    />
  )
}

/** Uncontrolled text input with the IME Enter rules (03 §12): never re-rendered while composing. */
function ImeInput(
  props: FieldProps & {
    readonly initial: string
    readonly placeholder?: string
    readonly type?: string
    readonly maxLength?: number
    readonly testid: string
    readonly focus?: boolean
    readonly onValue: (value: string) => void
  },
) {
  let element: HTMLInputElement | undefined
  const ime = createImeEnter({ onEnter: () => props.next() })
  onMount(() => {
    if (!element) return
    element.value = props.initial
    props.register(element)
    if (props.focus) nextFrame(() => element?.focus())
  })
  return (
    <input
      ref={element}
      class="own-rq-input"
      type={props.type ?? "text"}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      autocomplete="off"
      spellcheck={false}
      disabled={props.busy}
      aria-invalid={props.problem ? true : undefined}
      aria-label={props.field.title ?? props.field.key}
      data-testid={props.testid}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && isEnterKey(event)) return
        ime.keydown(event)
      }}
      onKeyUp={(event) => ime.keyup(event)}
      onCompositionStart={() => ime.compositionstart()}
      onCompositionEnd={() => ime.compositionend()}
      onInput={(event) => {
        ime.input()
        props.onValue(event.currentTarget.value)
      }}
    />
  )
}

function NumberInput(props: FieldProps) {
  const field = () => props.field as Extract<FormField, { type: "number" | "integer" }>
  let element: HTMLInputElement | undefined
  onMount(() => {
    if (!element) return
    const value = props.draft.values[props.field.key]
    element.value = typeof value === "number" ? String(value) : ""
    props.register(element)
  })
  return (
    <input
      ref={element}
      class="own-rq-input"
      type="number"
      inputMode={field().type === "integer" ? "numeric" : "decimal"}
      min={bound(field().minimum)}
      max={bound(field().maximum)}
      step={field().type === "integer" ? 1 : "any"}
      disabled={props.busy}
      aria-invalid={props.problem ? true : undefined}
      aria-label={props.field.title ?? props.field.key}
      data-testid="form-number"
      onKeyDown={(event) => {
        if (composing(event) || !isEnterKey(event) || event.ctrlKey || event.metaKey) return
        event.preventDefault()
        props.next()
      }}
      onInput={(event) => {
        const raw = event.currentTarget.value.trim()
        const parsed = raw === "" ? undefined : Number(raw)
        props.set((draft) => {
          draft.values[props.field.key] = parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined
        })
      }}
    />
  )
}

function YesNo(props: FieldProps) {
  const on = () => props.draft.values[props.field.key] === true
  return (
    <button
      type="button"
      class="own-rq-option"
      role="checkbox"
      aria-checked={on()}
      data-picked={on() ? "" : undefined}
      data-testid="form-boolean"
      disabled={props.busy}
      onClick={() =>
        props.set((draft) => {
          draft.values[props.field.key] = !on()
        })
      }
    >
      <span class="own-rq-check" data-type="checkbox" aria-hidden="true">
        {on() ? "✓" : ""}
      </span>
      <span class="own-rq-option-main">{props.text("own.requests.form.yes")}</span>
    </button>
  )
}

/** MCP URL-mode elicitation: the user finishes in the browser, then confirms with the send button. */
function External(props: { readonly url: string; readonly text: RequestsText }) {
  const host = useHost()
  return (
    <div class="flex flex-col gap-1.5">
      <p class="own-rq-url m-0">{props.url}</p>
      <div class="own-rq-actions justify-start">
        <button
          type="button"
          class="own-rq-btn"
          data-testid="form-external-open"
          onClick={() => host.openExternal(props.url)}
        >
          {props.text("own.requests.form.external")}
        </button>
        <span class="own-rq-note">{props.text("own.requests.form.externalHint")}</span>
      </div>
    </div>
  )
}

function problemText(text: RequestsText, field: FormField, problem: Problem) {
  if (problem === "range" && (field.type === "number" || field.type === "integer"))
    return text("own.requests.form.range", { min: bound(field.minimum) ?? "−∞", max: bound(field.maximum) ?? "∞" })
  return text("own.requests.form.missing")
}

function copy(draft: Draft): Mutable<Draft> {
  return {
    values: { ...draft.values },
    picked: Object.fromEntries(Object.entries(draft.picked).map(([key, value]) => [key, value ? [...value] : value])),
    custom: { ...draft.custom },
    customOn: { ...draft.customOn },
  }
}
