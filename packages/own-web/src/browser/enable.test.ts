// 03 §18.15 rule 3 (05 §8.7): the router writer over own.accounts `session.approval.get/set{browserTool}`, the
// per-server registry, the pane's view of "이 대화에서 켜기" and the cache note it confirms. No Electron, no server:
// the router is a fake that answers like own.accounts v0.5 (switching.ts `approvalGet` / `approvalSet`).
import { describe, expect, test } from "bun:test"
import type { PermissionRule } from "@opencode/client"
import type { Approval } from "@own/protocol"
import { createRoot, createSignal } from "solid-js"
import { BROWSER_DENY } from "@/policy/browser"
import {
  BrowserEnableError,
  browserEnableWriter,
  createBrowserEnable,
  createRouterBrowserEnableWriter,
  setBrowserEnableWriter,
  type BrowserEnableCheck,
  type BrowserEnableReason,
  type BrowserEnableView,
  type BrowserEnableRuntime,
  type BrowserEnableWriter,
} from "./enable"
import { browserEn, browserKo, browserText } from "./strings"
import { enableReasonKey, policyText, startedWithoutDetail } from "@/policy"

const SESSION = "ses_1"
const ask: PermissionRule = { action: "edit", resource: "**", effect: "ask" }

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A fake own.accounts router with one session's rules, answering like v0.5 (or v0.4 with `legacy`). */
function fakeRuntime(input: { rules: PermissionRule[]; mode?: Approval.Mode; legacy?: boolean; admin?: boolean }) {
  let rules = [...input.rules]
  const mode = input.mode ?? "ask"
  const calls: { method: string; payload: unknown }[] = []
  const listeners = new Map<string, Set<() => void>>()
  const [status, setStatus] = createSignal("connected")
  const synced: string[] = []
  let fail: Error | undefined
  const tool = (): Approval.BrowserTool => {
    const last = rules.findLast((rule) => rule.action === "browser" || rule.action === "*" || rule.action === "brow*")
    return last?.resource === "*" && last.effect === "deny" ? "off" : "on"
  }
  const on = (name: string, listener: () => void) => {
    const set = listeners.get(name) ?? new Set()
    listeners.set(name, set)
    set.add(listener)
    return () => void set.delete(listener)
  }
  const runtime: BrowserEnableRuntime = {
    rpc: {
      allowed: () => input.admin ?? true,
      // SAFETY: the fake answers exactly the two approval methods with their protocol shapes.
      call: (async (method: string, payload: { sessionID: string; mode?: string; browserTool?: string }) => {
        calls.push({ method, payload })
        if (fail) throw fail
        if (method === "session.approval.get")
          return {
            mode,
            rules,
            children: { open: 0 },
            ...(input.legacy ? {} : { browserTool: tool() }),
          } satisfies Approval.State
        if (method === "session.approval.set") {
          if (payload.browserTool === "on" && !input.legacy)
            rules = rules.filter(
              (rule) => !(rule.action === "browser" && rule.resource === "*" && rule.effect === "deny"),
            )
          const result: Approval.SetResult = {
            mode: payload.mode as Approval.SetMode,
            patched: [payload.sessionID as never],
            ...(payload.browserTool && !input.legacy ? { browserTool: tool() } : {}),
          }
          return result
        }
        throw new Error(`unexpected ${method}`)
      }) as unknown as BrowserEnableRuntime["rpc"]["call"],
    },
    own: { on: ((name: string, listener: () => void) => on(`own:${name}`, listener)) as never },
    bus: { on: ((name: string, listener: () => void) => on(`bus:${name}`, listener)) as never },
    connection: { status },
    data: {
      session: {
        invalidate: (id) => void synced.push(`invalidate:${id}`),
        sync: async (id) => void synced.push(`sync:${id}`),
      },
    },
  }
  return {
    runtime,
    calls,
    synced,
    rules: () => rules,
    setStatus,
    failWith: (error: Error | undefined) => void (fail = error),
    emit: (name: string) => listeners.get(name)?.forEach((listener) => listener()),
    listeners: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

describe("router writer (session.approval.get/set{browserTool}, v0.5)", () => {
  test("enable: set with the current mode and browserTool on; the creation deny goes, the rest stays", async () => {
    const fake = fakeRuntime({ rules: [BROWSER_DENY, ask], mode: "full" })
    const writer = createRouterBrowserEnableWriter(fake.runtime)
    expect(await writer.check(SESSION)).toEqual({ ok: true, mode: "full" })
    expect(await writer.enable(SESSION)).toBe("on")
    expect(fake.calls.at(-1)).toEqual({
      method: "session.approval.set",
      payload: { sessionID: SESSION, mode: "full", browserTool: "on" },
    })
    expect(fake.rules()).toEqual([ask])
    // The rules reach the store by `session.permissions`; the writer also reads the session again.
    expect(fake.synced).toEqual([`invalidate:${SESSION}`, `sync:${SESSION}`])
    writer.dispose()
  })

  test("someone else's deny keeps the tools off: the answer is the state after the write", async () => {
    const other: PermissionRule = { action: "brow*", resource: "*", effect: "deny" }
    const fake = fakeRuntime({ rules: [other, BROWSER_DENY] })
    const writer = createRouterBrowserEnableWriter(fake.runtime)
    expect(await writer.enable(SESSION)).toBe("off")
    expect(fake.rules()).toEqual([other])
    expect(fake.synced).toEqual([])
  })

  test("already on (store behind the router): no write, the session is read again", async () => {
    const fake = fakeRuntime({ rules: [ask] })
    const writer = createRouterBrowserEnableWriter(fake.runtime)
    expect(await writer.enable(SESSION)).toBe("on")
    expect(fake.calls.map((call) => call.method)).toEqual(["session.approval.get"])
    expect(fake.synced).toEqual([`invalidate:${SESSION}`, `sync:${SESSION}`])
  })

  test("check says no for custom mode, services before v0.5, no admin scope, no connection, no router", async () => {
    const custom = createRouterBrowserEnableWriter(fakeRuntime({ rules: [BROWSER_DENY], mode: "custom" }).runtime)
    expect(await custom.check(SESSION)).toEqual({ ok: false, reason: "custom" })
    await expect(custom.enable(SESSION)).rejects.toBeInstanceOf(BrowserEnableError)

    const legacy = fakeRuntime({ rules: [BROWSER_DENY, ask], legacy: true })
    const old = createRouterBrowserEnableWriter(legacy.runtime)
    expect(await old.check(SESSION)).toEqual({ ok: false, reason: "unsupported" })
    await expect(old.enable(SESSION)).rejects.toMatchObject({ reason: "unsupported" })
    // Nothing was written to a service that would drop the unknown field and only rewrite the mode.
    expect(legacy.calls.some((call) => call.method === "session.approval.set")).toBe(false)

    const device = fakeRuntime({ rules: [BROWSER_DENY, ask], admin: false })
    const scoped = createRouterBrowserEnableWriter(device.runtime)
    expect(await scoped.check(SESSION)).toEqual({ ok: false, reason: "scope" })
    await expect(scoped.enable(SESSION)).rejects.toMatchObject({ reason: "scope" })
    expect(device.calls).toEqual([])

    const offline = fakeRuntime({ rules: [BROWSER_DENY, ask] })
    offline.setStatus("reconnecting")
    expect(await createRouterBrowserEnableWriter(offline.runtime).check(SESSION)).toEqual({
      ok: false,
      reason: "unavailable",
    })

    const broken = fakeRuntime({ rules: [BROWSER_DENY, ask] })
    broken.failWith(new Error("rpc.method_not_found"))
    expect(await createRouterBrowserEnableWriter(broken.runtime).check(SESSION)).toEqual({
      ok: false,
      reason: "unavailable",
    })
    // A write that fails is a plain error (the pane keeps the confirmation for another try).
    await expect(createRouterBrowserEnableWriter(broken.runtime).enable(SESSION)).rejects.not.toBeInstanceOf(
      BrowserEnableError,
    )
  })

  test("revision follows approval.changed, session.permissions and the connection; dispose unsubscribes", () => {
    const fake = fakeRuntime({ rules: [BROWSER_DENY] })
    const writer = createRouterBrowserEnableWriter(fake.runtime)
    const seen = [writer.revision()]
    fake.emit("own:approval.changed")
    seen.push(writer.revision())
    fake.emit("bus:session.permissions")
    seen.push(writer.revision())
    fake.setStatus("reconnecting")
    seen.push(writer.revision())
    expect(new Set(seen).size).toBe(4)
    expect(fake.listeners()).toBe(2)
    writer.dispose()
    expect(fake.listeners()).toBe(0)
  })
})

describe("registry", () => {
  test("one writer per server key", () => {
    const writer = { revision: () => 0, check: async () => ({ ok: false, reason: "unavailable" }) } as never
    expect(browserEnableWriter("local")).toBeUndefined()
    setBrowserEnableWriter("local", writer)
    expect(browserEnableWriter("local")).toBe(writer)
    expect(browserEnableWriter("ssh-1")).toBeUndefined()
    setBrowserEnableWriter("local", undefined)
    expect(browserEnableWriter("local")).toBeUndefined()
  })
})

/** A scripted writer: `check` and `enable` resolve when the test says so. */
function scriptedWriter() {
  const [revision, setRevision] = createSignal(0)
  const checks: { sessionID: string; resolve: (value: BrowserEnableCheck) => void }[] = []
  const enables: {
    sessionID: string
    resolve: (value: Approval.BrowserTool) => void
    reject: (error: unknown) => void
  }[] = []
  const writer: BrowserEnableWriter = {
    revision,
    check: (sessionID) => new Promise((resolve) => checks.push({ sessionID, resolve })),
    enable: (sessionID) => new Promise((resolve, reject) => enables.push({ sessionID, resolve, reject })),
  }
  return { writer, checks, enables, bump: () => setRevision((value) => value + 1) }
}

function mount(input: { writer?: BrowserEnableWriter; rules?: PermissionRule[]; sessionID?: string }) {
  return createRoot((dispose) => {
    const [writer, setWriter] = createSignal(input.writer)
    const [sessionID, setSessionID] = createSignal(input.sessionID ?? SESSION)
    const [rules, setRules] = createSignal<PermissionRule[] | undefined>(input.rules ?? [BROWSER_DENY, ask])
    const enable = createBrowserEnable({ writer, sessionID, rules })
    return { enable, setWriter, setSessionID, setRules, dispose }
  })
}

describe("pane view (Removed)", () => {
  test("no writer for the server: only the new-session note", () => {
    const view = mount({})
    expect(view.enable.view()).toBe("new-session")
    expect(view.enable.reason()).toBe("elsewhere")
    view.enable.ask()
    expect(view.enable.view()).toBe("new-session")
    view.dispose()
  })

  test("offer → confirm → busy → done; cancel goes back to the offer", async () => {
    const script = scriptedWriter()
    const view = mount({ writer: script.writer })
    expect(view.enable.view()).toBe("checking")
    expect(view.enable.reason()).toBeUndefined()
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.enable.view()).toBe("offer")
    expect(view.enable.reason()).toBeUndefined()
    view.enable.ask()
    expect(view.enable.view()).toBe("confirm")
    view.enable.cancel()
    expect(view.enable.view()).toBe("offer")
    view.enable.ask()
    const applying = view.enable.apply()
    expect(view.enable.view()).toBe("busy")
    // A second press while the write runs does nothing.
    await view.enable.apply()
    expect(script.enables).toHaveLength(1)
    expect(script.enables[0]!.sessionID).toBe(SESSION)
    script.enables[0]!.resolve("on")
    await applying
    expect(view.enable.view()).toBe("done")
    // The router's own approval.changed re-checks, but the done state stays until the rules land.
    script.bump()
    script.checks.at(-1)!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.enable.view()).toBe("done")
    view.dispose()
  })

  test("the router answers off: another rule keeps the tools off", async () => {
    const script = scriptedWriter()
    const view = mount({ writer: script.writer })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    view.enable.ask()
    const applying = view.enable.apply()
    script.enables[0]!.resolve("off")
    await applying
    expect(view.enable.view()).toBe("blocked")
    expect(view.enable.reason()).toBe("blocked")
    view.dispose()
  })

  test("someone else's deny is visible in the rules: blocked without offering the switch", async () => {
    const script = scriptedWriter()
    const view = mount({ writer: script.writer, rules: [{ action: "*", resource: "*", effect: "deny" }, BROWSER_DENY] })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.enable.view()).toBe("blocked")
    view.dispose()
  })

  test("custom mode (or an old service) shows the note; a mode written later brings the button", async () => {
    const script = scriptedWriter()
    const view = mount({ writer: script.writer })
    script.checks[0]!.resolve({ ok: false, reason: "custom" })
    await tick()
    expect(view.enable.view()).toBe("new-session")
    expect(view.enable.reason()).toBe("custom")
    // approval.changed from the pill: checked again, the old answer stays on screen meanwhile (no flash).
    script.bump()
    expect(view.enable.view()).toBe("new-session")
    script.checks[1]!.resolve({ ok: true, mode: "read-only" })
    await tick()
    expect(view.enable.view()).toBe("offer")
    view.dispose()
  })

  test("a failed write keeps the confirmation with the error; a refused one falls back to the note", async () => {
    const script = scriptedWriter()
    const view = mount({ writer: script.writer })
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    view.enable.ask()
    let applying = view.enable.apply()
    script.enables[0]!.reject(new Error("network"))
    await applying
    expect(view.enable.view()).toBe("confirm")
    expect(view.enable.failed()).toBe(true)
    applying = view.enable.apply()
    expect(view.enable.failed()).toBe(false)
    script.enables[1]!.reject(new BrowserEnableError("custom"))
    await applying
    expect(view.enable.view()).toBe("new-session")
    expect(view.enable.failed()).toBe(false)
    view.dispose()
  })

  test("another session: state resets and a late answer for the previous one is dropped", async () => {
    const script = scriptedWriter()
    const view = mount({ writer: script.writer })
    view.setSessionID("ses_2")
    expect(script.checks.map((check) => check.sessionID)).toEqual([SESSION, "ses_2"])
    script.checks[0]!.resolve({ ok: true, mode: "ask" })
    await tick()
    expect(view.enable.view()).toBe("checking")
    script.checks[1]!.resolve({ ok: false, reason: "unsupported" })
    await tick()
    expect(view.enable.view()).toBe("new-session")
    expect(view.enable.reason()).toBe("unsupported")
    view.dispose()
  })
})

describe("strings (03 §18.15 rule 3)", () => {
  test("the confirmation names the cost: one tool-list note on this session's next request, prefix cache kept", () => {
    expect(browserKo["own.browserPane.enableConfirm"]).toBe(
      "이 대화의 다음 요청에 도구 목록 문구가 한 번 더해져요. 앞부분 캐시는 유지돼요.",
    )
    expect(browserEn["own.browserPane.enableConfirm"]).toContain("next request")
    expect(browserText("ko", "own.browserPane.enable")).toBe("이 대화에서 켜기")
  })

  test("the pane and the conversation's notice say the same thing: turn it on here, or why not", () => {
    const notice = (view: BrowserEnableView, reason?: BrowserEnableReason) => {
      const key = startedWithoutDetail(view, reason)
      return [policyText("ko", "own.policy.browser.startedWithout"), key && policyText("ko", key)].filter(Boolean)
    }
    // The switch is offered (or under way): it can be turned on here, the cache stays; the button's own words.
    for (const view of ["offer", "confirm", "busy", "done"] as const)
      expect(notice(view)).toEqual([
        "이 대화는 브라우저 도구 없이 시작했어요.",
        "브라우저 칸의 ‘이 대화에서 켜기’로 여기서 켤 수 있어요. 대화 앞부분 캐시는 유지돼요.",
      ])
    expect(policyText("ko", "own.policy.browser.canEnable")).toContain(browserText("ko", "own.browserPane.enable"))
    // Still asking the router: only the first sentence, so no reason flashes before the switch.
    expect(notice("checking")).toEqual(["이 대화는 브라우저 도구 없이 시작했어요."])
    // No switch: the plain reason, the same key the pane shows under its title.
    const reasons = {
      custom: "승인 모드가 ‘사용자 지정’이라 이 대화에서는 켤 수 없어요. 필요하면 새 대화를 만드세요.",
      unsupported: "서비스 버전이 낮아 이 대화에서는 켤 수 없어요. 필요하면 새 대화를 만드세요.",
      scope: "이 연결에는 대화 규칙을 바꿀 권한이 없어 켤 수 없어요. 필요하면 새 대화를 만드세요.",
      unavailable: "서비스가 답하지 않아 지금은 켤 수 없어요. 다시 연결되면 켤 수 있어요.",
      elsewhere: "이 창에서는 이 대화의 규칙을 바꿀 수 없어 켤 수 없어요. 필요하면 새 대화를 만드세요.",
      blocked: "다른 규칙이 이 대화의 브라우저 도구를 막고 있어요.",
    } satisfies Record<BrowserEnableReason, string>
    for (const [reason, text] of Object.entries(reasons) as [BrowserEnableReason, string][]) {
      expect(startedWithoutDetail(reason === "blocked" ? "blocked" : "new-session", reason)).toBe(
        enableReasonKey(reason),
      )
      expect(policyText("ko", enableReasonKey(reason))).toBe(text)
      expect(policyText("en", enableReasonKey(reason))).not.toBe(text)
    }
    // The old advice to make a new session "in the desktop app" (said inside the desktop app) is gone.
    expect(Object.values(reasons).some((text) => text.includes("데스크톱 앱에서"))).toBe(false)
  })
})
