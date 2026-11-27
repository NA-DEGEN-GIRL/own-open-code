// "폴더 열기…" single flight (03 §18.3): one flow per window however often the entry points fire (double clicks,
// Ctrl+O key repeat, the palette), with `busy()` from the press on and a reset on cancel and on errors. The native
// dialog opens at the service's 폴더 열기 시작 위치: the user's folder, else the parent of the last opened folder (the
// default conversation folder left out), else the home folder.
import { describe, expect, test } from "bun:test"
import type { ServerRuntime } from "@/data"
import type { OwnHost } from "@/host"
import type { Route } from "@/routing/routes"
import type { Router } from "@/routing/router"
import { newSessionTarget } from "@/sidebar/target"
import { defaultFolder } from "./default-folder"
import { createProjectOpener, openProject, projectOpenerBusy, registerProjectOpener } from "./opener"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const HOME = "C:\\Users\\me"
const CHATS = "C:\\Users\\me\\Documents\\Own OpenCode"

/** A window with (or without) the native folder dialog; every dialog and `GET /api/location` waits for the test. */
function setup(
  options: {
    native?: boolean
    /** The service's 폴더 열기 시작 위치 choice. */
    start?: string | null
    /** Folders of the newest conversations, newest first. */
    folders?: readonly string[]
  } = {},
) {
  const dialogs: ReturnType<typeof deferred<string | null>>[] = []
  const starts: (string | undefined)[] = []
  const locations: {
    directory: string
    answer: ReturnType<typeof deferred<{ directory: string; projectID: string }>>
  }[] = []
  const routes: Route[] = []
  const errors: number[] = []
  // SAFETY: the opener reads `capabilities.nativeDirectoryPicker` and `files.pickDirectory` only.
  const host = {
    capabilities: { nativeDirectoryPicker: options.native !== false },
    files:
      options.native === false
        ? undefined
        : {
            pickDirectory: (input?: { defaultPath?: string }) => {
              starts.push(input?.defaultPath)
              const dialog = deferred<string | null>()
              dialogs.push(dialog)
              return dialog.promise
            },
          },
  } as unknown as OwnHost
  const folders = options.folders ?? []
  // SAFETY: the opener uses `key`, `entry()` / `own.state.health` (control folder), `client().location.get`, the
  // session index (recent folders) and own.accounts' `folderPicker.get` / `conversationFolder.get`.
  const runtime = {
    key: "local",
    entry: () => ({ controlDir: "C:\\own\\control" }),
    own: { state: {}, on: () => () => undefined },
    sessions: {
      state: {
        order: folders.map((_, index) => `ses_${index}`),
        sessions: Object.fromEntries(
          folders.map((directory, index) => [
            `ses_${index}`,
            { directory, projectID: `prj_${index}`, updated: 1_000 - index },
          ]),
        ),
        projects: {},
      },
    },
    rpc: {
      allowed: () => true,
      call: async (method: string) =>
        method === "folderPicker.get"
          ? { start: options.start ?? null, home: HOME }
          : { path: CHATS, defaultPath: CHATS, custom: false, exists: true },
    },
    connection: { status: () => "connected" },
    client: () => ({
      location: {
        get: async (input: { location: { directory: string } }) => {
          const answer = deferred<{ directory: string; projectID: string }>()
          locations.push({ directory: input.location.directory, answer })
          const project = await answer.promise
          return { directory: project.directory, project: { id: project.projectID } }
        },
      },
    }),
  } as unknown as ServerRuntime
  // SAFETY: the opener calls `navigate` only.
  const router = { navigate: (route: Route) => routes.push(route) } as unknown as Router
  const opener = createProjectOpener({
    host,
    router,
    runtime: (serverKey) => (serverKey === undefined || serverKey === "local" ? runtime : undefined),
    onError: () => errors.push(1),
  })
  return { opener, dialogs, locations, routes, errors, starts, runtime }
}

describe("folder flow single flight (03 §18.3)", () => {
  test("rapid triggers open one native dialog, load the folder once and navigate once", async () => {
    const { opener, dialogs, locations, routes } = setup()
    opener.open()
    expect(opener.busy()).toBe("dialog")
    // Double click, Ctrl+O key repeat and the palette while the dialog is still coming up.
    opener.open()
    opener.open("local")
    opener.open()
    expect(dialogs).toHaveLength(1)

    dialogs[0]!.resolve("D:\\work\\app")
    await tick()
    expect(opener.busy()).toBe("opening")
    opener.open()
    opener.open()
    expect(dialogs).toHaveLength(1)
    expect(locations.map((item) => item.directory)).toEqual(["D:\\work\\app"])

    locations[0]!.answer.resolve({ directory: "D:\\work\\app", projectID: "prj_app" })
    await tick()
    expect(opener.busy()).toBeUndefined()
    expect(routes).toEqual([{ name: "project", serverKey: "local", projectID: "prj_app" }])
    expect(newSessionTarget()?.directory).toBe("D:\\work\\app")
    expect(opener.dialog()).toBeUndefined()

    // Done: the next trigger is a new flow.
    opener.open()
    expect(dialogs).toHaveLength(2)
  })

  test("cancelling the dialog resets the flow without side effects", async () => {
    const { opener, dialogs, locations, routes, errors } = setup()
    opener.open()
    dialogs[0]!.resolve(null)
    await tick()
    expect(opener.busy()).toBeUndefined()
    expect(locations).toHaveLength(0)
    expect(routes).toHaveLength(0)
    expect(errors).toHaveLength(0)
    opener.open()
    expect(dialogs).toHaveLength(2)
    expect(opener.busy()).toBe("dialog")
  })

  test("a dialog that fails resets the flow and reports once", async () => {
    const { opener, dialogs, routes, errors } = setup()
    opener.open()
    opener.open()
    dialogs[0]!.reject(new Error("ipc closed"))
    await tick()
    expect(opener.busy()).toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(routes).toHaveLength(0)
    opener.open()
    expect(dialogs).toHaveLength(2)
  })

  test("a folder the server cannot load resets the flow and opens the card for a second look", async () => {
    const { opener, dialogs, locations, routes } = setup()
    opener.open()
    dialogs[0]!.resolve("D:\\work\\broken")
    await tick()
    locations[0]!.answer.reject(new Error("500"))
    await tick()
    expect(opener.busy()).toBeUndefined()
    expect(routes).toHaveLength(0)
    expect(opener.dialog()).toMatchObject({ serverKey: "local", initial: "D:\\work\\broken" })
  })

  test("a drive root goes to the card without loading a Location", async () => {
    const { opener, dialogs, locations } = setup()
    opener.open()
    dialogs[0]!.resolve("D:\\")
    await tick()
    expect(opener.busy()).toBeUndefined()
    expect(locations).toHaveLength(0)
    expect(opener.dialog()).toMatchObject({ initial: "D:\\" })
  })

  test("while the own picker is open, triggers keep it and ask for focus; it starts one session", () => {
    const { opener, routes } = setup({ native: false })
    const picked: string[] = []
    opener.open(undefined, { purpose: "move", onPick: (project) => picked.push(project.projectID) })
    const request = opener.dialog()
    expect(request?.serverKey).toBe("local")
    expect(opener.busy()).toBeUndefined()
    opener.open()
    opener.open()
    expect(opener.dialog()).toBe(request!)
    expect(opener.attention()).toBe(2)

    // A second press of the start button (double click) must neither move twice nor fall back to navigating.
    opener.start({ directory: "D:\\work\\next", projectID: "prj_next" })
    opener.start({ directory: "D:\\work\\next", projectID: "prj_next" })
    expect(picked).toEqual(["prj_next"])
    expect(routes).toHaveLength(0)
    expect(opener.dialog()).toBeUndefined()
  })

  test("the native dialog opens at the start folder, else the last opened folder's parent, else the home folder", async () => {
    // Folders this browser opened count as opened folders too; earlier tests opened some.
    localStorage.clear()
    const chosen = setup({ start: "E:\\code", folders: ["D:\\work\\app"] })
    await defaultFolder(chosen.runtime).load()
    chosen.opener.open()
    // The newest conversation is in the default conversation folder: it does not count as an opened folder.
    const recent = setup({ folders: [`${CHATS}`, "D:\\work\\app", "D:\\other\\x"] })
    await defaultFolder(recent.runtime).load()
    recent.opener.open()
    const fresh = setup()
    await defaultFolder(fresh.runtime).load()
    fresh.opener.open()
    expect([...chosen.starts, ...recent.starts, ...fresh.starts]).toEqual(["E:\\code", "D:\\work", HOME])
  })

  test("openProject and projectOpenerBusy follow the registered opener", async () => {
    const { opener, dialogs } = setup()
    expect(openProject()).toBe(false)
    const unregister = registerProjectOpener(opener)
    expect(projectOpenerBusy()).toBeUndefined()
    expect(openProject()).toBe(true)
    expect(openProject()).toBe(true)
    expect(projectOpenerBusy()).toBe("dialog")
    expect(dialogs).toHaveLength(1)
    dialogs[0]!.resolve(null)
    await tick()
    expect(projectOpenerBusy()).toBeUndefined()
    unregister()
    expect(openProject()).toBe(false)
  })
})
