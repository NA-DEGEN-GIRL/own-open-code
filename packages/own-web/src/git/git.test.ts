// Git action units (03 §19.2): quoting per shell, the fixed command lines, pathspec-file fallback, porcelain v2
// parsing (C-quoted Hangul paths), hunk patches, and — where git and the shells exist on this machine — the command
// lines executed by the real shells the server would use (packages/core/src/shell/select.ts `args`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { removeTree } from "@/testing/remove"
import {
  applyReverse,
  canRevertHunks,
  commit,
  hasUnstaged,
  hunkPatch,
  isStaged,
  parseStatus,
  pathspec,
  pullRequestUrl,
  push,
  quoteArg,
  revert,
  shellKind,
  splitHunks,
  stage,
  STATUS_COMMAND,
  tail,
  unquotePath,
  unstage,
  UnsupportedPathError,
  type ShellKind,
} from "./commands"
import { gitEn, gitKo, gitText } from "./strings"

describe("shellKind", () => {
  test("maps the server's shell path to a quoting family", () => {
    expect(shellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell")
    expect(shellKind("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")).toBe("powershell")
    expect(shellKind("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("posix")
    expect(shellKind("C:\\Windows\\system32\\cmd.exe")).toBe("cmd")
    expect(shellKind("/bin/zsh")).toBe("posix")
    expect(shellKind("/usr/bin/fish")).toBe("fish")
    expect(shellKind("/usr/bin/nu")).toBe("other")
  })
})

describe("quoteArg", () => {
  test("bare values stay bare everywhere", () => {
    for (const kind of ["posix", "powershell", "cmd", "fish", "other"] as ShellKind[])
      expect(quoteArg(kind, "C:/tmp/own-git/a.txt")).toBe("C:/tmp/own-git/a.txt")
  })

  test("POSIX single quotes, embedded quote as '\\''", () => {
    expect(quoteArg("posix", ":(top,literal)src/it's $HOME.ts")).toBe(`':(top,literal)src/it'\\''s $HOME.ts'`)
  })

  test("PowerShell single quotes with doubled quote marks; double quotes refused", () => {
    expect(quoteArg("powershell", ":(top,literal)src/한 글 $x.ts")).toBe("':(top,literal)src/한 글 $x.ts'")
    expect(quoteArg("powershell", "it's")).toBe("'it''s'")
    expect(quoteArg("powershell", "it\u2019s")).toBe("'it\u2019\u2019s'")
    expect(quoteArg("powershell", 'a "b"')).toBeUndefined()
    expect(quoteArg("powershell", "dir\\")).toBeUndefined()
  })

  test("fish escapes backslashes and quotes inside single quotes", () => {
    expect(quoteArg("fish", "a\\b 'c'")).toBe("'a\\\\b \\'c\\''")
  })

  test("cmd and unknown shells take bare values only; control characters never", () => {
    expect(quoteArg("cmd", "a b")).toBeUndefined()
    expect(quoteArg("other", "(x)")).toBeUndefined()
    expect(quoteArg("posix", "a\nb")).toBeUndefined()
    expect(quoteArg("posix", "")).toBeUndefined()
  })
})

describe("commands", () => {
  const file = () => "C:/tmp/own-git/ps.txt"

  test("stage/unstage inline with literal top pathspecs", () => {
    expect(stage("posix", ["src/a b.ts"], file)).toEqual({
      commands: ["git add -A -- ':(top,literal)src/a b.ts'"],
      writes: [],
    })
    expect(unstage("powershell", ["src/a.ts"], false, file).commands).toEqual([
      "git restore --staged -- ':(top,literal)src/a.ts'",
    ])
    expect(unstage("posix", ["src/a.ts"], true, file).commands).toEqual([
      "git rm --cached -q -- ':(top,literal)src/a.ts'",
    ])
  })

  test("paths a shell cannot carry go through a NUL-separated pathspec file", () => {
    const plan = stage("cmd", ["src/a b.ts", "src/c.ts"], file)
    expect(plan.commands).toEqual(["git add -A --pathspec-from-file=C:/tmp/own-git/ps.txt --pathspec-file-nul"])
    expect(plan.writes).toEqual([
      { path: "C:/tmp/own-git/ps.txt", content: ":(top,literal)src/a b.ts\0:(top,literal)src/c.ts" },
    ])
    const quoted = stage("powershell", ['src/"x".ts'], () => "C:/Users/A B/tmp/ps.txt")
    expect(quoted.commands).toEqual(["git add -A '--pathspec-from-file=C:/Users/A B/tmp/ps.txt' --pathspec-file-nul"])
    expect(() => stage("cmd", ["a b"], () => "C:/Users/A B/tmp/ps.txt")).toThrow(UnsupportedPathError)
  })

  test("revert: tracked back to HEAD (index and working copy), untracked deleted, before the first commit rm -f", () => {
    const names = (name: string) => `C:/tmp/${name}.txt`
    expect(revert("posix", { tracked: ["a.ts"], untracked: ["new.ts"], initial: false }, names).commands).toEqual([
      "git restore --source=HEAD --staged --worktree -- ':(top,literal)a.ts'",
      "git clean -f -q -- ':(top,literal)new.ts'",
    ])
    expect(revert("posix", { tracked: ["a.ts"], untracked: [], initial: true }, names).commands).toEqual([
      "git rm -f -q -- ':(top,literal)a.ts'",
    ])
  })

  test("commit reads its message from a file; push sets the upstream only when missing; apply -R", () => {
    expect(commit("posix", "/tmp/own-git/m.txt").commands).toEqual(["git commit -F /tmp/own-git/m.txt"])
    expect(commit("powershell", "C:/Users/A B/m.txt").commands).toEqual(["git commit -F 'C:/Users/A B/m.txt'"])
    expect(() => commit("cmd", "C:/Users/A B/m.txt")).toThrow(UnsupportedPathError)
    expect(push(true)).toBe("git push")
    expect(push(false)).toBe("git push -u origin HEAD")
    expect(applyReverse("posix", "/tmp/h.patch")).toBe("git apply -R --whitespace=nowarn /tmp/h.patch")
    expect(pathspec("a")).toBe(":(top,literal)a")
  })
})

describe("status", () => {
  const output = [
    "# branch.oid 1234",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 aaa bbb src/staged.ts",
    "1 .M N... 100644 100644 100644 aaa aaa src/with space.ts",
    '1 MM N... 100644 100644 100644 aaa bbb "src/\\355\\225\\234 \\352\\270\\200.ts"',
    "2 R. N... 100644 100644 100644 aaa bbb R100 src/new-name.ts\tsrc/old-name.ts",
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts",
    "? src/untracked file.ts",
    "warning: in the working copy of 'x', LF will be replaced by CRLF",
    "",
  ].join("\r\n")

  test("parses branch, upstream, ahead/behind and every entry kind", () => {
    const status = parseStatus(output)
    expect(status.head).toBe("feature/x")
    expect(status.initial).toBe(false)
    expect(status.upstream).toBe("origin/feature/x")
    expect([status.ahead, status.behind]).toEqual([2, 1])
    expect([...status.files.keys()]).toEqual([
      "src/staged.ts",
      "src/with space.ts",
      "src/한 글.ts",
      "src/new-name.ts",
      "src/conflict.ts",
      "src/untracked file.ts",
    ])
    expect(isStaged(status.files.get("src/staged.ts"))).toBe(true)
    expect(hasUnstaged(status.files.get("src/staged.ts"))).toBe(false)
    expect(isStaged(status.files.get("src/한 글.ts")) && hasUnstaged(status.files.get("src/한 글.ts"))).toBe(true)
    expect(status.files.get("src/untracked file.ts")).toEqual({
      index: ".",
      worktree: "?",
      untracked: true,
      conflicted: false,
    })
    expect(status.files.get("src/conflict.ts")?.conflicted).toBe(true)
  })

  test("initial and detached", () => {
    const status = parseStatus("# branch.oid (initial)\n# branch.head (detached)\n")
    expect(status.initial).toBe(true)
    expect(status.head).toBeUndefined()
  })

  test("C-style unquoting", () => {
    expect(unquotePath('"a\\tb\\\\c\\"d"')).toBe('a\tb\\c"d')
    expect(unquotePath("plain name.ts")).toBe("plain name.ts")
  })
})

describe("hunks", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -10,2 +10,3 @@ export",
    " ten",
    "+ten and a half",
    " eleven",
    "\\ No newline at end of file",
    "",
  ].join("\n")

  test("splits a git patch into its header and hunks, and builds one-hunk patches", () => {
    const parts = splitHunks(patch)
    expect(parts.head).toHaveLength(4)
    expect(parts.hunks.map((hunk) => [hunk.header, hunk.additions, hunk.deletions])).toEqual([
      ["@@ -1,3 +1,3 @@", 1, 1],
      ["@@ -10,2 +10,3 @@ export", 1, 0],
    ])
    expect(canRevertHunks(parts.head)).toBe(true)
    expect(hunkPatch(parts.head, parts.hunks[1]!)).toBe(
      [...patch.split("\n").slice(0, 4), ...patch.split("\n").slice(9, 14), ""].join("\n"),
    )
  })

  test("new files are not hunk-revertable", () => {
    const parts = splitHunks("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+x\n")
    expect(canRevertHunks(parts.head)).toBe(false)
  })
})

test("PR URL and output tail", () => {
  expect(pullRequestUrl("Creating pull request\nhttps://github.com/o/r/pull/12\n")).toBe(
    "https://github.com/o/r/pull/12",
  )
  expect(tail("a\nb\nc\n\n", 2)).toBe("b\nc")
})

test("strings: every English key exists in Korean, particles follow the name", () => {
  expect(Object.keys(gitKo)).toEqual(expect.arrayContaining(Object.keys(gitEn)))
  expect(gitText("ko", "own.git.effect.unstage", { file: "라우터" })).toContain("라우터를")
  expect(gitText("en", "own.git.push")).toBe("Push")
})

// ---------------------------------------------------------------------------------------------------------------
// The command lines through the real shells (only those installed here), against a temporary repository.

const git = Bun.which("git")
const shells = [
  ...(process.platform === "win32"
    ? // One PowerShell (the default server shell on Windows) and Git Bash keep this quick.
      [Bun.which("pwsh") ?? Bun.which("powershell"), gitBash()].filter((item): item is string => !!item)
    : [Bun.which("bash") ?? "/bin/sh"]),
]

function gitBash() {
  if (!git) return undefined
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  return Bun.file(file).size ? file : undefined
}

function args(shell: string, command: string) {
  const kind = shellKind(shell)
  if (kind === "powershell") return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  return ["-c", command]
}

describe.skipIf(!git || shells.length === 0)("real shells", () => {
  const state = { root: "" }
  const files = ["src/한 글.ts", "src/it's $HOME.ts", "src/a[1].ts", "sub dir/x.txt"]

  beforeAll(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), "own-git-unit-"))
  })
  afterAll(async () => {
    await removeTree(state.root)
  })

  async function repo(name: string) {
    const directory = path.join(state.root, name)
    await fs.mkdir(directory, { recursive: true })
    const run = (...command: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=u@example.test", "-c", "user.name=u", ...command], { cwd: directory })
    run("init", "-q", "-b", "main")
    run("config", "core.autocrlf", "false")
    for (const file of files) {
      await fs.mkdir(path.join(directory, path.dirname(file)), { recursive: true })
      await Bun.write(path.join(directory, file), "one\n")
    }
    run("add", "-A")
    run("commit", "-q", "-m", "init")
    for (const file of files) await Bun.write(path.join(directory, file), "one\ntwo\n")
    return directory
  }

  function exec(shell: string, command: string, cwd: string) {
    const result = Bun.spawnSync([shell, ...args(shell, command)], { cwd })
    return { exit: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` }
  }

  for (const shell of shells)
    test(`${path.basename(shell)}: stage, read status, unstage, revert`, async () => {
      const kind = shellKind(shell)
      const directory = await repo(path.basename(shell).replace(/\W/g, "_"))
      const staged = stage(kind, files, () => path.join(directory, "..", "ps.txt").replaceAll("\\", "/"))
      await Promise.all(staged.writes.map((write) => Bun.write(write.path, write.content)))
      for (const command of staged.commands) expect(exec(shell, command, directory).exit).toBe(0)
      const status = exec(shell, STATUS_COMMAND, path.join(directory, "sub dir"))
      expect(status.exit).toBe(0)
      const parsed = parseStatus(status.output)
      expect(parsed.head).toBe("main")
      for (const file of files) expect(isStaged(parsed.files.get(file))).toBe(true)
      for (const command of unstage(kind, files, false, () => "unused").commands)
        expect(exec(shell, command, path.join(directory, "sub dir")).exit).toBe(0)
      const reverted = revert(kind, { tracked: files, untracked: [], initial: false }, () => "unused")
      for (const command of reverted.commands) expect(exec(shell, command, directory).exit).toBe(0)
      for (const file of files) expect(await Bun.file(path.join(directory, file)).text()).toBe("one\n")
      // One shell start per line, many in a row: PowerShell takes 1-3 s each alone and several times that while the
      // unit run's other workers keep every core busy; at 30 s the test ended inside a start, its exit code null.
    }, 120_000)
})
