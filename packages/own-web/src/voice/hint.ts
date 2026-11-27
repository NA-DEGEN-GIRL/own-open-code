// The hint `voice.transcribe` passes to the recognition service (02 §3.9): technical words it would otherwise spell
// as speech — the project's top-level file names and the identifiers that come up most in the conversation and the
// draft. ASCII terms only (Korean is what the service recognizes anyway), deduplicated, cut at whole terms.
import type { SessionMessageInfo } from "@opencode/client"
import type { ServerRuntime } from "@/data"
import { documentsOf } from "@/find/model"

/** Well under the service limit (`Voice.MAX_HINT_CHARS`, 600): a long prompt does not help recognition. */
export const HINT_CHARS = 400
const MAX_NAMES = 30
const IDENTIFIER = /[A-Za-z_$][\w$]*(?:[.\-/:][A-Za-z_$][\w$]*)*/g

/** A term that looks like code: camelCase, snake_case, dotted, dashed, with digits, or an acronym. */
export function technical(term: string) {
  if (term.length < 3 || term.length > 48) return false
  return /[a-z][A-Z]|[_.\-/:$]|\d|^[A-Z]{2,}$/.test(term)
}

export function buildHint(input: {
  readonly names: readonly string[]
  readonly texts: readonly string[]
  readonly max?: number
}) {
  const max = input.max ?? HINT_CHARS
  const names = input.names.filter((name) => name && !name.startsWith(".") && name.length <= 48).slice(0, MAX_NAMES)
  const counts = new Map<string, number>()
  for (const text of input.texts)
    for (const match of text.matchAll(IDENTIFIER))
      if (technical(match[0])) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
  const identifiers = [...counts].toSorted((a, b) => b[1] - a[1]).map(([term]) => term)
  const terms = [...new Set([...names, ...identifiers])]
  const kept: string[] = []
  let length = 0
  for (const term of terms) {
    const next = length + (kept.length ? 2 : 0) + term.length
    if (next > max) continue
    kept.push(term)
    length = next
  }
  return kept.join(", ")
}

/** Base names of a `file.list` answer (`{path, type}` rows). */
export function namesOf(entries: readonly { readonly path: string }[]) {
  return entries.map((entry) => entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "").filter(Boolean)
}

/** The texts of the last loaded messages of a session (user messages and assistant prose). */
export function messageTexts(messages: readonly SessionMessageInfo[], last = 20) {
  return documentsOf(messages.slice(-last)).map((doc) => doc.text)
}

const LIST_TTL_MS = 5 * 60_000
/** A slow folder listing never holds the recognition up for long. */
const LIST_WAIT_MS = 1_500
const listed = new Map<string, { readonly at: number; readonly names: readonly string[] }>()

/**
 * The composer's hint: the session folder's top-level names (one `file.list`, cached 5 minutes per folder), the draft
 * and the session's last loaded messages.
 */
export async function projectHint(input: {
  readonly runtime: ServerRuntime | undefined
  readonly directory: string | undefined
  readonly sessionID: string | undefined
  readonly draft: string
}) {
  const runtime = input.runtime
  const names = runtime && input.directory ? await topLevelNames(runtime, input.directory) : []
  const messages = runtime && input.sessionID ? runtime.data.session.message.list(input.sessionID) : []
  return buildHint({ names, texts: [input.draft, ...messageTexts(messages)] })
}

async function topLevelNames(runtime: ServerRuntime, directory: string) {
  const key = `${runtime.key}\u0000${directory}`
  const cached = listed.get(key)
  if (cached && Date.now() - cached.at < LIST_TTL_MS) return cached.names
  const listing = Promise.resolve()
    .then(() => runtime.client().file.list({ location: { directory } }))
    .then((output) => namesOf(output.data))
  const names = await Promise.race([
    listing,
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), LIST_WAIT_MS)),
  ]).catch((): string[] => [])
  if (names.length) listed.set(key, { at: Date.now(), names })
  return names
}
