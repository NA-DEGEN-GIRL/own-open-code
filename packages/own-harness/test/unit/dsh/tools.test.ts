// The dsh harness's tools (src/dsh/tools.ts) run through their registered `execute` with a stand-in plugin context that
// records own's permission asks: dsh's schemas (dsh's snapshot without the background and sandbox fields own leaves
// out), dsh's argument errors, the read window and footers, the read-before-write guard and its remedies, literal
// edits with line endings kept, the shell's markers and environment, the search tools over ripgrep and `todo_write`.
// Cases follow dsh's own (packages/fs/tool-fs/tests, shell/tool-pwsh/tests, guard tests), as texts the model reads.
// Ported from deepseek-ai/deepseek-harness (MIT, Copyright (c) 2026 DeepSeek) @ 687f282e86; see dsh-data/NOTICE.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { DshArgs } from "../../../src/dsh/args.js"
import { DshObserve } from "../../../src/dsh/observe.js"
import { DshSearch } from "../../../src/dsh/search.js"
import { DshShell } from "../../../src/dsh/shell.js"
import { DshShellTool } from "../../../src/dsh/shell-tool.js"
import { DshTools } from "../../../src/dsh/tools.js"

const SNAPSHOTS = path.join(import.meta.dir, "..", "..", "..", "dsh-data", "snapshots")

type Registered = {
  name: string
  description: string
  input: { "~standard": { jsonSchema: { input: () => unknown } } }
  execute: (
    raw: unknown,
    call: unknown,
  ) => Effect.Effect<{ content: string; metadata: Record<string, unknown> }, unknown>
}

const state = {
  dir: "",
  asks: [] as Array<{ action: string; resources: ReadonlyArray<string> }>,
  tools: new Map<string, Registered>(),
  /** own.accounts' protected patterns (`protectedPaths.patterns`, 01 §13 PP); undefined: own.accounts does not answer. */
  protectedPatterns: undefined as ReadonlyArray<string> | undefined,
  /** Core tools `ctx.tool.list()` offers (CoreTool.call). */
  core: [] as Array<{ id: string; execute: (input: unknown) => Effect.Effect<{ output: unknown }> }>,
}

beforeEach(async () => {
  state.dir = path.join(tmpdir(), `own-dsh-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(state.dir, { recursive: true })
  state.asks = []
  state.protectedPatterns = undefined
  state.tools = new Map()
  state.core = []
  const ctx = {
    location: { directory: state.dir },
    // core's default read rules, as an agent carries them: `.env` files ask; own's bundle denies a protected folder.
    agent: {
      get: () =>
        Effect.succeed({
          data: {
            permissions: [
              { action: "read", resource: "*", effect: "allow" },
              { action: "read", resource: "*.env", effect: "ask" },
            ],
          },
        }),
    },
    session: {
      get: () => Effect.succeed({ permissions: [{ action: "read", resource: "vault/*", effect: "deny" }] }),
    },
    tool: {
      list: () => Effect.succeed(state.core),
      transform: (callback: (editor: { add: (tool: Registered) => void }) => void) =>
        Effect.sync(() => callback({ add: (tool) => void state.tools.set(tool.name, tool) })),
    },
    permission: {
      paths: (input: { paths: ReadonlyArray<string> }) =>
        Effect.succeed(input.paths.map((file) => ({ resource: path.relative(state.dir, file) || "." }))),
      assert: (input: { action: string; resources: ReadonlyArray<string> }) =>
        Effect.sync(() => void state.asks.push({ action: input.action, resources: input.resources })),
    },
    rpc: () => ({
      "protectedPaths.patterns": () =>
        state.protectedPatterns === undefined
          ? Effect.fail(new Error("own.accounts is not loaded"))
          : Effect.succeed({ patterns: state.protectedPatterns }),
    }),
    shell: {
      authorize: (input: { command: string; cwd: string }) =>
        Effect.sync(() => {
          state.asks.push({ action: "shell", resources: [input.command] })
          return { cwd: input.cwd }
        }),
    },
  }
  await Effect.runPromise(DshTools.register(ctx as never, new DshObserve.State()) as Effect.Effect<void>)
})

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true })
})

const call = (sessionID = "ses_a") => ({
  sessionID,
  agent: "build",
  messageID: "msg_1",
  id: "call_1",
  progress: () => Effect.void,
})

async function run(name: string, input: unknown, sessionID?: string) {
  const tool = state.tools.get(DshTools.INTERNAL[name]!)!
  const result = await Effect.runPromise(tool.execute(input, call(sessionID)))
  return { text: result.content, metadata: result.metadata }
}

const file = (name: string) => path.join(state.dir, name)

describe("schemas", () => {
  test("dsh's wire schemas, without run_in_background and the sandbox escalation fields own leaves out", async () => {
    const snapshot = (await Bun.file(path.join(SNAPSHOTS, "pwsh-tool-turn.tool-schemas.json")).json()) as {
      initial: Array<{
        name: string
        description: string
        parameters: { properties: Record<string, unknown>; required: Array<string> }
      }>
    }
    const unported = ["run_in_background", "sandbox_permissions", "justification"]
    const wanted = Object.fromEntries(
      snapshot.initial
        .filter((tool) => ["pwsh", "read", "write", "edit", "glob", "grep", "todo_write"].includes(tool.name))
        .map((tool) => [
          tool.name,
          {
            ...tool,
            parameters: {
              ...tool.parameters,
              properties: Object.fromEntries(
                Object.entries(tool.parameters.properties).filter(([key]) => !unported.includes(key)),
              ),
            },
          },
        ]),
    )
    const sent = Object.fromEntries(
      [...state.tools.values()].map((tool) => {
        const name = Object.entries(DshTools.INTERNAL).find(([, id]) => id === tool.name)![0]
        return [name, { name, description: tool.description, parameters: tool.input["~standard"].jsonSchema.input() }]
      }),
    )
    for (const name of ["read", "write", "edit", "glob", "grep", "todo_write"])
      expect(JSON.stringify(sent[name])).toBe(JSON.stringify(wanted[name]))
    // The pwsh tool without a job registry: the kill wording for timeoutMs and dsh's non-Windows-sandbox description.
    const pwsh = wanted.pwsh!
    expect(DshShellTool.PWSH_DESCRIPTION).toBe(
      pwsh.description.slice(0, pwsh.description.indexOf(" Under the Windows sandbox")),
    )
    expect(Object.keys(DshShellTool.PWSH_SCHEMA.properties)).toEqual(Object.keys(pwsh.parameters.properties))
    expect(DshShellTool.PWSH_SCHEMA.properties.timeoutMs!.description).toBe(
      "Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.",
    )
    expect(DshShellTool.PWSH_SCHEMA.required).toEqual(pwsh.parameters.required)
    expect(DshTools.NAMES[0]).toBe(process.platform === "win32" ? "pwsh" : "bash")
  })

  test("argument errors are dsh's, in schema-walk order", () => {
    expect(DshArgs.check(DshShellTool.PWSH_SCHEMA, {})).toEqual({
      ok: false,
      message: 'invalid arguments: missing required property "description"; missing required property "command"',
    })
    expect(DshArgs.check(DshShellTool.PWSH_SCHEMA, { description: "d", command: 3, timeoutMs: "5" })).toEqual({
      ok: false,
      message: 'invalid arguments: "command" must be a string; "timeoutMs" must be a number',
    })
    expect(DshArgs.check(DshShellTool.PWSH_SCHEMA, "x")).toEqual({
      ok: false,
      message: 'invalid arguments: "arguments" must be an object',
    })
  })
})

describe("read", () => {
  test("a numbered window in dsh's envelope, with the end-of-file footer, and own's read ask", async () => {
    writeFileSync(file("a.txt"), "one\r\ntwo\nthree\n")
    const result = await run("read", { file_path: "a.txt" })
    expect(result.text).toBe(
      `<path>${file("a.txt")}</path>\n<type>file</type>\n<content>\n1: one\n2: two\n3: three\n\n(End of file - total 3 lines)\n</content>`,
    )
    expect(state.asks).toEqual([{ action: "read", resources: ["a.txt"] }])
  })

  test("offset and limit continue a large file; a long line is cut; the byte cap stops the window", async () => {
    writeFileSync(file("big.txt"), Array.from({ length: 2500 }, (_, index) => `Line ${index + 1}`).join("\n"))
    expect((await run("read", { file_path: "big.txt" })).text).toContain(
      "2000: Line 2000\n\n(Showing lines 1-2000 of 2500. Use offset=2001 to continue.)",
    )
    expect((await run("read", { file_path: "big.txt", offset: 2499, limit: 5 })).text).toContain(
      "2499: Line 2499\n2500: Line 2500\n\n(End of file - total 2500 lines)",
    )
    writeFileSync(
      file("wide.txt"),
      `${"x".repeat(2100)}\n${Array.from({ length: 60 }, () => "y".repeat(1500)).join("\n")}`,
    )
    const wide = (await run("read", { file_path: "wide.txt" })).text
    expect(wide).toContain(`1: ${"x".repeat(2000)}... (line truncated to 2000 chars)`)
    expect(wide).toMatch(/\(Output capped\. Showing lines 1-\d+\. Use offset=\d+ to continue\.\)/)
  })

  test("dsh's read failures", async () => {
    expect((await run("read", { file_path: "missing.txt" })).text).toBe(
      `Error: cannot read "${file("missing.txt")}": not found`,
    )
    writeFileSync(file("bin.dat"), Buffer.from([1, 0, 2]))
    expect((await run("read", { file_path: "bin.dat" })).text).toBe(
      `Error: cannot read "${file("bin.dat")}": binary file`,
    )
    writeFileSync(file("short.txt"), "a\nb\n")
    expect((await run("read", { file_path: "short.txt", offset: 5 })).text).toBe(
      `Error: offset 5 is out of range for "${file("short.txt")}" (2 lines)`,
    )
    expect((await run("read", { file_path: "short.txt", limit: 2001 })).text).toBe(
      "Error: limit must be less than or equal to 2000",
    )
    expect((await run("read", { file_path: "short.txt", offset: 0 })).text).toBe(
      "Error: offset must be a positive integer",
    )
    writeFileSync(file("empty.txt"), "")
    expect((await run("read", { file_path: "empty.txt" })).text).toContain("(End of file - total 0 lines)")
  })
})

describe("write and edit", () => {
  test("write creates a file; overwriting needs a read first; a read file is replaced, with own's edit ask", async () => {
    expect((await run("write", { file_path: "out/new.txt", content: "hello\n" })).text).toBe(
      `<path>${file(path.join("out", "new.txt"))}</path>\n<type>file</type>\n<content>\nCreated file\n</content>`,
    )
    expect(readFileSync(file(path.join("out", "new.txt")), "utf8")).toBe("hello\n")
    writeFileSync(file("keep.txt"), "old\n")
    expect((await run("write", { file_path: "keep.txt", content: "new\n" })).text).toBe(
      `Error: cannot modify "${file("keep.txt")}": file has not been read — read the file, then retry`,
    )
    await run("read", { file_path: "keep.txt" })
    expect((await run("write", { file_path: "keep.txt", content: "new\n" })).text).toContain("Updated file")
    expect(readFileSync(file("keep.txt"), "utf8")).toBe("new\n")
    expect(state.asks.filter((ask) => ask.action === "edit").map((ask) => ask.resources)).toEqual([
      [path.join("out", "new.txt")],
      ["keep.txt"],
    ])
  })

  test("a file changed since it was read is stale; another session has read nothing", async () => {
    writeFileSync(file("s.txt"), "one\n")
    await run("read", { file_path: "s.txt" })
    await Bun.sleep(20)
    writeFileSync(file("s.txt"), "changed elsewhere\n")
    expect((await run("edit", { file_path: "s.txt", old_string: "changed", new_string: "x" })).text).toBe(
      `Error: cannot edit "${file("s.txt")}": file changed since it was read — re-read the file, then retry`,
    )
    expect((await run("edit", { file_path: "s.txt", old_string: "changed", new_string: "x" }, "ses_b")).text).toBe(
      `Error: cannot modify "${file("s.txt")}": file has not been read — read the file, then retry`,
    )
  })

  test("edit replaces literal text once, keeps CRLF, and answers dsh's ambiguity and absence errors", async () => {
    writeFileSync(file("c.txt"), "alpha\r\nbeta\r\nbeta\r\n")
    await run("read", { file_path: "c.txt" })
    expect((await run("edit", { file_path: "c.txt", old_string: "beta", new_string: "gamma" })).text).toBe(
      `Error: old_string matched 2 times in "${file("c.txt")}"; provide a more specific old_string or set replace_all to true`,
    )
    expect(
      (await run("edit", { file_path: "c.txt", old_string: "alpha\nbeta", new_string: "first\nsecond" })).text,
    ).toBe(`The file ${file("c.txt")} has been updated successfully.`)
    expect(readFileSync(file("c.txt"), "utf8")).toBe("first\r\nsecond\r\nbeta\r\n")
    expect((await run("edit", { file_path: "c.txt", old_string: "e", new_string: "E", replace_all: true })).text).toBe(
      `The file ${file("c.txt")} has been updated. All occurrences were successfully replaced.`,
    )
    expect(readFileSync(file("c.txt"), "utf8")).toBe("first\r\nsEcond\r\nbEta\r\n")
    expect((await run("edit", { file_path: "c.txt", old_string: "zzz", new_string: "y" })).text).toBe(
      `Error: old_string was not found in "${file("c.txt")}"`,
    )
    expect((await run("edit", { file_path: "c.txt", old_string: "x", new_string: "x" })).text).toBe(
      "Error: old_string and new_string must differ",
    )
    const result = await run("edit", { file_path: "c.txt", old_string: "first", new_string: "1st" })
    expect((result.metadata.files as Array<{ additions: number }>)[0]!.additions).toBe(1)
  })

  test.skipIf(process.platform !== "win32" && process.getuid?.() === 0)(
    "upstream 66491b05e3: a write the OS refuses answers dsh's permission text, not the staging path; the file is kept",
    async () => {
      mkdirSync(file("locked"))
      const locked = file(path.join("locked", "f.txt"))
      writeFileSync(locked, "keep\n")
      // Windows refuses to replace a read-only file; POSIX refuses a new entry (the staging folder) in a read-only folder.
      const denied = process.platform === "win32" ? locked : file("locked")
      chmodSync(denied, process.platform === "win32" ? 0o444 : 0o555)
      try {
        // Read after the change of mode: it moves the file's version on Windows.
        await run("read", { file_path: "locked/f.txt" })
        const refused = `Error: cannot write "${locked}": permission denied`
        const written = await run("write", { file_path: "locked/f.txt", content: "new\n" })
        expect(written.text).toBe(refused)
        expect(written.metadata.isError).toBe(true)
        expect((await run("edit", { file_path: "locked/f.txt", old_string: "keep", new_string: "new" })).text).toBe(
          refused,
        )
        expect(readFileSync(locked, "utf8")).toBe("keep\n")
        expect(readdirSync(file("locked"))).toEqual(["f.txt"])
      } finally {
        chmodSync(denied, process.platform === "win32" ? 0o644 : 0o755)
      }
    },
  )

  test("upstream 66491b05e3: any other write failure names the file and the OS's reason", async () => {
    writeFileSync(file("blocker"), "file")
    const blocked = (await run("write", { file_path: "blocker/child.txt", content: "x" })).text
    expect(blocked).toStartWith(`Error: cannot write "${file(path.join("blocker", "child.txt"))}": `)
    expect(blocked).not.toContain("permission denied")
    expect(readFileSync(file("blocker"), "utf8")).toBe("file")
  })
})

describe("home prefix (upstream f3803c9697)", () => {
  test("read, write and edit of ~/… reach the home folder and leave no ~ folder in the workspace", async () => {
    const home = path.join(state.dir, "..", `${path.basename(state.dir)}-home`)
    mkdirSync(home, { recursive: true })
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      writeFileSync(path.join(home, "notes.txt"), "from home\n")
      expect((await run("read", { file_path: "~/notes.txt" })).text).toBe(
        `<path>${path.join(home, "notes.txt")}</path>\n<type>file</type>\n<content>\n1: from home\n\n(End of file - total 1 lines)\n</content>`,
      )
      expect((await run("write", { file_path: "~/new.txt", content: "made\n" })).text).toContain("Created file")
      expect(readFileSync(path.join(home, "new.txt"), "utf8")).toBe("made\n")
      expect((await run("edit", { file_path: "~/notes.txt", old_string: "from", new_string: "still" })).text).toBe(
        `The file ${path.join(home, "notes.txt")} has been updated successfully.`,
      )
      expect(readFileSync(path.join(home, "notes.txt"), "utf8")).toBe("still home\n")
      expect(existsSync(file("~"))).toBe(false)
      // The home folder is outside the Location, so own's file permission sees the home path itself.
      expect(state.asks.find((ask) => ask.action === "read")!.resources).toEqual([
        path.relative(state.dir, path.join(home, "notes.txt")),
      ])
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("shell", () => {
  const command = (text: { pwsh: string; bash: string }) => (DshShell.kind() === "pwsh" ? text.pwsh : text.bash)

  test("stdout, a marked stderr section and the exit marker; the description is required", async () => {
    const result = await run(DshShell.kind(), {
      description: "Print and fail",
      command: command({
        pwsh: "Write-Output 'out'; [Console]::Error.WriteLine('err'); exit 3",
        bash: "echo out; echo err >&2; exit 3",
      }),
    })
    // PowerShell writes CRLF, which reaches the model as it does in dsh.
    expect(result.text.replaceAll("\r\n", "\n")).toBe("out\n[stderr]\nerr\n[exit code: 3]")
    expect(result.metadata).toMatchObject({ exit: 3, description: "Print and fail" })
    expect(state.asks.some((ask) => ask.action === "shell")).toBe(true)
    expect((await run(DshShell.kind(), { description: " ", command: "x" })).text).toBe(
      "Error: invalid description: expected a non-empty string",
    )
  }, 60_000)

  test("UTF-8 output, the managed DSH_* facts, no credential-shaped variables, and (no output)", async () => {
    process.env.OWN_DSH_TEST_TOKEN = "secret"
    const result = await run(DshShell.kind(), {
      description: "Show env",
      command: command({
        pwsh: "Write-Output '한글'; Write-Output $env:DSH_SHELL; Write-Output \"[$env:OWN_DSH_TEST_TOKEN]\"; Write-Output $env:NO_COLOR",
        bash: 'echo 한글; echo $DSH_SHELL; echo "[$OWN_DSH_TEST_TOKEN]"; echo $NO_COLOR',
      }),
    })
    delete process.env.OWN_DSH_TEST_TOKEN
    expect(result.text.replaceAll("\r\n", "\n")).toBe("한글\n1\n[]\n1\n")
    const quiet = await run(DshShell.kind(), {
      description: "Nothing",
      command: command({ pwsh: "$null", bash: "true" }),
    })
    expect(quiet.text).toBe("(no output)")
  }, 60_000)

  test("the deadline kills the command and says so", async () => {
    const result = await run(DshShell.kind(), {
      description: "Sleep",
      command: command({ pwsh: "Start-Sleep -Seconds 30", bash: "sleep 30" }),
      timeoutMs: 1500,
    })
    expect(result.text).toStartWith("(no output)\n[timed out after 1500ms]\n")
    expect(result.text).toMatch(
      process.platform === "win32" ? /\[exit code: 1\]$/ : /\[killed by signal: SIG(TERM|KILL)\]$/,
    )
  }, 60_000)

  test("timeouts are clamped; the argv carries dsh's UTF-8 preamble", () => {
    expect(DshShell.timeout(undefined)).toBe(120_000)
    expect(DshShell.timeout(9_000_000)).toBe(600_000)
    expect(DshShell.argv("pwsh", "Get-Date", "pwsh.exe")).toEqual([
      "pwsh.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${DshShell.ENCODING_PREAMBLE}Get-Date`,
    ])
    expect(DshShell.candidatePwshPaths({ ProgramFiles: "P:", SystemRoot: "W:", PATH: '"C:\\bin";' })).toEqual([
      "P:\\PowerShell\\7\\pwsh.exe",
      "C:\\bin\\pwsh.exe",
      "W:\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ])
  })

  test("a long output keeps its tail and names the spill file with the whole stream", () => {
    const rendered = DshShellTool.render({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1,
      stdout: { text: "tail", truncated: true, spillPath: "C:\\tmp\\out.log" },
      stderr: { text: "", truncated: false },
    })
    expect(rendered).toBe("tail\n[output truncated; full output: C:\\tmp\\out.log]")
  })
})

describe.skipIf(DshSearch.ripgrep() === undefined)("glob and grep", () => {
  test("glob lists files with own's glob ask; grep groups matches by file", async () => {
    mkdirSync(file("src"), { recursive: true })
    writeFileSync(file(path.join("src", "a.ts")), "const one = 1\nconst two = 2\n")
    writeFileSync(file(path.join("src", "b.ts")), "const one = 'b'\n")
    mkdirSync(file(".git"), { recursive: true })
    writeFileSync(file(path.join(".git", "x.ts")), "const one = 'git'\n")
    const listed = (await run("glob", { pattern: "*.ts" })).text.split("\n").toSorted()
    expect(listed).toEqual([path.join("src", "a.ts"), path.join("src", "b.ts")])
    const found = (await run("grep", { pattern: "one", include: "*.ts" })).text
    expect(found).toStartWith("Found 2 matches\n\n")
    expect(found).toContain(`${path.join("src", "a.ts")}\nLine 1: const one = 1`)
    expect((await run("grep", { pattern: "absent" })).text).toBe("No matches found")
    expect((await run("glob", { pattern: "*.md" })).text).toBe("No files found")
    expect((await run("grep", { pattern: "(" })).text).toStartWith("Error: grep pattern rejected by ripgrep: ")
    expect((await run("grep", { pattern: "x", include: "*.ts,*.js" })).text).toBe(
      "Error: include must be one glob, not a comma-separated list (use {a,b} alternation instead)",
    )
    expect(state.asks.map((ask) => ask.action)).toContain("glob")
    expect(state.asks.map((ask) => ask.action)).toContain("grep")
  }, 60_000)

  test("upstream f3803c9697: grep's empty include is no filter; a literal folder prefix lists the same files", async () => {
    mkdirSync(file(path.join("src", "deep")), { recursive: true })
    writeFileSync(file(path.join("src", "a.ts")), "const one = 1\n")
    writeFileSync(file("notes.md"), "one more\n")
    writeFileSync(file(path.join("src", "deep", "b.ts")), "const one = 'b'\n")
    mkdirSync(file(path.join("node_modules", "x", "src")), { recursive: true })
    writeFileSync(file(path.join("node_modules", "x", "src", "c.ts")), "const one = 'c'\n")
    // ripgrep searches files in parallel, so the groups are compared in sorted order.
    const groups = (text: string) => text.split("\n\n").toSorted()
    const all = (await run("grep", { pattern: "one" })).text
    expect(all).toStartWith("Found 4 matches\n\n")
    expect(groups((await run("grep", { pattern: "one", include: "" })).text)).toEqual(groups(all))
    expect((await run("grep", { pattern: "one", include: " " })).text).toBe(
      "Error: include must be a non-empty glob when given",
    )
    expect((await run("glob", { pattern: "src/*.ts" })).text).toBe(path.join("src", "a.ts"))
    expect((await run("glob", { pattern: "src/deep/*.ts" })).text).toBe(path.join("src", "deep", "b.ts"))
  }, 60_000)

  test("own's P-031: no lines from a file whose read asks or is denied; a denied path is left out of glob", async () => {
    writeFileSync(file("app.ts"), "const token = 'public'\n")
    // dsh's grep skips hidden files (no --hidden), so the asking file here is a visible one.
    writeFileSync(file("config.env"), "token=secret\n")
    mkdirSync(file("vault"), { recursive: true })
    writeFileSync(file(path.join("vault", "key.ts")), "const token = 'vault'\n")
    const found = (await run("grep", { pattern: "token" })).text
    expect(found).toStartWith("Found 1 match\n\napp.ts\nLine 1: const token = 'public'")
    expect(found).toEndWith(
      "(Matches in 2 file(s) are left out: reading them is denied or needs the user's approval. Read such a file with the read tool to ask.)",
    )
    expect(found).not.toContain("secret")
    const listed = (await run("glob", { pattern: "*" })).text.split("\n").toSorted()
    expect(listed).toEqual(["app.ts", "config.env"])
  }, 60_000)

  test("own.accounts' protected paths (built-in and the user's, PP) are left out of grep and glob too", async () => {
    writeFileSync(file("app.ts"), "const token = 'public'\n")
    mkdirSync(file("wallet-backups"), { recursive: true })
    writeFileSync(file(path.join("wallet-backups", "seed.ts")), "const token = 'seed words'\n")
    // Without own.accounts the session rules alone decide: the folder shows.
    expect((await run("grep", { pattern: "token" })).text).toContain("seed words")
    state.protectedPatterns = [`${file("wallet-backups").replaceAll("\\", "/")}/**`]
    const found = (await run("grep", { pattern: "token" })).text
    expect(found).toStartWith("Found 1 match\n\napp.ts\nLine 1: const token = 'public'")
    expect(found).not.toContain("seed words")
    expect(found).toContain("(Matches in 1 file(s) are left out")
    expect((await run("glob", { pattern: "**/*.ts" })).text.split("\n")).toEqual(["app.ts"])
    // A link or junction to the protected folder is matched by its real path (PathForms, PP-V).
    symlinkSync(file("wallet-backups"), file("link"), process.platform === "win32" ? "junction" : "dir")
    const linked = (await run("grep", { pattern: "token", path: "link" })).text
    expect(linked).not.toContain("seed words")
    expect(linked).toContain("(Matches in 1 file(s) are left out")
  }, 60_000)

  test("before core has fetched ripgrep, core's own tool with the same pattern makes it do so, once", async () => {
    const real = DshSearch.ripgrep()!
    const cache = path.join(tmpdir(), `own-dsh-rg-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const bin = path.join(cache, "opencode", "bin")
    const saved = { PATH: process.env.PATH, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }
    const calls: Array<unknown> = []
    process.env.PATH = path.dirname(process.execPath)
    process.env.XDG_CACHE_HOME = cache
    try {
      writeFileSync(file("a.ts"), "const one = 1\n")
      expect(DshSearch.ripgrep()).toBeUndefined()
      expect((await run("glob", { pattern: "*.ts" })).text).toBe(
        "Error: glob could not start its search command (ripgrep launch failed)",
      )
      // core's glob resolves its ripgrep (here: copies one where core keeps it) and asks the same permission itself.
      state.core = [
        {
          id: "glob",
          execute: (input) =>
            Effect.sync(() => {
              calls.push(input)
              mkdirSync(bin, { recursive: true })
              copyFileSync(real, path.join(bin, path.basename(real)))
              return { output: [] }
            }),
        },
      ]
      expect((await run("glob", { pattern: "*.ts" })).text).toBe("a.ts")
      expect((await run("glob", { pattern: "*.ts" })).text).toBe("a.ts")
      expect(calls).toEqual([{ pattern: "*.ts", limit: 1 }])
      expect(DshSearch.ripgrep()).toBe(path.join(bin, path.basename(real)))
    } finally {
      process.env.PATH = saved.PATH
      if (saved.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = saved.XDG_CACHE_HOME
      rmSync(cache, { recursive: true, force: true })
    }
  }, 60_000)

  test("past the cap the complete result is saved and the footer names it", () => {
    const paths = Array.from({ length: 101 }, (_, index) => `f${index}.ts`)
    expect(DshSearch.renderGlob(paths, "C:\\spill\\glob-results.txt")).toEndWith(
      "f99.ts\n\n(Showing 100 of 101 paths. Full sorted result stored at: C:\\spill\\glob-results.txt. Use read with offset/limit, or grep this path to search within it.)",
    )
    const matches = Array.from({ length: 251 }, (_, index) => ({ path: "a.ts", lineNumber: index + 1, line: "x" }))
    expect(DshSearch.renderGrep(matches, undefined)).toStartWith("Found 250 of 251 matches\n\na.ts\nLine 1: x")
    expect(DshSearch.renderGrep(matches, undefined)).toEndWith(
      "(The complete result could not be saved; narrow pattern, path, or include to see more.)",
    )
    expect(DshSearch.previewLine(`${"a".repeat(1999)}한`)).toBe(`${"a".repeat(1999)} (line truncated)`)
  })
})

describe("todo_write", () => {
  test("the count line; dsh's checks", async () => {
    const result = await run("todo_write", {
      todos: [
        { content: "Read the code", status: "completed" },
        { content: " Fix it ", status: "in_progress" },
        { content: "Test", status: "pending" },
      ],
    })
    expect(result.text).toBe("Updated todo list: 1 pending, 1 in progress, 1 completed.")
    expect(result.metadata.todos).toEqual([
      { content: "Read the code", status: "completed" },
      { content: "Fix it", status: "in_progress" },
      { content: "Test", status: "pending" },
    ])
    expect((await run("todo_write", { todos: [{ content: "a", status: "done" }] })).text).toBe(
      'Error: invalid arguments: "todos[0].status" must be one of ["pending","in_progress","completed"]',
    )
    expect(
      (
        await run("todo_write", {
          todos: [
            { content: "a", status: "pending" },
            { content: "a", status: "pending" },
          ],
        })
      ).text,
    ).toBe('Error: invalid todos: duplicate content "a"')
    expect((await run("todo_write", { todos: [{ content: "a", status: "pending", extra: 1 }] })).text).toBe(
      'Error: invalid arguments: "todos[0].extra" is not a declared property (additionalProperties: false)',
    )
  })
})
