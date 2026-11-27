// Skills import decisions (03 §19.6.1, 09 §9), pure so they are unit-tested as tables: the status of a skill found in
// another tool (in use, own's copy, importable, not a fit), a free id for a rename, and which texts explain the format
// notes and problems. SK2 (2026-10-24): where each place is (a readable label per root: `Codex (기본 폴더)`, an account,
// a folder's name, a Claude app synced account), one row per identical skill (same source kind, id and content hash)
// with every place it was found, rows of the same name with other content marked, the search and the filters.
import type { ImportOutput } from "@/data/import-rpc"
import type { SkillsImportKey } from "./import-strings"
import { skillSource } from "./model"

export type FoundSkill = ImportOutput<"skills.list">["items"][number]
export type FoundRoot = ImportOutput<"skills.list">["roots"][number]
export type SkillRecord = ImportOutput<"skills.list">["imports"][number]
export type SkillLink = NonNullable<FoundSkill["links"]>[number]
export type Preview = ImportOutput<"skills.preview">
export type Candidate = Preview["items"][number]
export type Origin = FoundSkill["origin"]
export type Problem = FoundSkill["format"]["problems"][number]
export type Note = FoundSkill["format"]["notes"][number]
/** A skill core loads, with its content hash (`skills.list{directory}` `loaded`, SK2 2026-10-25). */
export type LoadedTwin = NonNullable<ImportOutput<"skills.list">["loaded"]>[number]

/**
 * - `inUse` (`이미 쓰는 중`): own already loads this very folder (Claude Code's `~/.claude/skills` is one of core's
 *   compatibility roots), or (SK2) a copy of the same content elsewhere, so there is nothing to import.
 * - `imported` (`이 앱에 있음`): own-import's copy, the same as the source; `changed` (`원본이 바뀜`) once it is not.
 * - `approve` (SK2, `링크 확인 필요`): a link leads outside the roots and waits for the user's approval.
 * - `incompatible` (`형식이 맞지 않음`) with the reasons; `available` (`가져올 수 있음`).
 * - `checking` (`확인 중…`, 2026-10-25): the skills own loads are not known yet, so nothing is offered.
 */
export type ImportStatus = "inUse" | "imported" | "changed" | "approve" | "incompatible" | "available" | "checking"

export interface LoadedSkill {
  readonly id: string
  readonly path: string
}

export function importStatus(skill: FoundSkill, loaded: ReadonlyArray<LoadedSkill>): ImportStatus {
  if (loadedHere(skill, loaded)) return "inUse"
  if (skill.imported) return skill.imported.changed ? "changed" : "imported"
  if (skill.format.status === "incompatible") return "incompatible"
  if (waiting(skill).length > 0) return "approve"
  return "available"
}

/** Whether own loads this folder itself: its `SKILL.md`, by the listed path or (links) the real one. */
function loadedHere(skill: FoundSkill, loaded: ReadonlyArray<LoadedSkill>) {
  const files = new Set([skill.directory, skill.real].flatMap((folder) => (folder ? [key(`${folder}/SKILL.md`)] : [])))
  return loaded.some((item) => files.has(key(item.path)))
}

/** The links of a found skill that wait for the user's approval (SK2). */
export function waiting(skill: FoundSkill): SkillLink[] {
  return (skill.links ?? []).filter((link) => link.state === "approve")
}

// ---------------------------------------------------------------------------------------------------------------
// Places (SK2): what each root is called

/** A text of the import view: a key of its catalog with its values. */
export interface Label {
  readonly key: SkillsImportKey
  readonly params?: Readonly<Record<string, string | number>>
}

/**
 * Where skills were found: a root, the Claude app's synced folder of one account in a Claude Code root, or a root's
 * plugins of one marketplace. `order` sorts them: the default Codex home, other Codex folders, added ones, account
 * homes, Claude Code, its synced accounts, plugins.
 */
export interface Source {
  readonly key: string
  readonly rootID: string
  readonly label: Label
  /** The folder it stands for (shown with the label, whole in a tooltip). */
  readonly directory: string
  readonly order: number
}

/** An own Claude account: its label and its uuid (`Account.View.claude.accountUuid`), to name synced folders. */
export interface ClaudeAccount {
  readonly label: string
  readonly uuid: string
}

/** Folder names that say nothing on their own: the parent's name is shown with them. */
const GENERIC = new Set([".codex", "codex", ".claude", "claude", "codex-home", "claude-home", "home"])

/** A root's own label (09 §9.2 SK2): `Codex (기본 폴더)`, `Codex · <account>`, `Codex · <folder>`, and Claude Code's. */
export function rootLabel(root: FoundRoot, roots: ReadonlyArray<FoundRoot>): Label {
  const codex = root.kind === "codex"
  const base = !root.added && root.origin !== "profile"
  const first = roots.find((other) => other.kind === root.kind && !other.added && other.origin !== "profile")
  if (base && first?.rootID === root.rootID)
    return { key: codex ? "own.skills.import.source.codexDefault" : "own.skills.import.source.claudeDefault" }
  if (root.account)
    return root.account.alias
      ? { key: "own.skills.import.source.codexAccount", params: { name: root.account.alias } }
      : { key: "own.skills.import.source.codexAccountID", params: { id: root.account.id } }
  return {
    key: codex ? "own.skills.import.source.codexFolder" : "own.skills.import.source.claudeFolder",
    params: { name: folderName(root.directory) },
  }
}

/** The last folder name of a path, with its parent's when the last one is generic (`backup\.codex`). */
export function folderName(directory: string) {
  const parts = directory.split(/[\\/]+/).filter((part) => part !== "")
  const last = parts.at(-1) ?? directory
  if (!GENERIC.has(last.toLowerCase()) || parts.length < 2) return last
  return `${parts.at(-2)}\\${last}`
}

/** The place a found skill is in: its root, or the synced account or plugin marketplace inside that root. */
export function sourceOf(
  item: FoundSkill,
  roots: ReadonlyArray<FoundRoot>,
  accounts: ReadonlyArray<ClaudeAccount> = [],
): Source {
  const index = roots.findIndex((root) => root.rootID === item.rootID)
  const root = roots[index]
  const order = rootOrder(root, roots) * 1000 + Math.max(index, 0)
  const directory = root?.directory ?? item.directory
  if (item.origin === "claude-plugin") {
    const market = item.plugin?.marketplace
    return {
      key: `${item.rootID}#plugin:${market ?? ""}`,
      rootID: item.rootID,
      label: market
        ? { key: "own.skills.import.source.pluginMarket", params: { name: market } }
        : { key: "own.skills.import.origin.claude-plugin" },
      directory,
      order: 7000 + order,
    }
  }
  if (item.synced) {
    const synced = item.synced
    const account = accounts.find(
      (entry) =>
        entry.uuid !== "" &&
        [synced.account, synced.org].some((part) => part.toLowerCase() === entry.uuid.toLowerCase()),
    )
    return {
      key: `${item.rootID}#synced:${synced.folder.toLowerCase()}`,
      rootID: item.rootID,
      label: account
        ? { key: "own.skills.import.source.claudeAccount", params: { name: account.label } }
        : { key: "own.skills.import.source.claudeSynced", params: { id: (synced.account || synced.org).slice(0, 8) } },
      directory: `${directory}\\skills\\synced\\${synced.folder}`,
      order: 6000 + order,
    }
  }
  return {
    key: item.rootID,
    rootID: item.rootID,
    label: root ? rootLabel(root, roots) : { key: `own.skills.import.origin.${item.origin}` },
    directory,
    order,
  }
}

function rootOrder(root: FoundRoot | undefined, roots: ReadonlyArray<FoundRoot>) {
  if (root === undefined) return 9
  const codex = root.kind === "codex"
  const first = roots.find((other) => other.kind === root.kind && !other.added && other.origin !== "profile")
  if (first?.rootID === root.rootID) return codex ? 0 : 4
  if (root.origin === "profile") return 3
  if (root.added) return codex ? 2 : 5
  return codex ? 1 : 5
}

// ---------------------------------------------------------------------------------------------------------------
// Rows (SK2): one per identical skill

/** One place a skill was found, with the places that reach the same real folder through links. */
export interface Place {
  readonly item: FoundSkill
  readonly source: Source
  readonly aliases: ReadonlyArray<FoundSkill>
}

export interface SkillRow {
  readonly key: string
  /** The copy that is imported and shown: in use or imported first, then the default home's, then the newest. */
  readonly item: FoundSkill
  readonly source: Source
  /** Every place, the representative's first. */
  readonly places: ReadonlyArray<Place>
  readonly status: ImportStatus
  /** `이미 쓰는 중`: the place own loads it from (another source kind's copy of the same content). */
  readonly inUseBy?: Source
  /** The same content is in use or in this app under another id (`같은 내용이 <id>로 이미 있어요`, SK2 2026-10-25). */
  readonly sameAs?: string
  /** Other rows of the same source kind and id have other content (`내용이 다름`). */
  readonly differs: boolean
  readonly system: boolean
}

/**
 * One row per identical skill (09 §9.2, SK2): found skills of one source kind, id and content hash; one folder reached
 * through links is one place. A skill without a hash (found once, unreadable, a link waiting) is a row of its own.
 * Rows sort by name, then by place. While `loaded` is undefined (the skills own loads are not known yet) every row is
 * `checking`. `twins` (2026-10-25) are skills core loads with their hashes, wherever they are (own's skills folder, the
 * project, `~/.agents/skills`): the same content under the same id is `이미 쓰는 중 (<where>)`, under another id
 * `이미 쓰는 중` with `sameAs`; own-import's copy of the same content under another id is `이 앱에 있음` with `sameAs`.
 */
export function mergeFound(input: {
  readonly items: ReadonlyArray<FoundSkill>
  readonly roots: ReadonlyArray<FoundRoot>
  readonly loaded: ReadonlyArray<LoadedSkill> | undefined
  readonly imports: ReadonlyArray<SkillRecord>
  readonly accounts?: ReadonlyArray<ClaudeAccount>
  readonly twins?: ReadonlyArray<LoadedTwin>
  /** The project the loaded skills are of: a twin in it is `프로젝트`, elsewhere `전역`. */
  readonly directory?: string
}): SkillRow[] {
  const loaded = input.loaded ?? []
  const sourceOfItem = (item: FoundSkill) => sourceOf(item, input.roots, input.accounts)
  const places = byRealFolder(input.items, sourceOfItem)
  const groups = new Map<string, Place[]>()
  for (const place of places) {
    const id = rowKey(place.item)
    groups.set(id, [...(groups.get(id) ?? []), place])
  }
  const kinds = new Map<string, number>()
  for (const id of groups.keys()) kinds.set(kindKey(id), (kinds.get(kindKey(id)) ?? 0) + 1)
  // In use somewhere by path: what an identical copy elsewhere (another source kind) is then too; and what core loads
  // from places that are no roots, by hash.
  const used = [
    ...places.flatMap((place) =>
      [place.item, ...place.aliases].some((item) => loadedHere(item, loaded)) && place.item.hash
        ? [{ id: place.item.id, hash: place.item.hash, source: place.source }]
        : [],
    ),
    ...(input.twins ?? []).map((twin) => ({
      id: twin.id,
      hash: twin.hash,
      source: loadedSource(twin, input.directory),
    })),
  ]
  const rows = [...groups.entries()].map(([id, members]): SkillRow => {
    const sorted = members.toSorted((a, b) => rank(a, loaded) - rank(b, loaded) || compare(a, b))
    const first = sorted[0]!
    const item = first.item
    const all = sorted.flatMap((place) => [place.item, ...place.aliases])
    const here = all.find((found) => loadedHere(found, loaded))
    const same = item.hash ? used.filter((entry) => entry.hash === item.hash) : []
    const twin = same.find((entry) => sameID(entry.id, item.id))
    const other = same.find((entry) => !sameID(entry.id, item.id))
    const record = all.find((found) => found.imported)?.imported
    const copy = item.hash === undefined ? undefined : input.imports.find((entry) => entry.hash === item.hash)
    const status: ImportStatus =
      input.loaded === undefined
        ? "checking"
        : here || twin || other
          ? "inUse"
          : record
            ? record.changed
              ? "changed"
              : "imported"
            : copy
              ? "imported"
              : importStatus(item, [])
    // The same content under another id, said instead of offering a second copy.
    const sameAs =
      here || twin || record ? undefined : (other?.id ?? (copy && !sameID(copy.id, item.id) ? copy.id : undefined))
    return {
      key: id,
      item,
      source: first.source,
      places: sorted,
      status,
      ...(here === undefined && twin !== undefined ? { inUseBy: twin.source } : {}),
      ...(sameAs === undefined ? {} : { sameAs }),
      differs: (kinds.get(kindKey(id)) ?? 0) > 1,
      system: item.system,
    }
  })
  return rows.toSorted(
    (a, b) =>
      a.item.name.localeCompare(b.item.name) || a.source.order - b.source.order || compare(a.places[0]!, b.places[0]!),
  )
}

function sameID(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}

/** Where a loaded twin is: the project's (`프로젝트`), else one of own's global places (`전역`). */
function loadedSource(twin: LoadedTwin, directory: string | undefined): Source {
  return {
    key: `loaded:${key(twin.path)}`,
    rootID: "",
    label: {
      key: skillSource(twin.path, directory) === "project" ? "own.skills.source.project" : "own.skills.source.global",
    },
    directory: twin.path,
    order: 9000,
  }
}

/** Places by real folder: the first by place order keeps it, the others reach it through a link (`aliases`). */
function byRealFolder(items: ReadonlyArray<FoundSkill>, source: (item: FoundSkill) => Source): Place[] {
  const placed = items
    .map((item) => ({ item, source: source(item) }))
    .toSorted((a, b) => a.source.order - b.source.order || plainFirst(a.item) - plainFirst(b.item))
  const seen = new Map<string, { item: FoundSkill; source: Source; aliases: FoundSkill[] }>()
  for (const entry of placed) {
    const real = key(entry.item.real ?? entry.item.directory)
    const known = seen.get(real)
    if (known && known.item.origin === entry.item.origin) known.aliases.push(entry.item)
    else if (!known) seen.set(real, { ...entry, aliases: [] })
    else seen.set(`${real}\0${entry.item.key}`, { ...entry, aliases: [] })
  }
  return [...seen.values()]
}

/** A folder that is a link sorts after the plain folder it leads to. */
function plainFirst(item: FoundSkill) {
  return item.links?.some((link) => link.relative === "") ? 1 : 0
}

function rowKey(item: FoundSkill) {
  return `${item.origin}\0${item.id.toLowerCase()}\0${item.hash ?? `item:${item.key}`}`
}

function kindKey(row: string) {
  return row.split("\0").slice(0, 2).join("\0")
}

/** Representative order: in use, imported, the default home's (by place), not bundled, then the newest. */
function rank(place: Place, loaded: ReadonlyArray<LoadedSkill>) {
  if ([place.item, ...place.aliases].some((item) => loadedHere(item, loaded))) return 0
  if (place.item.imported) return 1
  return 2
}

function compare(a: Place, b: Place) {
  return (
    a.source.order - b.source.order ||
    Number(a.item.system) - Number(b.item.system) ||
    (a.item.relative ?? "").split("/").length - (b.item.relative ?? "").split("/").length ||
    (b.item.modifiedAt ?? 0) - (a.item.modifiedAt ?? 0) ||
    a.item.directory.localeCompare(b.item.directory)
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Search, filters, groups (SK2)

/** `가져올 수 있음`, `이미 있음` (in use or in this app), `내용이 다름`, `형식이 맞지 않음`. */
export type ImportFilter = "all" | "available" | "present" | "differs" | "incompatible"

export const FILTERS: ReadonlyArray<ImportFilter> = ["all", "available", "present", "differs", "incompatible"]

export function matchesFilter(row: SkillRow, filter: ImportFilter) {
  if (filter === "all") return true
  if (filter === "available") return row.status === "available" || row.status === "approve"
  if (filter === "present") return row.status === "inUse" || row.status === "imported" || row.status === "changed"
  if (filter === "differs") return row.differs
  return row.status === "incompatible"
}

/**
 * The rows the view shows: bundled ones (`.system`) only with `builtins`, one source only when `source` is set, the
 * filter, and the search: every word of `query` in the name, id, description, a place's label or its folder.
 * `label` gives a place's label as shown. `hidden` counts the bundled rows left out by `builtins` alone.
 */
export function visibleRows(
  rows: ReadonlyArray<SkillRow>,
  input: {
    readonly query: string
    readonly filter: ImportFilter
    readonly builtins: boolean
    readonly source?: string
    readonly label: (source: Source) => string
  },
) {
  const words = input.query.trim().replace(/^@/, "").toLowerCase().split(/\s+/).filter(Boolean)
  const searched = rows.filter(
    (row) =>
      matchesFilter(row, input.filter) &&
      (input.source === undefined || row.places.some((place) => place.source.key === input.source)) &&
      words.every((word) => haystack(row, input.label).includes(word)),
  )
  return {
    rows: searched.filter((row) => input.builtins || !row.system),
    hidden: input.builtins ? 0 : searched.filter((row) => row.system).length,
  }
}

function haystack(row: SkillRow, label: (source: Source) => string) {
  return [
    row.item.name,
    row.item.id,
    row.item.description ?? "",
    ...row.places.flatMap((place) => [
      label(place.source),
      place.item.directory,
      place.item.relative ?? "",
      ...place.aliases.map((alias) => alias.directory),
    ]),
  ]
    .join("\n")
    .toLowerCase()
}

export interface RowGroup {
  readonly source: Source
  readonly rows: ReadonlyArray<SkillRow>
}

/** Rows by the representative's place, in place order. */
export function groupRows(rows: ReadonlyArray<SkillRow>): RowGroup[] {
  const groups = new Map<string, { source: Source; rows: SkillRow[] }>()
  for (const row of rows) {
    const group = groups.get(row.source.key) ?? { source: row.source, rows: [] }
    group.rows.push(row)
    groups.set(row.source.key, group)
  }
  return [...groups.values()].toSorted((a, b) => a.source.order - b.source.order)
}

/** Every source with rows, in place order (the view's source choice). */
export function sourcesOf(rows: ReadonlyArray<SkillRow>): Source[] {
  const all = new Map(rows.flatMap((row) => row.places.map((place) => [place.source.key, place.source] as const)))
  return [...all.values()].toSorted((a, b) => a.order - b.order)
}

/**
 * The places looked in, for the head of the view: each root with its label, its folder, its state (`missing`,
 * `unreadable`, `path_denied`, `shared` with another root's skills folder, `elsewhere` when its skills folder links
 * outside the roots) and how many rows it holds.
 */
export function lookedIn(roots: ReadonlyArray<FoundRoot>, rows: ReadonlyArray<SkillRow>) {
  return roots
    .map((root) => {
      const shared = roots.find((other) => other.rootID === root.sharedWith)
      return {
        root,
        label: rootLabel(root, roots),
        order: rootOrder(root, roots),
        count: rows.filter((row) => row.places.some((place) => place.item.rootID === root.rootID)).length,
        state: root.problem ?? (root.sharedWith ? "shared" : root.skillsTarget ? "elsewhere" : undefined),
        ...(shared === undefined ? {} : { shared: rootLabel(shared, roots) }),
      }
    })
    .toSorted((a, b) => a.order - b.order)
}

// ---------------------------------------------------------------------------------------------------------------
// Names

const SUFFIX: { readonly [O in Origin | "git"]: string } = {
  codex: "codex",
  "claude-code": "claude",
  "claude-plugin": "plugin",
  git: "repo",
}

/** The same id rules as own-import (`OwnImport.SkillID`): what the rename box accepts. */
export function validSkillID(id: string) {
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/.test(id) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(id)
  )
}

/** A rename suggestion that no loaded skill and no other taken id has: `<id>-<source>`, then `-2`, `-3`, … */
export function suggestID(id: string, origin: Origin | "git", taken: ReadonlyArray<string>) {
  const used = new Set(taken.map((item) => item.toLowerCase()))
  const base = `${id.slice(0, 64 - SUFFIX[origin].length - 4)}-${SUFFIX[origin]}`
  const free = [base, ...Array.from({ length: 98 }, (_, index) => `${base}-${index + 2}`)].find(
    (candidate) => !used.has(candidate.toLowerCase()),
  )
  return free ?? `${base}-${Date.now() % 1000}`
}

/** A loaded skill (not this folder) that already has `id`: core would load both under one id, so own asks to rename. */
export function loadedConflict(id: string, directory: string | undefined, loaded: ReadonlyArray<LoadedSkill>) {
  const own = directory === undefined ? undefined : key(`${directory}/SKILL.md`)
  return loaded.find((item) => item.id.toLowerCase() === id.toLowerCase() && key(item.path) !== own)
}

/** What `업데이트 확인` shows: the copies that are not the same as their source now (changed, gone, unknown). */
export function pendingUpdates(items: ImportOutput<"skills.updates">["items"]) {
  return items.filter((item) => item.state !== "same")
}

/** The short commit shown in a preview's head. */
export function shortCommit(commit: string) {
  return commit.slice(0, 12)
}

/** The folder below its root, with the root's separator (`skills\backup\pdf`), else the whole folder. */
export function shownPath(item: FoundSkill) {
  if (!item.relative) return item.directory
  return item.directory.includes("\\") ? item.relative.replaceAll("/", "\\") : item.relative
}

function key(path: string) {
  // Windows paths compare without case and with either separator.
  const slashed = path.replaceAll("\\", "/").replace(/\/+/g, "/")
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}
