// Merge round 11 (MR14): own's permission `evaluate` hooks tighten only, whatever order they run in. An approved
// extension allow lifts the ask core's rules gave, never one another own hook wrote with its reason (own-team's risky
// git commands), and an allow may not name GitHub writes or own's image tool.
import { describe, expect, test } from "bun:test"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { OwnGitHub, OwnImage } from "@own/protocol"
import { Effect } from "effect"
import { Rules } from "../../src/rules.js"
import { CreatorState } from "../../src/state.js"
import { CreatorStore } from "../../src/store.js"
import { manifest, tempDir } from "./fixtures.js"

type Event = { -readonly [Key in keyof PermissionEvaluation]: PermissionEvaluation[Key] }

const DIRECTORY = "D:\\work\\app"

async function hookWith(rules: ReadonlyArray<Record<string, unknown>>) {
  const store = new CreatorStore.Store(await tempDir())
  const created = await store.create(manifest("loose", { items: [{ type: "tool.rule", rules }] }), "model")
  if (!created.ok) throw new Error(JSON.stringify(created))
  const approved = await store.loosen("loose", 1, true)
  if (!approved.ok) throw new Error(JSON.stringify(approved))
  const state = new CreatorState.State(store, DIRECTORY)
  state.set(await store.read())
  const hooks: Array<(event: Event) => Effect.Effect<void>> = []
  const ctx = {
    permission: {
      hook: (_name: string, callback: (event: Event) => Effect.Effect<void>) =>
        Effect.sync(() => void hooks.push(callback)),
    },
    tool: { hook: () => Effect.void },
    session: {
      get: () => Effect.succeed({ agent: "build", metadata: {}, location: { directory: DIRECTORY } }),
    },
    location: { directory: DIRECTORY },
  }
  await Effect.runPromise(Effect.scoped(Rules.register(ctx as never, state)))
  return (event: Event) => Effect.runPromise(hooks[0]!(event))
}

/** own-team's hook (06 §4.9): a risky git command in a team area asks, with its reason. */
async function team(event: Event) {
  if (event.effect === "deny" || event.action !== "shell") return
  if (!event.resources.some((resource) => resource.startsWith("git push"))) return
  event.effect = "ask"
  event.message = "A push from a team area asks first."
}

const event = (effect: Event["effect"], resources = ["git push origin"]): Event => ({
  sessionID: "ses_compose" as Event["sessionID"],
  action: "shell",
  resources,
  effect,
})

describe("evaluate hooks compose (tighten only)", () => {
  const ALLOW_PUSH = [{ permission: "shell", pattern: "git push*", effect: "allow" }]

  test("an approved allow lifts core's ask", async () => {
    const creator = await hookWith(ALLOW_PUSH)
    const asked = event("ask")
    await creator(asked)
    expect(asked.effect).toBe("allow")
  })

  test("own-team's reasoned ask stays, in either order", async () => {
    const creator = await hookWith(ALLOW_PUSH)
    for (const effect of ["allow", "ask"] as const) {
      const teamFirst = event(effect)
      await team(teamFirst)
      await creator(teamFirst)
      const creatorFirst = event(effect)
      await creator(creatorFirst)
      await team(creatorFirst)
      expect([teamFirst.effect, creatorFirst.effect]).toEqual(["ask", "ask"])
    }
  })

  test("an extension's deny and ask hold against an earlier allow in either order", async () => {
    const creator = await hookWith([
      { permission: "shell", pattern: "git push*", effect: "deny", reason: "no pushes" },
      { permission: "shell", pattern: "git reset*", effect: "ask" },
    ])
    const denied = event("allow")
    await team(denied)
    await creator(denied)
    expect(denied.effect).toBe("deny")
    const asked = event("allow", ["git reset --hard"])
    await creator(asked)
    await team(asked)
    expect(asked.effect).toBe("ask")
  })

  // Stand-ins for every own hook that asks with a reason (the real ones live in own-accounts and own-team): each sets
  // `ask` with a message. An extension's approved allow must never lift one, whatever order the hooks run (L1/L2, MR15).
  const ownAsks: ReadonlyArray<readonly [string, (event: Event) => void]> = [
    ["own-accounts webAsk", (e) => { if (e.effect !== "deny") { e.effect = "ask"; e.message = "A web request asks first." } }],
    ["own-accounts github", (e) => { if (e.effect !== "deny") { e.effect = "ask"; e.message = "A GitHub write asks first." } }],
    ["own-team shell", (e) => { if (e.effect !== "deny" && e.action === "shell") { e.effect = "ask"; e.message = "A push from a team area asks first." } }],
    ["own-creator tool rule", (e) => { if (e.effect !== "deny") { e.effect = "ask"; e.message = "An extension's tool rule asks first." } }],
  ]
  test.each(ownAsks)("an extension allow never lifts %s's reasoned ask, in either order", async (_label, ownAsk) => {
    const creator = await hookWith(ALLOW_PUSH)
    for (const effect of ["allow", "ask"] as const) {
      const first = event(effect)
      ownAsk(first)
      await creator(first)
      const second = event(effect)
      await creator(second)
      ownAsk(second)
      expect([first.effect, second.effect]).toEqual(["ask", "ask"])
    }
  })

  test.each([OwnGitHub.WRITE_ACTION, OwnImage.TOOL])("an allow may not name %s", async (permission) => {
    const store = new CreatorStore.Store(await tempDir())
    const created = await store.create(
      manifest("sealed", { items: [{ type: "tool.rule", rules: [{ permission, effect: "allow" }] }] }),
      "model",
    )
    expect(created.ok).toBe(false)
  })
})
