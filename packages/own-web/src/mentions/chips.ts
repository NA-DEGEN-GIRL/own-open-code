// Mention chips of a draft and the prompt parts they become (03 §4.6 "첨부와 @ 멘션은 텍스트 밖의 칩", §18.12).
// Chips are kept per draft key (session, or the new-session screen) in memory: switching sessions keeps each one's
// chips; a reload drops them (the text draft survives through composer/drafts).
//
// Sending: files and references → `files[]` with `file://` URIs (line ranges as `?start=&end=`, which core slices),
// agents → `agents[]`, skills → `skills[]`. For a prompt, a first line with the `@` tokens is added in front of the
// text and each part carries its `mention` range, so the model reads which agent or file the user meant (core puts
// `agents` only in message metadata) and the transcript can highlight them. MCP resources have no attachment form
// (core reads only `file:` and `data:` URIs), so they go in as a text line the model resolves with
// `read_mcp_resource`. A server command gets the parts without the token line: its text is the argument string.
import { createStore, produce } from "solid-js/store"
import { formatRange } from "./range"
import type { MentionChip } from "./types"

export interface MentionSpan {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface MentionParts {
  readonly text: string
  readonly files?: { readonly uri: string; readonly name?: string; readonly mention?: MentionSpan }[]
  readonly agents?: { readonly name: string; readonly mention?: MentionSpan }[]
  readonly skills?: { readonly id: string; readonly mention?: MentionSpan }[]
}

export function chipID(chip: MentionChip) {
  switch (chip.kind) {
    case "file":
      return `file:${chip.path}${formatRange(chip.range)}`
    case "reference":
      return `reference:${chip.name}`
    case "agent":
      return `agent:${chip.name}`
    case "skill":
      return `skill:${chip.id}`
    case "resource":
      return `resource:${chip.server}:${chip.uri}`
  }
}

/** The `@` token of a chip (also its label in the chip bar). */
export function chipToken(chip: MentionChip) {
  switch (chip.kind) {
    case "file":
      return `@${chip.path}${chip.directory ? "/" : ""}${formatRange(chip.range)}`
    case "reference":
    case "agent":
      return `@${chip.name}`
    case "skill":
      return `@${chip.id}`
    case "resource":
      return `@${chip.server}:${chip.name}`
  }
}

/** Builds the prompt parts. `inline: false` for a server command (the text is its argument string). */
export function mentionParts(input: {
  readonly text: string
  readonly chips: readonly MentionChip[]
  readonly directory: string | undefined
  readonly inline?: boolean
}): MentionParts {
  const chips = input.chips
  if (!chips.length) return { text: input.text }
  const inline = input.inline !== false
  const tokens = chips.filter((chip) => chip.kind !== "resource")
  const spans = new Map<MentionChip, MentionSpan>()
  const head = inline
    ? tokens.reduce((line, chip) => {
        const token = chipToken(chip)
        const start = line ? line.length + 1 : 0
        spans.set(chip, { start, end: start + token.length, text: token })
        return line ? `${line} ${token}` : token
      }, "")
    : ""
  const resources = chips.flatMap((chip) =>
    chip.kind === "resource" ? [`MCP resource "${chip.name}" (server: ${chip.server}, uri: ${chip.uri})`] : [],
  )
  // Choosing a mention at the end of the text leaves its leading space behind.
  const text = [head, input.text.trimEnd(), ...resources].filter(Boolean).join("\n")
  const seen = new Set<string>()
  const files = chips.flatMap((chip) => {
    if (chip.kind !== "file" && chip.kind !== "reference") return []
    const uri =
      chip.kind === "file"
        ? fileUri(input.directory, chip.path, chip.directory ? undefined : chip.range)
        : fileUri(input.directory, chip.path)
    if (seen.has(uri)) return []
    seen.add(uri)
    const name = chip.kind === "file" ? `${basename(chip.path)}${formatRange(chip.range)}` : chip.name
    return [{ uri, name, ...mention(spans.get(chip)) }]
  })
  const agents = chips.flatMap((chip) =>
    chip.kind === "agent" ? [{ name: chip.name, ...mention(spans.get(chip)) }] : [],
  )
  const skills = chips.flatMap((chip) => (chip.kind === "skill" ? [{ id: chip.id, ...mention(spans.get(chip)) }] : []))
  return {
    text,
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
    ...(skills.length ? { skills } : {}),
  }
}

function mention(span: MentionSpan | undefined): { mention?: MentionSpan } {
  return span ? { mention: span } : {}
}

/**
 * `file://` URI of a path relative to `directory` (or absolute). Every segment is percent-encoded, so `#`, `%`,
 * spaces and Hangul survive (own/FORK.md Windows `#` path pitfall); the drive colon stays for the server's
 * `fileURLToPath`.
 */
export function fileUri(directory: string | undefined, path: string, range?: { start: number; end?: number }) {
  const absolute = isAbsolute(path) || !directory ? path : `${directory.replace(/[\\/]+$/, "")}/${path}`
  const normalized = absolute.replaceAll("\\", "/")
  const rooted = /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized
  const encoded = rooted
    .split("/")
    .map((segment, index) => (index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/")
  const query = range ? `?start=${range.start}&end=${range.end ?? range.start}` : ""
  return `file://${encoded}${query}`
}

function isAbsolute(path: string) {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)
}

function basename(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "")
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed
}

/** Chips per draft key. Duplicates (same file and range, same agent…) are ignored. */
export function createChipStore() {
  const [state, setState] = createStore<{ byKey: Record<string, MentionChip[] | undefined> }>({ byKey: {} })
  const api = {
    list: (key: string): readonly MentionChip[] => state.byKey[key] ?? [],
    add(key: string, chip: MentionChip) {
      const id = chipID(chip)
      if (api.list(key).some((existing) => chipID(existing) === id)) return false
      setState("byKey", key, (list) => [...(list ?? []), chip])
      return true
    },
    remove(key: string, id: string) {
      setState(
        "byKey",
        key,
        produce((list) => {
          const index = list?.findIndex((chip) => chipID(chip) === id) ?? -1
          if (index >= 0) list!.splice(index, 1)
        }),
      )
    },
    clear(key: string) {
      if (state.byKey[key]?.length) setState("byKey", key, [])
    },
    /** Removes and returns the chips of a draft (at send); `restore` puts them back if the send failed. */
    take(key: string) {
      const chips = [...api.list(key)]
      api.clear(key)
      return chips
    },
    restore(key: string, chips: readonly MentionChip[]) {
      chips.forEach((chip) => api.add(key, chip))
    },
    /** Moves the new-session screen's chips to the session it just created. */
    move(from: string, to: string) {
      const chips = api.take(from)
      chips.forEach((chip) => api.add(to, chip))
    },
  }
  return api
}

export type ChipStore = ReturnType<typeof createChipStore>
