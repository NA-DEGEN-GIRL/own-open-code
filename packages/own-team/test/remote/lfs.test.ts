// lfs-remote (06 §3.6, §4.13, TG17 local-filter, ordering and ~/.gitconfig parts): the bundled git-lfs of an SSH host
// becomes the repository's local LFS filter by its absolute path. A stub git-lfs sits under a temp
// OWN_HOME/tools/git-lfs/<ver>/ with `current` pointing at it (a junction on Windows, a symlink elsewhere, like the
// host's). HOME and XDG_CONFIG_HOME point at temp folders and GIT_CONFIG_NOSYSTEM hides this PC's system filter, so
// the only filter git sees is the one the step writes, and the global config files can be compared byte for byte.
// LFS repositories are pointer files under `filter=lfs` attributes; no real git-lfs runs and nothing leaves the
// temp folder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Lfs } from "../../src/git/lfs.js"
import { Git } from "../../src/git/run.js"
import type { Steps } from "../../src/ops/steps.js"
import { RemoteEnv } from "../../src/remote/env.js"
import { RemoteLfs } from "../../src/remote/lfs.js"
import { Controller } from "../../src/controller.js"
import { Log } from "../../src/log.js"
import { ServiceTarget } from "@own/runtime"
import { git, init, temp, write } from "../fixtures/repo.js"
import { lfsAvailable } from "../fixtures/lfs-repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, buildId, controller, team } from "../support/context.js"

const box = temp("own-team-lfs-remote-")
const WINDOWS = process.platform === "win32"
const VERSION = "3.8.0"
/** Git process starts are slow on Windows. */
const SLOW = 120_000

const USER = path.join(box.root, "user")
const XDG = path.join(box.root, "xdg")
const GLOBAL_FILES = [path.join(USER, ".gitconfig"), path.join(XDG, "git", "config")]
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
  box.dispose()
})

const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 12345\n`

let count = 0

/** A repository whose `assets/*.bin` are LFS pointers (committed without any filter configured). */
function lfsRepo() {
  const home = init(path.join(box.root, `r${++count}`, "home"))
  write(home, {
    ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    "README.md": "# lfs\n",
    "assets/model.bin": POINTER,
  })
  git(home, ["add", "-A"])
  git(home, ["commit", "-q", "-m", "lfs"])
  return home
}

function plainRepo() {
  const home = init(path.join(box.root, `r${++count}`, "home"))
  write(home, { "README.md": "# plain\n" })
  git(home, ["add", "-A"])
  git(home, ["commit", "-q", "-m", "plain"])
  return home
}

/** A temp OWN_HOME; with `tool`, a stub git-lfs in tools/git-lfs/<ver>/ and `current` pointing at that folder. */
function ownHome(input: { readonly tool: boolean }) {
  const home = path.join(box.root, `own${++count}`)
  fs.mkdirSync(home, { recursive: true })
  if (!input.tool) return home
  const dir = path.join(home, "tools", "git-lfs", VERSION)
  write(dir, { "git-lfs": `#!/bin/sh\necho "git-lfs/${VERSION} (GitHub; linux amd64; stub)"\n` })
  fs.chmodSync(path.join(dir, "git-lfs"), 0o755)
  if (WINDOWS) write(dir, { "git-lfs.cmd": `@echo git-lfs/${VERSION} (GitHub; windows amd64; stub)\r\n` })
  fs.symlinkSync(WINDOWS ? dir : VERSION, RemoteEnv.tools(home), WINDOWS ? "junction" : "dir")
  return home
}

function harness(home: string) {
  const h = controller(new World(), { directory: box.root, clock: manual(), home })
  RemoteLfs.register(h.services)
  return h
}

type Harness = ReturnType<typeof harness>

async function put(h: Harness, home: string, lfs: OwnTeam.Team["env"]["lfs"]) {
  const record = team({ home })
  await h.services.write(TEAM_ID, () => h.services.registry.teams.put({ ...record, env: { ...record.env, lfs } }))
}

async function run(h: Harness, steps: ReadonlyArray<Steps.Spec>) {
  const started = await h.services.runner.start({ teamID: TEAM_ID, kind: "enable", by: "user", steps })
  if (!started.ok) throw new Error("busy")
  await h.services.runner.settled(started.op.id)
  const op = (await h.services.journal.get(TEAM_ID, started.op.id))!
  return { op, step: op.steps[0]! }
}

function installedNotices(h: Harness) {
  return h.published.filter((event) => event.name === "notice" && event.data.kind === "lfs.installed")
}

/** `git config --file <common dir>/config --get <key>`, or `null` when unset. */
function local(home: string, key: string) {
  const result = Bun.spawnSync(["git", "config", "--file", path.join(home, ".git", "config"), "--get", key], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function globals() {
  return GLOBAL_FILES.map((file) => fs.readFileSync(file))
}

function addWorktree(home: string, directory: string) {
  return Git.run(["worktree", "add", "--no-checkout", "--detach", directory, "HEAD"], {
    cwd: home,
    write: true,
    worktree: true,
  })
}

describe("lfs-remote", () => {
  test(
    "an LFS repository without the bundled git-lfs: plan answers lfs_missing, the step fails and writes nothing",
    async () => {
      const own = ownHome({ tool: false })
      const repo = lfsRepo()
      expect(await RemoteLfs.plan({ directory: repo, home: own })).toMatchObject({
        ok: false,
        error: "lfs_missing",
        data: { tool: "git-lfs", version: null },
      })
      const h = harness(own)
      try {
        const ran = await run(h, [RemoteLfs.spec({ directory: repo })])
        expect(ran.op.state).toBe("failed")
        expect(ran.step).toMatchObject({ kind: RemoteLfs.KIND, state: "failed" })
        expect(ran.step.note).toContain("git-lfs")
        expect(local(repo, "filter.lfs.process")).toBeNull()
        expect(installedNotices(h)).toHaveLength(0)
        expect(await Lfs.env(repo, RemoteEnv.tools(own))).toEqual({ ok: true, lfs: "missing" })
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "with the tool: the filter goes to <common dir>/config by absolute path, every worktree sees it, the user's config files stay byte-identical",
    async () => {
      const own = ownHome({ tool: true })
      const repo = lfsRepo()
      const linked = path.join(path.dirname(repo), "linked")
      git(repo, ["worktree", "add", "-q", "--detach", linked, "HEAD"])
      const tools = RemoteEnv.tools(own)
      expect(tools).toBe(path.join(own, "tools", "git-lfs", "current"))
      const before = globals()
      const homeFiles = fs.readdirSync(USER).toSorted()
      expect(await RemoteLfs.plan({ directory: repo, home: own })).toEqual({
        ok: true,
        steps: [{ kind: RemoteLfs.KIND, mode: "auto", args: { directory: repo } }],
      })

      const h = harness(own)
      try {
        await put(h, repo, "missing")
        const ran = await run(h, [RemoteLfs.spec({ directory: repo })])
        expect(ran.op.state).toBe("done")
        expect(ran.step).toMatchObject({ state: "done", note: `git-lfs ${VERSION}` })

        const filter = Lfs.filter(tools)
        const exe = path.join(tools, "git-lfs")
        expect(filter).toEqual({
          "filter.lfs.process": `'${exe}' filter-process`,
          "filter.lfs.smudge": `'${exe}' smudge -- %f`,
          "filter.lfs.clean": `'${exe}' clean -- %f`,
          "filter.lfs.required": "true",
        })
        for (const [key, value] of Object.entries(filter)) expect(local(repo, key)).toBe(value)
        expect(git(linked, ["config", "--get", "filter.lfs.process"]).trim()).toBe(filter["filter.lfs.process"])
        expect(await Lfs.configured(repo, tools)).toEqual({ ok: true, configured: true })

        // Nothing outside the repository: the global and XDG files are unchanged and no file appeared in HOME.
        expect(globals()).toEqual(before)
        expect(fs.readdirSync(USER).toSorted()).toEqual(homeFiles)

        expect((await h.services.registry.teams.get(TEAM_ID))?.env.lfs).toBe("own")
        expect(installedNotices(h).map((event) => event.data)).toEqual([
          expect.objectContaining({ teamID: TEAM_ID, kind: "lfs.installed", data: { version: VERSION } }),
        ])
        expect(await Lfs.env(repo, tools)).toEqual({ ok: true, lfs: "own" })
        expect(await RemoteLfs.plan({ directory: repo, home: own })).toEqual({ ok: true, steps: [] })

        // Again (a resume): observed as done, no second notice.
        const again = await run(h, [RemoteLfs.spec({ directory: repo })])
        expect(again.step).toMatchObject({ state: "done", note: `git-lfs ${VERSION}` })
        expect(installedNotices(h)).toHaveLength(1)
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "a configured filter whose tool is gone: plan answers lfs_missing and the step fails before done",
    async () => {
      const own = ownHome({ tool: true })
      const repo = lfsRepo()
      const h = harness(own)
      try {
        expect((await run(h, [RemoteLfs.spec({ directory: repo })])).step.state).toBe("done")
        const version = path.join(own, "tools", "git-lfs", VERSION)
        fs.renameSync(version, `${version}.old`)
        expect(await RemoteLfs.plan({ directory: repo, home: own })).toMatchObject({ ok: false, error: "lfs_missing" })
        const ran = await run(h, [RemoteLfs.spec({ directory: repo })])
        expect(ran.step.state).toBe("failed")
        expect(ran.step.note).toContain("git-lfs")
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "a repository without LFS: nothing is planned, the step is skipped and writes nothing",
    async () => {
      const own = ownHome({ tool: true })
      const repo = plainRepo()
      expect(await RemoteLfs.plan({ directory: repo, home: own })).toEqual({ ok: true, steps: [] })
      const h = harness(own)
      try {
        const ran = await run(h, [RemoteLfs.spec({ directory: repo })])
        expect(ran.op.state).toBe("done")
        expect(ran.step).toMatchObject({ state: "skipped", note: "이 저장소는 큰 파일 도구를 쓰지 않아요" })
        expect(local(repo, "filter.lfs.process")).toBeNull()
        expect(installedNotices(h)).toHaveLength(0)
        expect(await Lfs.env(repo, RemoteEnv.tools(own))).toEqual({ ok: true, lfs: "unused" })
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "remote mode refuses worktree creation in an LFS repository until lfs-remote is done; this PC's mode does not",
    async () => {
      const own = ownHome({ tool: true })
      const repo = lfsRepo()
      const plain = plainRepo()
      const h = harness(own)
      const leave = RemoteEnv.enter(own)
      try {
        const early = path.join(path.dirname(repo), "early")
        expect(await addWorktree(repo, early)).toMatchObject({ ok: false, reason: "refused", message: Git.LFS_FILTER })
        expect(fs.existsSync(early)).toBe(false)
        expect((await addWorktree(plain, path.join(path.dirname(plain), "side"))).ok).toBe(true)

        expect((await run(h, [RemoteLfs.spec({ directory: repo })])).step.state).toBe("done")
        const late = path.join(path.dirname(repo), "late")
        expect((await addWorktree(repo, late)).ok).toBe(true)
        expect(git(late, ["config", "--get", "filter.lfs.process"]).trim()).toBe(
          Lfs.filter(RemoteEnv.tools(own))["filter.lfs.process"],
        )
      } finally {
        leave()
        await h.close()
      }
      const other = lfsRepo()
      expect((await addWorktree(other, path.join(path.dirname(other), "local"))).ok).toBe(true)
    },
    SLOW,
  )

  test(
    "the filter values it replaces are kept and come back with lfs-restore; the repository is listed for uninstall",
    async () => {
      const own = ownHome({ tool: true })
      const repo = lfsRepo()
      // The user's own repo-local filter before own's (another git-lfs install), without `required`.
      git(repo, ["config", "--local", "filter.lfs.process", "git-lfs filter-process"])
      git(repo, ["config", "--local", "filter.lfs.smudge", "git-lfs smudge -- %f"])
      const h = harness(own)
      try {
        expect((await run(h, [RemoteLfs.spec({ directory: repo })])).step.state).toBe("done")
        const tools = RemoteEnv.tools(own)
        expect(local(repo, "filter.lfs.process")).toBe(Lfs.filter(tools)["filter.lfs.process"])
        expect(local(repo, `${Lfs.SAVED}.process`)).toBe("git-lfs filter-process")
        expect(local(repo, `${Lfs.SAVED}.smudge`)).toBe("git-lfs smudge -- %f")
        expect(local(repo, `${Lfs.SAVED}.required`)).toBeNull()
        expect(local(repo, `${Lfs.SAVED}.saved`)).toBe("true")
        const common = path.resolve(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())
        const listed = () =>
          fs
            .readFileSync(RemoteEnv.repos(own), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => path.resolve(line))
        expect(listed()).toEqual([common])
        // A second lfs-remote (a resume, a new area) keeps the first record, not own's values.
        git(repo, ["config", "--local", "--remove-section", "filter.lfs"])
        expect((await run(h, [RemoteLfs.spec({ directory: repo })])).step.state).toBe("done")
        expect(local(repo, `${Lfs.SAVED}.process`)).toBe("git-lfs filter-process")

        const restored = await run(h, [RemoteLfs.restoreSpec({ directory: repo })])
        expect(restored.step).toMatchObject({ kind: RemoteLfs.RESTORE, state: "done" })
        expect(local(repo, "filter.lfs.process")).toBe("git-lfs filter-process")
        expect(local(repo, "filter.lfs.smudge")).toBe("git-lfs smudge -- %f")
        expect(local(repo, "filter.lfs.clean")).toBeNull()
        expect(local(repo, "filter.lfs.required")).toBeNull()
        expect(local(repo, `${Lfs.SAVED}.saved`)).toBeNull()
        expect(listed()).toEqual([])
        // Again: nothing left to restore.
        expect((await run(h, [RemoteLfs.restoreSpec({ directory: repo })])).step.state).toBe("done")
        expect(local(repo, "filter.lfs.process")).toBe("git-lfs filter-process")

        // A filter someone changed since is left as it is; own's record goes.
        expect((await run(h, [RemoteLfs.spec({ directory: repo })])).step.state).toBe("done")
        git(repo, ["config", "--local", "filter.lfs.process", "their-lfs filter-process"])
        expect((await run(h, [RemoteLfs.restoreSpec({ directory: repo })])).step.state).toBe("done")
        expect(local(repo, "filter.lfs.process")).toBe("their-lfs filter-process")
        expect(local(repo, `${Lfs.SAVED}.saved`)).toBeNull()
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "the controller holds remote mode while it lives, after the instance that made it left (module copies, 06 §2.6)",
    async () => {
      const own = ownHome({ tool: true })
      const tools = RemoteEnv.tools(own)
      // The creating instance's own remote mode, as plugin setup enters it, and the controller it makes.
      const leave = RemoteEnv.enter(own)
      const made = new Controller.Service({
        buildId: buildId("remote-mode"),
        home: own,
        log: Log.silent,
        clock: manual(),
        source: ServiceTarget.fixed({ url: "http://127.0.0.1:9", password: "fake-password-unused" }),
        tools,
      })
      try {
        // That instance's Location goes away while another instance keeps the controller.
        leave()
        expect(Git.tools()).toBe(tools)
        expect(RemoteEnv.mode()).toBe("remote")
        const repo = lfsRepo()
        expect(await addWorktree(repo, path.join(path.dirname(repo), "still-refused"))).toMatchObject({
          ok: false,
          reason: "refused",
          message: Git.LFS_FILTER,
        })
        expect(Git.environment({ cwd: repo }).PATH ?? Git.environment({ cwd: repo }).Path).toStartWith(tools)
      } finally {
        await made.close()
      }
      expect(Git.tools()).toBeUndefined()
    },
    SLOW,
  )

  test(
    "Team.env.lfs on this PC: without a filter, system when git-lfs answers, else missing",
    async () => {
      const repo = lfsRepo()
      expect(await Lfs.env(repo)).toEqual({ ok: true, lfs: lfsAvailable ? "system" : "missing" })
      expect(await Lfs.env(plainRepo())).toEqual({ ok: true, lfs: "unused" })
    },
    SLOW,
  )
})
