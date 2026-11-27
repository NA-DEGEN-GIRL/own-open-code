import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { OwnCreator } from "@own/protocol/rpc-creator"
import { createCreatorRpc, creatorChanged, creatorRpcOf, CREATOR_ID, CREATOR_SCOPE } from "@/data/creator-rpc"
import { ALL_SCOPES, OwnRpcError, type OwnScope } from "@/data/rpc"
import { failure, hostFolderOk, hostStateKey, reachKey, versions, withFolder, withHost, withoutFolder } from "./model"
import { creatorEn, creatorKo, creatorText } from "./strings"

describe("own.creator client contract", () => {
  test("id and scope table match the definition", () => {
    expect(CREATOR_ID).toBe(OwnCreator.ID)
    expect(CREATOR_SCOPE).toEqual(OwnCreator.MethodScope)
    expect(Object.keys(CREATOR_SCOPE).sort()).toEqual(Object.keys(OwnCreator.Definition.methods).sort())
  })

  test("writes need `local`: a paired device reads but never changes extensions (17 §8.2)", () => {
    const rpc = (scopes: ReadonlySet<OwnScope>) =>
      createCreatorRpc({
        client: () => {
          throw new Error("not called")
        },
        control: async () => "C:/work",
        scopes: () => scopes,
      })
    expect(rpc(ALL_SCOPES).allowed("rollback")).toBe(true)
    expect(rpc(new Set<OwnScope>(["read", "prompt", "switch", "admin"])).allowed("enabled.set")).toBe(false)
    expect(rpc(new Set<OwnScope>(["read"])).allowed("list")).toBe(true)
    const device = creatorRpcOf({
      client: () => {
        throw new Error("not called")
      },
      control: async () => "C:/work",
      entry: () => ({ auth: "device", scopes: ["read", "local"] }) as never,
    })
    expect(device.allowed("list")).toBe(true)
    expect(device.allowed("scope.set")).toBe(false)
  })

  test("a refused write fails before any request", async () => {
    const rpc = createCreatorRpc({
      client: () => {
        throw new Error("not called")
      },
      control: async () => "C:/work",
      scopes: () => new Set<OwnScope>(["read"]),
    })
    await expect(rpc.call("remove", { id: "x" })).rejects.toBeInstanceOf(OwnRpcError)
  })

  test("the change event is recognised by its name", () => {
    expect(creatorChanged({ type: "rpc.own.creator.changed" } as never)).toBe(true)
    expect(creatorChanged({ type: "rpc.own.harness.session.changed" } as never)).toBe(false)
  })
})

describe("설정 > 확장 strings", () => {
  test("English keys are Korean keys; Korean has every key the page uses", () => {
    const keys = Object.keys(creatorKo)
    for (const key of Object.keys(creatorEn)) expect(keys).toContain(key)
    const source = readFileSync(path.join(import.meta.dir, "settings.tsx"), "utf8")
    const model = readFileSync(path.join(import.meta.dir, "model.ts"), "utf8")
    const hosts = readFileSync(path.join(import.meta.dir, "hosts.tsx"), "utf8")
    const used = [...`${source}\n${model}\n${hosts}`.matchAll(/"(own\.ext\.[A-Za-z_.]+)"/g)].map((match) => match[1]!)
    for (const key of used) expect(keys).toContain(key)
  })

  test("particles follow the title", () => {
    expect(creatorText.text("ko", "own.ext.done.enabled", { title: "규칙" })).toBe("규칙을 켰어요.")
    expect(creatorText.text("ko", "own.ext.done.disabled", { title: "도구" })).toBe("도구를 껐어요.")
  })

  test("the page keeps its strings and its client in the lazy chunk (PF5)", () => {
    const source = readFileSync(path.join(import.meta.dir, "settings.tsx"), "utf8")
    expect(source).toContain('import { useCreatorText } from "./strings"')
    expect(source).toContain('from "@/data/creator-rpc"')
    const index = readFileSync(path.join(import.meta.dir, "..", "settings", "index.tsx"), "utf8")
    expect(index).toContain('lazy(() => import("@/creator/settings"))')
    const server = readFileSync(path.join(import.meta.dir, "..", "data", "server.ts"), "utf8")
    expect(server).not.toContain("creator-rpc")
  })
})

describe("model", () => {
  test("versions newest first, the active one marked", () => {
    const listed = versions({
      active: 1,
      versions: [
        { n: 1, hash: "a", createdAt: 1, by: "model" },
        { n: 2, hash: "b", createdAt: 2, by: "user" },
      ],
    })
    expect(listed.map((item) => [item.n, item.current])).toEqual([
      [2, false],
      [1, true],
    ])
  })

  test("folders are added once and taken out", () => {
    expect(withFolder(["C:\\work\\app"], "c:/work/app/")).toEqual(["C:\\work\\app"])
    expect(withFolder(["C:\\work\\app"], "D:\\other")).toEqual(["C:\\work\\app", "D:\\other"])
    expect(withoutFolder(["C:\\a", "C:\\b"], "C:\\a")).toEqual(["C:\\b"])
  })

  test("a refused write names the problems", () => {
    const refused = failure(new OwnRpcError("invalid", "x", { problems: [{ path: "items", message: "tool taken" }] }))
    expect(refused).toEqual({ key: "own.ext.error.invalid", problems: "tool taken" })
    expect(failure(new OwnRpcError("own.scope_denied", "x")).key).toBe("own.ext.error.scope")
    expect(failure(new Error("x")).key).toBe("own.ext.error.other")
  })
})

describe("SSH hosts of an extension (17 §10)", () => {
  test("every reach and host state has its words", () => {
    const keys = Object.keys(creatorKo)
    for (const reach of ["sent", "excluded", "out_of_scope", "pc_only", "inactive"] as const)
      expect(keys).toContain(reachKey(reach))
    const line = (state?: { status: string }) =>
      ({ host: "h-abc123", reach: "sent", ...(state ? { state: { id: "x", n: 1, problems: [], ...state } } : {}) }) as const
    expect(hostStateKey(line())).toEqual({ key: "own.ext.host.waiting" })
    expect(hostStateKey(line({ status: "active" }))).toEqual({ key: "own.ext.host.active" })
    expect(hostStateKey(line({ status: "failed" }))).toEqual({ key: "own.ext.host.failed" })
    expect(hostStateKey(line({ status: "tampered" }))).toEqual({ key: "own.ext.host.other", status: "tampered" })
    expect(hostStateKey({ host: "h-abc123", reach: "pc_only" })).toBeUndefined()
    // Withdrawn here while the host's last report still has it on (CRM-34).
    expect(hostStateKey({ ...line({ status: "active" }), reach: "pc_only" })).toEqual({ key: "own.ext.host.stale" })
    expect(hostStateKey({ ...line({ status: "failed" }), reach: "excluded" })).toBeUndefined()
    for (const key of ["own.ext.host.waiting", "own.ext.host.active", "own.ext.host.failed", "own.ext.host.other"])
      expect(keys).toContain(key)
  })

  test("a host is chosen once or taken out; host folders are absolute host paths", () => {
    expect(withHost({ mode: "only", ids: ["h-aaa111"] }, "h-bbb222", true)).toEqual({ mode: "only", ids: ["h-aaa111", "h-bbb222"] })
    expect(withHost({ mode: "only", ids: ["h-aaa111"] }, "h-aaa111", true)).toEqual({ mode: "only", ids: ["h-aaa111"] })
    expect(withHost({ mode: "except", ids: ["h-aaa111"] }, "h-aaa111", false)).toEqual({ mode: "except", ids: [] })
    expect(hostFolderOk("/home/me/work")).toBe(true)
    expect(hostFolderOk("C:\\work")).toBe(true)
    expect(hostFolderOk("work")).toBe(false)
    expect(hostFolderOk("~/work")).toBe(false)
  })

  test("the per-host code plugin allowance shows the same honest risk as this PC's approval", () => {
    expect(creatorKo["own.ext.hostTrust.risk"]).toContain("나(사용자)로 돌아요")
    expect(creatorKo["own.ext.hostTrust.risk"]).toContain("토큰·키·자격 증명")
    expect(creatorKo["own.ext.hostTrust.risk"]).toContain("해시를 다시 확인")
    const hosts = readFileSync(path.join(import.meta.dir, "hosts.tsx"), "utf8")
    expect(hosts).toContain('"own.ext.hostTrust.risk"')
    expect(creatorText.text("ko", "own.ext.done.hosts", { title: "규칙" })).toBe("규칙을 받을 호스트를 바꿨어요.")
  })
})
