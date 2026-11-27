// The controller's T2 triggers (06 §8.8, §4.7, §7.2–§7.3, §5.6, §2.6 (d); TG8 with integration and reconcile events):
// reconcile runs once per area when the controller starts and never wakes an idle area Location; a `done` report
// releases the fetched heavy folders at the area's next extended safe point (Main 멈춤 skips it); an integration
// stopped during its checks resumes from the result file; a waiting integration is tried again by `area.integrate`
// and when the main wakes; a second conflict wakes the main exactly once, and the results reach the next team update
// within 2k tokens in lines own-web counts. Real git fixtures in temp folders, a fake own service on 127.0.0.1, a
// manual clock, fake values only.

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import { Release } from "../../src/assets/release.js"
import { Controller } from "../../src/controller.js"
import type { Hub } from "../../src/hub.js"
import { Advance } from "../../src/integrate/advance.js"
import { IntegrateOp } from "../../src/integrate/op.js"
import { Log } from "../../src/log.js"
import { Digest } from "../../src/report/digest.js"
import { Fold } from "../../src/report/fold.js"
import type { Services } from "../../src/services.js"
import { integrate, save } from "../fixtures/integrate.js"
import { Backend, OWNERS } from "../fixtures/reconcile.js"
import { commit, git, head, init, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import {
  MAIN_SESSION,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  buildId,
  context,
  controller,
  team,
} from "../support/context.js"
import { type FakeService, type Recorded, start } from "../support/service.js"

const SLOW = 240_000

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function box(prefix: string) {
  const made = temp(prefix)
  cleanups.push(made.dispose)
  return made.root
}

/** A run of `sessionID` ended (the fields own.team reads). */
function ended(sessionID: string): Hub.Incoming {
  // SAFETY (test): a core event with the fields own.team reads (`type`, `data`).
  return {
    id: `evt_${crypto.randomUUID()}`,
    created: 1,
    type: "session.execution.succeeded",
    data: { sessionID },
  } as never
}

/** Waits (real time) until `check` answers something. */
async function until<T>(check: () => Promise<T | undefined> | T | undefined, ms = 120_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(25)
  }
}

/** Main 멈춤 aside, the admit feature records the `from="team"` requests instead of sending them. */
function admitting(requests: Services.DispatchInput[]): Services.Factories["admit"] {
  return () => ({
    dispatch: async (input) => {
      requests.push(input)
      return { ok: true, dispatchID: OwnTeam.DispatchID.create(), state: "waiting", why: "busy" }
    },
    message: async () => ({ ok: true, guard: "limit" }),
    drain: async () => {},
    list: async () => ({ ok: true, items: [] }),
    cancel: async () => ({ ok: true }),
    cancelAll: async () => [],
  })
}

/** The main's inbox and `session.synthetic` of the own service: a team update stays undelivered once it is in. */
function mainInbox(service: FakeService) {
  const synthetic: Recorded[] = []
  const inbox: unknown[] = []
  service.routes.set(`GET /api/session/${MAIN_SESSION}/inbox`, () => Response.json({ data: inbox }))
  service.routes.set(`POST /api/session/${MAIN_SESSION}/synthetic`, (request) => {
    synthetic.push(request)
    // SAFETY (test): own.team sends a JSON object body.
    const body = request.body as { id: string; text: string; metadata?: Record<string, unknown> }
    const item = {
      id: body.id,
      sessionID: MAIN_SESSION,
      type: "synthetic",
      delivery: "queue",
      payload: { text: body.text, ...(body.metadata ? { metadata: body.metadata } : {}) },
    }
    inbox.push(item)
    return Response.json({ data: item })
  })
  return synthetic
}

describe("reconcile at start (06 §8.8)", () => {
  test(
    "runs once per area when the controller starts, reads sessions at the home and wakes no area Location",
    async () => {
      const root = box("own-team-t2-start-")
      const home = init(path.join(root, "home"))
      write(home, { "README.md": "# start\n", "src/app.ts": "export const app = 1\n" })
      commit(home, "base")
      const slugs = ["ui", "save"] as const
      const folders = { ui: path.join(root, "home-team", "ui"), save: path.join(root, "home-team", "save") }
      const gitDirs = Object.fromEntries(
        slugs.map((slug) => {
          git(home, ["worktree", "add", "-q", "-b", slug, folders[slug], "main"])
          return [slug, git(folders[slug], ["rev-parse", "--absolute-git-dir"]).trim()]
        }),
      )
      // Changed while no controller ran: `ui` is on another branch now.
      git(folders.ui, ["switch", "-q", "-c", "ui-next"])
      const backend = new Backend()
      cleanups.push(() => backend.service.stop())
      backend.add(MAIN_SESSION, home)
      slugs.forEach((slug) => backend.add(OWNERS[slug], folders[slug]))
      const world = new World()
      const service = new Controller.Service({
        buildId: buildId("t2-start"),
        home: path.join(root, "own-home"),
        log: Log.silent,
        clock: manual(),
        source: backend.service.source,
        features: { digest: () => ({ add: async () => {}, render: async () => "" }) },
      })
      const detach = service.attach({
        ctx: context(world, { directory: home }).ctx,
        directory: home,
        control: true,
        leader: () => true,
      })
      cleanups.push(async () => {
        detach()
        await service.close()
      })
      // The registry as a previous controller left it (written straight to KV: nothing runs yet).
      await service.services.registry.teams.put({ ...team({ home }), worktreeRoot: path.join(root, "home-team") })
      for (const slug of slugs)
        await service.services.registry.areas.put({
          ...area({ slug, directory: folders[slug] }),
          gitDir: gitDirs[slug]!,
          owner: { sessionID: OWNERS[slug], previous: [], attached: true },
        })
      service.start()
      // The start reconcile read the teams before the controller's first write could run.
      await service.services.features().reconcile.start()
      expect((await service.services.registry.areas.get(TEAM_ID, OwnTeam.AreaID.make("ar_ui")))?.branch).toBe("ui-next")

      // Another instance appears: the features resume again, reconcile does not run again (and `start` answers the
      // same runs).
      const second = service.attach({
        ctx: context(world, { directory: folders.save }).ctx,
        directory: folders.save,
        control: false,
        leader: () => false,
      })
      cleanups.push(second)
      await service.resume()
      await service.services.features().reconcile.start()

      const reads = (sessionID: string) =>
        backend.service.requests.filter(
          (request) => request.method === "GET" && request.path === `/api/session/${sessionID}`,
        )
      for (const slug of slugs) {
        expect(reads(OWNERS[slug])).toHaveLength(1)
        expect(reads(OWNERS[slug])[0]?.query["location[directory]"]).toBe(home)
      }
      // Nothing that starts a Location (prompt, synthetic, generate, instruction entries, forms, shells, ptys) was
      // asked about an area folder.
      const areaFolders = Object.values(folders)
      const waking = backend.service.requests.filter(
        (request) =>
          areaFolders.includes(request.query["location[directory]"] ?? "") &&
          /\/(prompt|synthetic|generate|instructions|form)(\/|$)|^\/api\/(shell|pty)/.test(request.path),
      )
      expect(waking).toEqual([])
    },
    SLOW,
  )
})

describe("release after done (06 §4.7, TI-13)", () => {
  test("a done report releases at the next extended safe point; Main 멈춤 skips it", async () => {
    const root = box("own-team-t2-release-")
    const safe = { now: false }
    const h = controller(new World(), {
      directory: root,
      clock: manual(),
      features: {
        safePoint: () => ({
          check: async () => (safe.now ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
        }),
      },
    })
    cleanups.push(h.close)
    const extra = { "Assets/Textures": { reason: "모델 수정", at: 1, bytes: 10 } }
    const busy: OwnTeam.Area = {
      ...area({ slug: "ui", directory: path.join(root, "ui") }),
      shape: "code",
      cone: { extra, kept: {} },
    }
    const paused: OwnTeam.Area = {
      ...area({ slug: "save", directory: path.join(root, "save") }),
      shape: "code",
      cone: { extra, kept: {} },
      owner: { sessionID: OWNERS.save, previous: [], attached: true },
      paused: "user",
    }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put({
        ...team({ home: root }),
        heavy: { dirs: ["Assets/Textures"], measuredAt: null, forcedBytes: 0 },
      })
      await h.services.registry.areas.put(busy)
      await h.services.registry.areas.put(paused)
    })
    const report = (areaID: OwnTeam.AreaID, sessionID: SessionID) =>
      h.services.features().events.report({
        teamID: TEAM_ID,
        areaID,
        sessionID,
        kind: "done",
        text: "끝났습니다",
      })
    const releases = async () =>
      (await h.services.journal.list(TEAM_ID)).filter((op) => op.steps.some((step) => step.kind === Release.AUTO_STEP))

    expect(await report(busy.id, OWNER_SESSION)).toMatchObject({ ok: true })
    expect(await report(paused.id, OWNERS.save)).toMatchObject({ ok: true })
    // The owner still works: nothing yet.
    h.controller.hub.receive(ended(OWNER_SESSION))
    await Bun.sleep(300)
    expect(await releases()).toEqual([])

    safe.now = true
    h.controller.hub.receive(ended(OWNER_SESSION))
    const ops = await until(async () => {
      const found = await releases()
      return found.length > 0 ? found : undefined
    })
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      kind: "paths",
      by: "auto",
      areaID: busy.id,
      steps: [{ kind: Release.AUTO_STEP, args: { areaID: busy.id, trigger: "done" } }],
    })
    // Main 멈춤: the paused area's release was dropped, also at a safe point after another run.
    h.controller.hub.receive(ended(OWNERS.save))
    await Bun.sleep(300)
    expect((await releases()).filter((op) => op.areaID === paused.id)).toEqual([])
  })
})

describe("integration (06 §7.2–§7.3)", () => {
  test(
    "an integration stopped during its checks resumes from the result file: a passed check never runs again",
    async () => {
      const root = box("own-team-t2-verify-")
      const fx = integrate(path.join(root, "repo"))
      const counters = { one: path.join(root, "one.txt"), two: path.join(root, "two.txt"), go: path.join(root, "go") }
      const bun = process.execPath
      const code: OwnTeam.Command[] = [
        { argv: [bun, "-e", `require("fs").appendFileSync(${JSON.stringify(counters.one)}, "1")`] },
        {
          argv: [
            bun,
            "-e",
            [
              `const fs = require("fs")`,
              `fs.appendFileSync(${JSON.stringify(counters.two)}, "2")`,
              `while (!fs.existsSync(${JSON.stringify(counters.go)})) Bun.sleepSync(50)`,
            ].join("; "),
          ],
        },
      ]
      const world = new World()
      const features = {
        safePoint: () => ({ check: async () => ({ ok: true }) as const }),
        admit: admitting([]),
      } satisfies Partial<Services.Factories>
      const first = controller(world, { directory: root, clock: manual(), features })
      cleanups.push(first.close)
      first.services.features().integrate.register()
      const tip = save(fx.area.directory, { "src/area.ts": "area\n" })
      await first.services.write(TEAM_ID, async () => {
        await first.services.registry.teams.put({ ...fx.team, commands: { setup: null, code, assets: [] } })
        await first.services.registry.areas.put({ ...fx.area, candidate: { sha: tip, at: 1, text: "끝" } })
      })
      const started = await first.services
        .features()
        .integrate.start({ teamID: TEAM_ID, areaID: fx.area.id, by: "main" })
      if (!started.ok) throw new Error(started.message)
      // The second check runs: the controller goes away (its steps stop; the op stays running).
      await until(() => (fs.existsSync(counters.two) ? true : undefined))
      await first.close()
      // The stopped check's process ends; its result is never written (it runs again).
      await Bun.sleep(500)
      fs.writeFileSync(counters.go, "")

      const second = controller(world, { directory: root, clock: manual(), features })
      cleanups.push(second.close)
      // What the RPC group does while the plugin sets up: the kinds exist before the resume continues the op.
      second.services.features().integrate.register()
      const done = await until(async () => {
        const record = await IntegrateOp.get(second.services, TEAM_ID, started.integrationID)
        return record?.state === "done" ? record : undefined
      })
      expect(fs.readFileSync(counters.one, "utf8")).toBe("1")
      expect(fs.readFileSync(counters.two, "utf8")).toBe("22")
      expect(done.verify.code).toMatchObject({ ok: true })
      expect(done.advanced).toMatchObject({ how: "ff-in-worktree" })
      expect(head(fx.home)).toBe(String(done.candidate))
      // The candidate went in: it and 반영 준비됨 are gone from the area (ReportEvents.integrated).
      await until(async () =>
        (await second.services.registry.areas.get(TEAM_ID, fx.area.id))?.candidate === undefined ? true : undefined,
      )
    },
    SLOW,
  )

  test(
    "a waiting integration is tried again by area.integrate and when the main wakes",
    async () => {
      const root = box("own-team-t2-retry-")
      const fx = integrate(path.join(root, "repo"))
      const service = start()
      cleanups.push(() => service.stop())
      const synthetic = mainInbox(service)
      const clock = manual()
      const safe = { now: false }
      const h = controller(new World(), {
        directory: root,
        clock,
        source: service.source,
        features: {
          safePoint: () => ({
            check: async () => (safe.now ? { ok: true } : { ok: false, why: "session", sessionIDs: [] }),
          }),
          admit: admitting([]),
        },
      })
      cleanups.push(h.close)
      const tip = save(fx.area.directory, { "src/area.ts": "area\n" })
      await h.services.write(TEAM_ID, async () => {
        await h.services.registry.teams.put(fx.team)
        await h.services.registry.areas.put({ ...fx.area, candidate: { sha: tip, at: 1, text: "끝" } })
      })
      const feature = h.services.features().integrate
      const first = await feature.start({ teamID: TEAM_ID, areaID: fx.area.id, by: "main" })
      if (!first.ok) throw new Error(first.message)
      await h.services.runner.settled(first.opID)
      // The home has `main` checked out and someone works there: the integration waits, its op ended.
      const waiting = await IntegrateOp.get(h.services, TEAM_ID, first.integrationID)
      expect(waiting).toMatchObject({ state: "waiting", waiting: { why: "in-use" } })
      expect((await h.services.journal.get(TEAM_ID, first.opID))?.state).toBe("done")

      // 다시 반영 (area.integrate): steps 8–9 again for the same integration.
      const again = await feature.start({ teamID: TEAM_ID, areaID: fx.area.id, by: "user", tip: true })
      if (!again.ok) throw new Error(again.message)
      expect(again.integrationID).toBe(first.integrationID)
      await h.services.runner.settled(again.opID)
      expect((await h.services.journal.get(TEAM_ID, again.opID))?.steps.map((step) => step.kind)).toEqual([
        Advance.STEP,
        Advance.AFTER,
      ])
      expect((await IntegrateOp.get(h.services, TEAM_ID, first.integrationID))?.state).toBe("waiting")

      // The folder is idle now; a team update wakes the main, and the integration goes in.
      safe.now = true
      await h.services
        .features()
        .digest.add(TEAM_ID, Fold.entry({ at: clock.now(), reason: "blocked", text: "", areaID: fx.area.id }))
      const done = await until(async () => {
        clock.advance(1_000)
        const record = await IntegrateOp.get(h.services, TEAM_ID, first.integrationID)
        return record?.state === "done" ? record : undefined
      })
      expect(synthetic).toHaveLength(1)
      expect(head(fx.home)).toBe(String(done.candidate))
      const ops = (await h.services.journal.list(TEAM_ID)).filter((op) => op.kind === "integrate")
      expect(ops.map((op) => op.by)).toEqual(["main", "user", "auto"])
    },
    SLOW,
  )

  test(
    "a second conflict wakes the main once; the results come in the next team update, counted by OwnTeamText",
    async () => {
      const root = box("own-team-t2-conflict-")
      const fx = integrate(path.join(root, "repo"))
      const service = start()
      cleanups.push(() => service.stop())
      const synthetic = mainInbox(service)
      const clock = manual()
      const requests: Services.DispatchInput[] = []
      const h = controller(new World(), {
        directory: root,
        clock,
        source: service.source,
        features: { admit: admitting(requests) },
      })
      cleanups.push(h.close)
      await h.services.write(TEAM_ID, () => h.services.registry.teams.put(fx.team))
      save(fx.home, { "src/app.ts": "export const app = 'main'\n" })
      const integrateOnce = async (content: string) => {
        const sha = save(fx.area.directory, { "src/app.ts": content })
        await h.services.write(TEAM_ID, async () =>
          h.services.registry.areas.put({ ...fx.area, candidate: { sha, at: 1, text: "끝" } }),
        )
        const started = await h.services.features().integrate.start({ teamID: TEAM_ID, areaID: fx.area.id, by: "main" })
        if (!started.ok) throw new Error(started.message)
        await h.services.runner.settled(started.opID)
        return IntegrateOp.get(h.services, TEAM_ID, started.integrationID)
      }
      /** Moves the clock in steps for a while; the team update goes out when it is due. */
      const later = async (ms: number) => {
        for (let moved = 0; moved < ms; moved += 5_000) {
          clock.advance(5_000)
          await Bun.sleep(10)
        }
      }

      expect(await integrateOnce("export const app = 'area'\n")).toMatchObject({ state: "conflict" })
      expect(requests).toEqual([expect.objectContaining({ from: "team", kind: "conflict", areaID: fx.area.id })])
      // The first conflict goes to the owner, not to the main (7.3, 5.6).
      await later(Fold.DEBOUNCE_MS * 2)
      expect(synthetic).toEqual([])

      expect(await integrateOnce("export const app = 'area 2'\n")).toMatchObject({
        state: "failed",
        failure: "conflict",
      })
      expect(requests).toHaveLength(1)
      await until(async () => {
        await later(5_000)
        return synthetic.length > 0 ? true : undefined
      })
      await later(Fold.CHECK_MS * 2)
      expect(synthetic).toHaveLength(1)

      // SAFETY (test): own.team sends a JSON object body.
      const text = (synthetic[0]!.body as { text: string }).text
      expect(Digest.tokens(text)).toBeLessThanOrEqual(Digest.MAX_TOKENS)
      const counted = text.split("\n").flatMap((line) => {
        const kind = OwnTeamText.countOf(line)
        return kind === undefined ? [] : [kind]
      })
      expect(counted).toEqual(expect.arrayContaining(["busy", "failed"]))
      expect(text).toContain(`- ${fx.area.name}: ${OwnTeamText.INTEGRATION.failed}`)
      expect(text).toContain(`- ${fx.area.name}: ${OwnTeamText.INTEGRATION.conflict}`)
    },
    SLOW,
  )
})
