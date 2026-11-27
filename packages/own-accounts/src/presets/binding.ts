export * as PresetBinding from "./binding.js"

import { Option, Schema } from "effect"
import { Kv, Preset } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Module } from "../module.js"
import type { Variant } from "../switching/variant.js"

const encode = Schema.encodeSync(Preset.Binding)
const decode = Schema.decodeUnknownOption(Preset.Binding)
const toJson = Schema.decodeUnknownSync(Schema.Json)

/** Every key of the own-accounts KV that holds a binding ends with this (`Kv.preset`). */
const SUFFIX = ":preset"

/**
 * 07 §5.1 "다른 클라이언트 …": binds a root session that has no binding yet (TUI, `own run`, or `session.create`
 * without `session.preset.apply`) to its group's ★ preset, else to the group's `평소대로`. Switching calls it in the
 * session's work queue right after the session was pinned (07 §3.3 두 경로의 순서): any stored value stands, so a
 * `session.preset.apply` wins whichever runs first. The main stays the session's Ref (no `switchModel`). When the ★
 * needs guidance, its `own.preset` entry is written first (`presets.entry`), so the root has it before its first step;
 * `평소대로` needs none (07 §2.7), and then only the KV binding is written. The group is the one the subagent gate uses
 * (`presets.groupOf`): a provider outside every group (a built-in or plugin provider, `anthropic` without the Claude
 * slot) gets no binding, since no preset applies to it. The ★ comes from the presets store, which has none on a remote
 * service (07 §8.1 원격).
 */
export async function ensure(deps: Deps, peers: Module.Peers, sessionID: string, ref: Variant.Ref) {
  const presets = peers().presets
  const group = presets.groupOf(ref.providerID)
  if (!group) return
  // Presence alone: a value this build cannot decode (a newer build's) is a binding too and is never replaced.
  if ((await deps.ctx.storage.get(Kv.preset(sessionID))) !== undefined) return
  const presetID = presets.star(group) ?? Preset.builtinID(group)
  const preset = presets.preset(presetID, group) ?? Preset.builtin(group)
  const binding: Preset.Binding = {
    presetID,
    group,
    revision: preset.revision,
    appliedAt: deps.clock.now(),
    entryHash: await presets.entry(sessionID, ref, preset),
  }
  await write(deps, sessionID, binding)
  // 07 §2.3 강도 고정: queued behind this job on the session's runner, so it never waits on itself.
  if (Preset.forcedEffortOf(preset.forcedEffort)) void presets.enforce(sessionID)
}

/** A root's binding; `undefined` when it has none, or one this build cannot decode. */
export async function read(deps: Deps, sessionID: string): Promise<Preset.Binding | undefined> {
  return Option.getOrUndefined(decode(await deps.ctx.storage.get(Kv.preset(sessionID))))
}

export async function write(deps: Deps, sessionID: string, binding: Preset.Binding) {
  await deps.ctx.storage.set(Kv.preset(sessionID), toJson(encode(binding)))
}

/**
 * The accounts the preset bound to a root pins (its role rows, `single` and pinned pool entries, in that order), the
 * ones a Claude route starts an unbound tree on (PF 2026-11-03: `ClaudeAccounts` and `Bindings` `initial`). Empty
 * without a binding or a preset this build can read.
 */
export async function pinned(deps: Deps, peers: Module.Peers, root: string): Promise<ReadonlyArray<string>> {
  const binding = await read(deps, root)
  const preset = binding && peers().presets.preset(binding.presetID, binding.group)
  if (!preset) return []
  return Preset.targetsOf(preset.workers).flatMap((target) => ("pin" in target ? [target.pin.account] : []))
}

/** Whether two bindings store the same value. */
export function equal(a: Preset.Binding, b: Preset.Binding) {
  return JSON.stringify(encode(a)) === JSON.stringify(encode(b))
}

/** Every stored binding this build can decode, with its root session (a scan of the own-accounts KV). */
export async function scan(deps: Deps) {
  const page = async (after?: string): Promise<Array<{ sessionID: string; binding: Preset.Binding }>> => {
    const result = await deps.ctx.storage.scan({
      prefix: "sess:",
      ...(after === undefined ? {} : { after }),
      limit: 1000,
    })
    const found = result.entries.flatMap((entry) => {
      if (!entry.key.endsWith(SUFFIX)) return []
      const binding = Option.getOrUndefined(decode(entry.value))
      return binding ? [{ sessionID: entry.key.slice("sess:".length, -SUFFIX.length), binding }] : []
    })
    return result.next === undefined ? found : [...found, ...(await page(result.next))]
  }
  return page()
}
