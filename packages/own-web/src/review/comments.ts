// Diff line comments that go with the next prompt (03 §19.1, [gap] 17). The review tab adds them from session-ui's
// line comment editor (SessionReviewFilePreviewV2 → ./v2/line-comment-annotations-v2 → @opencode/ui line-comment);
// the composer shows them as chips above the box and sends them with the next prompt of that session, the way
// upstream does (packages/app/src/composer/comments.tsx for the store, composer/request.ts for the request):
//
//   text      the typed text, then one `The user made the following comment regarding lines 10 through 12 of
//             src/a.ts: …` line per comment (vendored comment-note.ts `formatCommentNote`, which the transcript
//             and upstream parse back);
//   files     the commented lines of the current file as a `file://…?start=&end=` part (core slices them), except
//             for comments on removed lines, which the current file no longer has, and comments whose repository
//             root was not known (review paths are root-relative; a wrong absolute path would fail the prompt);
//   metadata  `displayText` and `comments` (`readPromptPresentation`), so the message shows the typed text and the
//             comments as session-ui comment cards (`./comment-card`).
//
// Per session (server key + session id), kept in localStorage as a per-viewer convenience (a pending comment is
// like a draft; losing it only loses the draft). Sending takes them off; a failed send puts them back.
import type { JsonValue, SessionMessageUser } from "@opencode/client"
import { batch, createRoot, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerKey } from "@/data"
import { fileUri } from "@/mentions/chips"
import type { ReviewMode } from "./model"
import { reviewKey } from "./state"
import { formatCommentNote, parseCommentNote, readPromptPresentation, type PromptComment } from "./vendor/comment-note"

/** pierre's `SelectedLineRange` (lines of the diff side the selection started and ended on). */
export interface LineSelection {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

export interface ReviewComment {
  readonly id: string
  /** Repository-relative path, as the review lists it. */
  readonly file: string
  readonly selection: LineSelection
  readonly comment: string
  /** The selected lines' text, for the message's comment card. */
  readonly preview?: string
  /** The review mode it was written in, so opening it shows the same diff. */
  readonly mode?: ReviewMode
  /** The repository root (absolute) when it was written, for the commented lines' file part. */
  readonly root?: string
  readonly time: number
}

const STORAGE_KEY = "own.web.review.comments"
/** Sessions whose pending comments are kept (upstream keeps 20 comment sessions). */
const MAX_SESSIONS = 20
const SAVE_MS = 500

const state = createRoot(() => {
  const [comments, setComments] = createStore<Record<string, ReviewComment[]>>(read())
  const [focus, setFocus] = createSignal<{ readonly key: string; readonly file: string; readonly id: string }>()
  const save = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const persist = () => {
    if (save.timer !== undefined) clearTimeout(save.timer)
    save.timer = setTimeout(() => {
      save.timer = undefined
      write(comments)
    }, SAVE_MS)
  }
  return { comments, setComments, focus, setFocus, persist }
})

const EMPTY: readonly ReviewComment[] = []

export const reviewComments = {
  key: reviewKey,
  /** Pending comments of a session, oldest first. */
  list: (serverKey: ServerKey, sessionID: string | undefined): readonly ReviewComment[] =>
    (sessionID && state.comments[reviewKey(serverKey, sessionID)]) || EMPTY,
  add(serverKey: ServerKey, sessionID: string, input: Omit<ReviewComment, "id" | "time">) {
    const key = reviewKey(serverKey, sessionID)
    const next: ReviewComment = { ...input, selection: { ...input.selection }, id: newID(), time: Date.now() }
    batch(() => {
      state.setComments(key, (list) => [...(list ?? []), next])
      state.setFocus({ key, file: next.file, id: next.id })
    })
    state.persist()
    return next
  },
  update(serverKey: ServerKey, sessionID: string, id: string, comment: string, preview?: string) {
    const key = reviewKey(serverKey, sessionID)
    if (!state.comments[key]) return
    state.setComments(key, (list) =>
      list.map((item) => (item.id === id ? { ...item, comment, ...(preview ? { preview } : {}) } : item)),
    )
    state.persist()
  },
  remove(serverKey: ServerKey, sessionID: string, id: string) {
    const key = reviewKey(serverKey, sessionID)
    batch(() => {
      state.setComments(key, (list) => (list ?? []).filter((item) => item.id !== id))
      if (state.focus()?.id === id) state.setFocus(undefined)
    })
    state.persist()
  },
  /** Takes the session's comments off for a send (the composer's send path). */
  take(serverKey: ServerKey, sessionID: string | undefined): readonly ReviewComment[] {
    if (!sessionID) return EMPTY
    const key = reviewKey(serverKey, sessionID)
    const taken = state.comments[key] ?? EMPTY
    if (!taken.length) return EMPTY
    state.setComments(produce((all: Record<string, ReviewComment[]>) => void delete all[key]))
    state.persist()
    return taken
  },
  /** Puts comments back after a failed send, in front of any added meanwhile. */
  restore(serverKey: ServerKey, sessionID: string, comments: readonly ReviewComment[]) {
    if (!comments.length) return
    const key = reviewKey(serverKey, sessionID)
    state.setComments(key, (list) => [
      ...comments,
      ...(list ?? []).filter((item) => !comments.some((restored) => restored.id === item.id)),
    ])
    state.persist()
  },
  /** The comment to scroll to in the review tab (a chip was clicked, or one was just added). */
  focus: (serverKey: ServerKey, sessionID: string | undefined) => {
    const current = state.focus()
    return current && sessionID && current.key === reviewKey(serverKey, sessionID)
      ? { file: current.file, id: current.id }
      : undefined
  },
  setFocus(serverKey: ServerKey, sessionID: string, focus: { readonly file: string; readonly id: string } | null) {
    state.setFocus(focus ? { key: reviewKey(serverKey, sessionID), ...focus } : undefined)
  },
}

/** The lines a comment refers to, lowest first (`10-12`, or `10`). */
export function commentLines(selection: LineSelection) {
  const start = Math.min(selection.start, selection.end)
  const end = Math.max(selection.start, selection.end)
  return start === end ? `${start}` : `${start}-${end}`
}

/** A comment on removed lines: its line numbers are the old file's. */
export function onRemovedLines(selection: LineSelection) {
  return (selection.endSide ?? selection.side) === "deletions"
}

// ---------------------------------------------------------------------------------------------------------------
// Sending

export interface CommentedParts {
  readonly text: string
  readonly files: readonly { readonly uri: string; readonly name?: string }[]
  readonly metadata?: { [key: string]: JsonValue }
}

/**
 * Adds the comments to what the composer sends (the attachment store's `prepare` result, or `{ text, files: [] }`):
 * one note line per comment after the text, the commented lines as file parts, and `comments` in the metadata next
 * to `displayText` (and the attachments' `attachments`, kept as they are).
 */
export function withReviewComments(
  parts: CommentedParts,
  input: {
    /** What the user typed (without attachment lines): the message's `displayText`. */
    readonly typed: string
    readonly comments: readonly ReviewComment[]
  },
): CommentedParts {
  if (!input.comments.length) return parts
  const prompts = input.comments.map(promptComment)
  const seen = new Set(parts.files.map((file) => file.uri))
  const files = input.comments.flatMap((comment) => {
    if (!comment.root || onRemovedLines(comment.selection)) return []
    const start = Math.min(comment.selection.start, comment.selection.end)
    const end = Math.max(comment.selection.start, comment.selection.end)
    const uri = fileUri(comment.root, comment.file, { start, end })
    if (seen.has(uri)) return []
    seen.add(uri)
    return [{ uri, name: `${basename(comment.file)}#L${commentLines(comment.selection)}` }]
  })
  const metadata = parts.metadata ?? {}
  return {
    text: [...(parts.text.trim() ? [parts.text] : []), ...prompts.map(formatCommentNote)].join("\n"),
    files: [...parts.files, ...files],
    metadata: {
      ...metadata,
      displayText: input.typed,
      comments: prompts.map((item) => jsonComment(item)),
      attachments: Array.isArray(metadata.attachments) ? metadata.attachments : [],
    },
  }
}

function promptComment(comment: ReviewComment): PromptComment {
  const start = Math.min(comment.selection.start, comment.selection.end)
  const end = Math.max(comment.selection.start, comment.selection.end)
  return {
    path: comment.file,
    selection: { startLine: start, startChar: 0, endLine: end, endChar: 0 },
    comment: comment.comment,
    preview: comment.preview,
    origin: "review",
  }
}

function jsonComment(comment: PromptComment): { [key: string]: JsonValue } {
  return {
    path: comment.path,
    comment: comment.comment,
    ...(comment.selection ? { selection: { ...comment.selection } } : {}),
    ...(comment.preview !== undefined ? { preview: comment.preview } : {}),
    ...(comment.origin ? { origin: comment.origin } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Showing a sent message

export interface UserPresentation {
  readonly displayText?: string
  readonly comments?: { path: string; comment: string; selection?: { startLine: number; endLine: number } }[]
  readonly references?: { name: string; mime: string; path: string }[]
}

/**
 * session-ui `presentation` with the message's comments (comment cards above its text, like upstream's timeline):
 * from the metadata this module wrote, or a single note line typed or sent elsewhere (`parseCommentNote`). `base`
 * is the attachments module's presentation (typed text, attachment cards).
 */
export function withCommentPresentation(
  message: Pick<SessionMessageUser, "text" | "metadata">,
  base: UserPresentation | undefined,
): UserPresentation | undefined {
  const presentation = readPromptPresentation(message.metadata)
  const parsed = presentation ? undefined : parseCommentNote(message.text)
  const comments = presentation?.comments ?? (parsed ? [parsed] : [])
  if (!comments.length) return base
  return {
    ...base,
    displayText: base?.displayText ?? presentation?.displayText,
    comments: comments.map((item) => ({
      path: item.path,
      comment: item.comment,
      ...(item.selection
        ? { selection: { startLine: item.selection.startLine, endLine: item.selection.endLine } }
        : {}),
    })),
  }
}

// ---------------------------------------------------------------------------------------------------------------

function newID() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

function basename(path: string) {
  return path.slice(path.lastIndexOf("/") + 1)
}

function read(): Record<string, ReviewComment[]> {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).flatMap(([key, value]) => {
        const list = Array.isArray(value) ? value.filter(isComment) : []
        return list.length ? [[key, list]] : []
      }),
    )
  } catch {
    return {}
  }
}

function write(comments: Record<string, ReviewComment[]>) {
  // The most recently touched sessions win when there are more than MAX_SESSIONS.
  const entries = Object.entries(comments)
    .filter(([, list]) => list.length > 0)
    .map(([key, list]) => [key, list.map((item) => ({ ...item }))] as const)
    .toSorted((a, b) => Math.max(...b[1].map((item) => item.time)) - Math.max(...a[1].map((item) => item.time)))
    .slice(0, MAX_SESSIONS)
  try {
    if (entries.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {}
}

function isComment(value: unknown): value is ReviewComment {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<ReviewComment>
  return (
    typeof item.id === "string" &&
    typeof item.file === "string" &&
    typeof item.comment === "string" &&
    typeof item.time === "number" &&
    !!item.selection &&
    typeof item.selection.start === "number" &&
    typeof item.selection.end === "number"
  )
}
