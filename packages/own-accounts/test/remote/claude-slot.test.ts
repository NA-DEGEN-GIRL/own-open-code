// B8 (04 §8.11.4.3, §8.11.9, T9): the Claude slot of a remote service. `claudeSlot()` follows the PC's mirrored
// verdict and this Location's conflict check (its own claude-auth or `anthropic` connection), reloads the providers
// and re-checks the hidden agents when it changes, and raises `claude_remote_conflict`; the fold enables `anthropic`
// with no prices only then (registration tests); a remote session's Fast consent is the PC's, never stored here.
import { describe, expect, test } from "bun:test"
import { Kv, Plugin, type Broker } from "@own/protocol"
import type { RemoteHost } from "../../src/remote/host.js"
import { Register } from "../../src/rpc/register.js"
import { SessionID } from "@opencode/schema/session-id"
import { local, until, world } from "../plugins/support.js"
import { failure, rpcContext } from "../slots/support.js"
import { speedSetup } from "../speed/support.js"

const ROOT = "ses_root"
const sid = (id: string) => SessionID.make(id)

const OAUTH = { type: "credential", id: "crd_host", label: "Claude Max · host@example.com", method: "oauth" } as const

function remote(initial: Broker.ClaudeRemote["state"] | undefined) {
  const mirrored = { value: initial }
  const api = {
    claude: () =>
      mirrored.value === undefined
        ? undefined
        : { state: mirrored.value, fast: false, display: { label: null, shortLabel: "C", color: "orange" as const } },
  } as unknown as RemoteHost.Api
  return { api, mirrored }
}

describe("a remote service's Claude slot", () => {
  test("follows the mirrored verdict: enabled = detected and acknowledged, anything else is off", async () => {
    const pc = remote("enabled")
    await using w = await world({ remote: pc.api })
    await w.plugins.start()
    expect(w.plugins.claudeSlot()).toEqual({ detected: true, version: null, integrity: null, verified: true })
    expect(w.plugins.claudeConflict()).toBe(false)
    const before = { reloads: w.reloads.count, agents: w.reloads.agents }
    pc.mirrored.value = "consent"
    w.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "remote" })
    await until(() => !w.plugins.claudeSlot().detected)
    expect(w.plugins.claudeSlot()).toEqual({ detected: false, version: null, integrity: null, verified: false })
    // The provider fold and the hidden agents' check follow (02 §8.4 "전파", 07 §5.4).
    await until(() => w.reloads.count > before.reloads && w.reloads.agents > before.agents)
    // An older PC sends no verdict at all.
    pc.mirrored.value = undefined
    await w.plugins.refreshed()
    expect(w.plugins.claudeSlot().detected).toBe(false)
  })

  test("a Location with its own Claude login or claude-auth is a conflict: off, with claude_remote_conflict", async () => {
    const pc = remote("enabled")
    await using w = await world({ remote: pc.api })
    await w.plugins.start()
    w.connection = OAUTH
    await w.plugins.refreshed()
    expect(w.plugins.claudeConflict()).toBe(true)
    expect(w.plugins.claudeSlot().detected).toBe(false)
    expect(w.alerts.map((alert) => [alert.code, alert.severity, alert.accountID])).toEqual([
      ["claude_remote_conflict", "warning", "acc_claude_slot"],
    ])
    // Once per conflict, not per refresh.
    await w.plugins.refreshed()
    expect(w.alerts).toHaveLength(1)
    w.connection = undefined
    await w.plugins.refreshed()
    expect(w.plugins.claudeSlot().detected).toBe(true)
    // A claude-auth plugin loaded in this Location (the host's own `~/.claude` token): a conflict too.
    w.override = {
      entries: [
        local("own.accounts", `${w.own.accounts}/index.js`),
        local(Plugin.CLAUDE_AUTH_ID, `${w.root}/elsewhere/claude-auth/server.js`),
      ],
    }
    await w.plugins.refreshed()
    expect(w.plugins.claudeConflict()).toBe(true)
    expect(w.plugins.claudeSlot().detected).toBe(false)
    expect(w.alerts.filter((alert) => alert.code === "claude_remote_conflict")).toHaveLength(2)
  })

  test("the PC methods are refused on a remote service", () => {
    for (const method of ["plugin.claudeAuth.remote.ack", "plugin.claudeAuth.remote.set", "plugin.claudeAuth.fastAck"])
      expect<ReadonlyArray<string>>(Register.REMOTE_MANAGED).toContain(method)
  })
})

describe("Fast on a remote session (04 §8.11.9)", () => {
  test("without the PC's consent it is refused with recordOn local and nothing is stored here", async () => {
    await using s = await speedSetup({ claude: true, remote: { fast: false } })
    s.session(ROOT, "anthropic", "claude-opus-5-5")
    for (const consent of [undefined, true]) {
      const refused = await s.speed.set(
        { sessionID: sid(ROOT), speed: "fast", ...(consent === undefined ? {} : { consent }) },
        rpcContext(),
      )
      expect(failure(refused)).toMatchObject({ type: "speed_consent_required", data: { recordOn: "local" } })
    }
    expect(s.kv.values.has(Kv.ackClaudeFast)).toBe(false)
  })

  test("with the PC's consent mirrored, Fast is set like on the PC", async () => {
    await using s = await speedSetup({ claude: true, remote: { fast: true } })
    s.session(ROOT, "anthropic", "claude-opus-5-5")
    const result = await s.speed.set({ sessionID: sid(ROOT), speed: "fast" }, rpcContext())
    expect(result).toMatchObject({ dryRun: false, view: { choice: "fast" } })
    expect(s.kv.values.has(Kv.ackClaudeFast)).toBe(false)
  })
})
