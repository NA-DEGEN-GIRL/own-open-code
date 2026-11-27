export * as PrefixWatch from "./prefix-watch.js"

import type { SessionContext, SessionModelRequest } from "@opencode/plugin/promise/session"
import type { Model } from "@opencode/schema/model"
import { OwnID, type Ledger, type Switch } from "@own/protocol"
import { Hash, Prefix } from "@own/runtime"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { Resets } from "../resets.js"
import type { Capture } from "./capture.js"
import type { Telemetry } from "./telemetry.js"

/**
 * Opt-in per-block prefix fingerprint of own-slot primary requests (P0-2b, 02 §7.8). Off by default: it runs only for
 * the sessions and slots a wire evidence capture window records (`diagnostics.capture.*`); otherwise the request hook
 * asks the capture whether it records them and returns, hashing nothing.
 *
 * The `context` hook, after own's shaping (identity line, strip rules; cache hints are folded out by name), splits the
 * request into blocks (`Prefix.blocks`: the tools, each system part, each message). The `model.request` that follows
 * carries the request's kind, so it settles the comparison: a primary request is compared with the previous primary
 * request of its session and slot. The first block that differs is attributed to what own knows changed in between
 * (compaction, revert, context reset or its undo, model or variant, agent, tool set; for a message also a strip rule, core's image cut or an
 * instruction update; {@link Ledger.PrefixCause}), and each primary request writes one `prefix` line `{cause, lcp, …}`
 * to `events.jsonl` through the ledger writer. A divergence nothing explains raises `prefix_diverged` (info).
 *
 * What it sees is the hook's view: plugins whose `context` hook runs after own-accounts (own-computer-use prunes
 * screenshots there) and core's protocol lowering are not part of it. Core's image cut is (02 §4.3 D8): it runs after
 * the hooks, so the watch works out where it falls ({@link IMAGE_TRIGGER_BYTES}).
 */

/** Sessions and slots whose last fingerprint is kept; the oldest go first. */
export const MEMORY_KEYS = 256
/**
 * Core's request image budget (`boundImages`, `core/src/session/model-request.ts`): once the inline images of a request
 * pass 25 MiB, the oldest are replaced by a note until at most 15 MiB remain. It runs after the hooks.
 */
export const IMAGE_TRIGGER_BYTES = 25 * 1024 * 1024
export const IMAGE_TARGET_BYTES = 15 * 1024 * 1024

export interface Api {
  /**
   * The `context`, `compaction` and `generate` hook of an own slot, after own's shaping: the request's blocks for the
   * `model.request` that follows. While no capture window records the session and slot, it forgets the slot's last
   * fingerprint instead.
   */
  shaped(event: SessionContext, facts: Facts): void
  /** `model.request`: compares a primary request; a compaction request moves the session's compaction epoch. */
  settle(event: SessionModelRequest): void
  /**
   * A local event that explains the next divergence: compaction ended, revert committed, context reset delivered or
   * undone, instructions updated.
   */
  onEvent(event: Module.OpenCodeEvent, reset?: Resets.ColdPoint): void
}

export interface Facts {
  readonly accountID: string
  /** The strip rules that rewrote this request (02 §4.4); empty when none did. */
  readonly strip: ReadonlyArray<Switch.StripRule>
}

export interface Input {
  readonly alert: (input: Telemetry.AlertInput) => void
  /** The capture whose windows switch the watch on. */
  readonly capture: () => Capture.Api
}

type Mark = "compaction" | "revert" | "reset" | "reset-undo" | "instructions"
type Epochs = Readonly<Record<Mark, number>>

/** Where core's image cut falls in a request. */
interface Images {
  /** Images core leaves out, oldest first. */
  readonly dropped: number
  /** The message index of each image, in request order; empty while nothing is cut. */
  readonly messages: ReadonlyArray<number>
}

interface Shaped {
  readonly accountID: string
  readonly modelID: Model.ID
  readonly variant: Model.VariantID | null
  readonly agent: string
  readonly blocks: ReadonlyArray<Prefix.Block>
  /** Blocks before the first message: the tools and the system parts. */
  readonly offset: number
  readonly images: Images
  /** Hash of the strip rules that rewrote the request, `null` when none did. */
  readonly strip: string | null
  readonly ms: number
}

interface Snapshot extends Shaped {
  readonly epochs: Epochs
}

interface Verdict {
  readonly cause: Ledger.PrefixCause
  readonly lcp: number
  readonly at: Ledger.PrefixBlock | null
}

const NO_EPOCHS: Epochs = { compaction: 0, revert: 0, reset: 0, "reset-undo": 0, instructions: 0 }

export function create(deps: Deps, input: Input): Api {
  const log = deps.log.child("prefix")
  // The latest shaped request per (session, slot, model, agent) until its `model.request` (auth's D10 pairing).
  const pending = new Map<string, Shaped>()
  // The last primary request per (session, slot).
  const snapshots = new Map<string, Snapshot>()
  // Explaining events per session, counted from its first recorded request.
  const epochs = new Map<string, Epochs>()

  const mark = (sessionID: string, which: Mark) => {
    const current = epochs.get(sessionID)
    if (current) remember(epochs, sessionID, { ...current, [which]: current[which] + 1 })
  }

  const record = (event: SessionModelRequest, next: Shaped, verdict: Verdict, previous: number | null, ms: number) => {
    const data: Ledger.Prefix = {
      cause: verdict.cause,
      lcp: verdict.lcp,
      previous,
      blocks: next.blocks.length,
      at: verdict.at,
      modelID: next.modelID,
      variant: next.variant,
      agent: next.agent,
      ms: Math.round(ms * 100) / 100,
    }
    const now = deps.clock.now()
    void deps.runtime.ledger
      .event({
        eid: `prefix_${OwnID.ulid(now)}`,
        ts: now,
        type: "prefix",
        accountID: next.accountID,
        providerID: event.model.providerID,
        sessionID: event.sessionID,
        data: { ...data },
      })
      .catch((error: unknown) => log.warn("prefix_record_failed", { error }))
    if (verdict.cause !== "unexplained") return
    input.alert({
      code: "prefix_diverged",
      severity: "info",
      sessionID: event.sessionID,
      accountID: next.accountID,
      subject: [event.model.providerID, next.modelID, verdict.at].join("|"),
      fields: {
        providerID: event.model.providerID,
        modelID: next.modelID,
        agent: next.agent,
        at: verdict.at ?? "",
        lcp: String(verdict.lcp),
        previous: String(previous),
      },
      message:
        `A request on ${event.model.providerID} (${next.modelID}) rewrote its cached prefix from block ` +
        `${verdict.lcp} (${verdict.at}) of ${previous}, and no compaction, revert, model, agent, strip rule, image cut, ` +
        `instruction or tool-set change explains it.`,
    })
  }

  return {
    shaped: (event, facts) => {
      const started = performance.now()
      if (!input.capture().recording(event.sessionID, event.model.providerID)) {
        // A request shaped while a window ran whose `model.request` never came must not settle outside the window.
        pending.delete(requestKey(event))
        snapshots.delete(slotKey(event.sessionID, event.model.providerID))
        return
      }
      remember(pending, requestKey(event), {
        accountID: facts.accountID,
        modelID: event.model.id,
        variant: event.model.variant ?? null,
        agent: event.agent,
        blocks: Prefix.blocks(event),
        offset: 1 + event.system.length,
        images: imageCut(event.messages),
        strip: facts.strip.length === 0 ? null : Hash.stable(facts.strip),
        // Last: the members above are the work it times.
        ms: performance.now() - started,
      })
    },

    settle: (event) => {
      if (event.kind === "title") return
      const key = requestKey(event)
      const next = pending.get(key)
      pending.delete(key)
      if (event.kind === "compaction") return mark(event.sessionID, "compaction")
      if (event.kind !== "primary" || !next) return
      const started = performance.now()
      const slot = slotKey(event.sessionID, event.model.providerID)
      const previous = snapshots.get(slot)
      const current = epochs.get(event.sessionID) ?? NO_EPOCHS
      const snapshot = { ...next, epochs: current }
      remember(epochs, event.sessionID, current)
      remember(snapshots, slot, snapshot)
      const verdict = previous ? compare(previous, snapshot) : FIRST
      record(event, next, verdict, previous?.blocks.length ?? null, next.ms + performance.now() - started)
    },

    onEvent: (event, reset) => {
      if (event.type === "session.compaction.ended") mark(event.data.sessionID, "compaction")
      if (event.type === "session.revert.committed") mark(event.data.sessionID, "revert")
      if (event.type === "session.instructions.updated") mark(event.data.sessionID, "instructions")
      if (reset !== undefined) mark(reset.sessionID, reset.kind === "reset" ? "reset" : "reset-undo")
    },
  }
}

const FIRST: Verdict = { cause: "first", lcp: 0, at: null }

/**
 * The first block of `previous` that `next` does not repeat, and what own knows explains it. Core's image cut is
 * applied on top of the hook's view: a cut that moved rewrites the request from the first image it newly drops.
 */
function compare(previous: Snapshot, next: Snapshot): Verdict {
  const shared = Prefix.lcp(previous.blocks, next.blocks)
  const image = imageShift(previous.images, next)
  const lcp = image === undefined ? shared : Math.min(shared, image)
  if (lcp >= previous.blocks.length) return { cause: "append", lcp, at: null }
  const at = previous.blocks[lcp]?.kind ?? null
  return { cause: explain(previous, next, at), lcp, at }
}

function explain(previous: Snapshot, next: Snapshot, at: Ledger.PrefixBlock | null): Ledger.PrefixCause {
  if (previous.epochs.compaction !== next.epochs.compaction) return "compaction"
  if (previous.epochs.revert !== next.epochs.revert) return "revert"
  if (previous.epochs.reset !== next.epochs.reset) return "reset"
  if (previous.epochs["reset-undo"] !== next.epochs["reset-undo"]) return "reset-undo"
  if (previous.modelID !== next.modelID || previous.variant !== next.variant) return "model"
  if (previous.agent !== next.agent) return "agent"
  // Otherwise the tool definitions or system changed mid-session: D10's `toolset_changed` (02 §4.3) for this request.
  // Strip rules, the image cut and instruction updates only ever touch messages.
  if (at === "tools" || at === "system") return "toolset"
  if (previous.strip !== next.strip) return "strip"
  if (previous.images.dropped !== next.images.dropped) return "image-trim"
  if (previous.epochs.instructions !== next.epochs.instructions) return "instructions"
  return "unexplained"
}

/** The block of the first image whose cut state differs between the two requests, if the cut moved. */
function imageShift(previous: Images, next: Pick<Snapshot, "images" | "offset">) {
  if (previous.dropped === next.images.dropped) return undefined
  const first = Math.min(previous.dropped, next.images.dropped)
  const message = next.images.messages[first] ?? previous.messages[first]
  return message === undefined ? undefined : next.offset + message
}

type Message = SessionContext["messages"][number]
type Part = Message["content"][number]

/**
 * Mirror of core's image cut (`boundImages`): every image in request order (media parts and image files of tool
 * results), sized like core sizes them, and how many of the oldest it replaces. Core counts only what is still an image
 * after `unsupportedParts`, so images sent to a text-only model count here but not there (25 MiB of them is rare).
 * Since upstream v2.1 core replays the images in order and drops the oldest down to the target whenever the kept bytes
 * pass the trigger, so the cut moves only every (trigger - target) bytes.
 */
function imageCut(messages: ReadonlyArray<Message>): Images {
  const images = messages.flatMap((message, index) =>
    message.content.flatMap((part) => imageSizes(part).map((size) => ({ index, size }))),
  )
  const cut = images.reduce(
    (state, image) => {
      const kept = state.kept + image.size
      if (kept <= IMAGE_TRIGGER_BYTES) return { dropped: state.dropped, kept }
      const next = { dropped: state.dropped, kept }
      while (next.kept > IMAGE_TARGET_BYTES) next.kept -= images[next.dropped++]!.size
      return next
    },
    { dropped: 0, kept: 0 },
  )
  if (cut.dropped === 0) return { dropped: 0, messages: [] }
  return { dropped: cut.dropped, messages: images.map((image) => image.index) }
}

function imageSizes(part: Part): number[] {
  if (part.type === "media") return isImage(part.media.mediaType) ? [inlineBytes(part.media.source)] : []
  if (part.type !== "tool-result" || part.result.type !== "content") return []
  return part.result.value.flatMap((item) => (item.type === "file" && isImage(item.mime) ? [item.uri.length] : []))
}

// Remote and provider-referenced media carry no inline payload and count as 0, as in core. Base64 is ASCII, so core
// takes a string's length as its size (v2.1).
function inlineBytes(source: Extract<Part, { readonly type: "media" }>["media"]["source"]) {
  if (source.type === "base64") return source.data.length
  if (source.type === "bytes") return Math.ceil(source.data.byteLength / 3) * 4
  return 0
}

function isImage(mime: string) {
  return mime.toLowerCase().startsWith("image/")
}

function slotKey(sessionID: string, providerID: string) {
  return `${sessionID}\u0000${providerID}`
}

/** The D10 pairing key (auth): session, slot, model and agent. */
function requestKey(event: Pick<SessionModelRequest, "sessionID" | "model" | "agent">) {
  return `${slotKey(event.sessionID, event.model.providerID)}\u0000${event.model.id}\u0000${event.agent}`
}

/** Insertion-ordered bounded map write: the entry moves to the end and the oldest one goes past the bound. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size <= MEMORY_KEYS) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}
