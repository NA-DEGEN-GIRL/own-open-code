// 설정 > 승인·권한 `에이전트가 못 여는 파일·폴더` (01 §13, 03 §18.8, PP) over a fake own.accounts service: the view and
// the suggestions load on this PC's window, a phone or another PC (no `local` scope) reads the list without editing it
// or asking for suggestions, add and remove come back as the service's view and say so, a refused path names its
// reason, an older service says it does not know the setting, another window's change is followed; the built-in list
// is grouped in the page's order; both catalogs carry every key. The page itself is checked through its source where
// only wiring is left (the native pickers on this PC's service only, the read-only notice, the shell note).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createRoot } from "solid-js"
import type { ServerRuntime } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import { addError, GROUPS, grouped, protectedState, type ProtectedView } from "./state"
import { protectedEn, protectedKo, protectedText, type ProtectedKey } from "./strings"

const HOME = "C:\\Users\\me"
const ko = (key: ProtectedKey, params?: Readonly<Record<string, string | number>>) => protectedText("ko", key, params)

type Listener = (event: { readonly data: Record<string, unknown> }) => void

function service(input: { readonly local?: boolean; readonly old?: boolean } = {}) {
  const state = { user: [] as Array<{ path: string; resolved: string }> }
  const calls: string[] = []
  const listeners = new Map<string, Set<Listener>>()
  const view = (): ProtectedView => ({
    home: HOME,
    builtIn: [
      { id: "wallet-x", group: "wallet", paths: ["~\\AppData\\Roaming\\Bitcoin"], reason: "Bitcoin Core 지갑이에요" },
      { id: "ssh", group: "keys", paths: ["~\\.ssh"], reason: "SSH 개인 키와 접속하는 서버 목록이 있어요" },
      { id: "own-vault", group: "own", paths: ["C:\\own\\vault"], reason: "own의 계정 키 보관함이에요" },
    ],
    user: [...state.user],
  })
  const methods: Record<string, (payload: Record<string, unknown>) => unknown> = {
    "protectedPaths.get": () => view(),
    "protectedPaths.suggest": () => ({
      items: [{ name: "wallet-backups", path: `${HOME}\\wallet-backups`, folder: true }].filter(
        (item) => !state.user.some((entry) => entry.resolved === item.path),
      ),
    }),
    "protectedPaths.add": (payload) => {
      const typed = String(payload.path)
      if (!/^(~|[A-Z]:\\)/.test(typed))
        throw new OwnRpcError("protected_path_invalid", "relative", { reason: "relative", path: typed })
      const resolved = typed.startsWith("~") ? `${HOME}${typed.slice(1).replaceAll("/", "\\")}` : typed
      if (!state.user.some((entry) => entry.resolved === resolved)) state.user.push({ path: typed, resolved })
      return view()
    },
    "protectedPaths.remove": (payload) => {
      state.user = state.user.filter((entry) => entry.path !== payload.path && entry.resolved !== payload.path)
      return view()
    },
  }
  const local = input.local ?? true
  // SAFETY: the state reads only these members of a server runtime.
  const runtime = {
    key: "local",
    rpc: {
      allowed: (method: string) => local || method === "protectedPaths.get",
      call: async (method: string, payload: Record<string, unknown>) => {
        calls.push(method)
        if (input.old) throw new OwnRpcError("rpc.method_not_found", `Unknown RPC method: own.accounts.${method}`)
        return methods[method]!(payload)
      },
    },
    own: {
      on: (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>()
        listeners.set(name, set)
        set.add(listener)
        return () => set.delete(listener)
      },
    },
  } as unknown as ServerRuntime
  return {
    runtime,
    calls,
    state,
    view,
    emit(name: string, data: Record<string, unknown>) {
      for (const listener of listeners.get(name) ?? []) listener({ data })
    },
  }
}

const inRoot = <T>(run: () => Promise<T>) =>
  createRoot(async (dispose) => {
    try {
      return await run()
    } finally {
      dispose()
    }
  })

describe("the protected paths section's state", () => {
  test("this PC's window: loads the view and the suggestions, adds a typed path and a suggestion, removes one", () =>
    inRoot(async () => {
      const fake = service()
      const state = protectedState(fake.runtime, ko)
      expect(state.editable()).toBe(true)
      await state.load()
      expect(fake.calls).toEqual(["protectedPaths.get", "protectedPaths.suggest"])
      expect(state.view()?.user).toEqual([])
      expect(state.suggestions().map((item) => item.name)).toEqual(["wallet-backups"])

      state.setDraft("  D:\\keys  ")
      await state.add(state.draft())
      expect(state.view()?.user).toEqual([{ path: "D:\\keys", resolved: "D:\\keys" }])
      expect(state.draft()).toBe("")
      expect(state.status.message()).toEqual({ text: ko("own.protected.added", { path: "D:\\keys" }), tone: "ok" })

      await state.add(state.suggestions()[0]!.path)
      expect(state.view()?.user.map((entry) => entry.resolved)).toEqual(["D:\\keys", `${HOME}\\wallet-backups`])
      expect(state.suggestions()).toEqual([])
      // The same path again: the view is unchanged and the page says it is listed already.
      await state.add("D:\\keys")
      expect(state.status.message()?.text).toBe(ko("own.protected.already"))

      await state.remove("D:\\keys")
      expect(state.view()?.user.map((entry) => entry.path)).toEqual([`${HOME}\\wallet-backups`])
      expect(state.status.message()?.text).toBe(ko("own.protected.removed", { path: "D:\\keys" }))
    }))

  test("a refused path names its reason; an empty box sends nothing", () =>
    inRoot(async () => {
      const fake = service()
      const state = protectedState(fake.runtime, ko)
      await state.load()
      await state.add("wallet")
      expect(state.status.message()).toEqual({ text: ko("own.protected.problem.relative"), tone: "danger" })
      const before = fake.calls.length
      await state.add("   ")
      expect(fake.calls.length).toBe(before)
    }))

  test("a phone or another PC reads the list but neither edits it nor asks for suggestions", () =>
    inRoot(async () => {
      const fake = service({ local: false })
      const state = protectedState(fake.runtime, ko)
      expect(state.editable()).toBe(false)
      await state.load()
      expect(fake.calls).toEqual(["protectedPaths.get"])
      expect(state.view()?.builtIn).toHaveLength(3)
      expect(state.suggestions()).toEqual([])
    }))

  test("an older service says it does not know the setting; another window's change is followed", () =>
    inRoot(async () => {
      const old = protectedState(service({ old: true }).runtime, ko)
      await old.load()
      expect(old.failure()).toBe("unsupported")
      expect(old.view()).toBeUndefined()

      const fake = service()
      const state = protectedState(fake.runtime, ko)
      await state.load()
      const stop = state.follow()
      fake.state.user.push({ path: "~/seed", resolved: `${HOME}\\seed` })
      fake.emit("protectedPaths.changed", { paths: fake.view() })
      expect(state.view()?.user.map((entry) => entry.path)).toEqual(["~/seed"])
      stop()
    }))

  test("the built-in list is grouped in the page's order; refusals map to their words", () => {
    const view = service().view()
    expect(grouped(view).map((group) => group.group)).toEqual(["own", "keys", "wallet"])
    expect(GROUPS.every((group) => protectedKo[`own.protected.group.${group}`].length > 0)).toBe(true)
    for (const reason of ["relative", "root", "home", "wildcard", "too_many"])
      expect(addError(new OwnRpcError("protected_path_invalid", reason, { reason, path: "x" }), ko)).toBe(
        ko(`own.protected.problem.${reason}` as ProtectedKey, { max: 200 }),
      )
    expect(addError(new Error("offline"), ko)).toBe(ko("own.protected.addFailed"))
    expect(ko("own.protected.problem.too_many", { max: 200 })).toBe("더 넣을 수 없어요(최대 200개)")
  })

  test("both catalogs carry every key; no word for the harness in the Korean copy", () => {
    expect(Object.keys(protectedEn).sort()).toEqual(Object.keys(protectedKo).sort())
    expect(Object.values(protectedKo).join("\n")).not.toContain("하네스")
  })
})

describe("the section's wiring (source)", () => {
  const source = async (name: string) => Bun.file(path.join(import.meta.dir, name)).text()

  test("native pickers only for this PC's service; editing only with the scope; the settings page shows it", async () => {
    const section = await source("section.tsx")
    expect(section).toContain("runtime().key === LOCAL")
    expect(section).toContain("host.capabilities.nativeDirectoryPicker ? host.files?.pickDirectory")
    expect(section).toContain("host.capabilities.nativeFilePaths ? host.files?.pickFile")
    expect(section).toContain("<Show when={!state().editable()}>")
    expect(section).toContain('text("own.protected.shellNote")')
    const settings = await source(path.join("..", "settings.tsx"))
    expect(settings).toContain("<ProtectedPathsSection />")
  })
})
