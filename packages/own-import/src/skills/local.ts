export * as SkillLocal from "./local.js"

import { createHash } from "node:crypto"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import { Schema } from "effect"
import { Paths } from "../sources/paths.js"
import { SkillFormat } from "./format.js"
import type { SkillStore } from "./store.js"

/**
 * Skills other tools installed on this PC (09 §9.1, §9.2), read only through `Paths` with purpose `skill`: Codex
 * `<root>\skills` (its bundled `.system` skills too), Claude Code `<root>\skills`, and the skills of Claude Code plugins
 * under `<root>\plugins\cache\<marketplace>\<plugin>\<version>` (installed) and `<root>\plugins\marketplaces\<name>`
 * (the marketplaces' own copies). A skill is a folder with a `SKILL.md`; the walk never descends into one. Nothing is
 * written, and a found skill's files are read in full only when it is copied or its copy is compared (`read`).
 *
 * Links (SK2, 2026-10-24, 09 §9.3): a link (symbolic link or junction) in a skill, or a skill folder that is one, is
 * followed and later copied as what it points to, never as a link. A target in a skill area (this root's or another
 * root's) or in a folder core loads skills from is followed at once; any other local target only once the user
 * approved its `linkKey` (until then nothing of it is listed or read); a missing target, a loop, a device, a network
 * place and a place own never reads are refused (`links`).
 */

/** A found skill with what copying it needs: its root, its folder and its files. */
export interface Found {
  readonly info: Omit<OwnImport.SkillFound, "imported">
  /** The root, with this skill's reach (its approved link targets). */
  readonly root: Paths.Root
  /** The skill folder, as listed (below the root). */
  readonly folder: string
  /** The folder below the root, `/`-separated (records and keys use it). */
  readonly relative: string
  readonly files: ReadonlyArray<{ readonly relative: string; readonly size: number }>
  readonly context: Context
  /** A link in it waits for the user's approval: it cannot be read whole yet. */
  readonly pending: boolean
}

/** What one scan's links may reach (SK2). */
export interface Context {
  /** Folders core loads skills from (real-path keys): `~/.agents/skills`, `~/.claude/skills`, own's skills folder. */
  readonly known: ReadonlyArray<string>
  /** Never reached through a link (real-path keys): OWN_HOME, `.ssh` and the like, the Windows folder. */
  readonly blocked: ReadonlyArray<string>
  /** Every configured root, scanned or not: their files outside the skill areas stay closed. */
  readonly roots: ReadonlyArray<Paths.Root>
  /** The link keys the user approved. */
  readonly approved: ReadonlySet<string>
}

export const NO_LINKS: Context = { known: [], blocked: [], roots: [], approved: new Set() }

/** How deep the walks go below their start: skill groups (`skills\.system`), plugin trees (`plugins\x\skills`). */
const SKILL_DEPTH = 3
const PLUGIN_DEPTH = 6
const FILE_DEPTH = 8
/** The most folders one scan lists, so a huge marketplace clone cannot stall the list. */
const MAX_LISTED = 5_000
/** The most links one skill shows. */
const MAX_LINKS = 50
/** Folders a skill's tools make (packages, caches): neither counted nor copied (SK2 `left_out_folders`). */
const SKIP = new Set([".git", "node_modules", "__pycache__", ".venv"])
/** Folders of the skill groups that hold removed or half-installed skills (SK2), never listed as skills. */
const GROUP_SKIP = new Set([".trash", ".staging"])

interface Budget {
  listed: number
}

type Plugin = Found["info"]["plugin"]

/**
 * Every skill of `roots` (Codex and Claude Code), each root's problems aside; never throws for a missing folder. A root
 * in `shared` has a `skills` folder that is another root's (a junction, SK2): its skills are that root's, not walked
 * twice.
 */
export async function scan(
  roots: ReadonlyArray<Paths.Root>,
  context: Context = NO_LINKS,
  shared: ReadonlySet<string> = new Set(),
): Promise<Found[]> {
  const budget: Budget = { listed: 0 }
  const reach = reachOf(context)
  const found = (
    await Promise.all(
      roots.map(async (item) => {
        if (Paths.denied(item)) return []
        const root = { ...item, reach }
        const own = shared.has(root.rootID)
          ? []
          : await walkSkills(
              root,
              join(root.directory, "skills"),
              0,
              budget,
              root.kind === "codex" ? "codex" : "claude-code",
              context,
            )
        if (root.kind === "codex") return own
        const plugins = await Promise.all(
          ["cache", "marketplaces"].map((area) =>
            walkPlugins(root, join(root.directory, "plugins", area), 0, budget, context),
          ),
        )
        return [...own, ...plugins.flat()]
      }),
    )
  ).flat()
  // A plugin both installed (cache) and in its marketplace's copy is the installed one only.
  const installed = new Set(found.filter((item) => item.info.plugin?.installed).map((item) => pluginKey(item.info)))
  return found
    .filter(
      (item) => item.info.plugin === undefined || item.info.plugin.installed || !installed.has(pluginKey(item.info)),
    )
    .map((item) =>
      item.info.plugin !== undefined && installed.has(pluginKey(item.info))
        ? { ...item, info: { ...item.info, plugin: { ...item.info.plugin, installed: true } } }
        : item,
    )
}

/**
 * One skill folder core loads (`skills.detail` of 설정 > 스킬): the folder as a {@link Paths.Root.whole} root, its
 * files, `SKILL.md` and format; links lead only where a found skill's would without an approval.
 */
export function loaded(folder: string, context: Context) {
  const root = whole(folder)
  return skill({ ...root, reach: reachOf(context) }, root.directory, "claude-code", undefined, context, "", [])
}

/**
 * A skill core loads as one `.md` file among others (`skill\<id>.md`): that file's bytes up to 1 MiB, else its size
 * (`large`); `undefined` when it cannot be read.
 */
export async function loadedFile(file: string) {
  const root = whole(path.dirname(file))
  const stat = await Paths.stat(root, file, "skill")
  if (!stat.ok || !stat.value.file) return undefined
  if (stat.value.size > SkillFormat.MAX_SKILL_MD) return { large: true as const, size: stat.value.size }
  const read = await Paths.read(root, file, {}, "skill")
  return read.ok ? { large: false as const, bytes: new Uint8Array(read.value) } : undefined
}

function whole(folder: string): Paths.Root {
  return {
    rootID: "loaded",
    kind: "claude-code",
    directory: Paths.norm(folder),
    label: "",
    added: false,
    origin: "option",
    whole: true,
  }
}

/** The reach of a scan: the known folders and every root's skill areas allowed, OWN_HOME and the like blocked. */
function reachOf(context: Context): Paths.Reach {
  const roots = context.roots.map((root) => ({ kind: root.kind, real: Paths.realKey(root.directory) }))
  const areas = roots.flatMap((root) =>
    root.kind === "codex"
      ? [`${root.real}\\skills`]
      : [`${root.real}\\skills`, `${root.real}\\plugins\\cache`, `${root.real}\\plugins\\marketplaces`],
  )
  return { allowed: [...context.known, ...areas], blocked: context.blocked, roots }
}

/** The root with a reach of its own (a copy of the allowed folders), which this skill's approvals extend. */
function own(root: Paths.Root): Paths.Root & { readonly reach: Paths.Reach & { allowed: string[] } } {
  const reach = root.reach ?? { allowed: [], blocked: [], roots: [] }
  return { ...root, reach: { ...reach, allowed: [...reach.allowed] } }
}

function pluginKey(info: Found["info"]) {
  return `${info.rootID}\0${info.plugin?.marketplace ?? ""}\0${info.plugin?.name ?? ""}\0${info.name}`
}

/** The token of one link (SK2): its root, the skill (or linked folder), the link in it and the target's real path. */
export function linkKey(rootID: string, skill: string, link: string, real: string) {
  const digest = createHash("sha256")
    .update([rootID, skill.toLowerCase(), link.toLowerCase(), Paths.key(real)].join("\0"))
    .digest("hex")
  return decodeLinkKey(`lk-${digest.slice(0, 20)}`)
}

const decodeLinkKey = Schema.decodeSync(OwnImport.LinkKey)

/** The skills below `folder`: folders with a `SKILL.md`, and groups of them (dot folders, plain folders) above. */
async function walkSkills(
  root: Paths.Root,
  folder: string,
  depth: number,
  budget: Budget,
  origin: OwnImport.SkillOrigin,
  context: Context,
  plugin?: Plugin,
  inherited: ReadonlyArray<OwnImport.SkillLink> = [],
): Promise<Found[]> {
  const entries = await listed(root, folder, budget)
  if (entries === undefined) return []
  const children = await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.kind === "directory" || entry.kind === "link") &&
          !SKIP.has(entry.name.toLowerCase()) &&
          !GROUP_SKIP.has(entry.name.toLowerCase()),
      )
      .map(async (entry) => {
        const child = join(folder, entry.name)
        if (entry.kind === "link") return linkedFolder(root, child, depth, budget, origin, context, plugin, inherited)
        const inner = await listed(root, child, budget)
        if (inner === undefined) return []
        if (inner.some((item) => item.kind === "file" && item.name === "SKILL.md"))
          return [await skill(root, child, origin, plugin, context, below(root, child).join("/"), inherited)]
        if (depth + 1 >= SKILL_DEPTH) return []
        return walkSkills(root, child, depth + 1, budget, origin, context, plugin, inherited)
      }),
  )
  return children.flat()
}

/**
 * A skill folder (or a group of skills) that is a link: refused, waiting for approval (listed by its name only, the
 * target not read), or followed like a plain folder with the link kept on its skills.
 */
async function linkedFolder(
  base: Paths.Root,
  folder: string,
  depth: number,
  budget: Budget,
  origin: OwnImport.SkillOrigin,
  context: Context,
  plugin: Plugin,
  inherited: ReadonlyArray<OwnImport.SkillLink>,
): Promise<Found[]> {
  const root = own(base)
  const relative = below(root, folder).join("/")
  const target = await Paths.classifyLink(root, folder, context.known)
  if (target.ok && target.kind === "file") return []
  // A link onto the folder it lies in (or above it) would list itself forever.
  const looped = target.ok && Paths.inside(path.dirname(folder), target.real)
  if (!target.ok || looped) {
    const link: OwnImport.SkillLink = {
      relative: "",
      target: target.ok ? target.real : target.target,
      kind: "folder",
      state: "refused",
      reason: target.ok ? "cycle" : target.reason,
    }
    return [unread(root, folder, origin, plugin, context, [...inherited, link], ["links"])]
  }
  const link = { relative: "", target: target.real, kind: "folder" as const, scope: target.scope }
  if (target.scope === "outside") {
    const key = linkKey(root.rootID, relative, "", target.real)
    if (!context.approved.has(key))
      return [unread(root, folder, origin, plugin, context, [...inherited, { ...link, state: "approve", linkKey: key }])]
    root.reach.allowed.push(Paths.key(target.real))
  }
  const followed: OwnImport.SkillLink = {
    ...link,
    state: "copy",
    ...(target.scope === "outside"
      ? { linkKey: linkKey(root.rootID, relative, "", target.real), approved: true }
      : {}),
  }
  const inner = await listed(root, folder, budget)
  if (inner === undefined) return []
  if (inner.some((item) => item.kind === "file" && item.name === "SKILL.md"))
    return [await skill(root, folder, origin, plugin, context, relative, [...inherited, followed])]
  if (depth + 1 >= SKILL_DEPTH) return []
  return walkSkills(root, folder, depth + 1, budget, origin, context, plugin, [...inherited, followed])
}

/**
 * The plugin skills below a plugins area: every `skills` folder down to {@link PLUGIN_DEPTH}. Its plugin is named by
 * the path: `cache\<marketplace>\<plugin>\<version>\skills` (installed) or `marketplaces\<marketplace>\…\<plugin>\skills`.
 */
async function walkPlugins(
  root: Paths.Root,
  folder: string,
  depth: number,
  budget: Budget,
  context: Context,
): Promise<Found[]> {
  const entries = await listed(root, folder, budget)
  if (entries === undefined) return []
  const children = await Promise.all(
    entries
      .filter(
        (entry) => entry.kind === "directory" && !SKIP.has(entry.name.toLowerCase()) && !entry.name.startsWith("."),
      )
      .map(async (entry) => {
        const child = join(folder, entry.name)
        if (entry.name === "skills") {
          const parts = below(root, child)
          const cache = parts[1] === "cache"
          const owner = cache ? parts[3] : parts.at(-2)
          const plugin = {
            name: owner ?? parts[2] ?? "",
            ...(parts[2] === undefined ? {} : { marketplace: parts[2] }),
            installed: cache,
          }
          return walkSkills(root, child, 1, budget, "claude-plugin", context, plugin)
        }
        if (depth + 1 >= PLUGIN_DEPTH) return []
        return walkPlugins(root, child, depth + 1, budget, context)
      }),
  )
  return children.flat()
}

/** A folder's entries through the allowlist, within the scan's budget. */
async function listed(root: Paths.Root, folder: string, budget: Budget) {
  if (budget.listed >= MAX_LISTED) return undefined
  budget.listed += 1
  const result = await Paths.list(root, folder, "skill")
  return result.ok ? result.value : undefined
}

/** A skill folder not read: a refused link (`problems`) or one waiting for approval; named after the folder. */
function unread(
  root: Paths.Root,
  folder: string,
  origin: OwnImport.SkillOrigin,
  plugin: Plugin,
  context: Context,
  links: ReadonlyArray<OwnImport.SkillLink>,
  problems: ReadonlyArray<OwnImport.SkillProblem> = [],
): Found {
  const name = folder.split(/[\\/]/).at(-1) ?? ""
  const format: OwnImport.SkillFormat =
    problems.length > 0
      ? SkillFormat.withProblems(SkillFormat.analyze("").format, problems)
      : { status: "ok", problems: [], notes: [], ignored: [] }
  return found(root, folder, origin, plugin, context, { name, format }, [], {
    links,
    pending: problems.length === 0,
  })
}

/** One skill folder: its files (names and sizes), `SKILL.md` and, for Codex, `agents/openai.yaml`, then its format. */
async function skill(
  root: Paths.Root,
  folder: string,
  origin: OwnImport.SkillOrigin,
  plugin: Plugin,
  context: Context,
  relative: string,
  inherited: ReadonlyArray<OwnImport.SkillLink>,
): Promise<Found> {
  const view = own(root)
  const walked = await files(view, folder, context, relative)
  const skillMd = await text(view, join(folder, "SKILL.md"), SkillFormat.MAX_SKILL_MD)
  const yaml = walked.files.some((file) => file.relative === "agents/openai.yaml")
    ? await text(view, join(folder, "agents", "openai.yaml"), SkillFormat.MAX_OPENAI_YAML)
    : undefined
  const codex = origin === "codex"
  // A SKILL.md too large or unreadable is there, not missing (SK2, 2026-10-25): only `too_large` or `unreadable`.
  const analysis: SkillFormat.Analysis =
    skillMd.large || skillMd.failed
      ? { format: { status: "incompatible", problems: [], notes: [], ignored: [] } }
      : SkillFormat.analyze(skillMd.value, codex ? (yaml?.value ?? undefined) : undefined, { codex })
  const bytes = walked.files.reduce((sum, file) => sum + file.size, 0)
  const large = {
    ...(skillMd.large ? { skillMd: skillMd.size } : {}),
    ...(walked.files.length > SkillFormat.MAX_FILES ? { files: walked.files.length } : {}),
    ...(bytes > SkillFormat.MAX_BYTES ? { bytes } : {}),
    ...(walked.deep ? { deep: true } : {}),
  }
  const problems: OwnImport.SkillProblem[] = [
    ...walked.problems,
    ...(Object.keys(large).length > 0 ? (["too_large"] as const) : []),
    ...(skillMd.failed ? (["unreadable"] as const) : []),
  ]
  const links = [...inherited, ...walked.links]
  const notes: OwnImport.SkillNote[] = [
    ...(walked.leftOut.length > 0 ? (["left_out_folders"] as const) : []),
    ...(links.some((link) => link.state === "copy") ? (["links_copied"] as const) : []),
  ]
  const name = analysis.name?.trim() || (folder.split(/[\\/]/).at(-1) ?? "")
  return found(
    view,
    folder,
    origin,
    plugin,
    context,
    {
      name,
      description: analysis.description,
      version: analysis.version,
      format: {
        ...SkillFormat.withNotes(SkillFormat.withProblems(analysis.format, problems), notes),
        ...(Object.keys(large).length > 0 ? { large } : {}),
      },
    },
    walked.files,
    { links, pending: walked.pending, modifiedAt: walked.modifiedAt },
  )
}

function found(
  root: Paths.Root,
  folder: string,
  origin: OwnImport.SkillOrigin,
  plugin: Plugin,
  context: Context,
  read: {
    readonly name: string
    readonly description?: string
    readonly version?: string
    readonly format: OwnImport.SkillFormat
  },
  list: Found["files"],
  extra: {
    readonly links: ReadonlyArray<OwnImport.SkillLink>
    readonly pending: boolean
    readonly modifiedAt?: number
  },
): Found {
  const parts = below(root, folder)
  const relative = parts.join("/")
  const base = folder.split(/[\\/]/).at(-1) ?? ""
  const description = read.description?.replace(/\s+/g, " ").trim()
  const real = Paths.realpath(folder)
  const synced = root.kind === "claude-code" && parts[1]?.toLowerCase() === "synced" ? parts[2] : undefined
  const split = synced?.indexOf("_") ?? -1
  return {
    info: {
      key: SkillFormat.key(root.rootID, relative.toLowerCase()),
      origin,
      rootID: OwnImport.RootID.make(root.rootID),
      name: read.name,
      ...(description ? { description } : {}),
      id: SkillFormat.cleanID(base),
      directory: Paths.norm(folder),
      ...(plugin === undefined ? {} : { plugin }),
      system: origin === "codex" && parts[1] === ".system",
      files: list.length,
      bytes: list.reduce((sum, file) => sum + file.size, 0),
      scripts: list
        .filter((file) => SkillFormat.isScript(file.relative))
        .slice(0, 50)
        .map((file) => file.relative),
      format: read.format,
      relative,
      ...(real === undefined ? {} : { real: Paths.norm(real) }),
      ...(extra.modifiedAt === undefined || extra.modifiedAt <= 0 ? {} : { modifiedAt: Math.round(extra.modifiedAt) }),
      ...(read.version === undefined ? {} : { version: read.version }),
      ...(extra.links.length === 0 ? {} : { links: extra.links.slice(0, MAX_LINKS) }),
      ...(synced === undefined || origin !== "claude-code"
        ? {}
        : {
            synced: {
              folder: synced,
              org: split < 0 ? synced : synced.slice(0, split),
              account: split < 0 ? "" : synced.slice(split + 1),
            },
          }),
    },
    root,
    folder,
    relative,
    files: list,
    context,
    pending: extra.pending,
  }
}

interface Walked {
  readonly files: Array<{ relative: string; size: number }>
  readonly problems: OwnImport.SkillProblem[]
  readonly links: OwnImport.SkillLink[]
  readonly leftOut: string[]
  readonly pending: boolean
  readonly modifiedAt: number
  /** A folder deeper than {@link FILE_DEPTH} (`too_large`). */
  readonly deep: boolean
}

/**
 * The files of a skill folder (relative, sizes), up to {@link FILE_DEPTH} and one past {@link SkillFormat.MAX_FILES}.
 * A never-open or secret-looking name is `secret_file` (or `unreadable` when only the allowlist refuses it); neither is
 * read. {@link SKIP} folders are left out. A link is followed as its target when it may be (SK2, see the module
 * comment), else listed as waiting (`approve`) or refused (`links`); its target counts toward the limits.
 */
async function files(
  root: Paths.Root & { readonly reach: Paths.Reach & { allowed: string[] } },
  folder: string,
  context: Context,
  skill: string,
): Promise<Walked> {
  const out: Walked = { files: [], problems: [], links: [], leftOut: [], pending: false, modifiedAt: 0, deep: false }
  const problems = new Set<OwnImport.SkillProblem>()
  const left = new Set<string>()
  const state = { pending: false, newest: 0, deep: false }
  const tooDeep = () => {
    state.deep = true
    problems.add("too_large")
  }
  const refuse = (link: OwnImport.SkillLink, problem: OwnImport.SkillProblem = "links") => {
    out.links.push(link)
    problems.add(problem)
  }
  const add = async (file: string, relative: string) => {
    const stat = await Paths.stat(root, file, "skill")
    if (!stat.ok) return problems.add("unreadable")
    out.files.push({ relative, size: stat.value.size })
    state.newest = Math.max(state.newest, stat.value.mtimeMs)
  }
  const walk = async (current: string, prefix: string, depth: number, above: ReadonlyArray<string>): Promise<void> => {
    if (out.files.length > SkillFormat.MAX_FILES) return
    const entries = await Paths.list(root, current, "skill")
    if (!entries.ok) {
      problems.add("unreadable")
      return
    }
    for (const entry of entries.value) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      const file = join(current, entry.name)
      const lower = entry.name.toLowerCase()
      if (entry.kind === "other") {
        refuse({ relative, target: "", kind: "other", state: "refused", reason: "special" })
        continue
      }
      if (entry.kind === "directory") {
        if (SKIP.has(lower)) left.add(lower)
        else if (depth + 1 >= FILE_DEPTH) tooDeep()
        else await walk(file, relative, depth + 1, [...above, Paths.realKey(file)])
        continue
      }
      if (entry.kind === "link") {
        const target = await Paths.classifyLink(root, file, context.known)
        if (!target.ok) {
          refuse({ relative, target: target.target, kind: "folder", state: "refused", reason: target.reason })
          continue
        }
        const kind = target.kind
        if (kind === "file" && SkillFormat.isSecret(target.real.split("\\").at(-1) ?? "")) {
          refuse({ relative, target: target.real, kind, state: "refused", reason: "denied" }, "secret_file")
          continue
        }
        if (kind === "folder" && above.some((real) => Paths.inside(real, target.real, (value) => value))) {
          refuse({ relative, target: target.real, kind, scope: target.scope, state: "refused", reason: "cycle" })
          continue
        }
        const link = { relative, target: target.real, kind, scope: target.scope }
        if (target.scope === "outside") {
          const key = linkKey(root.rootID, skill, relative, target.real)
          if (!context.approved.has(key)) {
            out.links.push({ ...link, state: "approve", linkKey: key })
            state.pending = true
            continue
          }
          root.reach.allowed.push(Paths.key(target.real))
          out.links.push({ ...link, state: "copy", linkKey: key, approved: true })
        } else out.links.push({ ...link, state: "copy" })
        if (kind === "file") await add(file, relative)
        else if (SKIP.has(lower)) left.add(lower)
        else if (depth + 1 >= FILE_DEPTH) tooDeep()
        else await walk(file, relative, depth + 1, [...above, Paths.key(target.real)])
        if (out.files.length > SkillFormat.MAX_FILES) return
        continue
      }
      if (SkillFormat.isSecret(relative)) {
        problems.add("secret_file")
        continue
      }
      if (Paths.neverName(entry.name, "skill")) {
        problems.add("unreadable")
        continue
      }
      await add(file, relative)
      if (out.files.length > SkillFormat.MAX_FILES) return
    }
  }
  await walk(folder, "", 0, [Paths.realKey(folder)])
  return {
    ...out,
    files: out.files.toSorted((a, b) => (a.relative < b.relative ? -1 : 1)),
    problems: [...problems],
    leftOut: [...left],
    pending: state.pending,
    modifiedAt: state.newest,
    deep: state.deep,
  }
}

/**
 * A small text file of a skill, whole: `value` undefined when missing; `large` past `max` (`size` its size);
 * `failed` when unreadable.
 */
async function text(root: Paths.Root, file: string, max: number) {
  const stat = await Paths.stat(root, file, "skill")
  if (!stat.ok) return { value: undefined, large: false, failed: stat.reason !== "missing", size: 0 }
  const size = stat.value.size
  if (size > max) return { value: undefined, large: true, failed: false, size }
  const read = await Paths.read(root, file, {}, "skill")
  if (!read.ok) return { value: undefined, large: false, failed: true, size }
  return { value: new TextDecoder().decode(read.value), large: false, failed: false, size }
}

/**
 * A found skill's `SKILL.md` (`상세 보기`): its text up to {@link SkillFormat.MAX_SKILL_MD}, else why not (SK2,
 * 2026-10-25: `too_large` with its size, `missing`, `unreadable`).
 */
export async function skillMd(item: Found) {
  return described(await text(item.root, join(item.folder, "SKILL.md"), SkillFormat.MAX_SKILL_MD))
}

/** A read text as `상세 보기` takes it: the text, or the state of a SKILL.md it could not read. */
function described(read: Awaited<ReturnType<typeof text>>): SkillText {
  if (read.value !== undefined) return { text: read.value }
  if (read.large) return { state: "too_large", size: read.size }
  return { state: read.failed ? "unreadable" : "missing" }
}

/** A `SKILL.md` as `상세 보기` reads it: its text, or why it has none (`OwnImport.SkillDetail.skillMd`). */
export type SkillText =
  | { readonly text: string }
  | { readonly state: "missing" | "unreadable" }
  | { readonly state: "too_large"; readonly size: number }

/**
 * Every file of a found skill (09 §9.4: copy and compare), read now through the allowlist; a link as the file it
 * points to. `undefined` when one cannot be read, a link waits for approval, it is over the limits or the folder
 * changed since the scan (files added, removed or resized).
 */
export async function read(item: Found): Promise<SkillStore.File[] | undefined> {
  if (item.pending) return undefined
  const view = own(item.root)
  const now = await files(view, item.folder, item.context, item.relative)
  if (now.problems.length > 0 || now.pending || now.files.length > SkillFormat.MAX_FILES) return undefined
  if (now.files.reduce((sum, file) => sum + file.size, 0) > SkillFormat.MAX_BYTES) return undefined
  const read = await Promise.all(
    now.files.map(async (file) => {
      const bytes = await Paths.read(view, join(item.folder, ...file.relative.split("/")), {}, "skill")
      return bytes.ok ? { relative: file.relative, bytes: new Uint8Array(bytes.value) } : undefined
    }),
  )
  return read.every((file) => file !== undefined) ? read : undefined
}

/** Path segments of `folder` below the root (as listed, case kept). */
function below(root: Paths.Root, folder: string) {
  const full = Paths.norm(folder)
  const base = Paths.norm(root.directory)
  return full
    .slice(base.length)
    .split("\\")
    .filter((part) => part !== "")
}

function join(folder: string, ...parts: ReadonlyArray<string>) {
  return [folder, ...parts].join(process.platform === "win32" ? "\\" : "/")
}
