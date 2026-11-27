// The pickers' listing and `새 폴더` (03 §18.3, 04 §17.4) over a fake own.accounts service: the service's listing with
// locked folders and hidden ones, its refusals in Korean (a folder the user may not read names its owner, missing and
// file paths have their own words), core's listing on an older service (and no `새 폴더` there), and `새 폴더`'s refusals.
import { describe, expect, test } from "bun:test"
import { OwnRpcError } from "@/data/rpc"
import type { I18nParams } from "@/i18n"
import {
  browseFolders,
  canCreate,
  createFailureText,
  createFolder,
  listFailureText,
  lockedText,
  type ListEntry,
} from "./listing"
import { pickerText, type PickerKey } from "./picker-strings"

const ko = (key: PickerKey, params?: I18nParams) => pickerText("ko", key, params)

function service(input: { readonly old?: boolean; readonly allowed?: (method: string) => boolean } = {}) {
  const calls: string[] = []
  const methods: Record<string, (payload: Record<string, unknown>) => unknown> = {
    "folderPicker.list": (payload) => {
      const path = payload.path as string
      if (path === "/lost+found")
        throw new OwnRpcError("folder_list_unavailable", "denied", { reason: "denied", path, owner: "root" })
      if (path === "/nowhere") throw new OwnRpcError("folder_list_unavailable", "missing", { reason: "missing", path })
      if (path === "/etc/hosts")
        throw new OwnRpcError("folder_list_unavailable", "not_folder", { reason: "not_folder", path })
      return {
        path: path === "~" ? "/home/me" : path,
        entries: [
          { name: "projects", locked: false },
          { name: "Archive", locked: false },
          { name: "secret", locked: true, owner: "root" },
        ],
        hidden: 1,
      }
    },
    "folderPicker.create": (payload) => {
      const name = payload.name as string
      if (name === "taken")
        throw new OwnRpcError("folder_create_unavailable", "exists", { reason: "exists", path: `/home/me/${name}` })
      if (name.includes("/"))
        throw new OwnRpcError("folder_create_unavailable", "name", { reason: "name", path: `/home/me/${name}` })
      return { path: `${payload.parent as string}/${name.trim()}` }
    },
  }
  return {
    calls,
    rpc: {
      allowed: (method: string) => input.allowed?.(method) ?? true,
      async call(method: string, payload: Record<string, unknown>) {
        calls.push(method)
        if (input.old) throw new OwnRpcError("rpc.method_not_found", method)
        const handler = methods[method]
        if (!handler) throw new Error(`no ${method}`)
        return handler(payload)
      },
    },
  }
}

// SAFETY: the fake implements the two methods the module calls; the rest of the RPC surface is never touched.
const runtime = (fake: ReturnType<typeof service>) => fake as unknown as Parameters<typeof browseFolders>[0]

describe("browseFolders", () => {
  test("the service's listing: sorted, locked folders with their owner, hidden ones counted, ~ resolved", async () => {
    const fake = service()
    const listed = await browseFolders(runtime(fake), "~", async () => {
      throw new Error("core must not be asked")
    })
    expect(listed).toEqual({
      path: "/home/me",
      entries: [
        { name: "Archive", locked: false },
        { name: "projects", locked: false },
        { name: "secret", locked: true, owner: "root" },
      ],
      hidden: 1,
    })
    expect(lockedText(ko, listed.entries[2]!)).toBe("읽을 권한이 없어요 (소유자: root)")
    expect(lockedText(ko, { name: "x", locked: true } satisfies ListEntry)).toBe("읽을 권한이 없어요")
  })

  test("a refused listing says why: no permission with the owner, missing, a file", async () => {
    const fake = service()
    const failure = (path: string) =>
      browseFolders(runtime(fake), path, async () => []).then(
        () => "listed",
        (error: unknown) => listFailureText(ko, error),
      )
    expect(await failure("/lost+found")).toBe("이 폴더는 읽을 권한이 없어요 (소유자: root).")
    expect(await failure("/nowhere")).toBe("이 경로에 폴더가 없어요: /nowhere")
    expect(await failure("/etc/hosts")).toBe("폴더가 아니에요 (파일이에요): /etc/hosts")
    expect(listFailureText(ko, new Error("network"))).toBe("이 폴더를 읽지 못했어요. 잠시 뒤 다시 해 보세요.")
  })

  test("an older service lists with core's fs.list, once asked, and offers no 새 폴더", async () => {
    const fake = service({ old: true })
    expect(canCreate(runtime(fake))).toBe(true)
    const first = await browseFolders(runtime(fake), "/srv", async () => ["b", "a"])
    expect(first).toEqual({
      path: "/srv",
      entries: [
        { name: "b", locked: false },
        { name: "a", locked: false },
      ],
      hidden: 0,
    })
    await browseFolders(runtime(fake), "/srv/a", async () => [])
    expect(fake.calls).toEqual(["folderPicker.list"])
    expect(canCreate(runtime(fake))).toBe(false)
  })

  test("any other failure of the service's listing lists with core that time", async () => {
    const fake = service()
    const broken = { ...fake, rpc: { ...fake.rpc, call: async () => Promise.reject(new Error("plugin not loaded")) } }
    expect(await browseFolders(runtime(broken), "/srv", async () => ["a"])).toEqual({
      path: "/srv",
      entries: [{ name: "a", locked: false }],
      hidden: 0,
    })
    expect(canCreate(runtime(broken))).toBe(true)
  })

  test("a connection without the prompt scope lists with core and makes no folders", async () => {
    const fake = service({ allowed: (method) => !method.startsWith("folderPicker.") })
    expect(await browseFolders(runtime(fake), "/srv", async () => ["a"])).toMatchObject({ entries: [{ name: "a" }] })
    expect(fake.calls).toEqual([])
    expect(canCreate(runtime(fake))).toBe(false)
  })
})

describe("createFolder", () => {
  test("answers the new folder; an existing name and an invalid name are refused in Korean", async () => {
    const fake = service()
    expect(await createFolder(runtime(fake), "/home/me", "새 프로젝트")).toBe("/home/me/새 프로젝트")
    const refused = (name: string) =>
      createFolder(runtime(fake), "/home/me", name).then(
        () => "made",
        (error: unknown) => createFailureText(ko, error),
      )
    expect(await refused("taken")).toBe("같은 이름이 이미 있어요.")
    expect(await refused("a/b")).toBe("폴더 이름으로 쓸 수 없어요. `/` 없이 폴더 이름 하나만 입력하세요.")
  })

  test("an older service says so and hides the action from then on", async () => {
    const fake = service({ old: true })
    const text = await createFolder(runtime(fake), "/home/me", "x").then(
      () => "made",
      (error: unknown) => createFailureText(ko, error),
    )
    expect(text).toBe("이 서버의 서비스가 오래돼서 여기서 폴더를 만들 수 없어요. 서버를 업데이트하세요.")
    expect(canCreate(runtime(fake))).toBe(false)
  })
})
