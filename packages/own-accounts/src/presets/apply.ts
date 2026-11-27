export * as PresetApply from "./apply.js"

import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { Account, Kind, Kv, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import { Location } from "../location.js"
import type { Module } from "../module.js"
import type { RpcTypes } from "../rpc/types.js"
import type { Variant } from "../switching/variant.js"
import { Book } from "../telemetry/book.js"
import { PresetBinding } from "./binding.js"
import { PresetBudget } from "./budget.js"
import { PresetGuidance } from "./guidance.js"
import type { PresetForce } from "./force.js"
import type { PresetRepair } from "./repair.js"
import { PresetStore } from "./store.js"
import { PresetUltra } from "./ultra.js"
import { PresetUsage } from "./usage.js"

/**
 * Owner: PRESETS (07 §5.1–§5.3, §8.1). A root session's preset binding (KV `sess:<root>:preset`) and its `own.preset`
 * guidance entry:
 * - `session.preset.apply` on the session's serial runner (`switching.serial`, the queue `session.created` binds a new
 *   root on), so whichever runs first, the applied preset wins; it returns after the entry was written. The preset
 *   must belong to the group of the session's main; R4 is judged with the binding's team (`team` omitted keeps the
 *   stored one, `null` clears it). The main never changes, so there is no estimate.
 * - The entry is written only when the guidance hash changes ({@link commit}); a team-only change never touches it.
 * - `session.preset.get`: binding, the preset in effect and its resolution, the caps in force, subagent counts and
 *   this conversation's spend on paid accounts; `main` when the main's model or level is gone (07 §4.3,
 *   `PresetRepair.main`), with the 02 switch to offer. Nothing switches by itself.
 * - Afterwards: `presets.json` changes rebind sessions whose preset was removed (to the group's ★, else `평소대로`) and
 *   re-render the entry of edited ones ({@link reconcile}); a main moving to another group takes that group's preset
 *   of the same name, else its ★; a user's own effort change turns ultra off (`PresetUltra.survives`), and another
 *   account or model keeps it with its effort decided again for the new model (`PresetUltra.after`, `retune`).
 */
export interface Api {
  get: RpcTypes.Handler<"session.preset.get">
  apply: RpcTypes.Handler<"session.preset.apply">
  /** A session's id, directory and main; `undefined` when the lookup fails. */
  session(sessionID: string): Promise<Session | undefined>
  /**
   * The binding of a root whose main is in `group`: the stored one, else (none yet, or the main moved to another
   * group) the group's preset a rebind would choose, carrying the stored ultra and team. Not stored here.
   */
  binding(session: Session, group: Preset.Group): Promise<Preset.Binding>
  /**
   * Changes the stored binding on the session's serial runner: `change` gets the current binding of the group and
   * the result is committed ({@link commit}).
   */
  update(session: Session, group: Preset.Group, change: (current: Preset.Binding) => Preset.Binding): Promise<Commit>
  /**
   * The entry hash of a new root's first binding (`PresetBinding.ensure`, already on the session's runner): the
   * guidance of `preset` is written when it needs an entry. `null` = no entry (none needed, or the write failed).
   */
  entry(sessionID: string, ref: Variant.Ref, preset: Preset.Info): Promise<string | null>
  /** `session.model.selected` of a local session; queued, never awaited by the event loop. */
  onModelSelected(sessionID: string, model: Variant.Ref, previous: Variant.Ref | undefined): void
  /** `presets.json` changed: bound sessions of this Location follow (07 §5.3 지울 때, §3.3). */
  reconcile(): Promise<void>
  /** The caps in force for a root now (07 §2.6), the current user message's raise included. */
  caps(sessionID: string): Promise<Preset.Caps>
}

export interface Session {
  readonly sessionID: string
  readonly directory: string
  readonly ref: Variant.Ref | undefined
}

export type Commit =
  | { readonly ok: true; readonly binding: Preset.Binding; readonly entry: PresetGuidance.Outcome }
  | { readonly ok: false; readonly message: string }

export interface Options {
  readonly writer: PresetGuidance.Writer
  /** The ultra effort of a model (`PresetUltra` `effort`), for the effort-change rule. */
  readonly effort: PresetUltra.Api["effort"]
  /** Ultra's effort on a main the session moved to (`PresetUltra` `retune`), run after the session's serial job. */
  readonly retune: PresetUltra.Api["retune"]
  /** Whether the main's model or level is gone (`PresetRepair` `main`, 07 §4.3). */
  readonly main: PresetRepair.Api["main"]
  /** The preset's fixed effort on the main (`PresetForce` `enforce`, 07 §2.3 강도 고정), run after the serial job. */
  readonly enforce: PresetForce.Api["enforce"]
}

const decodeChildren = Schema.decodeUnknownOption(Schema.Array(Schema.String))

export function create(deps: Deps, peers: Module.Peers, options: Options): Api {
  const log = deps.log.child("presets.session")
  const state = { level: undefined as Preset.UltraCaps | undefined }

  const session = async (sessionID: string): Promise<Session | undefined> => {
    const info = await deps.ctx.session.get({ sessionID }).catch(() => undefined)
    return info && { sessionID, directory: info.location.directory, ref: info.model }
  }

  /** A preset by id in the group, as loaded (`평소대로` included); `undefined` for any other id. */
  const presetIn = (id: Preset.ID, group: Preset.Group) => peers().presets.preset(id, group)

  /**
   * The preset a root rebinds to in `group` (07 §5.3): the preset named like `previous` there (when moving between
   * groups), else the group's ★, else `평소대로`; one that breaks R4 with the binding's team is skipped.
   */
  const rebound = (group: Preset.Group, name: string | undefined, main: string | undefined, team?: Preset.Team) => {
    const presets = peers().presets
    const star = presets.star(group)
    const named = name === undefined ? undefined : presets.presetsOf(group).find((preset) => preset.name === name)
    const mainID = main === undefined || Preset.isLocal(main) ? null : Account.ID.make(main)
    return (
      [named, star === undefined ? undefined : presetIn(star, group)].find(
        (preset) => preset !== undefined && Preset.allowed(preset, mainID, presets.resolver.lookup, team).ok,
      ) ?? Preset.builtin(group)
    )
  }

  const binding = async (current: Session, group: Preset.Group): Promise<Preset.Binding> => {
    const stored = await PresetBinding.read(deps, current.sessionID)
    if (stored?.group === group) return stored
    const main = current.ref && (await peers().presets.resolver.main(current.ref, current.sessionID))
    const name = stored && presetIn(stored.presetID, stored.group)?.name
    const preset = rebound(group, name, main?.account, stored?.team)
    return {
      presetID: preset.id,
      group,
      revision: preset.revision,
      appliedAt: deps.clock.now(),
      entryHash: stored?.entryHash ?? null,
      ...(stored?.ultra ? { ultra: stored.ultra } : {}),
      ...(stored?.team ? { team: stored.team } : {}),
    }
  }

  /**
   * The guidance a binding needs for this main (07 §3.3). The main is read only when a role has a target; the
   * resolution decides a lighter pair needed for the first time (`write`).
   */
  const guidanceOf = async (
    preset: Preset.Info,
    input: {
      readonly ref: Variant.Ref | undefined
      readonly sessionID?: string
      readonly ultra: boolean
      readonly team?: Preset.Team
      readonly resolution?: Preset.Resolution | null
      readonly write: boolean
    },
  ) => {
    const presets = peers().presets
    const targeted = PresetGuidance.targeted(preset.workers)
    const main = targeted && input.ref ? await presets.resolver.main(input.ref, input.sessionID) : undefined
    const resolution =
      input.resolution ??
      (main
        ? await presets.resolver.resolve(preset, main, {
            ...(input.team ? { team: input.team } : {}),
            write: input.write,
          })
        : undefined)
    const cards = targeted ? await PresetGuidance.cards(presets.resolver, preset.workers, main, resolution) : {}
    // A model pool (07 §3.3): its block from the frozen cards and this main's facts, in place of role cards.
    const pool = PresetGuidance.pool(preset.workers, resolution ?? undefined)
    return PresetGuidance.render({
      preset,
      ultra: input.ultra,
      level: presets.settings().ultraCaps,
      cards,
      ...(pool ? { pool } : {}),
    })
  }

  /**
   * Stores `next` (07 §5.3 step 3): the entry is put or removed only when the guidance hash changes, and the binding
   * is stored and announced (`session.preset.changed`) only when it changed. A failed entry write stores nothing.
   */
  const commit = async (
    current: Session,
    previous: Preset.Binding | undefined,
    next: Preset.Binding,
    resolution?: Preset.Resolution | null,
  ): Promise<Commit> => {
    const preset = presetIn(next.presetID, next.group) ?? Preset.builtin(next.group)
    const guidance = await guidanceOf(preset, {
      ref: current.ref,
      sessionID: current.sessionID,
      ultra: next.ultra !== undefined,
      ...(next.team ? { team: next.team } : {}),
      ...(resolution === undefined ? {} : { resolution }),
      write: true,
    })
    const entry = PresetGuidance.plan(previous?.entryHash ?? null, guidance)
    const place = { sessionID: current.sessionID, directory: current.directory }
    const written =
      entry === "written" && guidance
        ? await options.writer.put(place, guidance.text)
        : entry === "removed"
          ? await options.writer.remove(place)
          : ({ ok: true } as const)
    if (!written.ok) {
      log.warn("preset_entry_write_failed", { sessionID: current.sessionID, entry, status: written.status })
      return { ok: false, message: `the own.preset entry could not be ${entry}: ${written.message}` }
    }
    const stored: Preset.Binding = { ...next, entryHash: guidance?.hash ?? null }
    if (previous === undefined || !PresetBinding.equal(previous, stored)) {
      await PresetBinding.write(deps, current.sessionID, stored)
      await deps.emitter.session("session.preset.changed", {
        sessionID: SessionID.make(current.sessionID),
        binding: stored,
      })
    }
    return { ok: true, binding: stored, entry }
  }

  const serial = <T>(sessionID: string, work: () => Promise<T>) => peers().switching.serial(sessionID, work)

  /**
   * Re-evaluates a bound root (on its runner): the main's group (a move takes the same-named preset or the ★), a
   * removed preset (the ★, else `평소대로`), an edited one (its revision), and ultra after a main change. The entry
   * follows only when its text changes. Answers whether ultra wants another effort on the main the session moved to
   * (`PresetUltra.retune`, which must not run on the runner).
   */
  const refresh = async (
    sessionID: string,
    change?: { readonly model: Variant.Ref; readonly previous?: Variant.Ref },
  ): Promise<boolean> => {
    const stored = await PresetBinding.read(deps, sessionID)
    if (!stored) return false
    const found = await session(sessionID)
    if (!found) return false
    const current = change ? { ...found, ref: change.model } : found
    const ref = current.ref
    const presets = peers().presets
    const group = ref ? presets.groupOf(ref.providerID) : stored.group
    // A main outside every group: no preset applies, so the binding stays for when it comes back.
    if (!group) return false
    const main = ref && (await presets.resolver.main(ref, sessionID))
    const kept = presetIn(stored.presetID, group)
    const base =
      stored.group !== group
        ? await binding(current, group)
        : kept
          ? { ...stored, revision: kept.revision }
          : rebind(stored, rebound(group, undefined, main?.account, stored.team))
    const ultra = base.ultra
    if (!ultra || !change || !ref) {
      const committed = await commit(current, stored, base)
      if (!committed.ok) log.warn("preset_refresh_failed", { sessionID, message: committed.message })
      return false
    }
    // The effort ultra wants on this main, from the user's own effort (07 §2.9).
    const user = PresetUltra.userEffort(ultra, ref)
    const want = await options.effort(
      group,
      { providerID: ref.providerID, id: ref.id, ...(user === undefined ? {} : { variant: user }) },
      main?.variants ?? [],
      ultra.raiseClaude,
    )
    const moved = PresetUltra.moved(change.previous, ref) ? PresetUltra.after(ultra, ref, want) : undefined
    const next = moved
      ? { ...base, ultra: moved.state }
      : PresetUltra.survives(group, change.previous, ref, want)
        ? { ...base, ultra: PresetUltra.byHand(group, ultra, ref, want) }
        : withoutUltra(base)
    const committed = await commit(current, stored, next)
    if (!committed.ok) log.warn("preset_refresh_failed", { sessionID, message: committed.message })
    return committed.ok && moved?.retune === true
  }

  /** USD spent on paid accounts by this root and its subagents, this month and the last (02 §7.5 ledger). */
  const spendOf = async (sessionID: string) => {
    const stored = Option.getOrUndefined(
      decodeChildren(await deps.ctx.storage.get(Kv.children(sessionID)).catch(() => undefined)),
    )
    const tree = new Set([
      sessionID,
      ...(stored ?? []),
      ...deps.runtime.sessions.children(sessionID).map((entry) => entry.sessionID),
    ])
    const slots = peers().slots
    const paid = (accountID: Account.ID | null) => {
      const account = accountID === null ? undefined : slots.account(accountID)
      return account !== undefined && PresetBudget.paid(account)
    }
    const months = await Promise.all(
      Book.months(deps.clock.now(), 2).map((month) => deps.runtime.ledger.usageSorted(month)),
    )
    const total = months
      .flat()
      .map((entry) => entry.line)
      .filter((line) => tree.has(line.sessionID) && line.cost?.unit === "USD" && paid(line.accountID))
      .reduce((sum, line) => sum + (line.cost?.amount ?? 0), 0)
    return Math.round(total * 1e6) / 1e6
  }

  /** The preset in effect for a root (07 §5.3): the binding's while it exists in its group, else the group's ★. */
  const effective = (stored: Preset.Binding | undefined, group: Preset.Group) =>
    PresetStore.inEffect(peers().presets, stored, group)

  /**
   * The caps in force for a root now (07 §2.6), as the gate takes them: the preset's, with ultra the ultra level's, and
   * the per-message cap raised for the current user message (`raiseOnce`, `PresetUsage.perMessage`).
   */
  const capsOf = async (sessionID: string, preset: Preset.Info, stored: Preset.Binding | undefined) => {
    const caps = Preset.caps(preset, stored?.ultra !== undefined, peers().presets.settings().ultraCaps)
    const usage = await PresetUsage.read(deps, sessionID)
    return { ...caps, perMessage: PresetUsage.perMessage(caps, usage, await PresetUsage.message(deps, sessionID)) }
  }

  return {
    session,
    binding,

    get: async (input) => {
      const sessionID = input.sessionID
      const found = await session(sessionID)
      const stored = await PresetBinding.read(deps, sessionID)
      const ref = found?.ref
      const presets = peers().presets
      const group = ref ? presets.groupOf(ref.providerID) : stored?.group
      const preset = group === undefined ? undefined : effective(stored, group)
      const main = preset && ref ? await presets.resolver.main(ref, sessionID) : undefined
      const resolution =
        preset && main ? await presets.resolver.resolve(preset, main, stored?.team ? { team: stored.team } : {}) : null
      // The gate's own counts (`runtime.reservations`); the conversation count survives a restart in KV.
      const counts = deps.runtime.reservations.counts(sessionID)
      const usage = await PresetUsage.read(deps, sessionID)
      const gone = ref ? await options.main(ref) : undefined
      return {
        binding: stored ?? null,
        preset: preset ?? null,
        resolution,
        caps: preset ? await capsOf(sessionID, preset, stored) : Preset.CAPS,
        counts: {
          running: counts.running,
          message: counts.messageID === (await PresetUsage.message(deps, sessionID)) ? counts.message : 0,
          session: Math.max(counts.session, usage.perSession),
        },
        spend: await spendOf(sessionID),
        ...(gone ? { main: gone } : {}),
      }
    },

    apply: async (input, context) => {
      const sessionID = input.sessionID
      const found = await session(sessionID)
      if (!found) return context.error("internal_error", "session not found", {})
      const presets = peers().presets
      const main = found.ref ? presets.groupOf(found.ref.providerID) : undefined
      if (found.ref && main === undefined)
        return context.error("internal_error", "the session's main is in no provider group", {})
      // `평소대로` of any group, or a stored preset of any group, so another group's preset is told apart from an
      // unknown one.
      const preset = GROUPS.map((group) => presetIn(input.presetID, group)).find((item) => item !== undefined)
      if (!preset) return context.error("preset_not_found", "preset_not_found", { presetID: input.presetID })
      const group = main ?? preset.group
      if (preset.group !== group) return context.error("preset_wrong_group", "preset_wrong_group", { group })
      const result = await serial(sessionID, async () => {
        const previous = await PresetBinding.read(deps, sessionID)
        const team = input.team === undefined ? previous?.team : (input.team ?? undefined)
        const resolved = found.ref ? await presets.resolver.main(found.ref, sessionID) : undefined
        const mainID = resolved && !Preset.isLocal(resolved.account) ? Account.ID.make(resolved.account) : null
        const verdict = Preset.allowed(preset, mainID, presets.resolver.lookup, team)
        // A new team context for the preset the session already has (06 §10.1: the team moved to another account, or
        // another area changed) keeps it when only the preset's own pinned targets break R4 with that team: the gate
        // runs those roles on the next target or like the main, and own.team posts the repair notice. A team
        // context that breaks R4 by itself, and every new choice of a preset, is still refused.
        const reapplied =
          !verdict.ok &&
          input.team !== undefined &&
          previous?.presetID === preset.id &&
          Preset.allowed(Preset.builtin(group), mainID, presets.resolver.lookup, team).ok
        if (!verdict.ok && !reapplied)
          return context.error("same_company_subscription", "same_company_subscription", {
            accountID: verdict.accountID,
          })
        const next: Preset.Binding = {
          presetID: preset.id,
          group,
          revision: preset.revision,
          appliedAt: deps.clock.now(),
          entryHash: previous?.entryHash ?? null,
          ...(previous?.ultra ? { ultra: previous.ultra } : {}),
          ...(team ? { team } : {}),
        }
        const resolution = resolved
          ? await presets.resolver.resolve(preset, resolved, { ...(team ? { team } : {}), write: !input.dryRun })
          : null
        if (input.dryRun) {
          const guidance = await guidanceOf(preset, {
            ref: found.ref,
            sessionID,
            ultra: next.ultra !== undefined,
            resolution,
            write: false,
          })
          return {
            binding: { ...next, entryHash: guidance?.hash ?? null },
            resolution,
            entry: PresetGuidance.plan(previous?.entryHash ?? null, guidance),
            dryRun: true,
          }
        }
        const committed = await commit(found, previous, next, resolution)
        if (!committed.ok) return context.error("internal_error", committed.message, {})
        return { binding: committed.binding, resolution, entry: committed.entry, dryRun: false }
      })
      // 07 §2.3 강도 고정: an idle session takes the preset's fixed effort before this returns (a new session's first
      // prompt goes out at it); a busy one switches at its idle, without holding the answer.
      if (!input.dryRun && "binding" in result) {
        const forced = options.enforce(sessionID)
        if (!deps.runtime.sessions.get(sessionID)?.busy) await forced
      }
      return result
    },

    update: (current, group, change) =>
      serial(current.sessionID, async () => {
        const previous = await PresetBinding.read(deps, current.sessionID)
        return commit(current, previous, change(await binding(current, group)))
      }),

    entry: async (sessionID, ref, preset) => {
      const guidance = await guidanceOf(preset, { ref, sessionID, ultra: false, write: true })
      if (!guidance) return null
      const found = await session(sessionID)
      const written = found
        ? await options.writer.put({ sessionID, directory: found.directory }, guidance.text)
        : ({ ok: false, status: null, message: "session not found" } as const)
      if (written.ok) return guidance.hash
      log.warn("preset_entry_write_failed", { sessionID, entry: "written", status: written.status })
      return null
    },

    onModelSelected: (sessionID, model, previous) => {
      void serial(sessionID, () => refresh(sessionID, { model, ...(previous ? { previous } : {}) }))
        .then((retune) => {
          // 07 §2.3 강도 고정: another model or account takes the fixed effort again; an effort change alone is the
          // user's override and stays.
          if (PresetUltra.moved(previous, model)) void options.enforce(sessionID)
          return retune ? options.retune(sessionID) : undefined
        })
        .catch((error: unknown) => log.warn("preset_refresh_failed", { sessionID, error }))
    },

    reconcile: async () => {
      const presets = peers().presets
      const level = presets.settings().ultraCaps
      const leveled = state.level !== undefined && JSON.stringify(state.level) !== JSON.stringify(level)
      state.level = level
      const bound = await PresetBinding.scan(deps)
      const affected = bound.filter(
        (item) =>
          (!Preset.isBuiltin(item.binding.presetID) &&
            presetIn(item.binding.presetID, item.binding.group)?.revision !== item.binding.revision) ||
          (leveled && item.binding.ultra !== undefined),
      )
      for (const item of affected) {
        const found = await session(item.sessionID)
        // Each Location's instance follows its own sessions, on their own runners.
        if (!found || !Location.same(found.directory, deps.location.directory)) continue
        await serial(item.sessionID, () => refresh(item.sessionID)).catch((error: unknown) =>
          log.warn("preset_refresh_failed", { sessionID: item.sessionID, error }),
        )
        // An edited preset's fixed effort reaches its conversations (07 §2.3 강도 고정).
        void options.enforce(item.sessionID)
      }
    },

    caps: async (sessionID) => {
      const found = await session(sessionID)
      const stored = await PresetBinding.read(deps, sessionID)
      const group = found?.ref ? peers().presets.groupOf(found.ref.providerID) : stored?.group
      if (group === undefined) return Preset.CAPS
      return capsOf(sessionID, effective(stored, group), stored)
    },
  }
}

/** A binding moved to another preset of its group, everything else kept. */
function rebind(binding: Preset.Binding, preset: Preset.Info): Preset.Binding {
  return { ...binding, presetID: preset.id, revision: preset.revision }
}

function withoutUltra(binding: Preset.Binding): Preset.Binding {
  const { ultra: _ultra, ...rest } = binding
  return rest
}

/** Every group a preset may be filed under: each account kind and each discovered local provider (07 P-D2). */
const GROUPS: ReadonlyArray<Preset.Group> = [
  ...Kind.Any.literals,
  ...Preset.LOCAL_PROVIDERS.map((providerID) => `local:${providerID}` as const),
]
