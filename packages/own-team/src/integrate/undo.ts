export * as IntegrateUndo from "./undo.js"

import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { OwnTeam } from "@own/protocol"
import { Identity } from "../git/identity.js"
import { Inventory } from "../git/inventory.js"
import { Refs } from "../git/refs.js"
import { Git } from "../git/run.js"
import type { Steps } from "../ops/steps.js"
import { Services } from "../services.js"
import { Advance } from "./advance.js"
import { Journal } from "../ops/journal.js"

/**
 * Undoing an integration (06 §7.4, `integration.undo`), only while the target is still K when the user asks
 * ({@link plan}; otherwise the card hands it to the main: `conflict`, {@link Planned} `delegate`). The `integrate-undo`
 * step then, by git's own rule of who holds the target (`Inventory.branchInUse`):
 *
 * - no folder has it checked out: `update-ref refs/heads/<target> B K` (compare-and-swap, TI-10);
 * - a home or area folder W has it: at W's safe point and after the identity check, `git -C W reset --keep B`. Local
 *   changes that overlap stop git before it touches anything, and the step waits. The user may have committed between
 *   the confirm and now: when `ORIG_HEAD` is not K right after, that commit goes to `refs/own/keep/<ORIG_HEAD>` with an
 *   `undo.kept` notice (TI-8);
 * - a git operation in progress (a rebase or bisect started from the target, or one stopped in W) or a W outside the
 *   team waits.
 *
 * It is the user's action, so it waits (TI-9) instead of being skipped, and shows why on the card
 * (`integration.waiting`, `action: "undo"`). RH-20: it waits outside the op, as a waiting integration does: the step
 * records the wait on the integration (`undoing`) and ends its op, so the team's one op slot is free meanwhile; the
 * controller looks again every {@link RECHECK_MS} without an op ({@link waits}) and starts the undo again once the
 * wait is over. A target that moved past K with no folder holding it is no longer undone automatically (`delegate`).
 * RH-31: meanwhile no integration starts or goes on to move the target (`IntegrateOp.undoWaits`), as when the undo op
 * held the slot: the reset to B would take it out too.
 */

export const STEP = "integrate-undo"

/** How often a waiting undo looks again (a stopped git operation ends without an event). */
export const RECHECK_MS = 30_000

export interface Deps {
  /** 8.4 at the folder W that has the target checked out (see {@link Advance.Deps}). */
  readonly safePoint: Advance.Deps["safePoint"]
}

export type Planned =
  | { readonly ok: true; readonly team: OwnTeam.Team; readonly integration: OwnTeam.Integration }
  /** `delegate`: the target moved past K; the card offers `메인에게 되돌리기 맡기기` (the failure is `conflict`). */
  | { readonly ok: false; readonly delegate: boolean; readonly failure: Services.Failure }

/** Whether the integration can be undone now: advanced, not undone, and the target still at K (7.4). */
export async function plan(services: Services.Base, integrationID: string): Promise<Planned> {
  const integration = await Advance.find(services, integrationID)
  if (!integration)
    return refused(Services.failure("not_found", "integration not found", { what: "integration", id: integrationID }))
  const team = await services.registry.teams.get(integration.teamID)
  if (!team)
    return refused(Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: integration.teamID }))
  if (team.state !== "on") return refused(Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id }))
  const candidate = integration.candidate
  if (integration.state !== "done" || !integration.advanced || candidate === undefined)
    return refused(Services.unsupported("integration.undo"))
  const now = await Advance.tip(team.commonDir, integration.target)
  if (now === undefined) return refused(Services.failure("internal_error", `cannot read ${integration.target}`, {}))
  if (now === candidate) return { ok: true, team, integration }
  return {
    ok: false,
    delegate: true,
    failure: Services.failure("conflict", `${integration.target} moved on after the integration`, {
      ref: `refs/heads/${integration.target}`,
      expected: candidate,
      actual: now,
    }),
  }
}

/** `integration.undo`: {@link plan}, then an `undo` op with the `integrate-undo` step (by the user). */
export async function start(
  services: Services.Context,
  input: { readonly integrationID: string; readonly by: OwnTeam.Op["by"] },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const planned = await plan(services, input.integrationID)
  if (!planned.ok) return planned.failure
  return again(services, { integration: planned.integration, by: input.by })
}

/**
 * The `undo` op of an integration the user decided to undo: by `start`, and again (RH-20) once an undo that waited
 * outside its op may go on (`waited`). No "still K" check then: the user confirmed while it was K, and a commit made on
 * the target since is kept (TI-8, {@link once}). A `waited` op runs only while the wait is still recorded: a
 * 되돌리기 취소 that landed after the controller decided to go on drops it ({@link cancel}, RH-42).
 */
export async function again(
  services: Services.Context,
  input: { readonly integration: OwnTeam.Integration; readonly by: OwnTeam.Op["by"]; readonly waited?: boolean },
): Promise<Services.Result<{ readonly opID: OwnTeam.OpID }>> {
  const started = await services.runner.start({
    teamID: input.integration.teamID,
    kind: "undo",
    by: input.by,
    areaID: input.integration.areaID,
    undo: { available: false },
    steps: [
      {
        id: "undo",
        kind: STEP,
        args: { integrationID: input.integration.id, ...(input.waited === true ? { waited: true } : {}) },
      },
    ],
  })
  if (!started.ok) return Services.failure("busy", "another team op is running", Journal.busy(started.op))
  return { ok: true, opID: started.op.id }
}

/**
 * 되돌리기 취소 (`integration.undo.cancel`, RH-42): the user drops an undo that waits outside its op. Nothing moved
 * yet, so the record only loses `undoing` and its `integration.waiting` notice closes; the target it held (RH-31) is
 * free again, which the controller's caller acts on. While an undo op of it runs the answer is `busy` (that op is
 * `op.cancel`'s); an op the controller had already decided to start skips itself ({@link again} `waited`).
 */
export async function cancel(
  services: Services.Context,
  integrationID: string,
): Promise<Services.Result<{ readonly integration: OwnTeam.Integration }>> {
  const integration = await Advance.find(services, integrationID)
  if (integration?.undoing === undefined)
    return Services.failure("not_found", "기다리는 되돌리기가 없어요", { what: "integration", id: integrationID })
  const team = await services.registry.teams.get(integration.teamID)
  if (!team) return Services.failure("not_found", "팀을 찾을 수 없어요", { what: "team", id: integration.teamID })
  if (team.state !== "on") return Services.failure("team_off", "팀 모드가 꺼져 있어요", { teamID: team.id })
  const op = await services.journal.active(team.id)
  if (op?.kind === "undo" && op.steps.some((step) => step.args.integrationID === integration.id))
    return Services.failure("busy", "되돌리기가 지금 돌고 있어요", Journal.busy(op))
  const updated = await Advance.update(services, team.id, integration.id, (current) =>
    current.undoing === undefined ? undefined : withoutUndoing(current),
  )
  await Advance.announce(services, team, updated ?? integration, undefined, "undo")
  return { ok: true, integration: updated ?? withoutUndoing(integration) }
}

/** The deps the step kind was registered with, per controller ({@link waits} asks the same safe point). */
const registered = new WeakMap<object, Deps>()

/** Registers `integrate-undo` once per controller. */
export function register(services: Services.Context, deps: Deps) {
  if (services.steps.get(STEP)) return
  services.steps.register(kind(deps))
  registered.set(services.steps, deps)
}

export type Undone =
  /** The target is B again; `kept`: the commit made meanwhile, now in `refs/own/keep/<kept>`. */
  | { readonly state: "undone"; readonly how: "update-ref" | "reset-keep"; readonly kept?: string }
  | { readonly state: "waiting"; readonly waiting: Advance.Waiting }
  /** The target moved past K (or elsewhere) where no automatic undo is safe: the main decides (7.4). */
  | { readonly state: "delegate"; readonly tip: string | null }
  | { readonly state: "failed"; readonly message: string }

/** One look at the integration's undo: undo it now, or say why it waits or cannot. Records nothing on the integration. */
export async function once(
  services: Services.Base,
  deps: Deps,
  input: {
    readonly team: OwnTeam.Team
    readonly integration: OwnTeam.Integration
    readonly signal: AbortSignal
  },
): Promise<Undone> {
  const team = input.team
  const integration = input.integration
  const base = integration.base
  const candidate = integration.candidate
  const signal = input.signal
  if (base === undefined || candidate === undefined) return { state: "failed", message: "반영 후보가 없어요" }
  const commonDir = team.commonDir
  const target = integration.target
  const now = await Advance.tip(commonDir, target, signal)
  if (now === undefined) return { state: "failed", message: `프로젝트 본 코드(${target})를 읽지 못했어요` }
  // Already back at B: a resume after the undo moved it.
  if (now === base) return { state: "undone", how: "update-ref" }
  const contains = now !== null && (now === candidate || (await Advance.ancestor(commonDir, candidate, now, signal)))
  if (!contains) return { state: "delegate", tip: now }

  const used = await Inventory.branchInUse(commonDir, target)
  if (!used.ok) return { state: "failed", message: used.message }
  const held = used.users.find((use) => use.how !== "checkout")
  if (held) return waiting("in-progress", held.path)
  const checkout = used.users.find((use) => use.how === "checkout")
  if (!checkout) {
    if (now !== candidate) return { state: "delegate", tip: now }
    const swapped = await Advance.swap({
      directory: commonDir,
      target,
      to: base,
      from: candidate,
      integrationID: integration.id,
      signal,
    })
    if (swapped.ok) return { state: "undone", how: "update-ref" }
    const after = await Advance.tip(commonDir, target, signal)
    if (after === base) return { state: "undone", how: "update-ref" }
    return { state: "delegate", tip: after ?? null }
  }

  if (checkout.gitDir !== null && Inventory.operations(checkout.gitDir).length > 0)
    return waiting("in-progress", checkout.path)
  const member = await Advance.placeOf(services, team, checkout.path)
  if (!member) return waiting("outside", checkout.path)
  const safe = await deps.safePoint({
    teamID: team.id,
    ...(member.area === undefined ? {} : { areaID: member.area.id }),
    directory: checkout.path,
    signal,
  })
  if (!safe.ok) return waiting("in-use", checkout.path)
  const gitDir = member.area?.gitDir ?? checkout.gitDir
  if (gitDir === null) return { state: "failed", message: `${checkout.path}: Git 폴더가 없어요` }
  const identity = await Identity.check({ directory: checkout.path, gitDir })
  if (!identity.ok) return { state: "failed", message: identity.message }
  const before = await Advance.head(checkout.path, signal)
  if (!before || before.branch !== `refs/heads/${target}`)
    return { state: "failed", message: "폴더가 프로젝트 본 코드에서 벗어났어요" }

  // TI-8: a commit made on the target since the confirm is kept before anything moves the branch.
  const early = before.oid === candidate ? { ok: true as const } : await keep(commonDir, before.oid)
  if (!early.ok) return { state: "failed", message: early.message }
  await Git.run(["reset", "--keep", base], { cwd: checkout.path, write: true, worktree: true, signal })
  const after = await Advance.head(checkout.path, signal)
  // `reset --keep` stops before touching anything when local changes overlap what it would change.
  if (after?.oid !== base)
    return waiting("dirty", checkout.path, await Advance.overlap(checkout.path, before.oid, base, signal))
  const orig = await Git.run(["rev-parse", "--verify", "--quiet", "ORIG_HEAD^{commit}"], {
    cwd: checkout.path,
    worktree: true,
    signal,
  })
  // 7.4: ORIG_HEAD right after the reset; a commit that landed after the look above is kept too.
  const previous = orig.ok ? orig.stdout.trim() : before.oid
  if (previous === candidate) return { state: "undone", how: "reset-keep" }
  const late = previous === before.oid ? { ok: true as const } : await keep(commonDir, previous)
  if (!late.ok)
    return {
      state: "failed",
      message: `프로젝트 본 코드는 되돌렸지만 그 사이 생긴 저장 지점(${previous})을 보관하지 못했어요: ${late.message}`,
    }
  return { state: "undone", how: "reset-keep", kept: previous }
}

/**
 * Whether the undo would wait now (RH-20), asked without an op and without touching anything: the checks of
 * {@link once} up to the reset, with the overlap of the folder's local changes for `dirty`. `undefined` when it would
 * not wait (or git cannot say: the undo's own op then reports it).
 */
export async function waits(
  services: Services.Base,
  input: { readonly team: OwnTeam.Team; readonly integration: OwnTeam.Integration },
): Promise<Advance.Waiting | undefined> {
  const deps = registered.get(services.steps)
  if (!deps) return undefined
  const team = input.team
  const base = input.integration.base
  if (base === undefined) return undefined
  const used = await Inventory.branchInUse(team.commonDir, input.integration.target)
  if (!used.ok) return undefined
  const held = used.users.find((use) => use.how !== "checkout")
  if (held) return { why: "in-progress", directory: held.path }
  const checkout = used.users.find((use) => use.how === "checkout")
  if (!checkout) return undefined
  if (checkout.gitDir !== null && Inventory.operations(checkout.gitDir).length > 0)
    return { why: "in-progress", directory: checkout.path }
  const member = await Advance.placeOf(services, team, checkout.path)
  if (!member) return { why: "outside", directory: checkout.path }
  const safe = await deps.safePoint({
    teamID: team.id,
    ...(member.area === undefined ? {} : { areaID: member.area.id }),
    directory: checkout.path,
  })
  if (!safe.ok) return { why: "in-use", directory: checkout.path }
  const head = await Advance.head(checkout.path)
  if (!head) return undefined
  const paths = await Advance.overlap(checkout.path, head.oid, base)
  return paths && paths.length > 0 ? { why: "dirty", directory: checkout.path, paths: [...paths] } : undefined
}

/** `refs/own/keep/<sha>` (create-only; one that already holds it counts as made). */
async function keep(directory: string, sha: string) {
  const created = await Refs.create(directory, { ref: `refs/own/keep/${sha}`, oid: sha }, "own.team keep")
  return created.ok ? ({ ok: true } as const) : ({ ok: false, message: created.message } as const)
}

function refused(failure: Services.Failure): Planned {
  return { ok: false, delegate: false, failure }
}

function waiting(why: Advance.Waiting["why"], directory: string, paths?: ReadonlyArray<string>): Undone {
  return { state: "waiting", waiting: { why, directory, ...(paths === undefined ? {} : { paths: [...paths] }) } }
}

/** `waited`: started again by the controller after the undo waited outside its op ({@link again}). */
const Args = Schema.Struct({ integrationID: OwnTeam.IntegrationID, waited: optional(Schema.Boolean) })
const decodeArgs = Schema.decodeUnknownOption(Args)

/** The step's note when the user cancelled the undo while it waited (RH-42). */
export const CANCELLED = "기다리던 되돌리기를 취소했어요"

function kind(deps: Deps): Steps.Kind {
  return {
    kind: STEP,
    observe: async (input) => {
      const found = await load(input)
      if (!found.ok) return found.observed
      if (found.integration.state === "undone") return { state: "satisfied" }
      if (found.integration.state !== "done" || !found.integration.advanced)
        return { state: "failed", note: "이 반영은 프로젝트 본 코드를 옮기지 않았어요" }
      if (found.args.waited === true && found.integration.undoing === undefined)
        return { state: "skip", note: CANCELLED }
      return { state: "pending" }
    },
    act: async (input) => {
      const found = await load(input)
      if (!found.ok) return { ok: false, note: "반영 기록을 찾을 수 없어요" }
      const services = input.services
      const result = await once(services, deps, {
        team: found.team,
        integration: found.integration,
        signal: input.signal,
      })
      if (result.state !== "waiting") return finish(input, found, result)
      // TI-9: the user's undo waits at the folder's safe point instead of being skipped; RH-20: outside the op.
      const now = services.clock.now()
      const by = input.op.by
      const waiting = result.waiting
      const dropped = (current: OwnTeam.Integration) => found.args.waited === true && current.undoing === undefined
      const recorded = await Advance.update(services, found.team.id, found.integration.id, (current) =>
        dropped(current)
          ? undefined
          : { ...current, undoing: { since: current.undoing?.since ?? now, by, ...waiting } },
      )
      // RH-42: cancelled while this look ran; the wait is not recorded again.
      if (recorded && dropped(recorded)) return { ok: true, note: CANCELLED }
      await Advance.announce(services, found.team, recorded ?? found.integration, waiting, "undo")
      return { ok: true, note: WAITS }
    },
    verify: async () => ({ ok: true }),
  }
}

async function finish(
  input: Steps.Input,
  found: { readonly team: OwnTeam.Team; readonly integration: OwnTeam.Integration },
  result: Exclude<Undone, { readonly state: "waiting" }>,
): Promise<Steps.Outcome> {
  const services = input.services
  const team = found.team
  const integration = found.integration
  await Advance.announce(services, team, integration, undefined, "undo")
  if (result.state !== "undone") {
    // The wait (if any) is over either way.
    await Advance.update(services, team.id, integration.id, (current) =>
      current.undoing === undefined ? undefined : withoutUndoing(current),
    )
    if (result.state === "failed") return { ok: false, note: result.message }
    return { ok: false, note: "그 뒤 프로젝트 본 코드가 더 바뀌어 바로 되돌릴 수 없어요. 메인에게 맡기세요" }
  }
  await Advance.update(services, team.id, integration.id, (current) => ({
    ...withoutUndoing(Advance.withoutWaiting(current)),
    state: "undone",
    undone: { at: services.clock.now(), opID: input.op.id },
  }))
  if (result.kept !== undefined) {
    const ref = `refs/own/keep/${result.kept}`
    input.summary({ kind: "ref", ref, sha: result.kept })
    services.notices.publish({
      teamID: team.id,
      areaID: integration.areaID,
      kind: "undo.kept",
      text: "반영을 되돌리면서 그사이 만든 저장 지점을 따로 보관해 뒀어요",
      data: { ref, sha: result.kept },
    })
  }
  return { ok: true, note: result.how }
}

/** The step's note when the undo waits outside its op (RH-20). */
export const WAITS = "되돌리기를 기다려요. 폴더가 준비되면 다시 해요"

/** The record without `undoing` (the undo ran, failed or is no longer possible). */
export function withoutUndoing(integration: OwnTeam.Integration): OwnTeam.Integration {
  const { undoing: _undoing, ...rest } = integration
  return rest
}

async function load(input: Steps.Input) {
  const args = Option.getOrUndefined(decodeArgs(input.step.args))
  if (!args) return { ok: false as const, observed: { state: "failed" as const, note: "단계 정보가 맞지 않아요" } }
  const [team, integration] = await Promise.all([
    input.services.registry.teams.get(input.op.teamID),
    Advance.get(input.services, input.op.teamID, args.integrationID),
  ])
  if (!team || !integration)
    return { ok: false as const, observed: { state: "skip" as const, note: "반영 기록을 찾을 수 없어요" } }
  return { ok: true as const, args, team, integration }
}
