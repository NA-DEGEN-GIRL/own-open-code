// Small UI kit for the accounts, limits and settings modules. `@opencode/ui` dialogs and menus need the ui dialog
// layer and ui i18n contexts, which own-web does not mount (see ARCHITECTURE "Deviations"), so these use the
// platform instead: native `<dialog>` (top layer, inert page, focus containment) and the popover API for menus.
// Every text input follows 03 §12 through `createImeEnter`; Esc never fires while an IME is composing.
import { ProviderIcon } from "@opencode/ui/provider-icon"
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
  splitProps,
  type JSX,
  type ParentProps,
} from "solid-js"
import type { Account, Kind } from "@own/protocol"
import { providerIcon } from "@/accounts/model"
import { useI18n } from "@/i18n"
import { createImeEnter, isImeKey } from "@/ime/ime-enter"
import { Icon } from "@/shell/icons"
import "./kit.css"

export type TagTone = "default" | "plain" | "dashed" | "warn" | "danger" | "ok" | "accent" | "soft"

export function Tag(
  props: ParentProps<{ readonly tone?: TagTone; readonly title?: string; readonly testid?: string }>,
) {
  return (
    <span
      class="own-tag"
      data-tone={props.tone === "default" ? undefined : props.tone}
      title={props.title}
      data-testid={props.testid}
    >
      {props.children}
    </span>
  )
}

/** Account color dot (13.2). Decorative: the account name is always next to it (11장). */
export function Dot(props: { readonly color: Account.Color }) {
  return <span class="own-dot" aria-hidden="true" style={{ background: `var(--own-account-${props.color})` }} />
}

export function ProviderMark(props: { readonly kind: Kind.Any }) {
  return <ProviderIcon id={providerIcon(props.kind)} class="own-provider-icon" aria-hidden="true" />
}

export function Spinner() {
  return <span class="own-spinner" aria-hidden="true" />
}

export function Notice(
  props: ParentProps<{ readonly tone?: "info" | "warn" | "danger" | "ok"; readonly testid?: string }>,
) {
  return (
    <div
      class="own-notice"
      data-tone={props.tone === "info" ? undefined : props.tone}
      role={props.tone === "danger" || props.tone === "warn" ? "alert" : "status"}
      data-testid={props.testid}
    >
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  )
}

export interface DialogProps extends ParentProps {
  readonly open: boolean
  readonly title: JSX.Element
  readonly onClose: () => void
  readonly footer?: JSX.Element
  readonly size?: "normal" | "wide"
  readonly testid?: string
  /** Backdrop clicks close it (not for destructive confirmations). */
  readonly dismissable?: boolean
}

/** Modal dialog (11장: `role=dialog`, `aria-modal`, focus contained, focus returns to the opener). */
export function Dialog(props: DialogProps) {
  return (
    <Show when={props.open}>
      <DialogSurface {...props} />
    </Show>
  )
}

function DialogSurface(props: DialogProps) {
  const i18n = useI18n()
  const id = createUniqueId()
  let element!: HTMLDialogElement
  const opener = document.activeElement
  onMount(() => {
    if (typeof element.showModal === "function") element.showModal()
    else element.setAttribute("open", "")
  })
  onCleanup(() => {
    if (element.open && typeof element.close === "function") element.close()
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
  })
  return (
    <dialog
      ref={element}
      class="own-dialog"
      aria-labelledby={`${id}-title`}
      aria-modal="true"
      data-size={props.size === "wide" ? "wide" : undefined}
      data-testid={props.testid}
      data-own-keys="dialog"
      // The browser's own Esc handling would bypass the IME check below.
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.code !== "Escape" || isImeKey(event)) return
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }}
      onClick={(event) => {
        if (props.dismissable && event.target === element) props.onClose()
      }}
    >
      <header>
        <h2 id={`${id}-title`}>{props.title}</h2>
        <button
          type="button"
          class="own-icon-button"
          aria-label={i18n.t("own.kit.close")}
          data-testid="dialog-close"
          onClick={() => props.onClose()}
        >
          <Icon name="x" />
        </button>
      </header>
      <div class="own-dialog-body">{props.children}</div>
      <Show when={props.footer}>
        <footer>{props.footer}</footer>
      </Show>
    </dialog>
  )
}

export type MenuEntry =
  | {
      readonly label: string
      readonly onSelect: () => void
      readonly tone?: "danger"
      readonly disabled?: boolean
      readonly checked?: boolean
      readonly testid?: string
    }
  | "separator"

/**
 * `⋯` menu (5.4). Popover API: top layer (no clipping by scroll containers), light dismiss and Esc for free.
 * Arrow keys move between items; the first item gets focus when it opens.
 */
export function Menu(props: {
  readonly label: string
  readonly entries: () => readonly MenuEntry[]
  readonly testid?: string
}) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  const items = () => [...popover.querySelectorAll<HTMLButtonElement>("[role^=menuitem]:not(:disabled)")]
  // A menu with a check item keeps the check's column on every item, so the labels line up (2026-10-18 audit).
  const checkable = () => props.entries().some((entry) => entry !== "separator" && entry.checked !== undefined)
  const place = () => {
    const rect = button.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    popover.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`
    popover.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`
  }
  const move = (event: KeyboardEvent) => {
    // The popover closes itself on Esc; keep the key from also closing the drawer or sheet around it.
    if (event.code === "Escape") return event.stopPropagation()
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.code === "ArrowDown"
        ? (index + 1) % list.length
        : event.code === "ArrowUp"
          ? (index - 1 + list.length) % list.length
          : event.code === "Home"
            ? 0
            : event.code === "End"
              ? list.length - 1
              : -1
    if (next < 0) return
    event.preventDefault()
    list[next]?.focus()
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        class="own-icon-button"
        aria-label={props.label}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={id}
        popovertarget={id}
        data-testid={props.testid}
      >
        <span aria-hidden="true" class="own-ico own-ico-more" />
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="menu"
        aria-label={props.label}
        class="own-menu"
        onToggle={(event) => {
          const opened = event.newState === "open"
          setOpen(opened)
          if (!opened) return
          place()
          items()[0]?.focus()
        }}
        onKeyDown={move}
      >
        <Show when={open()}>
          <For each={props.entries()}>
            {(entry) =>
              entry === "separator" ? (
                <hr />
              ) : (
                <button
                  type="button"
                  role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={entry.checked}
                  data-tone={entry.tone}
                  data-testid={entry.testid}
                  disabled={entry.disabled}
                  onClick={() => {
                    popover.hidePopover()
                    button.focus()
                    entry.onSelect()
                  }}
                >
                  <Show when={checkable()}>
                    <span aria-hidden="true" class="w-3 flex-none">
                      {entry.checked ? "✓" : ""}
                    </span>
                  </Show>
                  {entry.label}
                </button>
              )
            }
          </For>
        </Show>
      </div>
    </>
  )
}

/** Radio-like segmented control (`aria-checked`), e.g. `5시간 | 7일`, the compaction choices. */
export function Segmented<T extends string>(props: {
  readonly label: string
  readonly value: T
  readonly options: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean }[]
  readonly onChange: (value: T) => void
  readonly testid?: string
}) {
  const select = (event: KeyboardEvent) => {
    const enabled = props.options.filter((option) => !option.disabled)
    const index = enabled.findIndex((option) => option.value === props.value)
    const delta =
      event.code === "ArrowRight" || event.code === "ArrowDown"
        ? 1
        : event.code === "ArrowLeft" || event.code === "ArrowUp"
          ? -1
          : 0
    if (!delta || enabled.length === 0) return
    event.preventDefault()
    const next = enabled[(index + delta + enabled.length) % enabled.length]!
    props.onChange(next.value)
    const group = event.currentTarget as HTMLElement
    queueMicrotask(() => group.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus())
  }
  return (
    <div class="own-seg" role="radiogroup" aria-label={props.label} data-testid={props.testid} onKeyDown={select}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="radio"
            data-value={option.value}
            aria-checked={props.value === option.value}
            tabIndex={props.value === option.value ? 0 : -1}
            disabled={option.disabled}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  )
}

export interface TextFieldProps extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "onInput" | "value"> {
  readonly label: string
  readonly value: string
  readonly onValue: (value: string) => void
  /** Enter submits once per press, also mid-composition (03 §12 rule 8). */
  readonly onEnter?: () => void
  readonly hint?: JSX.Element
  readonly error?: string
  readonly testid?: string
  readonly inputRef?: (element: HTMLInputElement) => void
  /** Keep the label for screen readers only (compact search boxes). */
  readonly hideLabel?: boolean
}

/**
 * Labelled input. The value is read from the element on `input` and written back only when it differs, so a
 * composition is never disturbed by a re-render (12장 rule 5).
 */
export function TextField(props: TextFieldProps) {
  const [local, rest] = splitProps(props, [
    "label",
    "value",
    "onValue",
    "onEnter",
    "hint",
    "error",
    "testid",
    "inputRef",
    "hideLabel",
    "class",
  ])
  const id = createUniqueId()
  const ime = createImeEnter({ onEnter: () => local.onEnter?.() })
  let element: HTMLInputElement | undefined
  // Write only real changes (a reset, a default name); never echo what the user is composing (12장 rule 5).
  createEffect(() => {
    const value = local.value
    if (element && element.value !== value) element.value = value
  })
  const note = () => local.error ?? local.hint
  return (
    <label class="own-field" for={id}>
      <span class={local.hideLabel ? "own-sr-only" : "own-field-label"}>{local.label}</span>
      <input
        {...rest}
        id={id}
        ref={(input) => {
          element = input
          input.value = local.value
          local.inputRef?.(input)
        }}
        class={`own-input ${local.class ?? ""}`}
        aria-invalid={local.error ? true : undefined}
        aria-describedby={local.error || local.hint ? `${id}-note` : undefined}
        data-testid={local.testid}
        onInput={(event) => {
          ime.input()
          local.onValue(event.currentTarget.value)
        }}
        onKeyDown={(event) => {
          if (local.onEnter) ime.keydown(event)
        }}
        onKeyUp={(event) => ime.keyup(event)}
        onCompositionStart={() => ime.compositionstart()}
        onCompositionEnd={() => ime.compositionend()}
      />
      <Show when={note()}>
        <span
          class={local.error ? "own-field-error" : "own-field-hint"}
          id={`${id}-note`}
          role={local.error ? "alert" : undefined}
        >
          {note()}
        </span>
      </Show>
    </label>
  )
}

/** Account color choice (5.4 `색 바꾸기`, 8 colors, names announced). */
export function ColorPicker(props: {
  readonly value: Account.Color
  readonly onChange: (color: Account.Color) => void
  readonly colors: readonly Account.Color[]
}) {
  const i18n = useI18n()
  return (
    <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label={i18n.t("own.acct.color")}>
      <For each={props.colors}>
        {(color) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === color}
            aria-label={i18n.t(`own.acct.colorName.${color}`)}
            title={i18n.t(`own.acct.colorName.${color}`)}
            class="grid h-7 w-7 place-items-center rounded-full border border-own-border bg-own-bg aria-checked:border-own-text"
            onClick={() => props.onChange(color)}
          >
            <span class="own-dot h-3 w-3" style={{ background: `var(--own-account-${color})` }} />
          </button>
        )}
      </For>
    </div>
  )
}

/** Short-lived status line for results of actions (`role=status`, cleared by the next action). */
export function createStatus() {
  const [message, setMessage] = createSignal<{ text: string; tone: "ok" | "danger" | "info" }>()
  return {
    message,
    ok: (text: string) => setMessage({ text, tone: "ok" }),
    error: (text: string) => setMessage({ text, tone: "danger" }),
    info: (text: string) => setMessage({ text, tone: "info" }),
    clear: () => setMessage(undefined),
  }
}

export type Status = ReturnType<typeof createStatus>

export function StatusLine(props: { readonly status: Status; readonly testid?: string }) {
  return (
    <Show when={props.status.message()}>
      {(message) => (
        <p
          class="m-0 text-[12.5px] leading-[18px]"
          classList={{
            "text-own-danger": message().tone === "danger",
            "text-own-ok": message().tone === "ok",
            "text-own-muted": message().tone === "info",
          }}
          role={message().tone === "danger" ? "alert" : "status"}
          data-testid={props.testid}
        >
          {message().text}
        </p>
      )}
    </Show>
  )
}

/** Copies text; resolves false when the clipboard is unavailable (no permission, insecure context). */
export async function copyText(text: string) {
  if (!navigator.clipboard?.writeText) return false
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}
