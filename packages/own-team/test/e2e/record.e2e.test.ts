// TG19 스냅샷 정합 (should, record only; 06 §4.14, §11.3) on a real server: what core's per-turn snapshot diff shows
// around own's cone changes. Nothing here fails on the observation itself; each run prints `[TG19 record]` lines for
// own/reports/team-t2-gates.md.
//
// - need_paths: in one owner turn a heavy folder comes in (`team_need_paths`) and a tracked file inside it and one in
//   the cone are changed. 4.14 (b) expects the change inside the fetched folder to be missing from the turn's diff.
// - Revert: the owner's conversation goes back to before that turn (staged with files, then cleared again).
// - Conversion: a full folder's conversation makes a change, the folder is made code-only (`sparse-checkout set`, as
//   a conversion does; the conversion itself is T3), then the next turn makes another change. 4.14 (a) expects the
//   files that left the disk to show as deleted.
//
// Fake credentials only; every listener binds 127.0.0.1. Run from a path without '#'.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { F2_HEAVY, f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { commit, git, write } from "../fixtures/repo.js"
import {
  BOOT_TIMEOUT,
  MODEL,
  enableTeam,
  messages,
  startTeamServer,
  turnDiff,
  type TeamServer,
  type TurnFile,
} from "./harness.js"

const STEP_TIMEOUT = 300_000
/** A tracked text file inside a heavy folder (the fixture adds it to F2). */
const INSIDE = "Assets/Textures/readme.txt"
/** A tracked file in the cone. */
const CONE = "src/app/main.ts"

interface Setup {
  readonly server: TeamServer
  readonly owner: string
  readonly folder: string
  /** A full linked worktree of the same repository and a plain conversation in it. */
  readonly full: string
  readonly conversation: string
}

describe.skipIf(!lfsAvailable)("TG19 record: core's turn diffs around need_paths and a conversion", () => {
  const state: { setup?: Setup } = {}

  beforeAll(async () => {
    const layout: { full?: string } = {}
    const server = await startTeamServer({
      name: "record",
      project: (root) => {
        const home = f2(root).home
        write(home, { [INSIDE]: "texture notes\n" })
        const head = commit(home, "a text file in a heavy folder")
        layout.full = path.join(root, "full-wt")
        git(home, ["worktree", "add", "-q", "-b", "full", layout.full, head])
        return home
      },
    })
    const viewed = await server.createSession({ title: "켠 대화", model: MODEL["01"] })
    const enabled = await enableTeam(server, {
      hint: `[propose-areas 1 +heavy=${F2_HEAVY.join(",")}]`,
      sessionID: viewed,
    })
    const area = required(enabled.view.areas[0])
    const owner = required(area.owner.sessionID ?? undefined)
    await server.accounts("session.approval.set", { sessionID: owner, mode: "full" }, area.directory)
    const full = required(layout.full)
    const conversation = await server.createSession({ title: "전체 폴더 대화", directory: full, model: MODEL["01"] })
    await server.accounts("session.approval.set", { sessionID: conversation, mode: "full" }, full)
    state.setup = { server, owner, folder: area.directory, full, conversation }
  }, BOOT_TIMEOUT)

  afterAll(async () => {
    await state.setup?.server.stop()
  }, 120_000)

  test(
    "need_paths and a change inside the fetched folder in one turn",
    async () => {
      const setup = required(state.setup)
      await setup.server.turn(
        setup.owner,
        `[need-paths Assets/Textures] [shell ${edit({ [INSIDE]: "texture notes, changed", [CONE]: "export const main = 2" })}]`,
      )
      const diff = await turnDiff(setup.server, setup.owner, setup.folder)
      const inside = diff.find((item) => item.file === INSIDE)
      record("need_paths", diff, {
        [`${INSIDE} (fetched folder, changed)`]: inside?.status ?? "missing",
        [`${CONE} (cone, changed)`]: diff.find((item) => item.file === CONE)?.status ?? "missing",
      })
      expect(diff.find((item) => item.file === CONE)?.status).toBe("modified")
    },
    STEP_TIMEOUT,
  )

  test(
    "revert to before that turn: what comes back in the cone and in the fetched folder",
    async () => {
      const setup = required(state.setup)
      const user = (await messages(setup.server, setup.owner)).findLast((message) => message.type === "user")
      const staged = await setup.server.server.request("POST", `/api/session/${setup.owner}/revert/stage`, {
        directory: setup.folder,
        query: { "location[directory]": setup.folder },
        body: { messageID: String(required(user).id), files: true },
      })
      const read = (file: string) => fs.readFileSync(path.join(setup.folder, ...file.split("/")), "utf8").trim()
      console.log(`[TG19 record] revert: stage answered HTTP ${staged.status}`)
      console.log(`[TG19 record] revert: ${CONE} (cone) after the revert: ${read(CONE)}`)
      console.log(`[TG19 record] revert: ${INSIDE} (fetched folder) after the revert: ${read(INSIDE)}`)
      const cleared = await setup.server.server.request("DELETE", `/api/session/${setup.owner}/revert`, {
        directory: setup.folder,
        query: { "location[directory]": setup.folder },
      })
      console.log(`[TG19 record] revert: clear answered HTTP ${cleared.status}; ${CONE} now: ${read(CONE)}`)
      expect(staged.status).toBe(200)
    },
    STEP_TIMEOUT,
  )

  test(
    "the first turn after a full folder becomes code-only",
    async () => {
      const setup = required(state.setup)
      await setup.server.turn(setup.conversation, `[shell ${edit({ "notes.txt": "one" })}]`)
      const before = await turnDiff(setup.server, setup.conversation, setup.full)
      expect(before.map((item) => item.file)).toContain("notes.txt")
      // What a conversion does to the folder (06 §8.2; own's conversion op is T3): the complement cone.
      git(setup.full, ["sparse-checkout", "set", "--cone", "--stdin"], {
        stdin: ["src", "docs", "-dash", "Assets/Scripts", ""].join("\n"),
      })
      await setup.server.turn(setup.conversation, `[shell ${edit({ "notes.txt": "two" })}]`)
      const after = await turnDiff(setup.server, setup.conversation, setup.full)
      const users = (await messages(setup.server, setup.conversation)).filter((message) => message.type === "user")
      const range =
        users.length >= 2
          ? await turnDiff(setup.server, setup.conversation, setup.full, {
              from: String(users.at(-2)?.id),
              to: String(users.at(-1)?.id),
            })
          : []
      const deleted = (files: ReadonlyArray<TurnFile>) =>
        files.filter((item) => item.status === "deleted" && F2_HEAVY.some((dir) => item.file.startsWith(`${dir}/`)))
      record("conversion", after, {
        "heavy files shown deleted (first turn after)": String(deleted(after).length),
        "heavy files shown deleted (both turns)": String(deleted(range).length),
      })
      expect(after.map((item) => item.file)).toContain("notes.txt")
    },
    STEP_TIMEOUT,
  )
})

// ---------------------------------------------------------------------------------------------------------------

/** A shell command that writes `files` (path → one line) with Bun. */
function edit(files: Readonly<Record<string, string>>) {
  const writes = Object.entries(files).map(([file, text]) => `require('fs').writeFileSync('${file}','${text}\\n')`)
  return `bun -e "${writes.join(";")}"`
}

/** One `[TG19 record]` line per observation, with the whole diff's file list. */
function record(scenario: string, diff: ReadonlyArray<TurnFile>, found: Readonly<Record<string, string>>) {
  for (const [what, value] of Object.entries(found)) console.log(`[TG19 record] ${scenario}: ${what}: ${value}`)
  console.log(
    `[TG19 record] ${scenario}: diff ${diff.length} files: ${diff
      .slice(0, 20)
      .map((item) => `${item.status} ${item.file}`)
      .join(", ")}`,
  )
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("e2e fixture was not started")
  return value
}
