// TG12 재구성 안전 (must, the Windows part; 06 §8, §11.3) on a real server, and the TG19 record of a conversion done by
// own (4.14). The project is F1 with `Assets/` as a heavy folder (four code-only areas `alpha`, `beta`, `gamma`,
// `delta`), ignore rules, and its links kept like this user's checkout (copies + skip-worktree, FORK §11), so the areas
// carry link copies (assume-unchanged) that `status` cannot see.
//
// - 끝내기 (`gamma`): an edited link copy, uncommitted work, an independent repository in an ignored folder and a nested
//   worktree each keep the folder (the area ends, its branch, its owner conversation and every file stay); an unmerged
//   commit shows its count in the removal dialog and the branch stays; a detached commit gets `refs/own/keep/<sha>`
//   before the removal (no unreachable commit); a new ignored file after the dialog makes the answer ask again with the
//   new list; a PowerShell whose current folder is in the area makes the removal fail with the in-use message, and 끝내기
//   again once it is closed clears what is left. Small irreplaceable files (`.env`) go to the team records first.
// - 영역 묶기 (`beta` → `alpha`) while `alpha` has uncommitted work: an untracked file in the cone, one outside the cone
//   (a sparse folder) and an edited link copy all go to the hold ref `refs/own/hold/<alpha>/<op>` (TI-1, 8.7) and stay
//   on disk; 두기 keeps `beta`'s folder; the undo puts `alpha` back and `beta` in the team again.
// - Main 멈춤 (`delta`): the main's split of it (`team_reorganize`) runs 0 steps, the card and `reorg.skipped` say why;
//   the main's and the judge's conversation moves become suggestions (no conversation moves).
// - A running shell in `delta` holds its safe point: the user's split waits and goes on once the shell ended.
// - 변환 (`delta`): code → full asks with the bytes; full → code is refused while a leaving folder has untracked work,
//   and lists an ignored file there that only goes after the confirm; the owner conversation is replaced first. The
//   new owner's first turn diff is recorded (`[TG19 record]`).
// - 대화 옮기기: the user moves a conversation into `alpha` (`own.team.moved`); a revert to before the move is recorded
//   (`[TG12 record]`), and the move's undo takes it back.
// - The server is killed after each step of a split (`alpha` → `alpha-two`) and restarted: one new area, branch,
//   worktree and owner, and `alpha`'s uncommitted work as it was.
// - No branch and no session is ever deleted.
//
// Verdicts come from durable state: op records and the registry, git (refs, `worktree list`, sparse state, files) and
// the session rows. Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Undo } from "../../src/ops/undo.js"
import { Convert } from "../../src/reorg/convert.js"
import { Remove } from "../../src/reorg/remove.js"
import { F1_LINKS, commit, f1, git, init, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  answer,
  confirmOf,
  enableTeam,
  killEachStep,
  messages,
  notices,
  opEnd,
  ops,
  reorganize,
  same,
  sessionRows,
  startShell,
  startTeamServer,
  stopShell,
  teamMeta,
  turnDiff,
  until,
  waitValue,
  type TeamServer,
} from "./harness.js"
import { sparse, worktrees } from "./inspect.js"

const STEP_TIMEOUT = 420_000
/** The kill test boots the server once per step. */
const KILL_TIMEOUT = 900_000
const SLUGS = ["alpha", "beta", "gamma", "delta"] as const

interface Setup {
  readonly server: TeamServer
  readonly teamID: OwnTeam.TeamID
  readonly home: string
  readonly main: string
  /** Every branch and session seen so far (none may go). */
  readonly seen: { readonly branches: Set<string>; readonly sessions: Set<string> }
}

describe("TG12 reorganizations on a real server (F1 + heavy `Assets/`, link copies, four code-only areas)", () => {
  const state: {
    setup?: Setup
    gamma?: { readonly opID: OwnTeam.OpID; readonly detached: string; readonly unmerged: string }
    chat?: string
    server?: TeamServer
  } = {}

  beforeAll(async () => {
    const server = await startTeamServer({ name: "reorg", project })
    state.server = server
    const viewed = await server.createSession({ title: "켠 대화" })
    const enabled = await enableTeam(server, {
      hint: `[propose-areas 4 ${SLUGS.join(" ")} +heavy=Assets]`,
      sessionID: viewed,
    })
    const team = required(enabled.view.team ?? undefined)
    expect(team.env.symlinkFix).toBe("skip-worktree")
    expect(enabled.view.areas.map((area) => `${slug(area.id)}:${area.shape}`).toSorted()).toEqual(
      SLUGS.map((name) => `${name}:code`).toSorted(),
    )
    state.setup = {
      server,
      teamID: team.id,
      home: required(server.project),
      main: team.main.sessionID,
      seen: { branches: new Set(), sessions: new Set() },
    }
    remember(state.setup)
  }, BOOT_TIMEOUT)

  afterEach(() => {
    if (state.setup) remember(state.setup)
  })

  afterAll(async () => {
    // The server goes even when the setup failed half way (its temp root with it).
    await state.server?.stop()
  }, 120_000)

  test(
    "끝내기 keeps a folder whose link copy was edited: the area ends, its folder, branch and owner stay",
    async () => {
      const setup = required(state.setup)
      const gamma = await areaOf(setup, "gamma")
      const copy = path.join(gamma.directory, "docs", "guide-link.md")
      expect(gamma.linkCopies?.["docs/guide-link.md"]).toBeDefined()
      fs.writeFileSync(copy, "edited copy\n")
      // The copy is assume-unchanged: status cannot see the edit (4.12).
      expect(git(gamma.directory, ["status", "--porcelain"])).toBe("")

      const op = await opEnd(setup.server, await apply(setup, [{ op: "retire", area: "gamma" }]))
      expect(op.state).toBe("done")
      const removal = required(op.steps.find((step) => step.kind === Remove.KIND))
      expect(removal.state).toBe("skipped")
      expect(removal.note).toContain("바로 가기 파일 사본")
      expect(op.summary?.lines).toContainEqual({ kind: "area", areaID: gamma.id, change: "touched" })
      expect(fs.readFileSync(copy, "utf8")).toBe("edited copy\n")
      expect((await areaOf(setup, "gamma")).state).toBe("retired")
      expect(branch(setup.home, "gamma")).toBeDefined()
      const view = await setup.server.team("team.get", { directory: setup.home })
      expect(
        (view.notices ?? []).filter((item) => item.kind === "link.copy.dirty" && item.areaID === gamma.id),
      ).not.toEqual([])
      const owner = required(rows(setup).find((row) => row.id === gamma.owner.sessionID))
      expect(owner.metadata[Undo.ARCHIVED]).toBe(true)
      fs.writeFileSync(copy, "guide\n")
    },
    STEP_TIMEOUT,
  )

  test(
    "uncommitted work, an independent repository and a nested worktree keep the folder; nothing in them is touched",
    async () => {
      const setup = required(state.setup)
      const gamma = await areaOf(setup, "gamma")
      const kept = async (expected: string) => {
        const op = await opEnd(setup.server, await apply(setup, [{ op: "retire", area: "gamma" }]))
        expect(op.state).toBe("done")
        const removal = required(op.steps.find((step) => step.kind === Remove.KIND))
        expect(removal).toMatchObject({ state: "skipped" })
        expect(removal.note).toContain(expected)
        expect(fs.existsSync(path.join(gamma.directory, ".git"))).toBe(true)
      }

      write(gamma.directory, { "src/app/main.ts": "export const main = 2\n" })
      await kept("아직 저장 지점에 넣지 않은 변경")
      expect(fs.readFileSync(path.join(gamma.directory, "src", "app", "main.ts"), "utf8")).toBe(
        "export const main = 2\n",
      )
      git(gamma.directory, ["checkout", "-q", "--", "src/app/main.ts"])

      // An independent repository in an ignored folder, with a commit and a changed file (8.6 step 1, [R-review] e7).
      const lib = init(path.join(gamma.directory, "vendor", "lib"))
      write(lib, { "lib.ts": "export const lib = 1\n" })
      const vendored = commit(lib, "vendored")
      write(lib, { "lib.ts": "export const lib = 2\n" })
      await kept(Remove.NESTED)
      expect(fs.readFileSync(path.join(lib, "lib.ts"), "utf8")).toBe("export const lib = 2\n")
      expect(git(lib, ["rev-parse", "HEAD"]).trim()).toBe(vendored)
      fs.rmSync(path.join(gamma.directory, "vendor"), { recursive: true, force: true })

      // A worktree of the same repository nested in an ignored folder.
      const nested = path.join(gamma.directory, "build", "nested")
      git(setup.home, ["worktree", "add", "-q", "-b", "nested-e2e", nested])
      write(nested, { "wip.txt": "nested work\n" })
      await kept(Remove.NESTED)
      expect(fs.readFileSync(path.join(nested, "wip.txt"), "utf8")).toBe("nested work\n")
      git(setup.home, ["worktree", "remove", "--force", nested])
    },
    STEP_TIMEOUT,
  )

  test(
    "an unmerged commit and a detached commit; a new ignored file after the dialog asks again with the new list",
    async () => {
      const setup = required(state.setup)
      const gamma = await areaOf(setup, "gamma")
      write(gamma.directory, { "src/gamma.ts": "export const gamma = 1\n" })
      const unmerged = commit(gamma.directory, "gamma work")
      git(gamma.directory, ["checkout", "-q", "--detach"])
      write(gamma.directory, { "src/detached.ts": "export const detached = 1\n" })
      const detached = commit(gamma.directory, "detached work")
      write(gamma.directory, {
        "build/out.bin": crypto.getRandomValues(new Uint8Array(8_192)),
        ".env": "TOKEN=fake-e2e-value\n",
      })

      const opID = await apply(setup, [{ op: "retire", area: "gamma" }])
      const first = await confirmOf(setup.server, opID, Remove.KIND)
      // The unapplied save points are counted when the op is planned and travel in the step's args (06 §8.6).
      expect(first.step.args).toMatchObject({ areaID: gamma.id, unapplied: 1 })
      const listed = (first.confirm.files ?? []).map((file) => file.path)
      expect(listed.some((file) => same(file, path.join(gamma.directory, "build")))).toBe(true)
      // `.env` is small and cannot be made again: it is kept in the team records, never listed for deletion.
      expect(listed.some((file) => file.endsWith(".env"))).toBe(false)

      write(gamma.directory, { "build/late.log": "written after the dialog\n" })
      expect(await answer(setup.server, opID, first.step, "do")).toMatchObject({ status: 400, type: "nonce_invalid" })
      const second = await confirmOf(setup.server, opID, Remove.KIND)
      expect(second.confirm.nonce).not.toBe(first.confirm.nonce)
      expect(second.confirm.manifest).not.toBe(first.confirm.manifest)
      expect(second.confirm.bytes ?? 0).toBeGreaterThan(first.confirm.bytes ?? 0)
      expect(fs.existsSync(path.join(gamma.directory, "build", "late.log"))).toBe(true)
      state.gamma = { opID, detached, unmerged }
    },
    STEP_TIMEOUT,
  )

  test(
    "a PowerShell in the folder makes the removal fail with the in-use message; 끝내기 again clears what is left",
    async () => {
      const setup = required(state.setup)
      const gamma = await areaOf(setup, "gamma")
      const pending = required(state.gamma)
      const asked = await confirmOf(setup.server, pending.opID, Remove.KIND)
      const shell =
        process.platform === "win32"
          ? Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 600"], {
              cwd: gamma.directory,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            })
          : undefined
      try {
        await Bun.sleep(2_000)
        expect((await answer(setup.server, pending.opID, asked.step, "do")).status).toBe(200)
        const op = await opEnd(setup.server, pending.opID, { timeoutMs: STEP_TIMEOUT })
        const removal = required(op.steps.find((step) => step.kind === Remove.KIND))
        console.log(
          `[TG12 record] removal with a PowerShell in the folder: op ${op.state}, step ${removal.state} (${removal.note ?? ""}); folder left ${fs.existsSync(gamma.directory)}`,
        )
        if (shell) {
          expect(op.state).toBe("failed")
          expect(removal.note).toContain(Remove.IN_USE)
        }
      } finally {
        shell?.kill()
        await shell?.exited
      }

      if (fs.existsSync(gamma.directory)) {
        const opID = await apply(setup, [{ op: "retire", area: "gamma" }])
        const op = await opEnd(setup.server, opID, { waiting: true })
        // A leftover that was not all on the confirmed list is asked about again.
        const step = op.steps.find((item) => item.state === "needs_confirm")
        console.log(
          `[TG12 record] 끝내기 again after the PowerShell closed: what was left ${step ? "was asked about again" : "was cleared without a question (all on the confirmed list)"}`,
        )
        if (step) expect((await answer(setup.server, opID, step, "do")).status).toBe(200)
        expect((await opEnd(setup.server, opID)).state).toBe("done")
      }
      expect(fs.existsSync(gamma.directory)).toBe(false)
      expect(worktrees(setup.home).some((entry) => same(entry.path, gamma.directory))).toBe(false)
      // The branch keeps the unmerged commit; the detached one is held by its keep ref (TI-4, TI-8).
      expect(branch(setup.home, "gamma")).toBe(pending.unmerged)
      expect(git(setup.home, ["rev-parse", `refs/own/keep/${pending.detached}`]).trim()).toBe(pending.detached)
      const team = await teamOf(setup)
      const env = path.join(Remove.retiredFolder(team, gamma.id), ".env")
      expect(fs.readFileSync(env, "utf8")).toBe("TOKEN=fake-e2e-value\n")
    },
    STEP_TIMEOUT,
  )

  test(
    "영역 묶기 with uncommitted work in A: all of it in the hold ref and on disk; 두기 keeps B; the undo puts A back",
    async () => {
      const setup = required(state.setup)
      const alpha = await areaOf(setup, "alpha")
      const beta = await areaOf(setup, "beta")
      write(beta.directory, { "src/beta.ts": "export const beta = 1\n" })
      const source = commit(beta.directory, "beta work")
      const before = required(branch(setup.home, "alpha"))
      expect(sparse(alpha.directory).enabled).toBe(true)
      expect(fs.existsSync(path.join(alpha.directory, "Assets", "Textures", "rock.bin"))).toBe(false)
      write(alpha.directory, { ...WORK, "README-link.md": "edited link copy\n" })
      const work = snapshot(alpha.directory)

      const opID = await apply(setup, [{ op: "merge", area: "alpha", from: "beta" }])
      const asked = await confirmOf(setup.server, opID, Remove.KIND)
      expect(asked.op.steps.find((step) => step.kind === Remove.KIND)?.args).toMatchObject({ areaID: beta.id })
      expect((await answer(setup.server, opID, asked.step, "skip")).status).toBe(200)
      const op = await opEnd(setup.server, opID)
      expect(op.state).toBe("done")
      expect(branch(setup.home, "alpha")).toBe(source)
      const hold = `refs/own/hold/${alpha.id}/${opID}`
      expect(op.summary?.lines).toContainEqual(expect.objectContaining({ kind: "ref", ref: hold }))
      // The untracked file outside the cone (`add -A --sparse`) and the edited copy are in the hold ref too.
      for (const [file, content] of Object.entries({ ...WORK, "README-link.md": "edited link copy\n" }))
        expect(git(setup.home, ["show", `${hold}:${file}`])).toBe(content)
      expect(snapshot(alpha.directory)).toEqual(work)
      expect((await areaOf(setup, "beta")).state).toBe("retired")
      expect(fs.existsSync(beta.directory)).toBe(true)
      expect(branch(setup.home, "beta")).toBe(source)

      const undone = await setup.server.team("op.undo", { opID })
      expect((await opEnd(setup.server, undone.opID)).state).toBe("done")
      expect(branch(setup.home, "alpha")).toBe(before)
      expect(git(alpha.directory, ["rev-parse", "HEAD"]).trim()).toBe(before)
      expect((await areaOf(setup, "beta")).state).toBe("active")
      expect(snapshot(alpha.directory)).toEqual(work)
    },
    STEP_TIMEOUT,
  )

  test(
    "Main 멈춤: the main's split runs 0 steps and says why; the main's and the judge's conversation moves are suggestions",
    async () => {
      const setup = required(state.setup)
      const delta = await areaOf(setup, "delta")
      const tip = branch(setup.home, "delta")
      const chat = await setup.server.createSession({ title: "사용자 대화" })
      state.chat = chat
      await setup.server.team("area.pause", { teamID: setup.teamID, areaID: delta.id, on: true })

      const before = new Set(ops(db(setup), setup.teamID).map((op) => op.id))
      await setup.server.turn(
        setup.main,
        `[propose-reorg ${JSON.stringify({
          version: 1,
          ops: [
            { op: "split", area: "delta", slug: "delta-x", name: "델타 엑스" },
            { op: "move", sessionID: chat, area: "alpha" },
          ],
        })}]`,
      )
      const started = required(
        ops(db(setup), setup.teamID).find((op) => op.kind === "reorg" && op.by === "main" && !before.has(op.id)),
      )
      const op = await opEnd(setup.server, started.id)
      expect(op.steps.filter((step) => step.args.areaID === delta.id)).toEqual([])
      expect(op.steps.some((step) => step.kind === "session-move")).toBe(false)
      expect(op.summary?.lines).toContainEqual(
        expect.objectContaining({ kind: "skipped", areaID: delta.id, why: "paused" }),
      )
      expect(op.summary?.lines).toContainEqual(
        expect.objectContaining({ kind: "suggest", suggestion: expect.objectContaining({ kind: "move" }) }),
      )
      expect(notices(setup.server, "reorg.skipped").some((item) => item.areaID === delta.id)).toBe(true)
      expect(branch(setup.home, "delta-x")).toBeUndefined()
      expect(branch(setup.home, "delta")).toBe(tip)

      // 팀 구성 다시 보기: the judge's answer moves the conversation; the plan and the op only suggest it.
      const proposed = await setup.server.team("reorg.propose", {
        teamID: setup.teamID,
        hint: `[propose-reorg ${JSON.stringify({
          version: 1,
          ops: [{ op: "move", sessionID: chat, area: "alpha" }],
          notes: "이 대화를 알파 영역으로 옮기면 좋겠습니다.",
        })}]`,
      })
      expect(JSON.stringify(proposed.proposal)).toContain(chat)
      expect(proposed.plan.steps.some((step) => step.kind === "session-move")).toBe(false)
      const applied = await setup.server.team("reorg.apply", { teamID: setup.teamID, proposalID: proposed.proposalID })
      const judged = await opEnd(setup.server, applied.opID)
      expect(judged.by).toBe("auto")
      expect(judged.steps.some((step) => step.kind === "session-move")).toBe(false)
      const row = required(rows(setup).find((item) => item.id === chat))
      expect(same(row.directory, setup.home)).toBe(true)
      expect(row.metadata[OwnTeam.MOVED_META]).toBeUndefined()
      await setup.server.team("area.pause", { teamID: setup.teamID, areaID: delta.id, on: false })
    },
    STEP_TIMEOUT,
  )

  test(
    "a running shell holds the area's safe point: the user's split waits, then goes on once the shell ended",
    async () => {
      const setup = required(state.setup)
      const delta = await areaOf(setup, "delta")
      const shell = await startShell(setup.server, delta.directory, 'bun -e "await Bun.sleep(600000)"')
      const opID = await apply(setup, [{ op: "split", area: "delta", slug: "delta-two", name: "델타 둘" }])
      await Bun.sleep(8_000)
      const waiting = (await setup.server.team("op.get", { opID })).op
      expect(waiting.state).toBe("running")
      expect(waiting.steps.find((step) => step.kind === "split-begin")?.state).toBe("pending")
      expect(branch(setup.home, "delta-two")).toBeUndefined()

      await stopShell(setup.server, delta.directory, shell)
      const op = await opEnd(setup.server, opID, { timeoutMs: STEP_TIMEOUT })
      expect(op.state).toBe("done")
      expect(branch(setup.home, "delta-two")).toBe(branch(setup.home, "delta"))
      const two = await areaOf(setup, "delta-two")
      expect(two.state).toBe("active")
      expect(two.owner.sessionID).not.toBeNull()
    },
    STEP_TIMEOUT,
  )

  test(
    "변환: code → full asks; full → code refuses untracked work in a leaving folder and deletes an ignored file only after the confirm",
    async () => {
      const setup = required(state.setup)
      const delta = await areaOf(setup, "delta")
      const before = required(delta.owner.sessionID ?? undefined)
      const full = await apply(setup, [{ op: "convert", area: "delta", shape: "full" }])
      // A confirm op asks first (`convert-confirm` holds the conversion back until `do`).
      const asked = await confirmOf(setup.server, full, Convert.ASK)
      // The dialog names the disk the heavy folders take (and the download, none here: no LFS).
      expect(asked.confirm.text).toContain("디스크")
      expect((await answer(setup.server, full, asked.step, "do")).status).toBe(200)
      expect((await opEnd(setup.server, full)).state).toBe("done")
      expect((await areaOf(setup, "delta")).shape).toBe("full")
      expect(sparse(delta.directory).enabled).toBe(false)
      expect(fs.existsSync(path.join(delta.directory, "Assets", "Textures", "rock.bin"))).toBe(true)

      // The owner works in the full folder before the conversion (4.14: its history must not span it).
      await setup.server.accounts("session.approval.set", { sessionID: before, mode: "full" }, delta.directory)
      await setup.server.turn(before, `[shell ${edit({ "notes.txt": "one" })}]`)
      expect(fs.readFileSync(path.join(delta.directory, "notes.txt"), "utf8")).toBe("one\n")

      write(delta.directory, { "Assets/Textures/mine.txt": "mine\n" })
      const refused = await setup.server.rpc(OwnTeam.ID, "reorg.apply", {
        teamID: setup.teamID,
        proposal: { version: 1, ops: [{ op: "convert", area: "delta", shape: "code" }] },
      })
      expect(refused).toMatchObject({ status: 400, type: "invalid_proposal" })
      expect(fs.readFileSync(path.join(delta.directory, "Assets", "Textures", "mine.txt"), "utf8")).toBe("mine\n")
      expect((await areaOf(setup, "delta")).shape).toBe("full")
      fs.rmSync(path.join(delta.directory, "Assets", "Textures", "mine.txt"))

      write(delta.directory, { "Assets/Textures/cache.log": "engine cache\n" })
      const code = await apply(setup, [{ op: "convert", area: "delta", shape: "code" }])
      const shown = await confirmOf(setup.server, code, Convert.ASK)
      expect((shown.confirm.files ?? []).some((file) => file.path.endsWith("cache.log"))).toBe(true)
      expect(fs.existsSync(path.join(delta.directory, "Assets", "Textures", "cache.log"))).toBe(true)
      expect((await answer(setup.server, code, shown.step, "do")).status).toBe(200)
      expect((await opEnd(setup.server, code)).state).toBe("done")
      const after = await areaOf(setup, "delta")
      expect(after.shape).toBe("code")
      expect(sparse(delta.directory).enabled).toBe(true)
      expect(fs.existsSync(path.join(delta.directory, "Assets", "Textures"))).toBe(false)
      expect(fs.readFileSync(path.join(delta.directory, "notes.txt"), "utf8")).toBe("one\n")
      // The owner conversation was replaced first (4.14).
      const owner = required(after.owner.sessionID ?? undefined)
      expect(owner).not.toBe(before)

      await setup.server.accounts("session.approval.set", { sessionID: owner, mode: "full" }, delta.directory)
      await setup.server.turn(owner, `[shell ${edit({ "notes.txt": "two" })}]`)
      const diff = await turnDiff(setup.server, owner, delta.directory)
      const deleted = diff.filter((item) => item.status === "deleted" && item.file.startsWith("Assets/"))
      console.log(
        `[TG19 record] own's conversion (owner replaced first): the new owner's first turn shows ${deleted.length} heavy files deleted; diff ${diff.length} files: ${diff
          .slice(0, 10)
          .map((item) => `${item.status} ${item.file}`)
          .join(", ")}`,
      )
      expect(diff.some((item) => item.file === "notes.txt")).toBe(true)
    },
    STEP_TIMEOUT,
  )

  test(
    "대화 옮기기 by the user: moved and marked; a revert to before the move is recorded; the undo moves it back",
    async () => {
      const setup = required(state.setup)
      const chat = required(state.chat)
      const alpha = await areaOf(setup, "alpha")
      await setup.server.accounts("session.approval.set", { sessionID: chat, mode: "full" }, setup.home)
      await setup.server.turn(chat, `[shell ${edit({ "chat-note.txt": "one" })}]`)
      const first = required((await messages(setup.server, chat)).find((message) => message.type === "user"))

      const opID = await apply(setup, [{ op: "move", sessionID: chat, area: "alpha" }])
      const op = await opEnd(setup.server, opID)
      expect(op.state).toBe("done")
      const moved = await waitValue(async () => {
        const row = rows(setup).find((item) => item.id === chat)
        return row && same(row.directory, alpha.directory) ? row : undefined
      }, "the conversation never moved")
      expect(moved.metadata[OwnTeam.MOVED_META]).toMatchObject({ to: alpha.directory })

      // 4.14: a revert restores from the snapshot store of the folder the conversation is in now.
      const staged = await setup.server.server.request("POST", `/api/session/${chat}/revert/stage`, {
        directory: alpha.directory,
        query: { "location[directory]": alpha.directory },
        body: { messageID: String(first.id), files: true },
      })
      const text = await staged.text()
      console.log(
        `[TG12 record] revert across a move: stage HTTP ${staged.status} ${text.slice(0, 160)}; chat-note.txt in the home: ${fs.existsSync(path.join(setup.home, "chat-note.txt"))}`,
      )
      if (staged.ok)
        await setup.server.server.request("DELETE", `/api/session/${chat}/revert`, {
          directory: alpha.directory,
          query: { "location[directory]": alpha.directory },
        })

      const undone = await setup.server.team("op.undo", { opID })
      expect((await opEnd(setup.server, undone.opID)).state).toBe("done")
      await until(async () => {
        const row = rows(setup).find((item) => item.id === chat)
        return row !== undefined && same(row.directory, setup.home)
      }, "the undo never moved the conversation back")
      fs.rmSync(path.join(setup.home, "chat-note.txt"), { force: true })
    },
    STEP_TIMEOUT,
  )

  test(
    "killed after each step of a split and restarted: one new area, branch, worktree and owner; A's work as it was",
    async () => {
      const setup = required(state.setup)
      const alpha = await areaOf(setup, "alpha")
      const work = snapshot(alpha.directory)
      const opID = await apply(setup, [{ op: "split", area: "alpha", slug: "alpha-two", name: "알파 둘" }])
      const kills = await killEachStep(setup.server, opID, new Set(["worktree-create", "session-create"]))
      const op = await opEnd(setup.server, opID, { timeoutMs: STEP_TIMEOUT })
      console.log(`[TG12 record] split killed after each step: ${kills} kills, op ${op.state}`)
      expect(op.state).toBe("done")
      expect(kills).toBeGreaterThan(0)
      const view = await setup.server.team("team.get", { directory: setup.home })
      const made = view.areas.filter((area) => slug(area.id) === "alpha-two")
      expect(made.map((area) => area.state)).toEqual(["active"])
      const two = required(made[0])
      expect(branch(setup.home, "alpha-two")).toBe(branch(setup.home, "alpha"))
      expect(worktrees(setup.home).filter((entry) => same(entry.path, two.directory))).toHaveLength(1)
      const owners = rows(setup).filter((row) => row.parentID === null && teamMeta(row)?.areaID === two.id)
      expect(owners.map((row) => row.id)).toEqual([required(two.owner.sessionID ?? undefined)])
      expect(snapshot(alpha.directory)).toEqual(work)
    },
    KILL_TIMEOUT,
  )

  test("no branch and no session was deleted", () => {
    const setup = required(state.setup)
    const branches = new Set(heads(setup.home))
    const sessions = new Set(rows(setup).map((row) => row.id))
    expect([...setup.seen.branches].filter((name) => !branches.has(name))).toEqual([])
    expect([...setup.seen.sessions].filter((id) => !sessions.has(id))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** The uncommitted work A keeps through a merge: an untracked file in the cone and one in a sparse (collapsed) folder. */
const WORK: Readonly<Record<string, string>> = {
  "src/alpha-notes.ts": "// alpha notes\n",
  "Assets/Textures/new-note.txt": "outside the cone\n",
}

/** F1 with `Assets/` as a heavy folder, ignore rules, and the links kept as copies + skip-worktree (FORK §11). */
function project(root: string) {
  const home = f1(root).home
  write(home, {
    ".gitignore": ["node_modules/", "build/", "vendor/", "*.log", ".env", ""].join("\n"),
    "Assets/Textures/rock.bin": crypto.getRandomValues(new Uint8Array(16_384)),
    "Assets/Textures/readme.txt": "texture notes\n",
  })
  commit(home, "a heavy folder and ignore rules")
  const exclude = path.join(home, ".git", "info", "exclude")
  for (const [link, target] of Object.entries(F1_LINKS)) {
    const file = path.join(home, ...link.split("/"))
    const source = path.resolve(path.dirname(file), target)
    fs.rmSync(file, { force: true })
    fs.cpSync(source, file, { recursive: true })
    if (fs.statSync(source).isDirectory()) fs.appendFileSync(exclude, `/${link}/\n`)
    git(home, ["update-index", "--skip-worktree", "--", link])
  }
  return home
}

/** `reorg.apply` with `ops` (by the user) once the team runs no other op. */
async function apply(setup: Setup, list: ReadonlyArray<OwnTeam.ReorgOp>) {
  await until(
    async () => (await setup.server.team("team.get", { directory: setup.home })).op === null,
    "a team op never ended",
    STEP_TIMEOUT,
  )
  return reorganize(setup.server, setup.teamID, list)
}

async function areaOf(setup: Setup, name: string) {
  const view = await setup.server.team("team.get", { directory: setup.home })
  return required(view.areas.find((area) => slug(area.id) === name))
}

async function teamOf(setup: Setup) {
  return required((await setup.server.team("team.get", { directory: setup.home })).team ?? undefined)
}

function rows(setup: Setup) {
  return sessionRows(db(setup))
}

/** Records every branch and session there is now (`seen`). */
function remember(setup: Setup) {
  for (const name of heads(setup.home)) setup.seen.branches.add(name)
  for (const row of rows(setup)) setup.seen.sessions.add(row.id)
}

function heads(home: string) {
  return git(home, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n").filter(Boolean)
}

/** A branch's tip, or `undefined` when there is no such branch. */
function branch(home: string, name: string) {
  const found = git(home, ["for-each-ref", "--format=%(objectname)", `refs/heads/${name}`]).trim()
  return found === "" ? undefined : found
}

/** The files of {@link WORK} and the edited link copy in a folder, with their content (`undefined`: missing). */
function snapshot(directory: string) {
  return Object.fromEntries(
    [...Object.keys(WORK), "README-link.md"].map((file) => {
      const at = path.join(directory, ...file.split("/"))
      return [file, fs.existsSync(at) ? fs.readFileSync(at, "utf8") : undefined]
    }),
  )
}

/** A shell command that writes `files` (path → one line) with Bun. */
function edit(files: Readonly<Record<string, string>>) {
  const writes = Object.entries(files).map(([file, text]) => `require('fs').writeFileSync('${file}','${text}\\n')`)
  return `bun -e "${writes.join(";")}"`
}

function db(setup: Setup) {
  return setup.server.server.paths.database
}

function slug(areaID: OwnTeam.AreaID) {
  return areaID.slice("ar_".length)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
