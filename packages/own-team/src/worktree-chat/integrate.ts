export * as WorktreeChatIntegrate from "./integrate.js"

import fs from "node:fs"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Git } from "../git/run.js"
import { Porcelain } from "../git/porcelain.js"
import type { Services } from "../services.js"
import { WorktreeChats } from "./chats.js"

/**
 * Integrating and removing a worktree conversation's work (06 §13.5). Team mode's integration (06 ch.7: a verify
 * folder, the team's check commands, a journal op) needs a team; this is the plain Git path for one branch:
 *
 * - Only when the conversation does not run and its worktree has no uncommitted tracked change, and its branch is
 *   ahead of the base branch.
 * - Into the checkout that has the base branch: its tracked files must be clean; a fast-forward when the base did not
 *   move, else a merge commit; a conflict is aborted and named (the worktree conversation should merge the base in).
 *   With no checkout of the base, only a fast-forward of the ref.
 * - Asks first (permission `worktree_integrate`, which no approval mode allows by itself, so even 전체 허용 asks
 *   until the user picks 항상 허용); 읽기 전용 refuses. Never pushes.
 * - `undo`: back to the commit before, while the base still points at what the integration made (`reset --keep`).
 * - Removal: never with uncommitted changes (untracked files count), never while it runs; the branch stays unless it
 *   is merged and `deleteBranch` asks for it.
 */

export const ACTION = "worktree_integrate"

type Reply = { readonly ok: boolean; readonly text: string }
type Ctx = Pick<Plugin.Context, "permission" | "worktree" | "location">

export async function integrate(
  services: Services.Context,
  ctx: Ctx,
  call: ToolContext,
  input: { readonly session: string; readonly undo?: boolean },
): Promise<Reply> {
  const record = await owned(services, call.sessionID, input.session, true)
  if (!record.ok) return record
  const chat = record.record
  const base = chat.base.branch
  if (base === undefined)
    return { ok: false, text: "기준이 브랜치가 아닌 커밋이라 합칠 곳이 없어요. 사용자에게 어느 브랜치에 합칠지 물어 보세요." }
  const mode = await services.accounts.approvalGet({ sessionID: call.sessionID }, { directory: ctx.location.directory })
  if (mode.ok && mode.value.mode === "read-only") return { ok: false, text: "읽기 전용 승인 모드에서는 합치지 않아요." }
  if (input.undo) return undo(services, ctx, call, chat, base)
  const running = await services.http.session.active()
  if (running.ok && running.value.has(chat.sessionID))
    return { ok: false, text: `"${chat.title}" 대화가 아직 일하고 있어요. 끝난 뒤에 합치세요.` }
  const status = await Git.run(["status", "--porcelain=v2", "-z", "-uno"], { cwd: chat.directory, worktree: true })
  if (!status.ok) return { ok: false, text: `작업 폴더를 읽지 못했어요: ${status.message}` }
  const dirty = Porcelain.status(status.stdout).entries.map((entry) => entry.path)
  if (dirty.length > 0)
    return {
      ok: false,
      text: `"${chat.title}" 작업 폴더에 커밋하지 않은 변경이 있어요 (${dirty.slice(0, 5).join(", ")}). worktree_send로 커밋하라고 하세요.`,
    }
  const ahead = await count(chat.directory, `refs/heads/${base}..refs/heads/${chat.branch}`)
  if (ahead === undefined) return { ok: false, text: `브랜치 ${chat.branch}나 ${base}를 읽지 못했어요.` }
  if (ahead === 0) return { ok: false, text: `브랜치 ${chat.branch}에 ${base}로 합칠 커밋이 없어요.` }
  const before = await rev(chat.directory, `refs/heads/${base}`)
  const tip = await rev(chat.directory, `refs/heads/${chat.branch}`)
  if (!before || !tip) return { ok: false, text: "브랜치를 읽지 못했어요." }
  const fastForward = (
    await Git.run(["merge-base", "--is-ancestor", before, tip], { cwd: chat.directory, worktree: true })
  ).ok
  const checkout = await checkoutOf(chat.directory, base)
  if (checkout === undefined && !fastForward)
    return {
      ok: false,
      text: `${base}가 어느 폴더에도 열려 있지 않고 ${chat.branch}가 ${base}보다 뒤처져 있어 합치기 커밋을 만들 곳이 없어요. worktree_send로 ${base}를 먼저 그 브랜치에 합치라고 하세요.`,
    }
  if (checkout !== undefined) {
    const clean = await trackedChanges(checkout)
    if (clean === undefined) return { ok: false, text: `${checkout}를 읽지 못했어요.` }
    if (clean.length > 0)
      return {
        ok: false,
        text: `${base}가 열린 폴더 ${checkout}에 커밋하지 않은 변경이 있어요 (${clean.slice(0, 5).join(", ")}). 먼저 정리해야 합칠 수 있어요.`,
      }
  }
  await ctx.permission.assert({
    sessionID: call.sessionID,
    agent: call.agent,
    action: ACTION,
    resources: [base],
    save: [base],
    metadata: { branch: chat.branch, base, commits: ahead, how: fastForward ? "ff" : "merge", title: chat.title },
    source: { type: "tool", messageID: call.messageID, id: call.id },
  })
  const merged = await apply({ checkout, base, branch: chat.branch, before, tip, fastForward, title: chat.title, cwd: chat.directory })
  if (!merged.ok) return merged
  const after = await rev(chat.directory, `refs/heads/${base}`)
  const now = services.clock.now()
  await WorktreeChats.update(services, chat.sessionID, (current) => ({
    ...current,
    state: "integrated",
    integrated: { before, after: after ?? tip, at: now, how: fastForward ? "ff" : "merge" },
    updated: now,
  }))
  return {
    ok: true,
    text: [
      `${chat.branch}의 커밋 ${ahead}개를 ${base}에 ${fastForward ? "빨리 감기로" : "합치기 커밋으로"} 합쳤어요 (${before.slice(0, 12)} → ${(after ?? tip).slice(0, 12)}). push는 하지 않았어요.`,
      `되돌리려면 worktree_integrate{session, undo: true}. 작업 폴더를 지울지 사용자에게 물은 뒤 worktree_cleanup을 쓰세요.`,
    ].join("\n"),
  }
}

async function apply(input: {
  readonly checkout: string | undefined
  readonly base: string
  readonly branch: string
  readonly before: string
  readonly tip: string
  readonly fastForward: boolean
  readonly title: string
  readonly cwd: string
}): Promise<Reply> {
  if (input.checkout === undefined) {
    const moved = await Git.run(["update-ref", `refs/heads/${input.base}`, input.tip, input.before], {
      cwd: input.cwd,
      worktree: true,
      write: true,
    })
    return moved.ok ? { ok: true, text: "" } : { ok: false, text: `${input.base}를 옮기지 못했어요: ${moved.message}` }
  }
  if (input.fastForward) {
    const ff = await Git.run(["merge", "--ff-only", "--no-edit", input.branch], { cwd: input.checkout, write: true })
    return ff.ok ? { ok: true, text: "" } : { ok: false, text: `빨리 감기를 하지 못했어요: ${ff.message}` }
  }
  const merged = await Git.run(
    ["merge", "--no-ff", "--no-edit", "-m", `Merge worktree conversation "${input.title}" (${input.branch})`, input.branch],
    { cwd: input.checkout, write: true },
  )
  if (merged.ok) return { ok: true, text: "" }
  const conflicts = await Git.run(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: input.checkout })
  const files = conflicts.ok ? conflicts.stdout.split("\0").filter(Boolean) : []
  await Git.run(["merge", "--abort"], { cwd: input.checkout, write: true })
  return {
    ok: false,
    text:
      files.length > 0
        ? `${input.base}와 겹치는 곳이 있어 합치지 않고 되돌렸어요 (${files.slice(0, 8).join(", ")}). worktree_send로 그 대화에 ${input.base}를 먼저 합쳐 충돌을 풀고 커밋하라고 하세요.`
        : `합치지 못했어요: ${merged.message}`,
  }
}

async function undo(
  services: Services.Context,
  ctx: Ctx,
  call: ToolContext,
  chat: WorktreeChats.Stored,
  base: string,
): Promise<Reply> {
  const done = chat.integrated
  if (!done) return { ok: false, text: `"${chat.title}"은(는) 합친 적이 없어요.` }
  const now = await rev(chat.directory, `refs/heads/${base}`)
  if (now !== done.after)
    return { ok: false, text: `${base}가 합친 뒤 다른 곳으로 움직여 되돌리지 않아요 (지금 ${now?.slice(0, 12) ?? "?"}).` }
  const checkout = await checkoutOf(chat.directory, base)
  if (checkout !== undefined) {
    const changes = await trackedChanges(checkout)
    if (changes === undefined || changes.length > 0)
      return { ok: false, text: `${checkout}에 커밋하지 않은 변경이 있어 되돌리지 않아요.` }
  }
  await ctx.permission.assert({
    sessionID: call.sessionID,
    agent: call.agent,
    action: ACTION,
    resources: [base],
    save: [],
    metadata: { branch: chat.branch, base, undo: true, title: chat.title },
    source: { type: "tool", messageID: call.messageID, id: call.id },
  })
  const reset =
    checkout === undefined
      ? await Git.run(["update-ref", `refs/heads/${base}`, done.before, done.after], {
          cwd: chat.directory,
          worktree: true,
          write: true,
        })
      : await Git.run(["reset", "--keep", done.before], { cwd: checkout, write: true })
  if (!reset.ok) return { ok: false, text: `되돌리지 못했어요: ${reset.message}` }
  const at = services.clock.now()
  await WorktreeChats.update(services, chat.sessionID, (current) => ({
    sessionID: current.sessionID,
    parentID: current.parentID,
    name: current.name,
    title: current.title,
    directory: current.directory,
    branch: current.branch,
    base: current.base,
    state: "done",
    created: current.created,
    updated: at,
    ...(current.summary === undefined ? {} : { summary: current.summary }),
    ...(current.parentTitle === undefined ? {} : { parentTitle: current.parentTitle }),
    ...(current.parentDirectory === undefined ? {} : { parentDirectory: current.parentDirectory }),
    ...(current.ended === undefined ? {} : { ended: current.ended, told: current.ended }),
  }))
  return { ok: true, text: `${base}를 합치기 전(${done.before.slice(0, 12)})으로 되돌렸어요. ${chat.branch}의 커밋은 그대로 있어요.` }
}

export async function cleanup(
  services: Services.Context,
  ctx: Ctx,
  call: ToolContext,
  input: { readonly session: string; readonly deleteBranch?: boolean },
): Promise<Reply> {
  const record = await owned(services, call.sessionID, input.session, false)
  if (!record.ok) return record
  const chat = record.record
  const mode = await services.accounts.approvalGet({ sessionID: call.sessionID }, { directory: ctx.location.directory })
  if (mode.ok && mode.value.mode === "read-only") return { ok: false, text: "읽기 전용 승인 모드에서는 지우지 않아요." }
  const running = await services.http.session.active()
  if (running.ok && running.value.has(chat.sessionID))
    return { ok: false, text: `"${chat.title}" 대화가 아직 일하고 있어 지우지 않아요.` }
  if (fs.existsSync(chat.directory)) {
    const status = await Git.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      cwd: chat.directory,
      worktree: true,
    })
    if (!status.ok) return { ok: false, text: `작업 폴더를 읽지 못했어요: ${status.message}` }
    const dirty = Porcelain.status(status.stdout).entries.map((entry) => entry.path)
    if (dirty.length > 0)
      return {
        ok: false,
        text: `커밋하지 않은 변경이 있어 지우지 않아요 (${dirty.slice(0, 5).join(", ")}). 사용자가 직접 정리하거나 그 대화에 커밋하라고 하세요.`,
      }
    const removed = await ctx.worktree
      .remove({ projectID: ctx.location.project.id, directory: chat.directory, force: false })
      .then(() => undefined)
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    if (removed !== undefined) return { ok: false, text: `작업 폴더를 지우지 못했어요: ${removed}` }
  }
  const branch = await deleteBranch(chat, input.deleteBranch === true)
  const at = services.clock.now()
  await WorktreeChats.update(services, chat.sessionID, (current) => ({ ...current, state: "removed", updated: at }))
  return {
    ok: true,
    text: `작업 폴더 ${chat.directory}를 지웠어요. ${branch} 대화 "${chat.title}"는 목록에 남아요.`,
  }
}

async function deleteBranch(chat: WorktreeChats.Stored, wanted: boolean) {
  const base = chat.base.branch
  const cwd = chat.parentDirectory ?? chat.directory
  if (!wanted || base === undefined || !fs.existsSync(cwd)) return `브랜치 ${chat.branch}는 남겼어요.`
  const merged = await Git.run(["merge-base", "--is-ancestor", `refs/heads/${chat.branch}`, `refs/heads/${base}`], { cwd })
  if (!merged.ok) return `브랜치 ${chat.branch}는 ${base}에 다 합쳐지지 않아 남겼어요.`
  const deleted = await Git.run(["branch", "-d", chat.branch], { cwd, write: true })
  return deleted.ok ? `브랜치 ${chat.branch}도 지웠어요.` : `브랜치 ${chat.branch}는 지우지 못했어요: ${deleted.message}`
}

/**
 * The record of `session` when `caller` started it, or (with `self`) is it: a worktree conversation may integrate its
 * own work when the user asks there.
 */
export async function owned(services: Services.Context, caller: string, session: string, self: boolean) {
  const record = await WorktreeChats.find(services, session)
  if (!record || !(record.parentID === caller || (self && record.sessionID === caller)))
    return { ok: false as const, text: `${session}은(는) 이 대화가 시작한 작업 폴더 대화가 아니에요. worktree_status로 목록을 보세요.` }
  if (record.state === "removed") return { ok: false as const, text: `"${record.title}"의 작업 폴더는 이미 지웠어요.` }
  return { ok: true as const, record }
}

/** The worktree that has `branch` checked out, from the repository at `directory`. */
async function checkoutOf(directory: string, branch: string) {
  const listed = await Git.run(["worktree", "list", "--porcelain", "-z"], { cwd: directory, worktree: true })
  if (!listed.ok) return undefined
  return Porcelain.worktrees(listed.stdout).find((item) => item.branch === `refs/heads/${branch}` && !item.bare)?.path
}

async function trackedChanges(directory: string) {
  const status = await Git.run(["status", "--porcelain=v2", "-z", "-uno"], { cwd: directory })
  if (!status.ok) return undefined
  return Porcelain.status(status.stdout).entries.map((entry) => entry.path)
}

async function rev(directory: string, ref: string) {
  const result = await Git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: directory, worktree: true })
  return result.ok ? result.stdout.trim() : undefined
}

async function count(directory: string, range: string) {
  const result = await Git.run(["rev-list", "--count", range], { cwd: directory, worktree: true })
  if (!result.ok) return undefined
  const value = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(value) ? value : undefined
}
