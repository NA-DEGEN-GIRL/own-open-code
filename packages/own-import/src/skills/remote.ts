export * as SkillRemote from "./remote.js"

import path from "node:path"
import { OwnID } from "@own/protocol"
import { OwnImport } from "@own/protocol/rpc-import"
import { Option, Schema } from "effect"
import { SkillFormat } from "./format.js"
import { SkillGit } from "./git.js"
import { SkillStore } from "./store.js"

/**
 * `URL로 설치` (09 §9.5). `preview` clones the repository without file content (`SkillGit.clone`), lists its tree,
 * checks out only the manifests (`.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, every skill's
 * `SKILL.md` and `agents/openai.yaml`) and answers the skills with their file names, executable-looking files, format
 * and conflicts, pinned at one commit; the clone stays under `OWN_HOME/tmp` with a 10-minute single-use nonce.
 * `install` checks out the chosen skills' files at that commit and copies them into own's skills folder. Nothing else
 * is downloaded, and nothing runs: no hook, script or LFS filter of the repository.
 */

/** A preview's nonce lives this long (as 09 §4.8's plans). */
export const TTL_MS = 10 * 60 * 1000
/** The most skills one preview lists. */
export const MAX_SKILLS = 300
/** File names shown per skill. */
const SHOWN_FILES = 200
const SKIP = new Set([".git", "node_modules"])

export interface Candidate {
  readonly info: OwnImport.SkillCandidate
  /** Every blob of the skill, repository-relative. */
  readonly blobs: ReadonlyArray<string>
}

/** A previewed repository while its nonce is valid. */
export interface Planned {
  readonly nonce: OwnImport.SkillPreview["nonce"]
  readonly expiresAt: number
  readonly repo: SkillGit.Repo
  readonly commit: string
  /** `OWN_HOME/tmp/skill-git-*`, holding the clone in `repo`. */
  readonly temp: string
  readonly items: ReadonlyMap<string, Candidate>
}

export type Nonces = Map<string, Planned>

export type Failure =
  | { readonly type: "url_invalid" }
  | { readonly type: "fetch_failed"; readonly reason: OwnImport.FetchProblem }

export interface Deps {
  readonly home: string
  readonly skillsDir: string
  readonly git: SkillGit.Runner
  readonly nonces: Nonces
  /** Ids own-import copied (`skill-imports.json`): a conflict with one of them is replaceable. */
  readonly imported: ReadonlySet<string>
  readonly now?: () => number
}

export async function preview(
  deps: Deps,
  input: OwnImport.SkillRepo,
): Promise<
  { readonly ok: true; readonly value: OwnImport.SkillPreview } | { readonly ok: false; readonly error: Failure }
> {
  const repo = SkillGit.parseRepo(input)
  if (repo === undefined) return { ok: false, error: { type: "url_invalid" } }
  const now = deps.now?.() ?? Date.now()
  await expire(deps.nonces, now)
  const temp = await SkillStore.temp(deps.home, "git")
  const read = await inspect(deps, repo, temp)
  if (!read.ok) {
    await SkillStore.remove(temp)
    return { ok: false, error: { type: "fetch_failed", reason: read.reason } }
  }
  const nonce = OwnID.Nonce.create()
  const planned: Planned = {
    nonce,
    expiresAt: now + TTL_MS,
    repo,
    commit: read.value.commit,
    temp,
    items: new Map(read.value.items.map((item) => [item.info.key, item])),
  }
  deps.nonces.set(nonce, planned)
  return {
    ok: true,
    value: {
      nonce,
      expiresAt: planned.expiresAt,
      url: repo.url,
      ...(repo.ref === undefined ? {} : { ref: repo.ref }),
      ...(repo.folder === undefined ? {} : { folder: repo.folder }),
      commit: read.value.commit,
      layout: read.value.layout,
      items: read.value.items.map((item) => item.info),
      external: read.value.external,
    },
  }
}

/** The valid preview of `nonce`, without using it. */
export function get(nonces: Nonces, nonce: string, now = Date.now()) {
  const found = nonces.get(nonce)
  return found !== undefined && found.expiresAt > now ? found : undefined
}

/** Ends a preview: its nonce and its clone. */
export async function end(nonces: Nonces, nonce: string) {
  const found = nonces.get(nonce)
  nonces.delete(nonce)
  if (found !== undefined) await SkillStore.remove(found.temp)
}

/** Ends every preview older than its nonce. */
export async function expire(nonces: Nonces, now = Date.now()) {
  await Promise.all([...nonces.values()].filter((item) => item.expiresAt <= now).map((item) => end(nonces, item.nonce)))
}

/**
 * The files of the chosen skills at the preview's commit (one batch download), each skill's as {@link SkillStore.File}s
 * relative to its folder. `too_large` past {@link SkillFormat.MAX_BYTES}.
 */
export async function files(
  git: SkillGit.Runner,
  planned: Planned,
  chosen: ReadonlyArray<Candidate>,
): Promise<SkillGit.Result<ReadonlyArray<ReadonlyArray<SkillStore.File>>>> {
  const clone = path.join(planned.temp, "repo")
  const done = await SkillGit.checkout(
    git,
    planned.repo,
    clone,
    planned.commit,
    chosen.flatMap((item) => item.blobs),
  )
  if (!done.ok) return done
  const read = await Promise.all(
    chosen.map(async (item) => {
      const list = await Promise.all(
        item.blobs.map(async (blob) => {
          const bytes = await SkillStore.readCheckout(clone, blob)
          return bytes === undefined ? undefined : { relative: inFolder(item.info.folder, blob), bytes }
        }),
      )
      return list.every((file) => file !== undefined) ? list : undefined
    }),
  )
  if (read.some((list) => list === undefined)) return { ok: false, reason: "other" }
  const lists = read.filter((list) => list !== undefined)
  if (lists.some((list) => list.reduce((sum, file) => sum + file.bytes.length, 0) > SkillFormat.MAX_BYTES))
    return { ok: false, reason: "too_large" }
  return { ok: true, value: lists }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a repository

interface Inspected {
  readonly commit: string
  readonly layout: OwnImport.SkillPreview["layout"]
  readonly items: ReadonlyArray<Candidate>
  readonly external: OwnImport.SkillPreview["external"]
}

async function inspect(deps: Deps, repo: SkillGit.Repo, temp: string): Promise<SkillGit.Result<Inspected>> {
  const clone = path.join(temp, "repo")
  const cloned = await SkillGit.clone(deps.git, repo, clone)
  if (!cloned.ok) return cloned
  const commit = cloned.value
  const listed = await SkillGit.tree(deps.git, clone, commit)
  if (!listed.ok) return listed
  const entries = listed.value
  const scope = repo.folder === undefined ? entries : entries.filter((entry) => under(entry.path, repo.folder ?? ""))
  if (scope.length === 0) return { ok: false, reason: "not_found" }
  const folders = outermost(
    scope
      .filter((entry) => entry.type === "blob" && basename(entry.path) === "SKILL.md")
      .map((entry) => dirname(entry.path))
      .filter((folder) => !folder.split("/").some((part) => SKIP.has(part))),
  )
  if (folders.length > MAX_SKILLS) return { ok: false, reason: "too_large" }
  const has = new Set(entries.filter((entry) => entry.type === "blob").map((entry) => entry.path))
  const marketplace = has.has(".claude-plugin/marketplace.json") ? ".claude-plugin/marketplace.json" : undefined
  const pluginJson = [
    repo.folder === undefined ? undefined : `${repo.folder}/.claude-plugin/plugin.json`,
    ".claude-plugin/plugin.json",
  ]
    .filter((file) => file !== undefined)
    .find((file) => has.has(file))
  const manifests = [
    ...(marketplace === undefined ? [] : [marketplace]),
    ...(pluginJson === undefined ? [] : [pluginJson]),
    ...folders.flatMap((folder) =>
      [join(folder, "SKILL.md"), join(folder, "agents/openai.yaml")].filter((file) => has.has(file)),
    ),
  ]
  const fetched = await SkillGit.checkout(deps.git, repo, clone, commit, manifests)
  if (!fetched.ok) return fetched
  const plugins = marketplace === undefined ? undefined : await marketplacePlugins(clone, marketplace)
  const single = pluginJson === undefined ? undefined : await pluginName(clone, pluginJson)
  const items = await Promise.all(
    folders.map(async (folder): Promise<Candidate> => {
      const own = scope.filter((entry) => entry.type !== "tree" && under(entry.path, folder))
      const blobs = own.filter((entry) => entry.type === "blob" && entry.mode !== "120000").map((entry) => entry.path)
      const relative = own.map((entry) => ({ entry, relative: inFolder(folder, entry.path) }))
      const skillMd = await textOf(clone, join(folder, "SKILL.md"))
      const yaml = has.has(join(folder, "agents/openai.yaml"))
        ? await textOf(clone, join(folder, "agents/openai.yaml"))
        : undefined
      const analysis = SkillFormat.analyze(skillMd, yaml)
      const size = skillMd === undefined ? 0 : Buffer.byteLength(skillMd)
      // Which limit it passed (SK2, 2026-10-25): the tree's true count, the SKILL.md's size.
      const large = {
        ...(size > SkillFormat.MAX_SKILL_MD ? { skillMd: size } : {}),
        ...(own.length > SkillFormat.MAX_FILES ? { files: own.length } : {}),
      }
      const problems: OwnImport.SkillProblem[] = [
        ...(own.some((entry) => entry.mode === "120000" || entry.type === "commit") ? (["links"] as const) : []),
        ...(relative.some((item) => SkillFormat.isSecret(item.relative)) ? (["secret_file"] as const) : []),
        ...(Object.keys(large).length > 0 ? (["too_large"] as const) : []),
      ]
      const id = SkillFormat.cleanID(basename(folder) || repoName(repo.url))
      const conflict = (await SkillStore.exists(deps.skillsDir, id))
        ? { replaceable: deps.imported.has(id) }
        : undefined
      const description = analysis.description?.replace(/\s+/g, " ").trim()
      const plugin = plugins?.assign(folder) ?? single
      return {
        blobs,
        info: {
          key: SkillFormat.key(repo.url, commit, folder),
          name: analysis.name?.trim() || basename(folder) || repoName(repo.url),
          ...(description ? { description } : {}),
          id,
          folder,
          ...(plugin === undefined ? {} : { plugin }),
          files: relative.slice(0, SHOWN_FILES).map((item) => item.relative),
          fileCount: relative.length,
          scripts: relative
            .filter((item) => SkillFormat.isScript(item.relative, item.entry.mode === "100755"))
            .slice(0, 50)
            .map((item) => item.relative),
          format: {
            ...SkillFormat.withProblems(analysis.format, problems),
            ...(Object.keys(large).length > 0 ? { large } : {}),
          },
          ...(conflict === undefined ? {} : { conflict }),
        },
      }
    }),
  )
  return {
    ok: true,
    value: {
      commit,
      layout: marketplace !== undefined ? "marketplace" : pluginJson !== undefined ? "plugin" : "repository",
      items,
      external: plugins?.external ?? [],
    },
  }
}

const Marketplace = Schema.Struct({
  plugins: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.Unknown,
      skills: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})
const decodeMarketplace = Schema.decodeUnknownOption(Schema.fromJsonString(Marketplace))
const PluginJson = Schema.Struct({ name: Schema.String })
const decodePluginJson = Schema.decodeUnknownOption(Schema.fromJsonString(PluginJson))

/**
 * A marketplace's plugins: those in this repository (a `./folder` source, plus their `skills` list) name the skills
 * below them; the others (`github`, `url`, `git-subdir` sources) are listed with their repository to preview later.
 */
async function marketplacePlugins(clone: string, file: string) {
  const text = await textOf(clone, file)
  const decoded = text === undefined ? Option.none() : decodeMarketplace(text)
  const plugins = Option.isSome(decoded) ? decoded.value.plugins : []
  const local = plugins.flatMap((plugin) => {
    if (typeof plugin.source !== "string" || !plugin.source.startsWith("./")) return []
    const root = clean(plugin.source)
    if (root === undefined) return []
    const listed = (plugin.skills ?? []).flatMap((skill) => {
      const folder = clean(skill)
      return folder === undefined ? [] : [join(root, folder)]
    })
    return [{ name: plugin.name, root, listed }]
  })
  const external = plugins
    .filter((plugin) => typeof plugin.source !== "string")
    .slice(0, 100)
    .map((plugin) => {
      const repo = sourceRepo(plugin.source)
      return { plugin: plugin.name, ...(repo === undefined ? {} : { repo }) }
    })
  return {
    external,
    /** The plugin that lists the folder, else the one whose folder holds it most closely. */
    assign: (folder: string) =>
      local.find((plugin) => plugin.listed.includes(folder))?.name ??
      local
        .filter((plugin) => under(folder, plugin.root))
        .toSorted((a, b) => b.root.length - a.root.length)
        .at(0)?.name,
  }
}

async function pluginName(clone: string, file: string) {
  const text = await textOf(clone, file)
  const decoded = text === undefined ? Option.none() : decodePluginJson(text)
  return Option.isSome(decoded) ? decoded.value.name : undefined
}

const Source = Schema.Union([
  Schema.Struct({
    source: Schema.Literal("github"),
    repo: Schema.String,
    ref: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    source: Schema.Literals(["url", "git-subdir", "git"]),
    url: Schema.String,
    ref: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
  }),
])
const decodeSource = Schema.decodeUnknownOption(Source)

/** The repository of a marketplace plugin kept elsewhere, when it is one own can preview. */
function sourceRepo(source: unknown): OwnImport.SkillRepo | undefined {
  const decoded = decodeSource(source)
  if (Option.isNone(decoded)) return undefined
  const value = decoded.value
  const url = value.source === "github" ? `https://github.com/${value.repo}` : value.url
  const repo = SkillGit.parseRepo({
    url,
    ...(value.ref ? { ref: value.ref } : {}),
    ...(value.path ? { folder: value.path } : {}),
  })
  return repo
}

async function textOf(clone: string, file: string) {
  const bytes = await SkillStore.readCheckout(clone, file)
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes)
}

/** `./a/b/` → `a/b`; `undefined` when it leaves the repository. `.`/`./` is the root (`""`). */
function clean(relative: string) {
  const parts = relative.split("/").filter((part) => part !== "" && part !== ".")
  if (parts.some((part) => part === ".." || part.includes("\\"))) return undefined
  return parts.join("/")
}

/** Drops folders inside another listed folder (a skill's own examples are not skills). */
function outermost(folders: ReadonlyArray<string>) {
  const sorted = [...new Set(folders)].toSorted((a, b) => a.length - b.length || (a < b ? -1 : 1))
  return sorted.filter((folder) => !sorted.some((other) => other !== folder && under(folder, other)))
}

function under(file: string, folder: string) {
  return folder === "" || file === folder || file.startsWith(`${folder}/`)
}

function inFolder(folder: string, file: string) {
  return folder === "" ? file : file.slice(folder.length + 1)
}

function join(folder: string, file: string) {
  return folder === "" ? file : `${folder}/${file}`
}

function dirname(file: string) {
  const index = file.lastIndexOf("/")
  return index === -1 ? "" : file.slice(0, index)
}

function basename(file: string) {
  return file.slice(file.lastIndexOf("/") + 1)
}

function repoName(url: string) {
  return basename(url.replace(/\.git$/i, "").replace(/\/+$/, ""))
}
