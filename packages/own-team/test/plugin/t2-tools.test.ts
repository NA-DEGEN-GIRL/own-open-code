// `team_integrate` and `team_decide` since T2 (06 §2.8, §6.6, §7.1; TG16): the main records a decision and starts an
// integration; an owner integrates only its own area, and its call first does the `ready` clean check and records the
// candidate without waking the main; a child session and an archived (previous) owner are refused with a sentence; and
// the registered tool definitions and the agent-wide denies (all a non-team session's catalog depends on) hash to the
// recorded catalog snapshot. Git fixtures in temp folders, fake contexts, fake values only.

import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { OwnTeam } from "@own/protocol"
import { Digest } from "../../src/report/digest.js"
import { ReportEvents } from "../../src/report/events.js"
import { Singleton } from "../../src/singleton.js"
import { IntegrateTool } from "../../src/tools/integrate.js"
import { MainTools } from "../../src/tools/main.js"
import { OwnerTools } from "../../src/tools/owner.js"
import { Permissions } from "../../src/tools/permissions.js"
import { integrate, save } from "../fixtures/integrate.js"
import { head, temp } from "../fixtures/repo.js"
import {
  MAIN_SESSION,
  OLD_OWNER,
  OWNER_SESSION,
  TEAM_ID,
  World,
  area,
  boot,
  buildId,
  managedEnv,
  tempHome,
} from "../support/context.js"

const SLOW = 180_000

const restore = managedEnv()
const cleanups: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  restore()
})

/**
 * sha256 of the tool registration (namespace, each tool's name, description, input and output schema, options) and
 * of the agent-wide denies. A non-team session's request carries only Code Mode's fixed `execute`, and its catalog
 * lists no team tool because of the denies, so these are all it depends on. Recorded at c0cd7674dc: the T1 catalog
 * (2.0.18-own.6, `6985419633ef…`) with the new `team_integrate` and `team_decide` descriptions of design choice (e)
 * (decided 2026-10-03), the one catalog change of the T2 upgrade (`548bceee8f8d…`). Recorded again in T3 (T3.08): the
 * `team_reorganize` description and input text name the T3 actions (split, merge, retire, convert, 팀에 넣기; a move
 * only as a suggestion), the approved T3 catalog change (`997b4f39a0be…`). With it, in the same T3 upgrade (so a team
 * session still gets one catalog delta), `team_report` takes `assets` (with `ready`: the change needs an engine run,
 * so the integration runs the asset check, 4.10) and its description says so, approved 2026-10-05 (06 §11.1). Any
 * later catalog change records it again. Recorded again for area peers (동료, approved 2026-10-09): `team_dispatch`
 * takes `member` (an area peer by key or label) and its description names it, the `refused` state and `fresh` never
 * going with `member` (`e0015837661e…` before), and in the same release (one catalog delta per team session) for V+동료
 * (2026-10-09): `team_area` and `team_control`, `team_status` `detail`, `team_integrate` `tip` and `token`,
 * `team_reorganize` `token`, `team_dispatch` `member`, and the namespace's two sentences (`15a9803d4448…` was the
 * peers-only interim, never shipped). Recorded again for area messages (2026-10-16, 06 §5.8): `team_message` with action
 * `team.owner`, so only owners and peers get the one catalog delta; the team main's visible catalog, the namespace
 * description and the `team_status` description are unchanged (`463a0573933282d9…` before). In the same release (so a
 * team session still gets one catalog delta of each kind), team-mode convenience (2026-10-16, 06 §8.1, §5.5):
 * `team_reorganize` takes `preview` (its description's second line says what it does; the team main's one delta) and
 * `team_report` takes kind `relay` with a `kind` description (owners and peers, the same delta as `team_message`)
 * (`c3275a638e23f3ed…` before). Recorded again for RH-20 (2026-10-29): `team_control` takes `cancel {op?}` (취소 of
 * the op that waits) and its description's answer line names it; the team main's one delta (`7024250b6f51afb6…` before).
 * Recorded again for 담당 대화 바꾸기 (2026-11-12, and 2026-11-13 in the same release for `peer`): `team_control` takes
 * `seat {area, session or peer}`; its first line ends with `owner seat` (and says `confirm` for `confirms`, to stay
 * within the 120 characters an inline catalog shows) and a line of its own names the action; the team main's one delta
 * (`94edb713437d3efd…` before). Recorded again for 2.2.6-own.3 (2026-11-14): `team_area` takes `role {role}` and resume
 * hands back direct work, `team_reorganize` lists `userMade?` on `new` (the team main's one delta); owners and peers in
 * their one delta: `team_area`, `team_report` text 20,000 and its description, `team_message` text 20,000 and limits,
 * `team_need_paths` dirs 64 (`ac2b9170c92f17764a3d82901d8469489c9c61fd4306a5493afdeb1fe4c35f0b` before). Recorded again
 * for 2.2.6-own.6 (2026-11-17, L12): `team_area` takes `keep` and `unkeep` (내가 정한 영역), `team_reorganize` lists
 * `goal?` and `userMade?` on `rename`; one delta for the main and the owners (`2fcba3e98a6e…` before).
 */
const CATALOG_SNAPSHOT = "fe8024be1ca89f85e3fc55c218a16154888956792701177aa9c0bd358bb1be02"

/** A child of the main: it copies the main's permissions and metadata, but the registry does not know it. */
const CHILD = SessionID.make("ses_child000000000000000000001")

async function setup() {
  const box = temp("own-team-t2-tools-")
  cleanups.push(box.dispose)
  const fx = integrate(path.join(box.root, "repo"))
  const own = await tempHome()
  cleanups.push(() => own[Symbol.asyncDispose]())
  const id = buildId("t2-tools")
  const booted = await boot(new World(), {
    directory: fx.home,
    options: { home: own.root, buildId: id, lingerSeconds: 0, logLevel: "error" },
  })
  cleanups.push(booted.cleanup)
  const services = Singleton.peek(id)!.controller.services
  // `ask`: the advance waits for its confirm, so an integration started here stays where a test can see it.
  const record = { ...fx.team, policy: { ...OwnTeam.POLICY, mergeLocal: "ask" as const } }
  const other = area({ slug: "other", directory: path.join(box.root, "other") })
  await services.write(TEAM_ID, async () => {
    await services.registry.teams.put(record)
    await services.registry.areas.put(fx.area)
    await services.registry.areas.put({ ...other, owner: { sessionID: null, previous: [], attached: true } })
  })
  const tool = (name: string) => {
    const found = booted.tools.find((item) => item.name === name)
    if (!found) throw new Error(`no tool ${name}`)
    return async (sessionID: string, input: unknown) => {
      const result = await found.execute(input, { sessionID })
      // SAFETY (test): every team tool returns its reply `{ok, text, …}` as output.
      return result.output as MainTools.Reply
    }
  }
  return { fx, services, booted, tool, other }
}

describe("team_decide and team_integrate for the team main", () => {
  test(
    "the main writes decision records and integrates only a reported candidate",
    async () => {
      const s = await setup()
      const decide = s.tool("decide")
      const first = await decide(MAIN_SESSION, { title: "필드 이름은 snake_case", body: "저장 형식 v3부터" })
      expect(first).toMatchObject({ ok: true, number: 1, file: "decisions/0001-snake-case.md" })
      expect(first.text).toContain("결정 기록 0001")
      expect(await decide(MAIN_SESSION, { title: "UI first", body: "", areas: ["ui"] })).toMatchObject({
        ok: true,
        number: 2,
        file: "decisions/0002-ui-first.md",
      })
      expect(await decide(MAIN_SESSION, { title: "x", body: "", areas: ["nope"] })).toEqual({
        ok: false,
        text: MainTools.NO_AREA,
      })
      const listed = await s.services.features().decisions.list(TEAM_ID)
      if (!listed.ok) throw new Error(listed.message)
      expect(listed.items.map((item) => [item.number, item.source, item.areas])).toEqual([
        [1, "main", []],
        [2, "main", [s.fx.area.id]],
      ])

      // No candidate yet: the main is told to wait for the owner's `ready` (7.1).
      const integrate = s.tool("integrate")
      const refused = await integrate(MAIN_SESSION, { area: "ui" })
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain('team_report(kind:"ready")')
      expect(await s.services.journal.active(TEAM_ID)).toBeUndefined()

      const tip = save(s.fx.area.directory, { "src/area.ts": "area\n" })
      await s.services.write(TEAM_ID, async () =>
        s.services.registry.areas.put({ ...s.fx.area, candidate: { sha: tip, at: 1, text: "끝" } }),
      )
      const started = await integrate(MAIN_SESSION, { area: "ui" })
      const opID = String(started.opID)
      expect(started.ok).toBe(true)
      expect(opID).toMatch(/^op_/)
      const op = await until(async () => {
        const found = await s.services.journal.get(TEAM_ID, opID)
        return found?.state === "waiting" ? found : undefined
      })
      expect(op).toMatchObject({ kind: "integrate", by: "main", areaID: s.fx.area.id })
      expect(op.steps.at(-1)).toMatchObject({ kind: "integrate-advance", state: "needs_confirm" })
    },
    SLOW,
  )
})

describe("team_integrate for an owner", () => {
  test(
    "its own area only: the ready clean check, then the candidate, without waking the main",
    async () => {
      const s = await setup()
      const integrate = s.tool("integrate")
      expect(await integrate(OWNER_SESSION, { area: "other" })).toEqual({
        ok: false,
        text: IntegrateTool.OWN_AREA_ONLY,
      })

      // A changed tracked file: refused with the `ready` sentence, nothing recorded.
      const tip = save(s.fx.area.directory, { "src/area.ts": "area\n" })
      fs.writeFileSync(path.join(s.fx.area.directory, "src", "app.ts"), "edited\n")
      const dirty = await integrate(OWNER_SESSION, { area: "ui" })
      expect(dirty).toMatchObject({ ok: false, error: "dirty" })
      expect(dirty.text).toContain(ReportEvents.DIRTY)
      expect((await s.services.registry.areas.get(TEAM_ID, s.fx.area.id))?.candidate).toBeUndefined()
      fs.writeFileSync(path.join(s.fx.area.directory, "src", "app.ts"), "export const app = 1\n")

      const started = await integrate(OWNER_SESSION, { area: "ui" })
      const opID = String(started.opID)
      expect(started.ok).toBe(true)
      expect(String(started.integrationID)).toMatch(/^ig_/)
      const after = await s.services.registry.areas.get(TEAM_ID, s.fx.area.id)
      expect(after?.candidate).toMatchObject({ sha: tip, text: ReportEvents.INTEGRATE_TEXT })
      expect(after?.candidate?.sha).toBe(head(s.fx.area.directory))
      expect(after?.status.kind).not.toBe("ready")
      const op = await until(async () => {
        const found = await s.services.journal.get(TEAM_ID, opID)
        return found?.state === "waiting" ? found : undefined
      })
      expect(op).toMatchObject({ kind: "integrate", by: "auto", areaID: s.fx.area.id })
      // No report, no wake: nothing in the digest asks for the main (5.6).
      const digest = await Digest.load(s.services.kv, TEAM_ID)
      expect(digest.entries.filter((entry) => entry.wake)).toEqual([])
      expect(digest.areas[s.fx.area.id]?.reports.ready).toBeUndefined()
      expect(digest.pending).toBeNull()
    },
    SLOW,
  )
})

describe("who may call them (06 §2.8, TG16)", () => {
  test(
    "a child session and an archived owner get a sentence, never an error",
    async () => {
      const s = await setup()
      const integrate = s.tool("integrate")
      const decide = s.tool("decide")
      expect(await integrate(CHILD, { area: "ui" })).toEqual({ ok: false, text: MainTools.NOT_TEAM })
      expect(await decide(CHILD, { title: "t", body: "" })).toEqual({ ok: false, text: MainTools.NOT_TEAM })
      expect(await integrate(OLD_OWNER, { area: "ui" })).toEqual({ ok: false, text: OwnerTools.PREVIOUS_OWNER })
      expect(await decide(OLD_OWNER, { title: "t", body: "" })).toEqual({ ok: false, text: MainTools.NOT_TEAM })
      expect(await decide(OWNER_SESSION, { title: "t", body: "" })).toEqual({ ok: false, text: MainTools.MAIN_ONLY })
      expect(await s.services.journal.active(TEAM_ID)).toBeUndefined()
      const listed = await s.services.features().decisions.list(TEAM_ID)
      expect(listed.ok && listed.items).toEqual([])
    },
    SLOW,
  )

  test("the registered definitions and the agent denies hash to the catalog snapshot", async () => {
    const s = await setup()
    const registration = {
      namespaces: s.booted.namespaces,
      tools: s.booted.tools.map((item) => ({
        name: item.name,
        description: item.description,
        input: item.input,
        output: item.output,
        options: item.options,
      })),
      deny: Permissions.DENY,
    }
    expect(createHash("sha256").update(JSON.stringify(registration)).digest("hex")).toBe(CATALOG_SNAPSHOT)
    expect(s.booted.tools.find((item) => item.name === "integrate")?.input).toEqual({
      type: "object",
      properties: {
        area: { type: "string", description: "Area id, slug or name." },
        tip: {
          type: "boolean",
          description: "The area's current state when no ready report came (team main; a plan).",
        },
        token: { type: "string" },
      },
      required: ["area"],
      additionalProperties: false,
    })
    // 2026-10-16: the main's preview and the owners' and peers' relay (06 §8.1, §5.5).
    const reorganize = s.booted.tools.find((item) => item.name === "reorganize")
    expect(reorganize?.input).toMatchObject({
      properties: {
        preview: {
          type: "boolean",
          description: "true: only check the proposal and say what applying it now would do; nothing changes.",
        },
      },
    })
    expect(reorganize?.input).not.toMatchObject({ required: expect.arrayContaining(["preview"]) })
    const report = s.booted.tools.find((item) => item.name === "report")
    expect(report?.input).toMatchObject({
      properties: { kind: { type: "string", enum: ["progress", "done", "ready", "blocked", "relay"] } },
    })
    const message = s.booted.tools.find((item) => item.name === "message")
    expect(message?.options).toMatchObject({ permission: "team.owner", codemode: true, pinned: false })
    // The first line is what an inline catalog shows (06 §2.8).
    expect(message?.description.split("\n")[0]?.length).toBeLessThanOrEqual(120)
    // 2026-11-12: the main's spoken seat move; its first line names it and is not clipped.
    const control = s.booted.tools.find((item) => item.name === "control")
    expect(control?.description.split("\n")[0]).toEndWith("owner seat.")
    expect(control?.description.split("\n")[0]?.length).toBeLessThanOrEqual(120)
    expect(control?.input).toMatchObject({ properties: { action: { enum: expect.arrayContaining(["seat"]) } } })
    // 2026-11-13: a peer is named as `team_status` lists it.
    expect(control?.description).toContain("seat {area, session or peer}: ")
    // 2026-11-14: role edits, whole report texts, more large-file folders and the main's standing areas.
    const area = s.booted.tools.find((item) => item.name === "area")
    const first = area?.description.split("\n")[0] ?? ""
    expect(first.length).toBeLessThanOrEqual(120)
    expect(first).toEndWith("cancel.")
    expect(area?.input).toMatchObject({
      properties: {
        action: { enum: expect.arrayContaining(["role", "keep", "unkeep"]) },
        role: { type: "string", description: expect.any(String) },
      },
    })
    expect(report?.input).toMatchObject({ properties: { text: { maxLength: 20000 } } })
    expect(s.booted.tools.find((item) => item.name === "need_paths")?.input).toMatchObject({
      properties: { dirs: { maxItems: 64 } },
    })
    expect(reorganize?.description).toContain("userMade?")
    expect(message?.input).toEqual({
      type: "object",
      properties: {
        kind: { type: "string", enum: ["ask", "reply", "note", "watch"] },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Your message; with watch, what you will do then.",
        },
        to: { type: "string", description: "Area id, slug or name (not with reply)." },
        member: {
          type: "string",
          minLength: 1,
          description: "A peer (key or label) of that area instead of its owner.",
        },
        id: { type: "string", description: "With reply: the id of the ask's envelope." },
        on: { type: "string", enum: ["ready", "integrated"], description: "With watch: ready or integrated." },
      },
      required: ["kind", "text"],
      additionalProperties: false,
    })
  })
})

/** Waits (real time) until `check` answers something. */
async function until<T>(check: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error("timed out")
    await Bun.sleep(50)
  }
}
