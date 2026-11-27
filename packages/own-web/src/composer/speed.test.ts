// The composer's 속도 (02 §4.8, 03 §4.6): the button, the menu's badges (plan multiples, API prices, the Claude
// subscription's usage-credit price), when a change asks first (cost dialog, one-time consent), the dialog's lines, the
// service's notices, the store's speed views (read, refreshed on `session.speed.changed` and `binding.changed`,
// dropped), the pickers hiding speed mode entries, and a remote session's Fast consent recorded on this PC (04
// §8.11.9). 2026-10-10: the control stays on screen grey with a reason, a new conversation (and the switcher's row)
// follows its target's `speed.offers` on every account or model change, and a new session's early empty view is read
// again on `session.created` (the user's DeepSeek → ChatGPT report). Solid components do not render under `bun test`,
// so the button's wiring is checked in its source. Every account, model and price is made up.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { Speed } from "@own/protocol"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"
import type { ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc, OwnRpcError } from "@/data/rpc"
import { createI18n } from "@/i18n"
import { offered } from "@/switcher/labels"
import {
  active,
  button,
  changeLines,
  consentRequired,
  items,
  needsConsent,
  needsDialog,
  noneNote,
  notice,
  offerBadge,
  offerNote,
  pendingView,
  setSpeed,
} from "./speed"
import {
  afterSwitch,
  closeAsk,
  confirmSpeed,
  landAfterSwitch,
  newKey,
  pendingChoice,
  requestSpeed,
  speedFlow,
  startSpeed,
  takeNewSpeed,
  targetView,
  watchTargetOffers,
  type SpeedEnv,
} from "./speed-flow"

const ko = createI18n("ko")
const en = createI18n("en")

const FAST: Speed.Offer = {
  choice: "fast",
  tier: "priority",
  wire: "service_tier",
  basis: "account",
  status: "available",
  name: "Fast",
  billing: { type: "plan", included: 2.5, credits: 2 },
}
const ULTRA: Speed.Offer = {
  choice: "ultrafast",
  tier: "ultrafast",
  wire: "service_tier",
  basis: "account",
  status: "available",
  billing: { type: "plan", included: 8, credits: 6 },
}

function view(extra: Partial<Speed.View> = {}): Speed.View {
  return {
    sessionID: "ses_speed" as Speed.View["sessionID"],
    root: "ses_speed" as Speed.View["root"],
    choice: "standard",
    effective: "standard",
    tier: null,
    offers: [FAST, ULTRA],
    beta: false,
    ...extra,
  }
}

describe("badges (decision 3)", () => {
  test("plan multiples on ChatGPT, prices with an API key, usage credits on the Claude subscription", () => {
    expect(offerBadge(ko, FAST)).toBe("Fast · 한도 ×2.5")
    expect(offerBadge(ko, ULTRA)).toBe("Ultrafast · 한도 ×8")
    expect(offerBadge(en, FAST)).toBe("Fast · limits ×2.5")
    const api: Speed.Offer = { ...FAST, basis: "catalog", billing: { type: "api", input: 20, output: 100 } }
    expect(offerBadge(ko, api)).toBe("Fast · $20/$100")
    const claude: Speed.Offer = {
      ...FAST,
      tier: "fast",
      wire: "speed",
      basis: "catalog",
      billing: { type: "extra", input: 8, output: 40 },
    }
    expect(offerBadge(ko, claude)).toBe("Fast · 추가 사용량 $8/$40")
    expect(offerBadge(en, claude)).toBe("Fast · usage credits $8/$40")
    expect(offerBadge(ko, { ...FAST, billing: { type: "plan", included: null, credits: null } })).toBe("Fast")
  })

  test("an unverified offer says so; a cooling one says until when", () => {
    expect(offerBadge(ko, { ...FAST, basis: "catalog", status: "unverified" })).toBe("Fast · 한도 ×2.5 · 확인 전")
    const until = new Date(2026, 9, 6, 14, 20).getTime()
    // A coming time in the reset style (LV): relative within a day, never a bare clock that may be tomorrow.
    expect(offerBadge(ko, { ...FAST, status: "cooldown", until }, until - 42 * 60_000)).toBe(
      "Fast · 한도 ×2.5 · 42분 후까지 쉼",
    )
  })
})

describe("the button and the menu", () => {
  test("what the main offers; a refused or cooling speed stays in the menu, disabled with its note", () => {
    expect(items(view()).map((item) => [item.choice, item.disabled])).toEqual([
      ["standard", false],
      ["fast", false],
      ["ultrafast", false],
    ])
    const marked = view({
      offers: [
        { ...FAST, status: "cooldown", until: Date.UTC(2026, 9, 10, 5, 20) },
        { ...ULTRA, status: "unavailable", reason: "status_400" },
      ],
    })
    expect(items(marked).map((item) => [item.choice, item.disabled])).toEqual([
      ["standard", false],
      ["fast", true],
      ["ultrafast", true],
    ])
    expect(offerNote(ko, marked.offers[1]!)).toBe("모델 회사가 이 계정과 모델에서 거절했어요(HTTP 400 오류)")
    // 2026-10-18: the reason the service recorded, in Korean.
    expect(offerNote(ko, { ...ULTRA, status: "unavailable", reason: "unsupported_tier" })).toBe(
      "모델 회사가 이 계정과 모델에서 거절했어요(이 계정·모델에서는 지원하지 않는 속도예요)",
    )
    expect(offerNote(ko, { ...ULTRA, status: "unavailable", reason: "rejected" })).toBe(
      "모델 회사가 이 계정과 모델에서 거절했어요",
    )
    expect(offerNote(ko, { ...ULTRA, status: "unavailable", reason: "ignored" })).toBe(
      "계속 더 느린 속도로 처리되어 지금은 보내지 않아요",
    )
    expect(offerNote(ko, marked.offers[0]!)).toContain("까지 쉼")
    expect(offerNote(ko, { ...FAST, status: "unverified" })).toBeUndefined()
  })

  test("without a faster speed the control stays grey with the reason; a choice to undo keeps it usable", () => {
    expect(active(view())).toBe(true)
    expect(active(view({ offers: [] }))).toBe(false)
    expect(active(view({ offers: [], choice: "fast" }))).toBe(true)
    expect(active(view({ offers: [], fixed: "fast", effective: "fast" }))).toBe(false)
    expect(active(undefined)).toBe(false)
    expect(noneNote(ko, view({ offers: [], none: "kind" }))).toBe("이 계정 종류에는 빠른 속도가 없어요")
    expect(noneNote(ko, view({ offers: [], none: "model" }))).toBe(
      "이 계정과 모델에는 지금 Fast가 없어요(요금제·모델 목록에 없음)",
    )
    expect(noneNote(ko, view({ offers: [], none: "provider" }))).toBe(
      "이 앱이 이 모델 회사의 요청을 다루지 않아 속도를 고를 수 없어요",
    )
    expect(noneNote(ko, view({ offers: [], none: "session" }))).toBe("대화를 만드는 중이에요")
    // An older service says nothing about why.
    expect(noneNote(ko, view({ offers: [] }))).toBe("이 모델에는 빠른 속도가 없어요")
    expect(noneNote(en, view({ offers: [], none: "kind" }))).toBe("This kind of account has no faster speed")
    expect(noneNote(ko, view({ offers: [], fixed: "fast" }))).toBeUndefined()
  })

  test("a new conversation's choice resolves on what its target offers, as a request would send it", () => {
    const codex: Speed.Targeted = { providerID: "own-codex-aaaa", modelID: "gpt-6-astra", offers: [FAST, ULTRA] }
    expect(pendingView(codex, "standard")).toEqual({ choice: "standard", effective: "standard", offers: [FAST, ULTRA] })
    expect(pendingView(codex, "ultrafast").effective).toBe("ultrafast")
    // The same choice on a main that offers Fast only, or nothing: it falls back; the choice is kept.
    expect(pendingView({ ...codex, offers: [FAST] }, "ultrafast")).toMatchObject({
      choice: "ultrafast",
      effective: "fast",
    })
    const deepseek: Speed.Targeted = { providerID: "own-ds-dddd", modelID: "deepseek-flash", offers: [], none: "kind" }
    expect(pendingView(deepseek, "fast")).toMatchObject({ choice: "fast", effective: "standard", none: "kind" })
    // The Claude slot sends Fast only once the consent card was accepted for it.
    const claude: Speed.Targeted = {
      providerID: "anthropic",
      modelID: "claude-opus-5-5",
      offers: [{ ...FAST, tier: "fast", wire: "speed", basis: "catalog" }],
      consent: "needed",
    }
    expect(pendingView(claude, "fast").effective).toBe("standard")
    expect(pendingView(claude, "fast", true).effective).toBe("fast")
    expect(needsConsent(pendingView(claude, "standard"), "fast")).toBe(true)
    expect(pendingView({ ...codex, offers: [], fixed: "fast" }, "standard")).toMatchObject({
      effective: "fast",
      fixed: "fast",
    })
  })

  test("the label is what the next request sends; grey when it falls short or was served at Standard", () => {
    expect(button(ko, view())).toEqual({ label: "속도: 표준", mark: "standard", dim: false })
    expect(button(ko, view({ choice: "fast", effective: "fast", tier: "priority" }))).toEqual({
      label: "Fast",
      mark: "fast",
      dim: false,
    })
    expect(button(ko, view({ choice: "ultrafast", effective: "ultrafast", tier: "flex" }))).toMatchObject({
      label: "Ultrafast",
      mark: "ultrafast",
    })
    expect(button(ko, view({ choice: "ultrafast", effective: "fast", tier: "priority" }))).toEqual({
      label: "Fast",
      mark: "fast",
      dim: true,
      note: "Ultrafast를 지금 쓸 수 없어 Fast로 보내요",
    })
    const served = { requested: "priority", served: "default", downgraded: true, at: 1 }
    expect(button(ko, view({ choice: "fast", effective: "fast", tier: "priority", served }))).toMatchObject({
      dim: true,
      note: "마지막 요청은 모델 회사가 표준 속도로 처리했어요",
    })
    expect(button(ko, view({ offers: [], fixed: "fast", effective: "fast" })).label).toBe("Fast 전용 모델")
  })
})

describe("asking first", () => {
  const change = (extra: Partial<Speed.Change> = {}): Speed.Change => ({
    from: "standard",
    to: "fast",
    P: 100_000,
    unit: "USD",
    delta: { lo: 0.19, hi: 1.81, unit: "USD" },
    factor: 2,
    cache: "unknown",
    basis: "rule",
    warnings: ["cache_unverified"],
    ...extra,
  })

  test("a faster speed with a cost or an open question opens the dialog; back to Standard applies at once", () => {
    expect(needsDialog(change(), "fast")).toBe(true)
    expect(needsDialog(change({ delta: { lo: 0, hi: 0, unit: "USD" }, factor: 1, warnings: [] }), "fast")).toBe(false)
    expect(needsDialog(change({ to: "standard" }), "standard")).toBe(false)
    expect(needsDialog(null, "fast")).toBe(false)
  })

  test("the Claude subscription asks for the one-time usage-credit consent", () => {
    expect(needsConsent(view({ consent: "needed" }), "fast")).toBe(true)
    expect(needsConsent(view({ consent: "needed" }), "standard")).toBe(false)
    expect(needsConsent(view({ consent: "given" }), "fast")).toBe(false)
    expect(needsConsent(view(), "fast")).toBe(false)
  })

  test("the dialog's lines: the next request's range, the factor and each warning", () => {
    expect(changeLines(ko, change())).toEqual([
      "다음 요청 +$0.19~$1.8",
      "이후 요청당 약 ×2",
      ko.t("own.speed.dialog.cacheUnknown"),
    ])
    const first = change({ cache: "lost", warnings: ["first_fast_rewrite", "extra_usage"] })
    expect(changeLines(ko, first)).toContain(ko.t("own.speed.dialog.firstFast"))
    expect(changeLines(ko, first)).toContain(ko.t("own.speed.consent.body"))
    // The consent card already says it: not twice.
    expect(changeLines(ko, first, { consent: true })).not.toContain(ko.t("own.speed.consent.body"))
    expect(changeLines(ko, change({ delta: null, factor: 2.5, warnings: ["rate_unknown"] }))).toEqual([
      "이후 요청당 약 ×2.5",
      ko.t("own.speed.dialog.rateUnknown"),
    ])
  })

  test("the service's own changes become a notice; the user's own do not", () => {
    expect(notice(ko, "fallback", "fast")).toBe("더 빠른 속도가 거절되어 Fast로 보내요. 계정은 그대로예요")
    expect(notice(ko, "fallback", "fast", "ultrafast", "unsupported_tier")).toBe(
      "더 빠른 속도가 거절되어 Fast로 보내요(이 계정·모델에서는 지원하지 않는 속도예요). 계정은 그대로예요",
    )
    expect(notice(ko, "fallback", "standard", "fast", "subscription_sharing_unsupported_capability")).toBe(
      "더 빠른 속도가 거절되어 표준으로 보내요(구독 공유는 이 속도를 지원하지 않아요). 계정은 그대로예요",
    )
    expect(notice(ko, "cooldown", "standard")).toBe("Fast 한도에 걸려 잠시 표준 속도로 보내요")
    expect(notice(ko, "downgraded", "ultrafast")).toBe(
      "모델 회사가 이번 Ultrafast 요청을 더 느린 속도로 처리했어요(그 속도의 요금). 혼잡하면 잠시 그럴 수 있어요",
    )
    expect(notice(ko, "ignored", "fast", "ultrafast")).toBe(
      "Ultrafast 요청이 계속 더 느리게 처리되어 Fast로 보내요. 이 계정·모델은 Ultrafast를 지원하지 않는 것 같아요",
    )
    expect(notice(ko, "ignored", "standard", "fast")).toBe(
      "Fast 요청이 계속 더 느리게 처리되어 표준으로 보내요. 이 계정·모델은 Fast를 지원하지 않는 것 같아요",
    )
    expect(notice(ko, "recovered", "fast")).toBe("다시 Fast로 보내요")
    expect(notice(ko, "user", "fast")).toBeUndefined()
  })
})

describe("a remote session's Fast consent (04 §8.11.9)", () => {
  const FAST_TIMING = { retryMs: 5, waitMs: 400 }
  const local = () => new OwnRpcError("speed_consent_required", "record it on the PC", { recordOn: "local" })

  /**
   * The session's server (`set`, answering from `answers` in order: `local` refuses with `recordOn: "local"`, `ok`
   * applies) and this PC's `fastAck`, both recording what was asked in one list.
   */
  function servers(answers: ReadonlyArray<"local" | "here" | "ok">) {
    const calls: string[] = []
    const queue = [...answers]
    return {
      calls,
      set: async (consent: boolean) => {
        calls.push(consent ? "remote set{consent}" : "remote set")
        const answer = queue.shift() ?? "ok"
        if (answer === "local") throw local()
        if (answer === "here") throw new OwnRpcError("speed_consent_required", "consent first", {})
        return { applied: true }
      },
      fastAck: async () => {
        calls.push("PC fastAck")
        return { at: 1 }
      },
    }
  }

  test("the refusal says where the consent is recorded", () => {
    expect(consentRequired(local())).toBe("local")
    expect(consentRequired(new OwnRpcError("speed_consent_required", "x", {}))).toBe("here")
    expect(consentRequired(new OwnRpcError("speed_unavailable", "x", {}))).toBeUndefined()
    expect(consentRequired(new Error("x"))).toBeUndefined()
  })

  test("on a remote session the consent goes to this PC, then the host's session.speed.set is asked again", async () => {
    // The first retry comes before the PC's mirror push reached the host; the next one goes through.
    const server = servers(["local", "ok"])
    expect(await setSpeed(server, { consent: true, local: true }, FAST_TIMING)).toEqual({ applied: true })
    expect(server.calls).toEqual(["PC fastAck", "remote set", "remote set"])
  })

  test("a server that answers recordOn: local is handled the same way", async () => {
    const server = servers(["local", "ok"])
    expect(await setSpeed(server, { consent: true, local: false }, FAST_TIMING)).toEqual({ applied: true })
    expect(server.calls).toEqual(["remote set{consent}", "PC fastAck", "remote set"])
  })

  test("without recordOn the consent stays on the session's own server (consent: true), as before", async () => {
    const server = servers(["ok"])
    await setSpeed(server, { consent: true, local: false }, FAST_TIMING)
    expect(server.calls).toEqual(["remote set{consent}"])
    const refused = servers(["here"])
    await expect(setSpeed(refused, { consent: true, local: false }, FAST_TIMING)).rejects.toThrow("consent first")
  })

  test("the host is asked again for a bounded time only, then the refusal shows", async () => {
    const server = servers(Array.from({ length: 1000 }, () => "local" as const))
    const started = Date.now()
    await expect(setSpeed(server, { consent: true, local: true }, { retryMs: 5, waitMs: 60 })).rejects.toThrow(
      "record it on the PC",
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(server.calls[0]).toBe("PC fastAck")
    expect(server.calls.filter((call) => call === "PC fastAck")).toHaveLength(1)
  })

  test("no consent: one plain set", async () => {
    const server = servers(["ok"])
    await setSpeed(server, { consent: false, local: true }, FAST_TIMING)
    expect(server.calls).toEqual(["remote set"])
  })

  test("the button records a remote session's consent with this PC's fastAck and says so on the card", async () => {
    const strip = (text: string) => text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")
    const source = strip(await Bun.file(path.join(import.meta.dir, "speed-button.tsx")).text())
    const flow = strip(await Bun.file(path.join(import.meta.dir, "speed-flow.ts")).text())
    expect(source).toContain('fastAck: () => data.local().rpc.call("plugin.claudeAuth.fastAck", {})')
    expect(flow).toContain('const remote = env.runtime.kind === "ssh"')
    expect(flow).toContain("const where = consentRequired(error)")
    expect(source).toContain('servers("own.remote.claudeSlot.fastLocal")')
  })
})

describe("the store's speed views", () => {
  test("watched roots are read, refreshed on session.speed.changed and binding.changed, and dropped", async () => {
    const calls: string[] = []
    const answers: Record<string, unknown> = {
      health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\\ctl" },
      "accounts.list": { revision: 1, accounts: [] },
      "quota.snapshot": { windows: [] },
      "policy.get": { policy: { defaults: { byKind: {} } } },
      "presets.list": { groups: [] },
      "session.speed.get": view(),
    }
    const client = {
      rpc: {
        call: async (input: { method: string }) => {
          calls.push(input.method)
          return { output: answers[input.method] ?? {} }
        },
      },
    }
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        // SAFETY: the stores only reach `rpc.call` here.
        client: () => client as unknown as OpenCodeClient,
        routing: { control: async () => "D:\\ctl", sessionDirectory: () => "D:\\work" },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({
        rpc,
        bus,
        client: () => client as unknown as OpenCodeClient,
        sessionDirectory: () => "D:\\work",
      })
      bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      bus.flush()
      await tick()
      const release = own.watchSpeed("ses_speed")
      await tick()
      expect(own.state.sessionSpeed.ses_speed?.choice).toBe("standard")
      answers["session.speed.get"] = view({ choice: "fast", effective: "fast", tier: "priority" })
      const event = (type: string, data: Record<string, unknown>) =>
        bus.publish({
          type: `rpc.own.accounts.${type}`,
          id: crypto.randomUUID(),
          location: { directory: "D:\\work" },
          data: {
            eventId: crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase(),
            origin: "session",
            ...data,
          },
        } as unknown as OpenCodeEvent)
      event("session.speed.changed", {
        sessionID: "ses_speed",
        choice: "fast",
        effective: "fast",
        tier: "priority",
        reason: "user",
      })
      bus.flush()
      await tick()
      expect(own.state.sessionSpeed.ses_speed?.effective).toBe("fast")
      const reads = calls.filter((method) => method === "session.speed.get").length
      event("binding.changed", {
        sessionID: "ses_speed",
        model: { providerID: "own-codex-aaaa", id: "gpt-6-sol" },
        previous: null,
        accountID: null,
        reason: "manual",
        external: false,
      })
      bus.flush()
      await tick()
      expect(calls.filter((method) => method === "session.speed.get").length).toBe(reads + 1)
      own.setSpeed(view({ choice: "ultrafast", effective: "ultrafast", tier: "ultrafast" }))
      expect(own.state.sessionSpeed.ses_speed?.choice).toBe("ultrafast")
      release()
      expect(own.state.sessionSpeed.ses_speed).toBeUndefined()
      own.dispose()
      dispose()
    })
  })
})

describe("a new conversation's speed follows its target (the user's 2026-10-10 report)", () => {
  test("DeepSeek first, then ChatGPT before the first message: ChatGPT's speeds show at once; the new session's early view is read again", async () => {
    const calls: Array<{ method: string; input: unknown }> = []
    const offersOf: Record<string, Speed.Targeted> = {
      "own-ds-dddd": { providerID: "own-ds-dddd", modelID: "deepseek-flash", offers: [], none: "kind" },
      "own-codex-aaaa": { providerID: "own-codex-aaaa", modelID: "gpt-6-astra", offers: [FAST, ULTRA] },
    }
    const answers: Record<string, unknown> = {
      health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\\ctl" },
      "accounts.list": { revision: 1, accounts: [] },
      "quota.snapshot": { windows: [] },
      "policy.get": { policy: { defaults: { byKind: {} } } },
      "presets.list": { groups: [] },
      // The optimistic create: the composer navigated before the server had the session.
      "session.speed.get": view({ offers: [], none: "session" }),
    }
    const client = {
      rpc: {
        call: async (input: { method: string; input?: { providerID?: string } }) => {
          calls.push({ method: input.method, input: input.input })
          if (input.method === "speed.offers") return { output: offersOf[input.input?.providerID ?? ""] }
          return { output: answers[input.method] ?? {} }
        },
      },
    }
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        // SAFETY: the stores only reach `rpc.call` here.
        client: () => client as unknown as OpenCodeClient,
        routing: { control: async () => "D:\\ctl", sessionDirectory: () => "D:\\work" },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({
        rpc,
        bus,
        client: () => client as unknown as OpenCodeClient,
        sessionDirectory: () => "D:\\work",
      })
      bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      bus.flush()
      await tick()
      // The new-conversation screen, as the 속도 button and the switcher's row watch it.
      const [target, setTarget] = createSignal({ providerID: "own-ds-dddd", id: "deepseek-flash" })
      watchTargetOffers(own, target)
      await tick()
      const onDeepSeek = targetView(own, target(), "standard", false)
      expect(onDeepSeek?.offers).toHaveLength(0)
      expect(onDeepSeek?.none).toBe("kind")
      expect(active(onDeepSeek)).toBe(false)
      expect(noneNote(ko, onDeepSeek!)).toBe("이 계정 종류에는 빠른 속도가 없어요")
      setTarget({ providerID: "own-codex-aaaa", id: "gpt-6-astra" })
      await tick()
      const onCodex = targetView(own, target(), "standard", false)
      expect(active(onCodex)).toBe(true)
      expect(items(onCodex!).map((item) => item.choice)).toEqual(["standard", "fast", "ultrafast"])
      expect(calls.filter((call) => call.method === "speed.offers").map((call) => call.input)).toEqual([
        { providerID: "own-ds-dddd", modelID: "deepseek-flash" },
        { providerID: "own-codex-aaaa", modelID: "gpt-6-astra" },
      ])
      // DeepSeek's offers were released with the move.
      expect(Object.keys(own.state.speedOffers)).toEqual(["own-codex-aaaa\u0000gpt-6-astra"])
      // The same main in a new object (a recomputed target) keeps its watch: no release, no second read.
      setTarget({ providerID: "own-codex-aaaa", id: "gpt-6-astra" })
      expect(Object.keys(own.state.speedOffers)).toEqual(["own-codex-aaaa\u0000gpt-6-astra"])
      await tick()
      expect(calls.filter((call) => call.method === "speed.offers")).toHaveLength(2)
      // The first send: the composer shows the new session before the server has it, so its first read is empty…
      own.watchSpeed("ses_speed")
      await tick()
      expect(own.state.sessionSpeed.ses_speed?.none).toBe("session")
      expect(active(own.state.sessionSpeed.ses_speed)).toBe(false)
      // …and the server's `session.created` reads it again, so Codex's speeds show without a model change.
      answers["session.speed.get"] = view()
      bus.publish({ type: "session.created", id: "c1", data: { sessionID: "ses_speed" } } as unknown as OpenCodeEvent)
      bus.flush()
      await tick()
      expect(calls.filter((call) => call.method === "session.speed.get")).toHaveLength(2)
      expect(active(own.state.sessionSpeed.ses_speed)).toBe(true)
      expect(own.state.sessionSpeed.ses_speed?.offers.map((offer) => offer.choice)).toEqual(["fast", "ultrafast"])
      // An accounts change (a plan's list was read again) reads the watched offers again.
      const before = calls.filter((call) => call.method === "speed.offers").length
      bus.publish({
        type: "rpc.own.accounts.accounts.changed",
        id: "a1",
        location: { directory: "D:\ctl" },
        data: { eventId: "01J0000000000000000000ACCT", origin: "global", revision: 2 },
      } as unknown as OpenCodeEvent)
      bus.flush()
      await tick()
      expect(calls.filter((call) => call.method === "speed.offers").length).toBe(before + 1)
      own.dispose()
      dispose()
    })
  })
})

describe("a speed picked on the new-conversation screen reaches the new session (the review's blocker)", () => {
  test("through the real store: the pick is resolved before navigating, which releases the offers, then set", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown> | undefined }> = []
    const client = {
      rpc: {
        call: async (input: { method: string; input?: Record<string, unknown> }) => {
          calls.push({ method: input.method, input: input.input })
          const answers: Record<string, unknown> = {
            health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\ctl" },
            "accounts.list": { revision: 1, accounts: [] },
            "quota.snapshot": { windows: [] },
            "policy.get": { policy: { defaults: { byKind: {} } } },
            "presets.list": { groups: [] },
            "speed.offers": { providerID: "own-codex-aaaa", modelID: "gpt-6-astra", offers: [FAST, ULTRA] },
            // The optimistic create: the session's first read does not know it yet.
            "session.speed.get": view({
              sessionID: "ses_made" as Speed.View["sessionID"],
              offers: [],
              none: "session",
            }),
            "session.speed.set": {
              view: view({
                sessionID: "ses_made" as Speed.View["sessionID"],
                choice: input.input?.speed as Speed.Choice,
                effective: input.input?.speed as Speed.Choice,
              }),
              change: null,
              dryRun: false,
            },
          }
          return { output: answers[input.method] ?? {} }
        },
      },
    }
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        // SAFETY: the stores only reach `rpc.call` here.
        client: () => client as unknown as OpenCodeClient,
        routing: { control: async () => "D:\ctl", sessionDirectory: () => "D:\work" },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({
        rpc,
        bus,
        client: () => client as unknown as OpenCodeClient,
        sessionDirectory: () => "D:\work",
      })
      const env: SpeedEnv = {
        // SAFETY: the speed flow reaches only `kind`, `rpc` and `own` of a runtime.
        runtime: { kind: "local", rpc, own } as unknown as ServerRuntime,
        serverKey: "speed-made",
        i18n: ko,
        fastAck: async () => {},
      }
      bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      bus.flush()
      await tick()
      // The 속도 button as the composer mounts it: the target's offers on the new-conversation screen, the session's
      // view once the route names the session.
      const target = { providerID: "own-codex-aaaa", id: "gpt-6-astra" }
      const [sessionID, setSessionID] = createSignal<string | undefined>(undefined)
      watchTargetOffers(own, () => (sessionID() ? undefined : target))
      createEffect(() => {
        const id = sessionID()
        if (id) onCleanup(own.watchSpeed(id))
      })
      await tick()
      const pending = pendingChoice("speed-made")
      const shown = targetView(own, target, pending.choice, pending.consent)
      expect(active(shown)).toBe(true)
      await requestSpeed(env, { sessionID: undefined, to: "fast", view: shown!, offer: FAST })
      expect(targetView(own, target, pendingChoice("speed-made").choice, false)?.effective).toBe("fast")
      // Composer.create: resolve the pick, then navigate. The navigation releases the offers…
      const speed = takeNewSpeed(own, "speed-made", target)
      setSessionID("ses_made")
      await tick()
      expect(own.state.speedOffers).toEqual({})
      // …and once the create settled the pick is still set before the first prompt.
      await startSpeed(env, "ses_made", speed)
      expect(calls.filter((call) => call.method === "session.speed.set").map((call) => call.input)).toEqual([
        { sessionID: "ses_made", speed: "fast" },
      ])
      expect(own.state.sessionSpeed.ses_made?.choice).toBe("fast")
      expect(pendingChoice("speed-made").choice).toBe("standard")
      own.dispose()
      dispose()
    })
  })
})

describe("one read per watched main (the review's churn)", () => {
  test("a main watched before own.accounts answers is read once when it becomes ready, not released and read again", async () => {
    const calls: string[] = []
    const client = {
      rpc: {
        call: async (input: { method: string }) => {
          calls.push(input.method)
          const answers: Record<string, unknown> = {
            health: { version: "local", buildId: "b", guard: "ok", controlDir: "D:\ctl" },
            "accounts.list": { revision: 1, accounts: [] },
            "quota.snapshot": { windows: [] },
            "policy.get": { policy: { defaults: { byKind: {} } } },
            "presets.list": { groups: [] },
            "speed.offers": { providerID: "own-codex-aaaa", modelID: "gpt-6-astra", offers: [FAST] },
            "session.speed.get": view(),
          }
          return { output: answers[input.method] ?? {} }
        },
      },
    }
    await createRoot(async (dispose) => {
      const bus = createEventBus()
      const rpc = createOwnRpc({
        // SAFETY: the stores only reach `rpc.call` here.
        client: () => client as unknown as OpenCodeClient,
        routing: { control: async () => "D:\ctl", sessionDirectory: () => "D:\work" },
        scopes: () => ALL_SCOPES,
      })
      const own = createOwnStore({
        rpc,
        bus,
        client: () => client as unknown as OpenCodeClient,
        sessionDirectory: () => "D:\work",
      })
      // Watched from effects, as the composer does, while the store still loads.
      watchTargetOffers(own, () => ({ providerID: "own-codex-aaaa", id: "gpt-6-astra" }))
      createEffect(() => onCleanup(own.watchSpeed("ses_speed")))
      bus.publish({ type: "server.connected", id: "x", data: {} } as OpenCodeEvent)
      bus.flush()
      await tick()
      expect(own.state.status).toBe("ready")
      expect(calls.filter((method) => method === "speed.offers")).toHaveLength(1)
      expect(calls.filter((method) => method === "session.speed.get")).toHaveLength(1)
      expect(own.state.speedOffers["own-codex-aaaa gpt-6-astra"]?.offers).toHaveLength(1)
      own.dispose()
      dispose()
    })
  })
})

describe("the speed flow shared by the composer and the switcher (2026-10-10)", () => {
  const CHANGE: Speed.Change = {
    from: "standard",
    to: "fast",
    P: 1000,
    unit: "USD",
    delta: { lo: 0, hi: 0.1, unit: "USD" },
    factor: 2,
    cache: "kept",
    basis: "rule",
    warnings: [],
  }
  const dry = (input: Record<string, unknown>) => ({
    view: view({ choice: input.speed as Speed.Choice, effective: input.speed as Speed.Choice }),
    change: input.speed === "standard" ? null : { ...CHANGE },
    dryRun: input.dryRun === true,
  })

  /** A runtime whose own RPC answers from `answers`; every call is recorded, every applied view kept. */
  function runtimeWith(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = []
    const applied: Speed.View[] = []
    const refreshed: string[] = []
    const speedOffers: Record<string, Speed.Targeted> = {
      "own-codex-aaaa\u0000gpt-6-astra": { providerID: "own-codex-aaaa", modelID: "gpt-6-astra", offers: [FAST] },
    }
    const runtime = {
      kind: "local",
      rpc: {
        allowed: () => true,
        call: async (method: string, input: Record<string, unknown>) => {
          calls.push({ method, input })
          const answer = answers[method]
          if (!answer) throw new Error(`unexpected ${method}`)
          return answer(input)
        },
      },
      own: {
        state: { speedOffers },
        setSpeed: (next: Speed.View) => void applied.push(next),
        refreshSpeed: async (sessionID: string) => void refreshed.push(sessionID),
      },
    }
    const env: SpeedEnv = {
      // SAFETY: the speed flow reaches only these members of a runtime.
      runtime: runtime as unknown as ServerRuntime,
      serverKey: "local",
      i18n: ko,
      fastAck: async () => {},
    }
    return { env, calls, applied, refreshed }
  }

  test("a new conversation keeps its pick, asks the Claude consent first, and sets it before the first prompt", async () => {
    closeAsk()
    const { env, calls, applied, refreshed } = runtimeWith({ "session.speed.set": dry })
    const codex = pendingView({ providerID: "own-codex-aaaa", modelID: "gpt-6-astra", offers: [FAST] }, "standard")
    await requestSpeed(env, { sessionID: undefined, to: "fast", view: codex, offer: FAST })
    expect(pendingChoice("local")).toEqual({ choice: "fast", consent: false })
    expect(calls).toEqual([])
    // The Claude slot: the consent card first; accepting keeps the pick with its consent.
    const claude = pendingView(
      { providerID: "anthropic", modelID: "claude-opus-5-5", offers: [FAST], consent: "needed" },
      "standard",
    )
    await requestSpeed(env, { sessionID: undefined, to: "fast", view: claude })
    expect(speedFlow.ask).toMatchObject({ key: newKey("local"), to: "fast", consent: true, change: null })
    await confirmSpeed(env, speedFlow.ask!)
    expect(pendingChoice("local")).toEqual({ choice: "fast", consent: true })
    // The first send on Codex: Fast is set (with the accepted consent) and the next new conversation is Standard.
    const taken = takeNewSpeed(env.runtime.own, "local", { providerID: "own-codex-aaaa", id: "gpt-6-astra" })
    expect(taken).toEqual({ choice: "fast", consent: true })
    expect(pendingChoice("local").choice).toBe("standard")
    await startSpeed(env, "ses_new", taken)
    expect(calls).toEqual([
      { method: "session.speed.set", input: { sessionID: "ses_new", speed: "fast", consent: true } },
    ])
    expect(applied.map((item) => item.effective)).toEqual(["fast"])
    // Standard, or a pick the target does not offer: no change, the early view is read again.
    await requestSpeed(env, { sessionID: undefined, to: "fast", view: codex, offer: FAST })
    const unoffered = takeNewSpeed(env.runtime.own, "local", { providerID: "own-ds-dddd", id: "deepseek-flash" })
    expect(unoffered.choice).toBe("standard")
    await startSpeed(env, "ses_next", unoffered)
    expect(calls).toHaveLength(1)
    expect(refreshed).toEqual(["ses_next"])
  })

  test("a session's change asks dry first and waits on the cost dialog; Standard applies at once", async () => {
    closeAsk()
    const { env, calls, applied } = runtimeWith({ "session.speed.set": dry })
    await requestSpeed(env, { sessionID: "ses_s", to: "fast", view: view(), offer: FAST })
    expect(calls).toEqual([{ method: "session.speed.set", input: { sessionID: "ses_s", speed: "fast", dryRun: true } }])
    expect(speedFlow.ask).toMatchObject({ key: "ses_s", to: "fast", consent: false, change: { factor: 2 } })
    await confirmSpeed(env, speedFlow.ask!)
    expect(calls.at(-1)).toEqual({ method: "session.speed.set", input: { sessionID: "ses_s", speed: "fast" } })
    await requestSpeed(env, { sessionID: "ses_s", to: "standard", view: view({ choice: "fast", effective: "fast" }) })
    expect(calls.at(-1)).toEqual({ method: "session.speed.set", input: { sessionID: "ses_s", speed: "standard" } })
    expect(applied.map((item) => item.choice)).toEqual(["fast", "standard"])
    expect(speedFlow.busy.ses_s).toBeUndefined()
  })

  test("model and speed together from the switcher: the speed waits for the new main, read fresh", async () => {
    closeAsk()
    const { env, calls } = runtimeWith({ "session.speed.get": () => view(), "session.speed.set": dry })
    afterSwitch("ses_w", { providerID: "own-codex-aaaa", id: "gpt-6-astra" }, "fast")
    // Still on the old main (a dialog or a safe point): nothing yet.
    await landAfterSwitch(env, "ses_w", { providerID: "own-ds-dddd", id: "deepseek-flash" })
    expect(calls).toEqual([])
    expect(speedFlow.after.ses_w).toBeDefined()
    await landAfterSwitch(env, "ses_w", { providerID: "own-codex-aaaa", id: "gpt-6-astra" })
    expect(calls.map((call) => call.method)).toEqual(["session.speed.get", "session.speed.set"])
    expect(calls[1]?.input).toEqual({ sessionID: "ses_w", speed: "fast", dryRun: true })
    expect(speedFlow.after.ses_w).toBeUndefined()
  })

  test("the switcher's row and apply paths (checked in source)", async () => {
    const strip = (text: string) => text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")
    const popover = strip(await Bun.file(path.join(import.meta.dir, "../switcher/popover.tsx")).text())
    expect(popover).toContain('data-testid="switcher-speed"')
    expect(popover).toContain("watchTargetOffers(own, () => (speedHere() ? target() : undefined))")
    expect(popover).toContain("void requestSpeed(speedEnv, { sessionID: undefined, to, view: speed, ...withOffer })")
    expect(popover).toContain("void requestSpeed(speedEnv, { sessionID: id, to, view, ...withOffer })")
    expect(popover.indexOf("afterSwitch(id, ref, to)")).toBeLessThan(
      popover.indexOf("const result = await requestSwitch("),
    )
    expect(popover).toContain('if (settable && (result === "failed" || result === "same")) dropAfterSwitch(id)')
    // The review's blocker: closing ends the `<Show>` behind `props.request`, so apply reads the row first.
    const apply = popover.slice(popover.indexOf("async function apply()"), popover.indexOf("async function applyArea("))
    const read = apply.indexOf("const settable = speed !== undefined && speedSettable()")
    expect(read).toBeGreaterThan(0)
    expect(read).toBeLessThan(apply.indexOf("props.onClose()", apply.indexOf("const id = sessionID()")))
    // The composer lands the speed once the binding names the new main: a reconciled binding keeps its `model` object,
    // so the effect must read the fields themselves to rerun (found in the browser after the review).
    const button = strip(await Bun.file(path.join(import.meta.dir, "speed-button.tsx")).text())
    expect(button).toContain("const main = { providerID: model.providerID, id: model.id }")
    expect(button).toContain("landAfterSwitch(env(), sessionID, main)")
    const same = apply.slice(apply.indexOf("if (isSame()) {"))
    expect(same.indexOf("currentSpeed()")).toBeLessThan(same.indexOf("props.onClose()"))
    expect(apply.slice(apply.lastIndexOf("props.onClose()"))).not.toMatch(
      /speedSettable\(|currentSpeed\(|sessionID\(\)/,
    )
  })
})

describe("pickers hide speed mode entries (02 §4.8)", () => {
  test("a `-fast`/`-ultrafast` entry is not offered; the base model and other modes are", () => {
    const model = (id: string, modelID: string) => ({ id, modelID, enabled: true, status: "active" as const })
    expect(offered(model("gpt-6-astra", "gpt-6-astra"))).toBe(true)
    expect(offered(model("gpt-6-astra-fast", "gpt-6-astra"))).toBe(false)
    expect(offered(model("gpt-6-astra-ultrafast", "gpt-6-astra"))).toBe(false)
    expect(offered(model("claude-opus-5-5-fast", "claude-opus-5-5"))).toBe(false)
    expect(offered(model("gpt-6-astra-pro", "gpt-6-astra"))).toBe(true)
    // An OpenRouter model whose own id ends in -fast is a model, not a mode.
    expect(offered(model("morph/morph-v3-fast", "morph/morph-v3-fast"))).toBe(true)
  })
})

describe("the composer's wiring (checked in source)", () => {
  test("the speed button sits beside the effort for a root session, asks dry first and shows consent and cost", async () => {
    const strip = (text: string) => text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")
    const composer = strip(await Bun.file(path.join(import.meta.dir, "index.tsx")).text())
    const variant = composer.indexOf("<VariantButton")
    const ultra = composer.indexOf("<UltraSwitch")
    const speed = composer.indexOf("<SpeedButton")
    expect(variant).toBeGreaterThan(0)
    // 07 §7.3 (2026-10-10): ultra right after the effort it raises, then the speed.
    expect(ultra).toBeGreaterThan(variant)
    expect(speed).toBeGreaterThan(ultra)
    // Inside the `!child()` block: a child follows its root and shows no control.
    expect(composer.slice(composer.lastIndexOf("<Show when={!child()}>", speed), speed)).not.toContain("</Show>")
    // The new-conversation screen follows its target; the first send sets the picked speed before the prompt.
    expect(composer.slice(speed, composer.indexOf("/>", speed))).toContain(
      "target={props.sessionID() ? undefined : newTarget()}",
    )
    const create = composer.slice(composer.indexOf("async function create("), composer.indexOf("function restore("))
    // The pick is resolved before navigating: leaving the screen releases the target's offers (the review's blocker).
    expect(create.indexOf("takeNewSpeed(current.own, props.serverKey(), target)")).toBeGreaterThan(0)
    expect(create.indexOf("takeNewSpeed(")).toBeLessThan(create.indexOf("router.navigate("))
    expect(create.indexOf("await startSpeed(")).toBeGreaterThan(create.indexOf("await applyStartPreset("))
    expect(create.indexOf("await startSpeed(")).toBeLessThan(create.indexOf("suggest.send("))
    const source = strip(await Bun.file(path.join(import.meta.dir, "speed-button.tsx")).text())
    const flow = strip(await Bun.file(path.join(import.meta.dir, "speed-flow.ts")).text())
    expect(flow).toContain('rpc.call("session.speed.set", { sessionID, speed: input.to, dryRun: true })')
    expect(flow).toContain("needsConsent(input.view, input.to)")
    expect(flow).toContain("...(consent ? { consent: true } : {})")
    expect(source).toContain("own.watchSpeed(sessionID)")
    expect(source).toContain('own.on("session.speed.changed"')
    expect(source).toContain("watchTargetOffers(props.runtime.own")
    // Grey with the reason instead of hidden.
    expect(source).toContain("noneNote(i18n, current())")
  })
})

describe("the speeds' marks (the user's 2026-10-18 report)", () => {
  test("one app icon per speed in front of its name: a bolt for Fast, the bolt with speed lines for Ultrafast", async () => {
    const strip = (text: string) => text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")
    const read = async (file: string) => strip(await Bun.file(path.join(import.meta.dir, file)).text())
    const mark = await read("speed-mark.tsx")
    expect(mark).toContain('name={props.choice === "ultrafast" ? "boltFast" : "bolt"}')
    expect(mark).toContain('<Show when={props.choice !== "standard"}>')
    const icons = await read("../shell/icons.tsx")
    const bolt = /\n {2}bolt: "([^"]+)"/.exec(icons)?.[1]
    const fast = /\n {2}boltFast: "([^"]+)"/.exec(icons)?.[1]
    expect(bolt).toBeDefined()
    expect(fast).toBeDefined()
    expect(fast).not.toBe(bolt)
    // The button, the menu, the cost dialog's title and the switcher's strip; no emoji left.
    const button = await read("speed-button.tsx")
    const switcher = await read("../switcher/popover.tsx")
    expect(button).toContain("<SpeedMark choice={state().mark} />")
    expect(button).toContain("<SpeedMark choice={item.choice} />")
    expect(button).toContain("<SpeedMark choice={pending().to} />")
    expect(switcher).toContain("<SpeedMark choice={item.choice} />")
    for (const source of [button, switcher, await read("speed.ts")]) expect(source).not.toContain("⚡")
  })
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 60))
