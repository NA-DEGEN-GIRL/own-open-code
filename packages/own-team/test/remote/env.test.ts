// Remote team mode (06 §2.6 guard, §4.3, §4.13; 04 §5.3, §6.4): own's git calls get `<OWN_HOME>/tools/git-lfs/current`
// first on PATH on top of the 06 §4.3 environment, with no filter injected through GIT_CONFIG_*; the plugin loads in
// full with OWN_REMOTE=1 and `{mode: "remote", home}`; and its self-HTTP reads the host's registration file of the
// channel `own`. Fake contexts, the real @own/runtime on a temp OWN_HOME, a fake loopback service and fake
// registration files; nothing here reads this PC's accounts or its real service registration.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnTeam } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { Git } from "../../src/git/run.js"
import { RemoteEnv } from "../../src/remote/env.js"
import { Singleton } from "../../src/singleton.js"
import { f1, temp, write } from "../fixtures/repo.js"
import { boot, buildId, call, managedEnv, tempHome, World } from "../support/context.js"
import { start } from "../support/service.js"

const box = temp("own-team-remote-env-")
afterAll(() => box.dispose())

const SLOW = 120_000

/** The `PATH` value of an environment, whatever its spelling (`Path` on Windows); exactly one such key. */
function searchPath(env: Readonly<Record<string, string | undefined>>) {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH")
  expect(keys).toHaveLength(1)
  return env[keys[0]!]
}

describe("own's git in remote mode", () => {
  test("PATH starts with <OWN_HOME>/tools/git-lfs/current, on top of the 06 §4.3 environment, until it leaves", () => {
    const repo = f1(path.join(box.root, "path"))
    const home = path.join(box.root, "own-path")
    const tools = RemoteEnv.tools(home)
    expect(tools).toBe(path.join(home, "tools", "git-lfs", "current"))
    const local = Git.environment({ cwd: repo.home, worktree: true })
    expect(Git.tools()).toBeUndefined()
    expect(RemoteEnv.mode()).toBe("local")

    const leave = RemoteEnv.enter(home)
    const again = RemoteEnv.enter(home)
    try {
      expect(Git.tools()).toBe(tools)
      expect(RemoteEnv.mode()).toBe("remote")
      const read = Git.environment({ cwd: repo.home, worktree: true })
      expect(searchPath(read)).toBe(`${tools}${path.delimiter}${searchPath(local)}`)
      expect(read).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CEILING_DIRECTORIES: path.dirname(repo.home),
      })
      // The filter lives in the repository's config, never in the environment (06 §4.13, [R-review] e9).
      expect(Object.keys(read).filter((key) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)/.test(key))).toEqual([])
      const written = Git.environment({ cwd: repo.home, write: true, env: { GIT_INDEX_FILE: "x" } })
      expect(searchPath(written)?.startsWith(`${tools}${path.delimiter}`)).toBe(true)
      expect(written.GIT_OPTIONAL_LOCKS).toBeUndefined()
      expect(written.GIT_INDEX_FILE).toBe("x")

      // Every instance of the service enters; one leaving keeps the others' setting, and leaving twice is harmless.
      leave()
      leave()
      expect(Git.tools()).toBe(tools)
    } finally {
      again()
      leave()
    }
    expect(Git.tools()).toBeUndefined()
    expect(RemoteEnv.mode()).toBe("local")
    expect(searchPath(Git.environment({ cwd: repo.home, worktree: true }))).toBe(searchPath(local))
  })

  // Git for Windows puts its own mingw64/bin (ucrt64/bin from 2.56, with its git-lfs) before PATH, so which git-lfs
  // `git lfs` runs is a Linux question; dev-host runs it in the real-host suite (T3.17).
  test.skipIf(process.platform === "win32")(
    "`git lfs version` and the `git lfs push` of integration.push.execute run the bundled git-lfs",
    async () => {
      const repo = f1(path.join(box.root, "push"))
      const home = path.join(box.root, "own-push")
      const log = path.join(box.root, "git-lfs.log")
      const dir = path.join(home, "tools", "git-lfs", "3.8.0")
      write(dir, {
        "git-lfs": [
          "#!/bin/sh",
          `printf '%s\\n' "$*" >> '${log}'`,
          `[ "$1" = version ] && echo 'git-lfs/3.8.0 (GitHub; linux amd64; stub)'`,
          "exit 0",
          "",
        ].join("\n"),
      })
      fs.chmodSync(path.join(dir, "git-lfs"), 0o755)
      fs.symlinkSync("3.8.0", RemoteEnv.tools(home))
      const leave = RemoteEnv.enter(home)
      try {
        const version = await Git.run(["lfs", "version"])
        expect(version.ok && version.stdout).toContain("git-lfs/3.8.0 (GitHub; linux amd64; stub)")
        // The command `integrate/push.ts` runs before `git push` (7.5).
        const pushed = await Git.run(["-c", "core.askPass=", "lfs", "push", "origin", "main"], {
          cwd: repo.home,
          write: true,
          worktree: true,
        })
        expect(pushed.ok).toBe(true)
        expect(fs.readFileSync(log, "utf8").split("\n")).toEqual(["version", "push origin main", ""])
      } finally {
        leave()
      }
    },
    SLOW,
  )
})

describe("the plugin on a remote service", () => {
  test(
    "loads in full with OWN_REMOTE=1 and {mode: 'remote', home}; self-HTTP reads the host's registration file",
    async () => {
      await using home = await tempHome()
      const service = start()
      const state = path.join(home.root, "xdg-state")
      // 04 §5.3: `<XDG_STATE_HOME>/opencode/service-own.json`, the registration of the channel `own`.
      const registration = ServiceTarget.registrationPath("own", { XDG_STATE_HOME: state })
      expect(registration).toBe(path.join(state, "opencode", "service-own.json"))
      write(path.dirname(registration), {
        "service-own.json": JSON.stringify({
          id: "fake",
          version: "local",
          url: service.url,
          pid: 1,
          password: service.password,
        }),
      })
      const savedState = process.env.XDG_STATE_HOME
      process.env.XDG_STATE_HOME = state
      const options = { mode: "remote", home: home.root, lingerSeconds: 0, logLevel: "error" }
      try {
        // Without OWN_REMOTE=1 a remote service is unmanaged: health only.
        const unmanaged = managedEnv({ OWN_OPEN_CODE: "1" })
        const missing = await boot(new World(), {
          directory: home.root,
          channel: "own",
          options: { ...options, buildId: buildId("remote-missing") },
        }).finally(unmanaged)
        expect(Object.keys(missing.registrations[0]!.definition.methods)).toEqual(["health"])
        expect(await call(missing.registrations[0]!, "health", {})).toMatchObject({
          guard: "unmanaged",
          mode: "remote",
          features: [],
        })
        expect(Git.tools()).toBeUndefined()
        await missing.cleanup()

        const id = buildId("remote")
        const managed = managedEnv({ OWN_OPEN_CODE: "1", OWN_REMOTE: "1" })
        const booted = await boot(new World(), {
          directory: path.join(home.root, "control"),
          channel: "own",
          options: { ...options, buildId: id },
        }).finally(managed)
        try {
          const registered = booted.registrations[0]!
          expect(Object.keys(registered.definition.methods).sort()).toEqual(
            Object.keys(OwnTeam.Definition.methods).sort(),
          )
          const health = (await call(registered, "health", {})) as OwnTeam.Health
          expect(health).toMatchObject({ guard: "ok", mode: "remote", buildId: id, leader: true })
          expect(health.features).toEqual(expect.arrayContaining(["diagnostics", "settings"]))
          expect(booted.tools).toHaveLength(11)
          expect(Git.tools()).toBe(RemoteEnv.tools(home.root))

          const services = Singleton.peek(id)!.controller.services
          await services.http.session.get({ sessionID: "ses_remote_probe", directory: home.root })
          expect(service.requests.at(-1)).toMatchObject({
            method: "GET",
            path: "/api/session/ses_remote_probe",
            authorization: ServiceTarget.basic(service.password),
          })
        } finally {
          await booted.cleanup()
        }
        expect(Git.tools()).toBeUndefined()
      } finally {
        if (savedState === undefined) delete process.env.XDG_STATE_HOME
        else process.env.XDG_STATE_HOME = savedState
        await service.stop()
      }
    },
    SLOW,
  )
})
