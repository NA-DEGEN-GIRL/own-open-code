import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { RemoteModel } from "../../src/remote/model.js"
import { Scripts } from "../../src/remote/scripts.js"
import { quote } from "../../src/vendor/ssh/command.js"
import * as Harness from "../harness/remote.js"

describe("script prelude and parsers", () => {
  test("parameters are single-quoted; nothing in a value is evaluated", () => {
    const text = Scripts.prelude({ OWN_X: `it's $(touch /tmp/x) \`id\` "q" $HOME` })
    expect(text).toBe(`OWN_X='it'\\''s $(touch /tmp/x) \`id\` "q" $HOME'`)
    expect(() => Scripts.prelude({ "bad-name": "x" })).toThrow()
    expect(() => Scripts.prelude({ OWN_X: "a\0b" })).toThrow()
  })

  test("reports: only PREFIX_KEY lines count, the last value wins, noise is dropped", () => {
    const report = Scripts.parseReport(
      "Welcome to Ubuntu\nOWN_INSPECT_OS=hacked\nOWN_INSPECT_OS=linux\nrandom=1\nOWN_INSPECT_PATH=/a=b\n",
      "OWN_INSPECT",
    )
    expect(report.get("OS")).toBe("linux")
    expect(report.get("PATH")).toBe("/a=b")
    expect(report.has("random")).toBe(false)
    expect(Scripts.parseResult("OWN_ENSURE_PORT=1\nOWN_ENSURE=ready\n", "OWN_ENSURE")).toBe("ready")
  })

  test("registration: only the block named by the status line, only 127.0.0.1 or [::1] (04 §6.1 step 7)", () => {
    const block = (url: string, pid = 7) =>
      `OPENCODE_SSH_REGISTRATION_BEGIN\n${JSON.stringify({ url, password: "pw", version: "2.0.18-own.1", pid })}\nOPENCODE_SSH_REGISTRATION_END\n`
    const ok = RemoteModel.parseRegistration(`OPENCODE_SSH_STATUS=http://127.0.0.1:31872\n${block("http://127.0.0.1:31872")}`)
    expect(ok).toMatchObject({ url: "http://127.0.0.1:31872", pid: 7 })
    expect(RemoteModel.parseRegistration(`OPENCODE_SSH_STATUS=http://[::1]:5\n${block("http://[::1]:5")}`)).toMatchObject({ pid: 7 })
    expect(RemoteModel.parseRegistration(`OPENCODE_SSH_STATUS=http://0.0.0.0:5\n${block("http://0.0.0.0:5")}`)).toBe("not_loopback")
    expect(RemoteModel.parseRegistration(`OPENCODE_SSH_STATUS=http://[::]:5\n${block("http://[::]:5")}`)).toBe("not_loopback")
    expect(RemoteModel.parseRegistration(`OPENCODE_SSH_STATUS=http://127.0.0.1:9\n${block("http://127.0.0.1:8")}`)).toBeUndefined()
    expect(RemoteModel.parseRegistration(block("http://127.0.0.1:8"))).toBeUndefined()
  })

  test("the install script survives any login shell: no single quote, no backslash, strict parameters", () => {
    const script = Scripts.install({
      ownHome: "/home/u/.local/share/own-open-code",
      version: "2.0.18-own.3",
      sums: "ab  opencode\ncd  plugins/own-remote/index.js",
      setCurrent: true,
    })
    expect(script.includes("'")).toBe(false)
    expect(script.includes("\\")).toBe(false)
    expect(quote(script)).toBe(`'${script}'`)
    expect(() => Scripts.install({ ownHome: "/home/u/$(x)", version: "1.0.0", sums: "", setCurrent: false })).toThrow()
    expect(() => Scripts.install({ ownHome: "/home/u", version: "local", sums: "", setCurrent: false })).toThrow()
  })

  test("the tool script follows the install rules: no single quote, no backslash, strict names (06 §4.13)", () => {
    const params = {
      ownHome: "/home/u/.local/share/own-open-code",
      tool: "git-lfs",
      version: "3.8.0",
      binary: "git-lfs",
      sums: "ab  LICENSE.md\ncd  git-lfs",
      files: [
        { name: "LICENSE.md", bytes: 20 },
        { name: "git-lfs", bytes: 300 },
      ],
    }
    for (const script of [Scripts.tool(params), Scripts.tool({ ...params, files: [] })]) {
      expect(script.includes("'")).toBe(false)
      expect(script.includes("\\")).toBe(false)
      expect(script.includes("\r")).toBe(false)
      expect(script).not.toContain("sudo")
      expect(quote(script)).toBe(`'${script}'`)
    }
    expect(Scripts.tool(params)).toContain('OWN_T_FILES="LICENSE.md:20 git-lfs:300"')
    expect(() => Scripts.tool({ ...params, ownHome: "/home/u/$(x)" })).toThrow()
    expect(() => Scripts.tool({ ...params, files: [{ name: "../x", bytes: 1 }] })).toThrow()
    expect(() => Scripts.tool({ ...params, binary: "git lfs" })).toThrow()
  })

  test("every generated script is LF-only", () => {
    for (const text of [Scripts.inspect(), Scripts.startScript, Scripts.prepareSocketDir("/tmp/own-1/abcd")]) {
      expect(text.includes("\r")).toBe(false)
    }
  })

  test("keep removes this epoch's broker and egress sockets, nothing else (04 §7.4, §8.11.4.2)", () => {
    const script = Scripts.ensure({
      version: "2.0.18-own.1",
      ownHome: "/home/u/own",
      stateDir: "/home/u/state",
      configDir: "/home/u/cfg/own-open-code",
      upstreamConfigDir: "/home/u/cfg/opencode",
      identity: "",
      installId: "i",
      ownerJson: "{}",
      epoch: 10,
      socketDir: "/home/u/own/run",
      port: 31000,
      portMode: "default",
      envJson: "{}",
      managedConfig: "{}",
      shellEnv: "login",
      pathPrepend: "",
    })
    expect(script).toContain('own_sock="$OWN_E_SOCKDIR/broker-$OWN_E_EPOCH.sock"')
    expect(script).toContain('rm -f "$own_sock" "$OWN_E_SOCKDIR/egress-$OWN_E_EPOCH.sock"')
  })

  test("ops stops a service with TMPDIR=<OWN_HOME>/tmp (no /tmp/.bun-<uid>-* native modules)", () => {
    const script = Scripts.ops({
      ownHome: "/home/u/.local/share/own-open-code",
      stateDir: "/home/u/.local/state/opencode",
      dataDir: "/home/u/.local/share/opencode",
      configDir: "/home/u/.config/own-open-code",
      upstreamConfigDir: "/home/u/.config/opencode",
      opId: "op1",
      kind: "update",
      steps: ["stop"],
    })
    expect(script).toContain('TMPDIR="$OWN_O_HOME/tmp" "$OWN_O_HOME/app/$own_rv/opencode" service stop')
    expect(Scripts.startScript).toContain("export TMPDIR")
  })

  test("start.sh removes exactly the provider key variables of 04 §5.6", () => {
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "OPENCODE_CLAUDE_AUTH_X", "XAI_API_KEY"])
      expect(Scripts.isProviderEnv(name)).toBe(true)
    for (const name of ["PATH", "OPENCODE_CONFIG_DIR", "GITHUB_TOKEN", "OPENAI_ORG"]) expect(Scripts.isProviderEnv(name)).toBe(false)
  })
})

const posixShell = Harness.available ? describe : describe.skip

posixShell("scripts in a real POSIX shell (Git for Windows sh)", () => {
  let root: string
  let home: string
  let testRoot: string
  let shim: string
  const run = (script: string, env: Record<string, string> = {}) =>
    spawnSync(Harness.GIT_BASH, ["-c", "sh -s"], {
      input: script,
      encoding: "utf8",
      windowsHide: true,
      env: {
        HOME: Harness.toPosix(home),
        SHELL: "/usr/bin/bash",
        PATH: `${Harness.toPosix(shim)}:/usr/bin:/bin`,
        OWN_REMOTE_TEST_ROOT: Harness.toPosix(testRoot),
        MSYS: "winsymlinks:native",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
        ...env,
      },
    })

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-scripts-"))
    home = path.join(root, "home")
    testRoot = path.join(root, "t")
    shim = path.join(root, "shim")
    for (const dir of [home, path.join(testRoot, "etc"), path.join(testRoot, "proc"), shim]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(shim, "uname"), '#!/bin/sh\ncase "${1:-}" in -m) echo aarch64 ;; *) echo Linux ;; esac\n')
    fs.writeFileSync(path.join(testRoot, "etc", "machine-id"), "0123456789abcdef0123456789abcdef\n")
    // A noisy profile: banners, fake report lines, an XDG override for login shells, nvm only in interactive bash.
    fs.writeFileSync(
      path.join(home, ".bash_profile"),
      'echo "OWN_INSPECT_TARGET=windows-x64"\nexport XDG_DATA_HOME="$HOME/data"\n[ -f ~/.bashrc ] && . ~/.bashrc\n',
    )
    fs.writeFileSync(
      path.join(home, ".bashrc"),
      'echo "Welcome!"\ncase $- in *i*) export PATH="$HOME/.nvm/bin:$PATH" ;; esac\nexport OPENAI_API_KEY=sk-profile-secret\n',
    )
  })

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  test("inspect reports platform, identity, shell environments; profile noise cannot override it", () => {
    const result = run(Scripts.inspect())
    expect(result.status).toBe(0)
    const inspect = RemoteModel.parseInspect(result.stdout)
    expect(inspect.complete).toBe(true)
    expect(inspect.target).toBe("linux-arm64")
    expect(inspect.libc).toBe("glibc")
    expect(inspect.identity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(inspect.env.LOGIN.state).toBe("ok")
    expect(inspect.env.LOGIN.XDG_DATA_HOME).toBe(`${Harness.toPosix(home)}/data`)
    expect(inspect.env.INTERACTIVE.PATH?.includes("/.nvm/bin")).toBe(true)
    expect(inspect.env.LOGIN.PATH?.includes("/.nvm/bin")).toBe(false)
    // Only allow-listed keys leave the host: the profile's API key never appears in the report.
    expect(result.stdout.includes("sk-profile-secret")).toBe(false)
    const paths = RemoteModel.remotePaths(inspect, "login")
    expect(paths.ownHome).toBe(`${Harness.toPosix(home)}/data/own-open-code`)
    expect(paths.dataDir).toBe(`${Harness.toPosix(home)}/data/opencode`)
    expect(RemoteModel.warnings(inspect, "login")).toContain("path_differs_interactive")
    expect(RemoteModel.warnings(inspect, "login-interactive")).not.toContain("path_differs_interactive")
  }, 60_000)

  test("host identity follows /etc/machine-id, uid and HOME (04 §2)", () => {
    const first = RemoteModel.parseInspect(run(Scripts.inspect()).stdout).identity
    fs.writeFileSync(path.join(testRoot, "etc", "machine-id"), "ffffffffffffffffffffffffffffffff\n")
    const second = RemoteModel.parseInspect(run(Scripts.inspect()).stdout).identity
    expect(second).not.toBe(first)
    // Two inspects of 15–40 s each in Git for Windows' sh on a loaded PC (60 s timed out; LFS-5 saw 52 s of 60 s).
  }, 120_000)

  test("ensure stops before writing anything when the identity differs", () => {
    const ownHome = `${Harness.toPosix(home)}/own`
    const result = run(
      Scripts.ensure({
        version: "2.0.18-own.1",
        ownHome,
        stateDir: `${Harness.toPosix(home)}/state/opencode`,
        configDir: `${Harness.toPosix(home)}/cfg/own-open-code`,
        upstreamConfigDir: `${Harness.toPosix(home)}/cfg/opencode`,
        identity: "sha256:0000",
        installId: "i1",
        ownerJson: '{"installId":"i1"}',
        epoch: 5,
        socketDir: "",
        port: 31000,
        portMode: "default",
        envJson: "{}",
        managedConfig: "{}",
        shellEnv: "login",
        pathPrepend: "",
      }),
    )
    const report = RemoteModel.parseEnsure(result.stdout)
    expect(report.result).toBe("host_identity_changed")
    expect(fs.existsSync(Harness.toWindows(ownHome))).toBe(false)
    expect(fs.existsSync(path.join(home, "cfg"))).toBe(false)
  }, 30_000)

  test("ensure: other owner, stale epoch and a non-loopback hostname stop it", () => {
    const ownHome = `${Harness.toPosix(home)}/own2`
    const base = {
      version: "2.0.18-own.1",
      ownHome,
      stateDir: `${Harness.toPosix(home)}/state2/opencode`,
      configDir: `${Harness.toPosix(home)}/cfg2/own-open-code`,
      upstreamConfigDir: `${Harness.toPosix(home)}/cfg2/opencode`,
      identity: "",
      installId: "mine",
      ownerJson: '{"installId":"mine","label":"pc"}',
      socketDir: "",
      port: 31000,
      portMode: "default" as const,
      envJson: "{}",
      managedConfig: "{}",
      shellEnv: "login" as const,
      pathPrepend: "",
      start: false,
    }
    fs.mkdirSync(path.join(Harness.toWindows(ownHome), "run"), { recursive: true })
    fs.writeFileSync(path.join(Harness.toWindows(ownHome), "run", "owner.json"), '{"installId":"theirs","label":"other-pc"}')
    const other = RemoteModel.parseEnsure(run(Scripts.ensure({ ...base, epoch: 10 })).stdout)
    expect(other.result).toBe("other_owner")
    expect(other.ownerLabel).toBe("other-pc")
    fs.rmSync(path.join(Harness.toWindows(ownHome), "run", "owner.json"))
    fs.writeFileSync(path.join(Harness.toWindows(ownHome), "run", "broker.current"), "99\n")
    const stale = RemoteModel.parseEnsure(run(Scripts.ensure({ ...base, epoch: 10 })).stdout)
    expect(stale.result).toBe("stale_epoch")
    expect(stale.staleEpoch).toBe(99)
    // the higher epoch works, writes broker.current and the config files, and (start=false) reports "stopped"
    const next = RemoteModel.parseEnsure(run(Scripts.ensure({ ...base, epoch: 100 })).stdout)
    expect(next.result).toBe("stopped")
    expect(fs.readFileSync(path.join(Harness.toWindows(ownHome), "run", "broker.current"), "utf8").trim()).toBe("100")
    const svc = path.join(home, "cfg2", "opencode", "service-own.json")
    expect(JSON.parse(fs.readFileSync(svc, "utf8"))).toEqual({ hostname: "127.0.0.1", port: 31000, env: {} })
    // the user's password is preserved; a LAN hostname stops ensure
    fs.writeFileSync(svc, JSON.stringify({ hostname: "0.0.0.0", port: 31000, password: "abc_DEF-123" }))
    const lan = RemoteModel.parseEnsure(run(Scripts.ensure({ ...base, epoch: 101 })).stdout)
    expect(lan.result).toBe("service_not_loopback")
    fs.writeFileSync(svc, JSON.stringify({ hostname: "127.0.0.1", port: 32000, password: "abc_DEF-123" }))
    const kept = RemoteModel.parseEnsure(run(Scripts.ensure({ ...base, epoch: 102 })).stdout)
    expect(kept.result).toBe("stopped")
    expect(kept.port).toBe(32000)
    expect(JSON.parse(fs.readFileSync(svc, "utf8"))).toEqual({ hostname: "127.0.0.1", port: 32000, password: "abc_DEF-123", env: {} })
  }, 60_000)

  test("ensure removes only lower-epoch sockets", () => {
    const ownHome = `${Harness.toPosix(home)}/own3`
    const run3 = path.join(Harness.toWindows(ownHome), "run")
    fs.mkdirSync(run3, { recursive: true })
    for (const epoch of [3, 9, 10, 11]) {
      fs.writeFileSync(path.join(run3, `broker-${epoch}.sock`), "")
      fs.writeFileSync(path.join(run3, `egress-${epoch}.sock`), "")
    }
    const result = RemoteModel.parseEnsure(
      run(
        Scripts.ensure({
          version: "2.0.18-own.1",
          ownHome,
          stateDir: `${Harness.toPosix(home)}/state3/opencode`,
          configDir: `${Harness.toPosix(home)}/cfg3/own-open-code`,
          upstreamConfigDir: `${Harness.toPosix(home)}/cfg3/opencode`,
          identity: "",
          installId: "i",
          ownerJson: "{}",
          epoch: 10,
          socketDir: ownHome + "/run",
          port: 31000,
          portMode: "default",
          envJson: "{}",
          managedConfig: "{}",
          shellEnv: "login",
          pathPrepend: "",
          start: false,
        }),
      ).stdout,
    )
    expect(result.result).toBe("stopped")
    // The Claude egress relay's sockets (04 §8.11.4.2) follow the broker's: only lower epochs go.
    expect(fs.readdirSync(run3).filter((name) => name.endsWith(".sock")).sort()).toEqual([
      "broker-10.sock",
      "broker-11.sock",
      "egress-10.sock",
      "egress-11.sock",
    ])
    // The ensure script starts a few dozen Git Bash processes (login shells, version reads): 20-25 s alone on this PC,
    // past 30 s while other sessions' shells kept it busy (2.2.6-own.15 tier), like the uname probe of RL23-T.
  }, 120_000)

  // The tool script runs like install: `sh -c '<script>'` from the login shell, the files on stdin (06 §4.13).
  const LFS = "3.8.0"
  const LICENSE = "MIT License (test)\n"
  const fakeLfs = (reports: string) =>
    `#!/bin/sh\ncase "\${1:-}" in\n  version) echo "git-lfs/${reports} (GitHub; linux amd64; go 1.24.4)"; exit 0 ;;\nesac\nexit 2\n`
  const toolInput = (ownHome: string, binary: string, version = LFS, sums?: string) => {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex")
    return {
      params: {
        ownHome,
        tool: "git-lfs",
        version,
        binary: "git-lfs",
        sums: sums ?? `${sha(LICENSE)}  LICENSE.md\n${sha(binary)}  git-lfs`,
        files: [
          { name: "LICENSE.md", bytes: Buffer.byteLength(LICENSE) },
          { name: "git-lfs", bytes: Buffer.byteLength(binary) },
        ],
      },
      payload: Buffer.from(LICENSE + binary),
    }
  }
  const runTool = (script: string, payload: Uint8Array | string = "", extraPath?: string) =>
    spawnSync(Harness.GIT_BASH, ["-c", `sh -c ${quote(script)}`], {
      input: payload,
      encoding: "utf8",
      windowsHide: true,
      env: {
        HOME: Harness.toPosix(home),
        SHELL: "/usr/bin/bash",
        PATH: `${extraPath ? `${Harness.toPosix(extraPath)}:` : ""}${Harness.toPosix(shim)}:/usr/bin:/bin`,
        MSYS: "winsymlinks:native",
        SYSTEMROOT: process.env.SYSTEMROOT ?? "C:\\Windows",
      },
    })
  const bash = (command: string) =>
    spawnSync(Harness.GIT_BASH, ["-c", command], {
      encoding: "utf8",
      windowsHide: true,
      env: { MSYS: "winsymlinks:native", PATH: "/usr/bin:/bin" },
    })
  const linked = (ownHome: string) =>
    bash(`readlink ${quote(`${ownHome}/tools/git-lfs/current`)}`)
      .stdout.trim()
      .replace(/\/+$/, "")
  const outcome = (result: ReturnType<typeof runTool>) => ({
    result: Scripts.parseResult(result.stdout, "OWN_TOOL"),
    report: Scripts.parseReport(result.stdout, "OWN_TOOL"),
  })

  test("uninstall gives each listed repository its own LFS filter back before tools/ goes (06 §4.13)", () => {
    const ownHome = `${Harness.toPosix(home)}/own-uninstall`
    const own = Harness.toWindows(ownHome)
    const tools = `${ownHome}/tools/git-lfs/current`
    const local = (repo: string, ...args: string[]) =>
      spawnSync("git", ["-C", repo, "config", "--local", ...args], { encoding: "utf8", windowsHide: true })
    const repo = (name: string, filter: string) => {
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      spawnSync("git", ["init", "-q", dir], { windowsHide: true })
      local(dir, "filter.lfs.process", filter)
      local(dir, "filter.lfs.smudge", `'${tools}/git-lfs' smudge -- %f`)
      local(dir, "filter.lfs.required", "true")
      local(dir, "own-team-lfs.process", "git-lfs filter-process")
      local(dir, "own-team-lfs.saved", "true")
      return dir
    }
    // Own's filter with the user's earlier `process` kept; and one whose filter someone changed since.
    const ours = repo("lfs-ours", `'${tools}/git-lfs' filter-process`)
    const theirs = repo("lfs-theirs", "their-lfs filter-process")
    fs.mkdirSync(path.join(own, "tools", "git-lfs", "3.8.0"), { recursive: true })
    fs.writeFileSync(
      path.join(own, "tools", "git-lfs", "repos"),
      [ours, theirs].map((dir) => `${Harness.toPosix(path.join(dir, ".git"))}\n`).join(""),
    )
    const result = run(
      Scripts.ops({
        ownHome,
        stateDir: `${Harness.toPosix(home)}/state-u/opencode`,
        dataDir: `${Harness.toPosix(home)}/data-u/opencode`,
        configDir: `${Harness.toPosix(home)}/config-u/own-open-code`,
        upstreamConfigDir: `${Harness.toPosix(home)}/config-u/opencode`,
        opId: "op_uninstall",
        kind: "forget",
        steps: ["uninstall"],
      }),
      // Git for Windows' git: `/mingw64/bin` up to 2.55, `/ucrt64/bin` from 2.56.
      { PATH: "/ucrt64/bin:/mingw64/bin:/usr/bin:/bin" },
    )
    expect(result.stdout).toContain("OWN_OPS_STEP=uninstall:ok")
    expect(local(ours, "--get", "filter.lfs.process").stdout.trim()).toBe("git-lfs filter-process")
    expect(local(ours, "--get", "filter.lfs.smudge").status).toBe(1)
    expect(local(ours, "--get", "filter.lfs.required").status).toBe(1)
    expect(local(theirs, "--get", "filter.lfs.process").stdout.trim()).toBe("their-lfs filter-process")
    for (const dir of [ours, theirs]) expect(local(dir, "--get-regexp", "^own-team-lfs\\.").status).toBe(1)
    expect(fs.existsSync(path.join(own, "tools"))).toBe(false)
    // About 5 s alone, 6–9 s under load (several git and bash processes on Windows); past 30 s once while other
    // sessions ran live harness work beside the e2e tier (SLM, 2026-11-23), like RL23-T's and RL24-T's.
  }, 120_000)

  test("tool: looks without writing, uploads (sha256sum -c, chmod 755, version), points current at it, then finds it present", () => {
    const ownHome = `${Harness.toPosix(home)}/own-tools`
    const input = toolInput(ownHome, fakeLfs(LFS))
    const looked = outcome(runTool(Scripts.tool({ ...input.params, files: [] })))
    expect(looked.result).toBe("missing")
    expect(Number(looked.report.get("FREE_KB"))).toBeGreaterThan(0)
    // No version of the tool yet: no CURRENT (an update's refresh leaves such a host alone, LFS-3).
    expect(looked.report.has("CURRENT")).toBe(false)
    expect(fs.existsSync(Harness.toWindows(ownHome))).toBe(false)

    const uploaded = outcome(runTool(Scripts.tool(input.params), input.payload))
    expect(uploaded.result).toBe("uploaded")
    expect(uploaded.report.get("DONE")).toBe("1")
    expect(uploaded.report.get("PATH")).toBe(`${ownHome}/tools/git-lfs/current`)
    expect(uploaded.report.get("VERSION")).toBe(LFS)
    const root = path.join(Harness.toWindows(ownHome), "tools", "git-lfs")
    expect(fs.readFileSync(path.join(root, LFS, "git-lfs"), "utf8")).toBe(fakeLfs(LFS))
    expect(fs.readFileSync(path.join(root, LFS, "LICENSE.md"), "utf8")).toBe(LICENSE)
    expect(fs.readFileSync(path.join(root, LFS, ".verified"), "utf8")).toContain("  git-lfs")
    // No stage directory is left behind.
    expect(fs.readdirSync(root).sort()).toEqual([LFS, "current"])
    expect(linked(ownHome)).toBe(LFS)
    expect(bash(`${quote(`${ownHome}/tools/git-lfs/current/git-lfs`)} version`).stdout).toContain(`git-lfs/${LFS} `)

    expect(outcome(runTool(Scripts.tool({ ...input.params, files: [] }))).result).toBe("present")
    // An upload that lost a race with another one drains its payload and reports present.
    expect(outcome(runTool(Scripts.tool(input.params), input.payload)).result).toBe("present")
  }, 60_000)

  test("tool: a new version replaces the current link and keeps the previous folder", () => {
    const ownHome = `${Harness.toPosix(home)}/own-tools2`
    const first = toolInput(ownHome, fakeLfs(LFS))
    expect(outcome(runTool(Scripts.tool(first.params), first.payload)).result).toBe("uploaded")
    const next = toolInput(ownHome, fakeLfs("3.9.0"), "3.9.0")
    // A look for the new version names the one the host runs now (LFS-3: an update replaces it).
    const looked = outcome(runTool(Scripts.tool({ ...next.params, files: [] })))
    expect(looked.result).toBe("missing")
    expect(looked.report.get("CURRENT")).toBe(LFS)
    expect(outcome(runTool(Scripts.tool(next.params), next.payload)).result).toBe("uploaded")
    expect(linked(ownHome)).toBe("3.9.0")
    expect(bash(`${quote(`${ownHome}/tools/git-lfs/current/git-lfs`)} version`).stdout).toContain("git-lfs/3.9.0 ")
    expect(fs.existsSync(path.join(Harness.toWindows(ownHome), "tools", "git-lfs", LFS, ".verified"))).toBe(true)
  }, 60_000)

  test("tool: checksum, version, noexec and a full disk are declared outcomes; nothing is installed", () => {
    const ownHome = `${Harness.toPosix(home)}/own-tools3`
    const root = path.join(Harness.toWindows(ownHome), "tools", "git-lfs")
    const installed = () => (fs.existsSync(root) ? fs.readdirSync(root) : [])

    const checksum = toolInput(ownHome, fakeLfs(LFS), LFS, `${"0".repeat(64)}  LICENSE.md\n${"0".repeat(64)}  git-lfs`)
    const bad = outcome(runTool(Scripts.tool(checksum.params), checksum.payload))
    expect(bad).toMatchObject({ result: "install_failed" })
    expect(bad.report.get("DETAIL")).toBe("checksum")

    const other = toolInput(ownHome, fakeLfs("3.7.1"))
    const wrong = outcome(runTool(Scripts.tool(other.params), other.payload))
    expect(wrong.result).toBe("install_failed")
    expect(wrong.report.get("DETAIL")).toBe("version git-lfs/3.7.1")

    // A noexec mount: the shell cannot run the file (126).
    const noexec = toolInput(ownHome, "#!/bin/sh\nexit 126\n")
    expect(outcome(runTool(Scripts.tool(noexec.params), noexec.payload)).result).toBe("noexec")

    // A full disk: writing the last file fails with ENOSPC.
    const full = path.join(root, "..", "..", "..", "full-shim")
    fs.mkdirSync(full, { recursive: true })
    fs.writeFileSync(
      path.join(full, "cat"),
      '#!/bin/sh\necho "cat: write error: No space left on device" >&2\nexit 1\n',
    )
    const disk = toolInput(ownHome, fakeLfs(LFS))
    const filled = outcome(runTool(Scripts.tool(disk.params), disk.payload, full))
    expect(filled.result).toBe("disk_full")
    expect(filled.report.get("DETAIL")).toBe("upload")

    expect(installed()).toEqual([])
  }, 60_000)

  // Bun extracts its native modules under TMPDIR (`/tmp/.bun-<uid>-*.so` without one): every own Bun binary the
  // scripts run gets TMPDIR=<OWN_HOME>/tmp, a 0700 directory they create first.
  const tmpdirProbe = (version: string, record: string) =>
    [
      "#!/bin/sh",
      `printf '%s|%s|%s' "\${TMPDIR:-unset}" "\${ANTHROPIC_API_KEY:-}" "$*" > "$HOME/${record}"`,
      `case "\${1:-}" in --version) echo "opencode ${version}" ;; esac`,
      "exit 0",
      "",
    ].join("\n")

  test("install checks the new opencode's version with TMPDIR=<OWN_HOME>/tmp", () => {
    const ownHome = `${Harness.toPosix(home)}/own-tmpdir`
    const version = "2.0.24-own.9"
    const stage = path.join(root, "tmpdir-bundle")
    fs.mkdirSync(stage, { recursive: true })
    const opencode = tmpdirProbe(version, "install-tmpdir")
    fs.writeFileSync(path.join(stage, "opencode"), opencode)
    const archive = path.join(root, "tmpdir-bundle.tgz")
    spawnSync(Harness.WINDOWS_TAR, ["-czf", archive, "-C", stage, "opencode"], { windowsHide: true })
    const sums = `${createHash("sha256").update(opencode).digest("hex")}  opencode`
    const result = runTool(Scripts.install({ ownHome, version, sums, setCurrent: true }), fs.readFileSync(archive))
    expect(Scripts.parseResult(result.stdout, "OWN_INSTALL")).toBe("installed")
    expect(fs.readFileSync(path.join(home, "install-tmpdir"), "utf8")).toBe(`${ownHome}/tmp||--version`)
    expect(fs.statSync(path.join(Harness.toWindows(ownHome), "tmp")).isDirectory()).toBe(true)
  }, 60_000)

  test("start.sh starts the service with TMPDIR=<OWN_HOME>/tmp and without provider keys", () => {
    const ownHome = `${Harness.toPosix(home)}/own-start`
    const app = `${ownHome}/app/2.0.24-own.9`
    fs.mkdirSync(path.join(Harness.toWindows(app), "libexec"), { recursive: true })
    fs.writeFileSync(path.join(Harness.toWindows(app), "libexec", "start.sh"), Scripts.startScript)
    fs.writeFileSync(path.join(Harness.toWindows(app), "opencode"), tmpdirProbe("2.0.24-own.9", "start-tmpdir"))
    const result = run(`OWN_APP=${quote(app)} exec /bin/sh ${quote(`${app}/libexec/start.sh`)}\n`, {
      ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key",
      TMPDIR: "/tmp",
    })
    expect(result.status).toBe(0)
    const [tmpdir, key, args] = fs.readFileSync(path.join(home, "start-tmpdir"), "utf8").split("|")
    expect(path.resolve(Harness.toWindows(tmpdir!)).toLowerCase()).toBe(
      path.join(Harness.toWindows(ownHome), "tmp").toLowerCase(),
    )
    expect(key).toBe("")
    expect(args).toBe("service start")
    expect(fs.statSync(path.join(Harness.toWindows(ownHome), "tmp")).isDirectory()).toBe(true)
  }, 30_000)

  test("start.sh adds the loopback to the login shell's NO_PROXY, keeping its entries (04 §8.11.14)", () => {
    const ownHome = `${Harness.toPosix(home)}/own-noproxy`
    const app = `${ownHome}/app/2.0.24-own.9`
    fs.mkdirSync(path.join(Harness.toWindows(app), "libexec"), { recursive: true })
    fs.writeFileSync(path.join(Harness.toWindows(app), "libexec", "start.sh"), Scripts.startScript)
    fs.writeFileSync(
      path.join(Harness.toWindows(app), "opencode"),
      `#!/bin/sh\nprintf '%s|%s' "\${NO_PROXY:-}" "\${no_proxy:-}" > "$HOME/start-noproxy"\n`,
    )
    const start = (env: Record<string, string>) => {
      const result = run(`OWN_APP=${quote(app)} exec /bin/sh ${quote(`${app}/libexec/start.sh`)}\n`, env)
      expect(result.status).toBe(0)
      return fs.readFileSync(path.join(home, "start-noproxy"), "utf8")
    }
    expect(start({ NO_PROXY: "corp.example,.internal" })).toBe(
      "corp.example,.internal,127.0.0.1,localhost|corp.example,.internal,127.0.0.1,localhost",
    )
    expect(start({ no_proxy: "localhost" })).toBe("localhost,127.0.0.1|localhost,127.0.0.1")
    expect(start({})).toBe("127.0.0.1,localhost|127.0.0.1,localhost")
  }, 30_000)

  test("start.sh drops the login shell's OpenTelemetry exporter settings (decisions TLM)", () => {
    const ownHome = `${Harness.toPosix(home)}/own-otel`
    const app = `${ownHome}/app/2.0.24-own.9`
    fs.mkdirSync(path.join(Harness.toWindows(app), "libexec"), { recursive: true })
    fs.writeFileSync(path.join(Harness.toWindows(app), "libexec", "start.sh"), Scripts.startScript)
    fs.writeFileSync(
      path.join(Harness.toWindows(app), "opencode"),
      `#!/bin/sh\nprintf '%s|%s|%s' "\${OTEL_EXPORTER_OTLP_ENDPOINT:-}" "\${OTEL_RESOURCE_ATTRIBUTES:-}" "\${KEEP_ME:-}" > "$HOME/start-otel"\n`,
    )
    const result = run(`OWN_APP=${quote(app)} exec /bin/sh ${quote(`${app}/libexec/start.sh`)}\n`, {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid:4318",
      OTEL_RESOURCE_ATTRIBUTES: "user=someone",
      KEEP_ME: "kept",
    })
    expect(result.status).toBe(0)
    expect(fs.readFileSync(path.join(home, "start-otel"), "utf8")).toBe("||kept")
  }, 30_000)
})
