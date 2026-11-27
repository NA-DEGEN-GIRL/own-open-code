import { describe, expect, test } from "bun:test"
import { serverCapabilities } from "./capabilities"
import { remoteClientId } from "./client-id"
import {
  accountAllowed,
  catalogList,
  destinationHost,
  hostStatus,
  newerList,
  overlayKind,
} from "./state"

const view = (stage: string, extra: Record<string, unknown> = {}) =>
  ({ stage, paused: false, error: null, owner: { clientId: null }, ...extra }) as never

describe("host status (04 §17.2, §17.9)", () => {
  test("ready is live only while the host's stream is connected", () => {
    expect(hostStatus(view("ready"), "connected")).toMatchObject({
      key: "ready",
      symbol: "●",
      tone: "ok",
      stale: false,
    })
    expect(hostStatus(view("ready"), "reconnecting")).toMatchObject({ key: "connecting", symbol: "◐", stale: true })
    expect(hostStatus(view("ready"), undefined)).toMatchObject({ key: "connecting", stale: true })
  })

  test("host-only symbols: ⤓ update/install needed, ! sign-in or host key", () => {
    expect(hostStatus(view("incompatible"), undefined)).toMatchObject({ key: "incompatible", symbol: "⤓" })
    expect(hostStatus(view("needs_install"), undefined)).toMatchObject({ key: "needsInstall", symbol: "⤓" })
    expect(hostStatus(view("authentication"), undefined)).toMatchObject({ key: "authentication", symbol: "!" })
    expect(hostStatus(view("failed", { paused: true, error: "host_key" }), undefined)).toMatchObject({
      key: "hostKey",
      symbol: "!",
    })
    expect(hostStatus(view("failed", { paused: true, error: "other_owner" }), undefined).key).toBe("otherOwner")
  })

  test("a failed but retrying host reads as connecting; a paused failure as failed", () => {
    expect(hostStatus(view("failed", { error: "connection" }), undefined).key).toBe("connecting")
    expect(hostStatus(view("failed", { paused: true, error: "connection" }), undefined).key).toBe("failed")
    expect(hostStatus(view("disconnected", { paused: true }), undefined)).toMatchObject({
      key: "disconnected",
      symbol: "○",
    })
  })
})

describe("session overlay (04 §17.7)", () => {
  test("nothing for a live host", () => {
    expect(overlayKind(view("ready"), "connected", "c-me")).toBeUndefined()
  })

  test("reconnecting while not paused, paused otherwise", () => {
    expect(overlayKind(view("ready"), "reconnecting", "c-me")).toBe("reconnecting")
    expect(overlayKind(view("connecting"), undefined, "c-me")).toBe("reconnecting")
    expect(overlayKind(view("disconnected", { paused: true }), undefined, "c-me")).toBe("paused")
    expect(overlayKind(view("failed", { paused: true, error: "connection" }), undefined, "c-me")).toBe("failed")
  })

  test("sign-in owned by another window shows 다른 창에서 인증 중", () => {
    expect(overlayKind(view("authentication", { owner: { clientId: "c-other" } }), undefined, "c-me")).toBe("elsewhere")
    expect(overlayKind(view("authentication", { owner: { clientId: "c-me" } }), undefined, "c-me")).toBe(
      "authentication",
    )
    expect(overlayKind(view("authentication", { paused: true }), undefined, "c-me")).toBe("authentication")
  })

  test("host key, version skew, install and owner states", () => {
    expect(overlayKind(view("failed", { paused: true, error: "host_key" }), undefined, "c")).toBe("hostKey")
    expect(overlayKind(view("incompatible", { paused: true, error: "version_skew" }), undefined, "c")).toBe(
      "incompatible",
    )
    expect(overlayKind(view("needs_install", { paused: true }), undefined, "c")).toBe("needsInstall")
    expect(overlayKind(view("failed", { paused: true, error: "other_owner" }), undefined, "c")).toBe("otherOwner")
  })
})

describe("catalog as a session list snapshot (04 §12.3)", () => {
  const catalog = {
    epoch: 3,
    fetchedAt: 1_000,
    projects: [{ id: "p1", directory: "/home/me/work/game", name: "game", updatedAt: 900 }],
    sessions: [
      {
        id: "s1",
        directory: "/home/me/work/game",
        title: "빌드 스크립트 정리",
        updatedAt: 950,
        model: { providerID: "oai", modelID: "gpt" },
      },
      { id: "s2", directory: "/srv/other", title: "other", updatedAt: 800, model: null },
    ],
  }

  test("rows carry titles, times, model and project; unknown folders get a folder project", () => {
    const list = catalogList("h-abc123", catalog)!
    expect(list.serverKey).toBe("h-abc123")
    expect(list.savedAt).toBe(1_000)
    expect(list.sessions[0]).toMatchObject({
      id: "s1",
      projectID: "p1",
      model: { providerID: "oai", id: "gpt" },
      updated: 950,
    })
    expect(list.sessions[1]).toMatchObject({ id: "s2", projectID: "dir:/srv/other" })
    expect(list.projects.map((project) => project.id)).toEqual(["p1", "dir:/srv/other"])
    expect(JSON.stringify(list)).not.toContain("token")
  })

  test("an empty catalog is no snapshot; the newer of the two wins", () => {
    expect(catalogList("h-abc123", { epoch: 0, fetchedAt: null, projects: [], sessions: [] })).toBeUndefined()
    const cached = { serverKey: "h", savedAt: 500, sessions: [], projects: [] }
    const fromCatalog = { serverKey: "h", savedAt: 900, sessions: [], projects: [] }
    expect(newerList(cached, fromCatalog)).toBe(fromCatalog)
    expect(newerList({ ...cached, savedAt: 2_000 }, fromCatalog)?.savedAt).toBe(2_000)
    expect(newerList(undefined, fromCatalog)).toBe(fromCatalog)
    expect(newerList(cached, undefined)).toBe(cached)
  })
})

describe("helpers", () => {
  test("badge shows user@host (the port is dropped)", () => {
    expect(destinationHost("me@hp.example:2222")).toBe("me@hp.example")
    expect(destinationHost("me@lab")).toBe("me@lab")
    expect(destinationHost(null)).toBeUndefined()
  })

  test("host account scope", () => {
    expect(accountAllowed({ mode: "all" }, "a1")).toBe(true)
    expect(accountAllowed({ mode: "only", ids: ["a2"] }, "a1")).toBe(false)
    expect(accountAllowed({ mode: "only", ids: ["a1"] }, "a1")).toBe(true)
  })

  test("local-only capabilities are off for SSH servers (03 §16.7, 04 §12.5)", () => {
    const host = {
      windowControlsOverlay: true,
      nativeDirectoryPicker: true,
      nativeFilePaths: true,
      openInApp: true,
      clipboardImage: true,
      saveDialog: true,
      osNotifications: "native",
      browserPane: true,
      serviceControl: true,
      multiWindow: true,
      keepScreenAwake: false,
      touch: false,
      offlineCatalog: false,
    } as const
    expect(serverCapabilities(host, { kind: "local" })).toBe(host)
    expect(serverCapabilities(host, { kind: "ssh" })).toMatchObject({
      nativeDirectoryPicker: false,
      nativeFilePaths: false,
      openInApp: false,
      clipboardImage: true,
      saveDialog: true,
    })
  })

  test("clientId lives in the tab's sessionStorage (04 §6.3: same owner after a reload)", () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const first = remoteClientId(storage)
    expect(first).toMatch(/^c-[a-z0-9-]{8,64}$/)
    expect(remoteClientId(storage)).toBe(first)
    expect(remoteClientId({ getItem: () => null, setItem: () => {} })).not.toBe(first)
  })
})
