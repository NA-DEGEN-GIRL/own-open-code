export * as JudgeValidate from "./validate.js"

import path from "node:path"
import { Schema } from "effect"
import type { Model } from "@opencode/schema/model"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Classify } from "../git/classify.js"

/**
 * The V-rules of 06 §3.5 over a decoded proposal (V1 is `schema.ts`). Pure: everything the rules need from git, the
 * sessions and the registry comes in as {@link Facts}, which enable (and reorganization) observe right before. A
 * broken item is dropped, fixed or truncated, never the whole proposal:
 *
 *   V2  worktrees, branches and sessions named must be in the inventory (this common dir)      drop the item
 *   V3  the main worktree, another tool's folder, a `#` path, a gone one or the home are never adopted   → `leave`
 *   V4  a worktree, branch or session in at most one area; the main session is never an owner  drop the later one
 *   V5  (removed 2026-11-14: no area limit for anyone, AL-1; the number is kept)
 *   V6  slug `[a-z0-9-]{1,32}`, unique in the team; a taken branch name gets `-2`              fix
 *   V7  heavy folders are trees of the target, never the root; a cone under 1% of files warns  drop, warn
 *   V8  shared folders are ignored, untracked folders of the home, not a tool cache            drop
 *   V9  `full` only for an adopted full folder                                                 `code`
 *   V10 commands are names from the program's candidate list                                   drop
 *   V11 suggestions (and removals, large downloads, system changes) are never `auto`           confirm only
 *   V12 name 40, goal 1,000, notes 400 characters, no control characters                       truncate; goals,
 *       notes and reasons end in `…` when cut
 *   V13 an active candidate is adopted or listed on the card; `retire` only when verified      card / drop
 *
 * Repository content (README, branch names, session titles) reaches the judge, so its output can carry injected text
 * (06 §2.3). That is why nothing here can produce a destructive step or a command string of its own.
 *
 * A reorganization (06 §8.1–8.2: `reorg.apply`, `reorg.propose`, `team_reorganize`) goes through {@link reorganize}:
 * the same rules over its `ops` and `areas`, against the team's areas. Heavy folders, shared folders, commands and the
 * target are not changed by a reorganization; a conversation move is the user's alone (V11: the main's or the
 * judge's becomes a suggestion).
 */

/** V12 limits, in characters. An area's role (`goal`) is 1,000 (2026-11-14), as `area.edit` takes it. */
export const LIMITS = { name: 40, goal: 1_000, notes: 400, why: 200 } as const

/** Not a limit: a proposal that makes more new areas than this at once is shown to the user first (AL-3). */
export const BATCH = 4

/** V8: tool caches are never shared folders. */
export const TOOL_CACHES = [
  "node_modules",
  "Library",
  ".godot",
  "DerivedDataCache",
  "Intermediate",
  "build",
  "dist",
  ".venv",
  "target",
  ".gradle",
] as const

/** V7: a code-only cone with fewer files than this share of the repository is warned about. */
export const CONE_WARNING_SHARE = 0.01

export interface Worktree {
  /** As git prints it. */
  readonly path: string
  readonly class: Classify.Class
  readonly nested: boolean
  readonly branch: string | null
  readonly head: string | null
  /** 06 §3.4 activity. */
  readonly active: boolean
  /** Paths with uncommitted work. */
  readonly changes: number
  /** Commits not in the target. */
  readonly ahead: number
  /** Root sessions placed in it, most recently updated first. */
  readonly sessions: ReadonlyArray<string>
  /** Most recent root session update, epoch ms. */
  readonly updated: number | null
  /** A sparse (code-only) checkout; an adopted one keeps its shape (3.7: enabling converts nothing). */
  readonly sparse: boolean
}

/** A command the program found (V10): `setup` installs, `code` checks. */
export interface Candidate {
  readonly name: string
  readonly kind: "setup" | "code"
  readonly command: OwnTeam.Command
}

/** An area of the team already (reorganization, a converged enable). */
export interface Existing {
  readonly slug: string
  readonly directory: string
  readonly branch: string
  readonly owner: string | null
}

export interface Facts {
  readonly target: string
  /** Inventory order, classified (06 §3.2). */
  readonly worktrees: ReadonlyArray<Worktree>
  /** Local branch names. */
  readonly branches: ReadonlyArray<string>
  /** Folders of the target's tree (`ls-tree -r -d`), `/`-separated. */
  readonly trees: ReadonlySet<string>
  /** Files directly in each folder of the target (`Measure.Result.direct`). */
  readonly direct: Readonly<Record<string, { readonly files: number; readonly bytes: number }>>
  /** Ignored, untracked folders of the home (`Measure.Result.ignored`). */
  readonly ignored: ReadonlyArray<string>
  readonly commands: ReadonlyArray<Candidate>
  /** V13: `Classify.key` of folders whose retirement the program verified (unique commits, all in the target, clean). */
  readonly retirable: ReadonlySet<string>
  readonly areas: ReadonlyArray<Existing>
  /** Folder names already under the worktree root (a new area's folder is `<root>/<slug>`). */
  readonly taken?: ReadonlyArray<string>
  readonly mainSessionID?: string
}

export interface Dir {
  readonly dir: string
  readonly why: string
}

export interface Create {
  /** Pointer into the proposal (`areas/1`). */
  readonly item: string
  readonly slug: string
  readonly name: string
  readonly goal: string
  readonly needs: ReadonlyArray<string>
  /** `main` or the slug of an area made before it. */
  readonly from: string
  readonly shape: "code" | "plain"
}

export interface Adopt {
  readonly item: string
  readonly slug: string
  /** The folder name (3.7); the judge's name is the subtitle. */
  readonly name: string
  readonly subtitle: string
  readonly goal: string
  readonly worktree: string
  readonly branch: string | null
  /** Default: the folder's most recent root session. */
  readonly owner: string | null
  readonly needs: ReadonlyArray<string>
  readonly shape: "plain" | "code" | "full"
}

export interface Validated {
  readonly target: string
  readonly heavy: ReadonlyArray<Dir>
  readonly shared: ReadonlyArray<Dir>
  readonly create: ReadonlyArray<Create>
  readonly adopt: ReadonlyArray<Adopt>
  readonly leave: ReadonlyArray<{ readonly worktree: string; readonly why: string }>
  readonly suggest: ReadonlyArray<OwnTeam.Suggestion>
  readonly commands: OwnTeam.Commands
  readonly notes: string
  /** V13: active candidates not adopted, shown on the card with `팀에 넣기`. */
  readonly unadopted: ReadonlyArray<Worktree>
  readonly rejected: ReadonlyArray<OwnTeam.Rejected>
  readonly warnings: ReadonlyArray<string>
  /** What applying would do: areas are `auto`, suggestions `confirm` (V11). */
  readonly plan: OwnTeam.Plan
}

export function validate(proposal: OwnTeam.Proposal, facts: Facts): Validated {
  const rejected: OwnTeam.Rejected[] = []
  const reject = (item: string, why: string) => {
    rejected.push({ item, why })
  }
  const target = proposal.target === undefined || proposal.target === facts.target ? facts.target : undefined
  if (target === undefined) reject("target", "프로젝트 본 코드는 이 앱이 정해요")
  const heavy = heavyOf(proposal, facts, reject)
  const areas = areasOf(proposal, facts, heavy, reject)
  const adopted = new Set(areas.adopt.map((area) => Classify.key(area.worktree)))
  const slugs = new Set([...facts.areas.map((area) => area.slug), ...areas.adopt.map((area) => area.slug)])
  const leave = leaveOf(proposal, facts, adopted, areas.left, reject)
  const suggest = suggestOf(proposal, facts, areas.renamed, slugs, reject)
  return {
    target: facts.target,
    heavy,
    shared: sharedOf(proposal, facts, reject),
    create: areas.create,
    adopt: areas.adopt,
    leave,
    suggest,
    commands: commandsOf(proposal, facts, reject),
    notes: clean(proposal.notes ?? "", LIMITS.notes, true),
    unadopted: facts.worktrees.filter(
      (item) => item.class === "candidate" && item.active && !adopted.has(Classify.key(item.path)),
    ),
    rejected,
    warnings: coneWarning(facts, heavy),
    plan: {
      steps: [
        ...areas.adopt.map((area) => ({
          item: area.item,
          kind: "area-adopt",
          mode: "auto" as const,
          areaID: OwnTeam.AreaID.make(`ar_${area.slug}`),
        })),
        ...areas.create.map((area) => ({
          item: area.item,
          kind: "area-create",
          mode: "auto" as const,
          areaID: OwnTeam.AreaID.make(`ar_${area.slug}`),
        })),
        // V11: a suggestion is never run by itself; the card shows it and the user starts it.
        ...suggest.map((item, index) => ({
          item: `suggest/${index}`,
          kind: `suggest-${item.kind}`,
          mode: "confirm" as const,
        })),
      ],
      rejected,
    },
  }
}

/** V6: ASCII lower case, digits and hyphens, at most 32, starting with a letter or digit; `""` when nothing is left. */
export function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
}

/**
 * V12: control characters become spaces, whitespace runs one space, then at most `max` characters (code points).
 * `mark` (2026-11-14: notes, reasons, the judge's roles): a cut text ends in `…`, within `max`, so a reader sees that
 * more was written.
 */
export function clean(value: string, max: number, mark = false) {
  const plain = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const chars = [...plain]
  if (chars.length <= max) return plain
  if (!mark) return chars.slice(0, max).join("").trimEnd()
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`
}

/**
 * A repository folder as own writes it: `/`-separated, no leading `./` or `/`, no trailing `/`. `undefined` for the
 * root, an absolute path, or a `.`/`..` segment.
 */
export function folder(value: string) {
  const slashed = value.trim().replaceAll("\\", "/")
  if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith("//")) return undefined
  const trimmed = slashed.replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "")
  if (trimmed === "") return undefined
  const parts = trimmed.split("/")
  return parts.some((part) => part === "" || part === "." || part === "..") ? undefined : trimmed
}

/** `child` is `parent` or inside it (repository folders). */
export function within(parent: string, child: string) {
  return child === parent || child.startsWith(`${parent}/`)
}

/**
 * The growth judge's answer checked strictly (06 §4.4, `assets/heavy.ts`). The judge only splits the rule's
 * candidates that also hold code: an answered folder is kept when it is a folder of the measured commit inside one of
 * those candidates and large enough on its own (`qualifies`, by size or the team's limits). Repository text reaches
 * the judge, so nothing it says can make a folder outside a candidate, or a small code folder, collapse; and a split
 * that would leave most of a candidate's bytes in every area (the kept folders hold less than half of it) is refused.
 * A candidate the answer splits is replaced by the kept folders inside it; one it leaves alone (or splits only into
 * refused folders) stays whole, the rule's choice. Outer folders first, so a folder inside a kept one is dropped. Pure.
 */
export function grown(input: {
  readonly answer: ReadonlyArray<{ readonly dir: string }>
  /** The rule's candidates the judge was asked about. */
  readonly candidates: ReadonlyArray<string>
  /** A folder of the measured commit that is large enough on its own (size or limits). */
  readonly qualifies: (dir: string) => boolean
  /** Bytes a full checkout of a folder of the measured commit writes. */
  readonly bytes: (dir: string) => number
}): { readonly dirs: ReadonlyArray<string>; readonly rejected: ReadonlyArray<OwnTeam.Rejected> } {
  const rejected: OwnTeam.Rejected[] = []
  const listed = input.answer.map((item, index) => ({ item: `heavy/${index}`, dir: folder(item.dir) }))
  const kept = listed
    .toSorted((a, b) => depth(a.dir) - depth(b.dir))
    .reduce<string[]>((found, entry) => {
      const dir = entry.dir
      if (dir === undefined) {
        rejected.push({ item: entry.item, why: "맨 위 폴더나 잘못된 경로는 큰 파일 폴더가 될 수 없어요" })
        return found
      }
      if (!input.candidates.some((candidate) => within(candidate, dir))) {
        rejected.push({ item: entry.item, why: "후보 밖의 폴더는 고를 수 없어요" })
        return found
      }
      if (!input.qualifies(dir)) {
        rejected.push({ item: entry.item, why: "크기나 바이너리 비율이 큰 파일 폴더에 못 미쳐요" })
        return found
      }
      if (found.some((item) => within(item, dir))) return found
      return [...found, dir]
    }, [])
  const dirs = input.candidates.flatMap((candidate) => {
    const inside = kept.filter((dir) => within(candidate, dir))
    if (inside.length === 0) return [candidate]
    const taken = inside.reduce((sum, dir) => sum + input.bytes(dir), 0)
    if (taken * 2 >= input.bytes(candidate)) return inside
    rejected.push({ item: candidate, why: "고른 폴더가 후보 크기의 절반에 못 미쳐 후보를 그대로 둬요" })
    return [candidate]
  })
  return { dirs: [...new Set(dirs)].toSorted(), rejected }
}

/** The slug with `-2`, `-3`, … until `taken` says no (V6), kept within 32 characters. */
export function unique(base: string, taken: (slug: string) => boolean) {
  const start = base === "" ? "area" : base
  const next = (n: number): string => {
    const suffix = n === 1 ? "" : `-${n}`
    const candidate = `${start.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`
    return taken(candidate) ? next(n + 1) : candidate
  }
  return next(1)
}

const OUTSIDE: Readonly<Partial<Record<Classify.Class, string>>> = {
  home: "메인 폴더",
  primary: "저장소의 원래 폴더",
  "other-tool": "다른 도구의 작업 폴더",
  "hash-path": "#이 든 경로",
  prunable: "낡은 항목",
}

type Reject = (item: string, why: string) => void

/** V7. Outer folders first, so a folder inside an accepted one is dropped. */
function heavyOf(proposal: OwnTeam.Proposal, facts: Facts, reject: Reject): Dir[] {
  const listed = (proposal.heavy ?? []).map((item, index) => ({
    item: `heavy/${index}`,
    dir: folder(item.dir),
    why: item.why,
  }))
  const ordered = listed.toSorted((a, b) => depth(a.dir) - depth(b.dir))
  return ordered.reduce<Dir[]>((kept, entry) => {
    if (entry.dir === undefined) {
      reject(entry.item, "맨 위 폴더나 잘못된 경로는 큰 파일 폴더가 될 수 없어요")
      return kept
    }
    const dir = entry.dir
    if (!facts.trees.has(dir)) {
      reject(entry.item, "프로젝트 본 코드에 없는 폴더예요")
      return kept
    }
    if (kept.some((item) => within(item.dir, dir))) {
      reject(entry.item, "이미 고른 큰 파일 폴더 안에 있어요")
      return kept
    }
    return [...kept, { dir, why: clean(entry.why, LIMITS.why, true) }]
  }, [])
}

function coneWarning(facts: Facts, heavy: ReadonlyArray<Dir>) {
  if (heavy.length === 0) return []
  const counts = Object.entries(facts.direct)
  const total = counts.reduce((sum, [, entry]) => sum + entry.files, 0)
  const left = counts
    .filter(([dir]) => !heavy.some((item) => within(item.dir, dir)))
    .reduce((sum, [, entry]) => sum + entry.files, 0)
  return total > 0 && left / total < CONE_WARNING_SHARE ? ["V7: 코드 전용 범위가 전체 파일의 1% 미만입니다"] : []
}

/** V8. */
function sharedOf(proposal: OwnTeam.Proposal, facts: Facts, reject: Reject): Dir[] {
  const caches = new Set(TOOL_CACHES.map((name) => name.toLowerCase()))
  return (proposal.shared ?? []).flatMap((item, index) => {
    const dir = folder(item.dir)
    const at = `shared/${index}`
    if (dir === undefined) {
      reject(at, "잘못된 경로예요")
      return []
    }
    if (!facts.ignored.some((ignored) => within(ignored, dir))) {
      reject(at, "메인 폴더의 무시된 폴더가 아니에요")
      return []
    }
    if (dir.split("/").some((part) => caches.has(part.toLowerCase()))) {
      reject(at, "도구가 만드는 폴더는 공유하지 않아요")
      return []
    }
    return [{ dir, why: clean(item.why, LIMITS.why, true) }]
  })
}

interface Areas {
  readonly create: Create[]
  readonly adopt: Adopt[]
  /** V3: adopt items moved to `leave`. */
  readonly left: Array<{ readonly worktree: string; readonly why: string }>
  /** The judge's slug → the slug after V6, for `create.from` and suggestions. */
  readonly renamed: Map<string, string>
}

/** What the areas of the team and of the proposal so far hold (V4). */
interface Used {
  readonly worktrees: Set<string>
  readonly branches: Set<string>
  readonly sessions: Set<string>
  readonly slugs: Set<string>
}

function usedOf(facts: Facts): Used {
  return {
    worktrees: new Set(facts.areas.map((area) => Classify.key(area.directory))),
    branches: new Set(facts.areas.map((area) => area.branch)),
    sessions: new Set(facts.areas.flatMap((area) => (area.owner === null ? [] : [area.owner]))),
    slugs: new Set(facts.areas.map((area) => area.slug)),
  }
}

/**
 * V2–V4, V9 and V12 for one `adopt` item (enable and reorganization); `undefined` when it is rejected. A V3 folder is
 * listed in `left` too. `shaped`: the team has heavy folders, so the adopted folder keeps its shape (V9).
 */
function adoptOf(input: {
  readonly item: string
  readonly area: OwnTeam.ProposalArea
  readonly adopt: NonNullable<OwnTeam.ProposalArea["adopt"]>
  readonly facts: Facts
  readonly used: Used
  readonly shaped: boolean
  readonly needs: (worktree: Worktree) => ReadonlyArray<string>
  readonly left: Array<{ readonly worktree: string; readonly why: string }>
  readonly reject: Reject
}): Adopt | undefined {
  const facts = input.facts
  const used = input.used
  const reject = (why: string) => {
    input.reject(input.item, why)
    return undefined
  }
  const worktree = facts.worktrees.find((entry) => Classify.same(entry.path, input.adopt.worktree))
  if (!worktree) return reject("작업 폴더 목록에 없는 폴더예요")
  const outside = OUTSIDE[worktree.class]
  if (outside !== undefined) {
    input.left.push({ worktree: worktree.path, why: `팀에 넣지 않는 폴더(${outside})` })
    return reject(`팀에 넣지 않는 폴더예요(${outside})`)
  }
  const branch = input.adopt.branch ?? null
  if (branch !== null && branch !== worktree.branch) return reject("이 폴더의 기록 이름이 아니에요")
  const owner = input.adopt.owner ?? worktree.sessions[0] ?? null
  if (owner !== null && !worktree.sessions.includes(owner)) return reject("이 폴더의 대화가 아니에요")
  if (owner !== null && owner === facts.mainSessionID) return reject("팀 메인 대화는 담당이 될 수 없어요")
  if (
    used.worktrees.has(Classify.key(worktree.path)) ||
    (worktree.branch !== null && used.branches.has(worktree.branch)) ||
    (owner !== null && used.sessions.has(owner))
  )
    return reject("이미 다른 영역에 있어요")
  const base = path.posix.basename(worktree.path.replaceAll("\\", "/"))
  const slug = unique(slugify(input.area.slug) || slugify(base), (value) => used.slugs.has(value))
  used.worktrees.add(Classify.key(worktree.path))
  if (worktree.branch !== null) used.branches.add(worktree.branch)
  if (owner !== null) used.sessions.add(owner)
  used.slugs.add(slug)
  return {
    item: input.item,
    slug,
    name: clean(base, LIMITS.name) || slug,
    subtitle: clean(input.area.name, LIMITS.name),
    goal: clean(input.area.goal ?? "", LIMITS.goal, true),
    worktree: worktree.path,
    branch: worktree.branch,
    owner,
    needs: input.needs(worktree),
    // V9: an adopted folder keeps its shape; `full` only when it is a full checkout.
    shape: !input.shaped ? "plain" : worktree.sparse ? "code" : "full",
  }
}

/** V2–V4, V6, V9, V12 for `areas` (no V5 since 2026-11-14: enable makes every area the judge proposes). */
function areasOf(proposal: OwnTeam.Proposal, facts: Facts, heavy: ReadonlyArray<Dir>, reject: Reject): Areas {
  const used = usedOf(facts)
  const branches = new Set(facts.branches.map((name) => name.toLowerCase()))
  const taken = new Set((facts.taken ?? []).map((name) => name.toLowerCase()))
  const state: Areas = { create: [], adopt: [], left: [], renamed: new Map() }
  const needsOf = (item: string, needs: ReadonlyArray<string> | undefined) => [
    ...new Set(
      (needs ?? []).flatMap((value, index) => {
        const dir = folder(value)
        if (dir === undefined || !facts.trees.has(dir) || !heavy.some((entry) => within(entry.dir, dir))) {
          reject(`${item}/needs/${index}`, "큰 파일 폴더 안에 있는 폴더가 아니에요")
          return []
        }
        return [dir]
      }),
    ),
  ]
  ;(proposal.areas ?? []).forEach((area, index) => {
    const item = `areas/${index}`
    const adopt = area.adopt ?? null
    const create = area.create ?? null
    if ((adopt === null) === (create === null)) return reject(item, "adopt와 create 중 하나만 채우세요")
    if (adopt !== null) {
      const adopted = adoptOf({
        item,
        area,
        adopt,
        facts,
        used,
        shaped: heavy.length > 0,
        needs: (worktree) => (worktree.sparse ? needsOf(item, area.needs) : []),
        left: state.left,
        reject,
      })
      if (!adopted) return
      state.renamed.set(area.slug, adopted.slug)
      state.adopt.push(adopted)
      return
    }
    const from = fromOf(create?.from ?? "main", facts, state)
    if (from === undefined) return reject(item, "create.from은 main이나 앞에 나온 영역이어야 해요")
    const slug = unique(
      slugify(area.slug) || slugify(area.name),
      (value) => used.slugs.has(value) || branches.has(value) || taken.has(value),
    )
    used.slugs.add(slug)
    state.renamed.set(area.slug, slug)
    state.create.push({
      item,
      slug,
      name: clean(area.name, LIMITS.name) || slug,
      goal: clean(area.goal ?? "", LIMITS.goal, true),
      needs: needsOf(item, area.needs),
      from,
      // V9: a new area is never `full`; without heavy folders it is `plain`.
      shape: heavy.length === 0 ? "plain" : "code",
    })
  })
  return state
}

/** `main` (or the target's name), an area made earlier in this proposal, or an area of the team. */
function fromOf(value: string, facts: Facts, state: Areas) {
  const trimmed = value.trim()
  if (trimmed === "" || trimmed === "main" || trimmed === facts.target) return "main"
  const renamed = state.renamed.get(trimmed)
  if (renamed !== undefined && state.create.some((area) => area.slug === renamed)) return renamed
  if (facts.areas.some((area) => area.slug === trimmed)) return trimmed
  return undefined
}

/** V2, V13: an active candidate is never left out quietly; V3 moves come along. */
function leaveOf(
  proposal: OwnTeam.Proposal,
  facts: Facts,
  adopted: ReadonlySet<string>,
  moved: ReadonlyArray<{ readonly worktree: string; readonly why: string }>,
  reject: Reject,
) {
  const listed = (proposal.leave ?? []).flatMap((item, index) => {
    const at = `leave/${index}`
    const worktree = facts.worktrees.find((entry) => Classify.same(entry.path, item.worktree))
    if (!worktree) {
      reject(at, "작업 폴더 목록에 없는 폴더예요")
      return []
    }
    if (adopted.has(Classify.key(worktree.path))) {
      reject(at, "팀에 넣는 폴더예요")
      return []
    }
    if (worktree.class === "candidate" && worktree.active) {
      reject(at, "활동이 있는 폴더는 카드에 보여요")
      return []
    }
    return [{ worktree: worktree.path, why: clean(item.why, LIMITS.why, true) }]
  })
  return [...listed, ...moved].filter(
    (item, index, all) => all.findIndex((other) => Classify.same(other.worktree, item.worktree)) === index,
  )
}

/** V2, V11, V13. */
function suggestOf(
  proposal: OwnTeam.Proposal,
  facts: Facts,
  renamed: ReadonlyMap<string, string>,
  slugs: ReadonlySet<string>,
  reject: Reject,
): OwnTeam.Suggestion[] {
  const known = new Set([...slugs, ...renamed.values()])
  return (proposal.suggest ?? []).flatMap((item, index) => {
    const at = `suggest/${index}`
    const named = item.worktree
    const worktree = named === undefined ? undefined : facts.worktrees.find((entry) => Classify.same(entry.path, named))
    if (named !== undefined && worktree === undefined) {
      reject(at, "작업 폴더 목록에 없는 폴더예요")
      return []
    }
    const area = item.area === undefined ? undefined : (renamed.get(item.area) ?? item.area)
    if (area !== undefined && !known.has(area)) {
      reject(at, "없는 영역이에요")
      return []
    }
    if (item.kind === "retire") {
      const directory = worktree?.path ?? facts.areas.find((entry) => entry.slug === area)?.directory
      if (directory === undefined || !facts.retirable.has(Classify.key(directory))) {
        reject(at, "이 앱이 확인하지 않은 끝내기예요")
        return []
      }
    }
    return [
      {
        kind: item.kind,
        ...(worktree === undefined ? {} : { worktree: worktree.path }),
        ...(area === undefined ? {} : { area }),
        why: clean(item.why, LIMITS.why, true),
      },
    ]
  })
}

/** V10. */
function commandsOf(proposal: OwnTeam.Proposal, facts: Facts, reject: Reject): OwnTeam.Commands {
  const byName = new Map(facts.commands.map((candidate) => [candidate.name, candidate.command]))
  const pick = (name: string, at: string) => {
    const command = byName.get(name.trim())
    if (command === undefined) reject(at, "후보 목록에 없는 명령이에요")
    return command
  }
  const list = (names: ReadonlyArray<string> | undefined, at: string) =>
    [...new Set(names ?? [])].flatMap((name, index) => {
      const command = pick(name, `${at}/${index}`)
      return command === undefined ? [] : [command]
    })
  const setup = proposal.commands?.setup
  return {
    setup: setup === undefined || setup === null ? null : (pick(setup, "commands/setup") ?? null),
    code: list(proposal.commands?.code, "commands/code"),
    assets: list(proposal.commands?.assets, "commands/assets"),
  }
}

function depth(dir: string | undefined) {
  return dir === undefined ? 0 : dir.split("/").length
}

// ---------------------------------------------------------------------------------------------------------------
// Reorganization (06 §8.1–8.2)

/** What the V-rules of a reorganization need, read right before (TI-11). */
export interface ReorgFacts {
  readonly target: string
  /**
   * Every area of the team; a retired one is named only by `retire` (the removal of a folder still there, 8.6) and by
   * a new area's `from` (its branch stays: 다시 만들기, 8.2).
   */
  readonly areas: ReadonlyArray<OwnTeam.Area>
  /** The team's heavy folders: with any, an adopted folder keeps its shape (V9). */
  readonly heavy: ReadonlyArray<string>
  /** The inventory (3.2) for `areas[].adopt` and `suggest` (V2, V3, V4, V13); absent when the proposal has neither. */
  readonly inventory?: Facts
}

/** One action that passed the V-rules; areas are named by id, new ones by their V6 slug. */
export type ReorgAction =
  | {
      readonly item: string
      readonly action: "new"
      readonly slug: string
      readonly name: string
      readonly goal: string
      readonly needs: ReadonlyArray<string>
      /** `main`, an area's slug, or the slug of a new area earlier in the proposal. */
      readonly from: string
      /** 영역 만들기 (by the user only, 2026-10-26): the area's own model; absent = 팀과 같게. */
      readonly main?: Model.Ref
      /** 영역 만들기 (by the user only): the first owner conversation's 에이전트 방식. */
      readonly harness?: OwnTeam.Harness
      /**
       * The area is user-made: 영역 만들기 by the user, or the main's new area for a standing role the user asked to keep
       * (2026-11-14, AL-9); never the judge's.
       */
      readonly userMade?: true
    }
  | {
      readonly item: string
      readonly action: "rename"
      readonly areaID: OwnTeam.AreaID
      readonly name: string
      readonly subtitle?: string | null
      /** The area's whole new role when the rename takes it to another purpose (the user's or the main's, 2026-11-17). */
      readonly goal?: string
      /** The renamed area becomes user-made: a standing role the user asked to keep (the user's or the main's). */
      readonly userMade?: true
      /** The name, subtitle, role and mark before (for an undo). */
      readonly previous: {
        readonly name: string
        readonly subtitle: string | null
        readonly goal: string
        readonly userMade: boolean
      }
    }
  | { readonly item: string; readonly action: "retire"; readonly areaID: OwnTeam.AreaID }
  | {
      readonly item: string
      readonly action: "split"
      readonly areaID: OwnTeam.AreaID
      readonly slug: string
      readonly name: string
      readonly goal: string
    }
  | { readonly item: string; readonly action: "merge"; readonly areaID: OwnTeam.AreaID; readonly from: OwnTeam.AreaID }
  | {
      readonly item: string
      readonly action: "convert"
      readonly areaID: OwnTeam.AreaID
      readonly shape: "code" | "full"
    }
  | { readonly item: string; readonly action: "move"; readonly areaID: OwnTeam.AreaID; readonly sessionID: SessionID }
  /** `userMade`: the user's own adopt row (영역 만들기 · 있는 작업 폴더, 2026-10-26); never the main's or the judge's. */
  | { readonly item: string; readonly action: "adopt"; readonly adopt: Adopt; readonly userMade?: true }

export interface Reorganized {
  /** In proposal order: `ops`, then `areas`. */
  readonly actions: ReadonlyArray<ReorgAction>
  readonly suggest: ReadonlyArray<OwnTeam.Suggestion>
  readonly notes: string
  readonly rejected: ReadonlyArray<OwnTeam.Rejected>
  /** Items of `rejected` shown as a suggestion instead (V11: a conversation move only the user makes). */
  readonly suggested: ReadonlySet<string>
}

const MOVE_WHY = "이 대화를 영역 폴더로 옮기면 좋겠어요"

/** A role the user or the main wrote is longer than `LIMITS.goal` (V12, 2026-11-14): refused with its count, never cut. */
export const ROLE_LONG = (count: number) => `역할은 1,000자까지예요(지금 ${count.toLocaleString("en-US")}자)`

/** Why a conversation move of the main or the judge does not run (V11): the card shows it as a suggestion instead. */
export const MOVE_REFUSED = "대화 옮기기는 사용자만 해요. 카드에 제안으로 올렸어요"

/**
 * The V-rules over a reorganization proposal (8.1: the user's own action, the judge's proposal, the main's
 * `team_reorganize`):
 *
 *   V2  areas named by id, slug or name must exist (`retire` may name a retired area); `from` is `main`, an area (a
 *       retired one too: 다시 만들기, 8.2, 8.8) or a new area earlier in the proposal; folders, branches and sessions of
 *       `areas[].adopt` are in the inventory
 *   V3  `areas[].adopt` never takes the main worktree, another tool's folder, a `#` path, a gone one or the home
 *   V4  an area, a new slug, a session in at most one action; a folder, branch or session in at most one area
 *   V5  (removed 2026-11-14: no area limit for anyone; more than {@link BATCH} new areas of the main plan first,
 *       `tools/reorganize.ts`)
 *   V6  slugs `[a-z0-9-]{1,32}` (a taken name becomes `-2` when the area is planned)
 *   V9  an adopted folder keeps its shape
 *   V11 heavy folders, shared folders, commands and the target are not changed; a conversation move by the main or
 *       the judge becomes a suggestion (8.2: the user's action only)
 *   V12 names 40 (subtitles too), goals 1,000, notes 400, reasons 200 characters, no control characters; a goal the
 *       user or the main wrote over 1,000 is refused with its count, the judge's is cut with `…` (so are notes and
 *       reasons)
 *   V13 a `retire` suggestion only for what the program verified
 *
 * `author` is who wrote the proposal, which is not always who runs it: the main's proposal that the user's yes runs by
 * `user` (V-f, V-b (5)) stays the main's, and the judge's items the user chose in 팀 구성 다시 보기 stay the judge's
 * (`reorg.apply{proposalID, items}`). What only the user sets (영역 만들기, 2026-10-26: a new area's own model and
 * 에이전트 방식, and the user-made mark of an adopted area) is carried for a proposal the user wrote and dropped for the
 * main's and the judge's, whose conversation moves stay suggestions (V11) whoever runs them (2026-10-27). A new area's
 * user-made mark is kept for the main's too (2026-11-14, AL-9: a standing role the user asked to keep), never the
 * judge's; so are a rename's new role and mark (2026-11-17, L12: an area reused for a standing role the user named), a
 * role over 1,000 characters refused as a new area's is. The user's own adopt row is the area of the name the user typed, with no subtitle (06 §8.2, 2026-10-27).
 *
 * Destructive steps and downloads become confirm steps when the actions are planned (`reorg/plan.ts`).
 */
export function reorganize(proposal: OwnTeam.Proposal, facts: ReorgFacts, author: OwnTeam.Op["by"]): Reorganized {
  const rejected: OwnTeam.Rejected[] = []
  const reject: Reject = (item, why) => {
    rejected.push({ item, why })
  }
  if (proposal.target !== undefined && proposal.target !== facts.target)
    reject("target", "프로젝트 본 코드는 이 앱이 정해요")
  const fixed = [
    ...(proposal.heavy?.length ? ["heavy"] : []),
    ...(proposal.shared?.length ? ["shared"] : []),
    ...(proposal.commands ? ["commands"] : []),
  ]
  fixed.forEach((item) => reject(item, "재구성에서는 바꾸지 않아요"))
  const live = facts.areas.filter((area) => area.state !== "retired")
  const find = (name: string, among: ReadonlyArray<OwnTeam.Area> = live) =>
    among.find((area) => area.id === name || area.id === `ar_${name}` || area.name === name)
  const slugOf = (area: OwnTeam.Area) => area.id.slice("ar_".length)
  const missing = (item: string, name: string) => reject(item, `'${name}' 영역이 없어요`)
  const seen = new Set<string>()
  const actions: ReorgAction[] = []
  /** The proposal's slugs of new areas → their slugs after V6 (`from` and suggestions name them). */
  const renamed = new Map<string, string>()
  const moved: OwnTeam.Suggestion[] = []
  const suggested = new Set<string>()
  const add = (action: ReorgAction, keys: ReadonlyArray<string>) => {
    if (keys.some((key) => seen.has(key))) {
      reject(action.item, "같은 영역이 두 번 나와요")
      return false
    }
    keys.forEach((key) => seen.add(key))
    actions.push(action)
    return true
  }
  const startOf = (value: string | undefined) => {
    const trimmed = value?.trim() ?? ""
    if (trimmed === "" || trimmed === "main" || trimmed === facts.target) return "main"
    const made = renamed.get(trimmed)
    if (made !== undefined) return made
    // A finished area's branch stays (8.2), so a new area may start there: B 다시 만들기 after a merge.
    const area = find(trimmed) ?? find(trimmed, facts.areas)
    return area === undefined ? undefined : slugOf(area)
  }
  const user = author === "user"
  // A role the user or the main wrote is refused when too long, never cut (CP-6); the judge's is cut with `…`.
  const written = author === "user" || author === "main"
  const goalOf = (item: string, value: string | undefined) => {
    const plain = clean(value ?? "", Number.POSITIVE_INFINITY)
    if (written && plain.length > LIMITS.goal) {
      reject(item, ROLE_LONG(plain.length))
      return undefined
    }
    return clean(plain, LIMITS.goal, true)
  }
  const fresh = (item: string, input: { readonly slug: string; readonly name: string } & Partial<NewFields>) => {
    const slug = slugify(input.slug) || slugify(input.name)
    if (!slug) return reject(item, `영역 이름으로 쓸 수 없어요: '${input.slug}'`)
    const from = startOf(input.from)
    if (from === undefined) return missing(item, input.from ?? "")
    const goal = goalOf(item, input.goal)
    if (goal === undefined) return
    const action: ReorgAction = {
      item,
      action: "new",
      slug,
      name: clean(input.name, LIMITS.name) || slug,
      goal,
      needs: input.needs ?? [],
      from,
      ...(user && input.main !== undefined ? { main: input.main } : {}),
      ...(user && input.harness !== undefined ? { harness: input.harness } : {}),
      ...(written && input.userMade === true ? { userMade: true as const } : {}),
    }
    if (add(action, [`slug:${slug}`])) renamed.set(input.slug, slug)
  }

  ;(proposal.ops ?? []).forEach((op, index) => {
    const item = `ops/${index}`
    if (op.op === "new") {
      // A slug the user or the judge gave must be one (own-web names a nameless area `area`, T2).
      if (!slugify(op.slug)) return reject(item, `영역 이름으로 쓸 수 없어요: '${op.slug}'`)
      return fresh(item, op)
    }
    if (op.op === "merge") {
      const into = find(op.area)
      const from = find(op.from)
      if (!into) return missing(item, op.area)
      if (!from) return missing(item, op.from)
      if (into.id === from.id) return reject(item, "같은 영역끼리는 묶을 수 없어요")
      add({ item, action: "merge", areaID: into.id, from: from.id }, [`area:${into.id}`, `area:${from.id}`])
      return
    }
    const area = op.op === "retire" ? (find(op.area) ?? find(op.area, facts.areas)) : find(op.area)
    if (!area) return missing(item, op.area)
    const key = `area:${area.id}`
    if (op.op === "rename") {
      const name = clean(op.name, LIMITS.name)
      if (!name) return reject(item, "새 이름이 비어 있어요")
      const subtitle =
        op.subtitle === undefined ? {} : { subtitle: op.subtitle === null ? null : clean(op.subtitle, LIMITS.name) }
      // A new role and the user-made mark ride a rename of the user's or the main's (2026-11-17, L12: an area reused
      // for a standing role the user named); the judge's are dropped, so 팀 구성 다시 보기 never applies an unseen role.
      const goal = written && op.goal !== undefined ? goalOf(item, op.goal) : undefined
      if (written && op.goal !== undefined && goal === undefined) return
      add(
        {
          item,
          action: "rename",
          areaID: area.id,
          name,
          previous: {
            name: area.name,
            subtitle: area.subtitle ?? null,
            goal: area.goal,
            userMade: area.userMade !== undefined,
          },
          ...subtitle,
          ...(goal === undefined || goal === "" ? {} : { goal }),
          ...(written && op.userMade === true ? { userMade: true as const } : {}),
        },
        [key],
      )
      return
    }
    if (op.op === "retire") {
      add({ item, action: "retire", areaID: area.id }, [key])
      return
    }
    if (op.op === "split") {
      const slug = slugify(op.slug)
      if (!slug) return reject(item, `영역 이름으로 쓸 수 없어요: '${op.slug}'`)
      const goal = goalOf(item, op.goal)
      if (goal === undefined) return
      const action: ReorgAction = {
        item,
        action: "split",
        areaID: area.id,
        slug,
        name: clean(op.name, LIMITS.name) || slug,
        goal,
      }
      if (add(action, [key, `slug:${slug}`])) renamed.set(op.slug, slug)
      return
    }
    if (op.op === "convert") {
      add({ item, action: "convert", areaID: area.id, shape: op.shape }, [key])
      return
    }
    // V11: only the user moves a conversation (it cannot be taken back to a point before the move, 4.14).
    if (!user) {
      moved.push({ kind: "move", area: slugOf(area), why: clean(op.why ?? "", LIMITS.why, true) || MOVE_WHY })
      suggested.add(item)
      return reject(item, MOVE_REFUSED)
    }
    const sessionID = op.sessionID
    if (!Schema.is(SessionID)(sessionID)) return reject(item, "옮길 대화가 올바르지 않아요")
    add({ item, action: "move", areaID: area.id, sessionID }, [`session:${sessionID}`])
  })

  const inventory = facts.inventory
  const used = inventory === undefined ? undefined : usedOf(inventory)
  ;(proposal.areas ?? []).forEach((area, index) => {
    const item = `areas/${index}`
    const adopt = area.adopt ?? null
    const create = area.create ?? null
    if ((adopt === null) === (create === null)) return reject(item, "adopt와 create 중 하나만 채우세요")
    if (create !== null) return fresh(item, { ...area, from: create.from })
    if (adopt === null) return
    if (inventory === undefined || used === undefined)
      return reject(item, "작업 폴더 목록을 읽지 못해 팀에 넣지 않았어요")
    // The new areas' slugs are taken too (V4, V6).
    seen.forEach((key) => {
      if (key.startsWith("slug:")) used.slugs.add(key.slice("slug:".length))
    })
    const adopted = adoptOf({
      item,
      area,
      adopt,
      facts: inventory,
      used,
      shaped: facts.heavy.length > 0,
      needs: () => [],
      left: [],
      reject,
    })
    if (!adopted) return
    // 06 §8.2: the user's own row (영역 만들기 · 있는 작업 폴더) is the area of the name the user typed; 3.7 names other
    // adopted areas after their folder, with the proposal's name as the subtitle. The record name follows the folder.
    const mine = user && area.userMade === true
    const named = mine ? { ...adopted, name: clean(area.name, LIMITS.name) || adopted.name, subtitle: "" } : adopted
    if (
      add({ item, action: "adopt", adopt: named, ...(mine ? { userMade: true as const } : {}) }, [`slug:${named.slug}`])
    )
      renamed.set(area.slug, named.slug)
  })

  const slugs = new Set([
    ...live.map(slugOf),
    ...actions.flatMap((action) => {
      if (action.action === "new" || action.action === "split") return [action.slug]
      if (action.action === "adopt") return [action.adopt.slug]
      return []
    }),
  ])
  const listed = proposal.suggest ?? []
  if (listed.length > 0 && inventory === undefined)
    listed.forEach((_, index) => reject(`suggest/${index}`, "작업 폴더 목록을 읽지 못해 제안을 보이지 않아요"))
  const suggest =
    listed.length === 0 || inventory === undefined ? [] : suggestOf(proposal, inventory, renamed, slugs, reject)
  return {
    actions,
    suggest: [...suggest, ...moved],
    notes: clean(proposal.notes ?? "", LIMITS.notes, true),
    rejected: rejected.toSorted((a, b) => order(a.item) - order(b.item)),
    suggested,
  }
}

interface NewFields {
  readonly goal: string
  readonly needs: ReadonlyArray<string>
  readonly from: string
  readonly main: Model.Ref
  readonly harness: OwnTeam.Harness
  readonly userMade: true
}

/** The proposal sections in the order their items are listed. */
const SECTIONS = ["target", "heavy", "shared", "commands", "ops", "areas", "suggest"]

/** Sort key of a pointer (`ops/2`, `areas/0/needs/1`): its section, then its index. */
function order(item: string) {
  const [section = "", index = "0"] = item.split("/")
  return SECTIONS.indexOf(section) * 1_000_000 + (Number(index) || 0)
}
