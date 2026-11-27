// 원격에 올리기와 검토 요청 (06 §7.5, §4.13, TG11 push items): nothing pushes without the plan's nonce (10 minutes,
// used once, `local` scope); expired or wrong nonces are `nonce_invalid`; an LFS repository runs `git lfs push` first
// and stops before `git push` when it fails; a remote that wants a login fails with `remote_rejected` and the login
// hint (`GIT_TERMINAL_PROMPT=0`, no askpass); a review request without `gh` gets the compare page. Remotes are bare
// `file://` repositories in the temp folder and one fake HTTP server on 127.0.0.1; no real remote is ever reached.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OwnID, OwnTeam } from "@own/protocol"
import { GitHubBridge } from "@own/runtime"
import { Advance } from "../../src/integrate/advance.js"
import { Push } from "../../src/integrate/push.js"
import { Confirm } from "../../src/ops/confirm.js"
import { Keys } from "../../src/registry/keys.js"
import { Lfs } from "../../src/git/lfs.js"
import { AREA, prepare, records, fixture, restarter, tipOf } from "../fixtures/advance.js"
import { f2, lfsAvailable } from "../fixtures/lfs-repo.js"
import { git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"
import { Schema } from "effect"

const SLOW = 120_000

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const NO_GH: Push.Deps = { gh: () => null }

/** Local settings that keep the user's credential helpers and proxy out of a fixture's pushes. */
function isolate(directory: string) {
  git(directory, ["config", "--local", "credential.helper", ""])
  git(directory, ["config", "--local", "http.proxy", ""])
}

/** An advanced integration on the advance fixture, with a bare `origin` that has `main` at B. */
async function pushable(
  options: { readonly gh?: Push.Deps; readonly remote?: (input: { home: string; bare: string }) => void } = {},
) {
  const box = temp("own-team-push-")
  const repo = fixture(box.root, { diverged: true })
  const bare = init(path.join(box.root, "origin.git"), { bare: true })
  isolate(repo.home)
  git(repo.home, ["remote", "add", "origin", pathToFileURL(bare).href])
  git(repo.home, ["push", "-q", "origin", "main"])
  options.remote?.({ home: repo.home, bare })
  const clock = manual()
  const h = controller(new World(), { directory: box.root, clock })
  cleanups.push(async () => {
    await h.close()
    box.dispose()
  })
  const deps: Advance.Deps = {
    safePoint: async () => ({ ok: true }),
    restart: restarter(h.services, repo),
    onAdvanced: async () => {},
  }
  const made = records(repo)
  const integration = await prepare(h.services, repo, made)
  const signal = new AbortController().signal
  await Advance.run(h.services, deps, { teamID: TEAM_ID, integrationID: integration.id, signal })
  await Advance.after(h.services, deps, { teamID: TEAM_ID, integrationID: integration.id, signal, summary: () => {} })
  const push = options.gh ?? NO_GH
  Push.register(h.services, push)
  return { box, repo, bare, clock, h, integration, push, area: made.area }
}

type Pushable = Awaited<ReturnType<typeof pushable>>

async function settle(h: Pushable["h"], opID: string) {
  await h.services.runner.settled(opID)
  return (await h.services.journal.find(opID))!
}

function remoteTip(bare: string, ref: string) {
  const result = Bun.spawnSync(["git", "-C", bare, "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], {
    stdout: "pipe",
  })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

describe("plan and execute (7.5)", () => {
  test(
    "the plan shows remote, ref and commands with a 10-minute nonce; only execute with it pushes, once",
    async () => {
      const s = await pushable()
      const before = remoteTip(s.bare, "main")
      const planned = await Push.plan(s.h.services, s.push, { integrationID: s.integration.id })
      if (!planned.ok) throw new Error(planned.message)
      expect(planned).toMatchObject({ remote: "origin", ref: "main", commands: ["git push origin main"] })
      expect(planned.expiresAt).toBe(s.clock.now() + Confirm.TTL_MS)
      // The plan alone sends nothing.
      expect(remoteTip(s.bare, "main")).toBe(before)

      const executed = await Push.execute(s.h.services, { nonce: planned.nonce })
      if (!executed.ok) throw new Error(executed.message)
      const op = await settle(s.h, executed.opID)
      expect(op).toMatchObject({ kind: "integrate", by: "user", state: "done" })
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([[Push.KIND.push, "done"]])
      expect(remoteTip(s.bare, "main")).toBe(tipOf(s.repo.home))
      expect(op.summary?.lines).toEqual([
        { kind: "pushed", areaID: s.area.id, integrationID: s.integration.id, remote: "origin", ref: "main" },
      ])
      const record = await Advance.get(s.h.services, TEAM_ID, s.integration.id)
      expect(record?.pushed).toMatchObject({ remote: "origin", ref: "main" })

      // A nonce is used once.
      expect(await Push.execute(s.h.services, { nonce: planned.nonce })).toMatchObject({
        ok: false,
        error: "nonce_invalid",
      })
    },
    SLOW,
  )

  test(
    "an expired or unknown nonce is nonce_invalid and pushes nothing",
    async () => {
      const s = await pushable()
      const before = remoteTip(s.bare, "main")
      const planned = await Push.plan(s.h.services, s.push, { integrationID: s.integration.id })
      if (!planned.ok) throw new Error(planned.message)
      expect(await Push.execute(s.h.services, { nonce: OwnID.Nonce.create() })).toMatchObject({
        ok: false,
        error: "nonce_invalid",
      })
      s.clock.advance(Confirm.TTL_MS)
      expect(await Push.execute(s.h.services, { nonce: planned.nonce })).toMatchObject({
        ok: false,
        error: "nonce_invalid",
      })
      expect(await s.h.services.journal.list(TEAM_ID)).toEqual([])
      expect(remoteTip(s.bare, "main")).toBe(before)
    },
    SLOW,
  )

  test(
    "nothing to push before the target advanced; no remote is not_found",
    async () => {
      const s = await pushable()
      const record = (await Advance.get(s.h.services, TEAM_ID, s.integration.id))!
      const encode = Schema.encodeSync(OwnTeam.Integration)
      const running: OwnTeam.Integration = { ...Advance.withoutWaiting(record), state: "running" }
      await s.h.services.write(TEAM_ID, () =>
        s.h.services.kv.set(Keys.integration(TEAM_ID, record.id), Keys.toJson(encode(running))),
      )
      expect(await Push.plan(s.h.services, s.push, { integrationID: record.id })).toMatchObject({
        ok: false,
        error: "unsupported",
      })
      await s.h.services.write(TEAM_ID, () =>
        s.h.services.kv.set(Keys.integration(TEAM_ID, record.id), Keys.toJson(encode(record))),
      )
      git(s.repo.home, ["remote", "remove", "origin"])
      expect(await Push.plan(s.h.services, s.push, { integrationID: record.id })).toMatchObject({
        ok: false,
        error: "not_found",
        data: { what: "remote" },
      })
    },
    SLOW,
  )
})

describe("a remote that wants a login (7.5)", () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response("login required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="own-test"' } }),
  })
  afterAll(() => server.stop(true))

  test(
    "fails with remote_rejected and the login hint instead of prompting",
    async () => {
      const s = await pushable()
      git(s.repo.home, ["remote", "set-url", "origin", `http://127.0.0.1:${server.port}/fixture.git`])
      const direct = await Push.gitPush(s.repo.home, "origin", "main")
      expect(direct).toMatchObject({ ok: false, error: "remote_rejected", data: { remote: "origin" } })
      if (direct.ok) throw new Error("pushed")
      expect(direct.message.startsWith(Push.LOGIN)).toBe(true)

      const planned = await Push.plan(s.h.services, s.push, { integrationID: s.integration.id })
      if (!planned.ok) throw new Error(planned.message)
      const executed = await Push.execute(s.h.services, { nonce: planned.nonce })
      if (!executed.ok) throw new Error(executed.message)
      const op = await settle(s.h, executed.opID)
      expect(op.state).toBe("failed")
      expect(op.steps[0]?.note?.startsWith(Push.LOGIN)).toBe(true)
      expect((await Advance.get(s.h.services, TEAM_ID, s.integration.id))?.pushed).toBeUndefined()
    },
    SLOW,
  )

  test(
    "with a GitHub account chosen for the area's folder, git logs in through own's helper (16 §6)",
    async () => {
      const seen: string[] = []
      const remote = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
          const authorization = request.headers.get("authorization")
          if (authorization) seen.push(authorization)
          return new Response("bad credentials", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="own-test"' },
          })
        },
      })
      const site = `http://127.0.0.1:${remote.port}`
      const s = await pushable()
      git(s.repo.home, ["remote", "set-url", "origin", `${site}/fixture.git`])
      const asked: string[] = []
      // own-accounts' provider answers with git's helper for the account's site; this one gives a fake login itself.
      const undo = GitHubBridge.provide({
        gitEnv: async (directory) => {
          asked.push(directory)
          return {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: `credential.${site}.helper`,
            GIT_CONFIG_VALUE_0: "",
            GIT_CONFIG_KEY_1: `credential.${site}.helper`,
            GIT_CONFIG_VALUE_1: "!f() { cat >/dev/null; echo username=octo-area; echo password=fake-area-token; }; f",
          }
        },
      })
      try {
        const pushed = await Push.gitPush(s.repo.home, "origin", "main")
        expect(pushed).toMatchObject({ ok: false, error: "remote_rejected" })
        expect(asked).toEqual([s.repo.home])
        expect(seen).toContain(`Basic ${btoa("octo-area:fake-area-token")}`)
      } finally {
        undo()
        remote.stop(true)
      }
    },
    SLOW,
  )
})

describe("review requests (7.5)", () => {
  /** `url` names a GitHub-style page; pushes go to the bare repository through `pushurl`. */
  const github = (input: { home: string; bare: string }) => {
    git(input.home, ["remote", "set-url", "origin", "https://github.com/own-test/fixture.git"])
    git(input.home, ["remote", "set-url", "--push", "origin", pathToFileURL(input.bare).href])
  }

  test(
    "without gh: the area branch goes up and the card gets the compare page",
    async () => {
      const t = await pushable({ remote: github })
      const url = `https://github.com/own-test/fixture/compare/main...${AREA}?expand=1`
      const planned = await Push.plan(t.h.services, t.push, { integrationID: t.integration.id, pr: true })
      if (!planned.ok) throw new Error(planned.message)
      expect(planned).toMatchObject({ remote: "origin", ref: AREA, commands: [`git push origin ${AREA}`, url] })
      const executed = await Push.execute(t.h.services, { nonce: planned.nonce })
      if (!executed.ok) throw new Error(executed.message)
      const op = await settle(t.h, executed.opID)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        [Push.KIND.push, "done"],
        [Push.KIND.pr, "done"],
      ])
      expect(remoteTip(t.bare, AREA)).toBe(head(t.repo.area))
      expect((await Advance.get(t.h.services, TEAM_ID, t.integration.id))?.pushed).toMatchObject({
        remote: "origin",
        ref: AREA,
        pr: url,
      })
    },
    SLOW,
  )

  test(
    "with gh: gh pr create --base <target> --head <area branch> --fill, without prompts",
    async () => {
      const box = temp("own-team-gh-")
      cleanups.push(async () => box.dispose())
      const script = path.join(box.root, "fake-gh.ts")
      const log = path.join(box.root, "gh-args.json")
      fs.writeFileSync(
        script,
        [
          `require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({`,
          `  args: process.argv.slice(2), prompt: process.env.GH_PROMPT_DISABLED }))`,
          `console.log("Creating pull request")`,
          `console.log("https://example.invalid/own-test/fixture/pull/7")`,
        ].join("\n"),
      )
      const s = await pushable({ gh: { gh: () => [process.execPath, script] } })
      const planned = await Push.plan(s.h.services, s.push, { integrationID: s.integration.id, pr: true })
      if (!planned.ok) throw new Error(planned.message)
      expect(planned.commands).toEqual([`git push origin ${AREA}`, `gh pr create --base main --head ${AREA} --fill`])
      const executed = await Push.execute(s.h.services, { nonce: planned.nonce })
      if (!executed.ok) throw new Error(executed.message)
      expect((await settle(s.h, executed.opID)).state).toBe("done")
      expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual({
        args: ["pr", "create", "--base", "main", "--head", AREA, "--fill"],
        prompt: "1",
      })
      expect((await Advance.get(s.h.services, TEAM_ID, s.integration.id))?.pushed?.pr).toBe(
        "https://example.invalid/own-test/fixture/pull/7",
      )
    },
    SLOW,
  )

  test("compare pages come only from web-style remote URLs", () => {
    const page = (url: string) => Push.compareUrl(url, "main", "inv")
    expect(page("https://github.com/o/r.git")).toBe("https://github.com/o/r/compare/main...inv?expand=1")
    expect(page("https://user@github.com/o/r")).toBe("https://github.com/o/r/compare/main...inv?expand=1")
    expect(page("git@github.com:o/r.git")).toBe("https://github.com/o/r/compare/main...inv?expand=1")
    expect(page("ssh://git@github.com:22/o/r.git")).toBe("https://github.com/o/r/compare/main...inv?expand=1")
    expect(page("file:///C:/repos/r.git")).toBeUndefined()
    expect(page("C:/repos/r.git")).toBeUndefined()
    expect(page("/srv/repos/r.git")).toBeUndefined()
  })
})

describe.skipIf(!lfsAvailable)("an LFS repository (4.13)", () => {
  /** F2 with a new LFS file committed on `main`, and a done integration of it. */
  async function lfsPushable() {
    const box = temp("own-team-push-lfs-")
    const repo = f2(path.join(box.root, "f2"))
    isolate(repo.home)
    const previous = repo.head
    write(repo.home, { "src/icons/new.png": crypto.getRandomValues(new Uint8Array(4_096)) })
    git(repo.home, ["add", "src/icons/new.png"])
    git(repo.home, ["commit", "-q", "-m", "new icon"])
    const tip = head(repo.home)
    const clock = manual()
    const h = controller(new World(), { directory: box.root, clock })
    cleanups.push(async () => {
      await h.close()
      box.dispose()
    })
    const lfsTeam: OwnTeam.Team = {
      ...team({ home: repo.home }),
      env: { symlinkFix: "none", bunCache: "unused", lfs: "system" },
    }
    const lfsArea = area({ slug: AREA, directory: path.join(box.root, "team", AREA) })
    const integration: OwnTeam.Integration = {
      id: OwnTeam.IntegrationID.create(),
      teamID: TEAM_ID,
      areaID: lfsArea.id,
      state: "done",
      target: "main",
      source: tip,
      base: previous,
      candidate: tip,
      how: "ff",
      verify: { code: { ok: true, ms: 1 }, assets: "skipped" },
      advanced: { how: "update-ref", at: 0 },
      createdAt: 0,
    }
    const encode = Schema.encodeSync(OwnTeam.Integration)
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(lfsTeam)
      await h.services.registry.areas.put(lfsArea)
      await h.services.kv.set(Keys.integration(TEAM_ID, integration.id), Keys.toJson(encode(integration)))
    })
    Push.register(h.services, NO_GH)
    const oid = Lfs.parsePointer(git(repo.home, ["cat-file", "-p", `${tip}:src/icons/new.png`]))!.oid
    return { repo, h, integration, tip, previous, oid }
  }

  test(
    "git lfs push runs first, then git push; the remote gets the object and the commit",
    async () => {
      const s = await lfsPushable()
      const planned = await Push.plan(s.h.services, NO_GH, { integrationID: s.integration.id })
      if (!planned.ok) throw new Error(planned.message)
      expect(planned.commands).toEqual(["git lfs push origin main", "git push origin main"])
      const executed = await Push.execute(s.h.services, { nonce: planned.nonce })
      if (!executed.ok) throw new Error(executed.message)
      const op = await settle(s.h, executed.opID)
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        [Push.KIND.lfs, "done"],
        [Push.KIND.push, "done"],
      ])
      expect(remoteTip(s.repo.origin, "main")).toBe(s.tip)
      expect(fs.existsSync(Lfs.objectPath(path.join(s.repo.origin, "lfs"), s.oid))).toBe(true)
    },
    SLOW,
  )

  test(
    "a failed git lfs push stops the op before git push",
    async () => {
      const s = await lfsPushable()
      const planned = await Push.plan(s.h.services, NO_GH, { integrationID: s.integration.id })
      if (!planned.ok) throw new Error(planned.message)
      s.repo.offline()
      const executed = await Push.execute(s.h.services, { nonce: planned.nonce })
      if (!executed.ok) throw new Error(executed.message)
      const op = await settle(s.h, executed.opID)
      s.repo.online()
      expect(op.state).toBe("failed")
      expect(op.steps.map((step) => [step.kind, step.state])).toEqual([
        [Push.KIND.lfs, "failed"],
        [Push.KIND.push, "pending"],
      ])
      expect(remoteTip(s.repo.origin, "main")).toBe(s.previous)
    },
    SLOW,
  )
})
