// 모바일 미리보기 (08 §4.3) in own-web without a shell: the section's states against the gateway view, the status
// store, and the 만들기 flow (gateway link → shell → this PC's 허용), where the pairing link never enters a state.
import { describe, expect, test } from "bun:test"
import type { GatewayView } from "@/data"
import type { HostMobilePreview, MobilePreview, RemotePcPairResult, RemotePcPairStart } from "@/host/types"
import { createPreviewFlow, createPreviewStatus, previewView, PREVIEW_SCOPES, type PreviewStep } from "./preview-flow"
import { previewEn, previewKo, previewText, type PreviewKey } from "./preview-strings"

const PIN = "A".repeat(43)
const LINK = `ownpc://pair?v=1&k=abcdefghij23&p=${PIN}&c=Q2xhaW1Db2RlXzEyMzQ1Ng&n=PC&r=127.0.0.1%3A28540`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function gateway(app: Partial<NonNullable<GatewayView["app"]>> | null, state: GatewayView["state"] = "listening") {
  return {
    state,
    app: app === null ? undefined : { state: "listening", pcKey: "abcdefghij23", pin: PIN, port: 28540, ...app },
  } as unknown as GatewayView
}

function device(state: Exclude<MobilePreview["state"], "none"> = "connected", change: Partial<MobilePreview> = {}) {
  return {
    state,
    pcKey: "abcdefghij23",
    pin: PIN,
    deviceId: "dev_preview",
    addedAt: 1,
    expiresAt: 2,
    open: false,
    preset: "pixel",
    orientation: "portrait",
    ...change,
  } as MobilePreview
}

function fakeShell() {
  const calls: string[] = []
  const listeners = new Set<(preview: MobilePreview) => void>()
  const status = deferred<MobilePreview>()
  const started = deferred<RemotePcPairStart>()
  const ended = deferred<RemotePcPairResult>()
  const api: HostMobilePreview = {
    status: () => {
      calls.push("status")
      return status.promise
    },
    pair: (link) => {
      calls.push(`pair ${link}`)
      return started.promise
    },
    waitPairing: (id) => {
      calls.push(`wait ${id}`)
      return ended.promise
    },
    cancelPairing: async (id) => void calls.push(`cancel ${id}`),
    open: async (input) => {
      calls.push(`open ${input.port}`)
      return true
    },
    remove: async () => {
      calls.push("remove")
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const push = (preview: MobilePreview) => listeners.forEach((listener) => listener(preview))
  return { api, calls, status, started, ended, push, listeners }
}

function fakeGateway(appLink: string | null = LINK) {
  const calls: string[] = []
  return {
    calls,
    port: {
      start: async (days: number) => {
        calls.push(`start ${days}`)
        return { pairingId: "pair_1", appLink }
      },
      cancel: async (id: string) => void calls.push(`cancel ${id}`),
    },
  }
}

/** Every state the flow goes through, for the "never shows the link" check. */
function recorder(flow: ReturnType<typeof createPreviewFlow>) {
  const seen: PreviewStep[] = []
  const timer = setInterval(() => seen.push(flow.state()), 0)
  return {
    seen,
    stop: () => {
      clearInterval(timer)
      seen.push(flow.state())
    },
  }
}

describe("section states (08 §4.3)", () => {
  test("off while the gateway or the app listener is down; loading until both answers arrive", () => {
    expect(previewView(undefined, gateway({}))).toEqual({ kind: "loading" })
    expect(previewView({ state: "none" }, undefined)).toEqual({ kind: "loading" })
    expect(previewView({ state: "none" }, gateway({}, "off"))).toEqual({ kind: "off", reason: "gateway", device: undefined })
    expect(previewView({ state: "none" }, gateway(null))).toMatchObject({ kind: "off", reason: "app" })
    expect(previewView(device(), gateway({ state: "error" }))).toMatchObject({ kind: "off", reason: "app", device: device() })
  })

  test("none, ready, and stale on reauth or another key of this PC", () => {
    expect(previewView({ state: "none" }, gateway({}))).toEqual({ kind: "none" })
    expect(previewView(device("checking"), gateway({}))).toMatchObject({ kind: "ready" })
    expect(previewView(device("unreachable"), gateway({}))).toMatchObject({ kind: "ready" })
    expect(previewView(device("reauth"), gateway({}))).toMatchObject({ kind: "stale", why: "reauth" })
    expect(previewView(device(), gateway({ pin: "B".repeat(43) }))).toMatchObject({ kind: "stale", why: "mismatch" })
    expect(previewView(device(), gateway({ pcKey: "bbbbbbbbbbbb" }))).toMatchObject({ kind: "stale", why: "mismatch" })
  })
})

describe("status store", () => {
  test("the shell's status, then each change it pushes; a change before the first status wins", async () => {
    const shell = fakeShell()
    const store = createPreviewStatus(shell.api)
    shell.push(device("checking"))
    shell.status.resolve({ state: "none" })
    await tick()
    expect(store.preview()).toMatchObject({ state: "checking" })
    shell.push(device("connected", { open: true }))
    expect(store.preview()).toMatchObject({ state: "connected", open: true })
    store.dispose()
    expect(shell.listeners.size).toBe(0)
  })
})

describe("만들기 flow", () => {
  const ok: RemotePcPairStart = { ok: true, pairingId: "shell_1", pcKey: "abcdefghij23", name: "PC", sas: "4821", expiresAt: 9 }

  test("gateway link → shell → the SAS → this PC's 허용; the link goes to the shell only", async () => {
    const shell = fakeShell()
    const port = fakeGateway()
    const flow = createPreviewFlow(shell.api, port.port)
    const seen = recorder(flow)
    const running = flow.create(7)
    expect(flow.state()).toEqual({ step: "starting" })
    shell.started.resolve(ok)
    await tick()
    expect(flow.state()).toEqual({ step: "waiting", sas: "4821", expiresAt: 9 })
    // A second press while waiting starts nothing.
    await flow.create(30)
    shell.ended.resolve({ ok: true, pcKey: "abcdefghij23", name: "PC" })
    await running
    seen.stop()
    expect(flow.state()).toEqual({ step: "done" })
    expect(port.calls).toEqual(["start 7"])
    expect(shell.calls).toEqual([`pair ${LINK}`, "wait shell_1"])
    expect(JSON.stringify(seen.seen)).not.toContain("ownpc://")
    expect(PREVIEW_SCOPES).not.toContain("terminal")
  })

  test("no loopback link (app listener down): failed, the gateway pairing cancelled, the shell never asked", async () => {
    const shell = fakeShell()
    const port = fakeGateway(null)
    const flow = createPreviewFlow(shell.api, port.port)
    await flow.create(7)
    expect(flow.state()).toEqual({ step: "failed", error: "no_link", detail: undefined })
    expect(port.calls).toEqual(["start 7", "cancel pair_1"])
    expect(shell.calls).toEqual([])
  })

  test("the shell's refusal and this PC's 거부 end it with their reason and cancel the gateway pairing", async () => {
    const refused = fakeShell()
    const first = fakeGateway()
    const flow = createPreviewFlow(refused.api, first.port)
    refused.started.resolve({ ok: false, error: "invalid_link", detail: "loopback" })
    await flow.create(7)
    expect(flow.state()).toEqual({ step: "failed", error: "invalid_link", detail: "loopback" })
    expect(first.calls).toEqual(["start 7", "cancel pair_1"])

    const denied = fakeShell()
    const second = createPreviewFlow(denied.api, fakeGateway().port)
    denied.started.resolve(ok)
    denied.ended.resolve({ ok: false, error: "rejected" })
    await second.create(30)
    expect(second.state()).toEqual({ step: "failed", error: "rejected", detail: undefined })
  })

  test("다시 만들기 removes the stale device first", async () => {
    const shell = fakeShell()
    const flow = createPreviewFlow(shell.api, fakeGateway().port)
    shell.started.resolve(ok)
    shell.ended.resolve({ ok: true, pcKey: "abcdefghij23", name: "PC" })
    await flow.create(7, true)
    expect(shell.calls).toEqual(["remove", `pair ${LINK}`, "wait shell_1"])
  })

  test("cancel while waiting stops the shell and the PC's request, and ignores the late answer", async () => {
    const shell = fakeShell()
    const port = fakeGateway()
    const flow = createPreviewFlow(shell.api, port.port)
    const running = flow.create(7)
    shell.started.resolve(ok)
    await tick()
    flow.cancel()
    expect(flow.state()).toEqual({ step: "idle" })
    shell.ended.resolve({ ok: false, error: "aborted" })
    await running
    expect(flow.state()).toEqual({ step: "idle" })
    expect(shell.calls).toEqual([`pair ${LINK}`, "wait shell_1", "cancel shell_1"])
    expect(port.calls).toEqual(["start 7", "cancel pair_1"])
  })

  test("a broken call is a failure, not an unhandled rejection", async () => {
    const shell = fakeShell()
    const flow = createPreviewFlow(shell.api, {
      start: () => Promise.reject(new Error("gateway_unavailable")),
      cancel: async () => undefined,
    })
    await flow.create(7)
    expect(flow.state()).toEqual({ step: "failed", error: "failed", detail: "gateway_unavailable" })
  })
})

describe("catalog", () => {
  test("Korean and English for every state and error", () => {
    const codes = [
      "invalid_link",
      "no_link",
      "expired",
      "rejected",
      "cancelled",
      "rate_limited",
      "unreachable",
      "pin_mismatch",
      "key_changed",
      "aborted",
      "failed",
    ]
    const keys = [
      ...codes.map((code) => `own.preview.error.${code}`),
      ...["checking", "connected", "unreachable", "reauth"].map((state) => `own.preview.state.${state}`),
    ] as PreviewKey[]
    for (const key of keys) {
      expect(previewKo[key]).toBeTruthy()
      expect(previewEn[key]).toBeTruthy()
    }
    expect(Object.keys(previewEn).sort()).toEqual(Object.keys(previewKo).sort())
    expect(previewText("ko", "own.preview.waiting", { sas: "4821" })).toStartWith("확인 번호 4821 · ")
  })
})
