import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { createEventBus } from "@/data/events"
import { connectUrl, controlCursor, createPtyApi, isNotFound, type PtyApi, type PtyInfo } from "./api"
import { exitCodeText, folderName, shellName, tabLabels } from "./label"
import { createSizeSync } from "./size"
import { createTerminalStore, sameDirectory } from "./store"
import { terminalKo, terminalText } from "./strings"
import { bufferText } from "./text"
import { toHex } from "./theme"
import { pendingNewTerminals, requestNewTerminal, takeNewTerminalRequests } from "./intents"

const DIR = "D:\\work\\own-open-code"

function info(id: string, overrides: Partial<PtyInfo> = {}): PtyInfo {
  return {
    id,
    title: id,
    command: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    args: [],
    cwd: DIR,
    status: "running",
    pid: 1,
    ...overrides,
  }
}

function fakeApi(initial: PtyInfo[] = []) {
  const server = { ptys: [...initial], created: 0, removed: [] as string[], fail: undefined as Error | undefined }
  const api: PtyApi = {
    directory: DIR,
    list: async () => {
      if (server.fail) throw server.fail
      return server.ptys
    },
    create: async (input) => {
      server.created += 1
      const created = info(`pty_new${server.created}`, {
        command: input.command ?? "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      })
      server.ptys.push(created)
      return created
    },
    get: async (id) => {
      const found = server.ptys.find((pty) => pty.id === id)
      if (!found) throw Object.assign(new Error("gone"), { name: "PtyNotFoundError" })
      return found
    },
    resize: async () => undefined,
    remove: async (id) => {
      server.removed.push(id)
      server.ptys = server.ptys.filter((pty) => pty.id !== id)
    },
    connect: async () => {
      throw new Error("not in unit tests")
    },
    shells: async () => [],
  }
  return { api, server }
}

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    map,
  }
}

function event(type: string, data: unknown, directory = DIR) {
  return { id: `evt_${Math.random()}`, created: 0, type, data, location: { directory } } as unknown as OpenCodeEvent
}

describe("terminal store (03 §18.6)", () => {
  test("loads the location's PTYs, remembered order first, and picks the remembered active tab", async () => {
    const { api } = fakeApi([info("pty_a"), info("pty_b"), info("pty_c")])
    const storage = memoryStorage()
    storage.setItem("k", JSON.stringify({ order: ["pty_c", "pty_gone", "pty_a"], active: "pty_a" }))
    const store = createTerminalStore({ api, events: createEventBus(), storage, storageKey: "k" })
    await store.load()
    expect(store.state.status).toBe("ready")
    expect(store.state.order).toEqual(["pty_c", "pty_a", "pty_b"])
    expect(store.state.active).toBe("pty_a")
    expect(store.running()).toBe(3)
    store.dispose()
  })

  test("create adds a tab, activates and asks for focus; close removes it on the server", async () => {
    const { api, server } = fakeApi([info("pty_a")])
    const store = createTerminalStore({ api, events: createEventBus() })
    await store.load()
    const created = await store.create()
    expect(created?.id).toBe("pty_new1")
    expect(store.state.order).toEqual(["pty_a", "pty_new1"])
    expect(store.state.active).toBe("pty_new1")
    expect(store.state.focus).toBe("pty_new1")
    await store.close("pty_new1")
    expect(store.state.order).toEqual(["pty_a"])
    expect(store.state.active).toBe("pty_a")
    expect(server.removed).toEqual(["pty_new1"])
    store.dispose()
  })

  test("pty events of this location update the tabs; other locations are ignored", async () => {
    const bus = createEventBus()
    const { api } = fakeApi([info("pty_a")])
    const store = createTerminalStore({ api, events: bus })
    await store.load()
    bus.publish(event("pty.created", { info: info("pty_other") }, "D:\\elsewhere"))
    bus.publish(event("pty.created", { info: info("pty_b") }, "d:/work/own-open-code/"))
    bus.publish(event("pty.exited", { id: "pty_a", exitCode: 3 }))
    bus.flush()
    expect(store.state.order).toEqual(["pty_a", "pty_b"])
    expect(store.state.items.pty_a?.status).toBe("exited")
    expect(store.state.items.pty_a?.exitCode).toBe(3)
    expect(store.running()).toBe(1)
    bus.publish(event("pty.deleted", { id: "pty_b" }))
    bus.flush()
    expect(store.state.order).toEqual(["pty_a"])
    store.dispose()
  })

  test("exited PTYs stay as tabs; restart puts a new PTY with the same shell in the same place", async () => {
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe"
    const { api, server } = fakeApi([
      info("pty_a"),
      info("pty_b", { command: bash, status: "exited", exitCode: 0 }),
      info("pty_c"),
    ])
    const store = createTerminalStore({ api, events: createEventBus() })
    await store.load()
    const created = await store.restart("pty_b")
    expect(created?.command).toBe(bash)
    expect(store.state.order).toEqual(["pty_a", created!.id, "pty_c"])
    expect(store.state.active).toBe(created!.id)
    expect(server.removed).toEqual(["pty_b"])
    store.dispose()
  })

  test("a restart racing its own pty.created event still lands in place", async () => {
    const bus = createEventBus()
    const { api } = fakeApi([info("pty_a"), info("pty_b", { status: "exited", exitCode: 1 })])
    const original = api.create
    api.create = async (input) => {
      const created = await original(input)
      bus.publish(event("pty.created", { info: created }))
      bus.flush()
      return created
    }
    const store = createTerminalStore({ api, events: bus })
    await store.load()
    const created = await store.restart("pty_b")
    expect(store.state.order).toEqual(["pty_a", created!.id])
    store.dispose()
  })

  test("after reconnecting, PTYs the server lost keep their tab as gone; new ones are added", async () => {
    const bus = createEventBus()
    const { api, server } = fakeApi([info("pty_a"), info("pty_b")])
    const store = createTerminalStore({ api, events: bus })
    await store.load()
    server.ptys = [info("pty_z")]
    bus.publish(event("server.connected", {}))
    bus.flush()
    await Bun.sleep(0)
    expect(store.state.order).toEqual(["pty_a", "pty_b", "pty_z"])
    expect(store.state.items.pty_a?.gone).toBe(true)
    expect(store.state.items.pty_a?.status).toBe("exited")
    expect(store.state.items.pty_z?.gone).toBeUndefined()
    expect(store.running()).toBe(1)
    store.dispose()
  })

  test("a failed first load reports the error and the next server.connected retries", async () => {
    const bus = createEventBus()
    const { api, server } = fakeApi([info("pty_a")])
    server.fail = new Error("server x is not connected yet")
    const store = createTerminalStore({ api, events: bus })
    await store.load()
    expect(store.state.status).toBe("error")
    server.fail = undefined
    bus.publish(event("server.connected", {}))
    bus.flush()
    await Bun.sleep(0)
    expect(store.state.status).toBe("ready")
    expect(store.state.order).toEqual(["pty_a"])
    store.dispose()
  })

  test("step wraps around and remembers the active tab", async () => {
    const storage = memoryStorage()
    const { api } = fakeApi([info("pty_a"), info("pty_b")])
    const store = createTerminalStore({ api, events: createEventBus(), storage, storageKey: "k" })
    await store.load()
    store.step(1)
    expect(store.state.active).toBe("pty_b")
    store.step(1)
    expect(store.state.active).toBe("pty_a")
    expect(JSON.parse(storage.map.get("k")!)).toEqual({ order: ["pty_a", "pty_b"], active: "pty_a" })
    store.dispose()
  })

  test("Windows directories compare case- and slash-insensitively, others exactly", () => {
    expect(sameDirectory("D:\\a\\b", "d:/a/b/")).toBe(true)
    expect(sameDirectory("/home/a", "/home/A")).toBe(false)
    expect(sameDirectory("/home/a", "/home/a")).toBe(true)
  })
})

describe("PTY api", () => {
  test("the WebSocket URL carries the ticket, the location and the cursor, under a path prefix", () => {
    const url = connectUrl({
      baseUrl: "https://pc.tailnet.ts.net/srv/local",
      ptyID: "pty_1",
      directory: "D:\\work",
      cursor: 42,
      ticket: "t-1",
    })
    expect(url.protocol).toBe("wss:")
    expect(url.pathname).toBe("/srv/local/api/pty/pty_1/connect")
    expect(url.searchParams.get("ticket")).toBe("t-1")
    expect(url.searchParams.get("cursor")).toBe("42")
    expect(url.searchParams.get("location[directory]")).toBe("D:\\work")
    expect([...url.searchParams.keys()].sort()).toEqual(["cursor", "location[directory]", "ticket"])
    const plain = connectUrl({
      baseUrl: "http://127.0.0.1:5173",
      ptyID: "pty_1",
      directory: "/w",
      cursor: undefined,
      ticket: "t",
    })
    expect(plain.protocol).toBe("ws:")
    expect(plain.searchParams.has("cursor")).toBe(false)
  })

  test("connect mints a ticket with the ticket header, then opens the socket on the ticket URL", async () => {
    const calls: unknown[] = []
    const client = {
      pty: {
        connect: {
          token: async (input: unknown) => {
            calls.push(input)
            return { location: { directory: "/w" }, data: { ticket: "ticket-1", expires_in: 60 } }
          },
        },
      },
    }
    const opened: URL[] = []
    const api = createPtyApi({
      // SAFETY: only `pty.connect.token` is used by `connect`.
      client: () => client as never,
      baseUrl: () => "http://127.0.0.1:5199",
      directory: "/w",
      openSocket: (url) => {
        opened.push(url)
        return { binaryType: "blob" } as WebSocket
      },
    })
    const socket = await api.connect("pty_9", 7)
    expect(calls).toEqual([{ ptyID: "pty_9", location: { directory: "/w" }, "x-opencode-ticket": "1" }])
    expect(opened[0]?.toString()).toBe(
      "ws://127.0.0.1:5199/api/pty/pty_9/connect?location%5Bdirectory%5D=%2Fw&cursor=7&ticket=ticket-1",
    )
    expect(socket.binaryType).toBe("arraybuffer")
  })

  test("terminals start with PowerShell's update notice off (pwsh 7.6 dies printing it in a ConPTY)", async () => {
    const calls: unknown[] = []
    const client = {
      pty: {
        create: async (input: unknown) => {
          calls.push(input)
          return { data: info("pty_new") }
        },
      },
    }
    // SAFETY: only `pty.create` is used by `create`.
    const api = createPtyApi({ client: () => client as never, baseUrl: () => "http://127.0.0.1:5199", directory: "/w" })
    await api.create({ command: "pwsh.exe" })
    expect(calls).toEqual([
      {
        location: { directory: "/w" },
        command: "pwsh.exe",
        title: undefined,
        env: { POWERSHELL_UPDATECHECK: "Off" },
      },
    ])
  })

  test("control frames carry the resume cursor; other binary frames are ignored", () => {
    const decoder = new TextDecoder()
    const frame = (text: string, first = 0) => {
      const bytes = new TextEncoder().encode(text)
      const out = new Uint8Array(bytes.length + 1)
      out[0] = first
      out.set(bytes, 1)
      return out.buffer
    }
    expect(controlCursor(frame('{"cursor":1234}'), decoder)).toBe(1234)
    expect(controlCursor(frame('{"cursor":-1}'), decoder)).toBeUndefined()
    expect(controlCursor(frame('{"cursor":5}', 1), decoder)).toBeUndefined()
  })

  test("only PtyNotFoundError counts as removed", () => {
    expect(isNotFound(Object.assign(new Error("x"), { name: "PtyNotFoundError" }))).toBe(true)
    expect(isNotFound(new Error("network"))).toBe(false)
  })
})

describe("tab labels (셸 이름 · 폴더)", () => {
  test("shell and folder names", () => {
    expect(shellName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh")
    expect(shellName("/usr/bin/bash")).toBe("bash")
    expect(shellName("cmd.exe")).toBe("cmd")
    expect(folderName("D:\\work\\own-open-code\\")).toBe("own-open-code")
    expect(folderName("D:\\")).toBe("D:")
    expect(folderName("/")).toBe("/")
  })

  test("the same shell in the same folder is numbered from the second tab", () => {
    const labels = tabLabels([info("a"), info("b"), info("c", { command: "/bin/bash" })])
    expect(labels.get("a")).toEqual({ shell: "pwsh", folder: "own-open-code", n: 1 })
    expect(labels.get("b")).toEqual({ shell: "pwsh", folder: "own-open-code", n: 2 })
    expect(labels.get("c")).toEqual({ shell: "bash", folder: "own-open-code", n: 1 })
    expect(terminalText("ko", "own.terminal.labelNumbered", { shell: "pwsh", folder: "x", n: 2 })).toBe("pwsh · x (2)")
  })

  test("exit codes from 0x80000000 up show in Windows hex, the rest in decimal", () => {
    expect(exitCodeText(0)).toBe("0")
    expect(exitCodeText(1)).toBe("1")
    expect(exitCodeText(0x7fffffff)).toBe("2147483647")
    expect(exitCodeText(3221225477)).toBe("0xC0000005")
    expect(exitCodeText(0x80131623)).toBe("0x80131623")
    // An older server sent the signed value bun-pty reports.
    expect(exitCodeText(-1073741819)).toBe("0xC0000005")
    expect(exitCodeText(-1)).toBe("0xFFFFFFFF")
  })
})

describe("size sync (rAF당 한 번, one request in flight)", () => {
  test("coalesces sizes while a request is in flight and skips repeats", async () => {
    const sent: string[] = []
    const gates: (() => void)[] = []
    const sync = createSizeSync(
      (size) =>
        new Promise<void>((resolve) => {
          sent.push(`${size.cols}x${size.rows}`)
          gates.push(resolve)
        }),
    )
    sync.set({ cols: 80, rows: 24 })
    sync.set({ cols: 90, rows: 24 })
    sync.set({ cols: 100, rows: 30 })
    expect(sent).toEqual(["80x24"])
    gates.shift()!()
    await Bun.sleep(0)
    expect(sent).toEqual(["80x24", "100x30"])
    gates.shift()!()
    await Bun.sleep(0)
    sync.set({ cols: 100, rows: 30 })
    sync.set({ cols: 0, rows: 30 })
    expect(sent).toEqual(["80x24", "100x30"])
    expect(sync.sent()).toEqual({ cols: 100, rows: 30 })
  })

  test("a failed request does not count as sent", async () => {
    const sent: string[] = []
    const sync = createSizeSync(async (size) => {
      sent.push(`${size.cols}x${size.rows}`)
      throw new Error("offline")
    })
    sync.set({ cols: 80, rows: 24 })
    await Bun.sleep(0)
    sync.set({ cols: 80, rows: 24 })
    await Bun.sleep(0)
    expect(sent).toEqual(["80x24", "80x24"])
    expect(sync.sent()).toBeUndefined()
  })
})

describe("output as text (03 §11, last 500 lines)", () => {
  const buffer = (rows: { text: string; wrapped?: boolean }[]) => ({
    length: rows.length,
    getLine: (y: number) => {
      const row = rows[y]
      return row ? { isWrapped: !!row.wrapped, translateToString: () => row.text } : undefined
    },
  })

  test("joins wrapped rows, drops the empty rows below the prompt and keeps the last lines", () => {
    const rows = [
      { text: "$ echo 한글" },
      { text: "한글" },
      { text: "$ long" },
      { text: "-continued", wrapped: true },
      { text: "" },
      { text: "" },
    ]
    expect(bufferText(buffer(rows))).toBe("$ echo 한글\n한글\n$ long-continued")
    expect(bufferText(buffer(rows), 2)).toBe("한글\n$ long-continued")
    expect(bufferText(buffer([]))).toBe("")
  })
})

describe("theme colors", () => {
  test("computed colors become canvas hex", () => {
    expect(toHex("rgb(36, 36, 36)")).toBe("#242424")
    expect(toHex("rgba(255, 255, 255, 1)")).toBe("#ffffff")
    expect(toHex("rgba(0, 0, 0, 0)")).toBeUndefined()
    expect(toHex("#ABC")).toBe("#aabbcc")
  })
})

describe("intents (eager surface)", () => {
  test("new-terminal requests queue until the terminal UI takes them", () => {
    takeNewTerminalRequests()
    requestNewTerminal()
    requestNewTerminal()
    expect(pendingNewTerminals()).toBe(2)
    expect(takeNewTerminalRequests()).toBe(2)
    expect(pendingNewTerminals()).toBe(0)
  })
})

describe("strings", () => {
  test("every key is in the own.terminal namespace and has English", async () => {
    const { terminalEn } = await import("./strings")
    const missing = Object.keys(terminalKo).filter(
      (key) => !key.startsWith("own.terminal.") || (!(key in terminalEn) && !key.startsWith("own.terminal.label")),
    )
    expect(missing).toEqual([])
  })
})
