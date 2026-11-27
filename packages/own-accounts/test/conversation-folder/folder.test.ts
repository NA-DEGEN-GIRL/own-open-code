// 기본 대화 폴더 (03 §5.1) and 폴더 열기 시작 위치 (03 §18.3): the RPC handlers over an in-memory stand-in for the plugin
// KV and a temp folder. The service decides its built-in default, creates it only on first use, keeps the user's
// choices in its KV (so every window and device agrees), refuses folders that cannot hold conversations or start the
// picker, announces every change, and a remote service answers these methods itself.
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { Kv } from "@own/protocol"
import type { Schema } from "effect"
import { ConversationFolders } from "../../src/conversation-folder/folder.js"
import { ConversationFolderRpc } from "../../src/rpc/conversation-folder.js"
import { Register } from "../../src/rpc/register.js"
import { removeTree } from "../e2e-kit/harness/remove.js"
import { call, ok, recordEvents } from "../plugins/support.js"
import { testDeps } from "../support/deps.js"

function memoryStorage() {
  const values = new Map<string, Schema.Json>()
  const storage: Pick<StorageDomain, "get" | "set" | "remove"> = {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, structuredClone(value)),
    remove: async (key) => void values.delete(key),
  }
  return { storage, values }
}

async function rig() {
  const kv = memoryStorage()
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-conversation-folder-")))
  const builtin = path.join(root, "home", "Documents", "Own OpenCode")
  const t = await testDeps({ ctx: { storage: kv.storage }, control: true, options: { conversationFolder: builtin } })
  return {
    t,
    kv,
    root,
    builtin,
    events: recordEvents(t.deps),
    rpc: ConversationFolderRpc.handlers(t.deps),
    async [Symbol.asyncDispose]() {
      await t[Symbol.asyncDispose]()
      await removeTree(root)
    },
  }
}

const exists = (directory: string) =>
  fs.stat(directory).then(
    (stat) => stat.isDirectory(),
    () => false,
  )

describe("the built-in default", () => {
  test("Windows and macOS: Own OpenCode in the documents folder; Linux: ~/own-chats", () => {
    const none = () => false
    expect(ConversationFolders.builtin({ home: "C:\\Users\\me", platform: "win32", isFolder: none })).toBe(
      "C:\\Users\\me\\Documents\\Own OpenCode",
    )
    expect(ConversationFolders.builtin({ home: "/Users/me", platform: "darwin", isFolder: none })).toBe(
      "/Users/me/Documents/Own OpenCode",
    )
    // 2.2.6-own.16: a new host gets a folder in its home that reads and types well in a shell, with or without
    // ~/Documents (a desktop Ubuntu has one, a server usually not).
    expect(ConversationFolders.builtin({ home: "/home/me", platform: "linux", isFolder: none })).toBe(
      "/home/me/own-chats",
    )
    expect(ConversationFolders.builtin({ home: "/home/me", platform: "freebsd", isFolder: none })).toBe(
      "/home/me/own-chats",
    )
  })

  test("a host that already has the older default keeps it, so its conversations stay where they are", () => {
    const only = (directory: string) => (candidate: string) => candidate === directory
    expect(
      ConversationFolders.builtin({
        home: "/home/me",
        platform: "linux",
        isFolder: only("/home/me/Documents/Own OpenCode"),
      }),
    ).toBe("/home/me/Documents/Own OpenCode")
    expect(
      ConversationFolders.builtin({ home: "/home/me", platform: "linux", isFolder: only("/home/me/Own OpenCode") }),
    ).toBe("/home/me/Own OpenCode")
    // Both: the documents one, which the older rule chose whenever ~/Documents existed.
    expect(ConversationFolders.builtin({ home: "/home/me", platform: "linux", isFolder: () => true })).toBe(
      "/home/me/Documents/Own OpenCode",
    )
    // Windows never looks: its default did not change.
    expect(ConversationFolders.builtin({ home: "C:\\Users\\me", platform: "win32", isFolder: () => true })).toBe(
      "C:\\Users\\me\\Documents\\Own OpenCode",
    )
  })

  test("without the option it follows core's home, so a test service never touches the real one", async () => {
    await using t = await testDeps()
    const home = process.env.OPENCODE_TEST_HOME || os.homedir()
    expect(ConversationFolders.defaultPath(t.deps).startsWith(home)).toBe(true)
    expect(path.basename(ConversationFolders.defaultPath(t.deps))).toBe(
      process.platform === "win32" || process.platform === "darwin" ? "Own OpenCode" : "own-chats",
    )
  })
})

describe("conversationFolder.*", () => {
  test("get names the default without creating it; ensure creates it once and announces it", async () => {
    await using r = await rig()
    expect(await ok(r.rpc["conversationFolder.get"], {})).toEqual({
      path: r.builtin,
      defaultPath: r.builtin,
      custom: false,
      exists: false,
    })
    expect(await exists(r.builtin)).toBe(false)
    const created = await ok(r.rpc["conversationFolder.ensure"], {})
    expect(created).toEqual({ path: r.builtin, defaultPath: r.builtin, custom: false, exists: true })
    expect(await exists(r.builtin)).toBe(true)
    // The write check leaves nothing behind.
    expect(await fs.readdir(r.builtin)).toEqual([])
    expect(r.events.map((event) => [event.name, event.payload.folder])).toEqual([
      ["conversationFolder.changed", created],
    ])
    // Nothing is stored for the default, and a second ensure changes nothing.
    expect(r.kv.values.size).toBe(0)
    expect(await ok(r.rpc["conversationFolder.ensure"], {})).toEqual(created)
    expect(r.events).toHaveLength(1)
  })

  test("set stores the user's folder (created now), reset goes back to the default", async () => {
    await using r = await rig()
    const chosen = path.join(r.root, "work", "chats")
    const saved = await ok(r.rpc["conversationFolder.set"], { path: `${chosen}${path.sep}` })
    expect(saved).toEqual({ path: chosen, defaultPath: r.builtin, custom: true, exists: true })
    expect(await exists(chosen)).toBe(true)
    expect(r.kv.values.get(Kv.conversationFolder)).toEqual({ path: chosen })
    expect(await ok(r.rpc["conversationFolder.get"], {})).toEqual(saved)
    // ensure uses the chosen folder and never creates the default.
    expect((await ok(r.rpc["conversationFolder.ensure"], {})).path).toBe(chosen)
    expect(await exists(r.builtin)).toBe(false)

    const reset = await ok(r.rpc["conversationFolder.set"], { path: null })
    expect(reset).toEqual({ path: r.builtin, defaultPath: r.builtin, custom: false, exists: false })
    expect(r.kv.values.has(Kv.conversationFolder)).toBe(false)
    // The chosen folder and what is in it stay where they are.
    expect(await exists(chosen)).toBe(true)
    expect(r.events.map((event) => (event.payload.folder as { custom: boolean }).custom)).toEqual([true, false])
  })

  test("~/… names a folder in the service user's home (an SSH host's own)", async () => {
    await using r = await rig()
    await using home = await testHome(r.root)
    const saved = await ok(r.rpc["conversationFolder.set"], { path: "~/projects/own-chats" })
    expect(saved).toMatchObject({ path: path.join(home.path, "projects", "own-chats"), custom: true, exists: true })
    expect(r.kv.values.get(Kv.conversationFolder)).toEqual({ path: path.join(home.path, "projects", "own-chats") })
    const refused = await call(r.rpc["conversationFolder.set"], { path: "~" })
    expect(refused).toMatchObject({ ok: false, data: { reason: "home", path: "~" } })
  })

  test("choosing the default itself stores nothing, so it keeps following the service's default", async () => {
    await using r = await rig()
    expect(await ok(r.rpc["conversationFolder.set"], { path: r.builtin })).toMatchObject({
      path: r.builtin,
      custom: false,
      exists: true,
    })
    expect(r.kv.values.size).toBe(0)
  })

  test("refuses folders that cannot hold conversations and stores nothing", async () => {
    await using r = await rig()
    const file = path.join(r.root, "a-file.txt")
    await Bun.write(file, "x")
    const home = process.env.OPENCODE_TEST_HOME || os.homedir()
    const refused = async (input: string) => {
      const result = await call(r.rpc["conversationFolder.set"], { path: input })
      return result.ok ? "stored" : [result.type, (result.data as { reason: string }).reason]
    }
    expect(await refused("chats")).toEqual(["conversation_folder_unavailable", "relative"])
    expect(await refused(path.parse(r.root).root)).toEqual(["conversation_folder_unavailable", "root"])
    expect(await refused(home)).toEqual(["conversation_folder_unavailable", "home"])
    expect(await refused(path.dirname(home))).toEqual(["conversation_folder_unavailable", "home"])
    // OWN_HOME (the app, the vault, the control folder), inside it and above it.
    const ownHome = r.t.deps.runtime.layout.root
    expect(await refused(ownHome)).toEqual(["conversation_folder_unavailable", "app"])
    expect(await refused(path.join(ownHome, "chats"))).toEqual(["conversation_folder_unavailable", "app"])
    expect(await refused(path.join(ownHome, "control"))).toEqual(["conversation_folder_unavailable", "app"])
    expect(await refused(path.dirname(process.execPath))).toEqual(["conversation_folder_unavailable", "app"])
    expect(await refused(file)).toEqual(["conversation_folder_unavailable", "not_folder"])
    expect(await refused(path.join(file, "below"))).toEqual(["conversation_folder_unavailable", "create_failed"])
    expect(r.kv.values.size).toBe(0)
    expect(r.events).toEqual([])
    expect(await ok(r.rpc["conversationFolder.get"], {})).toMatchObject({ path: r.builtin, custom: false })
  })

  test("ensure refuses a default that is a file and creates nothing", async () => {
    await using r = await rig()
    await fs.mkdir(path.dirname(r.builtin), { recursive: true })
    await Bun.write(r.builtin, "not a folder")
    const result = await call(r.rpc["conversationFolder.ensure"], {})
    expect(result).toMatchObject({
      ok: false,
      type: "conversation_folder_unavailable",
      data: { reason: "not_folder", path: r.builtin },
    })
    expect(r.events).toEqual([])
  })

  test("a stored folder that is no longer absolute reads as the default", async () => {
    await using r = await rig()
    r.kv.values.set(Kv.conversationFolder, { path: "relative\\chats" })
    expect(await ok(r.rpc["conversationFolder.get"], {})).toMatchObject({ path: r.builtin, custom: false })
    r.kv.values.set(Kv.conversationFolder, { other: true })
    expect(await ok(r.rpc["conversationFolder.get"], {})).toMatchObject({ path: r.builtin, custom: false })
  })

  test("every service answers for itself: an SSH host decides its own folder", () => {
    for (const method of [
      "conversationFolder.get",
      "conversationFolder.set",
      "conversationFolder.ensure",
      "folderPicker.get",
      "folderPicker.set",
      "folderPicker.list",
      "folderPicker.create",
    ])
      expect<readonly string[]>(Register.REMOTE_MANAGED).not.toContain(method)
  })
})

describe("folderPicker.*", () => {
  test("no choice by default: clients start at the last opened folder's parent, else the home folder", async () => {
    await using r = await rig()
    expect(await ok(r.rpc["folderPicker.get"], {})).toEqual({
      start: null,
      home: process.env.OPENCODE_TEST_HOME || os.homedir(),
    })
  })

  test("set keeps an existing folder (a drive root too), reset goes back, and both are announced", async () => {
    await using r = await rig()
    const projects = path.join(r.root, "projects")
    await fs.mkdir(projects)
    const chosen = await ok(r.rpc["folderPicker.set"], { start: `${projects}${path.sep}` })
    expect(chosen.start).toBe(projects)
    expect(r.kv.values.get(Kv.folderPicker)).toEqual({ start: projects })
    expect((await ok(r.rpc["folderPicker.get"], {})).start).toBe(projects)
    const drive = path.parse(r.root).root
    expect((await ok(r.rpc["folderPicker.set"], { start: drive })).start).toBe(drive)
    expect((await ok(r.rpc["folderPicker.set"], { start: null })).start).toBeNull()
    expect(r.kv.values.has(Kv.folderPicker)).toBe(false)
    expect(r.events.map((event) => [event.name, (event.payload.picker as { start: string | null }).start])).toEqual([
      ["folderPicker.changed", projects],
      ["folderPicker.changed", drive],
      ["folderPicker.changed", null],
    ])
  })

  test("refuses a relative path, a missing folder or a file, and creates nothing", async () => {
    await using r = await rig()
    const file = path.join(r.root, "a-file.txt")
    await Bun.write(file, "x")
    const missing = path.join(r.root, "nowhere")
    const reason = async (start: string) => {
      const result = await call(r.rpc["folderPicker.set"], { start })
      return result.ok ? "stored" : [result.type, (result.data as { reason: string }).reason]
    }
    expect(await reason("projects")).toEqual(["folder_picker_unavailable", "relative"])
    expect(await reason(missing)).toEqual(["folder_picker_unavailable", "missing"])
    expect(await reason(file)).toEqual(["folder_picker_unavailable", "not_folder"])
    expect(await exists(missing)).toBe(false)
    expect(r.kv.values.size).toBe(0)
    expect(r.events).toEqual([])
  })

  test("a stored start that is gone reads as no choice", async () => {
    await using r = await rig()
    r.kv.values.set(Kv.folderPicker, { start: path.join(r.root, "removed") })
    expect((await ok(r.rpc["folderPicker.get"], {})).start).toBeNull()
  })
})

const WINDOWS_ROOT = ["system volume information", "$recycle.bin", "$winreagent", "config.msi"]

describe("folderPicker.list", () => {
  test("folders only, a link to a folder included, each open", async () => {
    await using r = await rig()
    const top = path.join(r.root, "browse")
    await fs.mkdir(path.join(top, "alpha"), { recursive: true })
    await fs.mkdir(path.join(top, "한글 폴더"))
    await Bun.write(path.join(top, "notes.txt"), "x")
    const linked = await fs.symlink(path.join(top, "alpha"), path.join(top, "beta"), "junction").then(
      () => true,
      () => false,
    )
    await fs.symlink(path.join(top, "notes.txt"), path.join(top, "file-link")).catch(() => undefined)
    const view = await ok(r.rpc["folderPicker.list"], { path: `${top}${path.sep}` })
    expect(view.path).toBe(top)
    expect(view.hidden).toBe(0)
    expect(view.entries.map((entry) => entry.name).sort()).toEqual(
      ["alpha", "한글 폴더", ...(linked ? ["beta"] : [])].sort(),
    )
    expect(view.entries.every((entry) => !entry.locked)).toBe(true)
  })

  test("~ lists the service user's home", async () => {
    await using r = await rig()
    await using home = await testHome(r.root)
    await fs.mkdir(path.join(home.path, "projects"), { recursive: true })
    const view = await ok(r.rpc["folderPicker.list"], { path: "~" })
    expect(view.path).toBe(home.path)
    expect(view.entries.map((entry) => entry.name)).toContain("projects")
  })

  test("says why a folder cannot be listed: missing, a file, relative", async () => {
    await using r = await rig()
    const file = path.join(r.root, "a-file.txt")
    await Bun.write(file, "x")
    const reason = async (input: string) => {
      const result = await call(r.rpc["folderPicker.list"], { path: input })
      return result.ok ? "listed" : [result.type, (result.data as { reason: string }).reason]
    }
    expect(await reason(path.join(r.root, "nowhere"))).toEqual(["folder_list_unavailable", "missing"])
    expect(await reason(file)).toEqual(["folder_list_unavailable", "not_folder"])
    expect(await reason("projects")).toEqual(["folder_list_unavailable", "relative"])
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a folder without read permission is locked in its parent and denied with its owner when opened",
    async () => {
      await using r = await rig()
      const top = path.join(r.root, "perm")
      const closed = path.join(top, "closed")
      await fs.mkdir(closed, { recursive: true })
      await fs.chmod(closed, 0o000)
      try {
        const view = await ok(r.rpc["folderPicker.list"], { path: top })
        const me = os.userInfo().username
        expect(view.entries).toEqual([{ name: "closed", locked: true, owner: me }])
        const opened = await call(r.rpc["folderPicker.list"], { path: closed })
        expect(opened).toMatchObject({
          ok: false,
          type: "folder_list_unavailable",
          data: { reason: "denied", path: closed, owner: me },
        })
      } finally {
        await fs.chmod(closed, 0o755)
      }
    },
  )

  test.skipIf(process.platform !== "win32")("a drive root leaves out Windows' system folders", async () => {
    await using r = await rig()
    const drive = path.parse(r.root).root
    const names = (await fs.readdir(drive)).map((name) => name.toLowerCase())
    const view = await ok(r.rpc["folderPicker.list"], { path: drive })
    const listed = view.entries.map((entry) => entry.name.toLowerCase())
    for (const name of WINDOWS_ROOT) expect(listed).not.toContain(name)
    expect(view.hidden).toBe(names.filter((name) => WINDOWS_ROOT.includes(name)).length)
    // The same name below a drive root is an ordinary folder.
    await fs.mkdir(path.join(r.root, "Config.Msi"))
    const below = await ok(r.rpc["folderPicker.list"], { path: r.root })
    expect(below.entries.map((entry) => entry.name)).toContain("Config.Msi")
  })

  test.skipIf(process.platform === "win32")("lost+found is left out only at a filesystem root", async () => {
    await using r = await rig()
    // A temp folder is no mount point: its lost+found is an ordinary folder.
    await fs.mkdir(path.join(r.root, "lost+found"))
    const temp = await ok(r.rpc["folderPicker.list"], { path: r.root })
    expect(temp.entries.map((entry) => entry.name)).toContain("lost+found")
    const root = await ok(r.rpc["folderPicker.list"], { path: "/" })
    expect(root.entries.map((entry) => entry.name)).not.toContain("lost+found")
  })
})

describe("folderPicker.create", () => {
  test("makes one folder (a Korean name too) and refuses an existing one, naming it", async () => {
    await using r = await rig()
    const made = await ok(r.rpc["folderPicker.create"], { parent: r.root, name: "  새 프로젝트  " })
    expect(made.path).toBe(path.join(r.root, "새 프로젝트"))
    expect(await exists(made.path)).toBe(true)
    const again = await call(r.rpc["folderPicker.create"], { parent: r.root, name: "새 프로젝트" })
    expect(again).toMatchObject({
      ok: false,
      type: "folder_create_unavailable",
      data: { reason: "exists", path: made.path },
    })
    await Bun.write(path.join(r.root, "taken.txt"), "x")
    expect(await call(r.rpc["folderPicker.create"], { parent: r.root, name: "taken.txt" })).toMatchObject({
      ok: false,
      data: { reason: "exists" },
    })
  })

  test("refuses names that are not one folder name, and parents it cannot use", async () => {
    await using r = await rig()
    const reason = async (parent: string, name: string) => {
      const result = await call(r.rpc["folderPicker.create"], { parent, name })
      return result.ok ? "made" : (result.data as { reason: string }).reason
    }
    for (const name of ["   ", ".", "..", "a/b", "a\0b", "x".repeat(256), "가".repeat(86)])
      expect([name.slice(0, 8), await reason(r.root, name)]).toEqual([name.slice(0, 8), "name"])
    if (process.platform === "win32")
      for (const name of ["a\\b", "a:b", "con", "NUL.txt", "trail.", "what?"])
        expect([name, await reason(r.root, name)]).toEqual([name, "name"])
    expect(await reason("projects", "x")).toBe("relative")
    expect(await reason(path.join(r.root, "nowhere"), "x")).toBe("missing")
    await Bun.write(path.join(r.root, "a-file.txt"), "x")
    expect(await reason(path.join(r.root, "a-file.txt"), "x")).toBe("not_folder")
    expect(await fs.readdir(r.root)).toEqual(["a-file.txt"])
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a parent without write permission is denied",
    async () => {
      await using r = await rig()
      const closed = path.join(r.root, "read-only")
      await fs.mkdir(closed)
      await fs.chmod(closed, 0o555)
      try {
        expect(await call(r.rpc["folderPicker.create"], { parent: closed, name: "x" })).toMatchObject({
          ok: false,
          data: { reason: "denied" },
        })
      } finally {
        await fs.chmod(closed, 0o755)
      }
    },
  )
})

/** Core's home (`OPENCODE_TEST_HOME`) set to a folder of `root` for one test, so `~` never reaches the real home. */
async function testHome(root: string) {
  const before = process.env.OPENCODE_TEST_HOME
  const home = path.join(root, "home-of-test")
  await fs.mkdir(home, { recursive: true })
  process.env.OPENCODE_TEST_HOME = home
  return {
    path: home,
    async [Symbol.asyncDispose]() {
      if (before === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = before
    },
  }
}
