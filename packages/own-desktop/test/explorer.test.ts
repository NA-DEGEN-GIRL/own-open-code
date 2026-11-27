// `탐색기에서 열기` / `탐색기에서 보기` (05 §7.10): the argument template, the open-folder check, main's decisions
// with stand-ins for Electron and the service, and one real start of a console stand-in that writes down the
// arguments it got. Nothing here opens Explorer or starts the user's program: `openFolder`, `showItem` and `pick` are
// always stand-ins, and the only process started is this test's own Bun.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createExplorer,
  EXPLORER_KEY,
  launchDetached,
  launchFailure,
  pathKind,
  serviceRoots,
  type ExplorerDeps,
  type Launched,
} from "../src/main/explorer"
import {
  DEFAULT_TEMPLATE,
  expandTemplate,
  insideRoots,
  programFile,
  remotePath,
  sshHost,
  storedProgram,
  templateProblem,
  templateTokens,
  TEMPLATE_MAX,
} from "../src/shared/explorer"

const here = path.resolve(import.meta.dir, "..")
const code = async (file: string) =>
  (await Bun.file(path.join(here, file)).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const scratch = mkdtempSync(path.join(os.tmpdir(), "own-explorer-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("argument template", () => {
  const args = (template: string, host: string, remote: string) => {
    const expanded = expandTemplate(template, { host, path: remote })
    if (!expanded.ok) throw new Error(`${expanded.reason}: ${expanded.detail}`)
    return expanded.args
  }

  test("the default is ssh-explorer's contract: --open <host> <remote-path>", () => {
    expect(DEFAULT_TEMPLATE).toBe("--open {host} {path}")
    expect(args(DEFAULT_TEMPLATE, "devbox", "/home/dev/app")).toEqual(["--open", "devbox", "/home/dev/app"])
    expect(args(DEFAULT_TEMPLATE, "dev@build.example", "/srv/app/main.rs")).toEqual([
      "--open",
      "dev@build.example",
      "/srv/app/main.rs",
    ])
  })

  test("a placeholder is exactly one argument, whatever the remote name holds", () => {
    const names = [
      "/home/dev/my project/read me.txt",
      '/home/dev/say "hi".txt',
      "/home/dev/it's here",
      "/home/dev/a&calc.exe",
      "/home/dev/a && calc.exe",
      "/home/dev/a | b > c < d",
      "/home/dev/%PATH%/%USERPROFILE%.txt",
      "/home/dev/$HOME/`id`/$(id)",
      "/home/dev/^caret!bang",
      "/home/dev/ --open evil /etc",
      "/home/dev/-rf",
      "/home/dev/한글 폴더/새 파일.txt",
      "/home/dev/日本語/🙂.md",
      "/home/dev/e\u0301-combining",
      "/home/dev/tab\there",
      "/home/dev/line\nbreak",
      "/home/dev/trailing space ",
      "/home/dev/back\\slash\\",
    ]
    for (const name of names) expect(args(DEFAULT_TEMPLATE, "devbox", name)).toEqual(["--open", "devbox", name])
  })

  test("names Windows would refuse or read specially pass as they are (they are remote names)", () => {
    const names = [
      '/home/dev/a:b*c?d<e>f|g"h.txt',
      "/home/dev/CON",
      "/home/dev/NUL.txt",
      "/home/dev/COM1",
      "/home/dev/name.",
      "/home/dev/name ",
      "/home/dev/C:\\Windows\\System32",
      "/home/dev/\\\\server\\share",
    ]
    for (const name of names) expect(args(DEFAULT_TEMPLATE, "devbox", name)).toEqual(["--open", "devbox", name])
  })

  test("a value is never read again: placeholder text inside a name stays text", () => {
    expect(args(DEFAULT_TEMPLATE, "devbox", "/srv/{host}/{path}/{other}")).toEqual([
      "--open",
      "devbox",
      "/srv/{host}/{path}/{other}",
    ])
    expect(args("{path} {host}", "devbox", "/a/{host}")).toEqual(["/a/{host}", "devbox"])
  })

  test("placeholders inside a larger token stay in that one argument", () => {
    expect(args("sftp://{host}{path}", "dev@box", "/srv/my app")).toEqual(["sftp://dev@box/srv/my app"])
    expect(args("--target={host}:{path} --new-window", "devbox", "/a b")).toEqual([
      "--target=devbox:/a b",
      "--new-window",
    ])
    expect(args("{path} {path}", "devbox", "/x y")).toEqual(["/x y", "/x y"])
  })

  test("quotes in the template keep whitespace in one token; a backslash is a path character", () => {
    expect(templateTokens('--title "my host" {path}')).toEqual(["--title", "my host", "{path}"])
    expect(templateTokens('--profile="C:\\Program Files\\x y" {path}')).toEqual([
      "--profile=C:\\Program Files\\x y",
      "{path}",
    ])
    expect(templateTokens('a "" b')).toEqual(["a", "", "b"])
    expect(templateTokens("  a \t b\n")).toEqual(["a", "b"])
    expect(templateTokens("")).toEqual([])
    expect(templateTokens('--open "{host} {path}')).toBeUndefined()
    expect(args('"{host} {path}"', "devbox", "/a")).toEqual(["devbox /a"])
  })

  test("a host that starts with - or holds anything but an ssh destination is refused", () => {
    for (const host of [
      "-oProxyCommand=calc.exe",
      "-v",
      "--open",
      "dev box",
      "dev;calc",
      "dev&calc",
      '"dev"',
      "",
      "a".repeat(256),
    ])
      expect(expandTemplate(DEFAULT_TEMPLATE, { host, path: "/a" })).toMatchObject({ ok: false, reason: "host" })
    for (const host of ["devbox", "dev@box", "dev_1@build-2.example.org", "dev@[fe80::1%eth0]", "dev@10.0.0.5:2222"])
      expect(sshHost(host)).toBe(true)
  })

  test("a remote path must be absolute, so it can never read as an option", () => {
    for (const remote of ["-rf", "--open", "relative/a", "~/a", "", "C:\\Users", "/a\0b", `/${"a".repeat(4096)}`])
      expect(expandTemplate(DEFAULT_TEMPLATE, { host: "devbox", path: remote })).toMatchObject({
        ok: false,
        reason: "path",
      })
    expect(remotePath("/")).toBe(true)
  })

  test("a template needs {path}, knows only {host} and {path}, and has a length limit", () => {
    expect(templateProblem(DEFAULT_TEMPLATE)).toBeUndefined()
    expect(templateProblem("{path}")).toBeUndefined()
    expect(templateProblem("--open {host}")).toBe("no {path}")
    expect(templateProblem("")).toBe("no {path}")
    expect(templateProblem("--open {hsot} {path}")).toBe("unknown placeholder {hsot}")
    expect(templateProblem("--open {host} {path} {port}")).toBe("unknown placeholder {port}")
    expect(templateProblem('--open "{host} {path}')).toBe('a " that never closes')
    expect(templateProblem(`{path} ${"x".repeat(TEMPLATE_MAX)}`)).toContain("longer than")
    // Braces that are not a name are plain text.
    expect(args("--json={} {path} {0}", "devbox", "/a")).toEqual(["--json={}", "/a", "{0}"])
    expect(expandTemplate("--open {host}", { host: "devbox", path: "/a" })).toMatchObject({
      ok: false,
      reason: "template",
    })
  })
})

describe("open-folder check", () => {
  const roots = ["D:/projects/app", "C:\\Users\\dev\\work tree", "\\\\nas\\share\\repo"]
  const inside = (target: string) => insideRoots(roots, target, "win32")

  test("a root and everything under it, whatever the case or the separators", () => {
    expect(inside("D:\\projects\\app")).toBe(true)
    expect(inside("D:\\projects\\app\\")).toBe(true)
    expect(inside("d:/PROJECTS/App/src/main.ts")).toBe(true)
    expect(inside("D:\\projects\\app\\한글 폴더\\새 파일.txt")).toBe(true)
    expect(inside("C:\\Users\\dev\\work tree\\a b\\c.txt")).toBe(true)
    expect(inside("\\\\nas\\share\\repo\\src")).toBe(true)
    expect(inside("D:\\projects\\app\\src\\..\\lib\\a.ts")).toBe(true)
  })

  test("nothing outside: siblings, parents, .. climbs, other drives", () => {
    expect(inside("D:\\projects\\app2\\a.ts")).toBe(false)
    expect(inside("D:\\projects\\app.bak")).toBe(false)
    expect(inside("D:\\projects")).toBe(false)
    expect(inside("D:\\")).toBe(false)
    expect(inside("D:\\projects\\app\\..\\secret.txt")).toBe(false)
    expect(inside("D:\\projects\\app\\..\\..\\Windows\\System32\\calc.exe")).toBe(false)
    expect(inside("D:/projects/app/../../x")).toBe(false)
    expect(inside("E:\\projects\\app\\a.ts")).toBe(false)
    expect(inside("C:\\Windows\\System32\\cmd.exe")).toBe(false)
    expect(inside("\\\\nas\\share\\other")).toBe(false)
    expect(inside("\\\\nas\\share2\\repo")).toBe(false)
  })

  test("never a relative, drive-less or device path, and never with no open folder", () => {
    for (const target of [
      "",
      "src\\a.ts",
      "..\\a.ts",
      "\\projects\\app\\a.ts",
      "D:projects\\app\\a.ts",
      "\\\\?\\D:\\projects\\app\\a.ts",
      "\\\\.\\D:\\projects\\app\\a.ts",
      "file:///D:/projects/app/a.ts",
      "D:\\projects\\app\\a\0.ts",
    ])
      expect(inside(target)).toBe(false)
    expect(insideRoots([], "D:\\projects\\app", "win32")).toBe(false)
    expect(insideRoots(["", "app", "\\\\?\\D:\\projects\\app"], "D:\\projects\\app\\a.ts", "win32")).toBe(false)
  })

  test("a whole drive opened as a project covers that drive only", () => {
    expect(insideRoots(["E:\\"], "E:\\any\\where.txt", "win32")).toBe(true)
    expect(insideRoots(["E:/"], "e:\\", "win32")).toBe(true)
    expect(insideRoots(["E:\\"], "C:\\Windows", "win32")).toBe(false)
  })

  test("other systems compare with case", () => {
    expect(insideRoots(["/home/dev/app"], "/home/dev/app/src/a.ts", "linux")).toBe(true)
    expect(insideRoots(["/home/dev/app"], "/home/dev/App/src/a.ts", "linux")).toBe(false)
    expect(insideRoots(["/home/dev/app"], "/home/dev/app/../.ssh/id", "linux")).toBe(false)
    expect(insideRoots(["/home/dev/app"], "home/dev/app", "linux")).toBe(false)
  })
})

describe("the program", () => {
  test("only an absolute path to an .exe: never a script cmd.exe would run", () => {
    expect(programFile("D:\\projects\\ssh-explorer\\dist\\SSH-Explorer\\ssh-explorer.exe", "win32")).toBe(true)
    expect(programFile("C:/Tools/WinSCP.EXE", "win32")).toBe(true)
    for (const value of [
      "ssh-explorer.exe",
      ".\\ssh-explorer.exe",
      "C:\\Tools\\run.cmd",
      "C:\\Tools\\run.bat",
      "C:\\Tools\\run.ps1",
      "C:\\Tools\\run.exe.lnk",
      "C:\\Tools\\run",
      "\\\\?\\C:\\Tools\\run.exe",
      "C:\\Tools\\run.exe\0.txt",
      "",
    ])
      expect(programFile(value, "win32")).toBe(false)
  })

  test("the stored value is read back strictly; anything else is the default with no program", () => {
    expect(storedProgram(undefined, "win32")).toEqual({ template: DEFAULT_TEMPLATE })
    expect(storedProgram("C:\\x.exe", "win32")).toEqual({ template: DEFAULT_TEMPLATE })
    expect(storedProgram({ program: "C:\\Tools\\x.exe", template: "{path}" }, "win32")).toEqual({
      program: "C:\\Tools\\x.exe",
      template: "{path}",
    })
    expect(storedProgram({ program: "C:\\Tools\\x.cmd", template: "--open {host}" }, "win32")).toEqual({
      template: DEFAULT_TEMPLATE,
    })
    expect(storedProgram({ program: 5, template: 7 }, "win32")).toEqual({ template: DEFAULT_TEMPLATE })
  })
})

interface Stand {
  readonly calls: string[][]
  readonly deps: ExplorerDeps
  stored: unknown
}

function stand(options: {
  readonly roots?: readonly string[] | "down"
  readonly kinds?: Readonly<Record<string, "directory" | "file">>
  readonly stored?: unknown
  readonly launched?: Launched
  readonly picked?: string
  readonly openFailure?: string
}): Stand {
  const calls: string[][] = []
  const state: Stand = {
    calls,
    stored: options.stored,
    deps: {
      roots: async () => (options.roots === "down" ? undefined : (options.roots ?? [])),
      kind: async (target) => options.kinds?.[target],
      openFolder: async (folder) => {
        calls.push(["openFolder", folder])
        return options.openFailure ?? ""
      },
      showItem: (file) => void calls.push(["showItem", file]),
      launch: async (program, args) => {
        calls.push(["launch", program, ...args])
        return options.launched ?? { ok: true }
      },
      pick: async (window, current) => {
        calls.push(["pick", String(window), current ?? ""])
        return options.picked
      },
      read: () => state.stored,
      write: (value) => {
        state.stored = value
      },
      log: () => undefined,
    },
  }
  return state
}

// Windows paths: these decisions are the Windows shell's.
describe.skipIf(process.platform !== "win32")("reveal on this PC", () => {
  const roots = ["D:/projects/app", "D:/worktrees/app-feature"]
  const kinds = {
    "D:\\projects\\app": "directory",
    "D:\\projects\\app\\src": "directory",
    "D:\\projects\\app\\src\\main.ts": "file",
    "D:\\projects\\app\\run me.exe": "file",
    "D:\\worktrees\\app-feature": "directory",
    "C:\\Windows\\System32\\calc.exe": "file",
    "C:\\Windows": "directory",
  } as const

  test("a folder opens in Explorer; a worktree folder is an open folder too", async () => {
    const world = stand({ roots, kinds })
    const explorer = createExplorer(world.deps)
    expect(await explorer.reveal("D:\\projects\\app")).toEqual({ ok: true })
    expect(await explorer.reveal("D:/projects/app/src")).toEqual({ ok: true })
    expect(await explorer.reveal("D:\\worktrees\\app-feature")).toEqual({ ok: true })
    expect(world.calls).toEqual([
      ["openFolder", "D:\\projects\\app"],
      ["openFolder", "D:\\projects\\app\\src"],
      ["openFolder", "D:\\worktrees\\app-feature"],
    ])
  })

  test("a file is only ever shown in its folder, never opened: also a program", async () => {
    const world = stand({ roots, kinds })
    const explorer = createExplorer(world.deps)
    expect(await explorer.reveal("D:\\projects\\app\\src\\main.ts")).toEqual({ ok: true })
    expect(await explorer.reveal("D:\\projects\\app\\run me.exe")).toEqual({ ok: true })
    expect(world.calls).toEqual([
      ["showItem", "D:\\projects\\app\\src\\main.ts"],
      ["showItem", "D:\\projects\\app\\run me.exe"],
    ])
  })

  test("outside the open folders nothing is opened or shown, whatever exists there", async () => {
    const world = stand({ roots, kinds })
    const explorer = createExplorer(world.deps)
    for (const target of [
      "C:\\Windows\\System32\\calc.exe",
      "C:\\Windows",
      "D:\\projects\\app\\..\\..\\Windows",
      "D:\\projects",
      "src\\main.ts",
      "\\\\?\\D:\\projects\\app",
    ])
      expect(await explorer.reveal(target)).toEqual({ ok: false, reason: "outside" })
    expect(world.calls).toEqual([])
  })

  test("a path that is gone, a service that does not answer and a failed open say so", async () => {
    const gone = stand({ roots, kinds })
    expect(await createExplorer(gone.deps).reveal("D:\\projects\\app\\deleted.ts")).toEqual({
      ok: false,
      reason: "missing",
    })
    expect(gone.calls).toEqual([])
    const down = stand({ roots: "down", kinds })
    expect(await createExplorer(down.deps).reveal("D:\\projects\\app")).toEqual({ ok: false, reason: "service" })
    expect(down.calls).toEqual([])
    const failing = stand({ roots, kinds, openFailure: "Failed to open path" })
    expect(await createExplorer(failing.deps).reveal("D:\\projects\\app")).toEqual({
      ok: false,
      reason: "failed",
      detail: "Failed to open path",
    })
  })
})

describe.skipIf(process.platform !== "win32")("launch for an SSH host", () => {
  const program = "D:\\tools\\ssh-explorer.exe"
  const kinds = { [program]: "file" } as const

  test("no program chosen: nothing starts", async () => {
    const world = stand({ kinds })
    expect(await createExplorer(world.deps).launch({ host: "devbox", path: "/home/dev/app" })).toEqual({
      ok: false,
      reason: "unconfigured",
    })
    expect(world.calls).toEqual([])
  })

  test("the chosen program gets the template's arguments as a list", async () => {
    const world = stand({ kinds, stored: { program, template: DEFAULT_TEMPLATE } })
    const explorer = createExplorer(world.deps)
    expect(await explorer.launch({ host: "devbox", path: '/home/dev/my app/a "b" & c.txt' })).toEqual({ ok: true })
    expect(world.calls).toEqual([["launch", program, "--open", "devbox", '/home/dev/my app/a "b" & c.txt']])
  })

  test("a refused host, path or template starts nothing", async () => {
    const world = stand({ kinds, stored: { program, template: DEFAULT_TEMPLATE } })
    const explorer = createExplorer(world.deps)
    expect(await explorer.launch({ host: "-oProxyCommand=calc", path: "/a" })).toMatchObject({
      ok: false,
      reason: "host",
    })
    expect(await explorer.launch({ host: "devbox", path: "-rf" })).toMatchObject({ ok: false, reason: "path" })
    expect(world.calls).toEqual([])
  })

  test("a program that is gone, and what Windows answers when it refuses one", async () => {
    const gone = stand({ stored: { program, template: DEFAULT_TEMPLATE } })
    expect(await createExplorer(gone.deps).launch({ host: "devbox", path: "/a" })).toEqual({
      ok: false,
      reason: "program",
      detail: program,
    })
    expect(gone.calls).toEqual([])
    const blocked = stand({
      kinds,
      stored: { program, template: DEFAULT_TEMPLATE },
      launched: { ok: false, code: "UNKNOWN", message: "spawn UNKNOWN" },
    })
    expect(await createExplorer(blocked.deps).launch({ host: "devbox", path: "/a" })).toEqual({
      ok: false,
      reason: "blocked",
      detail: "UNKNOWN: spawn UNKNOWN",
    })
    // One try: a refusal is reported, never worked around.
    expect(blocked.calls).toHaveLength(1)
    expect(launchFailure("UNKNOWN")).toBe("blocked")
    expect(launchFailure("EACCES")).toBe("blocked")
    expect(launchFailure("EPERM")).toBe("blocked")
    expect(launchFailure("ENOENT")).toBe("program")
    expect(launchFailure("EINVAL")).toBe("failed")
  })

  test("the program comes from the dialog alone, and only an .exe is kept", async () => {
    const world = stand({ picked: program })
    const explorer = createExplorer(world.deps)
    expect(explorer.program()).toEqual({ template: DEFAULT_TEMPLATE })
    expect(await explorer.pick(7)).toEqual({ program, template: DEFAULT_TEMPLATE })
    expect(world.stored).toEqual({ program, template: DEFAULT_TEMPLATE })
    expect(world.calls).toEqual([["pick", "7", ""]])
    const script = stand({ picked: "D:\\tools\\run.cmd", stored: { program, template: "{path}" } })
    expect(await createExplorer(script.deps).pick(1)).toEqual({ program, template: "{path}" })
    const cancelled = stand({ stored: { program, template: "{path}" } })
    expect(await createExplorer(cancelled.deps).pick(1)).toEqual({ program, template: "{path}" })
    expect(cancelled.stored).toEqual({ program, template: "{path}" })
  })

  test("the template is kept only when it is usable; clearing keeps it and drops the program", async () => {
    const world = stand({ stored: { program, template: DEFAULT_TEMPLATE } })
    const explorer = createExplorer(world.deps)
    expect(explorer.setTemplate("  sftp://{host}{path}  ")).toEqual({ program, template: "sftp://{host}{path}" })
    expect(explorer.setTemplate("--open {host}")).toEqual({ program, template: "sftp://{host}{path}" })
    expect(explorer.setTemplate("{path} {port}")).toEqual({ program, template: "sftp://{host}{path}" })
    expect(explorer.clear()).toEqual({ template: "sftp://{host}{path}" })
    expect(world.stored).toEqual({ template: "sftp://{host}{path}" })
    expect(await explorer.launch({ host: "devbox", path: "/a" })).toEqual({ ok: false, reason: "unconfigured" })
  })
})

describe("the service's open folders", () => {
  test("every project's folder and every folder of its worktree table, read with main's credential", async () => {
    const seen: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        seen.push(`${request.headers.get("authorization")} ${url.pathname}${url.search}`)
        if (url.pathname === "/api/project")
          return Response.json([
            { id: "p 1", canonical: "D:/projects/app", sandboxes: [] },
            { id: "p2", canonical: "D:/projects/lib" },
            { id: "p3" },
          ])
        if (url.searchParams.get("projectID") === "p 1")
          return Response.json([
            { directory: "D:/projects/app" },
            { directory: "D:/worktrees/app-feature", strategy: "git" },
          ])
        if (url.searchParams.get("projectID") === "p2") return new Response("no", { status: 500 })
        return Response.json([])
      },
    })
    try {
      const roots = await serviceRoots({
        url: `http://127.0.0.1:${server.port}`,
        headers: { authorization: "Basic abc" },
      })
      expect(roots).toEqual(["D:/projects/app", "D:/projects/lib", "D:/projects/app", "D:/worktrees/app-feature"])
      expect(seen[0]).toBe("Basic abc /api/project")
      expect(seen).toContain("Basic abc /api/worktree?projectID=p%201")
      // Reading only: nothing but the two list routes.
      expect(seen.every((line) => / \/api\/(project|worktree\?projectID=[^&]*)$/.test(line))).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  test("no service, a refusal or an answer of another shape: unknown, so reveal refuses", async () => {
    expect(await serviceRoots(undefined)).toBeUndefined()
    const refuse = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch
    expect(await serviceRoots({ url: "http://127.0.0.1:1", headers: {} }, refuse)).toBeUndefined()
    const odd = (async () => Response.json({ projects: [] })) as unknown as typeof fetch
    expect(await serviceRoots({ url: "http://127.0.0.1:1", headers: {} }, odd)).toBeUndefined()
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof fetch
    expect(await serviceRoots({ url: "http://127.0.0.1:1", headers: {} }, failing)).toBeUndefined()
  })

  test("pathKind: a folder, a file, nothing", async () => {
    const file = path.join(scratch, "kind.txt")
    writeFileSync(file, "x")
    expect(await pathKind(scratch)).toBe("directory")
    expect(await pathKind(file)).toBe("file")
    expect(await pathKind(path.join(scratch, "none"))).toBeUndefined()
  })
})

describe("a real start (this test's Bun as the program, hidden; it writes down its arguments)", () => {
  const recorder = path.join(scratch, "record args.ts")
  writeFileSync(
    recorder,
    "await Bun.write(process.argv[2], JSON.stringify({ args: process.argv.slice(3), stdin: process.stdin.isTTY ?? null }))\n",
  )
  const recorded = async (file: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const text = await Bun.file(file)
        .text()
        .catch(() => "")
      if (text) return JSON.parse(text) as { args: string[] }
      await Bun.sleep(50)
    }
    throw new Error(`the stand-in program wrote nothing to ${file}`)
  }

  test("each argument arrives whole: spaces, quotes, &, %VAR%, Unicode, trailing backslashes", async () => {
    const out = path.join(scratch, "argv out.json")
    const remote = '/home/dev/my "quoted" dir/a&b %PATH% ^x 한글 🙂\\'
    const expanded = expandTemplate(`"${recorder}" "${out}" --open {host} {path} "" tail`, {
      host: "dev@box",
      path: remote,
    })
    if (!expanded.ok) throw new Error(expanded.detail)
    expect(await launchDetached(process.execPath, expanded.args, true)).toEqual({ ok: true })
    expect((await recorded(out)).args).toEqual(["--open", "dev@box", remote, "", "tail"])
  }, 60_000)

  test("it does not wait for the program", async () => {
    const out = path.join(scratch, "slow.json")
    const slow = path.join(scratch, "slow.ts")
    writeFileSync(slow, "await Bun.sleep(1500)\nawait Bun.write(process.argv[2], JSON.stringify({ args: [] }))\n")
    expect(await launchDetached(process.execPath, [slow, out], true)).toEqual({ ok: true })
    // Answered at the start: the stand-in is still asleep.
    expect(await Bun.file(out).exists()).toBe(false)
    expect((await recorded(out)).args).toEqual([])
  }, 60_000)

  test("a program that is not there fails with its code instead of throwing", async () => {
    const missing = path.join(scratch, "nowhere", "ssh-explorer.exe")
    mkdirSync(path.dirname(missing), { recursive: true })
    const result = await launchDetached(missing, ["--open", "devbox", "/a"], true)
    expect(result).toMatchObject({ ok: false, code: "ENOENT" })
  })
})

describe("wiring", () => {
  test("the shell lists the plugin, whose main entry provides the Ipc with Electron behind the stand-in seams", async () => {
    const { builtins } = await import("../src/overrides/gui-plugins")
    expect(builtins.map((definition) => definition.id)).toEqual(["browser", "explorer"])
    const main = await code("src/explorer/main.ts")
    expect(main).toContain("ctx.provide(Explorer, {")
    expect(main).toContain("openFolder: (folder) => shell.openPath(folder),")
    expect(main).toContain("showItem: (file) => shell.showItemInFolder(file),")
    expect(main).toContain("launch: (program, args) => launchDetached(program, args),")
    expect(main).toContain('roots: () => serviceRoots(ctx.serverEndpoints.get("sidecar")),')
    // The page names no program: the dialog is main's.
    expect(main).toContain("dialog.showOpenDialog")
    const ipc = await code("src/explorer/ipc.ts")
    expect(ipc).toContain('id: "explorer"')
    expect(ipc).not.toMatch(/program:\s*\{\s*input/)
    expect(ipc).not.toMatch(/pick:\s*\{\s*input/)
  })

  test("the program starts as an argument list: no shell, detached, no pipes; only main/explorer.ts starts anything", async () => {
    const logic = await code("src/main/explorer.ts")
    expect(logic).toContain("shell: false,")
    expect(logic).toContain("detached: true,")
    expect(logic).toContain('stdio: "ignore",')
    expect(logic).not.toMatch(/\bexec(File|Sync)?\(|cmd\.exe|powershell|windowsVerbatimArguments/)
    expect(logic).not.toContain('from "electron"')
    expect(await code("src/shared/explorer.ts")).not.toMatch(/child_process|from "electron"/)
    expect(await code("src/explorer/main.ts")).not.toContain("child_process")
  })

  test("not part of window.own or its contract: only the plugin Ipc reaches it", async () => {
    expect(await code("src/preload/own-api.ts")).not.toMatch(/explorer/i)
    expect(await code("src/preload/index.ts")).not.toMatch(/explorer/i)
    expect(await code("src/main/own-shell.ts")).not.toMatch(/explorer/i)
    // The setting lives in the shell's settings file under an own key.
    expect(EXPLORER_KEY).toBe("ownExplorerProgram")
    const keys = await Bun.file(path.join(here, "../desktop/src/main/storage/keys.ts")).text()
    expect(keys).not.toContain(EXPLORER_KEY)
  })

  test("the 원격 PC 전용 build leaves it out", async () => {
    const own = await code("src/overrides/gui-plugins.ts")
    expect(own).toMatch(/clientOnly \? \{\} : \{ explorer:/)
  })
})
