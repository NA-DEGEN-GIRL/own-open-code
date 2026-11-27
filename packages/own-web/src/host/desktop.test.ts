// Desktop host (05 §6.3 T0, §6.4, 03 §16.7 adapters) against a fake upstream IPC client: no Electron needed.
// Capability detection (05 §6.2) and what each capability falls back to when the window lacks it.
import { afterEach, describe, expect, test } from "bun:test"
import type { OwnShellApi } from "../../../own-desktop/src/preload/own-api"
// @ts-ignore plain ESM script from own-desktop (the contract hash, 05 §5.5)
import { rpcHash } from "../../../own-desktop/scripts/rpc-hash.mjs"
import {
  checkShell,
  createDesktopHost,
  describe as describeError,
  desktopCapabilities,
  desktopHost,
  EXPLORER_AVAILABLE_MS,
  EXPLORER_IPC,
  NOTIFY_MERGE_MS,
  PANE_IPC,
  pageEnvironment,
  RPC_HASH,
  ShellMismatchError,
  TOAST_TAG_MAX,
  toastTag,
  type DesktopEnvironment,
  type ElectronBridge,
} from "./desktop"
import { createHost } from "./index"
import { createWebHost } from "./web"

type Call = { tag: string; payload?: unknown; kind: "invoke" | "send" }

function fakeIpc(answers: Record<string, (payload: unknown) => unknown> = {}) {
  const calls: Call[] = []
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const ipc = {
    invoke: async (tag: string, payload?: unknown) => {
      calls.push({ tag, payload, kind: "invoke" })
      const answer = answers[tag]
      return answer ? answer(payload) : undefined
    },
    send: (tag: string, payload?: unknown) => {
      calls.push({ tag, payload, kind: "send" })
    },
    listen: (tag: string, listener: (value: unknown) => void) => {
      const set = listeners.get(tag) ?? new Set()
      set.add(listener)
      listeners.set(tag, set)
      return () => set.delete(listener)
    },
    onBeforeDispose: () => () => undefined,
  }
  const emit = (tag: string, value: unknown) => listeners.get(tag)?.forEach((listener) => listener(value))
  const tags = () => calls.map((call) => call.tag)
  return { ipc: ipc as never, calls, emit, tags }
}

function fakeOwn(overrides: Partial<OwnShellApi["shell"]> = {}): OwnShellApi {
  return {
    shell: {
      rpcHash: RPC_HASH,
      version: "2.0.18-own.9",
      startedAt: Promise.resolve(Date.now() - 1000),
      controlDir: Promise.resolve("C:\\own\\control"),
      renderer: Promise.resolve({ source: "installed", root: "W" }),
      ...overrides,
    },
    service: {
      status: async () => ({ running: true, managed: true, version: "2.0.18-own.9" }),
      restart: async () => ({ ok: true }),
    },
  }
}

/** HTML5 Notification stand-in (happy-dom has none). */
class FakeToast {
  static permission: NotificationPermission = "granted"
  static made: FakeToast[] = []
  onclick: (() => void) | null = null
  closed = false
  constructor(
    readonly title: string,
    readonly options: NotificationOptions = {},
  ) {
    FakeToast.made.push(this)
  }
  close() {
    this.closed = true
  }
}

let clock = 1_000_000
function env(overrides: Partial<DesktopEnvironment> = {}): DesktopEnvironment {
  return {
    windowControlsOverlay: true,
    Notification: FakeToast as never,
    coarsePointer: false,
    now: () => clock,
    ...overrides,
  }
}

const electron: ElectronBridge = { windowID: "1", getPathForFile: () => "C:\\work\\a.png" }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const scope = window as unknown as { own?: OwnShellApi; electron?: unknown }
afterEach(() => {
  delete scope.own
  delete scope.electron
  FakeToast.permission = "granted"
  FakeToast.made = []
})

describe("T0-0 rpcHash (05 §5.5)", () => {
  test("this build carries the hash of the current contract files", () => {
    expect(RPC_HASH).toMatch(/^[0-9a-f]{16}$/)
    expect(rpcHash()).toBe(RPC_HASH)
  })

  test("missing window.own or another hash refuses the shell", () => {
    expect(() => checkShell(undefined)).toThrow(ShellMismatchError)
    expect(() => checkShell({ shell: { ...fakeOwn().shell, rpcHash: "0123456789abcdef" } })).toThrow(
      /0123456789abcdef.*데스크톱 앱을 다시 설치/,
    )
    const own = fakeOwn()
    expect(checkShell(own)).toBe(own)
  })

  test("a mismatch never loads upstream IPC", async () => {
    scope.own = fakeOwn({ rpcHash: "ffffffffffffffff" })
    let loaded = false
    await expect(
      createDesktopHost({
        loadIpc: async () => {
          loaded = true
          return fakeIpc().ipc
        },
      }),
    ).rejects.toBeInstanceOf(ShellMismatchError)
    expect(loaded).toBe(false)
  })

  test("after loading the client it asks the preload for main's port", async () => {
    scope.own = fakeOwn()
    const posted: unknown[] = []
    const original = window.postMessage.bind(window)
    window.postMessage = ((message: unknown) => void posted.push(message)) as typeof window.postMessage
    try {
      const host = await createDesktopHost({ loadIpc: async () => fakeIpc().ipc, environment: env() })
      expect(host.kind).toBe("desktop")
      expect(posted).toEqual(["own:ipc.port-request"])
    } finally {
      window.postMessage = original
    }
  })
})

describe("host selection (05 §6.6)", () => {
  test("no window.electron: the web host, with every desktop capability off", async () => {
    const host = await createHost()
    expect(host.kind).toBe("web")
    expect(host.capabilities).toMatchObject({
      windowControlsOverlay: false,
      nativeDirectoryPicker: false,
      nativeFilePaths: false,
      openInApp: false,
      clipboardImage: false,
      saveDialog: false,
      browserPane: false,
      serviceControl: false,
      multiWindow: false,
      keepScreenAwake: false,
    })
    // The UI's fallbacks key off these being absent: server fs.list picker, uploads, vscode:// links, downloads,
    // `own restart` to copy (03 §16.7).
    expect(host.files).toBeUndefined()
    expect(host.service).toBeUndefined()
    expect(host.browser).toBeUndefined()
    expect(host.window?.zoom).toBeUndefined()
  })

  test("window.electron: the desktop chunk, which refuses another shell before any IPC", async () => {
    scope.electron = { windowID: "1" }
    scope.own = fakeOwn({ rpcHash: "ffffffffffffffff" })
    await expect(createHost()).rejects.toBeInstanceOf(ShellMismatchError)
  })

  test("web notifications are the browser's (web), none without the API", () => {
    const had = "Notification" in globalThis
    ;(globalThis as { Notification?: unknown }).Notification = FakeToast
    try {
      expect(createWebHost().capabilities.osNotifications).toBe("web")
    } finally {
      if (!had) delete (globalThis as { Notification?: unknown }).Notification
    }
    expect(createWebHost().capabilities.osNotifications).toBe(had ? "web" : "none")
  })
})

/** `window.own.remotePcs` of a shell with 원격 PC (08 §4.1); never called here. */
const remotePcs: NonNullable<OwnShellApi["remotePcs"]> = {
  list: async () => [],
  pair: async () => ({ ok: false, error: "invalid_link" }),
  waitPairing: async () => ({ ok: false, error: "aborted" }),
  cancelPairing: async () => undefined,
  open: async () => false,
  remove: async () => false,
  onChange: () => () => undefined,
}

/** `window.own.mobilePreview` of a shell with 모바일 미리보기 (08 §4.3); never called here. */
const mobilePreview: NonNullable<OwnShellApi["mobilePreview"]> = {
  status: async () => ({ state: "none" }),
  pair: async () => ({ ok: false, error: "invalid_link" }),
  waitPairing: async () => ({ ok: false, error: "aborted" }),
  cancelPairing: async () => undefined,
  open: async () => false,
  remove: async () => false,
  onChange: () => () => undefined,
}

/** `window.own.app` of a shell with the tray (05 §7.3); records its calls. */
function fakeApp() {
  const calls: unknown[] = []
  const app: NonNullable<OwnShellApi["app"]> = {
    quit: async (mode) => {
      calls.push(["quit", mode])
      return mode === "app"
    },
    closeAction: async () => "tray",
    setCloseAction: async (action) => {
      calls.push(["setCloseAction", action])
      return action
    },
  }
  return { app, calls }
}

describe("capability detection (05 §6.2, 03 §16.7)", () => {
  test("a desktop window with everything", () => {
    expect(
      desktopCapabilities({ ...fakeOwn(), remotePcs, mobilePreview, app: fakeApp().app }, electron, env()),
    ).toEqual({
      windowControlsOverlay: true,
      nativeDirectoryPicker: true,
      nativeFilePaths: true,
      openInApp: true,
      clipboardImage: true,
      saveDialog: true,
      osNotifications: "native",
      browserPane: true,
      serviceControl: true,
      multiWindow: false,
      keepScreenAwake: false,
      touch: false,
      offlineCatalog: false,
      remotePcs: true,
      mobilePreview: true,
      appQuit: true,
    })
  })

  test("앱 종료 / 완전 종료 follow the shell (05 §7.3): its calls as they are, nothing without them", async () => {
    const { ipc } = fakeIpc()
    expect(desktopCapabilities(fakeOwn(), electron, env()).appQuit).toBe(false)
    expect(desktopHost(fakeOwn(), ipc, electron, env()).app).toBeUndefined()
    const { app, calls } = fakeApp()
    const host = desktopHost({ ...fakeOwn(), app }, ipc, electron, env())
    expect(host.capabilities.appQuit).toBe(true)
    expect(host.app).toBe(app)
    expect(await host.app!.quit("all")).toBe(false)
    expect(await host.app!.setCloseAction("quit")).toBe("quit")
    expect(calls).toEqual([
      ["quit", "all"],
      ["setCloseAction", "quit"],
    ])
    expect(createWebHost().capabilities.appQuit).toBeFalsy()
    expect(createWebHost().app).toBeUndefined()
  })

  test("모바일 미리보기 follows the shell (08 §4.3): its calls as they are, nothing without them", () => {
    const { ipc } = fakeIpc()
    expect(desktopCapabilities(fakeOwn(), electron, env()).mobilePreview).toBe(false)
    expect(desktopHost(fakeOwn(), ipc, electron, env()).mobilePreview).toBeUndefined()
    expect(desktopHost({ ...fakeOwn(), mobilePreview }, ipc, electron, env()).mobilePreview).toBe(mobilePreview)
    expect(createWebHost().capabilities.mobilePreview).toBeFalsy()
    expect(createWebHost().mobilePreview).toBeUndefined()
  })

  test("원격 PC follows the shell (08 §4.1): its calls as they are, nothing without them", () => {
    const { ipc } = fakeIpc()
    expect(desktopCapabilities(fakeOwn(), electron, env()).remotePcs).toBe(false)
    expect(desktopHost(fakeOwn(), ipc, electron, env()).remotePcs).toBeUndefined()
    expect(desktopHost({ ...fakeOwn(), remotePcs }, ipc, electron, env()).remotePcs).toBe(remotePcs)
    expect(createWebHost().capabilities.remotePcs).toBeFalsy()
    expect(createWebHost().remotePcs).toBeUndefined()
  })

  test("each capability follows what the window has", () => {
    const base = fakeOwn()
    expect(desktopCapabilities(base, undefined, env()).nativeFilePaths).toBe(false)
    expect(desktopCapabilities(base, { windowID: "1" }, env()).nativeFilePaths).toBe(false)
    expect(desktopCapabilities(base, electron, env({ Notification: undefined })).osNotifications).toBe("none")
    // The permission is main's policy, checked when sending (reading it at startup is a sync call into busy main).
    FakeToast.permission = "denied"
    expect(desktopCapabilities(base, electron, env()).osNotifications).toBe("native")
    FakeToast.permission = "default"
    expect(desktopCapabilities(base, electron, env()).osNotifications).toBe("native")
    expect(desktopCapabilities(base, electron, env({ windowControlsOverlay: false })).windowControlsOverlay).toBe(false)
    expect(desktopCapabilities(base, electron, env({ coarsePointer: true })).touch).toBe(true)
    const noService = { shell: base.shell } as unknown as OwnShellApi
    expect(desktopCapabilities(noService, electron, env()).serviceControl).toBe(false)
  })

  test("a missing capability leaves its member out: no service, no notify", () => {
    const noService = { shell: fakeOwn().shell } as unknown as OwnShellApi
    const host = desktopHost(noService, fakeIpc().ipc, electron, env({ Notification: undefined }))
    expect(host.service).toBeUndefined()
    expect(host.notify).toBeUndefined()
    const full = desktopHost(fakeOwn(), fakeIpc().ipc, electron, env())
    expect(full.service).toBeDefined()
    expect(full.notify).toBeDefined()
  })

  test("page detection: the overlay API counts only when visible or on Windows (fullscreen hides it)", () => {
    // Own properties shadow happy-dom's prototype getters; deleting them restores the originals.
    const nav = navigator as unknown as Record<string, unknown>
    const agent = navigator.userAgent
    try {
      expect(pageEnvironment().windowControlsOverlay).toBe(false)
      Object.defineProperty(nav, "windowControlsOverlay", { value: { visible: true }, configurable: true })
      expect(pageEnvironment().windowControlsOverlay).toBe(true)
      Object.defineProperty(nav, "windowControlsOverlay", { value: { visible: false }, configurable: true })
      Object.defineProperty(nav, "userAgent", {
        value: "Mozilla/5.0 (X11; Linux x86_64) Electron/44",
        configurable: true,
      })
      expect(pageEnvironment().windowControlsOverlay).toBe(false)
      Object.defineProperty(nav, "userAgent", {
        value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/44",
        configurable: true,
      })
      expect(pageEnvironment().windowControlsOverlay).toBe(true)
    } finally {
      delete nav.windowControlsOverlay
      delete nav.userAgent
    }
    expect(navigator.userAgent).toBe(agent)
    expect("windowControlsOverlay" in navigator).toBe(false)
    expect(pageEnvironment().Notification).toBe(typeof Notification === "function" ? Notification : undefined)
  })
})

describe("T0 calls", () => {
  test("connect: AppAwaitInitialization url, injected auth, controlDir from window.own; reconnect likewise", async () => {
    const { ipc, tags } = fakeIpc({
      AppAwaitInitialization: () => ({ url: "http://127.0.0.1:28538" }),
      AppReconnectService: () => ({ url: "http://127.0.0.1:28539" }),
    })
    const host = desktopHost(fakeOwn(), ipc, undefined, env())
    expect(await host.connect()).toEqual({
      baseUrl: "http://127.0.0.1:28538",
      auth: "injected",
      controlDir: "C:\\own\\control",
    })
    expect((await host.reconnect()).baseUrl).toBe("http://127.0.0.1:28539")
    expect(tags()).toEqual(["AppAwaitInitialization", "AppReconnectService"])
  })

  test("connect failure carries the shell's own message (IPC defect cause)", async () => {
    const failure = new Error("Desktop IPC handler failed", {
      cause: { message: "런처가 오류로 끝났어요(종료 코드 1)" },
    })
    const { ipc } = fakeIpc({
      AppAwaitInitialization: () => {
        throw failure
      },
    })
    await expect(desktopHost(fakeOwn(), ipc, undefined, env()).connect()).rejects.toThrow(
      "런처가 오류로 끝났어요(종료 코드 1)",
    )
    expect(describeError(new Error("plain"))).toBe("plain")
  })

  test("ready once; setChrome sends titlebar theme and background; openExternal only http(s)/mailto", async () => {
    const { ipc, calls } = fakeIpc()
    const host = desktopHost(fakeOwn(), ipc, undefined, env())
    host.ready()
    host.ready()
    host.setChrome({ mode: "dark", scheme: "system", background: "#1d1f22" })
    host.setChrome({ mode: "light", background: "#f6f6f7" })
    host.openExternal("https://opencode.ai")
    host.openExternal("file:///C:/Windows")
    host.openExternal("javascript:alert(1)")
    await Promise.resolve()
    expect(calls).toEqual([
      { tag: "WindowThemeReady", payload: undefined, kind: "invoke" },
      { tag: "WindowSetTitlebar", payload: { theme: { mode: "dark", scheme: "system" } }, kind: "invoke" },
      { tag: "AppSetBackgroundColor", payload: { color: "#1d1f22" }, kind: "invoke" },
      { tag: "WindowSetTitlebar", payload: { theme: { mode: "light" } }, kind: "invoke" },
      { tag: "AppSetBackgroundColor", payload: { color: "#f6f6f7" }, kind: "invoke" },
      { tag: "FilesOpenExternal", payload: { url: "https://opencode.ai" }, kind: "send" },
    ])
  })

  test("service control goes to window.own", async () => {
    const own = fakeOwn()
    let restarted: unknown
    own.service.restart = async (input) => {
      restarted = input
      return { ok: false, refused: "session_running" }
    }
    const host = desktopHost(own, fakeIpc().ipc, undefined, env())
    expect(await host.service!.restart({ force: false, claudeConfigDir: "C:\\claude" })).toEqual({
      ok: false,
      refused: "session_running",
    })
    expect(restarted).toEqual({ force: false, claudeConfigDir: "C:\\claude" })
    expect((await host.service!.status()).managed).toBe(true)
  })
})

describe("files (05 §7.5)", () => {
  test("pickDirectory: first path, null when cancelled", async () => {
    let answer: unknown = ["C:\\work\\a", "C:\\work\\b"]
    const { ipc, calls } = fakeIpc({ FilesOpenDirectoryPicker: () => answer })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    expect(await files.pickDirectory!()).toBe("C:\\work\\a")
    answer = "C:\\work\\c"
    expect(await files.pickDirectory!()).toBe("C:\\work\\c")
    answer = null
    expect(await files.pickDirectory!()).toBeNull()
    expect(calls[0]!.payload).toEqual({ options: { multiple: false } })
    // 03 §18.3 폴더 열기 시작 위치: the dialog opens where the caller says.
    await files.pickDirectory!({ defaultPath: "D:\\projects" })
    expect(calls.at(-1)!.payload).toEqual({ options: { multiple: false, defaultPath: "D:\\projects" } })
  })

  test("pickFile: the picked file's path with its token released, null when cancelled (PP)", async () => {
    let answer: unknown = { token: "tok_1", files: [{ path: "C:\\keys\\a.kdbx", name: "a.kdbx", size: 3 }] }
    const { ipc, calls } = fakeIpc({ FilesOpenFilePicker: () => answer, FilesReleasePickedFiles: () => undefined })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    expect(await files.pickFile!()).toBe("C:\\keys\\a.kdbx")
    expect(calls.map((call) => [call.tag, call.payload])).toEqual([
      ["FilesOpenFilePicker", { options: { multiple: false } }],
      ["FilesReleasePickedFiles", { token: "tok_1" }],
    ])
    answer = null
    expect(await files.pickFile!({ defaultPath: "C:\\Users\\me" })).toBeNull()
    expect(calls.at(-1)).toMatchObject({
      tag: "FilesOpenFilePicker",
      payload: { options: { multiple: false, defaultPath: "C:\\Users\\me" } },
    })
  })

  test("pathForFile: the dropped file's real path; null for in-memory files, errors and no preload", () => {
    const file = new File(["x"], "a.png")
    const withPath = desktopHost(fakeOwn(), fakeIpc().ipc, electron, env()).files!
    expect(withPath.pathForFile!(file)).toBe("C:\\work\\a.png")
    const memory = desktopHost(fakeOwn(), fakeIpc().ipc, { windowID: "1", getPathForFile: () => "" }, env()).files!
    expect(memory.pathForFile!(file)).toBeNull()
    const broken = {
      windowID: "1",
      getPathForFile: () => {
        throw new Error("not a File")
      },
    }
    expect(desktopHost(fakeOwn(), fakeIpc().ipc, broken, env()).files!.pathForFile!(file)).toBeNull()
    expect(desktopHost(fakeOwn(), fakeIpc().ipc, undefined, env()).files!.pathForFile!(file)).toBeNull()
  })

  test("openPath without an app: shell default; its error text rejects", async () => {
    let failure: string | null = null
    const { ipc, calls } = fakeIpc({ FilesOpenPath: () => failure })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    await files.openPath!("C:\\work\\a.ts")
    expect(calls).toEqual([{ tag: "FilesOpenPath", payload: { path: "C:\\work\\a.ts" }, kind: "invoke" }])
    failure = "Failed to open path"
    await expect(files.openPath!("C:\\nope")).rejects.toThrow("Failed to open path")
  })

  test("openPath with an editor: resolved once through AppResolveAppPath (code.cmd → Code.exe)", async () => {
    const resolved: Record<string, string | null> = { code: "C:\\VSCode\\Code.exe", zed: null }
    const { ipc, calls, tags } = fakeIpc({
      AppResolveAppPath: (payload) => resolved[(payload as { appName: string }).appName] ?? null,
      FilesOpenPath: () => null,
    })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    await files.openPath!("C:\\work\\a.ts", "code")
    await files.openPath!("C:\\work\\b.ts", "code")
    expect(tags()).toEqual(["AppResolveAppPath", "FilesOpenPath", "FilesOpenPath"])
    expect(calls[1]!.payload).toEqual({ path: "C:\\work\\a.ts", application: "C:\\VSCode\\Code.exe" })
    // Not installed: rejects without opening anything, and is asked again next time.
    await expect(files.openPath!("C:\\work\\a.ts", "zed")).rejects.toThrow("앱을 찾을 수 없어요: zed")
    resolved.zed = "C:\\Zed\\zed.exe"
    await files.openPath!("C:\\work\\a.ts", "zed")
    expect(tags().filter((tag) => tag === "AppResolveAppPath")).toHaveLength(3)
    // A full path is used as is.
    await files.openPath!("C:\\work\\a.ts", "D:\\Tools\\editor.exe")
    expect(calls.at(-1)!.payload).toEqual({ path: "C:\\work\\a.ts", application: "D:\\Tools\\editor.exe" })
  })

  test("openPath: a failed launch (IPC defect) rejects with its message", async () => {
    const { ipc } = fakeIpc({
      AppResolveAppPath: () => "C:\\VSCode\\Code.exe",
      FilesOpenPath: () => {
        throw new Error("Desktop IPC handler failed", { cause: { message: "spawn EACCES" } })
      },
    })
    await expect(desktopHost(fakeOwn(), ipc, undefined, env()).files!.openPath!("C:\\a", "code")).rejects.toThrow(
      "spawn EACCES",
    )
  })

  test("revealPath: missing file rejects", async () => {
    let exists = true
    const { ipc } = fakeIpc({ FilesRevealPath: () => exists })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    await files.revealPath!("C:\\work\\a.ts")
    exists = false
    await expect(files.revealPath!("C:\\work\\gone.ts")).rejects.toThrow("파일이 없어요")
  })

  test("explorer: every call is a PluginCall to the shell's `explorer` Ipc with nothing but the path or host", async () => {
    const answers: Record<string, unknown> = {
      reveal: { ok: true },
      launch: { ok: false, reason: "unconfigured" },
      program: { template: "--open {host} {path}" },
      pick: { program: "D:\\tools\\ssh-explorer.exe", template: "--open {host} {path}" },
      template: { template: "{path}" },
      clear: { template: "{path}" },
    }
    const { ipc, calls } = fakeIpc({
      PluginCall: (payload) => answers[(payload as { method: string }).method],
    })
    const explorer = desktopHost(fakeOwn(), ipc, undefined, env()).explorer!
    expect(await explorer.reveal("D:\\projects\\app")).toEqual({ ok: true })
    expect(await explorer.launch({ host: "devbox", path: "/home/dev/app" })).toEqual({
      ok: false,
      reason: "unconfigured",
    })
    expect(await explorer.program()).toEqual({ template: "--open {host} {path}" })
    expect((await explorer.pickProgram()).program).toBe("D:\\tools\\ssh-explorer.exe")
    expect(await explorer.setTemplate("{path}")).toEqual({ template: "{path}" })
    expect(await explorer.clearProgram()).toEqual({ template: "{path}" })
    expect(calls.map((call) => call.payload)).toEqual([
      { ipc: EXPLORER_IPC, method: "reveal", input: { path: "D:\\projects\\app" } },
      { ipc: EXPLORER_IPC, method: "launch", input: { host: "devbox", path: "/home/dev/app" } },
      { ipc: EXPLORER_IPC, method: "program" },
      // The page never names a program: main's own dialog picks it.
      { ipc: EXPLORER_IPC, method: "pick" },
      { ipc: EXPLORER_IPC, method: "template", input: { template: "{path}" } },
      { ipc: EXPLORER_IPC, method: "clear" },
    ])
    expect(calls.every((call) => call.tag === "PluginCall")).toBe(true)
  })

  test("explorer: a shell without the plugin: a path of this PC goes through FilesRevealPath, the rest says unavailable", async () => {
    const unavailable = () => {
      throw Object.assign(new Error("unavailable"), { code: "unavailable" })
    }
    let exists = true
    const { ipc, tags } = fakeIpc({
      PluginCall: unavailable,
      PluginSubscribe: () => ({ available: false }),
      FilesRevealPath: () => exists,
    })
    const explorer = desktopHost(fakeOwn(), ipc, undefined, env()).explorer!
    const started = Date.now()
    expect(await explorer.reveal("C:\\work\\a.ts")).toEqual({ ok: true })
    // It waited for main to start the plugin before giving up.
    expect(Date.now() - started).toBeGreaterThanOrEqual(EXPLORER_AVAILABLE_MS - 50)
    expect(tags()).toEqual(["PluginCall", "PluginSubscribe", "FilesRevealPath"])
    exists = false
    // One wait per window: the next calls answer at once.
    const again = Date.now()
    expect(await explorer.reveal("C:\\work\\gone.ts")).toEqual({ ok: false, reason: "missing" })
    expect(Date.now() - again).toBeLessThan(1_000)
    expect(await explorer.launch({ host: "devbox", path: "/a" })).toEqual({ ok: false, reason: "unavailable" })
    await expect(explorer.program()).rejects.toMatchObject({ code: "unavailable" })
  }, 30_000)

  test("explorer: a call that comes before main started the plugin is tried again once it is there", async () => {
    let up = false
    const { ipc, tags, emit } = fakeIpc({
      PluginCall: () => {
        if (!up) throw Object.assign(new Error("unavailable"), { code: "unavailable" })
        return { ok: true }
      },
      PluginSubscribe: () => {
        setTimeout(() => {
          up = true
          emit("PluginAvailable", { ipc: EXPLORER_IPC, available: true })
        }, 30)
        return { available: false }
      },
    })
    const explorer = desktopHost(fakeOwn(), ipc, undefined, env()).explorer!
    expect(await explorer.reveal("D:\\projects\\app")).toEqual({ ok: true })
    expect(tags()).toEqual(["PluginCall", "PluginSubscribe", "PluginCall"])
    // Another Ipc's availability opens nothing.
    up = false
    const pending = explorer.launch({ host: "devbox", path: "/a" })
    emit("PluginAvailable", { ipc: "browser.pane", available: true })
    up = true
    expect(await pending).toEqual({ ok: true })
  })

  test("explorer: a failed call or an answer of another shape is a failure with its text, never a throw", async () => {
    let answer: () => unknown = () => {
      throw new Error("Desktop IPC handler failed", { cause: { message: "input: path too long" } })
    }
    const { ipc } = fakeIpc({ PluginCall: () => answer() })
    const explorer = desktopHost(fakeOwn(), ipc, undefined, env()).explorer!
    expect(await explorer.reveal("D:\\x")).toEqual({ ok: false, reason: "failed", detail: "input: path too long" })
    answer = () => "yes"
    expect(await explorer.launch({ host: "devbox", path: "/a" })).toEqual({ ok: false, reason: "failed" })
    answer = () => ({ program: 1 })
    await expect(explorer.program()).rejects.toThrow("explorer.program")
  })

  test("readClipboardImage: PNG blob; null when empty or when main fails", async () => {
    let answer: () => unknown = () => ({ buffer: new Uint8Array([137, 80, 78, 71]), width: 1, height: 1 })
    const { ipc } = fakeIpc({ FilesReadClipboardImage: () => answer() })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    const blob = await files.readClipboardImage!()
    expect(blob?.type).toBe("image/png")
    expect(blob?.size).toBe(4)
    answer = () => null
    expect(await files.readClipboardImage!()).toBeNull()
    answer = () => {
      throw new Error("clipboard busy")
    }
    expect(await files.readClipboardImage!()).toBeNull()
  })

  test("saveFile: text through the save dialog; binary refused without a call", async () => {
    const { ipc, calls } = fakeIpc({ FilesSaveFile: () => true })
    const files = desktopHost(fakeOwn(), ipc, undefined, env()).files!
    const json = new Blob(['{"a":1}'], { type: "application/json" })
    expect(await files.saveFile!({ name: "session.json", data: json })).toBe(true)
    expect(calls[0]!.payload).toEqual({ options: { defaultPath: "session.json" }, content: '{"a":1}' })
    expect(await files.saveFile!({ name: "a.png", data: new Blob([new Uint8Array([1])], { type: "image/png" }) })).toBe(
      false,
    )
    expect(calls).toHaveLength(1)
  })
})

describe("notifications (03 §9, 05 §7.4)", () => {
  test("only while the window is not focused; silent, tagged, no icon URL", async () => {
    let focused = true
    const { ipc } = fakeIpc({ WindowGetFocused: () => focused })
    const host = desktopHost(fakeOwn(), ipc, undefined, env())
    host.notify!({ title: "승인이 필요해요", body: "RPC 설계 · 명령 실행", tag: "own:approval:local:ses_1" })
    await flush()
    expect(FakeToast.made).toHaveLength(0)
    focused = false
    host.notify!({ title: "승인이 필요해요", body: "RPC 설계 · 명령 실행", tag: "own:approval:local:ses_1" })
    await flush()
    expect(FakeToast.made).toHaveLength(1)
    const toast = FakeToast.made[0]!
    expect(toast.title).toBe("승인이 필요해요")
    expect(toast.options).toEqual({ body: "RPC 설계 · 명령 실행", tag: "own:approval:local:ses_1", silent: true })
  })

  test("same tag within 10 s merges; other tags and later ones go out", async () => {
    const { ipc } = fakeIpc({ WindowGetFocused: () => false })
    const host = desktopHost(fakeOwn(), ipc, undefined, env())
    host.notify!({ title: "a", tag: "own:turn:local:ses_1" })
    host.notify!({ title: "b", tag: "own:turn:local:ses_1" })
    host.notify!({ title: "c", tag: "own:approval:local:ses_1" })
    clock += NOTIFY_MERGE_MS - 1
    host.notify!({ title: "d", tag: "own:turn:local:ses_1" })
    clock += 1
    host.notify!({ title: "e", tag: "own:turn:local:ses_1" })
    await flush()
    expect(FakeToast.made.map((toast) => toast.title)).toEqual(["a", "c", "e"])
  })

  test("an event skipped for focus does not swallow the next one", async () => {
    let focused = true
    const { ipc } = fakeIpc({ WindowGetFocused: () => focused })
    const host = desktopHost(fakeOwn(), ipc, undefined, env())
    host.notify!({ title: "a", tag: "own:turn:local:ses_2" })
    await flush()
    focused = false
    clock += 3_000
    host.notify!({ title: "b", tag: "own:turn:local:ses_2" })
    await flush()
    expect(FakeToast.made.map((toast) => toast.title)).toEqual(["b"])
  })

  test("a hidden or unfocused page notifies although main reports the window focused (minimized)", async () => {
    const { ipc, tags } = fakeIpc({ WindowGetFocused: () => true })
    let active = true
    const host = desktopHost(fakeOwn(), ipc, undefined, env({ pageActive: () => active }))
    host.notify!({ title: "a", tag: "own:approval:local:ses_3" })
    await flush()
    expect(FakeToast.made).toHaveLength(0)
    active = false
    clock += NOTIFY_MERGE_MS
    host.notify!({ title: "b", tag: "own:approval:local:ses_3" })
    await flush()
    expect(FakeToast.made.map((toast) => toast.title)).toEqual(["b"])
    expect(tags().filter((tag) => tag === "WindowGetFocused")).toHaveLength(1)
  })

  test("tags longer than a Windows toast allows reach the OS as a stable short hash", async () => {
    const long = "own:approval:local:ses_f1f03a361ffexOTZO6G98f6lIS"
    expect(toastTag("own:approval:local:ses_1")).toBe("own:approval:local:ses_1")
    expect(toastTag(long)).toBe(toastTag(long))
    expect(toastTag(long)).not.toBe(toastTag(`${long}x`))
    expect(toastTag(long).length).toBeLessThanOrEqual(TOAST_TAG_MAX)
    // Electron's toast tag is `n#<origin>#<tag>`; Windows takes 64 characters at most.
    expect(`n#oc://renderer#${toastTag(long)}`.length).toBeLessThanOrEqual(64)
    const { ipc } = fakeIpc({ WindowGetFocused: () => false })
    desktopHost(fakeOwn(), ipc, undefined, env()).notify!({ title: "a", tag: long })
    await flush()
    expect(FakeToast.made[0]!.options.tag).toBe(toastTag(long))
  })

  test("untagged (the settings test) shows while focused and never asks for focus", async () => {
    const { ipc, tags } = fakeIpc({ WindowGetFocused: () => true })
    desktopHost(fakeOwn(), ipc, undefined, env()).notify!({ title: "테스트 알림" })
    await flush()
    expect(FakeToast.made).toHaveLength(1)
    expect(tags()).not.toContain("WindowGetFocused")
  })

  test("focus unknown (IPC failed): falls back to document focus", async () => {
    const { ipc } = fakeIpc({
      WindowGetFocused: () => {
        throw new Error("port closed")
      },
    })
    const hasFocus = document.hasFocus
    try {
      document.hasFocus = () => true
      desktopHost(fakeOwn(), ipc, undefined, env()).notify!({ title: "a", tag: "t1" })
      await flush()
      expect(FakeToast.made).toHaveLength(0)
      document.hasFocus = () => false
      desktopHost(fakeOwn(), ipc, undefined, env()).notify!({ title: "b", tag: "t1" })
      await flush()
      expect(FakeToast.made).toHaveLength(1)
    } finally {
      document.hasFocus = hasFocus
    }
  })

  test("click shows and focuses the window, runs onClick, closes the toast", async () => {
    const { ipc, tags } = fakeIpc({ WindowGetFocused: () => false })
    let opened = 0
    desktopHost(fakeOwn(), ipc, undefined, env()).notify!({ title: "a", tag: "t2", onClick: () => opened++ })
    await flush()
    const toast = FakeToast.made[0]!
    toast.onclick?.()
    expect(opened).toBe(1)
    expect(toast.closed).toBe(true)
    expect(tags()).toEqual(["WindowGetFocused", "WindowShow", "WindowSetFocus"])
  })

  test("permission denied after start: nothing", async () => {
    const { ipc } = fakeIpc({ WindowGetFocused: () => false })
    const host = desktopHost(fakeOwn(), ipc, undefined, env())
    FakeToast.permission = "denied"
    host.notify!({ title: "a" })
    await flush()
    expect(FakeToast.made).toHaveLength(0)
  })
})

describe("window", () => {
  test("zoom through window.own.zoom (05 §7.9): Chrome's levels, sets and steps answered by main, every change heard", async () => {
    const { ipc, calls } = fakeIpc()
    const listeners = new Set<(factor: number) => void>()
    const asked: unknown[] = []
    let kept = 1.25
    const own: OwnShellApi = {
      ...fakeOwn(),
      zoom: {
        get: async () => kept,
        set: async (factor) => {
          asked.push(["set", factor])
          kept = Math.min(2, Math.max(0.5, factor))
          listeners.forEach((listener) => listener(kept))
          return kept
        },
        step: async (direction) => {
          asked.push(["step", direction])
          return kept
        },
        onChange(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    }
    const zoom = desktopHost(own, ipc, undefined, env()).window!.zoom!
    expect(zoom.levels.map((level) => Math.round(level * 100))).toEqual([
      50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200,
    ])
    expect(await zoom.get()).toBe(1.25)
    const seen: number[] = []
    const off = zoom.onChange((factor) => seen.push(factor))
    expect(await zoom.set(3)).toBe(2)
    // Not a factor: nothing is sent, the answer is the kept one.
    expect(await zoom.set(Number.NaN)).toBe(2)
    expect(await zoom.set(0)).toBe(2)
    expect(await zoom.step("out")).toBe(2)
    off()
    await zoom.set(1)
    expect(seen).toEqual([2])
    expect(asked).toEqual([
      ["set", 3],
      ["step", "out"],
      ["set", 1],
    ])
    // Upstream's WindowSetZoomFactor is no longer used: it neither keeps the factor nor reaches other windows.
    expect(calls.map((call) => call.tag)).not.toContain("WindowSetZoomFactor")
  })

  test("a shell without window.own.zoom: no zoom (no keys, no indicator, no settings row)", () => {
    const { ipc } = fakeIpc()
    expect(desktopHost(fakeOwn(), ipc, undefined, env()).window?.zoom).toBeUndefined()
  })
})

describe("browser pane over the `browser` GUI extension (05 §8.1, f406d93a66)", () => {
  type Registration = {
    setLayout(layout?: unknown): void
    command(command: unknown): Promise<void>
    capture(tabID: string): Promise<Blob | null>
    close(): void
  }
  type Pane = {
    register(target: unknown, listener: (event: unknown) => void): Registration
    onAvailable?(listener: () => void): () => void
  }
  const local = { serverKey: "local", sessionID: "ses_1", endpoint: { url: "http://127.0.0.1:28538" } }
  const bounds = { x: 10, y: 20, width: 300, height: 200 }
  const pane = (ipc: never) => desktopHost(fakeOwn(), ipc, undefined, env()).browser as unknown as Pane
  const callInput = (calls: Call[], method: string) =>
    calls
      .filter((call) => call.tag === "PluginCall" && (call.payload as { method: string }).method === method)
      .map((call) => (call.payload as { input: unknown }).input)
  const event = (binding: string, value: unknown) => ({ ipc: PANE_IPC, name: "event", data: { binding, event: value } })

  test("configure, then register under the server key; events by binding; calls after register; close once", async () => {
    const { ipc, calls, emit } = fakeIpc({ PluginSubscribe: () => ({ available: true }) })
    const events: unknown[] = []
    const registration = pane(ipc).register(local, (value) => events.push(value))
    await flush()
    expect(calls.find((call) => call.tag === "PluginSubscribe")?.payload).toEqual({ ipc: "browser.pane" })
    expect(calls.find((call) => call.tag === "PluginConfigure")?.payload).toEqual({
      servers: [{ id: "local", url: "http://127.0.0.1:28538" }],
    })
    const [register] = callInput(calls, "register") as { binding: string; server: string; session: string }[]
    expect(register).toEqual({ binding: register!.binding, server: "local", session: "ses_1" })
    expect(calls.find((call) => call.tag === "PluginCall")?.payload).toMatchObject({ ipc: "browser.pane" })
    const binding = register!.binding
    const state = { tabs: [], focusedTabID: null }
    emit("PluginEvent", event(binding, { type: "state", state }))
    emit("PluginEvent", event("other", { type: "focus", tabID: "tab_x" }))
    emit("PluginEvent", { ipc: "other.ipc", name: "event", data: { binding, event: { type: "focus", tabID: "x" } } })
    emit("PluginEvent", event(binding, { type: "inspect", tabID: "tab_1", active: true }))
    expect(events).toEqual([{ type: "state", state }])
    await registration.command({ type: "tabs.open" })
    expect(callInput(calls, "command")).toEqual([{ binding, command: { type: "tabs.open" } }])
    registration.close()
    registration.close()
    await flush()
    expect(callInput(calls, "close")).toEqual([{ binding }])
    emit("PluginEvent", event(binding, { type: "focus", tabID: "tab_1" }))
    expect(events).toHaveLength(1)
  })

  test("a chord a focused page hands over runs as a window key press; page focus and details stop here", async () => {
    const { ipc, calls, emit } = fakeIpc({ PluginSubscribe: () => ({ available: true }) })
    const events: unknown[] = []
    pane(ipc).register(local, (value) => events.push(value))
    await flush()
    const binding = (callInput(calls, "register")[0] as { binding: string }).binding
    const keys: KeyboardEvent[] = []
    const listener = (key: KeyboardEvent) => keys.push(key)
    window.addEventListener("keydown", listener)
    try {
      const chord = { key: "w", code: "KeyW", ctrl: true, meta: false, shift: false, alt: false }
      emit("PluginEvent", event(binding, { type: "shortcut", ...chord }))
      emit("PluginEvent", event(binding, { type: "focused", tabID: "tab_1" }))
      emit("PluginEvent", event(binding, { type: "page", tabID: "tab_1", zoom: 1 }))
      expect(events).toEqual([])
      expect(
        keys.map((key) => ({
          key: key.key,
          code: key.code,
          ctrl: key.ctrlKey,
          meta: key.metaKey,
          shift: key.shiftKey,
          alt: key.altKey,
          cancelable: key.cancelable,
        })),
      ).toEqual([{ ...chord, cancelable: true }])
    } finally {
      window.removeEventListener("keydown", listener)
    }
  })

  test("a layout goes to its tab's embed and hides the one placed before; a tab without a page is loaded", async () => {
    const { ipc, calls, emit } = fakeIpc({
      PluginSubscribe: () => ({ available: true }),
      PluginCapture: (payload) => ((payload as { id: string }).id === "e2" ? new Uint8Array([1, 2, 3]) : null),
    })
    const events: unknown[] = []
    const registration = pane(ipc).register(local, (value) => events.push(value))
    await flush()
    const binding = (callInput(calls, "register")[0] as { binding: string }).binding
    // A restored tab has no page yet: hidden, it stays unloaded; shown, main creates its page once.
    registration.setLayout({ tabID: "tab_1", visible: false })
    await flush()
    expect(callInput(calls, "load")).toEqual([])
    registration.setLayout({ tabID: "tab_1", visible: true, bounds })
    registration.setLayout({ tabID: "tab_1", visible: true, bounds })
    await flush()
    expect(callInput(calls, "load")).toEqual([{ binding, tabID: "tab_1" }])
    emit("PluginEvent", event(binding, { type: "embed", tabID: "tab_1", embed: "e1" }))
    emit("PluginEvent", event(binding, { type: "embed", tabID: "tab_2", embed: "e2" }))
    expect(events).toEqual([])
    const embedCalls = () => calls.filter((call) => call.tag === "PluginEmbed").map((call) => call.payload)
    expect(embedCalls()).toEqual([{ id: "e1", layout: { visible: true, bounds } }])
    registration.setLayout({ tabID: "tab_2", visible: true, bounds, background: [1, 2, 3, 255] })
    expect(embedCalls().slice(1)).toEqual([
      { id: "e1" },
      { id: "e2", layout: { visible: true, bounds, background: [1, 2, 3, 255] } },
    ])
    expect(calls.filter((call) => call.tag === "PluginEmbed").every((call) => call.kind === "send")).toBe(true)
    const blob = await registration.capture("tab_2")
    expect(blob?.type).toBe("image/jpeg")
    expect(blob?.size).toBe(3)
    expect(calls.findLast((call) => call.tag === "PluginCapture")?.payload).toEqual({ id: "e2" })
    expect(await registration.capture("tab_1")).toBeNull()
    expect(await registration.capture("tab_9")).toBeNull()
    registration.setLayout(undefined)
    expect(embedCalls().at(-1)).toEqual({ id: "e2" })
    registration.setLayout({ tabID: "tab_2", visible: true, bounds })
    registration.close()
    expect(embedCalls().at(-1)).toEqual({ id: "e2" })
    expect(await registration.capture("tab_2")).toBeNull()
  })

  test("endpoints: the window's list goes to main once per change, a remote one with its credentials", async () => {
    const { ipc, calls } = fakeIpc({ PluginSubscribe: () => ({ available: true }) })
    const platform = pane(ipc)
    platform.register(local, () => undefined)
    platform.register({ ...local, sessionID: "ses_2" }, () => undefined)
    await flush()
    const remote = { url: "http://127.0.3.2:31000", username: "opencode", password: "token" }
    platform.register({ serverKey: "ssh:box", sessionID: "ses_3", endpoint: remote }, () => undefined)
    await flush()
    expect(calls.filter((call) => call.tag === "PluginConfigure").map((call) => call.payload)).toEqual([
      { servers: [{ id: "local", url: "http://127.0.0.1:28538" }] },
      {
        servers: [
          { id: "local", url: "http://127.0.0.1:28538" },
          { id: "ssh:box", url: remote.url, username: "opencode", password: "token" },
        ],
      },
    ])
    expect((callInput(calls, "register") as { server: string }[]).map((input) => input.server)).toEqual([
      "local",
      "local",
      "ssh:box",
    ])
  })

  test("main still starting the extension: register waits for PluginAvailable", async () => {
    const { ipc, calls, emit } = fakeIpc({ PluginSubscribe: () => ({ available: false }) })
    pane(ipc).register(local, () => undefined)
    await flush()
    expect(callInput(calls, "register")).toEqual([])
    emit("PluginAvailable", { ipc: "other.ipc", available: true })
    await flush()
    expect(callInput(calls, "register")).toEqual([])
    emit("PluginAvailable", { ipc: PANE_IPC, available: true })
    await flush()
    expect(callInput(calls, "register")).toHaveLength(1)
  })

  test("what main rejects becomes a closed-state event; the extension going away suspends with the last tabs", async () => {
    const outcome = { register: (): unknown => undefined }
    const { ipc, calls, emit } = fakeIpc({
      PluginSubscribe: () => ({ available: true }),
      PluginCall: (payload) => {
        const method = (payload as { method: string }).method
        if (method === "register") return outcome.register()
        if (method === "command") throw { code: "failed", message: "Browser tab is unavailable." }
      },
    })
    const platform = pane(ipc)
    const run = async (register: () => unknown, restore?: unknown) => {
      outcome.register = register
      const events: unknown[] = []
      const registration = platform.register(restore ? { ...local, restore } : local, (value) => events.push(value))
      await flush()
      return { events, registration }
    }
    const tabs = { tabs: [{ id: "tab_1", url: "https://example.com/" }], focusedTabID: "tab_1" }
    expect((await run(() => Promise.reject({ code: "unavailable" }), tabs)).events).toEqual([
      { type: "state", state: tabs, error: "browser.pane.suspended", lost: true },
    ])
    expect(
      (await run(() => Promise.reject({ code: "failed", message: "browser.pane.registration.invalid" }))).events,
    ).toEqual([{ type: "state", state: null, error: "browser.pane.registration.closed" }])
    // A binding main took and then closed: its own closed-state event decides.
    expect(
      (await run(() => Promise.reject({ code: "failed", message: "browser.pane.registration.closed" }))).events,
    ).toEqual([])

    const live = await run(() => undefined)
    await expect(live.registration.command({ type: "back", tabID: "tab_1" })).rejects.toThrow(
      "Browser tab is unavailable.",
    )
    const binding = (callInput(calls, "register").at(-1) as { binding: string }).binding
    emit("PluginEvent", event(binding, { type: "state", state: tabs }))
    emit("PluginEvent", event(binding, { type: "state", state: tabs, error: "page_crashed" }))
    emit("PluginAvailable", { ipc: PANE_IPC, available: false })
    expect(live.events).toEqual([
      { type: "state", state: tabs },
      { type: "state", state: tabs, error: "page_crashed" },
      { type: "state", state: tabs, error: "browser.pane.suspended", lost: true },
    ])
  })

  test("onAvailable hears the pane come back after it went away, once per return", async () => {
    const { ipc, emit } = fakeIpc({ PluginSubscribe: () => ({ available: true }) })
    const platform = pane(ipc)
    const returns: number[] = []
    const stop = platform.onAvailable!(() => returns.push(returns.length))
    platform.register(local, () => undefined)
    await flush()
    // The first answer counts as coming up.
    expect(returns).toEqual([0])
    emit("PluginAvailable", { ipc: PANE_IPC, available: true })
    expect(returns).toEqual([0])
    emit("PluginAvailable", { ipc: PANE_IPC, available: false })
    emit("PluginAvailable", { ipc: "other.ipc", available: true })
    expect(returns).toEqual([0])
    emit("PluginAvailable", { ipc: PANE_IPC, available: true })
    expect(returns).toEqual([0, 1])
    stop()
    emit("PluginAvailable", { ipc: PANE_IPC, available: false })
    emit("PluginAvailable", { ipc: PANE_IPC, available: true })
    expect(returns).toEqual([0, 1])
  })

  test("downloads and the close guard are the shell's own calls; no keep-screen-awake on the window", () => {
    const { ipc } = fakeIpc()
    const guards: boolean[] = []
    const browser = {
      onDownload: () => () => undefined,
      saveDownload: async () => ({ ok: true as const }),
      guardClose: (on: boolean) => void guards.push(on),
    }
    const host = desktopHost({ ...fakeOwn(), browser }, ipc, undefined, env())
    expect(host.capabilities.browserPane).toBe(true)
    const platform = host.browser as unknown as { guardClose(on: boolean): void; downloads?: unknown }
    platform.guardClose(true)
    expect(guards).toEqual([true])
    expect(platform.downloads).toBeDefined()
    expect((desktopHost(fakeOwn(), ipc, undefined, env()).browser as { downloads?: unknown }).downloads).toBeUndefined()
    expect(host.capabilities.keepScreenAwake).toBe(false)
    expect("keepScreenAwake" in host.window!).toBe(false)
  })
})
