// Files units (03 §19.4, §19.5, §16.7, 04 §12.5): link and path forms, editor links and capability gating, content
// decisions (text, media, binary, large; same-origin media), the tree store against a fake `fs.list`, tabs, intents
// and strings.
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { HostCapabilities } from "@/host/types"
import { decodeFile, loadsDirect, MAX_TEXT_BYTES, mediaSource, readUrl, sameContent } from "./content"
import { editorPreference, fileActions, vscodeFileUrl, vscodeRemoteUrl } from "./editor"
import { openFile, pendingFile, QUICK_OPEN_INTENT, quickOpenRequests, requestQuickOpen, takeFile } from "./intents"
import { absolutePath, ancestors, basename, dirname, locate, normalizePath, parseLink } from "./paths"
import { filesEn, filesKo, filesText, formatBytes } from "./strings"
import { fileTabs } from "./tabs"
import { createTree, type ListedEntry } from "./tree"

describe("paths", () => {
  test("normalizes separators, trailing slashes and ./", () => {
    expect(normalizePath("src\\lib\\a.ts\\")).toBe("src/lib/a.ts")
    expect(normalizePath("./src//a.ts")).toBe("src/a.ts")
    expect(normalizePath("C:\\")).toBe("C:/")
    expect(normalizePath("/")).toBe("/")
    expect(normalizePath("\\\\server\\share\\a.ts")).toBe("//server/share/a.ts")
  })

  test("parses the links the agent writes", () => {
    expect(parseLink("src/router.ts:12")).toEqual({ path: "src/router.ts", line: 12 })
    expect(parseLink("src/router.ts:12:4")).toEqual({ path: "src/router.ts", line: 12 })
    expect(parseLink("src/router.ts#L40-L52")).toEqual({ path: "src/router.ts", line: 40 })
    expect(parseLink("`src/router.ts`")).toEqual({ path: "src/router.ts" })
    expect(parseLink("C:\\repo\\src\\a.ts:3")).toEqual({ path: "C:/repo/src/a.ts", line: 3 })
    expect(parseLink("file:///C:/repo/My%20Docs/a%23b.md")).toEqual({ path: "C:/repo/My Docs/a#b.md" })
    expect(parseLink("/home/u/repo/a.ts")).toEqual({ path: "/home/u/repo/a.ts" })
    expect(parseLink("router.ts:40")).toEqual({ path: "router.ts", line: 40 })
    expect(parseLink("문서/한글 메모.md")).toEqual({ path: "문서/한글 메모.md" })
    expect(parseLink("https://example.com/a.ts")).toBeUndefined()
    expect(parseLink("mailto:a@example.com")).toBeUndefined()
    expect(parseLink("  ")).toBeUndefined()
  })

  test("locates paths against the session folder (Windows compares case-insensitively)", () => {
    expect(locate("C:\\Repo", "c:/repo/src/a.ts")).toEqual({ path: "src/a.ts", inside: true })
    expect(locate("C:\\Repo", "D:/other/a.ts")).toEqual({ path: "D:/other/a.ts", inside: false })
    expect(locate("/home/u/repo", "/home/u/Repo/a.ts")).toEqual({ path: "/home/u/Repo/a.ts", inside: false })
    expect(locate("/home/u/repo", "/home/u/repo/a.ts")).toEqual({ path: "a.ts", inside: true })
    expect(locate("/home/u/repo", "../README.md", "docs")).toEqual({ path: "README.md", inside: true })
    expect(locate("/home/u/repo", "../../x.md", "docs")).toEqual({ path: "/home/u/x.md", inside: false })
    expect(locate("C:\\Repo", "./src/../a.ts")).toEqual({ path: "a.ts", inside: true })
  })

  test("absolute paths use the folder's separators", () => {
    expect(absolutePath("C:\\Repo", "src/a.ts")).toBe("C:\\Repo\\src\\a.ts")
    expect(absolutePath("/home/u/repo", "src/a.ts")).toBe("/home/u/repo/src/a.ts")
    expect(absolutePath("C:\\Repo", "D:/other/a.ts")).toBe("D:\\other\\a.ts")
  })

  test("names, parents and ancestors", () => {
    expect(basename("src/lib/a.ts")).toBe("a.ts")
    expect(dirname("src/lib/a.ts")).toBe("src/lib")
    expect(dirname("a.ts")).toBe("")
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"])
  })
})

const capabilities = (openInApp: boolean): HostCapabilities => ({
  windowControlsOverlay: false,
  nativeDirectoryPicker: openInApp,
  nativeFilePaths: openInApp,
  openInApp,
  clipboardImage: false,
  saveDialog: false,
  osNotifications: "none",
  browserPane: false,
  serviceControl: false,
  multiWindow: false,
  keepScreenAwake: false,
  touch: false,
  offlineCatalog: false,
})

describe("editor and Explorer (19.5)", () => {
  test("vscode:// links encode segments and keep drive letters", () => {
    expect(vscodeFileUrl("C:\\Repo\\My Docs\\a#b.ts", 12)).toBe("vscode://file/C:/Repo/My%20Docs/a%23b.ts:12")
    expect(vscodeFileUrl("/home/u/repo/한글.md")).toBe("vscode://file/home/u/repo/%ED%95%9C%EA%B8%80.md")
    expect(vscodeRemoteUrl("dev box", "/home/u/repo/a.ts", 3)).toBe(
      "vscode://vscode-remote/ssh-remote+dev%20box/home/u/repo/a.ts:3",
    )
  })

  test("desktop + local server: the host opens and reveals", () => {
    const actions = fileActions({ capabilities: capabilities(true), server: "local", openPath: true, revealPath: true })
    expect(actions).toEqual({ open: { kind: "app" }, reveal: true })
  })

  test("web: a vscode:// link, never reveal; a paired device gets neither", () => {
    const web = fileActions({
      capabilities: capabilities(false),
      server: "local",
      auth: "cookie",
      openPath: false,
      revealPath: false,
    })
    expect(web.reveal).toBe(false)
    expect(web.open?.kind === "url" && web.open.url("C:\\r\\a.ts", 2)).toBe("vscode://file/C:/r/a.ts:2")
    const device = fileActions({
      capabilities: capabilities(false),
      server: "local",
      auth: "device",
      openPath: false,
      revealPath: false,
    })
    expect(device).toEqual({ reveal: false })
  })

  test("SSH: vscode-remote with the ssh config alias, local actions hidden (04 §12.5)", () => {
    // The desktop's openInApp is already off for SSH sessions (servers/capabilities.ts); even if not, SSH wins.
    const ssh = fileActions({
      capabilities: capabilities(true),
      server: "ssh",
      openPath: true,
      revealPath: true,
      alias: "devbox",
    })
    expect(ssh.reveal).toBe(false)
    expect(ssh.open?.kind === "url" && ssh.open.url("/srv/app/a.ts", 7)).toBe(
      "vscode://vscode-remote/ssh-remote+devbox/srv/app/a.ts:7",
    )
    expect(
      fileActions({
        capabilities: capabilities(false),
        server: "ssh",
        openPath: false,
        revealPath: false,
        alias: null,
      }),
    ).toEqual({
      open: undefined,
      reveal: false,
    })
  })

  test("with the desktop app's explorer: reveal on a local server and on an SSH server; never on a device", () => {
    // SSH: the user's SSH file explorer program, also before one is chosen (the click then explains).
    const ssh = fileActions({
      capabilities: capabilities(false),
      server: "ssh",
      openPath: true,
      revealPath: true,
      alias: null,
      explorer: true,
    })
    expect(ssh).toEqual({ open: undefined, reveal: true })
    const local = fileActions({
      capabilities: capabilities(true),
      server: "local",
      openPath: true,
      revealPath: false,
      explorer: true,
    })
    expect(local).toEqual({ open: { kind: "app" }, reveal: true })
    // A phone or a 원격 PC window has no explorer at all; even if it had, its paths are the PC's.
    const device = fileActions({
      capabilities: capabilities(false),
      server: "local",
      auth: "device",
      openPath: false,
      revealPath: false,
    })
    expect(device).toEqual({ reveal: false })
    const browser = fileActions({
      capabilities: capabilities(false),
      server: "local",
      auth: "cookie",
      openPath: false,
      revealPath: false,
    })
    expect(browser.reveal).toBe(false)
  })

  test("the editor preference defaults to code and survives blank input", () => {
    expect(editorPreference.get()).toBe("code")
    editorPreference.set("cursor")
    expect(editorPreference.get()).toBe("cursor")
    editorPreference.set("  ")
    expect(editorPreference.get()).toBe("code")
  })
})

describe("content", () => {
  const encode = (text: string) => new TextEncoder().encode(text)

  test("text, markdown and svg decode; NUL bytes mark binaries; fonts are binary", () => {
    expect(decodeFile("src/a.ts", encode("const a = 1\n"))).toEqual({
      type: "text",
      kind: "text",
      text: "const a = 1\n",
      bytes: 12,
    })
    expect(decodeFile("README.md", encode("# 제목"))).toMatchObject({ type: "text", kind: "markdown" })
    expect(decodeFile("docs/flow.mmd", encode("flowchart LR"))).toMatchObject({ type: "text", kind: "mermaid" })
    expect(decodeFile("a.svg", encode("<svg/>"))).toMatchObject({ type: "text", kind: "svg" })
    expect(decodeFile("data.bin", new Uint8Array([1, 0, 2]))).toEqual({ type: "binary", bytes: 3 })
    expect(decodeFile("font.woff2", new Uint8Array([1, 2]))).toEqual({ type: "binary", bytes: 2 })
  })

  test("media become Blobs with the extension's type; large text waits for 그래도 보기", () => {
    const png = decodeFile("a.png", new Uint8Array([137, 80, 78, 71]))
    expect(png.type === "media" && png.blob.type).toBe("image/png")
    const pdf = decodeFile("doc.pdf", new Uint8Array([37, 80, 68, 70]))
    expect(pdf.type === "media" && pdf.blob.type).toBe("application/pdf")
    const big = new Uint8Array(MAX_TEXT_BYTES + 1).fill(97)
    expect(decodeFile("big.log", big)).toEqual({ type: "large", kind: "text", bytes: MAX_TEXT_BYTES + 1 })
    expect(decodeFile("big.log", big, true)).toMatchObject({ type: "text" })
  })

  test("a re-read with the same bytes keeps the viewer", () => {
    const a = decodeFile("a.ts", encode("x"))
    expect(sameContent(a, decodeFile("a.ts", encode("x")))).toBe(true)
    expect(sameContent(a, decodeFile("a.ts", encode("y")))).toBe(false)
    const image = decodeFile("a.png", new Uint8Array([1, 2, 3]))
    expect(sameContent(image, decodeFile("a.png", new Uint8Array([1, 2, 3])))).toBe(true)
    expect(sameContent(image, decodeFile("a.png", new Uint8Array([1, 2, 4])))).toBe(false)
  })

  test("media load from the server URL only on the same origin without auth headers", () => {
    expect(mediaSource({ baseUrl: "http://127.0.0.1:5173" }, "http://127.0.0.1:5173")).toBe("direct")
    expect(mediaSource({ baseUrl: "http://127.0.0.1:4096" }, "oc://renderer")).toBe("blob")
    expect(mediaSource({ baseUrl: "http://127.0.0.1:5173", headers: () => ({}) }, "http://127.0.0.1:5173")).toBe("blob")
    expect(mediaSource(undefined, "http://127.0.0.1:5173")).toBe("blob")
  })

  test("a PDF is never loaded from the server URL: fs.read answers as a download (upstream v2.2.6)", () => {
    expect(["image", "audio", "video"].every((kind) => loadsDirect(kind as "image"))).toBe(true)
    expect(loadsDirect("pdf")).toBe(false)
    expect(loadsDirect("markdown")).toBe(false)
    expect(loadsDirect("binary")).toBe(false)
  })

  test("readUrl matches the generated client (path segments, location query, base path prefix)", () => {
    expect(readUrl("https://pc.example.test/srv/local", "C:\\Repo", "docs/한글 #1.pdf")).toBe(
      "https://pc.example.test/srv/local/api/fs/read/docs/%ED%95%9C%EA%B8%80%20%231.pdf?location%5Bdirectory%5D=C%3A%5CRepo",
    )
  })
})

describe("tree", () => {
  const folders: Record<string, ListedEntry[]> = {
    "": [
      { path: ".git\\", type: "directory" },
      { path: "src\\", type: "directory" },
      { path: "README.md", type: "file" },
    ],
    src: [
      { path: "src\\lib\\", type: "directory" },
      { path: "src\\a.ts", type: "file" },
    ],
    "src/lib": [{ path: "src\\lib\\b.ts", type: "file" }],
  }

  function make(list = folders) {
    const calls: string[] = []
    return createRoot((dispose) => {
      const tree = createTree(async (folder) => {
        calls.push(folder)
        const entries = list[folder]
        if (!entries) throw new Error("gone")
        return entries
      })
      return { tree, calls, dispose }
    })
  }

  test("lists the root, hides .git, expands folders and flattens rows", async () => {
    const { tree, dispose } = make()
    await tree.load("")
    expect(tree.rows().map((row) => row.node.path)).toEqual(["src", "README.md"])
    await tree.expand("src")
    expect(tree.rows().map((row) => [row.node.path, row.level])).toEqual([
      ["src", 0],
      ["src/lib", 1],
      ["src/a.ts", 1],
      ["README.md", 0],
    ])
    expect(tree.typeOf("src/lib")).toBe("directory")
    expect(tree.typeOf("src/a.ts")).toBe("file")
    expect(tree.typeOf("src/zzz.ts")).toBeUndefined()
    dispose()
  })

  test("reveal expands every ancestor in order", async () => {
    const { tree, calls, dispose } = make()
    await tree.reveal("src/lib/b.ts")
    expect(calls).toEqual(["", "src", "src/lib"])
    expect(tree.rows().some((row) => row.node.path === "src/lib/b.ts")).toBe(true)
    dispose()
  })

  test("refresh lists visible folders again and forgets hidden ones", async () => {
    const live = structuredClone(folders)
    const { tree, calls, dispose } = make(live)
    await tree.reveal("src/lib/b.ts")
    tree.collapse("src/lib")
    live.src = [...live.src!, { path: "src\\new.ts", type: "file" }]
    calls.length = 0
    await tree.refresh()
    expect(calls.toSorted()).toEqual(["", "src"])
    expect(tree.state.children["src/lib"]).toBeUndefined()
    expect(tree.rows().map((row) => row.node.path)).toContain("src/new.ts")
    dispose()
  })

  test("a folder that disappeared is dropped on refresh", async () => {
    const live = structuredClone(folders)
    const { tree, dispose } = make(live)
    await tree.load("")
    await tree.expand("src")
    delete live.src
    live[""] = [{ path: "README.md", type: "file" }]
    await tree.refresh()
    expect(tree.rows().map((row) => row.node.path)).toEqual(["README.md"])
    expect(tree.state.errors.src).toBeUndefined()
    dispose()
  })

  test("a failing root shows its error", async () => {
    const { tree, dispose } = make({})
    await tree.load("")
    expect(tree.state.errors[""]).toBe("gone")
    dispose()
  })
})

describe("tabs", () => {
  test("open, re-open with a line, activate, move and close", () => {
    const key = `local\nses_tabs_${Math.random()}`
    fileTabs.open(key, "a.ts")
    fileTabs.open(key, "b.ts", 4)
    expect(fileTabs.get(key).tabs.map((tab) => tab.path)).toEqual(["a.ts", "b.ts"])
    expect(fileTabs.get(key).active).toBe("b.ts")
    fileTabs.open(key, "b.ts", 9)
    expect(fileTabs.get(key).tabs[1]).toMatchObject({ path: "b.ts", line: 9, jump: 2 })
    fileTabs.activate(key, "a.ts")
    expect(fileTabs.get(key).active).toBe("a.ts")
    fileTabs.move(key, "a.ts", 1)
    expect(fileTabs.get(key).tabs.map((tab) => tab.path)).toEqual(["b.ts", "a.ts"])
    fileTabs.close(key, "a.ts")
    expect(fileTabs.get(key).active).toBe("b.ts")
    expect(fileTabs.get(key).recent).toEqual(["b.ts", "a.ts"])
  })

  test("at most 12 tabs: the oldest closes", () => {
    const key = `local\nses_many_${Math.random()}`
    for (let index = 0; index < 14; index++) fileTabs.open(key, `f${index}.ts`)
    const paths = fileTabs.get(key).tabs.map((tab) => tab.path)
    expect(paths).toHaveLength(12)
    expect(paths[0]).toBe("f2.ts")
    expect(fileTabs.get(key).active).toBe("f13.ts")
  })
})

describe("intents", () => {
  test("open-file requests wait until the tab takes them; quick open counts requests", () => {
    const events: string[] = []
    const listen = (event: Event) => events.push(event.type)
    window.addEventListener("own:open-file", listen)
    window.addEventListener(QUICK_OPEN_INTENT, listen)
    openFile({ serverKey: "local", sessionID: "ses_a", path: "src/a.ts:3" })
    const request = pendingFile()
    expect(request).toMatchObject({ sessionID: "ses_a", path: "src/a.ts:3" })
    takeFile(request!.seq + 1)
    expect(pendingFile()).toBeDefined()
    takeFile(request!.seq)
    expect(pendingFile()).toBeUndefined()
    const before = quickOpenRequests()
    requestQuickOpen()
    expect(quickOpenRequests()).toBe(before + 1)
    expect(events).toEqual(["own:open-file", "own:quick-open"])
    window.removeEventListener("own:open-file", listen)
    window.removeEventListener(QUICK_OPEN_INTENT, listen)
  })
})

describe("strings", () => {
  test("every key has English; particles resolve in Korean", () => {
    expect(Object.keys(filesKo).filter((key) => !(key in filesEn))).toEqual([])
    expect(filesText("ko", "own.files.close", { name: "router.ts" })).toBe("router.ts 닫기")
    expect(filesText("en", "own.files.line", { line: 4 })).toBe("Line 4")
    expect(formatBytes("en", 1536)).toBe("1.5 kB")
  })
})
