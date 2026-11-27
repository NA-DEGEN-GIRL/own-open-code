// The T2 RPC groups (06 §2.7, TG11 Op-level wiring): every T2 method is registered through the portable definition and
// answers from its group (never `unsupported`); service failures come back as declared errors and a thrown error as
// `internal_error`, never a throw; `area.paths{release}` is the user's release (`Release.user`); `integration.get`
// answers the checks' log text; `health` lists the T2 features. Fake contexts over one world, the real @own/runtime on
// a temp OWN_HOME, a manual clock; fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Account, OwnTeam } from "@own/protocol"
import { Log } from "../../src/log.js"
import { Keys } from "../../src/registry/keys.js"
import { Teams } from "../../src/registry/team.js"
import { TeamRpc } from "../../src/rpc/handlers.js"
import { Services } from "../../src/services.js"
import { manual } from "../support/clock.js"
import {
  TEAM_ID,
  World,
  area,
  boot,
  buildId,
  call,
  controller,
  managedEnv,
  team,
  tempHome,
  type Registered,
} from "../support/context.js"

const restore = managedEnv()
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  restore()
})

/** The methods T1 answered with `unsupported` (`rpc/unsupported.ts`). */
const T2 = [
  "area.adopt",
  "area.unadopt",
  "area.integrate",
  "integration.get",
  "integration.undo",
  "integration.push.plan",
  "integration.push.execute",
  "decisions.list",
  "decisions.add",
] as const

const UNKNOWN_TEAM = "tm_000000000000"
const AREA_ID = OwnTeam.AreaID.make("ar_ui")
const IG = "ig_01JABCDEFGHJKMNPQRSTVWXYZ0"

interface Standard {
  readonly "~standard": { readonly validate: (value: unknown) => unknown }
}

/** Calls a handler of `TeamRpc.create` with a context whose `error` returns the error object (as the host would). */
function invoke(handlers: TeamRpc.Handlers, method: string, input: unknown) {
  // SAFETY (test): every handler takes its method's input and a call context; erased to call them by name.
  const loose = handlers as unknown as Registered["handlers"]
  return call({ definition: { methods: {} }, handlers: loose, emitted: [], disposed: false }, method, input)
}

/** The declared error types of `method` (`internal_error` and `unsupported` included). */
function declared(method: (typeof T2)[number]) {
  return Object.keys(OwnTeam.Definition.methods[method].errors)
}

describe("the T2 groups in the plugin", () => {
  test("every T2 method is registered through the portable definition and answers from its group", async () => {
    await using home = await tempHome()
    const booted = await boot(new World(), {
      directory: home.root,
      options: { home: home.root, buildId: buildId("t2-rpc"), lingerSeconds: 0, logLevel: "error" },
    })
    cleanups.push(booted.cleanup)
    const registered = booted.registrations[0]!
    expect(registered.definition).toBe(TeamRpc.definition())
    for (const method of T2) {
      // SAFETY (test): the portable definition's methods carry Standard Schema input and output objects.
      const entry = registered.definition.methods[method] as { readonly input: Standard; readonly output: Standard }
      expect(typeof entry.input["~standard"].validate).toBe("function")
      expect(typeof entry.output["~standard"].validate).toBe("function")
    }
    const inputs: Readonly<Record<(typeof T2)[number], unknown>> = {
      "area.adopt": { teamID: UNKNOWN_TEAM, directory: home.root },
      "area.unadopt": { teamID: UNKNOWN_TEAM, areaID: AREA_ID },
      "area.integrate": { teamID: UNKNOWN_TEAM, areaID: AREA_ID },
      "integration.get": { integrationID: IG },
      "integration.undo": { integrationID: IG },
      "integration.push.plan": { integrationID: IG },
      "integration.push.execute": { nonce: "N".repeat(24) },
      "decisions.list": { teamID: UNKNOWN_TEAM },
      "decisions.add": { teamID: UNKNOWN_TEAM, title: "결정", body: "" },
    }
    const answers = await Promise.all(
      T2.map(async (method) => ({
        method,
        answer: (await call(registered, method, inputs[method])) as { readonly type: string },
      })),
    )
    for (const item of answers) {
      expect(item.answer.type).not.toBe("unsupported")
      expect(declared(item.method)).toContain(item.answer.type)
    }
    expect(Object.fromEntries(answers.map((item) => [item.method, item.answer.type]))).toEqual({
      "area.adopt": "not_found",
      "area.unadopt": "not_found",
      "area.integrate": "not_found",
      "integration.get": "not_found",
      "integration.undo": "not_found",
      "integration.push.plan": "not_found",
      "integration.push.execute": "nonce_invalid",
      "decisions.list": "not_found",
      "decisions.add": "not_found",
    })
    const health = (await call(registered, "health", {})) as OwnTeam.Health
    expect(health.features).toEqual(expect.arrayContaining(["adopt", "integrate", "push", "decisions"]))
    expect(new Set(health.features).size).toBe(health.features.length)
    await booted.cleanup()
  })
})

describe("declared errors from injected failures", () => {
  const failing = { adopt: true }
  const thrown = new Error("boom")

  async function setup() {
    const home = await tempHome()
    cleanups.push(() => home[Symbol.asyncDispose]())
    const world = new World()
    const h = controller(world, {
      directory: home.root,
      clock: manual(),
      features: {
        adopt: () => ({
          adopt: async () =>
            failing.adopt
              ? Services.failure("path_forbidden", "not here", { path: home.root, why: "primary" })
              : { ok: true, opID: OwnTeam.OpID.create() },
          unadopt: async () =>
            Services.failure("not_safe_point", "the area is working", {
              areaID: AREA_ID,
              why: "session",
              sessionIDs: [],
            }),
        }),
        integrate: () => ({
          register: () => {},
          retry: async () => {},
          start: async (input) =>
            input.areaID === AREA_ID
              ? Services.failure("not_safe_point", "a rebase stopped half way", {
                  areaID: AREA_ID,
                  why: "git",
                  sessionIDs: [],
                })
              : Services.failure("same_company_subscription", "not for this method", {
                  accountID: Account.ID.make("acc_x"),
                }),
          undo: async () => {
            throw thrown
          },
          undoCancel: async () =>
            Services.failure("busy", "the undo runs", { teamID: TEAM_ID, opID: OwnTeam.OpID.create(), kind: "undo" }),
          plan: async () => Services.failure("lfs_missing", "git-lfs is needed", { tool: "git-lfs", version: null }),
          push: async () => Services.failure("remote_rejected", "rejected", { remote: "origin", message: "no" }),
        }),
      },
    })
    cleanups.push(h.close)
    const record = team({ home: home.root })
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put({ ...record, state: "off" })
      await h.services.registry.areas.put(area({ slug: "ui", directory: path.join(home.root, "ui") }))
    })
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: Log.silent })
    return { home: home.root, h, record, handlers }
  }

  test("each failure is its method's declared error, an undeclared one and a throw are internal_error", async () => {
    const s = await setup()
    expect(await invoke(s.handlers, "area.adopt", { teamID: TEAM_ID, directory: s.home })).toMatchObject({
      type: "path_forbidden",
      data: { why: "primary" },
    })
    expect(await invoke(s.handlers, "area.unadopt", { teamID: TEAM_ID, areaID: AREA_ID })).toMatchObject({
      type: "not_safe_point",
      data: { why: "session" },
    })
    // A git operation stopped in the area folder: its branch is in use there (7.1).
    expect(await invoke(s.handlers, "area.integrate", { teamID: TEAM_ID, areaID: AREA_ID })).toMatchObject({
      type: "in_use",
      data: { branch: "ui", directory: path.join(s.home, "ui") },
    })
    expect(
      await invoke(s.handlers, "area.integrate", { teamID: TEAM_ID, areaID: OwnTeam.AreaID.make("ar_other") }),
    ).toMatchObject({ type: "internal_error", message: "not for this method" })
    expect(await invoke(s.handlers, "integration.undo", { integrationID: IG })).toMatchObject({
      type: "internal_error",
      data: {},
    })
    expect(await invoke(s.handlers, "integration.undo.cancel", { integrationID: IG })).toMatchObject({
      type: "busy",
      data: { kind: "undo" },
    })
    expect(await invoke(s.handlers, "integration.push.plan", { integrationID: IG })).toMatchObject({
      type: "lfs_missing",
    })
    expect(await invoke(s.handlers, "integration.push.execute", { nonce: "N".repeat(24) })).toMatchObject({
      type: "remote_rejected",
      data: { remote: "origin" },
    })
    // The decision records refuse a team that is off (declared `team_off`).
    expect(await invoke(s.handlers, "decisions.add", { teamID: TEAM_ID, title: "t", body: "" })).toMatchObject({
      type: "team_off",
    })
    expect(await invoke(s.handlers, "decisions.list", { teamID: TEAM_ID })).toEqual({ items: [] })
    failing.adopt = false
    expect(await invoke(s.handlers, "area.adopt", { teamID: TEAM_ID, directory: s.home })).toMatchObject({
      opID: expect.stringMatching(/^op_/),
    })
  })

  test("integration.get answers the checks' log text, never a path outside the team records folder", async () => {
    const s = await setup()
    const records = Teams.records(s.record)
    const log = path.join(records, "integrations", `${IG}.log`)
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.writeFileSync(log, "$ bun run typecheck\nerror TS2322: nope\n")
    const outside = path.join(s.home, "elsewhere.log")
    fs.writeFileSync(outside, "secret\n")
    const integration: OwnTeam.Integration = {
      id: OwnTeam.IntegrationID.make(IG),
      teamID: TEAM_ID,
      areaID: AREA_ID,
      state: "failed",
      target: "main",
      source: "a".repeat(40),
      base: "b".repeat(40),
      candidate: "c".repeat(40),
      how: "merge",
      verify: { code: { ok: false, ms: 10, failed: "bun run typecheck", log }, assets: "skipped" },
      failure: "verify",
      createdAt: 1,
    }
    const encode = Schema.encodeSync(OwnTeam.Integration)
    await s.h.services.write(TEAM_ID, () =>
      s.h.services.kv.set(Keys.integration(TEAM_ID, IG), Keys.toJson(encode(integration))),
    )
    expect(await invoke(s.handlers, "integration.get", { integrationID: IG })).toEqual({
      integration: {
        ...integration,
        verify: {
          ...integration.verify,
          code: { ok: false, ms: 10, failed: "bun run typecheck", log: fs.readFileSync(log, "utf8") },
        },
      },
    })
    const elsewhere = { ...integration, verify: { code: { ok: false, ms: 10, log: outside } } }
    await s.h.services.write(TEAM_ID, () =>
      s.h.services.kv.set(Keys.integration(TEAM_ID, IG), Keys.toJson(encode(elsewhere))),
    )
    expect(await invoke(s.handlers, "integration.get", { integrationID: IG })).toEqual({
      integration: { ...elsewhere, verify: { code: { ok: false, ms: 10 } } },
    })
  })
})

describe("area.paths{release}", () => {
  test("starts the user's release (Release.user): away from the extended safe point the folder is kept as busy", async () => {
    const home = await tempHome()
    cleanups.push(() => home[Symbol.asyncDispose]())
    const h = controller(new World(), {
      directory: home.root,
      clock: manual(),
      features: {
        safePoint: () => ({ check: async () => ({ ok: false, why: "session", sessionIDs: [] }) }),
      },
    })
    cleanups.push(h.close)
    const extra = { "Assets/Textures": { reason: "모델 수정", at: 1, bytes: 10 } }
    const record: OwnTeam.Area = {
      ...area({ slug: "ui", directory: path.join(home.root, "ui") }),
      shape: "code",
      cone: { extra, kept: {} },
    }
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put({
        ...team({ home: home.root }),
        heavy: { dirs: ["Assets/Textures"], measuredAt: null, forcedBytes: 0 },
      })
      await h.services.registry.areas.put(record)
    })
    const handlers = TeamRpc.create({ services: h.services, leader: () => true, log: Log.silent })
    const started = (await invoke(handlers, "area.paths", {
      teamID: TEAM_ID,
      areaID: record.id,
      release: ["Assets/Textures"],
    })) as { readonly opID: OwnTeam.OpID }
    expect(started.opID).toMatch(/^op_/)
    await h.services.runner.settled(started.opID)
    const op = await h.services.journal.get(TEAM_ID, started.opID)
    expect(op).toMatchObject({ kind: "paths", by: "user", state: "done", steps: [{ kind: "paths-release" }] })
    const after = await h.services.registry.areas.get(TEAM_ID, record.id)
    expect(after?.cone).toEqual({ extra, kept: { "Assets/Textures": "busy" } })
  })
})
