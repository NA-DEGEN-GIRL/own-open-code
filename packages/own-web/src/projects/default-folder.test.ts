// 기본 대화 폴더 (03 §5.1) and 폴더 열기 시작 위치 (03 §18.3) in own-web, over a fake own.accounts service: the store
// reads both when the connection comes up and follows another device's change; the new-conversation screen without a
// project starts in the service's folder (an older service keeps the newest conversation's folder), reads nothing in a
// folder that does not exist yet and creates it on the first send; the folder picker starts at the user's folder, else
// the last opened folder's parent, else home; 설정 > 일반 changes both through the native dialog or a path box and
// says why the service refused a folder.
import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import type { I18nParams } from "@/i18n"
import type { Route } from "@/routing/routes"
import { newSessionDirectory, newSessionLookup } from "@/switcher/new-session"
import { defaultFolder, defaultFolderFailure, isDefaultFolder, pickerStart } from "./default-folder"
import { folderSettingsState } from "./folder-settings-state"
import { folderSettingsKo, folderSettingsText } from "./folder-settings-strings"
import { projectsKo, projectsText } from "./strings"

const BUILTIN = "C:\\Users\\me\\Documents\\Own OpenCode"
const HOME = "C:\\Users\\me"
const HOME_ROUTE: Route = { name: "home" }

type Listener = (event: { readonly data: Record<string, unknown> }) => void

/** A fake service: own.accounts' folder methods with their refusals, its events, and a session index. */
function service(
  input: {
    /** The service has no folder methods (an older build). */
    readonly old?: boolean
    /** Folders of the newest conversations, newest first. */
    readonly folders?: readonly string[]
    /** Methods this connection may call. */
    readonly allowed?: (method: string) => boolean
  } = {},
) {
  const state = { path: BUILTIN, custom: false, exists: false, start: null as string | null }
  const calls: string[] = []
  const listeners = new Map<string, Set<Listener>>()
  const [status, setStatus] = createSignal("connecting")
  const view = () => ({ path: state.path, defaultPath: BUILTIN, custom: state.custom, exists: state.exists })
  const refuse = (type: string, reason: string, path: string) => {
    throw new OwnRpcError(type, reason, { reason, path })
  }
  const methods: Record<string, (payload: Record<string, unknown>) => unknown> = {
    "conversationFolder.get": () => view(),
    "conversationFolder.ensure": () => {
      if (state.path.includes("blocked")) refuse("conversation_folder_unavailable", "create_failed", state.path)
      state.exists = true
      return view()
    },
    "conversationFolder.set": (payload) => {
      const path = payload.path as string | null
      if (path === null) Object.assign(state, { path: BUILTIN, custom: false, exists: false })
      else if (!/^[A-Z]:\\/.test(path)) refuse("conversation_folder_unavailable", "relative", path)
      else if (path.startsWith("C:\\Users\\me\\AppData")) refuse("conversation_folder_unavailable", "app", path)
      else Object.assign(state, { path, custom: true, exists: true })
      return view()
    },
    "folderPicker.get": () => ({ start: state.start, home: HOME }),
    "folderPicker.set": (payload) => {
      const start = payload.start as string | null
      if (start?.includes("missing")) refuse("folder_picker_unavailable", "missing", start)
      state.start = start
      return { start: state.start, home: HOME }
    },
  }
  const folders = input.folders ?? []
  // SAFETY: the folder store and the new-session rules read only these members.
  const runtime = {
    key: "local",
    rpc: {
      allowed: (method: string) => input.allowed?.(method) ?? true,
      call: async (method: string, payload: Record<string, unknown>) => {
        calls.push(method)
        if (input.old) throw new OwnRpcError("rpc.method_not_found", `Unknown RPC method: own.accounts.${method}`)
        return methods[method]!(payload)
      },
    },
    connection: { status },
    own: {
      on: (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>()
        listeners.set(name, set)
        set.add(listener)
        return () => set.delete(listener)
      },
    },
    sessions: {
      state: {
        order: folders.map((_, index) => `ses_${index}`),
        sessions: Object.fromEntries(
          folders.map((directory, index) => [`ses_${index}`, { directory, projectID: `prj_${index}` }]),
        ),
        projects: { prj_app: { id: "prj_app", directory: "D:\\work\\app" } },
      },
    },
  } as unknown as ServerRuntime
  return {
    runtime,
    state,
    calls,
    /** The connection comes up; the store's reads have answered when this resolves. */
    async connect() {
      setStatus("connected")
      await defaultFolder(runtime).load()
    },
    emit(name: string, data: Record<string, unknown>) {
      for (const listener of listeners.get(name) ?? []) listener({ data })
    },
  }
}

describe("the default conversation folder store", () => {
  test("reads the folder and the picker start when the connection comes up, and follows other devices", async () => {
    const fake = service()
    const store = defaultFolder(fake.runtime)
    expect(store.view()).toBeUndefined()
    expect(store.pending()).toBe(true)
    expect(fake.calls).toEqual([])
    await fake.connect()
    expect(store.pending()).toBe(false)
    expect(store.view()).toEqual({ path: BUILTIN, defaultPath: BUILTIN, custom: false, exists: false })
    expect(store.picker()).toEqual({ start: null, home: HOME })
    expect(fake.calls.sort()).toEqual(["conversationFolder.get", "folderPicker.get"])
    // Another window or device changed them.
    const moved = { path: "D:\\chats", defaultPath: BUILTIN, custom: true, exists: true }
    fake.emit("conversationFolder.changed", { folder: moved })
    fake.emit("folderPicker.changed", { picker: { start: "D:\\projects", home: HOME } })
    expect(store.view()).toEqual(moved)
    expect(store.picker()?.start).toBe("D:\\projects")
    expect(isDefaultFolder(fake.runtime, "d:\\CHATS\\")).toBe(true)
    expect(isDefaultFolder(fake.runtime, BUILTIN)).toBe(false)
  })

  test("an older service without the methods is unsupported", async () => {
    const fake = service({ old: true })
    await fake.connect()
    expect(defaultFolder(fake.runtime).unsupported()).toBe(true)
    expect(defaultFolder(fake.runtime).pending()).toBe(false)
    expect(defaultFolder(fake.runtime).view()).toBeUndefined()
  })
})

describe("the new-conversation screen without a project (5.1)", () => {
  test("starts in the default folder, looks nothing up there until it exists, and the first send creates it", async () => {
    const fake = service({ folders: ["D:\\work\\app"] })
    await fake.connect()
    expect(newSessionDirectory(fake.runtime, HOME_ROUTE)).toBe(BUILTIN)
    expect(newSessionDirectory(fake.runtime, { name: "home", serverKey: "local" })).toBe(BUILTIN)
    // Not created yet: models, `@` files and skills come from the server's own (control) Location.
    expect(newSessionLookup(fake.runtime, HOME_ROUTE)).toBeUndefined()
    // A project route keeps its folder.
    expect(newSessionDirectory(fake.runtime, { name: "project", serverKey: "local", projectID: "prj_app" })).toBe(
      "D:\\work\\app",
    )
    expect(isDefaultFolder(fake.runtime, BUILTIN)).toBe(true)
    expect(await defaultFolder(fake.runtime).ensure()).toMatchObject({ path: BUILTIN, exists: true })
    expect(newSessionLookup(fake.runtime, HOME_ROUTE)).toBe(BUILTIN)
  })

  test("follows a changed default: the next folderless conversation starts in the new folder", async () => {
    const fake = service()
    await fake.connect()
    await defaultFolder(fake.runtime).set("D:\\chats")
    expect(newSessionDirectory(fake.runtime, HOME_ROUTE)).toBe("D:\\chats")
    expect(newSessionLookup(fake.runtime, HOME_ROUTE)).toBe("D:\\chats")
    await defaultFolder(fake.runtime).set(null)
    expect(newSessionDirectory(fake.runtime, HOME_ROUTE)).toBe(BUILTIN)
  })

  test("every server has its own: the screen's folder is that of the server the conversation starts on", async () => {
    const pc = service()
    const host = service()
    await pc.connect()
    await host.connect()
    const hostFolder = (path: string) => ({ folder: { path, defaultPath: path, custom: false, exists: true } })
    host.emit("conversationFolder.changed", hostFolder("/home/dev/own-chats"))
    const HOST: Route = { name: "home", serverKey: "h-devbox" }
    expect(newSessionDirectory(pc.runtime, HOME_ROUTE)).toBe(BUILTIN)
    expect(newSessionDirectory(host.runtime, HOST)).toBe("/home/dev/own-chats")
    expect(isDefaultFolder(host.runtime, "/home/dev/own-chats")).toBe(true)
    expect(isDefaultFolder(pc.runtime, "/home/dev/own-chats")).toBe(false)
    host.emit("conversationFolder.changed", hostFolder("/srv/chats"))
    expect(newSessionDirectory(host.runtime, HOST)).toBe("/srv/chats")
    expect(newSessionDirectory(pc.runtime, HOME_ROUTE)).toBe(BUILTIN)
  })

  test("an older service keeps the old rule: the newest conversation's folder", async () => {
    const fake = service({ old: true, folders: ["D:\\work\\app", "D:\\work\\other"] })
    await fake.connect()
    expect(newSessionDirectory(fake.runtime, HOME_ROUTE)).toBe("D:\\work\\app")
    expect(newSessionLookup(fake.runtime, HOME_ROUTE)).toBe("D:\\work\\app")
  })

  test("a folder the service could not create says why and where to change it", async () => {
    const fake = service()
    await fake.connect()
    await defaultFolder(fake.runtime).set("D:\\blocked")
    fake.state.exists = false
    const error = await defaultFolder(fake.runtime)
      .ensure()
      .then(
        () => undefined,
        (failure: unknown) => failure,
      )
    expect(defaultFolderFailure("ko", error)).toBe(
      projectsText("ko", "own.project.defaultFolder.create_failed", { path: "D:\\blocked" }),
    )
    expect(defaultFolderFailure("ko", new Error("offline"))).toBe(projectsKo["own.project.defaultFolder.failed"])
  })
})

describe("where the folder picker starts (18.3)", () => {
  test("the user's folder, else the last opened folder's parent (not the default folder), else home", async () => {
    const fake = service({ folders: [BUILTIN, "D:\\work\\app"] })
    await fake.connect()
    const recent = [{ directory: BUILTIN }, { directory: "D:\\work\\app" }]
    expect(pickerStart(fake.runtime, recent)).toBe("D:\\work")
    expect(pickerStart(fake.runtime, [{ directory: BUILTIN }])).toBe(HOME)
    expect(pickerStart(fake.runtime, [])).toBe(HOME)
    await defaultFolder(fake.runtime).setStart("E:\\code")
    expect(pickerStart(fake.runtime, recent)).toBe("E:\\code")
  })
})

describe("설정 > 일반: 기본 대화 폴더 and 폴더 열기 시작 위치", () => {
  const text = (key: keyof typeof folderSettingsKo, params?: I18nParams) => folderSettingsText("ko", key, params)

  test("without a native dialog `바꾸기…` opens a path box with the folder; saving and resetting say so", async () => {
    const fake = service()
    await fake.connect()
    await createRoot(async (dispose) => {
      const state = folderSettingsState({ runtime: fake.runtime, recent: () => [], text })
      await state.change("folder")
      expect(state.editing()).toEqual({ row: "folder", value: BUILTIN })
      state.setEditing({ row: "folder", value: ' "D:\\chats\\" ' })
      expect(await state.submit()).toBe(true)
      expect(fake.state).toMatchObject({ path: "D:\\chats", custom: true })
      expect(state.editing()).toBeUndefined()
      expect(state.status.folder.message()).toEqual({
        text: folderSettingsKo["own.project.folderSetting.saved"],
        tone: "ok",
      })
      expect(await state.reset("folder")).toBe(true)
      expect(fake.state).toMatchObject({ path: BUILTIN, custom: false })
      expect(state.status.folder.message()?.text).toBe(folderSettingsKo["own.project.folderSetting.resetDone"])
      dispose()
    })
  })

  test("a refused folder keeps the box open and says why", async () => {
    const fake = service()
    await fake.connect()
    await createRoot(async (dispose) => {
      const state = folderSettingsState({ runtime: fake.runtime, recent: () => [], text })
      state.setEditing({ row: "folder", value: "chats" })
      expect(await state.submit()).toBe(false)
      expect(state.status.folder.message()).toEqual({
        text: folderSettingsKo["own.project.folderSetting.problem.relative"],
        tone: "danger",
      })
      state.setEditing({ row: "folder", value: "C:\\Users\\me\\AppData\\Local\\own-open-code\\chats" })
      await state.submit()
      expect(state.status.folder.message()?.text).toBe(folderSettingsKo["own.project.folderSetting.problem.app"])
      expect(state.editing()?.row).toBe("folder")
      expect(fake.state.custom).toBe(false)
      state.setEditing({ row: "start", value: "D:\\missing" })
      await state.submit()
      expect(state.status.start.message()?.text).toBe(folderSettingsKo["own.project.startSetting.problem.missing"])
      dispose()
    })
  })

  test("the native dialog opens where the folder is (or would be) and at the picker's start; cancel changes nothing", async () => {
    const fake = service()
    await fake.connect()
    const asked: (string | undefined)[] = []
    const answers: (string | null)[] = [null, "E:\\code", "D:\\chats"]
    await createRoot(async (dispose) => {
      const state = folderSettingsState({
        runtime: fake.runtime,
        recent: () => [{ directory: "D:\\work\\app" }],
        text,
        pick: async (options) => {
          asked.push(options.defaultPath)
          return answers.shift() ?? null
        },
      })
      await state.change("folder")
      expect(fake.state.custom).toBe(false)
      await state.change("start")
      expect(fake.state.start).toBe("E:\\code")
      await state.change("folder")
      expect(fake.state.path).toBe("D:\\chats")
      // The default folder does not exist yet: its parent (twice); the start: the last opened folder's parent.
      expect(asked).toEqual(["C:\\Users\\me\\Documents", "D:\\work", "C:\\Users\\me\\Documents"])
      expect(state.editing()).toBeUndefined()
      dispose()
    })
  })

  test("a connection without `admin` reads them only", async () => {
    const fake = service({ allowed: (method) => !method.endsWith(".set") })
    await fake.connect()
    createRoot((dispose) => {
      expect(folderSettingsState({ runtime: fake.runtime, recent: () => [], text }).editable()).toBe(false)
      dispose()
    })
  })
})
