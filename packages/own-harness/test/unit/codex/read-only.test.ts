import { describe, expect, test } from "bun:test"
import type { Permission } from "@opencode/schema/permission"
import type { ExecManager } from "../../../src/codex/exec/manager.js"
import { Fragments } from "../../../src/codex/fragments.js"
import { CodexReadOnly } from "../../../src/codex/read-only.js"
import { CodexVariant } from "../../../src/codex/variant.js"

const ps = (command: string) => CodexReadOnly.parse(command, "powershell")
const sh = (command: string) => CodexReadOnly.parse(command, "bash")

describe("CodexReadOnly.parse", () => {
  test("PowerShell reads, listings and searches", () => {
    expect(ps("Get-Content README.md")).toEqual({
      kind: "read",
      dialect: "powershell",
      command: "Get-Content",
      file: "README.md",
      raw: false,
      steps: [],
    })
    expect(ps(String.raw`Get-Content -Path .\src\a.ts -TotalCount 50`)).toMatchObject({
      file: String.raw`.\src\a.ts`,
      steps: [{ kind: "first", count: 50 }],
    })
    expect(ps("gc a.txt -Tail 20")).toMatchObject({ file: "a.txt", steps: [{ kind: "last", count: 20 }] })
    expect(ps("Get-Content a.txt | Select-Object -First 50 -Skip 100")).toMatchObject({
      steps: [
        { kind: "skip", count: 100 },
        { kind: "first", count: 50 },
      ],
    })
    expect(ps(String.raw`Get-Content 'C:\work\a b.txt' -Raw`)).toMatchObject({
      file: String.raw`C:\work\a b.txt`,
      raw: true,
    })
    expect(ps("Get-Content -LiteralPath 'it''s.txt'")).toMatchObject({ file: "it's.txt" })
    expect(ps('type "a b.txt"')).toMatchObject({ kind: "read", file: "a b.txt" })
    expect(ps("Get-Content -Path:a.txt")).toMatchObject({ file: "a.txt" })
    expect(ps("Get-ChildItem")).toEqual({
      kind: "list",
      dialect: "powershell",
      dir: ".",
      dotfiles: true,
      filesOnly: false,
    })
    expect(ps("ls src -File")).toMatchObject({ kind: "list", dir: "src", filesOnly: true })
    expect(ps("Get-ChildItem src -Recurse -File -Filter *.ts")).toEqual({
      kind: "files",
      dialect: "powershell",
      dir: "src",
      glob: "*.ts",
      hidden: false,
      show: "absolute",
    })
    expect(ps("gci -Recurse -File -Name -Force")).toMatchObject({
      kind: "files",
      dir: ".",
      hidden: true,
      show: "relative",
    })
    expect(ps(String.raw`Select-String -Pattern TODO -Path .\a.ts`)).toMatchObject({
      kind: "search",
      style: "select-string",
      pattern: "TODO",
      path: String.raw`.\a.ts`,
      literal: false,
      caseSensitive: false,
    })
    expect(ps("sls 'a.b' a.ts -SimpleMatch -CaseSensitive")).toMatchObject({ literal: true, caseSensitive: true })
    expect(ps('rg -n "useState" src')).toEqual({
      kind: "search",
      dialect: "powershell",
      style: "rg",
      pattern: "useState",
      path: "src",
      glob: undefined,
      literal: false,
      caseSensitive: true,
      filesOnly: false,
      lineNumbers: true,
    })
    expect(ps("rg -niF -g '*.ts' -- -x")).toMatchObject({
      pattern: "-x",
      glob: "*.ts",
      literal: true,
      caseSensitive: false,
    })
    expect(ps("rg -l -e foo src")).toMatchObject({ pattern: "foo", path: "src", filesOnly: true })
    expect(ps("rg --files -g '*.md'")).toEqual({
      kind: "files",
      dialect: "powershell",
      dir: undefined,
      glob: "*.md",
      hidden: false,
      show: "rg",
    })
  })

  test("POSIX reads, listings and searches", () => {
    expect(sh("cat a")).toEqual({ kind: "read", dialect: "posix", command: "cat", file: "a", raw: true, steps: [] })
    expect(sh("head -n 40 a")).toMatchObject({ command: "head", steps: [{ kind: "first", count: 40 }] })
    expect(sh("head a")).toMatchObject({ steps: [{ kind: "first", count: 10 }] })
    expect(sh("tail -20 a")).toMatchObject({ steps: [{ kind: "last", count: 20 }] })
    expect(sh("sed -n '1,200p' a.ts")).toMatchObject({ file: "a.ts", steps: [{ kind: "lines", from: 1, to: 200 }] })
    expect(sh("sed -n '5p' a")).toMatchObject({ steps: [{ kind: "lines", from: 5, to: 5 }] })
    expect(sh("sed -n '10,$p' a")).toMatchObject({ steps: [{ kind: "lines", from: 10, to: undefined }] })
    expect(sh("cat 'a b'")).toMatchObject({ file: "a b" })
    expect(sh("cat ~/notes.txt")).toMatchObject({ file: "~/notes.txt" })
    expect(sh("ls -la src")).toEqual({ kind: "list", dialect: "posix", dir: "src", dotfiles: true, filesOnly: false })
    expect(sh("ls")).toMatchObject({ dir: ".", dotfiles: false })
    expect(sh("rg -i foo")).toMatchObject({ kind: "search", dialect: "posix", pattern: "foo", caseSensitive: false })
    expect(sh("rg --files src")).toMatchObject({ kind: "files", dir: "src", show: "rg" })
    expect(CodexReadOnly.parse("cat a", "zsh")).toMatchObject({ kind: "read" })
  })

  test("PowerShell: anything that could run, write, expand or reach a provider is not served", () => {
    ;[
      "Get-Content a > b",
      "Get-Content a 2>$null",
      "Get-Content a; Remove-Item a",
      String.raw`Get-Content $env:USERPROFILE\x`,
      "Get-Content (Resolve-Path a)",
      "Get-Content a | Set-Content b",
      "Get-Content a | ForEach-Object { $_ }",
      "Get-Content a | Select-Object -First 1 | Out-File o",
      "Get-Content *.json",
      "Get-Content a[1].txt",
      "Get-Content Env:PATH",
      "Get-Content HKCU:\\Software",
      String.raw`Get-Content \\srv\s\x`,
      "Get-Content //srv/s/x",
      "Get-Content a.txt:s",
      "Get-Content -Stream s a",
      "Get-Content a -Wait",
      "Get-Content a -Encoding",
      "Get-Content a -Foo 1",
      "Get-Content a`b",
      'Get-Content "a$b"',
      'Get-Content "a`tb"',
      "Get-Content \u2018a\u2019",
      "Get-Content \u2013Path a",
      "Get-Content --% a",
      "Get-Content -Path a -LiteralPath b",
      "Get-Content a -TotalCount 5 -Tail 5",
      "Get-Content a -TotalCount -5",
      "Get-Content a -TotalCount 99999999",
      "Get-Content a -Raw | Select-Object -First 1",
      "Get-Content a | Select-Object -Last 2",
      "Get-Content ~user/x",
      "'Get-Content' a",
      "[IO.File]::ReadAllText('a')",
      "& rg x",
      "rg --pre cat x",
      "rg -z x",
      "rg --search-zip x",
      "rg -C 3 x",
      "rg -v x",
      "rg --json x",
      "rg x a b",
      "rg -g a -g b x",
      "rg x ~/.claude",
      "rg --files -n",
      "Get-ChildItem -Recurse",
      "Get-ChildItem -Recurse | Remove-Item",
      "Get-ChildItem -Recurse -File | Select-String x",
      "Get-ChildItem -Recurse -File ~",
      "Get-ChildItem src *.ts",
      "Get-ChildItem -Directory",
      "Get-ChildItem -Depth 2",
      "Get-ChildItem -r",
      "Select-String foo",
      "Select-String -Pattern foo -Path *.ts",
      "Set-Location s; gc a",
      "cd s && cat a",
      "git status",
      "Test-Path a",
      "",
    ].forEach((command) => expect([command, ps(command)]).toEqual([command, undefined]))
  })

  test("POSIX: anything that could run, write or expand is not served", () => {
    ;[
      "cat a > b",
      "cat $HOME/x",
      "cat $(echo a)",
      "cat `echo a`",
      "cat *.txt",
      "cat a b",
      "cat -n a",
      "cat -",
      String.raw`cat a\ b`,
      'cat "a\\"b"',
      "cat ~user/x",
      "cat a | head -n 5",
      "head -c 10 a",
      "tail -f a",
      "tail -n +5 a",
      "sed -i 's/a/b/' a",
      "sed -n '1p;w o' a",
      "sed -n '0,5p' a",
      "sed -n 'w o' a",
      "find . -delete",
      "find . -exec rm {} ;",
      "grep -r x . | tee o",
      "grep -rn foo src",
      "FOO=1 cat a",
      "ls -R",
      "ls a b",
      "ls; rm a",
      "nl -ba a",
      "wc -l a",
      "rg x a b",
      "rg --pre cat x",
    ].forEach((command) => expect([command, sh(command)]).toEqual([command, undefined]))
  })

  test("cmd is never served", () => {
    expect(CodexReadOnly.parse("type a.txt", "cmd")).toBeUndefined()
    expect(CodexReadOnly.parse("rg foo", "cmd")).toBeUndefined()
  })

  test("every command the read-only texts name is served in the shells they name it for", () => {
    // Each form under every shell the texts say it works in; the POSIX-only forms are refused in PowerShell.
    const named: ReadonlyArray<readonly [string, string, ReadonlyArray<ExecManager.ShellType>]> = [
      ["`Get-Content`", "Get-Content a.txt", ["powershell"]],
      ["`cat`", "cat a.txt", ["powershell", "bash", "zsh", "sh"]],
      ["`head`", "head -n 5 a.txt", ["bash", "zsh", "sh"]],
      ["`tail`", "tail -5 a.txt", ["bash", "zsh", "sh"]],
      ["`sed -n`", "sed -n '1,5p' a.txt", ["bash", "zsh", "sh"]],
      ["`Get-ChildItem`", "Get-ChildItem src", ["powershell"]],
      ["`ls`", "ls src", ["powershell", "bash"]],
      ["`rg --files`", "rg --files src", ["powershell", "bash"]],
      ["`rg`", "rg -n foo src", ["powershell", "bash"]],
      ["`Select-String`", "Select-String -Pattern foo -Path a.txt", ["powershell"]],
    ]
    const permissions = CodexVariant.permissions("read-only", true)
    named.forEach(([name, command, shells]) => {
      expect([name, permissions.includes(name)]).toEqual([name, true])
      shells.forEach((shell) =>
        expect([command, shell, CodexReadOnly.parse(command, shell)]).not.toEqual([command, shell, undefined]),
      )
    })
    ;["head -n 5 a.txt", "tail -5 a.txt", "sed -n '1,5p' a.txt"].forEach((command) =>
      expect([command, ps(command)]).toEqual([command, undefined]),
    )
    expect(permissions).toContain("`cat`, `head`, `tail` or `sed -n` in bash, zsh or sh")
    const refused = CodexReadOnly.refused("Permission denied: shell")
    ;[...named, ["`Get-ChildItem -Recurse -File`", "Get-ChildItem -Recurse -File", ["powershell"]] as const].forEach(
      ([name]) => expect([name, refused.includes(name)]).toEqual([name, true]),
    )
    expect(refused).toContain("`cat`, `head`, `tail` or `sed -n` in bash, zsh or sh")
    expect(CodexReadOnly.parse("Get-ChildItem -Recurse -File", "powershell")).toBeDefined()
  })
})

describe("CodexReadOnly.serves", () => {
  const READ_ONLY = [
    { action: "edit", resource: "**", effect: "deny" },
    { action: "shell", resource: "**", effect: "deny" },
  ] as const
  const ASK = [
    { action: "edit", resource: "**", effect: "ask" },
    { action: "shell", resource: "**", effect: "ask" },
  ] as const
  const FULL = [
    { action: "edit", resource: "**", effect: "allow" },
    { action: "shell", resource: "**", effect: "allow" },
    { action: "webfetch", resource: "**", effect: "allow" },
  ] as const
  const PROTECTED = [
    { action: "read", resource: "C:/Users/me/.claude/.credentials.json", effect: "deny" },
    { action: "edit", resource: "C:/Users/me/.claude/.credentials.json", effect: "deny" },
  ] as const
  const absolute =
    process.platform === "win32"
      ? PROTECTED
      : PROTECTED.map((rule) => ({ ...rule, resource: "/home/me/.claude/.credentials.json" }))

  test("own's read-only bundle with its protected denies serves reads", () => {
    expect(CodexReadOnly.serves([...READ_ONLY, ...absolute])).toBe(true)
    expect(
      CodexReadOnly.serves([...READ_ONLY, ...absolute, { action: "browser", resource: "*", effect: "allow" }]),
    ).toBe(true)
  })

  test("own's ask bundle with its protected denies serves reads too (RO-D4, amended 2026-10-17)", () => {
    expect(CodexReadOnly.serves([...ASK, ...absolute])).toBe(true)
    expect(CodexReadOnly.serves([...ASK, ...absolute, { action: "browser", resource: "*", effect: "allow" }])).toBe(
      true,
    )
    // A switch from read-only to ask keeps serving; the last `{shell, **}` rule decides.
    expect(CodexReadOnly.serves([...READ_ONLY, ...absolute, ...ASK, ...absolute])).toBe(true)
  })

  test("full access, custom rule sets without protected denies and no rules serve nothing", () => {
    expect(CodexReadOnly.serves([...READ_ONLY])).toBe(false)
    expect(CodexReadOnly.serves([...absolute, ...READ_ONLY])).toBe(false)
    expect(CodexReadOnly.serves([...READ_ONLY, { action: "read", resource: "secret/**", effect: "deny" }])).toBe(false)
    expect(CodexReadOnly.serves([...ASK])).toBe(false)
    expect(CodexReadOnly.serves([...absolute, ...ASK])).toBe(false)
    expect(CodexReadOnly.serves([...ASK, { action: "read", resource: "secret/**", effect: "deny" }])).toBe(false)
    // Protected denies alone, without a `{shell, **}` rule (Fragments.mode reads that as ask), serve nothing.
    expect(CodexReadOnly.serves([...absolute])).toBe(false)
    expect(CodexReadOnly.serves([...FULL, ...absolute])).toBe(false)
    expect(CodexReadOnly.serves([...READ_ONLY, ...absolute, ...FULL, ...absolute])).toBe(false)
    expect(CodexReadOnly.serves([...READ_ONLY, ...absolute, { action: "shell", resource: "**", effect: "ask" }])).toBe(
      false,
    )
    expect(CodexReadOnly.serves(undefined)).toBe(false)
  })

  test("a later rule for shell makes the set custom and serves nothing; the harness's tool gate does not", () => {
    const deny = { action: "shell", resource: "Get-Content *", effect: "deny" } as const
    expect(CodexReadOnly.serves([...ASK, deny, ...absolute])).toBe(false)
    expect(CodexReadOnly.serves([...READ_ONLY, ...absolute, deny])).toBe(false)
    expect(CodexReadOnly.serves([...ASK, ...absolute, { action: "*", resource: "*", effect: "allow" }])).toBe(false)
    expect(CodexReadOnly.serves([...ASK, ...absolute, { action: "sh*", resource: "rg *", effect: "allow" }])).toBe(
      false,
    )
    // A rule before own's bundle is overridden by its `{shell, **}` rule.
    expect(CodexReadOnly.serves([deny, ...ASK, ...absolute])).toBe(true)
    // `Gate.rules` puts the harness's allow at the end, after own's bundle, when the session switches harness.
    expect(
      CodexReadOnly.serves([...ASK, ...absolute, { action: "own_harness_codex", resource: "*", effect: "allow" }]),
    ).toBe(true)
  })
})

describe("CodexReadOnly.answers: a no-shell role reads in every mode (decisions SA-1)", () => {
  const PROTECTED: Permission.Rule = {
    action: "read",
    resource:
      process.platform === "win32" ? "C:/Users/me/.claude/.credentials.json" : "/home/me/.claude/.credentials.json",
    effect: "deny",
  }
  const bundle = (effect: Permission.Rule["effect"]): Array<Permission.Rule> => [
    { action: "edit", resource: "**", effect },
    { action: "shell", resource: "**", effect },
    PROTECTED,
  ]

  test("`explore` gets its reads answered under full, ask, read-only and no own bundle; its mode reads read-only", () => {
    for (const rules of [bundle("allow"), bundle("ask"), bundle("deny"), [], undefined]) {
      expect(CodexReadOnly.answers(rules, "explore")).toBe(true)
      expect(Fragments.mode(rules, "explore")).toBe("read-only")
    }
  })

  test("other agents keep the mode's rule: full runs commands, ask and read-only answer reads", () => {
    for (const agent of ["build", "general", "own-review", undefined]) {
      expect([agent, CodexReadOnly.answers(bundle("allow"), agent)]).toEqual([agent, false])
      expect([agent, CodexReadOnly.answers(bundle("ask"), agent)]).toEqual([agent, true])
      expect([agent, CodexReadOnly.answers(bundle("deny"), agent)]).toEqual([agent, true])
      expect([agent, Fragments.mode(bundle("allow"), agent)]).toEqual([agent, "full"])
    }
  })

  test("the role's refusal names no core tool, and Pi's bash refusal names only bash shapes, each served in bash", () => {
    const reason = "This subagent role is read-only: it may not run shell commands. Use read, grep and glob instead."
    const role = CodexReadOnly.refused(reason, "explore")
    expect(role).toStartWith("exec_command was refused (this subagent role is read-only and may not run commands).")
    expect(role).not.toContain("Use read, grep and glob")
    expect(role).toContain("`workdir` instead of `cd`")
    // Read-only mode keeps its text for every other agent.
    expect(CodexReadOnly.refused("Permission denied: shell", "build")).toBe(
      CodexReadOnly.refused("Permission denied: shell"),
    )
    expect(CodexReadOnly.refused("Permission denied: shell")).toStartWith(
      "exec_command was refused (Permission denied: shell). In read-only approval mode own runs no commands;",
    )
    const bash = CodexReadOnly.refusedBash(reason, "explore")
    expect(bash).toStartWith("bash was refused (this subagent role is read-only and may not run commands).")
    expect(bash).not.toContain("PowerShell")
    expect(bash).not.toContain("workdir")
    expect(CodexReadOnly.refusedBash("Permission denied: shell")).toStartWith(
      "bash was refused (Permission denied: shell). In read-only approval mode",
    )
    for (const [name, command] of [
      ["`cat`", "cat a.txt"],
      ["`head`", "head -n 5 a.txt"],
      ["`tail`", "tail -5 a.txt"],
      ["`sed -n`", "sed -n '1,5p' a.txt"],
      ["`ls`", "ls src"],
      ["`rg --files`", "rg --files src"],
      ["`rg`", "rg -n foo src"],
    ] as const) {
      expect([name, bash.includes(name)]).toEqual([name, true])
      expect([command, sh(command)]).not.toEqual([command, undefined])
    }
  })
})
