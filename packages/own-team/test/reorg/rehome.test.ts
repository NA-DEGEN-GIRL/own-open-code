// 대화 옮기기 (06 §8.2, §4.14; TG12 pre-move revert record, TG19 record): only the user moves a conversation, only at
// a safe point (the conversation idle, the area at its extended safe point; the move waits for it and says why on the
// card, TI-9), never during a rebase or merge
// (`Inventory.operations`), never the team main or an owner; a conversation already there is a no-op; core's move is
// queued once and not again while a move waits in its inbox (the reconcile rule); `OwnTeam.MOVED_META {at, from, to}`
// is written for own-web's moved banner; undo moves it back. The reconcile fixture (a real repository with three
// areas, a fake own service on 127.0.0.1 whose `session.move` moves at once); fake values only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import type { Hub } from "../../src/hub.js"
import { Rehome } from "../../src/reorg/rehome.js"
import { type Fixture, OWNERS, areaID, setup } from "../fixtures/reconcile.js"
import { git, write } from "../fixtures/repo.js"
import { MAIN_SESSION, TEAM_ID } from "../support/context.js"

const SLOW = 120_000

describe("Rehome: the user moves a conversation into an area (06 §8.2)", () => {
  const state: { fixture?: Fixture } = {}
  const fixture = () => {
    if (!state.fixture) throw new Error("no fixture")
    return state.fixture
  }
  let count = 0

  beforeAll(async () => {
    state.fixture = await setup()
    // The home's Location is alive in this fixture: its shells and terminals are asked for (8.4), and there are none.
    state.fixture.backend.service.routes.set("GET /api/shell", () => Response.json({ data: [] }))
    state.fixture.backend.service.routes.set("GET /api/pty", () => Response.json({ data: [] }))
  }, SLOW)
  afterAll(async () => {
    await state.fixture?.close()
  })

  /** A conversation the user opened in `directory` (default: the home). */
  const conversation = (directory = fixture().home) => {
    const id = SessionID.make(`ses_user_${String(++count).padStart(22, "0")}`)
    fixture().backend.add(id, directory)
    return id
  }
  const start = (sessionID: SessionID, slug = "ui", by: OwnTeam.Op["by"] = "user") =>
    Rehome.start(fixture().services, { teamID: TEAM_ID, sessionID, areaID: areaID(slug), by })
  const settled = async (opID: OwnTeam.OpID) => {
    await fixture().services.runner.settled(opID)
    return (await fixture().services.journal.get(TEAM_ID, opID))!
  }
  /** An op of exactly these steps (what a reorganization op carries), bypassing {@link Rehome.start}'s checks. */
  const run = async (steps: ReadonlyArray<ReturnType<typeof Rehome.spec>>, by: OwnTeam.Op["by"] = "user") => {
    Rehome.register(fixture().services)
    const started = await fixture().services.runner.start({ teamID: TEAM_ID, kind: "reorg", by, steps: [...steps] })
    if (!started.ok) throw new Error("busy")
    return settled(started.op.id)
  }
  const moves = (sessionID: string) => fixture().backend.moves.filter((item) => item.sessionID === sessionID)

  test("only the user moves a conversation: main and auto are refused, and the step fails for them", async () => {
    const user = conversation()
    expect(await start(user, "ui", "main")).toMatchObject({ ok: false, error: "unsupported" })
    expect(await start(user, "ui", "auto")).toMatchObject({ ok: false, error: "unsupported" })

    const done = await run(
      [Rehome.spec({ sessionID: user, from: fixture().home, to: fixture().folders.ui, areaID: areaID("ui") })],
      "auto",
    )
    expect(done.state).toBe("failed")
    expect(done.steps[0]?.note).toContain("사용자만")
    expect(moves(user)).toEqual([])
  })

  test("the team main, an owner and a child conversation are never moved this way", async () => {
    expect(await start(MAIN_SESSION)).toMatchObject({ ok: false, error: "unsupported" })
    expect(await start(OWNERS.save)).toMatchObject({ ok: false, error: "unsupported" })
    const parent = conversation()
    const child = conversation()
    fixture().backend.service.routes.set(`GET /api/session/${child}`, () =>
      Response.json({
        data: {
          id: child,
          parentID: parent,
          projectID: "prj_test",
          location: { directory: fixture().home },
          time: { created: 1, updated: 1 },
          cost: 0,
          tokens: {},
        },
      }),
    )
    expect(await start(child)).toMatchObject({ ok: false, error: "unsupported" })
    expect(moves(MAIN_SESSION)).toEqual([])
    expect(moves(OWNERS.save)).toEqual([])
  })

  test("away from a safe point the move waits and says why (TI-9): queued input, then the area's owner runs", async () => {
    const f = fixture()
    const backend = f.backend
    const user = conversation()
    backend.inbox.set(user, [{ id: "inb_prompt", sessionID: user, type: "user", delivery: "queue", payload: {} }])
    backend.active.add(OWNERS.ui)
    const started = await start(user)
    if (!started.ok) throw new Error(started.message)
    const shown = async (text: string) => {
      const deadline = Date.now() + 10_000
      const seen = () =>
        f.published.some(
          (event) =>
            event.name === "op.progress" &&
            event.data.opID === started.opID &&
            event.data.state === "pending" &&
            event.data.text === text,
        )
      while (!seen()) {
        if (Date.now() > deadline) throw new Error(`not shown: ${text}`)
        await Bun.sleep(20)
      }
    }
    // A folder event makes the step look again (Settle.until), as core's events do.
    const wake = () =>
      f.controller.hub.receive({
        id: `evt_${Math.random()}`,
        created: 1,
        type: "session.execution.succeeded",
        data: { sessionID: OWNERS.ui },
      } as unknown as Hub.Incoming)
    await shown("대기열에 멈춘 요청이 있어 기다려요")
    backend.inbox.delete(user)
    wake()
    await shown("영역에서 대화가 일하는 중이라 기다려요")
    expect(moves(user)).toEqual([])
    expect((await f.services.journal.get(TEAM_ID, started.opID))?.state).toBe("running")
    backend.active.delete(OWNERS.ui)
    wake()
    const done = await settled(started.opID)
    expect(done.state).toBe("done")
    expect(moves(user)).toEqual([{ sessionID: user, directory: f.folders.ui, delivery: "queue" }])
  })

  test("a context reset or a passive notice waiting in the conversation's queue is no work: the move goes (06 §6.1)", async () => {
    const f = fixture()
    const user = conversation()
    f.backend.inbox.set(user, [
      { id: "inb_reset", sessionID: user, type: "reset", delivery: "queue", payload: {} },
      {
        id: "inb_notice",
        sessionID: user,
        type: "synthetic",
        delivery: "steer",
        payload: { text: "old job", beforeReset: "msg_reset" },
      },
    ])
    const started = await start(user)
    if (!started.ok) throw new Error(started.message)
    expect((await settled(started.opID)).state).toBe("done")
    expect(moves(user)).toEqual([{ sessionID: user, directory: f.folders.ui, delivery: "queue" }])
    f.backend.inbox.delete(user)
  })

  test("RH-34: a notice parked for the next prompt is no work; a prompt the user parked holds the move", async () => {
    const f = fixture()
    const parked = f.services.clock.now() - 60_000
    // own.harness' switch notice, admitted without a wake a minute ago: the move's wake delivers it.
    const notice = {
      id: "inb_switch",
      type: "synthetic",
      delivery: "steer",
      payload: { text: "Harness: codex → pi", metadata: { "own.harness": { switch: { from: "codex", to: "pi" } } } },
      time: { created: parked },
    }
    const switched = conversation()
    f.backend.inbox.set(switched, [{ ...notice, sessionID: switched }])
    const started = await start(switched)
    if (!started.ok) throw new Error(started.message)
    expect((await settled(started.opID)).state).toBe("done")
    expect(moves(switched)).toEqual([{ sessionID: switched, directory: f.folders.ui, delivery: "queue" }])
    f.backend.inbox.delete(switched)

    // A prompt left in the queue after the user stopped the conversation: the move's wake would run it first.
    const stopped = conversation()
    f.backend.inbox.set(stopped, [
      {
        id: "inb_stopped",
        sessionID: stopped,
        type: "user",
        delivery: "queue",
        payload: {},
        time: { created: parked },
      },
    ])
    const held = await start(stopped)
    if (!held.ok) throw new Error(held.message)
    const deadline = Date.now() + 10_000
    const waits = async () => (await f.services.journal.get(TEAM_ID, held.opID))?.steps[0]?.wait?.detail === "inbox"
    while (!(await waits())) {
      if (Date.now() > deadline) throw new Error("the move did not wait for the parked prompt")
      await Bun.sleep(20)
    }
    expect((await f.services.journal.get(TEAM_ID, held.opID))?.steps[0]?.wait?.actions).toEqual(["cancel"])
    expect(moves(stopped)).toEqual([])
    expect(await f.services.runner.cancel(held.opID)).toMatchObject({ ok: true, op: { state: "cancelled" } })
    f.backend.inbox.delete(stopped)
  })

  test("a conversation already in the folder is a no-op", async () => {
    const there = conversation(fixture().folders.ui)
    const started = await start(there)
    if (!started.ok) throw new Error(started.message)
    const done = await settled(started.opID)
    expect(done.state).toBe("done")
    expect(done.steps[0]).toMatchObject({ kind: Rehome.STEP, state: "done" })
    expect(moves(there)).toEqual([])
    expect(fixture().backend.sessions.get(there)?.metadata[OwnTeam.MOVED_META]).toBeUndefined()
  })

  test(
    "moved once at the safe point with MOVED_META {at, from, to}; not again while a move waits; undo moves it back",
    async () => {
      const f = fixture()
      const user = conversation()
      const started = await start(user)
      if (!started.ok) throw new Error(started.message)
      const done = await settled(started.opID)

      expect(done.state).toBe("done")
      expect(done.undo).toEqual({ available: true })
      expect(moves(user)).toEqual([{ sessionID: user, directory: f.folders.ui, delivery: "queue" }])
      const moved = f.backend.sessions.get(user)!
      expect(moved.directory).toBe(f.folders.ui)
      expect(moved.metadata[OwnTeam.MOVED_META]).toEqual({ at: f.services.clock.now(), from: f.home, to: f.folders.ui })

      // A move already waits in its inbox (queued before, not delivered yet): core's move is not idempotent.
      const waiting = conversation()
      f.backend.inbox.set(waiting, [
        { id: "inb_move", sessionID: waiting, type: "move", delivery: "queue", payload: {} },
      ])
      const again = await start(waiting)
      if (!again.ok) throw new Error(again.message)
      const second = await settled(again.opID)
      expect(second.steps[0]).toMatchObject({ state: "done", note: "옮기기가 대화의 대기열에서 기다려요" })
      expect(moves(waiting)).toEqual([])
      f.backend.inbox.delete(waiting)

      const back = Rehome.undo(done)
      expect(back).toEqual([
        { kind: Rehome.STEP, mode: "auto", args: { sessionID: user, from: f.folders.ui, to: f.home } },
      ])
      const undone = await run(back ?? [])
      expect(undone.state).toBe("done")
      expect(moves(user)).toEqual([
        { sessionID: user, directory: f.folders.ui, delivery: "queue" },
        { sessionID: user, directory: f.home, delivery: "queue" },
      ])
      expect(f.backend.sessions.get(user)?.directory).toBe(f.home)
      expect(f.backend.sessions.get(user)?.metadata[OwnTeam.MOVED_META]).toMatchObject({
        from: f.folders.ui,
        to: f.home,
      })
      expect(Rehome.undo({ ...done, steps: [] })).toBeUndefined()
    },
    SLOW,
  )

  test(
    "skipped while a merge is stopped half way in the area folder (Inventory.operations)",
    async () => {
      const f = fixture()
      const user = conversation()
      const gitDir = (await f.area("ui")).gitDir
      const marker = path.join(gitDir, "MERGE_HEAD")
      fs.writeFileSync(marker, `${f.git("ui", ["rev-parse", "HEAD"]).trim()}\n`)
      try {
        const done = await run([Rehome.spec({ sessionID: user, from: f.home, to: f.folders.ui, areaID: areaID("ui") })])
        expect(done.state).toBe("done")
        expect(done.steps[0]?.state).toBe("skipped")
        expect(done.summary?.lines).toContainEqual({
          kind: "skipped",
          item: Rehome.STEP,
          areaID: areaID("ui"),
          why: "busy",
        })
        expect(moves(user)).toEqual([])
        expect(f.notices().some((notice) => notice.kind === "reorg.skipped" && notice.data?.sessionID === user)).toBe(
          true,
        )
      } finally {
        fs.rmSync(marker, { force: true })
      }
    },
    SLOW,
  )

  test(
    "[TG19 record] a revert to a point before the move restores from the destination's snapshot store (emulated)",
    async () => {
      const f = fixture()
      const user = conversation()
      // core keeps one snapshot store per worktree; the conversation's pre-move turns wrote their trees into the home's.
      const home = store(f.home, path.join(f.root, "snap-home"))
      const ui = store(f.folders.ui, path.join(f.root, "snap-ui"))
      write(f.home, { "README.md": "# changed in the home before the move\n" })
      const before = home.capture()
      const started = await start(user)
      if (!started.ok) throw new Error(started.message)
      expect((await settled(started.opID)).state).toBe("done")
      const found = ui.has(before)
      console.log(
        `[TG19 record] revert across a move: the pre-move tree ${before.slice(0, 12)} is ${found ? "present" : "missing"} in the destination's store, so core's revert there ${found ? "could restore it" : "fails"}`,
      )
      expect(fs.existsSync(path.join(f.root, "snap-home", "objects", before.slice(0, 2), before.slice(2)))).toBe(true)
      git(f.home, ["checkout", "--", "README.md"])
    },
    SLOW,
  )
})

/**
 * core's per-worktree snapshot store (its own git dir, the repository's objects as alternates, the worktree's index
 * copied once), reduced to what the record needs: a capture (`add --all` of the worktree, `write-tree`) and whether a
 * tree is readable there. An emulation for the TG19 record only; the real server's record is the e2e suite's.
 */
function store(worktree: string, dir: string) {
  const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"]).trim()
  const commonDir = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
  git(path.dirname(dir), ["init", "-q", "--bare", dir])
  git(dir, ["config", "core.bare", "false"])
  fs.mkdirSync(path.join(dir, "objects", "info"), { recursive: true })
  fs.writeFileSync(path.join(dir, "objects", "info", "alternates"), `${path.join(commonDir, "objects")}\n`)
  fs.copyFileSync(path.join(gitDir, "index"), path.join(dir, "index"))
  const repo = (args: ReadonlyArray<string>) => git(worktree, [`--git-dir=${dir}`, `--work-tree=${worktree}`, ...args])
  return {
    capture: () => {
      repo(["add", "--all", "--sparse", "--", "."])
      return repo(["write-tree"]).trim()
    },
    has: (tree: string) =>
      Bun.spawnSync(["git", `--git-dir=${dir}`, "cat-file", "-e", `${tree}^{tree}`], { stdout: "pipe", stderr: "pipe" })
        .exitCode === 0,
  }
}
