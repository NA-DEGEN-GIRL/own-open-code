export * as Shared from "./shared.js"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { OwnTeam } from "@own/protocol"
import { Hash } from "@own/runtime"
import { Identity } from "../git/identity.js"
import { Git } from "../git/run.js"
import { JudgeValidate } from "../judge/validate.js"
import { Steps } from "../ops/steps.js"
import { Teams } from "../registry/team.js"
import type { Services } from "../services.js"
import { Symlinks } from "./symlinks.js"

/**
 * Shared untracked folders (06 §4.11). An ignored, untracked folder of the main folder that the judge picked as
 * read-only data (datasets, weights; never a tool cache, V8) is linked into every area at the same relative path: a
 * junction on Windows (no administrator, no Developer Mode), a symlink elsewhere, made with Bun fs from the service
 * process (inside the Claude MSIX `%LOCALAPPDATA%` writes are virtualized, 01 §5.5). `Team.shared {name, target,
 * protect}` is the record; only a recorded folder is ever linked.
 *
 *   protect-shared  confirm   The original becomes read-only first, because `rm -rf <name>/` (trailing slash) follows
 *                             the link and deletes the original's content (J/ r2): a deny ACE on Windows, `chmod -R
 *                             a-w` elsewhere. It changes a user folder, so only the user's confirm runs it (06 §0.3,
 *                             V11): `act` refuses without it, and declining (두기) records nothing, so the folder is
 *                             not shared. Then the record, the `info/exclude` line, and a link in every active area.
 *   link-shared     auto      An area's links ({@link relink}); for a new area after `worktree-create`.
 *
 * **The ACE's rights.** 06 §4.11 writes `(OI)(CI)(W,DE,DC)`. icacls's `W` is FILE_GENERIC_WRITE, which holds
 * SYNCHRONIZE and READ_CONTROL, so denying it stops every read of the folder as well (seen 2026-10-04 on Windows 11:
 * readdir and readFile through the link and at the original fail with EPERM). {@link DENY_RIGHTS} denies writing data,
 * adding files and folders, extended attributes, attributes and deletion, and keeps reading. The ACE names the user by
 * SID (`whoami /user`), and `icacls /save` (SDDL with SIDs, never localized) observes it. Before protecting, the
 * folder's state is recorded in the team records ({@link remember}: its own `icacls /save`, or the entries without an
 * owner write bit); undoing ({@link unprotect}) takes own's part off (`icacls /remove:d`, `chmod -R u+w`) and gives the
 * user's own deny entries or read-only entries back, so a deny entry the user had set stays.
 *
 * **Links.** A link is made only where lstat answers ENOENT, inside a parent that is a plain folder of the area (a
 * code-only area's collapsed folder gets none: Cone.endangered would see a folder of only ignored files). A real
 * folder, a file or a link elsewhere is never touched and keeps the lasting notice `link.blocked` open until it is gone.
 * Right before linking the original is checked again ({@link check}: in the main folder, ignored, untracked, not a tool
 * cache, still the recorded folder; `ls-files` gets it as a literal pathspec). The link is ignored through `<common dir>/info/exclude` as `/<name>` (no trailing
 * `/`: `data/` does not match a Linux symlink, [R-lazy] S/r), under {@link EXCLUDE_HEADER}, written through Symlinks'
 * serialized writer, the one writer of that file. `git clean -fdx` and `git worktree remove` delete a link and leave the
 * original (A/wt-j1, wt-j2); the feature relinks at safe points after runs end ({@link create}). Relinking only adds, so
 * Main 멈춤 does not stop it (TI-13); a folder that fails its identity check gets no link (TI-14).
 *
 * **Removal.** {@link unlink} deletes own's links without following them (`unlink`, never recursive; J/junc.ts) before
 * an area folder is removed (8.6 step 4) and for disable; a real folder or a foreign link stays.
 */

/** The step kinds (06 §3.6 `link-shared`, and the protect confirm). */
export const KIND = { link: "link-shared", protect: "protect-shared" } as const

/** Marks own's shared-folder lines in `info/exclude` (link copies have their own, `Symlinks.EXCLUDE_HEADER`). */
export const EXCLUDE_HEADER = "# own.team shared folders (06 §4.11)"

/** The deny ACE's rights on Windows (see the module comment for why not `W`). */
export const DENY_RIGHTS = "(OI)(CI)(WD,AD,WEA,WA,DE,DC)"

export type Protect = OwnTeam.Shared["protect"]

/** What this platform applies: a deny ACE on Windows, `chmod -R a-w` elsewhere. */
export const PROTECT: Exclude<Protect, "none"> = process.platform === "win32" ? "acl" : "chmod"

/** Why an original is not shared (V8 again, right before linking). */
export type Refusal = "path" | "cache" | "missing" | "tracked" | "not-ignored" | "git"

export type Checked =
  | { readonly ok: true; readonly name: string; readonly target: string }
  | { readonly ok: false; readonly why: Refusal; readonly message: string }

/** What is at an area's link path. */
export type State =
  /** own's link to the original. */
  | "linked"
  /** Nothing (lstat ENOENT): a relink makes the link. */
  | "missing"
  /** The parent folder is not on disk, or is not a plain folder (outside a code-only area's cone). */
  | "no-parent"
  /** The original failed its check again: no link. */
  | "refused"
  /** Blocked (`link.blocked`), never touched: a real folder, a link to somewhere else, anything else. */
  | Blocked

export type Blocked = "folder" | "link" | "other"

export interface Item {
  readonly name: string
  readonly state: State
}

export type Relinked =
  | { readonly ok: true; readonly items: ReadonlyArray<Item>; readonly created: ReadonlyArray<string> }
  | {
      readonly ok: false
      /** Set when the folder is not the recorded worktree (06 §4.3): no link was made. */
      readonly broken?: "missing" | "identity"
      readonly message: string
    }

export type Unlinked =
  | {
      readonly ok: true
      readonly removed: ReadonlyArray<string>
      /** What is at a link path and is not own's link: left as it is. */
      readonly left: ReadonlyArray<{ readonly name: string; readonly why: Blocked }>
    }
  | { readonly ok: false; readonly removed: ReadonlyArray<string>; readonly message: string }

export type Done = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** The shared-folder feature (06 §4.11): relinks at safe points after runs end, and removes links. */
export interface Api extends Services.Lifecycle {
  relink(input: {
    readonly teamID: OwnTeam.TeamID
    readonly areaID: OwnTeam.AreaID
    readonly signal?: AbortSignal
  }): Promise<Relinked>
  unlink(input: { readonly directory: string; readonly shared: ReadonlyArray<OwnTeam.Shared> }): Promise<Unlinked>
}

/**
 * The feature: registers the step kinds and, after every run that ends (and on resume), relinks each active area of a
 * team that is on whose links are missing or whose `link.blocked` notices changed, at its safe point (8.4) so no
 * owner's command races the link. Passes that are asked for while one runs make one more pass after it.
 */
export function create(services: Services.Context): Api {
  register(services)
  const state: { running: Promise<void> | undefined; again: boolean } = { running: undefined, again: false }
  const sweep = (): Promise<void> => {
    if (state.running) {
      state.again = true
      return state.running
    }
    const run = pass(services)
      .catch((error: unknown) => services.log.warn("shared_sweep_failed", { error }))
      .finally(() => {
        state.running = undefined
        if (!state.again) return
        state.again = false
        void sweep()
      })
    state.running = run
    return run
  }
  const stop = services.hub.on(async (event) => {
    if (ENDS.has(event.type)) await sweep()
  })
  return {
    relink: (input) => relink(services, input),
    unlink,
    resume: sweep,
    close: async () => stop(),
  }
}

/** Registers `link-shared` and `protect-shared` once per controller (before the runner resumes an op). */
export function register(services: Services.Context) {
  kinds()
    .filter((kind) => !services.steps.get(kind.kind))
    .forEach((kind) => services.steps.register(kind))
}

/** The `link-shared` step of an area (auto: it only adds links, 3.6). */
export function linkSpec(input: { readonly areaID: OwnTeam.AreaID }): Steps.Spec {
  return { kind: KIND.link, mode: "auto", args: { areaID: input.areaID } }
}

/** The `protect-shared` step of a folder of the main folder (confirm: it changes a user folder's permissions, V11). */
export function protectSpec(input: { readonly name: string }): Steps.Spec {
  return { kind: KIND.protect, mode: "confirm", args: { name: JudgeValidate.folder(input.name) ?? input.name } }
}

/**
 * The area's links made again where nothing is (06 §4.11 "안전 지점마다 다시 만들되 그 경로가 비어 있을 때만"). Nothing
 * to do for an area that is not active. The caller picks the moment (a safe point, an op step).
 */
export async function relink(
  services: Services.Context,
  input: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID; readonly signal?: AbortSignal },
): Promise<Relinked> {
  const [team, area] = await Promise.all([
    services.registry.teams.get(input.teamID),
    services.registry.areas.get(input.teamID, input.areaID),
  ])
  if (!team || !area || area.state !== "active") return { ok: true, items: [], created: [] }
  return link(services, team, area, input.signal)
}

/**
 * Deletes own's links in `directory` without following them (06 §4.11, 8.6 step 4): a link that points at its
 * record's original is `unlink`ed; a real folder, a file or a link elsewhere is left and listed.
 */
export async function unlink(input: {
  readonly directory: string
  readonly shared: ReadonlyArray<OwnTeam.Shared>
}): Promise<Unlinked> {
  const found = await Promise.all(
    input.shared.map(async (record) => ({ record, state: await stateOf(input.directory, record) })),
  )
  const ours = found.filter((item) => item.state === "linked")
  const failures = await Promise.all(
    ours.map((item) =>
      fs.unlink(native(input.directory, item.record.name)).then(
        () => undefined,
        (error: unknown) => `${item.record.name}: ${message(error)}`,
      ),
    ),
  )
  const removed = ours.flatMap((item, index) => (failures[index] === undefined ? [item.record.name] : []))
  const failed = failures.filter((item) => item !== undefined)
  if (failed.length > 0) return { ok: false, removed, message: failed.join("; ") }
  return {
    ok: true,
    removed,
    left: found.flatMap((item) => (isBlocked(item.state) ? [{ name: item.record.name, why: item.state }] : [])),
  }
}

/** What is at each record's link path in `directory` (lstat and readlink only). */
export function inspect(directory: string, shared: ReadonlyArray<OwnTeam.Shared>): Promise<Item[]> {
  return Promise.all(shared.map(async (record) => ({ name: record.name, state: await stateOf(directory, record) })))
}

/**
 * V8 again, right before a link or the protection (06 §3.5): `name` is a folder of the main folder `home` (no `..`, no
 * `.git`), not a tool cache, a real folder on disk (not a link), without tracked files (`ls-files`, the name as a literal
 * pathspec), and ignored (`check-ignore`).
 */
export async function check(input: {
  readonly home: string
  readonly name: string
  readonly signal?: AbortSignal
}): Promise<Checked> {
  const name = JudgeValidate.folder(input.name)
  if (name === undefined || name.split("/").some((part) => part.toLowerCase() === ".git"))
    return refuse("path", `메인 폴더 안의 폴더가 아니에요: ${input.name}`)
  if (name.split("/").some((part) => CACHES.has(part.toLowerCase())))
    return refuse("cache", `도구가 만드는 폴더예요: ${name}`)
  const target = native(input.home, name)
  const stat = await fs.lstat(target).catch(() => undefined)
  if (!stat?.isDirectory()) return refuse("missing", `폴더가 아니에요: ${target}`)
  const options = { cwd: input.home, worktree: true, signal: input.signal }
  const [tracked, ignored] = await Promise.all([
    Git.run(["ls-files", "-z", "--cached", "--", name], { ...options, env: { GIT_LITERAL_PATHSPECS: "1" } }),
    // check-ignore reads path names, not pathspecs (it refuses the `literal` magic).
    Git.run(["check-ignore", "-q", "--", name], options),
  ])
  if (!tracked.ok) return refuse("git", tracked.message)
  if (tracked.stdout !== "") return refuse("tracked", `${name}에 저장 지점에 든 파일이 있어요`)
  if (!ignored.ok && ignored.reason === "exit" && ignored.code === 1)
    return refuse("not-ignored", `무시된 폴더가 아니에요: ${name}`)
  if (!ignored.ok) return refuse("git", ignored.message)
  return { ok: true, name, target }
}

/**
 * Where the original's state from before own's protection is kept (`<records>/shared/<hash of name>`): `.acl` is the
 * folder's own `icacls /save` (SDDL), `.readonly` the entries that had no owner write bit (NUL-separated).
 */
export function saved(team: Pick<OwnTeam.Team, "id" | "commonDir">, name: string) {
  return path.join(Teams.records(team), "shared", Hash.sha256(name).slice(0, 16))
}

/**
 * Makes the original read-only (06 §4.11). Runs only from the confirmed `protect-shared` step. With `state` (see
 * {@link saved}) the folder's protection from before is recorded first ({@link remember}), so {@link unprotect} gives
 * it back as it was.
 */
export async function protect(
  target: string,
  how: Exclude<Protect, "none">,
  signal?: AbortSignal,
  state?: string,
): Promise<Done> {
  const kept = state === undefined ? ({ ok: true } as const) : await remember(target, how, state, signal)
  if (!kept.ok) return kept
  if (how === "chmod") return done(await exec(["chmod", "-R", "a-w", target], signal))
  const user = await sid()
  if (!user.ok) return user
  return done(await exec([system("icacls.exe"), target, "/deny", `*${user.sid}:${DENY_RIGHTS}`], signal))
}

/**
 * Records the original's protection as it is now, unless a record is there already (a protection that was cut short
 * keeps the record of what was there before it): its `icacls /save` on Windows, the entries without an owner write
 * bit elsewhere. The protect step also records a folder the user had protected already, so undoing changes nothing.
 */
export async function remember(
  target: string,
  how: Exclude<Protect, "none">,
  state: string,
  signal?: AbortSignal,
): Promise<Done> {
  const file = `${state}${STATE[how]}`
  if (await Bun.file(file).exists()) return { ok: true }
  await fs.mkdir(path.dirname(state), { recursive: true })
  if (how === "acl") return done(await exec([system("icacls.exe"), target, "/save", file], signal))
  const readonly = await exec(["find", target, "!", "-type", "l", "!", "-perm", "-u=w", "-print0"], signal)
  if (readonly.code !== 0) return { ok: false, message: failure(readonly) }
  await Bun.write(file, readonly.stdout)
  return { ok: true }
}

/**
 * Takes own's protection off again (06 §4.11 되돌림) and gives back what {@link remember} recorded, then drops the
 * record. On Windows `icacls /remove:d` takes every deny entry of the user off the folder, so the user's own explicit
 * deny entries from before are put back right after; elsewhere `chmod -R u+w` gives back the owner's write bits and the
 * entries that had none before lose it again. Without a record (a protection of an older build, or one undone already)
 * it acts only while the protection is on, and then takes off all of it; the group and other write bits `chmod -R a-w`
 * took are never recorded.
 */
export async function unprotect(target: string, how: Protect, signal?: AbortSignal, state?: string): Promise<Done> {
  if (how === "none") return { ok: true }
  const file = state === undefined ? undefined : `${state}${STATE[how]}`
  const recorded = file !== undefined && (await Bun.file(file).exists())
  if (!recorded) {
    const observed = await protection(target, how, signal)
    if (!observed.ok) return observed
    if (!observed.on) return { ok: true }
  }
  const restored = how === "chmod" ? await writable(target, file, signal) : await undeny(target, file, signal)
  if (!restored.ok || file === undefined) return restored
  await fs.rm(file, { force: true })
  return restored
}

/** `chmod -R u+w`, then `chmod u-w` again on the entries the record `file` lists. */
async function writable(target: string, file: string | undefined, signal?: AbortSignal): Promise<Done> {
  const opened = done(await exec(["chmod", "-R", "u+w", target], signal))
  if (!opened.ok || file === undefined) return opened
  const list = await Bun.file(file)
    .text()
    .catch(() => "")
  const entries = list.split("\0").filter((entry) => entry !== "")
  const failed = await chunks(entries, 200).reduce<Promise<string | undefined>>(async (previous, group) => {
    const before = await previous
    if (before !== undefined) return before
    const ran = await exec(["chmod", "u-w", "--", ...group], signal)
    return ran.code === 0 ? undefined : failure(ran)
  }, Promise.resolve(undefined))
  return failed === undefined ? { ok: true } : { ok: false, message: failed }
}

/** `icacls /remove:d` of the user, then the user's explicit deny entries of the record `file` (its SDDL) again. */
async function undeny(target: string, file: string | undefined, signal?: AbortSignal): Promise<Done> {
  const user = await sid()
  if (!user.ok) return user
  const removed = done(await exec([system("icacls.exe"), target, "/remove:d", `*${user.sid}`], signal))
  if (!removed.ok || file === undefined) return removed
  const before = await Bun.file(file)
    .arrayBuffer()
    .then((bytes) => new TextDecoder("utf-16le").decode(bytes))
    .catch(() => "")
  const failed = await denied(before, user.sid).reduce<Promise<string | undefined>>(async (previous, entry) => {
    const earlier = await previous
    if (earlier !== undefined) return earlier
    const ran = await exec([system("icacls.exe"), target, "/deny", `*${user.sid}:${entry}`], signal)
    return ran.code === 0 ? undefined : failure(ran)
  }, Promise.resolve(undefined))
  return failed === undefined ? { ok: true } : { ok: false, message: failed }
}

/** The record's file name ending by protection (see {@link saved}). */
const STATE: Readonly<Record<Exclude<Protect, "none">, string>> = { acl: ".acl", chmod: ".readonly" }

/**
 * Whether the protection is in place: the user's deny ACE (object and container inherit, not inherit-only) with at
 * least {@link DENY_RIGHTS}, or no entry below the original (links aside) with a write bit.
 */
export async function protection(
  target: string,
  how: Protect,
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly on: boolean } | { readonly ok: false; readonly message: string }> {
  if (how === "none") return { ok: true, on: false }
  if (how === "chmod") {
    const found = await exec(["find", target, "!", "-type", "l", "-perm", "/222", "-print", "-quit"], signal)
    if (found.code !== 0) return { ok: false, message: failure(found) }
    return { ok: true, on: found.stdout.trim() === "" }
  }
  const user = await sid()
  if (!user.ok) return user
  const file = path.join(os.tmpdir(), `own-team-acl-${crypto.randomUUID()}.txt`)
  const saved = await exec([system("icacls.exe"), target, "/save", file], signal)
  const text = saved.code === 0 ? new TextDecoder("utf-16le").decode(await Bun.file(file).arrayBuffer()) : undefined
  await fs.rm(file, { force: true })
  if (text === undefined) return { ok: false, message: failure(saved) }
  return { ok: true, on: denies(text, user.sid) }
}

/** Adds `/<name>` for each shared folder to `<commonDir>/info/exclude` under {@link EXCLUDE_HEADER} (once). */
export function exclude(commonDir: string, names: ReadonlyArray<string>) {
  const wanted = [...new Set(names.map(pattern))]
  return Symlinks.rewrite(commonDir, (text) => {
    const lines = text.split(/\r?\n/)
    const missing = wanted.filter((line) => !lines.includes(line))
    if (missing.length === 0) return undefined
    const header = lines.indexOf(EXCLUDE_HEADER)
    if (header < 0)
      return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${[EXCLUDE_HEADER, ...missing].join("\n")}\n`
    const body = [...lines.slice(0, header + 1), ...missing, ...lines.slice(header + 1)].join("\n")
    return body.endsWith("\n") ? body : `${body}\n`
  })
}

/**
 * Takes own's `/<name>` lines out of `<commonDir>/info/exclude` again (a folder no longer shared); the user's lines stay,
 * and own's header goes once its section is empty.
 */
export function unexclude(commonDir: string, names: ReadonlyArray<string>) {
  const drop = new Set(names.map(pattern))
  return Symlinks.rewrite(commonDir, (text) => {
    const lines = text.split(/\r?\n/)
    const header = lines.indexOf(EXCLUDE_HEADER)
    if (header < 0) return undefined
    const kept = lines.filter((line, index) => index <= header || !drop.has(line))
    if (kept.length === lines.length) return undefined
    const end = kept.findIndex((line, index) => index > header && line.startsWith("# own.team "))
    const section = kept.slice(header + 1, end < 0 ? undefined : end).filter((line) => line !== "")
    const body = (section.length === 0 ? kept.filter((_, index) => index !== header) : kept)
      .join("\n")
      .replace(/\n+$/, "")
    return body === "" ? "" : `${body}\n`
  })
}

// ---------------------------------------------------------------------------------------------------------------

const NOTICE = "link.blocked" as const

/** Run ends after which the links are checked (as the cone drift, `assets/drift.ts`). */
const ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

const CACHES = new Set(JudgeValidate.TOOL_CACHES.map((name) => name.toLowerCase()))

/** icacls, chmod and find get as long as a git write step (06 §4.3). */
const TIMEOUT_MS = Git.WRITE_TIMEOUT_MS

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir"

/** FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_EA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, DELETE. */
const REQUIRED = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000

/** SDDL access rights of a file (generic rights as their file mapping). */
const RIGHTS: Readonly<Record<string, number>> = {
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
  SD: 0x10000,
  RC: 0x20000,
  WD: 0x40000,
  WO: 0x80000,
  FA: 0x1f01ff,
  FR: 0x120089,
  FW: 0x120116,
  FX: 0x1200a0,
  GA: 0x1f01ff,
  GR: 0x120089,
  GW: 0x120116,
  GX: 0x1200a0,
}

const LinkArgs = Schema.Struct({ areaID: OwnTeam.AreaID })
const ProtectArgs = Schema.Struct({ name: Schema.String })
const decodeProtect = Schema.decodeUnknownOption(ProtectArgs)

/** The user's SID once found (`whoami /user`). */
const USER: { sid?: string } = {}

function kinds(): ReadonlyArray<Steps.Kind> {
  return [
    Steps.define(KIND.link, LinkArgs, {
      observe: async (args, input) => {
        const found = await load(input.services, input.op.teamID, args.areaID)
        if (!found.ok) return found.observed
        const items = await inspect(found.area.directory, linkable(found.team))
        if (items.length === 0) return { state: "satisfied", note: "공유하는 폴더가 없어요" }
        return items.every((item) => item.state === "linked") ? { state: "satisfied" } : { state: "pending" }
      },
      act: async (args, input) => {
        const found = await load(input.services, input.op.teamID, args.areaID)
        if (!found.ok) return { ok: true, note: found.observed.note }
        const linked = await link(input.services, found.team, found.area, input.signal)
        if (!linked.ok) return { ok: false, note: linked.message }
        return { ok: true, note: describe(linked.items) }
      },
      // Every link that can be made is there: what is left is blocked, waits for its parent folder or was refused.
      verify: async (args, input) => {
        const found = await load(input.services, input.op.teamID, args.areaID)
        if (!found.ok) return { ok: true }
        const missing = (await inspect(found.area.directory, linkable(found.team))).filter(
          (item) => item.state === "missing",
        )
        const left = await Promise.all(
          missing.map(async (item) => {
            const record = found.team.shared.find((entry) => entry.name === item.name)
            return record && (await linkableNow(found.team, record)) ? [item.name] : []
          }),
        )
        const names = left.flat()
        return names.length === 0 ? { ok: true } : { ok: false, note: `연결되지 않은 폴더: ${names.join(", ")}` }
      },
    }),
    {
      ...Steps.define(KIND.protect, ProtectArgs, {
        observe: async (args, input) => {
          const team = await input.services.registry.teams.get(input.op.teamID)
          if (!team || team.state !== "on") return { state: "skip", note: "팀 모드가 꺼져 있어요" }
          const record = team.shared.find((item) => item.name === args.name)
          if (record && record.protect !== "none") {
            const observed = await protection(record.target, record.protect, input.signal)
            if (!observed.ok) return { state: "failed", note: observed.message }
            if (!observed.on) return { state: "pending" }
            return (await unlinked(input.services, team)) ? { state: "pending" } : { state: "satisfied" }
          }
          const checked = await check({ home: team.home.directory, name: args.name, signal: input.signal })
          return checked.ok ? { state: "pending" } : { state: "skip", note: `공유하지 않았어요: ${checked.message}` }
        },
        act: async (args, input) => {
          if (!input.confirmed) return { ok: false, note: "공유 폴더는 사용자가 확인한 뒤에만 읽기 전용으로 바꿔요" }
          const team = await input.services.registry.teams.get(input.op.teamID)
          if (!team) return { ok: false, note: "팀을 찾을 수 없어요" }
          const checked = await check({ home: team.home.directory, name: args.name, signal: input.signal })
          if (!checked.ok) return { ok: false, note: checked.message }
          const observed = await protection(checked.target, PROTECT, input.signal)
          if (!observed.ok) return { ok: false, note: observed.message }
          // What the folder had is recorded either way, so the enable's undo gives back exactly that.
          const state = saved(team, checked.name)
          const applied = observed.on
            ? await remember(checked.target, PROTECT, state, input.signal)
            : await protect(checked.target, PROTECT, input.signal, state)
          if (!applied.ok) return { ok: false, note: applied.message }
          const written = await record(input.services, team.id, {
            name: checked.name,
            target: checked.target,
            protect: PROTECT,
          })
          if (!written) return { ok: false, note: "팀을 찾을 수 없어요" }
          return { ok: true, note: await linkAll(input.services, written, input.signal) }
        },
        verify: async (args, input) => {
          const team = await input.services.registry.teams.get(input.op.teamID)
          const record = team?.shared.find((item) => item.name === args.name)
          if (!record || record.protect === "none") return { ok: false, note: "공유 폴더가 기록되지 않았어요" }
          const observed = await protection(record.target, record.protect, input.signal)
          if (!observed.ok) return { ok: false, note: observed.message }
          return observed.on ? { ok: true } : { ok: false, note: "읽기 전용 보호가 걸려 있지 않아요" }
        },
      }),
      // 06 §9.7: one sentence; own-web adds what changes and how to undo it, with the command under 자세히.
      // 두기 leaves the folder unshared.
      prepare: async (input) => {
        const name = Option.match(decodeProtect(input.step.args), { onNone: () => "", onSome: (args) => args.name })
        return {
          text: `'${name}' 폴더를 모든 영역에 연결할까요? 바로 가기를 따라간 지우기 명령이 원본을 지우지 못하게 이 폴더를 읽기 전용으로 바꿔요. 두면 공유하지 않아요.`,
        }
      },
    },
  ]
}

/** One relink of an area: identity check before the first link, the original checked, the line first, then links. */
async function link(
  services: Services.Context,
  team: OwnTeam.Team,
  area: OwnTeam.Area,
  signal?: AbortSignal,
): Promise<Relinked> {
  const records = linkable(team)
  if (records.length === 0 || Identity.same(area.directory, team.home.directory)) {
    await notice(services, area, [])
    return { ok: true, items: [], created: [] }
  }
  const before = await inspect(area.directory, records)
  const missing = records.filter((record) =>
    before.some((item) => item.name === record.name && item.state === "missing"),
  )
  if (missing.length > 0) {
    const identity = await Identity.check({ directory: area.directory, gitDir: area.gitDir })
    if (!identity.ok) return { ok: false, broken: identity.broken, message: identity.message }
  }
  const allowed = (
    await Promise.all(missing.map(async (record) => ((await linkableNow(team, record, signal)) ? [record] : [])))
  ).flat()
  // The line goes first: on Linux the link would be an untracked file to `add -A` until it is there.
  const excluded =
    allowed.length === 0 ||
    (await exclude(
      team.commonDir,
      allowed.map((record) => record.name),
    ).then(
      () => true,
      (error: unknown) => {
        services.log.warn("shared_exclude_failed", { teamID: team.id, error })
        return false
      },
    ))
  if (!excluded) return { ok: false, message: "info/exclude 파일을 쓰지 못했어요" }
  const created = (
    await Promise.all(
      allowed.map((record) =>
        fs.symlink(record.target, native(area.directory, record.name), LINK_TYPE).then(
          () => [record.name],
          // Something appeared meanwhile (another relink): the next inspect says what it is.
          (error: unknown) => {
            services.log.debug("shared_link_failed", { areaID: area.id, name: record.name, error: message(error) })
            return []
          },
        ),
      ),
    )
  ).flat()
  const refused = new Set(missing.filter((record) => !allowed.includes(record)).map((record) => record.name))
  const items = (await inspect(area.directory, records)).map((item) =>
    item.state === "missing" && refused.has(item.name) ? { ...item, state: "refused" as const } : item,
  )
  await notice(services, area, items)
  return { ok: true, items, created }
}

/** After the protection: the links of every active area, one area at a time. */
async function linkAll(services: Services.Context, team: OwnTeam.Team, signal?: AbortSignal) {
  const areas = (await services.registry.areas.list(team.id)).filter((area) => area.state === "active")
  const results = await areas.reduce<Promise<Relinked[]>>(
    async (before, area) => [...(await before), await link(services, team, area, signal)],
    Promise.resolve([]),
  )
  results
    .flatMap((result, index) => (result.ok ? [] : [{ areaID: areas[index]?.id, message: result.message }]))
    .forEach((failed) => services.log.warn("shared_link_area_failed", failed))
  const created = results.reduce((sum, result) => sum + (result.ok ? result.created.length : 0), 0)
  return `읽기 전용으로 바꾸고 기록했어요 · 영역 ${areas.length}개에 연결 ${created}개`
}

/** Whether an active area of the team still lacks a link that could be made now. */
async function unlinked(services: Services.Context, team: OwnTeam.Team) {
  const areas = (await services.registry.areas.list(team.id)).filter(
    (area) => area.state === "active" && !Identity.same(area.directory, team.home.directory),
  )
  const items = await Promise.all(areas.map((area) => inspect(area.directory, linkable(team))))
  return items.some((list) => list.some((item) => item.state === "missing"))
}

/** A pass of the feature over every team that is on (see {@link create}). */
async function pass(services: Services.Context) {
  const teams = (await services.registry.teams.list()).filter((team) => team.state === "on")
  await Promise.all(
    teams.map(async (team) => {
      const [areas, open] = await Promise.all([services.registry.areas.list(team.id), services.notices.open(team.id)])
      // One area at a time: each relink rewrites the team's `link.blocked` notices.
      await areas
        .filter((item) => item.state === "active")
        .reduce(async (before, area) => {
          await before
          const items = await inspect(area.directory, linkable(team))
          const opened = open.filter((item) => item.kind === NOTICE && item.areaID === area.id).map((item) => item.id)
          const changed = ids(area, items) !== opened.toSorted().join("\n")
          if (!changed && !items.some((item) => item.state === "missing")) return
          const safe = await services.features().safePoint.check({ teamID: team.id, areaID: area.id })
          if (!safe.ok) return
          const linked = await link(services, team, area)
          if (!linked.ok) services.log.warn("shared_relink_failed", { areaID: area.id, message: linked.message })
        }, Promise.resolve())
    }),
  )
}

/** Keeps the area's `link.blocked` notices open exactly while something blocks a link; a new one is published. */
async function notice(services: Services.Context, area: OwnTeam.Area, items: ReadonlyArray<Item>) {
  const open = (await services.notices.open(area.teamID)).filter((item) => item.kind === NOTICE)
  const mine = open.filter((item) => item.areaID === area.id)
  if (
    ids(area, items) ===
    mine
      .map((item) => item.id)
      .toSorted()
      .join("\n")
  )
    return
  const blocked = items.flatMap((item) =>
    isBlocked(item.state)
      ? [
          {
            id: noticeID(area, item),
            at: services.clock.now(),
            areaID: area.id,
            kind: NOTICE,
            text: blockedText(area.name, item.name, item.state),
            data: { area: area.name, dir: item.name, why: item.state },
          },
        ]
      : [],
  )
  await services.notices.keep(area.teamID, NOTICE, [...open.filter((item) => item.areaID !== area.id), ...blocked])
  blocked
    .filter((item) => !mine.some((other) => other.id === item.id))
    .forEach((item) =>
      services.notices.publish({
        teamID: area.teamID,
        areaID: area.id,
        kind: NOTICE,
        text: item.text,
        data: item.data,
      }),
    )
}

/** The sorted notice ids of the blocked items (the reason is part of the id, so a new reason is a new notice). */
function ids(area: OwnTeam.Area, items: ReadonlyArray<Item>) {
  return items
    .filter((item) => isBlocked(item.state))
    .map((item) => noticeID(area, item))
    .toSorted()
    .join("\n")
}

function noticeID(area: OwnTeam.Area, item: Item) {
  return `${NOTICE}:${area.id}:${item.name}:${item.state}`
}

function blockedText(area: string, name: string, why: Blocked) {
  const what = { folder: "진짜 폴더가", link: "다른 곳을 가리키는 링크가", other: "다른 파일이" }[why]
  return `${area}: '${name}' 자리에 ${what} 있어 공유 폴더를 연결하지 않았어요. 그것이 없어지면 다시 연결해요`
}

const STATE_WORDS: Readonly<Record<State, string>> = {
  linked: "연결됨",
  missing: "없음",
  "no-parent": "상위 폴더 없음",
  refused: "확인 실패",
  folder: "진짜 폴더가 있음",
  link: "다른 바로 가기가 있음",
  other: "다른 파일이 있음",
}

function describe(items: ReadonlyArray<Item>) {
  const counts = Map.groupBy(items, (item) => item.state)
  return [...counts.entries()].map(([state, list]) => `${STATE_WORDS[state]} ${list.length}개`).join(", ")
}

/** The step's team and active area, or what observing answers (a broken folder gets no link, TI-14). */
async function load(
  services: Services.Context,
  teamID: OwnTeam.TeamID,
  areaID: OwnTeam.AreaID,
): Promise<
  | { readonly ok: true; readonly team: OwnTeam.Team; readonly area: OwnTeam.Area }
  | { readonly ok: false; readonly observed: { readonly state: "skip"; readonly note: string } }
> {
  const [team, area] = await Promise.all([
    services.registry.teams.get(teamID),
    services.registry.areas.get(teamID, areaID),
  ])
  if (!team || team.state !== "on") return { ok: false, observed: { state: "skip", note: "팀 모드가 꺼져 있어요" } }
  if (!area || area.state === "retired" || area.state === "retiring")
    return { ok: false, observed: { state: "skip", note: "영역을 찾을 수 없어요" } }
  if (area.state === "broken") return { ok: false, observed: { state: "skip", note: "영역이 멈춰 있어요" } }
  return { ok: true, team, area }
}

/** Writes the record in the team's mutex (one entry per name) and announces the team change. */
async function record(services: Services.Context, teamID: OwnTeam.TeamID, entry: OwnTeam.Shared) {
  const written = await services.write(teamID, async () => {
    const team = await services.registry.teams.get(teamID)
    if (!team) return undefined
    return services.registry.teams.put({
      ...team,
      shared: [...team.shared.filter((item) => item.name !== entry.name), entry],
    })
  })
  if (written) services.hub.publish({ name: "team.changed", data: { teamID: written.id, rev: written.rev } })
  return written
}

/** Records that are linked: own protected the original. A record without protection is never linked (fails closed). */
function linkable(team: OwnTeam.Team) {
  return team.shared.filter((record) => record.protect !== "none")
}

/** The original passes its check again and is still the recorded folder. */
async function linkableNow(team: OwnTeam.Team, entry: OwnTeam.Shared, signal?: AbortSignal) {
  const checked = await check({ home: team.home.directory, name: entry.name, signal })
  return checked.ok && comparable(checked.target) === comparable(entry.target)
}

async function stateOf(directory: string, entry: Pick<OwnTeam.Shared, "name" | "target">): Promise<State> {
  const at = native(directory, entry.name)
  const stat = await fs.lstat(at).then(
    (found) => found,
    (error: unknown) => (code(error) === "ENOENT" ? null : undefined),
  )
  if (stat === null) return (await parentReady(directory, entry.name)) ? "missing" : "no-parent"
  if (stat === undefined) return "other"
  if (stat.isSymbolicLink()) return (await pointsAt(at, entry.target)) ? "linked" : "link"
  return stat.isDirectory() ? "folder" : "other"
}

/** The area folder is a folder, and each folder between it and the link is a plain folder (never a link). */
async function parentReady(directory: string, name: string) {
  const root = await fs.stat(directory).then(
    (stat) => stat.isDirectory(),
    () => false,
  )
  if (!root) return false
  const parts = name.split("/").slice(0, -1)
  const plain = await Promise.all(
    parts.map((_, index) =>
      fs.lstat(native(directory, parts.slice(0, index + 1).join("/"))).then(
        (stat) => stat.isDirectory() && !stat.isSymbolicLink(),
        () => false,
      ),
    ),
  )
  return plain.every(Boolean)
}

/** The link's own target (readlink, never followed further) is the original. */
async function pointsAt(link: string, target: string) {
  const value = await fs.readlink(link).catch(() => undefined)
  if (value === undefined) return false
  return comparable(path.resolve(path.dirname(link), value.replace(/^\\\\\?\\|^\\\?\?\\/, ""))) === comparable(target)
}

function comparable(value: string) {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isBlocked(state: State): state is Blocked {
  return state === "folder" || state === "link" || state === "other"
}

/** Whether `sddl` (`icacls /save`) holds the user's deny ACE with {@link REQUIRED} for the folder and below. */
function denies(sddl: string, user: string) {
  return [...sddl.matchAll(/\(([^()]*)\)/g)].some((match) => {
    const [type, flags = "", rights = "", , , who = ""] = (match[1] ?? "").split(";")
    const set = new Set(flags.match(/../g) ?? [])
    return (
      type === "D" &&
      set.has("OI") &&
      set.has("CI") &&
      !set.has("IO") &&
      who.toUpperCase() === user.toUpperCase() &&
      (mask(rights) & REQUIRED) === REQUIRED
    )
  })
}

/**
 * The user's explicit deny entries in `sddl` (an `icacls /save` of the folder; inherited ones left out) as `icacls
 * /deny` grants: `(OI)(CI)…(<rights>)`.
 */
function denied(sddl: string, user: string) {
  return [...sddl.matchAll(/\(([^()]*)\)/g)].flatMap((match) => {
    const [type, flags = "", rights = "", , , who = ""] = (match[1] ?? "").split(";")
    const set = new Set(flags.match(/../g) ?? [])
    if (type !== "D" || set.has("ID") || who.toUpperCase() !== user.toUpperCase()) return []
    const bits = mask(rights)
    const names = SPECIFIC.filter(([, bit]) => (bits & bit) === bit).map(([name]) => name)
    if (names.length === 0) return []
    const inherit = INHERIT.filter((flag) => set.has(flag)).map((flag) => `(${flag})`)
    return [`${inherit.join("")}(${names.join(",")})`]
  })
}

/** icacls's specific rights and their bits (`icacls /?`), for {@link denied}. */
const SPECIFIC: ReadonlyArray<readonly [string, number]> = [
  ["RD", 0x1],
  ["WD", 0x2],
  ["AD", 0x4],
  ["REA", 0x8],
  ["WEA", 0x10],
  ["X", 0x20],
  ["DC", 0x40],
  ["RA", 0x80],
  ["WA", 0x100],
  ["DE", 0x10000],
  ["RC", 0x20000],
  ["WDAC", 0x40000],
  ["WO", 0x80000],
  ["S", 0x100000],
  ["AS", 0x1000000],
  ["MA", 0x2000000],
  ["GA", 0x10000000],
  ["GE", 0x20000000],
  ["GW", 0x40000000],
  ["GR", 0x80000000],
]

/** SDDL inheritance flags icacls takes as they are. */
const INHERIT = ["OI", "CI", "IO", "NP"] as const

function chunks<T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size),
  )
}

function mask(rights: string) {
  if (/^0x[0-9a-f]+$/i.test(rights)) return Number.parseInt(rights, 16)
  return (rights.match(/../g) ?? []).reduce((sum, letters) => sum | (RIGHTS[letters] ?? 0), 0)
}

/** The user's SID, by `whoami /user` from the system folder (a `whoami` on PATH may be Git's). */
async function sid(): Promise<
  { readonly ok: true; readonly sid: string } | { readonly ok: false; readonly message: string }
> {
  if (USER.sid !== undefined) return { ok: true, sid: USER.sid }
  const ran = await exec([system("whoami.exe"), "/user", "/fo", "csv", "/nh"])
  const found = /"(S-1-[0-9-]+)"/.exec(ran.stdout)?.[1]
  if (found === undefined) return { ok: false, message: `whoami /user: ${failure(ran)}` }
  USER.sid = found
  return { ok: true, sid: found }
}

function system(file: string) {
  return path.join(process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows", "System32", file)
}

interface Ran {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** One program with an argument array (no shell); a program that cannot start answers `code: null`. */
function exec(argv: ReadonlyArray<string>, signal?: AbortSignal): Promise<Ran> {
  return Promise.resolve()
    .then(async () => {
      const proc = Bun.spawn([...argv], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(TIMEOUT_MS)]),
      })
      const [stdout, stderr, exited] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code: exited, stdout, stderr }
    })
    .catch((error: unknown) => ({ code: null, stdout: "", stderr: message(error) }))
}

function done(ran: Ran): Done {
  return ran.code === 0 ? { ok: true } : { ok: false, message: failure(ran) }
}

function failure(ran: Ran) {
  return ran.stderr.trim() || ran.stdout.trim() || `exit ${ran.code ?? "-"}`
}

/** An exclude pattern for exactly the path `name` (no trailing `/`: it must match a link too; specials escaped). */
function pattern(name: string) {
  return `/${name.replace(/[\\*?[\]!#]/g, "\\$&").replace(/ $/, "\\ ")}`
}

function refuse(why: Refusal, text: string): Checked {
  return { ok: false, why, message: text }
}

function native(directory: string, file: string) {
  return path.join(directory, ...file.split("/"))
}

function code(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
