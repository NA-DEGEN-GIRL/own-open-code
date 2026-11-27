export * as Skills from "./service.js"

import os from "node:os"
import path from "node:path"
import { OwnImport } from "@own/protocol/rpc-import"
import type { Options } from "../options.js"
import { Paths } from "../sources/paths.js"
import { SkillFormat } from "./format.js"
import { SkillGit } from "./git.js"
import { SkillLocal } from "./local.js"
import { SkillRemote } from "./remote.js"
import { SkillStore } from "./store.js"

/**
 * The skills methods of `own.import` (09 §9) on the service thread. Found skills are read only (`SkillLocal`, through
 * `Paths`), copies go into own's global skills folder (`SkillStore.place`) and are recorded in
 * `OWN_HOME/state/skill-imports.json`; a git source is read only when the user asks (`skills.preview`,
 * `skills.install`, `skills.updates`). Core's skill watcher picks a placed copy up by itself, so nothing reloads here.
 * Answers are values or a declared failure, never a throw past {@link create}'s methods' callers (rpc.ts catches).
 */

export type Failure = { readonly type: keyof typeof OwnImport.errors; readonly message: string; readonly data: object }
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Failure }

type Output<M extends OwnImport.MethodName> = (typeof OwnImport.Definition.methods)[M]["output"]["Type"]
type Input<M extends OwnImport.MethodName> = (typeof OwnImport.Definition.methods)[M]["input"]["Type"]

export interface Deps {
  readonly home: string
  /** The current plugin options (roots, `skillsDir`, `controlCenter`). */
  readonly options: () => Options.Info
  readonly git?: SkillGit.Runner
  readonly nonces: SkillRemote.Nonces
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * `%USERPROFILE%` (SK2): where the folders core loads skills from are (`.agents\skills`, `.claude\skills`) and the
   * folders a link never reaches (`.ssh` and the like); default core's home (`OPENCODE_TEST_HOME`, else
   * `os.homedir()`). Unit tests set it.
   */
  readonly homedir?: string
  /** The skills core loads in a project (`GET /api/skill`), for `skills.detail{loaded}`; absent: none found. */
  readonly loaded?: (directory: string) => Promise<ReadonlyArray<{ readonly id: string; readonly path: string }> | undefined>
}

/** own's skills folder: the option, else `%OPENCODE_CONFIG_DIR%\skills`; `undefined` when neither is known. */
export function skillsDir(options: Options.Info, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (options.skillsDir !== undefined) return options.skillsDir
  const config = env.OPENCODE_CONFIG_DIR
  return config ? path.join(config, "skills") : undefined
}

/** `상세 보기` shows at most this much of a `SKILL.md` body, and this many files. */
const MAX_BODY = 256 * 1024
const MAX_DETAIL_FILES = 500
/** Folders below the user profile a link never reaches (SK2): keys and logins of other programs. */
const PRIVATE = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]

export function create(deps: Deps) {
  const git = deps.git ?? SkillGit.run
  const records = SkillStore.records(deps.home)
  /** The last scan's skills by key, so `skills.import` names what the list showed, and the approvals it used. */
  const last = { items: new Map<string, SkillLocal.Found>(), approved: "" }

  const rootsAll = () => Paths.skillRoots({ options: deps.options(), file: Paths.sources(deps.home) })

  /** What links may reach in this scan (SK2): the known folders, the roots, the blocked folders, the approvals. */
  const context = (roots: ReadonlyArray<Paths.Root>, approved: ReadonlyArray<string>): SkillLocal.Context => {
    // Core's home (`Global.Path.home`), whose `.agents` and `.claude` it loads skills from: a test's when one is set.
    const home = deps.homedir ?? (process.env.OPENCODE_TEST_HOME || os.homedir())
    const directory = skillsDir(deps.options(), deps.env)
    const windows = deps.env?.SystemRoot ?? process.env.SystemRoot
    return {
      known: [
        path.join(home, ".agents", "skills"),
        path.join(home, ".claude", "skills"),
        ...(directory === undefined ? [] : [directory]),
      ].map(Paths.realKey),
      blocked: [
        deps.home,
        ...PRIVATE.map((folder) => path.join(home, folder)),
        ...(windows ? [windows] : process.platform === "win32" ? ["C:\\Windows"] : []),
      ].map(Paths.realKey),
      roots,
      approved: new Set(approved),
    }
  }

  const scan = async (approved: ReadonlyArray<string> = []) => {
    const all = await rootsAll()
    const usable = all.filter((root) => !Paths.denied(root))
    const shared = new Set(usable.filter((root) => sharing(root, all).sharedWith !== undefined).map((root) => root.rootID))
    const found = await SkillLocal.scan(usable, context(all, approved), shared)
    last.items.clear()
    last.approved = [...new Set(approved)].toSorted().join(",")
    found.forEach((item) => last.items.set(item.info.key, item))
    return { all, found }
  }

  /** The found skill `key`, from the last scan when it used the same approvals, else from a new one. */
  const foundFor = async (key: string, approved: ReadonlyArray<string>) => {
    const same = [...new Set(approved)].toSorted().join(",") === last.approved
    if (same && last.items.has(key)) return last.items.get(key)
    await scan(approved)
    return last.items.get(key)
  }

  /** The records whose copy still exists in own's skills folder (a deleted copy is no longer own-import's). */
  const current = async (directory: string | undefined) => {
    const stored = await records.read().catch(() => undefined)
    const items = stored?.items ?? []
    if (directory === undefined) return []
    const present = await Promise.all(items.map((item) => SkillStore.exists(directory, item.id)))
    return items.filter((_, index) => present[index])
  }

  const unconfigured: Answer<never> = {
    ok: false,
    error: { type: "skills_unconfigured", message: "own's skills folder is unknown", data: {} },
  }

  /**
   * Content hashes by real folder (SK2, 2026-10-25), kept while the folder's files (names, sizes, newest change) and
   * its link approval stay the same, so a list can compare every skill core loads without reading them all again.
   */
  const digests = new Map<string, { readonly stamp: string; readonly hash: string | undefined }>()
  const digestOf = async (item: SkillLocal.Found) => {
    const id = Paths.key(item.info.real ?? item.info.directory)
    const stamp = `${item.pending}\0${item.info.modifiedAt ?? 0}\0${shapeOf(item)}`
    const known = digests.get(id)
    if (known?.stamp === stamp) return known.hash
    const files = await SkillLocal.read(item)
    const hash = files === undefined ? undefined : SkillFormat.digest(files)
    digests.set(id, { stamp, hash })
    return hash
  }

  /**
   * The skills core loads at `directory` (folders, not built-in or flat ones) with the same files as a found skill, each
   * with its content hash (SK2, 2026-10-25): own's skills folder, `~/.agents/skills` and the project are no roots, so
   * a found copy of the same content is matched by hash, whatever its id.
   */
  async function loadedTwins(
    directory: string,
    found: ReadonlyArray<SkillLocal.Found>,
    all: ReadonlyArray<Paths.Root>,
  ) {
    const shapes = new Set(found.map(shapeOf))
    const reach = context(all, [])
    const twins = await Promise.all(
      ((await deps.loaded?.(directory)) ?? []).map(async (skill) => {
        const file = Paths.norm(skill.path)
        if (!/^[A-Za-z]:\\/.test(file) || path.basename(file).toLowerCase() !== "skill.md") return []
        const item = await SkillLocal.loaded(path.dirname(file), reach)
        if (!shapes.has(shapeOf(item))) return []
        const hash = await digestOf(item)
        return hash === undefined ? [] : [{ id: skill.id, path: file, hash, shape: shapeOf(item) }]
      }),
    )
    return twins.flat()
  }

  async function list(input: Input<"skills.list"> = {}): Promise<Answer<Output<"skills.list">>> {
    const directory = skillsDir(deps.options(), deps.env)
    const [scanned, imports] = await Promise.all([scan(input.approvedLinks ?? []), current(directory)])
    const rootList = await Promise.all(scanned.all.map((root) => rootView(root, scanned.all)))
    const twins = input.directory === undefined ? [] : await loadedTwins(input.directory, scanned.found, scanned.all)
    const shapes = new Set(twins.map((twin) => twin.shape))
    const ids = new Map<string, number>()
    scanned.found.forEach((item) => ids.set(item.info.id.toLowerCase(), (ids.get(item.info.id.toLowerCase()) ?? 0) + 1))
    const hashes = new Map<string, Promise<string | undefined>>()
    /** One folder (by real path) is read once per list, whichever root reached it. */
    const hashOf = (item: SkillLocal.Found) => {
      const id = `${Paths.key(item.info.real ?? item.info.directory)}\0${item.pending}`
      const known = hashes.get(id)
      if (known !== undefined) return known
      const next = digestOf(item)
      hashes.set(id, next)
      return next
    }
    const items = await Promise.all(
      scanned.found.map(async (item) => {
        const record = imports.find(
          (entry) => entry.rootID === item.info.rootID && entry.relative?.toLowerCase() === item.relative.toLowerCase(),
        )
        const wanted =
          input.hashes === true ||
          record !== undefined ||
          (ids.get(item.info.id.toLowerCase()) ?? 0) > 1 ||
          shapes.has(shapeOf(item))
        const hash = wanted ? await hashOf(item) : undefined
        const info = hash === undefined ? item.info : { ...item.info, hash }
        if (record === undefined) return info
        return { ...info, imported: { id: record.id, changed: hash === undefined || hash !== record.hash } }
      }),
    )
    return {
      ok: true,
      value: {
        directory: directory ?? null,
        roots: rootList,
        items,
        imports,
        ...(input.directory === undefined
          ? {}
          : { loaded: twins.map((twin) => ({ id: twin.id, path: twin.path, hash: twin.hash })) }),
      },
    }
  }

  async function importOne(input: Input<"skills.import">): Promise<Answer<Output<"skills.import">>> {
    const directory = skillsDir(deps.options(), deps.env)
    if (directory === undefined) return unconfigured
    const approved = input.approvedLinks ?? []
    // Always a fresh scan: what a link points to now decides, not what the list saw.
    await scan(approved)
    const item = last.items.get(input.key)
    if (item === undefined)
      return { ok: false, error: { type: "skill_not_found", message: "no such skill", data: { key: input.key } } }
    if (item.info.format.status === "incompatible") return incompatible(input.key, item.info.format.problems)
    const waiting = (item.info.links ?? []).filter((link) => link.state === "approve")
    if (waiting.length > 0) {
      const keys = new Set((item.info.links ?? []).flatMap((link) => (link.linkKey ? [link.linkKey] : [])))
      return {
        ok: false,
        error: {
          type: "skill_links",
          message: "the skill has links outside its root that are not approved",
          data: {
            key: input.key,
            linkKeys: waiting.flatMap((link) => (link.linkKey ? [link.linkKey] : [])),
            reason: approved.some((key) => !keys.has(key)) ? "changed" : "unapproved",
          },
        },
      }
    }
    const id = input.id ?? item.info.id
    const imports = await current(directory)
    const conflict = await conflictOf(directory, id, imports, input.replace === true)
    if (conflict !== undefined) return conflict
    const files = await SkillLocal.read(item)
    if (files === undefined) return incompatible(input.key, ["unreadable"])
    const target = await SkillStore.place({
      home: deps.home,
      skillsDir: directory,
      id,
      files: converted(files, item.info.format),
      replace: input.replace === true,
    })
    const links = (item.info.links ?? []).flatMap((link) =>
      link.scope === "outside" && link.state === "copy"
        ? [{ relative: link.relative, target: link.target, ...(link.linkKey ? { linkKey: link.linkKey } : {}) }]
        : [],
    )
    await record({
      id,
      origin: item.info.origin,
      name: item.info.name,
      importedAt: Date.now(),
      hash: SkillFormat.digest(files),
      files: files.length,
      rootID: item.info.rootID,
      relative: item.relative,
      source: item.info.directory,
      ...(links.length === 0 ? {} : { links }),
    })
    return { ok: true, value: { id, directory: target } }
  }

  /**
   * `상세 보기` (SK2): a found skill by key, own-import's copy, or a skill core loads in a project. Read only; the body
   * goes to the client as text.
   */
  async function detail(input: Input<"skills.detail">): Promise<Answer<Output<"skills.detail">>> {
    const directory = skillsDir(deps.options(), deps.env)
    if ("copy" in input) return copyDetail(input.copy, directory)
    if ("loaded" in input) {
      const listed = await deps.loaded?.(input.directory)
      const skill = listed?.find((item) => item.id === input.loaded)
      const file = skill === undefined ? undefined : Paths.norm(skill.path)
      if (file === undefined || !/^[A-Za-z]:\\/.test(file))
        return { ok: false, error: { type: "skill_not_found", message: "no such skill", data: { key: input.loaded } } }
      if (path.basename(file).toLowerCase() !== "skill.md") return { ok: true, value: await flatDetail(file) }
      const item = await SkillLocal.loaded(path.dirname(file), context(await rootsAll(), []))
      return { ok: true, value: await foundDetail(item, await current(directory)) }
    }
    const item = await foundFor(input.key, input.approvedLinks ?? [])
    if (item === undefined)
      return { ok: false, error: { type: "skill_not_found", message: "no such skill", data: { key: input.key } } }
    return { ok: true, value: await foundDetail(item, await current(directory)) }
  }

  async function foundDetail(item: SkillLocal.Found, imports: ReadonlyArray<OwnImport.SkillImport>) {
    const read = await SkillLocal.skillMd(item)
    const files = await SkillLocal.read(item)
    const hash = files === undefined ? undefined : SkillFormat.digest(files)
    const record = imports.find(
      (entry) => entry.rootID === item.info.rootID && entry.relative?.toLowerCase() === item.relative.toLowerCase(),
    )
    return shape({
      name: item.info.name,
      fallback: item.info.name,
      description: item.info.description,
      directory: item.info.directory,
      // A folder behind a link that waits for approval is not read yet: no state, the links say why.
      read: item.pending && !("text" in read) ? undefined : read,
      files: item.files,
      hash,
      format: item.info.format,
      links: item.info.links,
      imported:
        record === undefined
          ? undefined
          : { record, source: hash === undefined ? "unknown" : hash === record.hash ? "same" : "changed" },
    })
  }

  /** A skill core loads as one `.md` file next to others (`skills\<id>.md`): that file only. */
  async function flatDetail(file: string) {
    const loaded = await SkillLocal.loadedFile(file)
    const relative = path.basename(file)
    const bytes = loaded?.large === false ? loaded.bytes : undefined
    return shape({
      fallback: relative.replace(/\.md$/i, ""),
      directory: Paths.norm(file),
      read:
        loaded === undefined
          ? { state: "unreadable" }
          : loaded.large
            ? { state: "too_large", size: loaded.size }
            : { text: new TextDecoder().decode(loaded.bytes) },
      files: loaded === undefined ? [] : [{ relative, size: loaded.large ? loaded.size : loaded.bytes.length }],
      hash: bytes === undefined ? undefined : SkillFormat.digest([{ relative, bytes }]),
    })
  }

  async function copyDetail(id: OwnImport.SkillID, directory: string | undefined): Promise<Answer<Output<"skills.detail">>> {
    if (directory === undefined) return unconfigured
    const imports = await current(directory)
    const record = imports.find((item) => item.id === id)
    if (record === undefined)
      return { ok: false, error: { type: "skill_not_found", message: "no such copy", data: { key: id } } }
    const files = await SkillStore.readCopy(directory, id, {
      files: SkillFormat.MAX_FILES,
      bytes: SkillFormat.MAX_BYTES,
    })
    const skill = files?.find((file) => file.relative === "SKILL.md")
    const read: SkillLocal.SkillText =
      files === undefined
        ? { state: "unreadable" }
        : skill === undefined
          ? { state: "missing" }
          : skill.bytes.length > SkillFormat.MAX_SKILL_MD
            ? { state: "too_large", size: skill.bytes.length }
            : { text: new TextDecoder("utf-8", { ignoreBOM: false }).decode(skill.bytes) }
    return {
      ok: true,
      value: shape({
        fallback: record.name,
        directory: Paths.norm(path.join(directory, id)),
        read,
        files: (files ?? []).map((file) => ({ relative: file.relative, size: file.bytes.length })),
        // The source's hash when it was copied (09 §9.4): what the other tools' copies are compared with.
        hash: record.hash,
        imported: { record, source: await sourceNow(record) },
      }),
    }
  }

  /** A local source now against its record (`skills.updates`' rule); a git source is never asked here (network). */
  async function sourceNow(record: OwnImport.SkillImport): Promise<"same" | "changed" | "source_missing" | "unknown"> {
    if (record.origin === "git") return "unknown"
    const scanned = await scan((record.links ?? []).flatMap((link) => (link.linkKey ? [link.linkKey] : [])))
    const source = scanned.found.find(
      (entry) => entry.info.rootID === record.rootID && entry.relative.toLowerCase() === record.relative?.toLowerCase(),
    )
    if (source === undefined) return "source_missing"
    const files = await SkillLocal.read(source)
    if (files === undefined) return "unknown"
    return SkillFormat.digest(files) === record.hash ? "same" : "changed"
  }

  async function preview(input: Input<"skills.preview">): Promise<Answer<Output<"skills.preview">>> {
    const directory = skillsDir(deps.options(), deps.env)
    if (directory === undefined) return unconfigured
    const imported = new Set((await current(directory)).map((item) => item.id))
    const previewed = await SkillRemote.preview(
      { home: deps.home, skillsDir: directory, git, nonces: deps.nonces, imported },
      input,
    )
    if (previewed.ok) return previewed
    if (previewed.error.type === "url_invalid")
      return { ok: false, error: { type: "url_invalid", message: "not an https git URL", data: {} } }
    return fetchFailed(previewed.error.reason)
  }

  async function install(input: Input<"skills.install">): Promise<Answer<Output<"skills.install">>> {
    const directory = skillsDir(deps.options(), deps.env)
    if (directory === undefined) return unconfigured
    const planned = SkillRemote.get(deps.nonces, input.nonce)
    if (planned === undefined)
      return {
        ok: false,
        error: { type: "nonce_invalid", message: "the preview is unknown, used or expired", data: {} },
      }
    const chosen = input.keys.map((key) => ({ key, item: planned.items.get(key) }))
    const missing = chosen.find((entry) => entry.item === undefined)
    if (missing !== undefined)
      return { ok: false, error: { type: "skill_not_found", message: "no such skill", data: { key: missing.key } } }
    const items = chosen.flatMap((entry) => (entry.item === undefined ? [] : [entry.item]))
    const blocked = items.find((item) => item.info.format.status === "incompatible")
    if (blocked !== undefined) return incompatible(blocked.info.key, blocked.info.format.problems)
    const ids = items.map((item) => input.renames?.find((rename) => rename.key === item.info.key)?.id ?? item.info.id)
    const twice = ids.find((id, index) => ids.indexOf(id) !== index)
    if (twice !== undefined)
      return {
        ok: false,
        error: { type: "skill_conflict", message: "two skills get one id", data: { id: twice, replaceable: false } },
      }
    const imports = await current(directory)
    for (const id of ids) {
      const conflict = await conflictOf(directory, id, imports, input.replace === true)
      if (conflict !== undefined) return conflict
    }
    const fetched = await SkillRemote.files(git, planned, items)
    if (!fetched.ok) {
      if (fetched.reason === "too_large") return incompatible(items[0]?.info.key ?? "", ["too_large"])
      await SkillRemote.end(deps.nonces, planned.nonce)
      return fetchFailed(fetched.reason)
    }
    const installed = []
    for (const [index, item] of items.entries()) {
      const files = fetched.value[index] ?? []
      const id = ids[index]
      const target = await SkillStore.place({
        home: deps.home,
        skillsDir: directory,
        id,
        files: converted(files, item.info.format),
        replace: input.replace === true,
      })
      await record({
        id,
        origin: "git",
        name: item.info.name,
        importedAt: Date.now(),
        hash: SkillFormat.digest(files),
        files: files.length,
        url: planned.repo.url,
        ...(planned.repo.ref === undefined ? {} : { ref: planned.repo.ref }),
        commit: planned.commit,
        folder: item.info.folder,
      })
      installed.push({ id, directory: target })
    }
    await SkillRemote.end(deps.nonces, planned.nonce)
    return { ok: true, value: { installed } }
  }

  async function updates(): Promise<Answer<Output<"skills.updates">>> {
    const directory = skillsDir(deps.options(), deps.env)
    const imports = await current(directory)
    // A copy's approved links are approved again while they point where they did (the key has the target).
    const approved = imports.flatMap((item) => (item.links ?? []).flatMap((link) => (link.linkKey ? [link.linkKey] : [])))
    const found = imports.some((item) => item.origin !== "git") ? (await scan(approved)).found : []
    const items = await Promise.all(
      imports.map(async (item): Promise<OwnImport.SkillUpdate> => {
        if (item.origin === "git") {
          if (item.url === undefined) return { id: item.id, state: "unknown" }
          const now = await SkillGit.remoteCommit(git, {
            url: item.url,
            ...(item.ref === undefined ? {} : { ref: item.ref }),
          })
          if (!now.ok) return { id: item.id, state: now.reason === "not_found" ? "source_missing" : "unknown" }
          return { id: item.id, state: now.value === item.commit ? "same" : "changed", commit: now.value }
        }
        const source = found.find(
          (entry) => entry.info.rootID === item.rootID && entry.relative.toLowerCase() === item.relative?.toLowerCase(),
        )
        if (source === undefined) return { id: item.id, state: "source_missing" }
        const files = await SkillLocal.read(source)
        if (files === undefined) return { id: item.id, state: "unknown", key: source.info.key }
        return {
          id: item.id,
          state: SkillFormat.digest(files) === item.hash ? "same" : "changed",
          key: source.info.key,
        }
      }),
    )
    return { ok: true, value: { items } }
  }

  /**
   * `지우기` in 설정 > 스킬 (SM): a copy own-import made, by its record, out of own's skills folder; its record goes too.
   * A folder own-import did not make (a project's skill, another tool's, one the user put there) is never touched.
   */
  async function remove(input: Input<"skills.remove">): Promise<Answer<Output<"skills.remove">>> {
    const directory = skillsDir(deps.options(), deps.env)
    if (directory === undefined) return unconfigured
    const imports = await current(directory)
    if (!imports.some((item) => item.id === input.id))
      return {
        ok: false,
        error: { type: "skill_not_imported", message: "no copy own-import made has this id", data: { id: input.id } },
      }
    await SkillStore.discard({ home: deps.home, skillsDir: directory, id: input.id })
    await records.update((stored) => ({ schemaVersion: 1, items: stored.items.filter((item) => item.id !== input.id) }))
    return { ok: true, value: { id: input.id } }
  }

  /** `skill_conflict` when own's folder has `id`; replaceable (and replaced with `replace`) only for own-import's copy. */
  async function conflictOf(
    directory: string,
    id: string,
    imports: ReadonlyArray<OwnImport.SkillImport>,
    replace: boolean,
  ): Promise<Answer<never> | undefined> {
    if (!(await SkillStore.exists(directory, id))) return undefined
    const replaceable = imports.some((item) => item.id === id)
    if (replace && replaceable) return undefined
    return {
      ok: false,
      error: { type: "skill_conflict", message: "own has a skill with this id", data: { id, replaceable } },
    }
  }

  async function record(entry: OwnImport.SkillImport) {
    await records.update((stored) => ({
      schemaVersion: 1,
      items: [...stored.items.filter((item) => item.id !== entry.id), entry],
    }))
  }

  return {
    list,
    import: importOne,
    detail,
    preview,
    install,
    updates,
    remove,
    /** Ends every preview (their clones under `OWN_HOME/tmp`). */
    close: () => Promise.all([...deps.nonces.keys()].map((nonce) => SkillRemote.end(deps.nonces, nonce))),
  }
}

export type Service = ReturnType<typeof create>

/**
 * A root as the skills list shows it (09 §9.2, SK2): its problem, how it came to be, its account, and whether its
 * `skills` folder is another root's (`sharedWith`, a junction) or links elsewhere (`skillsTarget`, not read).
 */
async function rootView(root: Paths.Root, all: ReadonlyArray<Paths.Root>): Promise<OwnImport.Root> {
  const problem = await Paths.problem(root)
  const skills = problem === undefined ? sharing(root, all) : {}
  return {
    rootID: OwnImport.RootID.make(root.rootID),
    kind: root.kind,
    label: root.label,
    directory: root.directory,
    added: root.added,
    available: problem === undefined,
    ...(problem === undefined ? {} : { problem }),
    origin: root.origin,
    ...(root.account === undefined
      ? {}
      : {
          account: {
            app: "codex-multi-provider" as const,
            id: root.account.id,
            ...(root.account.alias === null ? {} : { alias: root.account.alias }),
          },
        }),
    ...skills,
  }
}

/**
 * Whether the root's skills are another root's (SK2): the root folder is the same folder as another root of its kind
 * (2026-10-25: a codex-multi-provider profile whose whole codex home is a junction onto `~/.codex`), or `<root>\skills`
 * is a link onto another root's `skills` folder (`sharedWith`, the root that owns it), or anywhere else
 * (`skillsTarget`). Real paths only, nothing listed. Of roots that are one folder, the one that is no link owns it,
 * else the first listed.
 */
function sharing(root: Paths.Root, all: ReadonlyArray<Paths.Root>) {
  const base = Paths.realpath(root.directory) ?? root.directory
  const twins = all.filter(
    (other) =>
      other.kind === root.kind && Paths.key(Paths.realpath(other.directory) ?? other.directory) === Paths.key(base),
  )
  const home = twins.find((other) => Paths.key(other.directory) === Paths.key(base)) ?? twins[0]
  if (home !== undefined && home.rootID !== root.rootID) return { sharedWith: OwnImport.RootID.make(home.rootID) }
  const real = Paths.realpath(path.join(root.directory, "skills"))
  if (real === undefined) return {}
  if (Paths.key(real) === Paths.key(path.join(base, "skills"))) return {}
  const owner = all.find((other) => {
    if (other.rootID === root.rootID) return false
    const folder = path.join(Paths.realpath(other.directory) ?? other.directory, "skills")
    return Paths.key(folder) === Paths.key(real)
  })
  if (owner !== undefined) return { sharedWith: OwnImport.RootID.make(owner.rootID) }
  return { skillsTarget: Paths.norm(real) }
}

/** A skill's files as names and sizes (SK2): two skills hash the same only when these are the same. */
function shapeOf(item: SkillLocal.Found) {
  return item.files.map((file) => `${file.relative}:${file.size}`).join("\0")
}

/**
 * The detail answer: frontmatter and body from `read` (parsed once, within {@link SkillFormat.frontmatter}'s budget),
 * the name given, else the frontmatter's, else `fallback`; files capped, sizes summed.
 */
function shape(input: {
  readonly name?: string
  readonly fallback: string
  readonly description?: string
  readonly directory: string
  /** `SKILL.md` as read; `undefined` when it is not read yet (a link waits for approval). */
  readonly read: SkillLocal.SkillText | undefined
  readonly files: ReadonlyArray<{ readonly relative: string; readonly size: number }>
  readonly hash?: string
  readonly format?: OwnImport.SkillFormat
  readonly links?: ReadonlyArray<OwnImport.SkillLink>
  readonly imported?: OwnImport.SkillDetail["imported"]
}): OwnImport.SkillDetail {
  const read = input.read
  const front = read !== undefined && "text" in read ? SkillFormat.frontmatter(read.text) : undefined
  const body = front?.body
  const given = (key: string) => front?.entries.find((entry) => entry.key === key && entry.omitted === undefined)?.value
  const description = input.description ?? given("description")
  return {
    name: input.name ?? (given("name") || input.fallback),
    ...(description ? { description } : {}),
    directory: input.directory,
    frontmatter: front?.entries ?? [],
    ...(body === undefined ? {} : { body: body.slice(0, MAX_BODY) }),
    truncated: (body?.length ?? 0) > MAX_BODY,
    ...(read === undefined || "text" in read
      ? {}
      : { skillMd: { state: read.state, ...(read.state === "too_large" ? { size: read.size } : {}) } }),
    files: input.files.slice(0, MAX_DETAIL_FILES).map((file) => ({ relative: file.relative, size: file.size })),
    fileCount: input.files.length,
    bytes: input.files.reduce((sum, file) => sum + file.size, 0),
    ...(input.hash === undefined ? {} : { hash: input.hash }),
    ...(input.format === undefined ? {} : { format: input.format }),
    ...(input.links === undefined || input.links.length === 0 ? {} : { links: input.links }),
    ...(input.imported === undefined ? {} : { imported: input.imported }),
  }
}

/** A converted skill's copy says `disable-model-invocation: true` (09 §9.3); the hash stays the source's. */
function converted(files: ReadonlyArray<SkillStore.File>, format: OwnImport.SkillFormat) {
  if (format.status !== "converted") return files
  return files.map((file) =>
    file.relative === "SKILL.md"
      ? {
          relative: file.relative,
          bytes: new TextEncoder().encode(
            SkillFormat.convert(new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.bytes)),
          ),
        }
      : file,
  )
}

function incompatible(key: string, problems: ReadonlyArray<OwnImport.SkillProblem>): Answer<never> {
  return {
    ok: false,
    error: {
      type: "skill_incompatible",
      message: "own cannot use this skill as it is",
      data: { key, problems: [...problems] },
    },
  }
}

function fetchFailed(reason: OwnImport.FetchProblem): Answer<never> {
  return { ok: false, error: { type: "fetch_failed", message: "the repository could not be read", data: { reason } } }
}
