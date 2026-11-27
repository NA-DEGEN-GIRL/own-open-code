export * as ReorgPlan from "./plan.js"

import type { OwnTeam } from "@own/protocol"
import { Activity } from "../git/activity.js"
import { Classify } from "../git/classify.js"
import { Inventory } from "../git/inventory.js"
import { Direct } from "../dispatch/direct.js"
import { JudgeValidate } from "../judge/validate.js"
import { Adopt } from "../ops/adopt.js"
import { AreaCreate } from "../ops/area-create.js"
import type { Steps } from "../ops/steps.js"
import { Areas } from "../registry/area.js"
import type { Services } from "../services.js"
import { Convert } from "./convert.js"
import { AreaMerge } from "./merge.js"
import { Rehome } from "./rehome.js"
import { Retire } from "./retire.js"
import { AreaSplit } from "./split.js"

/**
 * The plan of a reorganization (06 §8.1–8.2, §3.5, §8.3 TI-9, TI-13): a proposal (the user's own action, a stored judge
 * proposal, the main's `team_reorganize`) through the V-rules (`JudgeValidate.reorganize`), then the steps of each
 * action from its module, run observe → act → verify (TI-11):
 *
 *   rename   `area-rename` (the registry only; no area work, so no skip rule, except that a new role the main's or
 *            the judge's rename carries skips an area under Main 멈춤 or direct work, 2026-11-17)
 *   adopt    팀에 넣기 (8.2, auto) through `Adopt.plan` as enable plans it: keep refs, every lock before any
 *            registration, the detached HEAD named, the owner registered; R4 is decided here and a folder it cannot
 *            judge (or whose identity fails) is skipped, not adopted (3.7)
 *   new      `AreaCreate` (branch, code-only worktree, owner; the setup command last). `from` an area starts at its
 *            branch's tip, a stopped or finished one's too: 다시 만들기 (8.8 a missing folder, 8.2 B after a merge),
 *            which keeps that area's user-made mark (2026-10-26; not in a run by `main`, 2026-10-27). The user's 영역
 *            만들기 also passes the area's own model (team R4 is checked there), its first owner's 에이전트 방식 and
 *            the mark
 *   split    `reorg/split.ts`: A's safe point and handoff, A2 from A's tip with A's area main and preset
 *   merge    `reorg/merge.ts`: B into A's branch, B's handoff and waiting requests to A, B's folder (a confirm)
 *   retire   `reorg/retire.ts`: keep refs, the outbox, the owner archived, `retired`, the folder (a confirm, 8.6)
 *   convert  `reorg/convert.ts`: full → code (auto unless ignored files would go, TI-2), code → full (a confirm)
 *   move     `reorg/rehome.ts` `session-move`: the user's action only (the main's or the judge's is a suggestion, V11)
 *
 * Skip and wait rules (8.1, TI-9, TI-13): an action of the main or the judge (`main`, `auto`) on an area under Main
 * 멈춤, a broken one, or one away from its safe point (the extended one for a conversion, 8.4) is skipped now: a
 * `skipped` card line and a `reorg.skipped` notice (sent when the op starts), and the main may propose it again later.
 * Since 2026-10-16 the main's answer names each skip (`tools/reorganize.ts`), a Main 멈춤 or busy skip's card line
 * carries the action (`op`) so the card offers it again as the user's own action, and the plan lists those skips in
 * `plan.skipped` (팀 구성 다시 보기 offers them unchecked). The main's preview (`team_reorganize{preview}`) relies on
 * planning writing nothing.
 * The user's action is planned anyway and its first step waits for the safe point and says why on the card
 * (`split-begin`, `merge-begin`, `retire.begin`, the conversion's and `session-move`'s observe). Removals, large
 * downloads and the WIP commit are confirm steps of their modules whoever proposed them (V11), so nothing the judge
 * says deletes or downloads without the user; a conversion asks before its rotation (`convert-confirm` holds it back).
 *
 * Planning writes nothing: it reads the registry, git and the sessions. An action whose step kinds this controller has
 * not registered is rejected as not available in this build.
 */

export type Action = JudgeValidate.ReorgAction["action"]

/** One action of the proposal and the indexes of its steps in the op. */
export interface Item {
  /** Pointer into the proposal (`ops/0`, `areas/1`). */
  readonly item: string
  readonly action: Action
  /** The area it changes or makes (a split's new area). */
  readonly areaID: OwnTeam.AreaID
  readonly steps: ReadonlyArray<number>
}

/** An action left out now because of its area (8.1: Main 멈춤, work, broken; an adoption R4 cannot judge). */
export interface Skipped {
  readonly item: string
  readonly areaID?: OwnTeam.AreaID
  readonly why: OwnTeam.SkipReason
  /** Plain Korean, for the notice and the tool's answer. */
  readonly text: string
  /** A `reorg.skipped` notice goes out when the op starts. */
  readonly notice: boolean
}

export interface Built {
  /** Renames, then adoptions (keep refs, locks, registrations), then the other actions, setup commands last. */
  readonly steps: ReadonlyArray<Steps.Spec>
  readonly items: ReadonlyArray<Item>
  readonly skipped: ReadonlyArray<Skipped>
  readonly rejected: ReadonlyArray<OwnTeam.Rejected>
  /** The op's card before it runs (9.3, 9.7): notes, suggestions, what was rejected or skipped. */
  readonly lines: ReadonlyArray<OwnTeam.SummaryLine>
  /** What applying does (`reorg.propose`): every step with its mode, and what is rejected or skipped. */
  readonly plan: OwnTeam.Plan
}

/** The inventory (3.2) a reorganization reads: as the V-rules see it, and as git printed it. */
export interface Gathered {
  readonly facts: JudgeValidate.Facts
  readonly inventory: Inventory.Result<Adopt.Root>
  readonly classified: ReadonlyArray<Classify.Classified>
}

/** Failures of the repository that hold for every new area: the whole call answers them. */
const ENVIRONMENT: ReadonlySet<OwnTeam.ErrorName> = new Set(["path_forbidden", "git_too_old", "not_git", "lfs_missing"])

/** A kind each action needs; when this controller lacks it the action is not in this build. */
const SUPPORT: Readonly<Record<Action, string>> = {
  new: AreaCreate.KIND.branch,
  rename: AreaCreate.KIND.rename,
  adopt: Adopt.KIND.register,
  split: AreaSplit.KIND.begin,
  merge: AreaMerge.KIND.begin,
  retire: Retire.KIND.mark,
  convert: Convert.STEP.code,
  move: Rehome.STEP,
}

const UNSUPPORTED = "이 버전에서는 아직 할 수 없는 재구성이에요"

/** Where an action's steps go in the op: every lock before any registration (3.6), setup commands last. */
const RANK = { rename: 0, keep: 1, lock: 2, adopt: 3, action: 4, setup: 5 } as const

export async function build(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly proposal: OwnTeam.Proposal
    readonly by: OwnTeam.Op["by"]
    /**
     * Who wrote the proposal when another runs it (2026-10-27): the main's proposal that the user's yes runs by `user`
     * (V-f, V-b (5), `tools/reorganize.ts`) and the judge's items the user chose in 팀 구성 다시 보기
     * (`reorg.apply{proposalID, items}`) keep none of what only the user sets, and their conversation moves stay
     * suggestions (V11). Absent: `by` wrote it.
     */
    readonly author?: OwnTeam.Op["by"]
    /** What `reorg.propose` read already; otherwise read here when the proposal adopts or suggests. */
    readonly gathered?: Gathered
  },
): Promise<Services.Result<Built>> {
  const team = input.team
  const areas = await services.registry.areas.list(team.id)
  const gathered = input.gathered ?? (wants(input.proposal) ? await gather(services, team, areas) : undefined)
  const validated = JudgeValidate.reorganize(
    input.proposal,
    {
      target: team.target,
      areas,
      heavy: team.heavy.dirs,
      ...(gathered === undefined ? {} : { inventory: gathered.facts }),
    },
    input.author ?? input.by,
  )
  const adopted = await adoption(services, { team, gathered, actions: validated.actions })
  const state: State = {
    parts: [...adopted.parts],
    skipped: [...adopted.skipped],
    refused: [...validated.rejected.map((entry) => ({ ...entry, reason: "invalid" as const })), ...adopted.refused],
    made: new Set(adopted.parts.map((part) => part.areaID)),
    starts: new Map(),
  }
  for (const action of validated.actions) {
    if (action.action === "adopt") continue
    const planned = await one(services, { team, areas, action, by: input.by, starts: state.starts })
    if (planned.kind === "failed") return planned.failure
    if (planned.kind === "skipped") state.skipped.push(...planned.entries)
    if (planned.kind === "refused") state.refused.push({ item: action.item, why: planned.why, reason: planned.reason })
    if (planned.kind !== "steps") continue
    // Two new areas (or a new one and an adopted one) that end up with one id: the later one is left out (V4).
    const creates = action.action === "new" || action.action === "split"
    if (creates && state.made.has(planned.areaID)) {
      state.refused.push({ item: action.item, why: `${planned.areaID} 이름이 겹쳐요`, reason: "invalid" })
      continue
    }
    if (creates) state.made.add(planned.areaID)
    state.parts.push(
      ...planned.specs.map((spec) => ({
        item: action.item,
        action: action.action,
        areaID: planned.areaID,
        spec,
        rank: action.action === "rename" ? RANK.rename : spec.kind === AreaCreate.KIND.setup ? RANK.setup : RANK.action,
      })),
    )
  }
  const parts = state.parts.toSorted((a, b) => a.rank - b.rank)
  const rejected = state.refused.map((entry) => ({ item: entry.item, why: entry.why }))
  const items = [...new Map(parts.map((part) => [part.item, part])).values()].map(
    (part): Item => ({
      item: part.item,
      action: part.action,
      areaID: part.areaID,
      steps: parts.flatMap((other, index) => (other.item === part.item ? [index] : [])),
    }),
  )
  return {
    ok: true,
    steps: parts.map((part) => part.spec),
    items,
    skipped: state.skipped,
    rejected,
    lines: [
      ...(validated.notes === "" ? [] : [{ kind: "notes" as const, text: validated.notes }]),
      ...validated.suggest.map((suggestion) => ({ kind: "suggest" as const, suggestion })),
      // A conversation move turned into a suggestion is on the card as that suggestion.
      ...state.refused
        .filter((entry) => !validated.suggested.has(entry.item))
        .map((entry) => ({ kind: "skipped" as const, item: entry.item, why: entry.reason })),
      ...state.skipped.map((entry) => {
        const op = waits(entry) ? opOf(input.proposal, entry.item) : undefined
        return {
          kind: "skipped" as const,
          item: entry.item,
          ...(entry.areaID === undefined ? {} : { areaID: entry.areaID }),
          why: entry.why,
          ...(op === undefined ? {} : { op }),
        }
      }),
    ],
    plan: {
      steps: parts.map((part) => ({
        item: part.item,
        kind: part.spec.kind,
        mode: part.spec.mode ?? "auto",
        areaID: part.areaID,
      })),
      // The skips stay in `rejected` with their text for clients built before `skipped` (8.1, 2026-10-16).
      rejected: [...rejected, ...state.skipped.map((entry) => ({ item: entry.item, why: entry.text }))],
      skipped: state.skipped.flatMap((entry) =>
        waits(entry) && entry.areaID !== undefined && opOf(input.proposal, entry.item) !== undefined
          ? [{ item: entry.item, areaID: entry.areaID, why: entry.why }]
          : [],
      ),
    },
  }
}

/**
 * A skip the user's own run would wait out instead (8.1, 2026-10-16): Main 멈춤 or work in its area. A broken area,
 * or an adoption R4 cannot judge, is no wait.
 */
function waits(entry: Skipped): entry is Skipped & { readonly why: "paused" | "busy" } {
  return entry.why === "paused" || entry.why === "busy"
}

/** The proposal's `ops/N` action an item points at. */
function opOf(proposal: OwnTeam.Proposal, item: string) {
  const [section, index] = item.split("/")
  return section === "ops" ? proposal.ops?.[Number(index)] : undefined
}

/**
 * The inventory a reorganization's V-rules and adoptions need (3.2): the project's root sessions, the worktrees as
 * classified for the team's home and patterns, and V13's verified retirements of the active areas. `undefined` when
 * git cannot list the worktrees.
 */
export async function gather(
  services: Services.Context,
  team: OwnTeam.Team,
  areas: ReadonlyArray<OwnTeam.Area>,
): Promise<Gathered | undefined> {
  const sessions = await Adopt.roots(services, team.projectID)
  const inventory = await Inventory.collect(team.commonDir, team.target, sessions)
  if (!inventory.ok) {
    services.log.warn("reorg_inventory_failed", { teamID: team.id, message: inventory.message })
    return undefined
  }
  const classified = Classify.classify(inventory.worktrees, { home: team.home.directory, patterns: team.patterns })
  const now = services.clock.now()
  const live = areas.filter((area) => area.state !== "retired")
  const [worktrees, retirable] = await Promise.all([
    Promise.all(
      inventory.worktrees.map(async (item, index): Promise<JudgeValidate.Worktree> => {
        const found = classified[index]
        const placed = item.sessions.toSorted((a, b) => b.updated - a.updated)
        return {
          path: item.path,
          class: found?.class ?? "candidate",
          nested: found?.nested ?? false,
          branch: item.branch,
          head: item.head,
          active: Activity.isActive(item, now),
          changes: item.changes?.uncommitted ?? 0,
          ahead: item.ahead ?? 0,
          sessions: placed.map((session) => session.id),
          updated: placed[0]?.updated ?? null,
          sparse: found?.class === "candidate" ? await Adopt.sparse(item.path) : false,
        }
      }),
    ),
    retirableOf(team, live, now),
  ])
  return {
    inventory,
    classified,
    facts: {
      target: team.target,
      worktrees,
      branches: inventory.branches.map((branch) => branch.name),
      // Heavy folders, shared folders and commands are not changed by a reorganization: V7, V8 and V10 read nothing.
      trees: new Set<string>(),
      direct: {},
      ignored: [],
      commands: [],
      retirable,
      areas: live.map((area) => ({
        slug: area.id.slice("ar_".length),
        directory: area.directory,
        branch: area.branch,
        owner: area.owner.sessionID,
      })),
      mainSessionID: team.main.sessionID,
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------

interface Part {
  readonly item: string
  readonly action: Action
  readonly areaID: OwnTeam.AreaID
  readonly spec: Steps.Spec
  readonly rank: number
}

interface Refusal extends OwnTeam.Rejected {
  readonly reason: "invalid" | "unsupported"
}

interface State {
  readonly parts: Part[]
  readonly skipped: Skipped[]
  readonly refused: Refusal[]
  /** Areas this plan makes (adopted, new, split off). */
  readonly made: Set<OwnTeam.AreaID>
  /** A new area's slug → where it starts (`main` or an area's slug): a later `from` naming it starts there too. */
  readonly starts: Map<string, string>
}

type Planned =
  | { readonly kind: "steps"; readonly areaID: OwnTeam.AreaID; readonly specs: ReadonlyArray<Steps.Spec> }
  | { readonly kind: "skipped"; readonly entries: ReadonlyArray<Skipped> }
  | { readonly kind: "refused"; readonly why: string; readonly reason: Refusal["reason"] }
  | { readonly kind: "failed"; readonly failure: Services.Failure }

/** The proposal adopts a folder or suggests something: the inventory is read for V2, V3, V4 and V13. */
function wants(proposal: OwnTeam.Proposal) {
  return (proposal.areas ?? []).some((area) => area.adopt) || (proposal.suggest ?? []).length > 0
}

/** One action other than an adoption. */
async function one(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly areas: ReadonlyArray<OwnTeam.Area>
    readonly action: Exclude<JudgeValidate.ReorgAction, { readonly action: "adopt" }>
    readonly by: OwnTeam.Op["by"]
    readonly starts: Map<string, string>
  },
): Promise<Planned> {
  const action = input.action
  if (!services.steps.get(SUPPORT[action.action])) return { kind: "refused", why: UNSUPPORTED, reason: "unsupported" }
  const planned = await stepsOf(services, input)
  if (planned.kind !== "steps") return planned
  // Every kind of the plan must be here (a merge also removes B's folder with the retire kinds).
  if (planned.specs.some((spec) => !services.steps.get(spec.kind)))
    return { kind: "refused", why: UNSUPPORTED, reason: "unsupported" }
  if (action.action === "new" || action.action === "split")
    input.starts.set(action.slug, action.action === "new" ? startOf(action, input.starts) : slugOf(action.areaID))
  return planned
}

async function stepsOf(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly areas: ReadonlyArray<OwnTeam.Area>
    readonly action: Exclude<JudgeValidate.ReorgAction, { readonly action: "adopt" }>
    readonly by: OwnTeam.Op["by"]
    readonly starts: ReadonlyMap<string, string>
  },
): Promise<Planned> {
  const team = input.team
  const action = input.action
  const by = input.by
  if (action.action === "rename") {
    // A new role changes what the owner works on: the main's on an area under Main 멈춤 or direct work waits (TI-13),
    // as `team_area{role}` does; a plain rename and the mark leave the work alone.
    const held = input.areas.find((area) => area.id === action.areaID)
    if (action.goal !== undefined && by !== "user" && held !== undefined && Direct.kept(held))
      return { kind: "skipped", entries: [skipped(action.item, held, "paused")] }
    return stepped(action.areaID, [
      {
        kind: AreaCreate.KIND.rename,
        args: {
          areaID: action.areaID,
          name: action.name,
          previous: action.previous,
          ...(action.subtitle === undefined ? {} : { subtitle: action.subtitle }),
          ...(action.goal === undefined ? {} : { goal: action.goal }),
          ...(action.userMade === true ? { userMade: true } : {}),
        },
      },
    ])
  }
  if (action.action === "new") {
    // 다시 만들기 of a stopped or finished area keeps its user-made mark (2026-10-26), but never in the main's own run:
    // the main's 다시 만들기 of such an area is a plan the user's yes runs (`tools/reorganize.ts`, 2026-10-27). A `from`
    // naming an area this proposal makes starts where that one starts (`starts`), so the source is the record there
    // (none at main), never an older record of the slug it names.
    const start = startOf(action, input.starts)
    const source = start === "main" ? undefined : input.areas.find((area) => area.id === Areas.id(start))
    const again = by !== "main" && source !== undefined && source.state !== "active" && source.userMade !== undefined
    const made = await services.features().areas.plan({
      team,
      slug: action.slug,
      name: action.name,
      goal: action.goal,
      needs: action.needs,
      from: start,
      by,
      ...(action.main === undefined ? {} : { main: action.main }),
      ...(action.harness === undefined ? {} : { harness: action.harness }),
      ...(action.userMade === true || again ? { userMade: true } : {}),
    })
    if (!made.ok) return ENVIRONMENT.has(made.error) ? { kind: "failed", failure: made } : refusal(made)
    return stepped(made.areaID, made.steps)
  }
  // The V-rules found every area named; a record gone since is refused.
  const area = input.areas.find((item) => item.id === action.areaID)
  if (!area) return { kind: "refused", why: "영역이 없어요", reason: "invalid" }
  if (action.action === "split") {
    const skip = await gate(services, { team, areas: [area], by, item: action.item, extended: false })
    if (skip) return skip
    const split = await AreaSplit.plan(services, {
      team,
      areaID: area.id,
      slug: action.slug,
      name: action.name,
      goal: action.goal,
      by,
    })
    if (!split.ok) return ENVIRONMENT.has(split.error) ? { kind: "failed", failure: split } : refusal(split)
    return stepped(split.areaID, split.steps)
  }
  if (action.action === "merge") {
    const from = input.areas.find((item) => item.id === action.from)
    if (!from) return { kind: "refused", why: "영역이 없어요", reason: "invalid" }
    const skip = await gate(services, { team, areas: [area, from], by, item: action.item, extended: false })
    if (skip) return skip
    const merge = await AreaMerge.plan(services, { team, into: area.id, from: from.id })
    if (!merge.ok) return refusal(merge)
    return stepped(merge.areaID, merge.steps)
  }
  if (action.action === "retire") {
    // Retire.plan has the rules itself: Main 멈춤, broken and busy skip the main and the judge; the user's waits for the
    // safe point in its first step.
    const retire = await Retire.plan(services, { team, area, by, item: action.item })
    if (!retire.ok) return refusal(retire)
    if (retire.steps.length > 0) return stepped(area.id, retire.steps)
    return {
      kind: "skipped",
      entries: retire.lines.flatMap((line) =>
        line.kind === "skipped" && line.why !== "unsupported" && line.why !== "invalid"
          ? [skipped(action.item, area, line.why)]
          : [],
      ),
    }
  }
  if (action.action === "convert") {
    const skip = await gate(services, { team, areas: [area], by, item: action.item, extended: true })
    if (skip) return skip
    const checked = await Convert.check({ team, area, shape: action.shape }, action.item)
    if (!checked.ok) return refusal(checked)
    return stepped(
      area.id,
      Convert.steps({ area, shape: action.shape, mode: checked.mode, by, item: action.item, quiet: checked.quiet }),
    )
  }
  return move(services, { team, areas: input.areas, area, action })
}

/** 대화 옮기기 (the user's): a root conversation that is neither the team main nor an owner, moved at its idle point. */
async function move(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly areas: ReadonlyArray<OwnTeam.Area>
    readonly area: OwnTeam.Area
    readonly action: Extract<JudgeValidate.ReorgAction, { readonly action: "move" }>
  },
): Promise<Planned> {
  const sessionID = input.action.sessionID
  const session = await services.http.session.get({ sessionID, directory: input.team.home.directory })
  if (!session.ok) return { kind: "refused", why: "옮길 대화가 없어요", reason: "invalid" }
  // core moves a conversation without its children (8.2): a child alone is never moved.
  if (session.value.parentID !== undefined)
    return { kind: "refused", why: "하위 대화는 따로 옮기지 않아요", reason: "invalid" }
  const role = await services.locate.session(sessionID)
  // Their folder is the registry's (메인 폴더 바꾸기, 팀에서 빼기), an owner being created's too.
  if (role?.role === "main" || role?.role === "owner" || input.areas.some((area) => area.owner.pending === sessionID))
    return { kind: "refused", why: "팀 메인과 담당 대화는 이 동작으로 옮기지 않아요", reason: "invalid" }
  return stepped(input.area.id, [
    Rehome.spec({
      sessionID,
      from: session.value.location.directory,
      to: input.area.directory,
      areaID: input.area.id,
      item: input.action.item,
    }),
  ])
}

/**
 * 팀에 넣기 (8.2, auto) of every `areas[].adopt` item in one `Adopt.plan`, as enable plans it: each decision sees the
 * team's R4 with the areas planned before it, and a folder it cannot judge, or whose identity fails, is skipped (3.7).
 */
async function adoption(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly gathered: Gathered | undefined
    readonly actions: ReadonlyArray<JudgeValidate.ReorgAction>
  },
): Promise<{ readonly parts: Part[]; readonly skipped: Skipped[]; readonly refused: Refusal[] }> {
  const adopts = input.actions.flatMap((action) => (action.action === "adopt" ? [action] : []))
  const gathered = input.gathered
  if (adopts.length === 0 || gathered === undefined) return { parts: [], skipped: [], refused: [] }
  if (!services.steps.get(SUPPORT.adopt))
    return {
      parts: [],
      skipped: [],
      refused: adopts.map((action) => ({ item: action.item, why: UNSUPPORTED, reason: "unsupported" })),
    }
  const inventory = gathered.inventory
  const found = adopts.flatMap((action) => {
    const index = inventory.worktrees.findIndex((entry) => Classify.same(entry.path, action.adopt.worktree))
    const worktree = inventory.worktrees[index]
    if (!worktree) return []
    const outer = gathered.classified[index]?.outer ?? null
    const around = outer === null ? undefined : gathered.classified.find((entry) => entry.path === outer)
    const adopt = action.adopt
    const candidate: Adopt.Candidate = {
      item: action.item,
      slug: adopt.slug,
      name: adopt.name,
      // A proposal that names the area after its folder has no subtitle.
      ...(adopt.subtitle === "" || adopt.subtitle === adopt.name ? {} : { subtitle: adopt.subtitle }),
      goal: adopt.goal,
      shape: adopt.shape,
      worktree,
      ...(around === undefined ? {} : { outer: { path: around.path, class: around.class } }),
      owner: adopt.owner,
      // The user's own adopt row (영역 만들기 · 있는 작업 폴더, 2026-10-26).
      ...(action.userMade === true ? { userMade: true } : {}),
    }
    return [{ action, candidate, worktree }]
  })
  const planned = await Adopt.plan(services, {
    team: input.team,
    candidates: found.map((entry) => entry.candidate),
    branches: inventory.branches.map((branch) => branch.name),
  })
  const kept = new Set<string>()
  const parts = found.flatMap((entry): Part[] => {
    const areaID = Areas.id(entry.candidate.slug)
    if (!planned.areas.includes(areaID)) return []
    const head = entry.worktree.head
    // TI-8: commits only a detached HEAD holds are kept first; two folders at one HEAD keep it once.
    const keep =
      entry.worktree.detachedOnly.length > 0 && head !== null && !kept.has(head)
        ? [{ id: `keep:${head}`, kind: Adopt.KIND.keep, args: { ref: `refs/own/keep/${head}`, oid: head } }]
        : []
    if (head !== null) kept.add(head)
    const part = (spec: Steps.Spec, rank: number): Part => ({
      item: entry.action.item,
      action: "adopt",
      areaID,
      spec,
      rank,
    })
    return [
      ...keep.map((spec) => part(spec, RANK.keep)),
      ...planned.locks
        .filter((spec) => spec.id === `lock:${areaID}` || spec.id === `lock:outer:${areaID}`)
        .map((spec) => part(spec, RANK.lock)),
      ...planned.steps.filter((spec) => spec.args?.areaID === areaID).map((spec) => part(spec, RANK.adopt)),
    ]
  })
  const skipped = planned.lines.flatMap((line): Skipped[] =>
    line.kind === "skipped"
      ? [
          {
            item: line.item,
            ...(line.areaID === undefined ? {} : { areaID: line.areaID }),
            why: line.why,
            text:
              line.why === "broken"
                ? "폴더의 정보가 맞지 않아 팀에 넣지 않았어요"
                : "계정 규칙을 판정할 수 없어 팀에 넣지 않았어요",
            notice: false,
          },
        ]
      : [],
  )
  return { parts, skipped, refused: [] }
}

/**
 * TI-13, then TI-9 for an action of the main or the judge: an area under Main 멈춤, a broken one or one away from its
 * safe point (`extended`: no pty either, 8.4) skips the action. A user's action always goes on (its first step waits).
 */
async function gate(
  services: Services.Context,
  input: {
    readonly team: OwnTeam.Team
    readonly areas: ReadonlyArray<OwnTeam.Area>
    readonly by: OwnTeam.Op["by"]
    readonly item: string
    readonly extended: boolean
  },
): Promise<Planned | undefined> {
  if (input.by === "user") return undefined
  // The skip literal stays `paused` for an area held by direct work too (the wire's closed list); own-web words it.
  const paused = input.areas.find(Direct.kept)
  if (paused) return { kind: "skipped", entries: [skipped(input.item, paused, "paused")] }
  const broken = input.areas.find((area) => area.state === "broken")
  if (broken) return { kind: "skipped", entries: [skipped(input.item, broken, "broken")] }
  const checks = await Promise.all(
    input.areas.map((area) =>
      services.features().safePoint.check({ teamID: input.team.id, areaID: area.id, extended: input.extended }),
    ),
  )
  const busy = input.areas.find((_, index) => !checks[index]?.ok)
  return busy === undefined ? undefined : { kind: "skipped", entries: [skipped(input.item, busy, "busy")] }
}

const SKIP_TEXT: Readonly<Record<"paused" | "busy" | "broken", (name: string) => string>> = {
  paused: (name) => `'${name}' 영역은 메인 멈춤이라 이번 정리에서 건너뛰었어요`,
  busy: (name) => `'${name}' 영역에서 일하는 중이라 이번 정리에서 건너뛰었어요`,
  broken: (name) => `'${name}' 영역이 멈춘 상태라 이번 정리에서 건너뛰었어요`,
}

function skipped(item: string, area: OwnTeam.Area, why: "paused" | "busy" | "broken"): Skipped {
  return { item, areaID: area.id, why, text: SKIP_TEXT[why](area.name), notice: true }
}

function stepped(areaID: OwnTeam.AreaID, specs: ReadonlyArray<Steps.Spec>): Planned {
  return { kind: "steps", areaID, specs }
}

/** A module's refusal of one action, in plain Korean; the rest of the proposal goes on. */
function refusal(failure: Services.Failure): Planned {
  return {
    kind: "refused",
    why: reason(failure),
    reason: failure.error === "unsupported" ? "unsupported" : "invalid",
  }
}

function reason(failure: Services.Failure) {
  if (failure.error === "invalid_proposal")
    return failure.data.rejected.map((entry) => entry.why).join(", ") || failure.message
  if (failure.error === "dirty") return `아직 저장 지점에 넣지 않은 변경 ${failure.data.count}개가 있어 할 수 없어요`
  if (failure.error === "not_safe_point") return "영역에서 일하는 중이라 지금은 할 수 없어요. 일이 끝난 뒤 다시 하세요"
  if (failure.error === "broken") return "영역 폴더가 멈춘 상태라 할 수 없어요"
  if (failure.error === "not_found") return "영역이 없어요"
  if (failure.error === "unsupported") return UNSUPPORTED
  if (failure.error === "busy") return "팀에서 다른 작업이 진행 중이라 할 수 없어요. 끝난 뒤 다시 하세요"
  if (failure.error === "team_off") return "팀 모드가 꺼져 있어요"
  if (failure.error === "conflict") return "그 사이 기록이 바뀌어 할 수 없어요. 다시 하세요"
  if (failure.error === "git_too_old")
    return `Git이 너무 오래돼 할 수 없어요(지금 ${failure.data.version}, ${failure.data.minimum} 이상 필요)`
  if (failure.error === "lfs_missing") return "큰 파일 도구(git-lfs)가 없어 할 수 없어요"
  if (failure.error === "not_git") return "Git 저장소를 읽지 못해 할 수 없어요"
  // A module's own message (git's output included) for the rest.
  return failure.message
}

/** Where a new area starts: `main`, an area's slug, or where a new area earlier in the plan starts (no branch yet). */
function startOf(
  action: Extract<JudgeValidate.ReorgAction, { readonly action: "new" }>,
  starts: ReadonlyMap<string, string>,
) {
  return action.from === "main" ? "main" : (starts.get(action.from) ?? action.from)
}

function slugOf(areaID: OwnTeam.AreaID) {
  return areaID.slice("ar_".length)
}

/**
 * V13: active areas with commits of their own, all in the target, and clean (8.1's signal without the 7 days). An area
 * the user set up or works in directly is a standing one: never offered for ending (AL-5).
 */
async function retirableOf(team: OwnTeam.Team, areas: ReadonlyArray<OwnTeam.Area>, now: number) {
  const checked = await Promise.all(
    areas
      .filter((area) => area.state === "active" && area.userMade === undefined && area.directWork === undefined)
      .map(async (area) => {
        const facts = await Retire.facts({ team, area, now })
        return facts !== undefined && facts.commits > 0 && facts.unapplied === 0 && facts.clean
          ? [Classify.key(area.directory)]
          : []
      }),
  )
  return new Set(checked.flat())
}
