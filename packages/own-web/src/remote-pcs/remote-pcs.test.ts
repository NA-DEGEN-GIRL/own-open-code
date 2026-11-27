// 원격 PC (08 §4.1) in own-web without a shell: the list store over `host.remotePcs`, the `다른 PC 추가` flow (link →
// confirmation number → approved, and every way it ends otherwise), and the catalog. The host side is a plain object
// implementing HostRemotePcs whose answers each test releases by hand.
import { describe, expect, test } from "bun:test"
import type { HostRemotePcs, RemotePc, RemotePcPairResult, RemotePcPairStart } from "@/host/types"
import { createPairingFlow, pairingError } from "./pairing"
import { createRemotePcStore } from "./store"
import { remotePcDialogEn, remotePcDialogKo, remotePcDialogText, type RemotePcDialogKey } from "./dialog-strings"
import { remotePcEn, remotePcKo, type RemotePcKey } from "./strings"

const LINK =
  "ownpc://pair?v=1&k=abcdefghij23&p=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&c=Q2xhaW1Db2RlXzEyMzQ1Ng&n=%EC%A7%91%20PC&r=pc.tail1234.ts.net%3A28540"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const pc = (pcKey: string, state: RemotePc["state"] = "connected"): RemotePc => ({
  pcKey,
  name: `PC ${pcKey}`,
  state,
  addedAt: 1,
  expiresAt: 2,
  open: false,
})

function fakeShell() {
  const calls: string[] = []
  const listeners = new Set<(pcs: readonly RemotePc[]) => void>()
  const listed = deferred<readonly RemotePc[]>()
  const started = deferred<RemotePcPairStart>()
  const ended = deferred<RemotePcPairResult>()
  const api: HostRemotePcs = {
    list: () => {
      calls.push("list")
      return listed.promise
    },
    pair: (link) => {
      calls.push(`pair ${link.slice(0, 13)}`)
      return started.promise
    },
    waitPairing: (id) => {
      calls.push(`wait ${id}`)
      return ended.promise
    },
    cancelPairing: async (id) => void calls.push(`cancel ${id}`),
    open: async (pcKey) => {
      calls.push(`open ${pcKey}`)
      return true
    },
    remove: async (pcKey) => {
      calls.push(`remove ${pcKey}`)
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const push = (pcs: readonly RemotePc[]) => listeners.forEach((listener) => listener(pcs))
  return { api, calls, listed, started, ended, push, listeners }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("list store", () => {
  test("the shell's list, then each change it pushes; open and remove go to the shell", async () => {
    const shell = fakeShell()
    const store = createRemotePcStore(shell.api)
    expect(store.loaded()).toBe(false)
    shell.listed.resolve([pc("aaaaaaaaaaaa", "checking")])
    await tick()
    expect(store.loaded()).toBe(true)
    expect(store.pcs().map((item) => item.state)).toEqual(["checking"])
    shell.push([pc("aaaaaaaaaaaa"), pc("bbbbbbbbbbbb", "reauth")])
    expect(store.pcs().map((item) => `${item.pcKey} ${item.state}`)).toEqual([
      "aaaaaaaaaaaa connected",
      "bbbbbbbbbbbb reauth",
    ])
    store.open("aaaaaaaaaaaa")
    expect(await store.remove("bbbbbbbbbbbb")).toBe(true)
    expect(shell.calls).toEqual(["list", "open aaaaaaaaaaaa", "remove bbbbbbbbbbbb"])
    store.dispose()
    expect(shell.listeners.size).toBe(0)
  })

  test("a change pushed before the first list arrives wins over that list", async () => {
    const shell = fakeShell()
    const store = createRemotePcStore(shell.api)
    shell.push([pc("aaaaaaaaaaaa", "unreachable")])
    shell.listed.resolve([pc("aaaaaaaaaaaa", "checking")])
    await tick()
    expect(store.pcs().map((item) => item.state)).toEqual(["unreachable"])
  })
})

describe("원격 PC 추가 flow (08 §3.5)", () => {
  test("link → confirmation number → approved", async () => {
    const shell = fakeShell()
    const flow = createPairingFlow(shell.api)
    const running = flow.start(`  ${LINK}  `)
    expect(flow.state()).toEqual({ step: "starting" })
    shell.started.resolve({
      ok: true,
      pairingId: "p1",
      pcKey: "abcdefghij23",
      name: "집 PC",
      sas: "4821",
      expiresAt: 9,
    })
    await tick()
    expect(flow.state()).toEqual({
      step: "waiting",
      pairingId: "p1",
      pcKey: "abcdefghij23",
      name: "집 PC",
      sas: "4821",
    })
    // A second press while waiting starts nothing.
    await flow.start(LINK)
    shell.ended.resolve({ ok: true, pcKey: "abcdefghij23", name: "집 PC" })
    await running
    expect(flow.state()).toEqual({ step: "done", pcKey: "abcdefghij23", name: "집 PC" })
    expect(shell.calls).toEqual(["pair ownpc://pair?", "wait p1"])
  })

  test("a pasted text that is no link is explained without asking the shell", async () => {
    const shell = fakeShell()
    const flow = createPairingFlow(shell.api)
    await flow.start("https://pc.tail1234.ts.net/auth/connect/abc")
    expect(flow.state()).toEqual({ step: "failed", error: "invalid_link" })
    await flow.start(LINK.replace("v=1", "v=2"))
    expect(flow.state()).toMatchObject({ error: "invalid_link" })
    expect(shell.calls).toEqual([])
  })

  test("the shell's refusals and the PC's answers end it with their reason", async () => {
    const refused = fakeShell()
    const first = createPairingFlow(refused.api)
    refused.started.resolve({ ok: false, error: "unreachable" })
    await first.start(LINK)
    expect(first.state()).toEqual({ step: "failed", error: "unreachable", detail: undefined })

    const rejected = fakeShell()
    const second = createPairingFlow(rejected.api)
    rejected.started.resolve({
      ok: true,
      pairingId: "p2",
      pcKey: "abcdefghij23",
      name: "집 PC",
      sas: "1234",
      expiresAt: 9,
    })
    rejected.ended.resolve({ ok: false, error: "rejected" })
    await second.start(LINK)
    expect(second.state()).toMatchObject({ step: "failed", error: "rejected" })
    // Another try from a failure is allowed.
    const retry = fakeShell()
    const third = createPairingFlow(retry.api)
    retry.started.resolve({ ok: false, error: "failed", detail: "HTTP 500" })
    await third.start(LINK)
    expect(pairingError((key, params) => remotePcDialogText("ko", key, params), third.state())).toBe(
      "연결하지 못했어요 (HTTP 500).",
    )
  })

  test("cancel while waiting stops the shell's wait and ignores its late answer", async () => {
    const shell = fakeShell()
    const flow = createPairingFlow(shell.api)
    const running = flow.start(LINK)
    shell.started.resolve({
      ok: true,
      pairingId: "p3",
      pcKey: "abcdefghij23",
      name: "집 PC",
      sas: "4821",
      expiresAt: 9,
    })
    await tick()
    flow.cancel()
    expect(flow.state()).toEqual({ step: "idle" })
    shell.ended.resolve({ ok: false, error: "aborted" })
    await running
    expect(flow.state()).toEqual({ step: "idle" })
    expect(shell.calls).toEqual(["pair ownpc://pair?", "wait p3", "cancel p3"])
  })

  test("cancel while the shell opens the link: the pairing it then reports is cancelled too", async () => {
    const shell = fakeShell()
    const flow = createPairingFlow(shell.api)
    const running = flow.start(LINK)
    flow.cancel()
    shell.started.resolve({
      ok: true,
      pairingId: "p4",
      pcKey: "abcdefghij23",
      name: "집 PC",
      sas: "4821",
      expiresAt: 9,
    })
    await running
    await tick()
    expect(flow.state()).toEqual({ step: "idle" })
    expect(shell.calls).toEqual(["pair ownpc://pair?", "cancel p4"])
  })

  test("a broken IPC call is a failure, not an unhandled rejection", async () => {
    const shell = fakeShell()
    const flow = createPairingFlow({ ...shell.api, pair: () => Promise.reject(new Error("IPC gone")) })
    await flow.start(LINK)
    expect(flow.state()).toEqual({ step: "failed", error: "failed", detail: "IPC gone" })
  })
})

describe("catalog", () => {
  test("every failure code and state has Korean and English text", () => {
    const codes = [
      "invalid_link",
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
    for (const key of codes.map((code) => `own.remotePc.error.${code}`) as RemotePcDialogKey[]) {
      expect(remotePcDialogKo[key]).toBeTruthy()
      expect(remotePcDialogEn[key]).toBeTruthy()
    }
    const states = ["checking", "connected", "unreachable", "reauth"]
    for (const key of states.map((state) => `own.remotePc.state.${state}`) as RemotePcKey[]) {
      expect(remotePcKo[key]).toBeTruthy()
      expect(remotePcEn[key]).toBeTruthy()
    }
    expect(Object.keys(remotePcEn).sort()).toEqual(Object.keys(remotePcKo).sort())
    expect(Object.keys(remotePcDialogEn).sort()).toEqual(Object.keys(remotePcDialogKo).sort())
  })

  test("the confirmation line reads like 03's SAS copy, particles resolved", () => {
    expect(remotePcDialogText("ko", "own.remotePc.sas", { sas: "4821", name: "집 PC" })).toBe(
      "확인 번호 4821 · 집 PC에서 이 번호가 보이면 [허용]을 누르세요",
    )
    expect(remotePcDialogText("ko", "own.remotePc.done", { name: "집 PC" })).toBe("집 PC를 추가했어요.")
    expect(remotePcDialogText("ko", "own.remotePc.removeTitle", { name: "회사 노트북" })).toBe(
      "회사 노트북을 목록에서 뺄까요?",
    )
  })
})
