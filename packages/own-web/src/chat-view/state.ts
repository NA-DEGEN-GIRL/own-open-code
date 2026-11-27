// Chat view (03 §4.5 "대화 보기"): which meta information the transcript draws around the conversation itself. Every
// item is shown by default except the opt-in ones ({@link OPT_IN}: `날짜·시각`); `대화만 보기` hides them all and a
// second press brings back what was shown before. Presentational only: nothing here reaches a session, a prompt or the
// model (03 S8). Per viewer (localStorage, like the timeline preset and the theme), so it does not follow the user to
// another device; other windows of the same origin follow through the `storage` event. First-chunk safe: no session-ui
// import (see transcript/view-filter.ts).
import { createRoot, createSignal } from "solid-js"

/**
 * - usage: the turn footer's tokens, cache ratio and cost (and the step table)
 * - speed: output tokens per second and the time to the first token
 * - model: account and model in the footer, agent and model next to messages
 * - time: how long turns and steps took (`걸린 시간`)
 * - clock: when each message was sent and each answer finished, date and time (`날짜·시각`, UC 2026-10-18)
 * - thinking: thinking (reasoning) blocks
 * - tools: tool calls, shell runs and file edit cards
 * - subagents: subagent cards and refused-subagent chips
 * - markers: the account/model switch and compaction markers
 * - changes: `변경 n개 · 리뷰 →` and the big-file-folder note under the last turn
 */
export const CHAT_META = [
  "usage",
  "speed",
  "model",
  "time",
  "clock",
  "thinking",
  "tools",
  "subagents",
  "markers",
  "changes",
] as const
export type ChatMeta = (typeof CHAT_META)[number]

/**
 * Items that are off until turned on (UC 2026-10-18): a date and time on every message is noise for most reading, and
 * the elapsed times stay where they were. `기본으로` turns them off again.
 */
export const OPT_IN: ReadonlyArray<ChatMeta> = ["clock"]

const OPT_OUT = CHAT_META.filter((key) => !OPT_IN.includes(key))

export type ChatView = Readonly<Record<ChatMeta, boolean>>

export const CHAT_VIEW_KEY = "own.web.chat.view"

/**
 * What is stored: the hidden items of those shown by default (new ones are shown), the opt-in items turned on, and,
 * while `대화만 보기` is on, what it replaced. An older build reads `hidden` and `before` and ignores the rest.
 */
export interface ChatViewState {
  readonly hidden: readonly ChatMeta[]
  readonly shown?: readonly ChatMeta[]
  readonly before?: readonly ChatMeta[]
  readonly beforeShown?: readonly ChatMeta[]
}

const DEFAULT_STATE: ChatViewState = { hidden: [] }

export function parseChatView(value: unknown): ChatViewState {
  if (typeof value !== "string") return DEFAULT_STATE
  try {
    const stored = JSON.parse(value) as {
      hidden?: unknown
      shown?: unknown
      before?: unknown
      beforeShown?: unknown
    } | null
    const hidden = metaList(stored?.hidden, OPT_OUT)
    const shown = metaList(stored?.shown, OPT_IN)
    const before = stored?.before === undefined ? undefined : metaList(stored.before, OPT_OUT)
    const beforeShown = stored?.beforeShown === undefined ? undefined : metaList(stored.beforeShown, OPT_IN)
    return {
      hidden,
      ...(shown.length ? { shown } : {}),
      ...(before ? { before } : {}),
      ...(beforeShown?.length ? { beforeShown } : {}),
    }
  } catch {
    return DEFAULT_STATE
  }
}

export function viewOf(state: ChatViewState): ChatView {
  return Object.fromEntries(CHAT_META.map((key) => [key, on(state, key)])) as Record<ChatMeta, boolean>
}

/** Every meta item is hidden. */
export function isChatOnly(state: ChatViewState) {
  return CHAT_META.every((key) => !on(state, key))
}

/** Every item as it starts: the usual ones shown, the opt-in ones off. */
export function isDefault(state: ChatViewState) {
  return state.hidden.length === 0 && !state.shown?.length
}

export function withMeta(state: ChatViewState, key: ChatMeta, shown: boolean): ChatViewState {
  const hidden = OPT_OUT.filter((item) => (item === key ? !shown : state.hidden.includes(item)))
  const opted = OPT_IN.filter((item) => (item === key ? shown : !!state.shown?.includes(item)))
  return opted.length ? { hidden, shown: opted } : { hidden }
}

/** `대화만 보기`: on hides everything and keeps what was shown before; off brings that back. */
export function toggledChatOnly(state: ChatViewState): ChatViewState {
  if (isChatOnly(state)) {
    const hidden = state.before && state.before.length < OPT_OUT.length ? state.before : []
    return state.beforeShown?.length ? { hidden, shown: state.beforeShown } : { hidden }
  }
  return {
    hidden: [...OPT_OUT],
    before: state.hidden,
    ...(state.shown?.length ? { beforeShown: state.shown } : {}),
  }
}

const store = createRoot(() => {
  const [state, setState] = createSignal<ChatViewState>(parseChatView(read()))
  if (typeof window === "object")
    window.addEventListener("storage", (event) => {
      if (event.key === CHAT_VIEW_KEY) setState(parseChatView(event.newValue))
    })
  return { state, setState }
})

/** The stored state (reactive). */
export const chatViewState = store.state

/** What the transcript shows (reactive). */
export function chatView(): ChatView {
  return viewOf(store.state())
}

export function setChatMeta(key: ChatMeta, shown: boolean) {
  write(withMeta(store.state(), key, shown))
}

export function toggleChatOnly() {
  write(toggledChatOnly(store.state()))
}

/** `기본으로`: every usual item shown, the opt-in ones off. */
export function resetChatView() {
  write(DEFAULT_STATE)
}

function on(state: ChatViewState, key: ChatMeta) {
  return OPT_IN.includes(key) ? !!state.shown?.includes(key) : !state.hidden.includes(key)
}

function write(next: ChatViewState) {
  store.setState(next)
  try {
    localStorage.setItem(CHAT_VIEW_KEY, JSON.stringify(next))
  } catch {}
}

function read() {
  try {
    return localStorage.getItem(CHAT_VIEW_KEY)
  } catch {
    return null
  }
}

function metaList(value: unknown, keys: ReadonlyArray<ChatMeta>): ChatMeta[] {
  if (!Array.isArray(value)) return []
  return keys.filter((key) => value.includes(key))
}
