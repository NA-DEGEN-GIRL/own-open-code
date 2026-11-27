// Computer use in own-web (01 §10.2): the `own.computer` client contract against the real definition, the
// ComputerStore over a fake client and the real event bus, the per-session switch over a fake own.accounts router
// (answers like switching.ts `approvalGet` / `approvalSet`), the dialog's switch states, and the strings.
import { afterEach, describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent, PermissionRule } from "@opencode/client"
import type { Approval } from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { createRoot, createSignal } from "solid-js"
import type { ComputerRpc, ComputerStatus } from "@/data"
import {
  COMPUTER_ID,
  COMPUTER_SCOPE,
  computerAllowed,
  computerEvent,
  createComputerRpc,
  type ComputerMethod,
} from "@/data/computer-rpc"
import { createEventBus } from "@/data/events"
import { ALL_SCOPES, OwnRpcError, type OwnScope } from "@/data/rpc"
import { panelEn, panelKo, panelText } from "./panel-strings"
import { COMPUTER_ALLOW, computerUseOf, createComputerStore, type ComputerStore } from "./state"
import { computerEn, computerKo, computerText } from "./strings"
import {
  ComputerSwitchError,
  createComputerSwitch,
  createComputerToggle,
  type ComputerSwitch,
  type ComputerSwitchCheck,
  type ComputerSwitchRuntime,
} from "./switch"

const SESSION = "ses_computer_test_aaaaaaaaaaaa"
const ask: PermissionRule = { action: "edit", resource: "**", effect: "ask" }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const STATUS: ComputerStatus = {
  available: true,
  buildId: "0123456789ab",
  version: "2.0.18-own.4",
  driver: "windows",
  approval: "session",
  policy: { allowApps: [], denyApps: [], allowTerminals: false, allowSubagents: false },
  helper: { running: false },
  killSwitch: { engaged: false },
  lease: { holder: null },
  grants: [],
}

describe("own.computer client contract", () => {
  test("id and scope table match the definition", () => {
    expect(COMPUTER_ID).toBe(OwnComputer.ID)
    expect(COMPUTER_SCOPE).toEqual(OwnComputer.MethodScope)
    expect(Object.keys(COMPUTER_SCOPE).sort()).toEqual(Object.keys(OwnComputer.Definition.methods).sort())
  })

  test("PC windows may call everything; a scope set without local only reads and stops", () => {
    for (const method of Object.keys(COMPUTER_SCOPE) as ComputerMethod[])
      expect(computerAllowed(COMPUTER_SCOPE[method], ALL_SCOPES)).toBe(true)
    const device = new Set<OwnScope>(["read", "prompt"])
    expect(computerAllowed("read", device)).toBe(true)
    expect(computerAllowed("drive", device)).toBe(true)
    expect(computerAllowed("drive", new Set<OwnScope>(["read"]))).toBe(false)
    expect(computerAllowed("local", device)).toBe(false)
    // The data layer gives gateway devices no scope yet: the gateway would pass status and Stop to a device with prompt
    // or switch (own-remote Policy.COMPUTER_METHODS), but the phone UI does not call them (follow-up).
    expect(computerAllowed("read", new Set())).toBe(false)
  })

  test("events: both declared names parse; other names and ids are ignored", () => {
    for (const name of Object.keys(OwnComputer.Events)) {
      const event = computerEvent({ type: `rpc.own.computer.${name}`, data: { at: 1 } } as unknown as OpenCodeEvent)
      expect(event?.name).toBe(name as never)
    }
    expect(computerEvent({ type: "rpc.own.computer.unknown", data: {} } as unknown as OpenCodeEvent)).toBeUndefined()
    expect(computerEvent({ type: "rpc.own.accounts.status", data: {} } as unknown as OpenCodeEvent)).toBeUndefined()
    expect(computerEvent({ type: "rpc.own.computer.status" } as unknown as OpenCodeEvent)).toBeUndefined()
  })

  test("calls go to the control location under own.computer; RPC errors become OwnRpcError; scopes gate", async () => {
    const sent: unknown[] = []
    let fail: unknown
    const client = {
      rpc: {
        call: async (request: unknown) => {
          sent.push(request)
          if (fail) throw fail
          return { output: STATUS }
        },
      },
    } as unknown as OpenCodeClient
    const [scopes, setScopes] = createSignal<ReadonlySet<OwnScope>>(ALL_SCOPES)
    const rpc = createComputerRpc({ client: () => client, control: async () => "C:/control", scopes })
    expect(await rpc.call("status", {})).toEqual(STATUS)
    expect(sent).toEqual([
      { rpcID: "own.computer", method: "status", input: {}, location: { directory: "C:/control" } },
    ])

    fail = { _tag: "RpcError", type: "rpc.method_not_found", message: "no such method" }
    const error = await rpc.call("status", {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OwnRpcError)
    expect(error).toMatchObject({ type: "rpc.method_not_found", message: "no such method" })

    setScopes(new Set<OwnScope>(["read", "prompt"]))
    expect(rpc.allowed("killswitch.engage")).toBe(true)
    expect(rpc.allowed("killswitch.reset")).toBe(false)
    await expect(rpc.call("killswitch.reset", {})).rejects.toMatchObject({ type: "own.scope_denied" })
    expect(sent).toHaveLength(2)
  })
})

describe("computerUseOf (own.accounts computerUseOf, the plugin gate's rule)", () => {
  test("on only when the last rule matching `computer` is exactly the allow", () => {
    expect(computerUseOf(undefined)).toBe("off")
    expect(computerUseOf([ask])).toBe("off")
    expect(computerUseOf([COMPUTER_ALLOW])).toBe("on")
    // Written before the own bundle: later rules that do not match `computer` keep it on.
    expect(computerUseOf([COMPUTER_ALLOW, ask, { action: "read", resource: "*.env", effect: "deny" }])).toBe("on")
    // A later matching rule wins, wildcards included; a wildcard allow is not the consent.
    expect(computerUseOf([COMPUTER_ALLOW, { action: "comp*", resource: "*", effect: "deny" }])).toBe("off")
    expect(computerUseOf([COMPUTER_ALLOW, { action: "computer", resource: "notepad", effect: "deny" }])).toBe("off")
    expect(computerUseOf([{ action: "*", resource: "*", effect: "allow" }])).toBe("off")
    expect(computerUseOf([{ action: "computer", resource: "*", effect: "ask" }])).toBe("off")
  })
})

/** The ComputerStore over the real event bus and a fake `own.computer` client. */
function storeHarness(input: { connected?: boolean; fail?: unknown; activeMs?: number; status?: ComputerStatus } = {}) {
  const bus = createEventBus()
  const calls: Array<{ method: string; input: unknown }> = []
  const answers = { status: input.status ?? STATUS, fail: input.fail, pending: undefined as Promise<void> | undefined }
  const rpc = {
    allowed: () => true,
    async call(method: string, payload: unknown) {
      calls.push({ method, input: payload })
      if (answers.pending) await answers.pending
      if (answers.fail) throw answers.fail
      switch (method) {
        case "status":
          return answers.status
        case "killswitch.engage":
          return { engaged: true, reason: "rpc", at: 5 }
        case "killswitch.reset":
          return { engaged: false }
        case "helper.restart":
          return { running: false }
        case "session.grants.revoke":
          return { sessionID: (payload as { sessionID: string }).sessionID, apps: [] }
        case "audit.list":
          return {
            entries: [{ ts: 1, sessionID: SESSION, callID: "c1", tool: "screenshot", args: {}, outcome: "ok", ms: 3 }],
          }
      }
      throw new Error(`unexpected ${method}`)
    },
  } as unknown as ComputerRpc
  const local = { bus, connection: { status: () => (input.connected ? "connected" : "connecting") } }
  let store!: ComputerStore
  const dispose = createRoot((dispose) => {
    store = createComputerStore({ data: { computer: rpc, local: () => local }, activeMs: input.activeMs })
    return dispose
  })
  const emit = (type: string, data?: unknown) => {
    bus.publish({ type, data: data ?? {} } as unknown as OpenCodeEvent)
    bus.flush()
  }
  return {
    store,
    calls,
    answers,
    emit,
    connected: () => emit("server.connected"),
    action: (patch: Partial<OwnComputer.Action> = {}) =>
      emit("rpc.own.computer.action", {
        sessionID: SESSION,
        tool: "left_click",
        app: "notepad",
        outcome: "ok",
        at: 10,
        ...patch,
      }),
    cleanup() {
      store.dispose()
      dispose()
      bus.dispose()
    },
  }
}

let harness: ReturnType<typeof storeHarness> | undefined
afterEach(() => {
  harness?.cleanup()
  harness = undefined
})

describe("ComputerStore", () => {
  test("nothing is asked until something needs it: no request at startup or on connect", async () => {
    harness = storeHarness()
    harness.connected()
    await tick()
    expect(harness.store.state.load).toBe("idle")
    expect(harness.calls).toEqual([])
  })

  test("ensure before the stream is up asks once it connects; reconnects ask again; available gates the UI", async () => {
    harness = storeHarness()
    harness.store.ensure()
    expect(harness.calls).toEqual([])
    harness.connected()
    expect(harness.store.state.load).toBe("loading")
    await tick()
    expect(harness.store.state.load).toBe("ready")
    expect(harness.store.state.status).toEqual(STATUS)
    expect(harness.store.available()).toBe(true)
    // A second ensure does nothing; the next server.connected (service restart) asks again.
    harness.store.ensure()
    harness.connected()
    await tick()
    expect(harness.calls).toEqual([
      { method: "status", input: {} },
      { method: "status", input: {} },
    ])
  })

  test("ensure on an open stream asks at once; an unavailable plugin is ready but not available", async () => {
    harness = storeHarness({
      connected: true,
      status: { available: false, reason: "unsupported", buildId: "dev", version: "0.0.0-dev" },
    })
    harness.store.ensure()
    await tick()
    expect(harness.store.state.load).toBe("ready")
    expect(harness.store.available()).toBe(false)
    // refresh asks again even after an answer (the settings page on open).
    harness.store.refresh()
    await tick()
    expect(harness.calls).toHaveLength(2)
  })

  test("no plugin (or a refused call): missing with the error type, and nothing is available", async () => {
    harness = storeHarness({ connected: true, fail: new OwnRpcError("rpc.unavailable", "no rpc") })
    harness.store.ensure()
    await tick()
    expect(harness.store.state.load).toBe("missing")
    expect(harness.store.state.error).toBe("rpc.unavailable")
    expect(harness.store.available()).toBe(false)
    // Asked once: a later ensure does not repeat a failing call.
    harness.store.ensure()
    await tick()
    expect(harness.calls).toHaveLength(1)
  })

  test("a status event replaces the status, wins over a call still on its way, and makes reconnects ask", async () => {
    harness = storeHarness({ connected: true })
    let release!: () => void
    harness.answers.pending = new Promise((resolve) => (release = resolve))
    harness.store.ensure()
    const engaged = { ...STATUS, killSwitch: { engaged: true, reason: "user_chord", at: 7 } } as ComputerStatus
    harness.emit("rpc.own.computer.status", engaged)
    expect(harness.store.state.status?.killSwitch).toEqual({ engaged: true, reason: "user_chord", at: 7 })
    release()
    await tick()
    // The older answer of the call does not overwrite the event.
    expect(harness.store.state.status?.killSwitch?.engaged).toBe(true)

    // A window that never asked still takes events, and then refreshes after a reconnect.
    harness.cleanup()
    harness = storeHarness()
    harness.emit("rpc.own.computer.status", STATUS)
    expect(harness.store.available()).toBe(true)
    harness.connected()
    await tick()
    expect(harness.calls).toEqual([{ method: "status", input: {} }])
  })

  test("action events: de-duplicated across Locations, mark the session active for a while, notify listeners", async () => {
    harness = storeHarness({ activeMs: 30 })
    const seen: string[] = []
    const stop = harness.store.onAction((action) => seen.push(`${action.tool}@${action.at}`))
    harness.action()
    // Every Location's instance republishes the same notice.
    harness.action()
    expect(seen).toEqual(["left_click@10"])
    expect(harness.store.state.active[SESSION]).toBe(true)
    expect(harness.store.state.last[SESSION]).toMatchObject({ tool: "left_click", app: "notepad" })
    harness.action({ tool: "type", at: 11, app: "chrome" })
    expect(seen).toEqual(["left_click@10", "type@11"])
    expect(harness.store.state.last[SESSION]?.app).toBe("chrome")
    await sleep(60)
    expect(harness.store.state.active[SESSION]).toBe(false)
    stop()
    harness.action({ at: 12 })
    expect(seen).toHaveLength(2)
  })

  test("Stop, reset, helper restart and revoke patch the status; audit passes the query", async () => {
    harness = storeHarness({
      connected: true,
      status: { ...STATUS, grants: [{ sessionID: SESSION as never, apps: ["notepad"] }] },
    })
    harness.store.ensure()
    await tick()
    expect(harness.store.state.status?.grants).toHaveLength(1)
    await harness.store.engage()
    expect(harness.store.state.status?.killSwitch).toEqual({ engaged: true, reason: "rpc", at: 5 })
    await harness.store.reset()
    expect(harness.store.state.status?.killSwitch).toEqual({ engaged: false })
    await harness.store.restartHelper()
    expect(harness.store.state.status?.helper).toEqual({ running: false })
    await harness.store.revoke(SESSION as never)
    expect(harness.store.state.status?.grants).toEqual([])
    expect(await harness.store.audit({ limit: 20 })).toHaveLength(1)
    expect(harness.calls.map((call) => call.method)).toEqual([
      "status",
      "killswitch.engage",
      "killswitch.reset",
      "helper.restart",
      "session.grants.revoke",
      "audit.list",
    ])
    expect(harness.calls.at(-1)?.input).toEqual({ limit: 20 })
  })

  test("dispose stops listening", async () => {
    harness = storeHarness()
    harness.store.ensure()
    harness.store.dispose()
    harness.connected()
    harness.action()
    await tick()
    expect(harness.calls).toEqual([])
    expect(harness.store.state.active[SESSION]).toBeUndefined()
  })
})

/** A fake own.accounts router with one session's rules (answers like `approvalGet` / `approvalSet`). */
function fakeRouter(input: { rules: PermissionRule[]; mode?: Approval.Mode; legacy?: boolean; admin?: boolean }) {
  let rules = [...input.rules]
  const mode = input.mode ?? "ask"
  const calls: { method: string; payload: unknown }[] = []
  const synced: string[] = []
  const [status, setStatus] = createSignal("connected")
  let fail: Error | undefined
  const runtime: ComputerSwitchRuntime = {
    rpc: {
      allowed: () => input.admin ?? true,
      // SAFETY: the fake answers exactly the two approval methods with their protocol shapes.
      call: (async (method: string, payload: { sessionID: string; mode?: string; computerUse?: "on" | "off" }) => {
        calls.push({ method, payload })
        if (fail) throw fail
        if (method === "session.approval.get")
          return {
            mode,
            rules,
            children: { open: 0 },
            ...(input.legacy ? {} : { computerUse: computerUseOf(rules) }),
          } satisfies Approval.State
        if (method === "session.approval.set") {
          const rest = rules.filter((rule) => !(rule.action === "computer" && rule.effect === "allow"))
          if (payload.computerUse === "on") rules = [...rest, COMPUTER_ALLOW]
          if (payload.computerUse === "off") rules = rest
          return {
            mode: payload.mode as Approval.SetMode,
            patched: [payload.sessionID as never],
            ...(payload.computerUse ? { computerUse: computerUseOf(rules) } : {}),
          } satisfies Approval.SetResult
        }
        throw new Error(`unexpected ${method}`)
      }) as unknown as ComputerSwitchRuntime["rpc"]["call"],
    },
    connection: { status },
    data: {
      session: {
        invalidate: (id) => void synced.push(`invalidate:${id}`),
        sync: async (id) => void synced.push(`sync:${id}`),
      },
    },
  }
  return { runtime, calls, synced, rules: () => rules, setStatus, failWith: (error?: Error) => void (fail = error) }
}

describe("per-session switch (session.approval.get/set{computerUse})", () => {
  test("on: set with the current mode; the session is read again; off removes the allow", async () => {
    const router = fakeRouter({ rules: [ask], mode: "full" })
    const writer = createComputerSwitch(router.runtime)
    expect(await writer.check(SESSION)).toEqual({ ok: true, mode: "full" })
    expect(await writer.set(SESSION, "on")).toBe("on")
    expect(router.calls.at(-1)).toEqual({
      method: "session.approval.set",
      payload: { sessionID: SESSION, mode: "full", computerUse: "on" },
    })
    expect(router.rules()).toEqual([ask, COMPUTER_ALLOW])
    expect(router.synced).toEqual([`invalidate:${SESSION}`, `sync:${SESSION}`])
    expect(await writer.set(SESSION, "off")).toBe("off")
    expect(router.rules()).toEqual([ask])
  })

  test("already in the asked state: no write, the session is read again", async () => {
    const router = fakeRouter({ rules: [ask, COMPUTER_ALLOW] })
    expect(await createComputerSwitch(router.runtime).set(SESSION, "on")).toBe("on")
    expect(router.calls.map((call) => call.method)).toEqual(["session.approval.get"])
    expect(router.synced).toEqual([`invalidate:${SESSION}`, `sync:${SESSION}`])
  })

  test("custom mode, an older service, no admin scope, no connection: refused before any write", async () => {
    const custom = createComputerSwitch(fakeRouter({ rules: [ask], mode: "custom" }).runtime)
    expect(await custom.check(SESSION)).toEqual({ ok: false, reason: "custom" })
    await expect(custom.set(SESSION, "on")).rejects.toBeInstanceOf(ComputerSwitchError)

    const legacy = fakeRouter({ rules: [ask], legacy: true })
    const old = createComputerSwitch(legacy.runtime)
    expect(await old.check(SESSION)).toEqual({ ok: false, reason: "unsupported" })
    await expect(old.set(SESSION, "on")).rejects.toMatchObject({ reason: "unsupported" })
    // Nothing was written to a service that would drop the unknown field and only rewrite the mode.
    expect(legacy.calls.some((call) => call.method === "session.approval.set")).toBe(false)

    const device = fakeRouter({ rules: [ask], admin: false })
    expect(await createComputerSwitch(device.runtime).check(SESSION)).toEqual({ ok: false, reason: "scope" })
    await expect(createComputerSwitch(device.runtime).set(SESSION, "on")).rejects.toMatchObject({ reason: "scope" })
    expect(device.calls).toEqual([])

    const offline = fakeRouter({ rules: [ask] })
    offline.setStatus("reconnecting")
    expect(await createComputerSwitch(offline.runtime).check(SESSION)).toEqual({ ok: false, reason: "unavailable" })

    const broken = fakeRouter({ rules: [ask] })
    broken.failWith(new Error("network"))
    expect(await createComputerSwitch(broken.runtime).check(SESSION)).toEqual({ ok: false, reason: "unavailable" })
    // A write that fails is a plain error (the dialog keeps the confirmation for another try).
    await expect(createComputerSwitch(broken.runtime).set(SESSION, "on")).rejects.not.toBeInstanceOf(
      ComputerSwitchError,
    )
  })
})

/** A scripted switch: `check` and `set` resolve when the test says so. */
function scriptedSwitch() {
  const checks: { sessionID: string; resolve: (value: ComputerSwitchCheck) => void }[] = []
  const sets: {
    sessionID: string
    use: Approval.ComputerUse
    resolve: (value: Approval.ComputerUse) => void
    reject: (error: unknown) => void
  }[] = []
  const writer: ComputerSwitch = {
    check: (sessionID) => new Promise((resolve) => checks.push({ sessionID, resolve })),
    set: (sessionID, use) => new Promise((resolve, reject) => sets.push({ sessionID, use, resolve, reject })),
  }
  return { writer, checks, sets }
}

function mountToggle(input: { writer?: ComputerSwitch; rules?: PermissionRule[]; vision?: boolean }) {
  return createRoot((dispose) => {
    const [writer] = createSignal(input.writer)
    const [sessionID, setSessionID] = createSignal(SESSION)
    const [rules, setRules] = createSignal<PermissionRule[] | undefined>(input.rules ?? [ask])
    const [vision, setVision] = createSignal<boolean | undefined>(input.vision)
    const toggle = createComputerToggle({ writer, sessionID, rules, vision })
    return { toggle, setSessionID, setRules, setVision, dispose }
  })
}

describe("dialog switch", () => {
  test("off → confirm (consent) → busy → on; the result shows until the rules land; cancel goes back", async () => {
    const script = scriptedSwitch()
    const view = mountToggle({ writer: script.writer })
    expect(view.toggle.view()).toBe("checking")
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.toggle.view()).toBe("off")
    await view.toggle.flip()
    expect(view.toggle.view()).toBe("confirm")
    view.toggle.cancel()
    expect(view.toggle.view()).toBe("off")
    await view.toggle.flip()
    const applying = view.toggle.confirm()
    expect(view.toggle.view()).toBe("busy")
    // A second press while the write runs does nothing.
    await view.toggle.confirm()
    expect(script.sets).toHaveLength(1)
    expect(script.sets[0]).toMatchObject({ sessionID: SESSION, use: "on" })
    script.sets[0]!.resolve("on")
    await applying
    expect(view.toggle.view()).toBe("on")
    expect(view.toggle.use()).toBe("on")
    // `session.permissions` brings the allow; the state now comes from the rules.
    view.setRules([ask, COMPUTER_ALLOW])
    expect(view.toggle.view()).toBe("on")
    view.dispose()
  })

  test("on → off at once, no confirmation; another window's change shows from the rules", async () => {
    const script = scriptedSwitch()
    const view = mountToggle({ writer: script.writer, rules: [ask, COMPUTER_ALLOW] })
    script.checks[0]!.resolve({ ok: true, mode: "read-only" })
    await tick()
    expect(view.toggle.view()).toBe("on")
    const applying = view.toggle.flip()
    expect(view.toggle.view()).toBe("busy")
    expect(script.sets[0]).toMatchObject({ use: "off" })
    script.sets[0]!.resolve("off")
    await applying
    expect(view.toggle.view()).toBe("off")
    view.setRules([ask])
    view.setRules([ask, COMPUTER_ALLOW])
    expect(view.toggle.view()).toBe("on")
    view.dispose()
  })

  test("a failed write keeps the confirmation with the error; a refused one shows why", async () => {
    const script = scriptedSwitch()
    const view = mountToggle({ writer: script.writer })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    await view.toggle.flip()
    let applying = view.toggle.confirm()
    script.sets[0]!.reject(new Error("network"))
    await applying
    expect(view.toggle.view()).toBe("confirm")
    expect(view.toggle.failed()).toBe(true)
    applying = view.toggle.confirm()
    expect(view.toggle.failed()).toBe(false)
    script.sets[1]!.reject(new ComputerSwitchError("custom"))
    await applying
    expect(view.toggle.view()).toBe("blocked")
    expect(view.toggle.reason()).toBe("custom")
    // Blocked: the switch does nothing.
    await view.toggle.flip()
    expect(script.sets).toHaveLength(2)
    view.dispose()
  })

  test("no writer, or a check that fails: blocked as unavailable; another session starts over", async () => {
    const none = mountToggle({})
    expect(none.toggle.view()).toBe("blocked")
    expect(none.toggle.reason()).toBe("unavailable")
    none.dispose()

    const script = scriptedSwitch()
    const view = mountToggle({ writer: script.writer })
    view.setSessionID("ses_other")
    expect(script.checks.map((check) => check.sessionID)).toEqual([SESSION, "ses_other"])
    // The late answer for the previous session is dropped.
    script.checks[0]!.resolve({ ok: false, reason: "custom" })
    await tick()
    expect(view.toggle.view()).toBe("checking")
    script.checks[1]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.toggle.view()).toBe("off")
    view.dispose()
  })
  test("a re-check of the same session (a reconnect, a refreshed server entry) keeps the open confirmation", async () => {
    const script = scriptedSwitch()
    const [entry, setEntry] = createSignal(0)
    // The real `check` reads the connection's status and scopes synchronously, so the dialog's effect tracks them.
    const writer: ComputerSwitch = {
      ...script.writer,
      check: (sessionID) => {
        entry()
        return script.writer.check(sessionID)
      },
    }
    const view = mountToggle({ writer })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    await view.toggle.flip()
    setEntry(1)
    expect(script.checks).toHaveLength(2)
    expect(view.toggle.view()).toBe("confirm")
    script.checks[1]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.toggle.view()).toBe("confirm")
    const applying = view.toggle.confirm()
    script.sets[0]!.resolve("on")
    await applying
    expect(view.toggle.view()).toBe("on")
    view.dispose()
  })
})

describe("a model that cannot see images (01 §10.2)", () => {
  test("turning on is blocked with the reason; a model that sees images unblocks it; unknown blocks nothing", async () => {
    const script = scriptedSwitch()
    const view = mountToggle({ writer: script.writer, vision: false })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.toggle.view()).toBe("blocked")
    expect(view.toggle.reason()).toBe("vision")
    await view.toggle.flip()
    await view.toggle.confirm()
    expect(script.sets).toEqual([])
    view.setVision(undefined)
    expect(view.toggle.view()).toBe("off")
    view.setVision(true)
    expect(view.toggle.reason()).toBeUndefined()
    await view.toggle.flip()
    expect(view.toggle.view()).toBe("confirm")
    // The model changed to a text-only one while the consent was open: blocked again, nothing written.
    view.setVision(false)
    expect(view.toggle.view()).toBe("blocked")
    await view.toggle.confirm()
    expect(script.sets).toEqual([])
    view.dispose()
  })

  test("a session that has it on can still turn it off, and is told it does nothing meanwhile", async () => {
    const script = scriptedSwitch()
    const view = mountToggle({ writer: script.writer, rules: [ask, COMPUTER_ALLOW], vision: false })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.toggle.view()).toBe("on")
    expect(view.toggle.blind()).toBe(true)
    const applying = view.toggle.flip()
    expect(script.sets[0]).toMatchObject({ use: "off" })
    script.sets[0]!.resolve("off")
    await applying
    expect(view.toggle.view()).toBe("blocked")
    expect(view.toggle.reason()).toBe("vision")
    expect(view.toggle.blind()).toBe(false)
    view.dispose()
  })

  test("the strings say why, plainly", () => {
    expect(panelText("ko", "own.computer.blocked.vision")).toContain("그림을 볼 수 없어서 컴퓨터 사용을 켤 수 없어요")
    expect(panelText("ko", "own.computer.noVisionOn")).toContain("동작하지 않아요")
    expect(computerText("ko", "own.computer.noVisionSwitched")).toContain("바꾼 모델은 그림을 볼 수 없어서")
  })
})

describe("strings", () => {
  test("English keys exist in Korean; the consent text names stopping and what stays off limits", () => {
    for (const key of Object.keys(computerEn)) expect(Object.hasOwn(computerKo, key)).toBe(true)
    for (const key of Object.keys(panelEn)) expect(Object.hasOwn(panelKo, key)).toBe(true)
    // The two catalogs never define the same key.
    expect(Object.keys(computerKo).filter((key) => Object.hasOwn(panelKo, key))).toEqual([])
    expect(panelText("ko", "own.computer.toggle")).toBe("이 대화에서 컴퓨터 사용")
    expect(panelText("ko", "own.computer.stopHint")).toContain("Ctrl+Alt+Shift+Q")
    expect(panelText("ko", "own.computer.deniedApps")).toContain("비밀번호")
    expect(panelText("ko", "own.computer.deniedApps")).toContain("IDE")
    // Denied apps get no input, but nothing hides them from a screenshot.
    expect(panelText("ko", "own.computer.deniedApps")).toContain("스크린숏에는 찍혀요")
    expect(panelText("en", "own.computer.deniedApps")).toContain("still show up in screenshots")
    // The policy denies Start search, but File Explorer's address bar can still run a typed command.
    expect(panelText("ko", "own.computer.deniedApps")).toContain("파일 탐색기 주소 표시줄")
    expect(panelText("en", "own.computer.deniedApps")).toContain("File Explorer address bar")
    // Without the registered chord the panel must not promise it: it points to [모두 멈추기] instead.
    expect(panelText("ko", "own.computer.killChordMissing")).toContain("[모두 멈추기]")
    expect(panelText("en", "own.computer.killChordMissing")).toContain("[Stop all]")
    expect(computerText("en", "own.computer.chipActiveApp", { app: "notepad" })).toBe("Operating the PC · notepad")
    // Missing English falls back to Korean.
    expect(panelText("en", "own.computer.killReason.user_chord")).toBe("Ctrl+Alt+Shift+Q")
  })
})
