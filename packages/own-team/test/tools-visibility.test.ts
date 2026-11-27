// Team tools and who sees them (06 §2.8, §2.9, §5.8, TG16 registration part): eleven Code Mode tools in namespace `team` with
// plain JSON Schema inputs, pinned only `team_dispatch` and `team_report`; the agent-wide denies (also re-registered
// late after `plugin.updated`); registry identity checks that answer instead of throwing; and the permission write
// that calls own.accounts `session.approval.set` again without `computerUse`, keeping an existing computer allow.

import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Singleton } from "../src/singleton.js"
import { MainTools } from "../src/tools/main.js"
import { OwnerTools } from "../src/tools/owner.js"
import { Permissions } from "../src/tools/permissions.js"
import { manual } from "./support/clock.js"
import {
  type AgentInfo,
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  boot,
  buildId,
  controller,
  managedEnv,
  team,
  tempHome,
} from "./support/context.js"

const restore = managedEnv()
const homes: Array<{ [Symbol.asyncDispose](): Promise<void> }> = []
afterAll(async () => {
  restore()
  for (const home of homes) await home[Symbol.asyncDispose]()
})

async function booted() {
  const home = await tempHome()
  homes.push(home)
  const world = new World()
  const id = buildId("tools")
  const fake = await boot(world, {
    directory: home.root,
    options: { home: home.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
  })
  const services = Singleton.peek(id)!.controller.services
  const tool = (name: string) => {
    const found = fake.tools.find((item) => item.name === name)
    if (!found) throw new Error(`no tool ${name}`)
    return (sessionID: string, input: unknown) => found.execute(input, { sessionID })
  }
  return { home: home.root, world, fake, services, tool }
}

describe("registration", () => {
  // 06 §13.3, §4.12a: the worktree conversation tools in every conversation, and core's `git` strategy again.
  test("six worktree Code Mode tools in namespace worktree, without a permission gate, only start pinned; the git strategy", async () => {
    const h = await booted()
    const tools = Object.fromEntries(h.fake.worktreeTools.map((item) => [item.name, item]))
    expect(Object.keys(tools).sort()).toEqual(["cleanup", "integrate", "move", "send", "start", "status"])
    for (const item of h.fake.worktreeTools) {
      expect(item.options).toMatchObject({ namespace: "worktree", codemode: true })
      expect(item.options.permission).toBeUndefined()
      expect(item.options.pinned).toBe(item.name === "start")
    }
    expect(h.fake.strategies).toEqual([{ id: "git" }])
  })

  test("eleven Code Mode tools in namespace team with JSON Schema inputs; message is team.owner; only dispatch and report pinned", async () => {
    const h = await booted()
    expect(h.fake.namespaces.map((item) => item.name)).toEqual(["team"])
    const tools = Object.fromEntries(h.fake.tools.map((item) => [item.name, item]))
    expect(Object.keys(tools).sort()).toEqual(
      [
        "area",
        "control",
        "decide",
        "dispatch",
        "handoff",
        "integrate",
        "message",
        "need_paths",
        "reorganize",
        "report",
        "status",
      ].sort(),
    )
    const permission = (name: string) => tools[name]!.options.permission
    expect(["control", "dispatch", "reorganize", "decide"].map(permission)).toEqual([
      "team.main",
      "team.main",
      "team.main",
      "team.main",
    ])
    expect(["report", "need_paths", "handoff", "message"].map(permission)).toEqual([
      "team.owner",
      "team.owner",
      "team.owner",
      "team.owner",
    ])
    expect(["area", "status", "integrate"].map(permission)).toEqual(["team.member", "team.member", "team.member"])
    for (const item of h.fake.tools) {
      expect(item.options).toMatchObject({ namespace: "team", codemode: true })
      // Plain JSON data: no Effect schema crosses into the host (01 §17.0).
      expect(Schema.isSchema(item.input)).toBe(false)
      expect(JSON.parse(JSON.stringify(item.input))).toEqual(item.input)
      expect(item.output).toMatchObject({ type: "object", required: ["ok", "text"] })
    }
    expect(
      h.fake.tools
        .filter((item) => item.options.pinned)
        .map((item) => item.name)
        .sort(),
    ).toEqual(["dispatch", "report"])
    await h.fake.cleanup()
  })

  test("every agent gets the team denies last, once, and again after plugin.updated", async () => {
    const h = await booted()
    const agents: AgentInfo[] = [
      { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      { id: "explore", permissions: [{ action: "team.main", resource: "*", effect: "deny" }] },
    ]
    const editor = {
      list: () => agents,
      update: (id: string, update: (agent: AgentInfo) => void) => {
        const agent = agents.find((item) => item.id === id)
        if (agent) update(agent)
      },
    }
    const apply = () => h.fake.agentTransforms.forEach((transform) => transform?.(editor))
    apply()
    apply()
    for (const agent of agents) {
      const team = agent.permissions.filter((rule) => rule.action.startsWith("team."))
      expect(team).toEqual([...Permissions.DENY])
      expect(agent.permissions.slice(-3)).toEqual([...Permissions.DENY])
    }
    expect(agents[0]!.permissions[0]).toEqual({ action: "*", resource: "*", effect: "allow" })

    // The late registration (approved exception): after this Location's plugin.updated, and moved after each one.
    const updated = (id: string, directory: string) =>
      // SAFETY (test): a core event of the shape the client types describe.
      h.world.publish({ id, created: 1, type: "plugin.updated", location: { directory }, data: {} } as never)
    updated("evt_p1", h.home)
    for (let tries = 0; tries < 100 && h.fake.agentTransforms.length < 2; tries++) await Bun.sleep(5)
    expect(h.fake.agentTransforms).toHaveLength(2)
    updated("evt_p2", h.home)
    for (let tries = 0; tries < 100 && h.fake.agentTransforms.length < 3; tries++) await Bun.sleep(5)
    expect(h.fake.agentTransforms).toHaveLength(3)
    expect(h.fake.agentTransforms[1]).toBeNull()
    // Another Location's update moves nothing here.
    updated("evt_p3", path.join(h.home, "elsewhere"))
    await Bun.sleep(20)
    expect(h.fake.agentTransforms).toHaveLength(3)
    apply()
    expect(agents[1]!.permissions.filter((rule) => rule.action.startsWith("team."))).toEqual([...Permissions.DENY])
    await h.fake.cleanup()
  })
})

describe("identity checks", () => {
  test("only the registry's main and owners use the tools; everyone else gets a sentence, not an error", async () => {
    const h = await booted()
    await h.services.write(TEAM_ID, async () => {
      await h.services.registry.teams.put(team({ home: h.home }))
      await h.services.registry.areas.put(area({ slug: "ui", directory: path.join(h.home, "ui") }))
    })
    const status = h.tool("status")
    const report = h.tool("report")
    const dispatch = h.tool("dispatch")

    const stranger = await status("ses_somebody000000000000000001", {})
    expect(stranger).toEqual({ output: { ok: false, text: MainTools.NOT_TEAM }, content: MainTools.NOT_TEAM })
    // A child of the owner: its id is in no registry slot.
    expect((await report("ses_child0000000000000000000001", { kind: "done", text: "끝" })).content).toBe(
      MainTools.NOT_TEAM,
    )
    expect((await report(OLD_OWNER, { kind: "done", text: "끝" })).content).toBe(OwnerTools.PREVIOUS_OWNER)
    expect((await dispatch(OWNER_SESSION, { area: "ui", text: "x" })).content).toBe(MainTools.MAIN_ONLY)
    expect((await report(MAIN_SESSION, { kind: "done", text: "끝" })).content).toBe(OwnerTools.OWNER_ONLY)

    const mainStatus = await status(MAIN_SESSION, {})
    expect(mainStatus.output).toMatchObject({ ok: true })
    expect(String(mainStatus.content)).toContain("- ui: 쉬는 중")
    expect(String((await status(OWNER_SESSION, {})).content)).toContain("- ui:")
    expect((await status(MAIN_SESSION, { area: "nope" })).content).toBe(MainTools.NO_AREA)

    // The T2 tools answer with a sentence, never throw: the ui folder does not exist here.
    expect(await h.tool("integrate")(MAIN_SESSION, { area: "ui" })).toMatchObject({
      output: { ok: false, error: "broken" },
    })
    expect(String((await h.tool("decide")(MAIN_SESSION, { title: "t", body: "b" })).content)).toContain(
      "결정 기록 0001",
    )
    // No self-HTTP service in this harness, so the request is recorded and waits.
    expect((await dispatch(MAIN_SESSION, { area: "ui", text: "일" })).output).toMatchObject({
      ok: true,
      state: "waiting",
      why: "busy",
    })
    expect(String((await dispatch(MAIN_SESSION, { area: "ui" })).content)).toContain("입력이 올바르지 않습니다")

    await h.services.write(TEAM_ID, () => h.services.registry.teams.put(team({ home: h.home, state: "off" })))
    expect((await status(MAIN_SESSION, {})).content).toBe(MainTools.TEAM_OFF)
    await h.fake.cleanup()
  })
})

describe("permission writes", () => {
  async function setup() {
    const home = await tempHome()
    homes.push(home)
    const world = new World()
    const harness = controller(world, { directory: home.root, clock: manual() })
    world.sessions.set(OWNER_SESSION, {
      id: OWNER_SESSION,
      directory: home.root,
      permissions: [
        { action: "computer", resource: "*", effect: "allow" },
        { action: "edit", resource: "**", effect: "ask" },
        { action: "shell", resource: "**", effect: "ask" },
      ],
    })
    return { home: home.root, world, ...harness }
  }

  test("approval.set is called again with the mode only, and the computer allow stays", async () => {
    const h = await setup()
    h.world.accounts.set("session.approval.get", () => ({ mode: "ask", rules: [], children: { open: 0 } }))
    h.world.accounts.set("session.approval.set", (input) => ({ mode: "ask", patched: [OWNER_SESSION], input }))
    const granted = await Permissions.write(h.services, { sessionID: OWNER_SESSION, directory: h.home, role: "owner" })
    expect(granted).toEqual({ ok: true, mode: "ask" })
    expect(h.world.sessions.get(OWNER_SESSION)!.permissions).toEqual([
      { action: "team.owner", resource: "*", effect: "allow" },
      { action: "team.member", resource: "*", effect: "allow" },
      { action: "computer", resource: "*", effect: "allow" },
      { action: "edit", resource: "**", effect: "ask" },
      { action: "shell", resource: "**", effect: "ask" },
    ])
    expect(h.world.calls.map((item) => item.method)).toEqual(["session.approval.get", "session.approval.set"])
    // Exactly `{sessionID, mode}`: own.team never sets or forwards computer use.
    expect(h.world.calls[1]!.input).toEqual({ sessionID: OWNER_SESSION, mode: "ask" })

    const revoked = await Permissions.write(h.services, { sessionID: OWNER_SESSION, directory: h.home, role: null })
    expect(revoked).toEqual({ ok: true, mode: "ask" })
    expect(h.world.sessions.get(OWNER_SESSION)!.permissions).toEqual([
      { action: "computer", resource: "*", effect: "allow" },
      { action: "edit", resource: "**", effect: "ask" },
      { action: "shell", resource: "**", effect: "ask" },
    ])
    expect(h.world.calls.at(-1)).toEqual({
      method: "session.approval.set",
      input: { sessionID: OWNER_SESSION, mode: "ask" },
    })
    await h.close()
  })

  test("without an own bundle (custom) or without own.accounts, nothing is reset", async () => {
    const h = await setup()
    h.world.accounts.set("session.approval.get", () => ({ mode: "custom", rules: [], children: { open: 0 } }))
    expect(await Permissions.write(h.services, { sessionID: OWNER_SESSION, directory: h.home, role: "main" })).toEqual({
      ok: true,
      mode: "custom",
    })
    expect(h.world.calls.map((item) => item.method)).toEqual(["session.approval.get"])
    expect(h.world.sessions.get(OWNER_SESSION)!.permissions.slice(0, 2)).toEqual([...Permissions.rules("main")])

    h.world.accounts.clear()
    expect(await Permissions.write(h.services, { sessionID: OWNER_SESSION, directory: h.home, role: "owner" })).toEqual(
      {
        ok: true,
        mode: null,
      },
    )
    expect(h.world.sessions.get(OWNER_SESSION)!.permissions.slice(0, 2)).toEqual([...Permissions.rules("owner")])
    expect(
      await Permissions.write(h.services, {
        sessionID: "ses_missing00000000000000000001",
        directory: h.home,
        role: "owner",
      }),
    ).toMatchObject({ ok: false, error: "not_found" })
    await h.close()
  })
})
