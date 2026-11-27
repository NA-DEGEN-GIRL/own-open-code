export * as Transcripts from "./transcripts.js"

import fs from "node:fs/promises"
import path from "node:path"
import { ClaudeLogin } from "../claude/login.js"

/**
 * The shared transcript folder of the Claude Agent route (02 §8.10, CAG phase 2): every account folder's `projects`
 * (where Claude Code keeps its conversations, `projects/<directory>/<session>.jsonl`) is a junction to one folder own
 * manages, `<OWN_HOME>\claude-agent\projects`. So when a conversation moves to another account by hand, claude
 * started on the other folder resumes the same Claude conversation (`--resume`), and the provider's transcript checks
 * and forks (core P-045) find it there. Without the link the turn would start over from a flattened text.
 *
 * {@link ensure} makes the link, and repairs what it finds instead: a link that points elsewhere or at nothing is made
 * again; a real `projects` folder (Claude Code ran there before the link existed) has its conversations moved into the
 * shared folder first, a file name the shared folder already has going to `projects.kept-<time>` beside it, so nothing
 * is lost. A `projects` that is a file, or a move that fails, is {@link Broken}: the caller refuses the request with
 * that reason rather than run without the conversation. The shared folder itself must be a real folder inside
 * OWN_HOME (CAG-34): own sweeps and writes transcripts there, so a junction on its way (to `~/.claude/projects`, say)
 * is refused, never followed.
 */

/** A `projects` own could not turn into the link; `reason` is shown to the user (Korean). */
export class Broken extends Error {
  constructor(
    readonly folder: string,
    readonly reason: string,
  ) {
    super(reason)
  }
}

export type Outcome = "linked" | "created" | "repaired" | "merged"

/**
 * Makes or repairs `<folder>\projects` as a junction to `shared` (under `home`); throws {@link Broken} if it cannot.
 * Answers the outcome and the shared folder's checked real path (`realpath(home)` joined with the parts below it),
 * which is what the provider is told (CAG-42): core writes only when `realpath(shared)` is that very path.
 */
export async function ensure(
  folder: string,
  shared: string,
  home: string,
): Promise<{ readonly outcome: Outcome; readonly real: string }> {
  const link = path.join(folder, "projects")
  const real = await secure(folder, shared, home)
  const found = await fs.lstat(link).catch(() => undefined)
  if (found === undefined) {
    await make(folder, link, shared)
    return { outcome: "created", real }
  }
  if (found.isSymbolicLink()) {
    const target = await fs.readlink(link).catch(() => undefined)
    if (target !== undefined && ClaudeLogin.same(path.resolve(folder, target), shared))
      return { outcome: "linked", real }
    // A link to another folder, or one that cannot be read: made again (its target is never touched).
    await fs.unlink(link).catch((error: unknown) => {
      throw new Broken(folder, `대화 기록 연결을 고치지 못했어요(${code(error)}). ${link}를 지운 뒤 다시 시도하세요.`)
    })
    await make(folder, link, shared)
    return { outcome: "repaired", real }
  }
  if (!found.isDirectory())
    throw new Broken(folder, `${link}가 폴더가 아니라 파일이에요. 그 파일을 옮기거나 지운 뒤 다시 시도하세요.`)
  await merge(folder, link, shared)
  await make(folder, link, shared)
  return { outcome: "merged", real }
}

/** Whether `<folder>\projects` is the link to `shared` now (no change). */
export async function linked(folder: string, shared: string) {
  const link = path.join(folder, "projects")
  const found = await fs.lstat(link).catch(() => undefined)
  if (!found?.isSymbolicLink()) return false
  const target = await fs.readlink(link).catch(() => undefined)
  return target !== undefined && ClaudeLogin.same(path.resolve(folder, target), shared)
}

/** Takes the link out of a folder that leaves the route (its target, the shared folder, stays). */
export async function unlink(folder: string) {
  const link = path.join(folder, "projects")
  const found = await fs.lstat(link).catch(() => undefined)
  if (found?.isSymbolicLink()) await fs.unlink(link)
}

/**
 * Makes the shared folder when it is missing, one level at a time below `home`, and refuses one that is not a real
 * folder there: every level under OWN_HOME a real folder (never a junction or another link), and its real path inside
 * OWN_HOME's (which may itself be a link).
 */
async function secure(folder: string, shared: string, home: string) {
  const relative = path.relative(home, shared)
  const parts = relative.split(path.sep)
  if (relative === "" || parts[0] === ".." || path.isAbsolute(relative))
    throw new Broken(folder, `대화 기록 폴더 ${shared}가 own 폴더(${home}) 밖에 있어요.`)
  for (const at of parts.map((_, index) => path.join(home, ...parts.slice(0, index + 1)))) {
    const found = await fs.lstat(at).catch(() => undefined)
    if (found?.isSymbolicLink())
      throw new Broken(
        folder,
        `${at}가 다른 곳으로 이어진 링크(정션)예요. 대화 기록은 own 폴더 안의 진짜 폴더에만 둬요 — 그 링크를 지운 뒤 다시 시도하세요.`,
      )
    if (found && !found.isDirectory())
      throw new Broken(folder, `${at}가 폴더가 아니라 파일이에요. 그 파일을 옮기거나 지운 뒤 다시 시도하세요.`)
    if (!found)
      await fs.mkdir(at).catch((error: unknown) => {
        throw new Broken(folder, `대화 기록 폴더 ${at}를 만들지 못했어요(${code(error)}).`)
      })
  }
  const [real, top] = await Promise.all([fs.realpath(shared), fs.realpath(home)]).catch((error: unknown) => {
    throw new Broken(folder, `대화 기록 폴더 ${shared}를 확인하지 못했어요(${code(error)}).`)
  })
  const checked = path.join(top, ...parts)
  if (!ClaudeLogin.same(real, checked))
    throw new Broken(
      folder,
      `대화 기록 폴더 ${shared}가 own 폴더 밖(${real})을 가리켜요. 그 연결을 지운 뒤 다시 시도하세요.`,
    )
  return checked
}

async function make(folder: string, link: string, shared: string) {
  await fs.symlink(shared, link, "junction").catch((error: unknown) => {
    throw new Broken(folder, `대화 기록 폴더를 연결하지 못했어요(${code(error)}).`)
  })
}

/**
 * Moves every project folder of a real `projects` into the shared folder, entry by entry; a name the shared folder
 * already has (the same conversation file, or another one under that name) keeps the shared copy and moves this one to
 * `projects.kept-<time>` next to `projects`. A junction or another link, at any depth, and a file with more than one
 * hard link go there too, never into the shared folder (own sweeps and writes there; CAG-34, CAG-44), so folders move
 * entry by entry. The emptied folder goes.
 */
async function merge(folder: string, link: string, shared: string) {
  const kept = path.join(folder, `projects.kept-${Date.now()}`)
  const move = async (from: string, to: string, aside: string): Promise<void> => {
    const here = await fs.lstat(from)
    const there = await fs.lstat(to).catch(() => undefined)
    // A file with another name elsewhere (a hard link) would let an append in the shared folder change that file too.
    const elsewhere = (await redirected(from, here)) || (here.isFile() && here.nlink > 1)
    if (!elsewhere && here.isDirectory() && (there === undefined || there.isDirectory())) {
      if (there === undefined) await fs.mkdir(to)
      for (const name of await fs.readdir(from)) await move(path.join(from, name), path.join(to, name), path.join(aside, name))
      return fs.rmdir(from)
    }
    if (!elsewhere && there === undefined) return fs.rename(from, to)
    await fs.mkdir(path.dirname(aside), { recursive: true })
    return fs.rename(from, aside)
  }
  try {
    for (const name of await fs.readdir(link)) await move(path.join(link, name), path.join(shared, name), path.join(kept, name))
    await fs.rmdir(link)
  } catch (error) {
    throw new Broken(
      folder,
      `${link}의 대화 기록을 함께 쓰는 폴더로 옮기지 못했어요(${code(error)}). 그 계정의 Claude Code를 모두 닫고 다시 시도하세요.`,
    )
  }
}

/** A link, or an entry whose real path is not where it lies (a reparse point lstat does not show as a link). */
async function redirected(entry: string, found: { isSymbolicLink(): boolean }) {
  if (found.isSymbolicLink()) return true
  const [real, parent] = await Promise.all([fs.realpath(entry), fs.realpath(path.dirname(entry))])
  return !ClaudeLogin.same(real, path.join(parent, path.basename(entry)))
}

function code(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : String(error)
}
