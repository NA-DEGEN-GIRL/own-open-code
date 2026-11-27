// Preset repairs, the part the first chunk needs (07 §4.3, §7.3; PF5): the repairs of this PC's service, what marks a
// group for repair (the composer's dot) and what the shell's notifier has not announced yet. The lines and their
// actions (presets/repair-notice.tsx) are a lazy chunk, loaded once the service names a repair: the composer's preset
// menu then has them when it opens and measures itself, and the notifier announces from them.
import { Preset } from "@own/protocol/preset"
import { createEffect, createMemo, createRoot, createSignal, on, onCleanup } from "solid-js"
import type { OwnStore } from "@/data"
import type { RepairNotices } from "./repair-notice"

const [repairs, setRepairs] = createRoot(() => createSignal<ReadonlyArray<Preset.Repair>>())
const [lines, setLines] = createRoot(() => createSignal<typeof RepairNotices>())

/**
 * The repair lines' component (presets/repair-notice.tsx) once its chunk is loaded, which {@link watchRepairs} starts
 * as soon as the service names a repair; `undefined` before. A menu opened after that renders its lines at once, so it
 * fits them on screen when it opens (a later line made it wider than the place it measured).
 */
export const repairLines = lines

/**
 * `presets.list` `repairs` of this PC's service (07 §4.3): one per gone model, read by {@link watchRepairs};
 * `undefined` until the service's presets were read once.
 */
export const presetRepairs = repairs

/** Whether OwnStore's `presets.list` rows mark anything for repair: a preset, a gone lighter pair, a gone default. */
export function marksRepair(groups: Readonly<Record<string, Preset.GroupView>>) {
  return Object.values(groups).some(
    (view) =>
      needsRepair(view) ||
      Object.values(view.lighter ?? {}).some((pair) => pair.missing) ||
      view.defaultModel?.missing === true,
  )
}

/**
 * Keeps {@link presetRepairs} current; the shell calls it once. OwnStore keeps the rest of `presets.list` but not
 * `repairs`, so they are read here: when its rows start marking a repair, and on every `presets.changed` while they
 * do (the event comes before OwnStore's own read, so a first repair is read once the rows mark it). With nothing
 * marked there are none; before OwnStore read the presets (or while it reconnects) the last value stays. The last
 * answer wins.
 */
export function watchRepairs(own: OwnStore) {
  const state = createMemo(() => {
    if (own.state.status !== "ready" || !own.state.defaultsLoaded) return "unknown"
    return marksRepair(own.state.presetGroups) ? "marked" : "none"
  })
  let asked = 0
  const load = () => {
    const seq = ++asked
    if (state() === "unknown") return
    if (state() === "none" || !own.rpc.allowed("presets.list")) return setRepairs([])
    void own.rpc.call("presets.list", {}).then(
      (output) => {
        if (seq !== asked) return
        setRepairs(output.repairs ?? [])
        if (output.repairs?.length && !lines())
          void import("./repair-notice").then(
            (module) => setLines(() => module.RepairNotices),
            (error: unknown) => console.error("[own-web] preset repair lines", error),
          )
      },
      (error: unknown) => console.error("[own-web] preset repairs", error),
    )
  }
  createEffect(on(state, load))
  onCleanup(
    own.on("presets.changed", () => {
      if (state() === "marked") load()
    }),
  )
}

/**
 * The composer's dot (07 §7.3 `해당 프리셋 단추의 점`): a preset of the group needs a repair, as the service marks it
 * or because it runs on a lighter pair that is gone. A gone default model is no preset's (its line is on the settings
 * tab).
 */
export function needsRepair(view: Preset.GroupView | undefined) {
  if ((view?.presets ?? []).some((item) => item.status === "needs_repair")) return true
  return Object.values(view?.lighter ?? {}).some((pair) => pair.missing) && lighterPlaces(view).length > 0
}

/**
 * The model events a notifier has not announced yet, and what it remembers next: the models still gone, so a model
 * that comes back and goes again is announced again.
 */
export function unannounced(list: ReadonlyArray<Preset.Repair>, seen: ReadonlyArray<string>) {
  return {
    fresh: list.filter((repair) => !seen.includes(repair.model)),
    seen: list.map((repair) => repair.model),
  }
}

/** The places of a group's stored presets that run on the lighter pair, in list order. */
export function lighterPlaces(view: Preset.GroupView | undefined) {
  return (view?.presets ?? [])
    .filter((item) => !Preset.isBuiltin(item.id))
    .flatMap((item) => {
      const workers = item.workers
      const roles = Preset.ROLES.filter((role) => workers.roles[role]?.targets.some(isLighter))
      const places: Preset.Place[] = [
        ...roles,
        ...(workers.single && isLighter(workers.single) ? ["single" as const] : []),
      ]
      return places.map((place) => ({ presetID: item.id, place }))
    })
}

function isLighter(target: Preset.Target) {
  return "rel" in target && target.rel === "lighter"
}
