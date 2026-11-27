// Vendored from packages/gui-plugins/src/ssh/command.test.ts @ dae4077a96 (MIT). See own/ledger/vendored.yaml
// own: adapted to the own changes of command.ts (tunnelArgs with host loopback and -R, the absolute ssh.exe path,
// the narrowed parser: `-F` is refused, identity files must live under %USERPROFILE%\.ssh). Marked "own:".
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import { NodeServices } from "@effect/platform-node"
import { testEffect } from "../../../core/test/lib/effect"
import {
  commandFailureDetail,
  MINIMAL_ENV_WINDOWS,
  minimalEnv,
  parseTarget,
  quote,
  sshArgs,
  sshExecutable,
  sshHosts,
  SshFailure,
  tunnelArgs,
  WINDOWS_SSH,
} from "../../src/vendor/ssh/command.js"

const it = testEffect(NodeServices.layer)

describe("SSH connection commands", () => {
  test("classifies a missing SSH executable from the platform error", () => {
    const error = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcessSpawner",
      method: "spawn",
      pathOrDescriptor: "ssh",
    })
    expect(SshFailure.from(error).code).toBe("ssh-missing")
  })
  // own: the tunnel binds the host loopback address and carries the broker -R (04 §7.1).
  test("forwarding disables multiplexing and keeps the session on `sh -s`", () => {
    const args = tunnelArgs({ host: "devbox", args: [] }, { address: "127.0.3.2", port: 1234 }, { host: "127.0.0.1", port: 5678 }, undefined)
    expect(args.slice(0, 4)).toEqual(["-o", "ControlMaster=no", "-o", "ControlPersist=no"])
    expect(args.slice(-4)).toEqual(["-L", "127.0.3.2:1234:127.0.0.1:5678", "devbox", "sh -s"])
  })
  test("retains CLI stdout failures without exposing private connection details", () => {
    expect(
      commandFailureDetail(1, {
        stdout:
          'OPENCODE_SSH_REGISTRATION_BEGIN\n{"password":"secret"}\nOPENCODE_SSH_REGISTRATION_END\nFailed to read next file',
        stderr: "",
      }),
    ).toBe("Failed to read next file")
    expect(
      commandFailureDetail(1, {
        stdout: 'OPENCODE_SSH_REGISTRATION_BEGIN\n{"password":"secret"}',
        stderr: "read interrupted",
      }),
    ).toBe("read interrupted")
    expect(commandFailureDetail(1, { stdout: "Server process terminated by SIGKILL\n", stderr: "" })).toBe(
      "Server process terminated by SIGKILL",
    )
    expect(commandFailureDetail(255, { stdout: "", stderr: "" })).toBe('{"exitCode":255}')
  })
  test("preserves aliases and connection options without invoking a shell", () => {
    // own: the identity file must be under the profile's .ssh; the profile is explicit here.
    expect(parseTarget('ssh -p 2222 -i "~/.ssh/work key" -J gateway user@devbox', { profile: "C:\\Users\\u" })).toEqual({
      host: "user@devbox",
      args: ["-p", "2222", "-i", "~/.ssh/work key", "-J", "gateway"],
    })
    expect(parseTarget("devbox")).toEqual({ host: "devbox", args: [] })
    expect(parseTarget("ssh user@[::1]").host).toBe("user@[::1]")
    expect(sshArgs(parseTarget("devbox"))).toContain("PermitLocalCommand=no")
  })
  test("rejects remote commands, shell syntax, and transport overrides", () => {
    for (const input of [
      "",
      "ssh host whoami",
      "host;whoami",
      "ssh user:password@host",
      "ssh -t host",
      "ssh -o RemoteCommand=whoami host",
      "ssh -L 1234:x:80 host",
      "ssh -p 70000 host",
      'ssh -i "key host',
      "host\nwhoami",
      // own: refused since the vendor copy (04 §7.2)
      "ssh -F cfg host",
      "ssh -o ProxyCommand=x host",
      "ssh -o IdentityAgent=x host",
    ]) {
      expect(() => parseTarget(input)).toThrow()
    }
    expect(quote("a'b")).toBe("'a'\\''b'")
  })
  // own: absolute inbox OpenSSH on Windows (04 §14.1).
  test("uses the absolute Windows OpenSSH path", () => {
    if (process.platform === "win32") expect(sshExecutable()).toBe(WINDOWS_SSH)
    else expect(sshExecutable()).toBe("ssh")
  })
  // own: the minimal child environment (04 §14.4). Win32-OpenSSH exits 255 without output when `ProgramData` is
  // missing (it resolves `__PROGRAMDATA__\ssh` from it), so the Windows list must carry it (real-host finding).
  test("the minimal ssh environment keeps ProgramData on Windows and drops everything else", () => {
    const source = {
      SYSTEMROOT: "C:\\Windows",
      ProgramData: "C:\\ProgramData",
      Path: "C:\\Windows\\System32",
      USERPROFILE: "C:\\Users\\u",
      TEMP: "C:\\t",
      OPENCODE_SERVER_PASSWORD: "never",
      OPENAI_API_KEY: "never",
    }
    const env = minimalEnv(source)
    expect(MINIMAL_ENV_WINDOWS).toContain("ProgramData")
    if (process.platform === "win32") {
      expect(env).toEqual({
        SystemRoot: "C:\\Windows",
        ProgramData: "C:\\ProgramData",
        PATH: "C:\\Windows\\System32",
        USERPROFILE: "C:\\Users\\u",
        TEMP: "C:\\t",
      })
      // The real ssh.exe starts with it (`-G` needs no network); without ProgramData it would exit 255 silently.
      if (existsSync(WINDOWS_SSH)) {
        const result = spawnSync(WINDOWS_SSH, ["-G", "example.invalid"], { env: minimalEnv(), encoding: "utf8", windowsHide: true })
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("hostname example.invalid")
      }
    }
    expect(JSON.stringify(env)).not.toContain("never")
  })
  it.live(
    "discovers Include aliases without wildcards or recursion",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ssh-config-test-" })
      yield* fs.makeDirectory(path.join(dir, "hosts"))
      yield* fs.writeFileString(path.join(dir, "config"), "Host work other\nHost * !excluded\nInclude hosts/*\n")
      yield* fs.writeFileString(path.join(dir, "hosts", "extra"), "Host deploy\nInclude ../config\n")
      expect(yield* sshHosts(path.join(dir, "config"))).toEqual(["deploy", "other", "work"])
    }),
  )
})
