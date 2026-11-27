// OWN-PATCH(P-043) begin
export * as ClaudeTranscripts from "./transcripts.js"

// own (report §14, 02 §8.10.11): the transcript claude resumes is a copy derived from OpenCode's history, made the same
// way every time. Before claude resumes a conversation the history it has not seen is written into its transcript as
// real `user` and `assistant` entries (tool_use and tool_result blocks with their ids): appended in place when the
// transcript still ends where the record says, else on a fork of its last safe point (the bytes before it stay as
// claude wrote them, signed thinking included), else in a new transcript built from the history alone. The file is
// checked before every resume against what own last wrote or verified of it (the seal), and a transcript no record
// points to is removed.
import type { LanguageModelV3FunctionTool, LanguageModelV3Prompt } from "@ai-sdk/provider"
import { Effect } from "effect"
import type { ClaudeIO } from "./io.js"
import { SyncDecision } from "../sync/decide.js"
import { Fingerprint } from "../sync/fingerprint.js"
import { NativeTranscript } from "../sync/native.js"
import type { SessionRecord } from "../sync/record.js"

/** Replaced conversations kept for an undo (the newest first). Older ones are removed with their transcripts. */
export const KEEP = 4
/** An unreferenced transcript younger than this (the one-hour cache lifetime) is left alone by the sweep. */
export const ORPHAN_AGE_MS = 60 * 60_000
/** The version written into entries when no claude has reported its own yet. */
export const VERSION = "2.1.301"

export type Decision = ReturnType<typeof SyncDecision.decide>

export type Check =
  | { readonly kind: "ok"; readonly chain: ClaudeIO.Chain }
  | { readonly kind: "tail"; readonly chain: ClaudeIO.Chain }
  | { readonly kind: "gone" }
  | { readonly kind: "drifted" }

/**
 * The conversation to go on with: the current one when the prompt continues it in full, else a kept one the prompt
 * continues in full (an undo of a context reset brings its history back), else the current one as it is.
 */
export function pick(prompt: LanguageModelV3Prompt, record: SessionRecord.Record | undefined) {
  const decision = SyncDecision.decide(prompt, record)
  if (full(decision)) return { index: -1, decision }
  const best = (record?.previous ?? []).reduce<{ index: number; decision: Decision } | undefined>(
    (found, epoch, index) => {
      const candidate = SyncDecision.decide(prompt, epoch)
      if (!full(candidate) || (found && found.decision.start >= candidate.start)) return found
      return { index, decision: candidate }
    },
    undefined,
  )
  return best ?? { index: -1, decision }
}

/** The record with the kept conversation at `index` made current, and the current one kept in its place. */
export function swap(record: SessionRecord.Record, index: number): SessionRecord.Record {
  const previous = record.previous ?? []
  const chosen = previous[index]!
  return { ...chosen, previous: [epoch(record), ...previous.filter((_, at) => at !== index)] }
}

/** What the file holds against the record: the sealed prefix unchanged, the record's checkpoints in order to its end. */
export function verify(record: SessionRecord.Epoch, chain: ClaudeIO.Chain | undefined): Check {
  if (!chain || chain.messages.length === 0) return { kind: "gone" }
  const at = new Map(chain.messages.map((message, index) => [message.uuid, index]))
  const seal = record.seal
  if (seal) {
    const last = at.get(seal.last)
    if (
      last === undefined ||
      last + 1 !== seal.count ||
      NativeTranscript.chainDigest(chain.messages.slice(0, last + 1)) !== seal.digest
    )
      return { kind: "drifted" }
  }
  const marks = (record.history ?? []).flatMap((checkpoint) =>
    checkpoint.claudeMessageID ? [checkpoint.claudeMessageID] : [],
  )
  if (marks.length === 0) return { kind: "tail", chain }
  let previous = -1
  for (const mark of marks) {
    const index = at.get(mark)
    if (index === undefined || index < previous) return { kind: "tail", chain }
    previous = index
  }
  // An interrupted turn's drained reply follows the input claude received; otherwise the file ends at the record.
  if (!record.interrupted && previous !== chain.messages.length - 1) return { kind: "tail", chain }
  return { kind: "ok", chain }
}

/** The record sealed at its last checkpoint, as the chain holds it now (unchanged if the chain lacks it). */
export function sealed<R extends SessionRecord.Epoch>(record: R, chain: ClaudeIO.Chain): R {
  const last = record.history?.findLast((checkpoint) => checkpoint.claudeMessageID)?.claudeMessageID
  const index = last === undefined ? -1 : chain.messages.findIndex((message) => message.uuid === last)
  if (index < 0 || last === undefined) return record
  const prefix = chain.messages.slice(0, index + 1)
  return { ...record, seal: { last, count: index + 1, digest: NativeTranscript.chainDigest(prefix) } }
}

/** The record without its kept list, as it is kept in another record's list. */
export function epoch(record: SessionRecord.Record): SessionRecord.Epoch {
  const { previous: _, ...rest } = record
  return rest
}

/** Keeps `replaced` in front of the list (once), at most {@link KEEP}; returns the list and the epochs that fell off. */
export function keep(previous: readonly SessionRecord.Epoch[], replaced: SessionRecord.Epoch | undefined, current?: string) {
  const list = replaced ? [replaced, ...previous.filter((item) => item.claudeSessionID !== replaced.claudeSessionID)] : [...previous]
  const kept = list.filter((item) => item.claudeSessionID !== current).slice(0, KEEP)
  const dropped = list.filter((item) => !kept.includes(item) && item.claudeSessionID !== current)
  return { kept, dropped }
}

export interface Materialized {
  // The conversation claude resumes, or none when there is no history to give it (a new conversation).
  readonly record: SessionRecord.Epoch | undefined
  // Where the turn's input starts in the prompt.
  readonly start: number
  // The conversation the record replaced, worth keeping for an undo (none when its transcript is gone or changed).
  readonly replaced?: SessionRecord.Epoch
  // Transcripts to remove now: one that changed under the record.
  readonly discard: readonly string[]
}

export interface Deps {
  readonly io: ClaudeIO.Interface
  readonly transcripts: ClaudeIO.Transcripts
  readonly directory: string
  readonly version: () => Effect.Effect<string>
}

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toError })

export function make(deps: Deps) {
  const chainOf = (sessionID: string, folder: ClaudeIO.Folder) => attempt(() => deps.transcripts.chain(sessionID, folder))

  const writeAndSeal = Effect.fnUntraced(function* (
    record: SessionRecord.Epoch,
    folder: ClaudeIO.Folder,
    entries: readonly NativeTranscript.Entry[],
    replace: boolean,
  ) {
    if (entries.length > 0) yield* attempt(() => deps.transcripts.write(record.claudeSessionID, folder, entries, replace))
    const chain = yield* chainOf(record.claudeSessionID, folder)
    return chain ? sealed(record, chain) : record
  })

  /**
   * Makes the transcript hold the history up to the turn's input. `owned` is false for a record of another conversation
   * (a side call's or a fork's source): its transcript is only ever forked, never written.
   */
  const materialize = Effect.fn("ClaudeTranscripts.materialize")(function* (input: {
    readonly conversation: string | undefined
    readonly record: SessionRecord.Epoch | undefined
    readonly owned: boolean
    readonly decision: Decision
    readonly prompt: LanguageModelV3Prompt
    readonly tools: readonly LanguageModelV3FunctionTool[]
    readonly folder: ClaudeIO.Folder
  }) {
    const groups = Fingerprint.groups(input.prompt)
    const inputAt = NativeTranscript.inputStart(groups)
    const version = yield* deps.version()
    const record = input.record
    const build = (sessionId: string, from: number, parent?: NativeTranscript.Parent) =>
      NativeTranscript.build({
        sessionId,
        cwd: deps.directory,
        version,
        prompt: input.prompt,
        groups: NativeTranscript.between(groups, from, inputAt),
        tools: input.tools,
        parent,
      })
    const discard: string[] = []
    let check: Check | undefined

    // 1. The record's own conversation, which the prompt continues in full: written on in place.
    if (record && input.owned && (input.decision.kind === "continue" || input.decision.kind === "catch-up")) {
      check = verify(record, yield* chainOf(record.claudeSessionID, input.folder))
      if (check.kind === "ok") {
        if (input.decision.start >= inputAt)
          return { record: sealed(record, check.chain), start: input.decision.start, discard } satisfies Materialized
        if (!record.interrupted) {
          const parent = parentOf(check.chain)
          const built = yield* Effect.try({
            try: () => build(record.claudeSessionID, input.decision.start, parent),
            catch: toError,
          })
          const next = { ...record, history: [...(record.history ?? []), ...built.history], version }
          return {
            record: yield* writeAndSeal(next, input.folder, built.entries, false),
            start: inputAt,
            discard,
          } satisfies Materialized
        }
      }
      if (check.kind === "drifted") discard.push(record.claudeSessionID)
    }

    // 2. A fork of the record's transcript at its last safe point, with the rest written on. A transcript whose sealed
    // part changed is never forked.
    if (record && !check && input.decision.kind !== "fresh") {
      check = verify(record, yield* chainOf(record.claudeSessionID, input.folder))
      if (check.kind === "drifted" && input.owned) discard.push(record.claudeSessionID)
    }
    const usable = record && check?.kind !== "gone" && check?.kind !== "drifted" && input.decision.kind !== "fresh"
    if (record && usable) {
      const chain = check && "chain" in check ? check.chain : undefined
      const present = new Set(chain?.messages.map((message) => message.uuid) ?? [])
      // Checkpoints that are no longer in the transcript cannot be forked at.
      const boundary = SyncDecision.boundary(input.prompt, {
        ...record,
        history: record.history?.map((checkpoint) =>
          checkpoint.claudeMessageID && present.has(checkpoint.claudeMessageID) ? checkpoint : { hash: checkpoint.hash },
        ),
      })
      if (boundary) {
        // Unsupported attachments fail here, before anything is forked.
        yield* Effect.try({ try: () => build(record.claudeSessionID, boundary.start), catch: toError })
        const fork = yield* attempt(() => deps.io.fork(record.claudeSessionID, boundary.messageID, input.folder))
        if (fork) {
          const forked = yield* chainOf(fork.sessionID, input.folder)
          const built = yield* Effect.try({
            try: () => build(fork.sessionID, boundary.start, parentOf(forked)),
            catch: toError,
          }).pipe(
            Effect.tapError(() =>
              attempt(() => deps.io.remove(fork.sessionID, input.folder)).pipe(Effect.ignore),
            ),
          )
          const history = boundary.history.map((checkpoint) => ({
            hash: checkpoint.hash,
            claudeMessageID: checkpoint.claudeMessageID ? fork.messages.get(checkpoint.claudeMessageID) : undefined,
          }))
          const next = { claudeSessionID: fork.sessionID, history: [...history, ...built.history], version }
          return {
            record: yield* writeAndSeal(next, input.folder, built.entries, false),
            start: Math.max(boundary.start, inputAt),
            replaced: input.owned ? record : undefined,
            discard,
          } satisfies Materialized
        }
      }
    }

    // 3. A new transcript from the history alone.
    const replaced = input.owned && record && check?.kind !== "gone" && check?.kind !== "drifted" ? record : undefined
    const written = NativeTranscript.between(groups, 0, inputAt)
    if (written.length === 0) return { record: undefined, start: 0, replaced, discard } satisfies Materialized
    const sessionId = input.conversation ? NativeTranscript.sessionID(input.conversation, written) : crypto.randomUUID()
    const built = yield* Effect.try({ try: () => build(sessionId, 0), catch: toError })
    const next = { claudeSessionID: sessionId, history: built.history, version }
    return {
      record: yield* writeAndSeal(next, input.folder, built.entries, true),
      start: inputAt,
      replaced,
      discard: discard.filter((id) => id !== sessionId),
    } satisfies Materialized
  })

  /** Re-seals a record against its transcript as claude left it, when the file still matches the record. */
  const reseal = Effect.fn("ClaudeTranscripts.reseal")(function* (record: SessionRecord.Record, folder: ClaudeIO.Folder) {
    const check = verify(record, yield* chainOf(record.claudeSessionID, folder))
    return check.kind === "ok" ? sealed(record, check.chain) : undefined
  })

  /** Removes the transcripts of a folder that no record points to and no process uses, once they are old enough. */
  const sweep = Effect.fn("ClaudeTranscripts.sweep")(function* (
    configDir: string,
    referenced: ReadonlySet<string>,
    // OWN-PATCH(P-052) begin
    // Project folders with this prefix are SSH hosts' (02 §8.10.13): their hosts sweep them.
    skip?: string,
    // OWN-PATCH(P-052) end
    now = Date.now(),
  ) {
    const found = yield* attempt(() => deps.transcripts.list(configDir))
    // OWN-PATCH(P-052) begin
    const orphans = found.filter(
      (item) =>
        !referenced.has(item.sessionID) &&
        now - item.mtime > ORPHAN_AGE_MS &&
        (skip === undefined || !item.projectKey.startsWith(skip)),
    )
    // OWN-PATCH(P-052) end
    for (const orphan of orphans)
      yield* attempt(() => deps.transcripts.discard(configDir, orphan.projectKey, orphan.sessionID)).pipe(Effect.ignore)
    return orphans.map((orphan) => orphan.sessionID)
  })

  return { materialize, reseal, sweep }
}

function full(decision: Decision) {
  return decision.kind === "continue" || decision.kind === "catch-up"
}

// The entry new ones follow: the chain's last message, its time, and the tool calls of the reply it ends (claude writes
// a reply's blocks as several assistant entries in a row) when that reply waits for their results.
function parentOf(chain: ClaudeIO.Chain | undefined): NativeTranscript.Parent | undefined {
  const leaf = chain?.messages.at(-1)
  if (!chain || !leaf) return undefined
  const first = chain.messages.findLastIndex((message) => message.type !== "assistant") + 1
  const calls = chain.messages.slice(first).flatMap((message) => {
    const content = (message.message as { readonly content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return []
    return content.flatMap((block: { readonly type?: unknown; readonly id?: unknown }) =>
      block.type === "tool_use" && typeof block.id === "string" ? [block.id] : [],
    )
  })
  return { uuid: leaf.uuid, timestamp: chain.timestamps.get(leaf.uuid), calls }
}
// OWN-PATCH(P-043) end
