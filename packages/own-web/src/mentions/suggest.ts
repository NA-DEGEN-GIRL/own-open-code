// The composer's suggestion controller (03 §18.12 `@`, §18.13 `/`, §12 rules 5 and 9). First chunk, small: it detects
// the trigger on `input`, owns the keyboard while a list is open, applies a choice to the textarea and keeps the
// mention chips. The providers, ranking and the list UI are a lazy chunk (`./lazy`) loaded on the first trigger and
// prefetched when idle (03 §20.2 R5).
//
// IME (03 §12):
// - The list opens and closes from `input` events, composing or not; while composing only the list outside the
//   textarea changes (rule 5). Remote search waits for `compositionend` (rule 9, engine).
// - While composing, list keys (↑ ↓ Tab Esc) are not intercepted (rule 9, check 4/5): the IME keeps them.
// - Enter with an active item uses the `commitOnly` rule of the switcher/palette search (rule 8 exception): the Enter
//   that commits a composition only commits, the next Enter chooses. So a Korean query never sends the message and
//   never chooses a half-typed match.
// - A choice never edits the textarea while composing: a click during composition commits first (rule 6).
//
// The composer wires it (integrator): `keydown` first in its key handler (return when it says `true`), and forwards
// `keyup`, `compositionstart/end`, `input`, `focus`, `blur`, `click`; renders `<SuggestPopover>` and `<MentionChips>`;
// sends through `submitClient` and `send` (src/commands/run.ts).
import {
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  on,
  onCleanup,
  onMount,
  runWithOwner,
  untrack,
  type Accessor,
} from "solid-js"
import { nextFrame } from "@/data/frame"
import { useI18n, type Locale } from "@/i18n"
import { commitComposition, createImeEnter, isEnter, isImeKey, type ImeKeyEvent } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard/chord"
import type { CommandActions, CommandContext } from "@/commands/actions"
import { hasArguments } from "@/commands/catalog"
import {
  resolveClient,
  runClientCommand,
  sendComposed,
  type ComposedAttachments,
  type SendResult,
} from "@/commands/run"
import { createChipStore, type ChipStore } from "./chips"
import { MENTION_INTENT, type MentionIntent } from "./intents"
import type { SuggestEngine } from "./engine"
import { detectTrigger } from "./trigger"
import type { MentionChip, SuggestContext, SuggestItem, SuggestProvider, Trigger } from "./types"

export interface ComposerSuggestOptions {
  readonly element: Accessor<HTMLTextAreaElement | undefined>
  /** Runtime, route and the session's location directory (or the new session's folder). */
  readonly context: Accessor<SuggestContext | undefined>
  /** The composer's draft key (`composer/drafts` `draftKey`): chips are kept per draft. */
  readonly draftKey: Accessor<string>
  /** No lists (child session, `!` shell mode). */
  readonly disabled?: Accessor<boolean>
  /** Client command actions: `useCommandActions()` from `@/commands`. */
  readonly actions: CommandActions
  /** Providers added after the built-in ones (e.g. a future MCP prompt argument list). */
  readonly providers?: readonly SuggestProvider[]
  /** Shared chip store (tests); one per composer otherwise. */
  readonly chips?: ChipStore
  /** Locale of the list strings; the I18n context otherwise (tests pass it). */
  readonly locale?: Accessor<Locale>
}

let instances = 0

export function createComposerSuggest(options: ComposerSuggestOptions) {
  const owner = getOwner()
  const locale = options.locale ?? useI18n().locale
  const store = options.chips ?? createChipStore()
  const listbox = `own-sg-${++instances}`
  const [detected, setDetected] = createSignal<Trigger | undefined>(undefined, { equals: sameTrigger })
  /** Esc closes the list for this word while the user keeps typing it (not for a new or shortened word). */
  const [dismissed, setDismissed] = createSignal<{ readonly key: string; readonly query: string }>()
  const [focused, setFocused] = createSignal(false)
  const [composing, setComposing] = createSignal(false)
  const [activeID, setActiveID] = createSignal<string>()
  const [engine, setEngine] = createSignal<SuggestEngine>()

  const hasArgs = (name: string) => {
    const context = options.context()
    return hasArguments(context?.runtime, context?.directory, name)
  }
  const trigger = createMemo(() => {
    const current = detected()
    if (!current || !focused() || options.disabled?.()) return undefined
    const closed = dismissed()
    return closed && closed.key === dismissKey(current) && current.query.startsWith(closed.query) ? undefined : current
  })
  createEffect(() => {
    if (!detected()) setDismissed(undefined)
  })
  // A new query starts at its best match.
  createEffect(
    on(
      () => `${trigger()?.kind}\n${trigger()?.query}`,
      () => setActiveID(undefined),
      { defer: true },
    ),
  )

  // ---- the lazy chunk ----
  let loading: Promise<void> | undefined
  const load = () =>
    (loading ??= import("./lazy").then((module) => {
      const created = runWithOwner(owner, () =>
        module.createComposerEngine({
          locale,
          actions: options.actions,
          providers: options.providers,
          context: options.context,
          trigger,
          composing,
        }),
      )
      if (created) setEngine(created)
    }))
  createEffect(() => {
    if (trigger()) void load()
  })
  onMount(() => {
    const prefetch = () => void import("./lazy")
    if (typeof requestIdleCallback === "function") requestIdleCallback(prefetch, { timeout: 5_000 })
    else setTimeout(prefetch, 2_000)
    // Lines picked in the review or files tab (`Ctrl+Shift+L`, ./intents.ts) for the session on screen.
    const onMention = (event: Event) => {
      const detail = (event as CustomEvent<MentionIntent>).detail
      const context = options.context()
      if (!context || detail.serverKey !== context.serverKey || detail.sessionID !== context.sessionID) return
      store.add(options.draftKey(), detail.chip)
    }
    window.addEventListener(MENTION_INTENT, onMention)
    onCleanup(() => window.removeEventListener(MENTION_INTENT, onMention))
  })

  const items = () => (trigger() ? (engine()?.items() ?? []) : [])
  const activeItem = createMemo<SuggestItem | undefined>(() => {
    const list = items()
    const id = activeID()
    return (id ? list.find((item) => item.id === id) : undefined) ?? engine()?.preferred() ?? list[0]
  })
  const indexByID = createMemo(() => new Map(items().map((item, index) => [item.id, index])))
  const visible = createMemo(() => {
    const current = trigger()
    const loaded = engine()
    if (!current || !loaded) return false
    if (loaded.groups().length) return true
    // An `@query` that found nothing says so (after the search); a `/path` that is no command stays quiet.
    return current.kind === "mention" && !!current.query && loaded.searches()
  })

  // ---- detection: bounded scan, applied once per frame (PF2: the input handler only schedules) ----
  let pending: (() => void) | undefined
  const detectNow = () => {
    pending?.()
    pending = undefined
    const element = options.element()
    // A selection is being edited, or a `!` shell command (03 §4.6): no lists.
    if (!element || element.selectionStart !== element.selectionEnd || element.value.startsWith("!"))
      return setDetected(undefined)
    setDetected(detectTrigger(element.value, element.selectionEnd, hasArgs))
  }
  const refresh = () => {
    pending ??= nextFrame(() => {
      pending = undefined
      detectNow()
    })
  }
  onCleanup(() => pending?.())

  // ---- choosing ----
  const enter = createImeEnter({
    commitOnly: true,
    onEnter: () => {
      const item = activeItem()
      if (item) void choose(item)
    },
  })

  async function choose(item: SuggestItem) {
    const element = options.element()
    const loaded = engine()
    if (!element || !loaded) return
    // Rule 6: a click while composing commits first; the textarea is never edited during a composition (rule 5).
    if (composing()) await commitComposition(element, true)
    detectNow()
    const current = detected()
    if (!current) return
    const effect = loaded.select(item)
    if (!effect) return
    if (effect.text !== undefined) replace(element, current.start, current.end, effect.text)
    if (effect.chip) store.add(options.draftKey(), effect.chip)
    setActiveID(undefined)
    await effect.run?.()
  }

  function move(delta: number) {
    const list = items()
    if (!list.length) return
    const index = indexByID().get(activeItem()?.id ?? "") ?? 0
    setActiveID(list[(index + delta + list.length) % list.length]!.id)
  }

  function dismiss() {
    const current = trigger()
    if (current) setDismissed({ key: dismissKey(current), query: current.query })
  }

  function setText(value: string) {
    const element = options.element()
    if (!element) return
    element.focus()
    replace(element, 0, element.value.length, value)
  }

  const commandContext = (): CommandContext | undefined => {
    const context = options.context()
    return context
      ? {
          runtime: context.runtime,
          serverKey: context.serverKey,
          sessionID: context.sessionID,
          directory: context.directory,
        }
      : undefined
  }

  return {
    listbox,
    chips: store,
    /** Chips of the draft on screen. */
    chipList: () => store.list(options.draftKey()),
    removeChip: (id: string) => store.remove(options.draftKey(), id),
    addChip: (chip: MentionChip) => store.add(options.draftKey(), chip),
    trigger,
    engine,
    visible,
    items,
    activeItem,
    optionID: (item: SuggestItem) => `${listbox}-${indexByID().get(item.id) ?? 0}`,
    setActive: (id: string) => setActiveID(id),
    choose,
    dismiss,
    /** `aria-activedescendant` for the textarea. */
    activeDescendant: () => {
      const item = visible() ? activeItem() : undefined
      return item ? `${listbox}-${indexByID().get(item.id) ?? 0}` : undefined
    },

    // ---- DOM wiring (composer textarea) ----
    /** Call first in the textarea's keydown; `true` means handled (stop). */
    keydown(event: ImeKeyEvent): boolean {
      // A key in the same frame as the last `input` (fast typing, paste): see the text as it is now.
      if (pending) detectNow()
      if (!visible()) return false
      if (isEnter(event) && !event.shiftKey && !event.altKey) {
        const ime = isImeKey(event, composing())
        const loaded = engine()
        // A mention query still being typed or searched: Enter must not send it as text (commit only / wait).
        const holding = trigger()?.kind === "mention" && !!loaded?.searches() && (ime || !!loaded.loading())
        if (!activeItem() && !holding) return false
        enter.keydown(event)
        return true
      }
      if (isImeKey(event, composing())) return false
      if (event.ctrlKey || event.metaKey || event.altKey) return false
      const code = eventCode(event)
      if (code === "ArrowDown" || code === "ArrowUp") {
        if (!items().length) return false
        event.preventDefault()
        move(code === "ArrowDown" ? 1 : -1)
        return true
      }
      if (code === "Tab" && !event.shiftKey) {
        const item = activeItem()
        if (!item) return false
        event.preventDefault()
        void choose(item)
        return true
      }
      if (code === "Escape") {
        event.preventDefault()
        dismiss()
        return true
      }
      return false
    },
    keyup(event: Pick<ImeKeyEvent, "code" | "key">) {
      enter.keyup(event)
      const code = eventCode(event)
      if (code === "ArrowLeft" || code === "ArrowRight" || code === "Home" || code === "End") refresh()
    },
    compositionstart() {
      setComposing(true)
      enter.compositionstart()
    },
    compositionend() {
      setComposing(false)
      enter.compositionend()
      refresh()
    },
    input() {
      enter.input()
      refresh()
    },
    focus() {
      setFocused(true)
      refresh()
    },
    blur() {
      setFocused(false)
    },
    click() {
      refresh()
    },
    /**
     * The composer changed the text without an `input` event (the next-frame clear after a send, a draft swapped in
     * on a session change): look again.
     */
    reset() {
      setDismissed(undefined)
      refresh()
    },

    // ---- sending (src/commands/run.ts) ----
    /**
     * In the composer's submit, before `planSend`: runs a typed client command (`/compact`, `/model`, …). Returns
     * `undefined` when the text is not one; otherwise the composer clears the box and runs `after` (if any) once it
     * is cleared: `/agent` and `/skills` without an argument put `/agent ` back to open their list.
     */
    submitClient(text: string): { readonly after?: () => void } | undefined {
      const context = commandContext()
      const invocation = context ? resolveClient(text, context) : undefined
      if (!context || !invocation) return undefined
      const key = options.draftKey()
      const back = runClientCommand(invocation, context, options.actions, (chip) => store.add(key, chip))
      return back === undefined ? {} : { after: () => setText(back) }
    },
    /**
     * Sends a prompt or a server command with the chips of `draftKey` (taken now, put back when the send fails;
     * the composer restores the text). `draftKey` defaults to the draft on screen; pass the new-session draft's key
     * when a created session sends its first message.
     */
    async send(input: {
      readonly sessionID: string
      readonly text: string
      readonly delivery?: "steer" | "queue"
      readonly draftKey?: string
      /** Chips taken earlier (a message held during compact-then-switch, 03 §6.5); the draft's chips otherwise. */
      readonly chips?: readonly MentionChip[]
      /** The composer's attachments (src/attachments `prepare`), sent with the mention parts. */
      readonly attachments?: ComposedAttachments
    }): Promise<SendResult> {
      const context = commandContext()
      if (!context) throw new Error("composer suggestions: no server runtime")
      const key = input.draftKey ?? untrack(options.draftKey)
      const chips = input.chips ?? store.take(key)
      try {
        return await sendComposed({
          context: { ...context, sessionID: input.sessionID },
          text: input.text,
          chips,
          delivery: input.delivery,
          actions: options.actions,
          attachments: input.attachments,
        })
      } catch (error) {
        store.restore(key, chips)
        throw error
      }
    },
  }
}

export type ComposerSuggest = ReturnType<typeof createComposerSuggest>

function replace(element: HTMLTextAreaElement, start: number, end: number, text: string) {
  element.setRangeText(text, start, Math.min(end, element.value.length), "end")
  // The composer's own `input` handler saves the draft and resizes; ours re-detects the trigger.
  element.dispatchEvent(new Event("input", { bubbles: true }))
}

function dismissKey(trigger: Trigger) {
  return `${trigger.kind}:${trigger.start}:${trigger.kind === "argument" ? trigger.command : ""}`
}

function sameTrigger(a: Trigger | undefined, b: Trigger | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.query === b.query &&
    a.start === b.start &&
    a.end === b.end &&
    (a.kind !== "argument" || (b.kind === "argument" && a.command === b.command))
  )
}
