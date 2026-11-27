// The heavy-folder list across a stop and on an SSH host (06 §4.4, §4.13; 2026-10-09). A `heavy` op the last
// controller left running is continued by the next one from what it observes (TI-11): the list is written once, the
// plain area converts, and a step whose effect is already there acts no second time. On an SSH host whose team did not
// use LFS when it was enabled, LFS that starts later gets the bundled filter at once (a `heavy` op with `lfs-remote`,
// G8), and without the tool on the host the main is told once instead. Remote mode is this process's `Git.useTools`
// over a temp OWN_HOME with a stub git-lfs; HOME and XDG_CONFIG_HOME point at temp folders and GIT_CONFIG_NOSYSTEM hides
// this PC's system filter. Fake plugin contexts, a manual clock, a fake own service on 127.0.0.1; fake values only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { Heavy } from "../../src/assets/heavy.js"
import { Worktree } from "../../src/git/worktree.js"
import { RemoteEnv } from "../../src/remote/env.js"
import { commit, git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"
import { start } from "../support/service.js"

const SLOW = 240_000
const WINDOWS = process.platform === "win32"
const VERSION = "3.8.0"

const box = temp("own-team-t4-heavy-")
afterAll(() => box.dispose())

describe("a `heavy` op left running by a stopped controller (TI-11)", () => {
  const home = init(path.join(box.root, "resume", "home"))
  write(home, { "README.md": "# resume\n", "src/main.ts": "export const main = 1\n" })
  const base = commit(home, "base")
  write(home, {
    "Assets/Textures/rock.bin": Uint8Array.from({ length: 30_000 }, (_, index) => (index === 0 ? 0 : index % 251)),
  })
  const grown = commit(home, "assets")
  const world = new World()
  const service = start()
  afterAll(() => service.stop())
  const record: OwnTeam.Team = {
    ...team({ home }),
    heavy: { dirs: [], measuredAt: base, forcedBytes: 0 },
    policy: { ...OwnTeam.POLICY, askDiskBytes: 20_000 },
  }

  test(
    "the next controller continues it: the list once, the plain area code-only, no second notice",
    async () => {
      const directory = path.join(box.root, "resume", "team", "ui")
      const made = await Worktree.create(
        { home, directory, branch: "ui", base, areaID: "ar_ui", shape: "plain", cone: [], heavy: [] },
        { askDownloadBytes: Number.POSITIVE_INFINITY },
      )
      if (!made.ok || made.state !== "ready") throw new Error(JSON.stringify(made))
      const ui: OwnTeam.Area = { ...area({ slug: "ui", directory }), shape: "plain", gitDir: made.gitDir }
      // What the stopped controller left: the op written, its first step done (the list grew), the rest pending.
      const op: OwnTeam.Op = {
        id: OwnTeam.OpID.create(),
        teamID: TEAM_ID,
        kind: "heavy",
        by: "auto",
        state: "running",
        createdAt: 1,
        undo: { available: true },
        steps: [
          {
            id: "heavy:grow",
            kind: Heavy.KIND.grow,
            args: {
              rev: grown,
              target: true,
              added: ["Assets/Textures"],
              vanished: [],
              forcedBytes: 0,
              bytes: 30_000,
              previous: { dirs: [], measuredAt: base, forcedBytes: 0 },
            },
            mode: "auto",
            state: "pending",
          },
          { id: "heavy:areas", kind: Heavy.KIND.areas, args: { grew: true }, mode: "auto", state: "pending" },
        ],
      }
      const first = controller(world, {
        directory: box.root,
        clock: manual(),
        source: service.source,
        features: { safePoint: () => ({ check: async () => ({ ok: true }) }) },
      })
      // Its own start looked at nothing (no records yet); then the records of the stop are written.
      await first.controller.resume()
      // The list was written before the stop: the grow step observes it and does not act (no notice) on resume.
      await first.services.write(TEAM_ID, async () => {
        await first.services.registry.teams.put({
          ...record,
          heavy: { dirs: ["Assets/Textures"], measuredAt: grown, forcedBytes: 0 },
        })
        await first.services.registry.areas.put(ui)
        await first.services.journal.put(op)
      })
      await first.close()

      const next = controller(world, {
        directory: box.root,
        clock: manual(),
        source: service.source,
        features: { safePoint: () => ({ check: async () => ({ ok: true }) }) },
      })
      await until(async () => (await next.services.journal.get(TEAM_ID, op.id))?.state === "done")
      const ended = await next.services.journal.get(TEAM_ID, op.id)
      expect(ended?.steps.map((step) => [step.kind, step.state])).toEqual([
        [Heavy.KIND.grow, "done"],
        [Heavy.KIND.areas, "done"],
        ["convert-to-code", "done"],
      ])
      expect((await next.services.registry.areas.get(TEAM_ID, ui.id))?.shape).toBe("code")
      expect(next.published.some((event) => event.name === "notice" && event.data.kind === "heavy.grew")).toBe(false)
      // The resumed controller's own look finds nothing more to do for this commit.
      await next.services.features().heavy.check(TEAM_ID)
      expect((await next.services.journal.list(TEAM_ID)).filter((item) => item.kind === "heavy")).toHaveLength(1)
      expect(head(home)).toBe(grown)
      await next.close()
    },
    SLOW,
  )
})

describe("06 §4.13 G8: LFS that starts after enable on an SSH host", () => {
  const USER = path.join(box.root, "user")
  const XDG = path.join(box.root, "xdg")
  const SAVED = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  }
  beforeAll(() => {
    write(USER, { ".gitconfig": "[user]\n\tname = global fixture\n" })
    write(XDG, { "git/config": "[core]\n\teditor = true\n" })
    process.env.HOME = USER
    process.env.XDG_CONFIG_HOME = XDG
    process.env.GIT_CONFIG_NOSYSTEM = "1"
  })
  afterAll(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  let count = 0
  /** A repository without LFS at enable; then an owner's commit starts using it (a pointer as a plain blob). */
  function repository() {
    const home = init(path.join(box.root, `lfs${++count}`, "home"))
    write(home, { "README.md": "# remote\n", "src/app.ts": "export const app = 1\n" })
    commit(home, "base")
    write(home, {
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      "assets/model.bin": `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`,
    })
    return { home, tip: commit(home, "lfs starts") }
  }

  /** A temp OWN_HOME; with `tool`, a stub git-lfs in tools/git-lfs/<ver>/ and `current` pointing at that folder. */
  function ownHome(input: { readonly tool: boolean }) {
    const own = path.join(box.root, `own${++count}`)
    fs.mkdirSync(own, { recursive: true })
    if (!input.tool) return own
    const dir = path.join(own, "tools", "git-lfs", VERSION)
    write(dir, { "git-lfs": `#!/bin/sh\necho "git-lfs/${VERSION} (GitHub; linux amd64; stub)"\n` })
    fs.chmodSync(path.join(dir, "git-lfs"), 0o755)
    if (WINDOWS) write(dir, { "git-lfs.cmd": `@echo git-lfs/${VERSION} (GitHub; windows amd64; stub)\r\n` })
    fs.symlinkSync(WINDOWS ? dir : VERSION, RemoteEnv.tools(own), WINDOWS ? "junction" : "dir")
    return own
  }

  function boot(own: string, home: string, tip: string) {
    const world = new World()
    const service = start()
    const leave = RemoteEnv.enter(own)
    const h = controller(world, {
      directory: home,
      home: own,
      clock: manual(),
      source: service.source,
      features: { safePoint: () => ({ check: async () => ({ ok: true }) }) },
    })
    const record: OwnTeam.Team = {
      ...team({ home }),
      heavy: { dirs: [], measuredAt: tip, forcedBytes: 0 },
      env: { symlinkFix: "none", bunCache: "unused", lfs: "unused" },
    }
    return {
      ...h,
      world,
      record,
      stop: async () => {
        await h.close()
        leave()
        await service.stop()
      },
    }
  }

  test(
    "with the bundled tool: a `heavy` op makes it the repository's filter (`env.lfs` own, `lfs.installed`)",
    async () => {
      const repo = repository()
      const h = boot(ownHome({ tool: true }), repo.home, repo.tip)
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(h.record))
      await h.services.features().heavy.check(TEAM_ID)
      const op = (await h.services.journal.list(TEAM_ID)).find((item) => item.kind === "heavy")
      if (!op) throw new Error("no heavy op")
      await until(async () => (await h.services.journal.get(TEAM_ID, op.id))?.state === "done")
      const ended = await h.services.journal.get(TEAM_ID, op.id)
      expect(ended?.steps.map((step) => [step.kind, step.state])).toEqual([["lfs-remote", "done"]])
      expect(ended?.undo).toMatchObject({ available: false })
      expect((await h.services.registry.teams.get(TEAM_ID))?.env.lfs).toBe("own")
      expect(h.published.some((event) => event.name === "notice" && event.data.kind === "lfs.installed")).toBe(true)
      expect(git(repo.home, ["config", "--local", "--get", "filter.lfs.process"])).toContain("git-lfs")
      // Once set, nothing more is planned.
      await h.services.features().heavy.check(TEAM_ID)
      expect((await h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "heavy")).toHaveLength(1)
      await h.stop()
    },
    SLOW,
  )

  test(
    "without it: no op, and the main is told once in its next team update",
    async () => {
      const repo = repository()
      const h = boot(ownHome({ tool: false }), repo.home, repo.tip)
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(h.record))
      await h.services.features().heavy.check(TEAM_ID)
      await h.services.features().heavy.check(TEAM_ID)
      expect((await h.services.journal.list(TEAM_ID)).filter((item) => item.kind === "heavy")).toEqual([])
      const digest = JSON.stringify(h.world.kv.get(`digest:${TEAM_ID}`) ?? null)
      expect(digest.split("git-lfs").length - 1).toBe(1)
      expect((await h.services.registry.teams.get(TEAM_ID))?.env.lfs).toBe("unused")
      await h.stop()
    },
    SLOW,
  )
})

async function until(check: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(25)
  }
}
