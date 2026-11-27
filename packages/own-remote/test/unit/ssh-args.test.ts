// SEC-2 (04 §7.2, §15): own-remote's ssh does not forward the user's agent or X11 to a remote host. The one way back is
// an `-A` the user writes on the target line: upstream's syntax, kept as that host's explicit choice.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Liveness } from "../../src/ssh/liveness.js"
import { minimalEnv, parseTarget, shortArgs, sshArgs, sshExecutable, tunnelArgs } from "../../src/vendor/ssh/command.js"

const PROFILE = "C:\\Users\\tester"
const OFF = ["-o", "ForwardAgent=no", "-o", "ForwardX11=no"]
const SSH = Bun.which(sshExecutable())
const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-ssh-args-"))

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const target = parseTarget("ssh -p 2222 -o ConnectTimeout=5 devbox", { profile: PROFILE })
const tunnel = tunnelArgs(target, { address: "127.0.3.2", port: 24817 }, { host: "127.0.0.1", port: 31872 }, undefined)

describe("ssh arguments turn agent and X11 forwarding off (04 §7.2)", () => {
  test("short commands, -G and the tunnel carry both options ahead of the target's own options", () => {
    for (const args of [sshArgs(target), shortArgs(target), tunnel]) {
      const at = args.findIndex((_, index) => OFF.every((item, offset) => args[index + offset] === item))
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThan(args.indexOf("-p"))
    }
  })

  test("a UI target line cannot turn forwarding back on with -o, -X or -Y; an explicit -A is kept", () => {
    for (const input of [
      "ssh -o ForwardAgent=yes devbox",
      "ssh -o ForwardX11=yes devbox",
      "ssh -o ForwardX11Trusted=yes devbox",
      "ssh -X devbox",
      "ssh -Y devbox",
    ])
      expect(() => parseTarget(input, { profile: PROFILE })).toThrow()
    expect(parseTarget("ssh -A devbox", { profile: PROFILE })).toEqual({ host: "devbox", args: ["-A"] })
  })

  // The real OpenSSH resolves the options without connecting (`-G`); the temp config stands for a user config with
  // `ForwardAgent yes`, which is common. `-F` also keeps the user's and the system's config out of the run.
  test.skipIf(SSH === null)("ssh -G: the command line wins over a config that forwards both", () => {
    const config = path.join(root, "config")
    fs.writeFileSync(config, "Host devbox\n  HostName devbox.test\n  ForwardAgent yes\n  ForwardX11 yes\n")
    const resolve = (args: string[]) => {
      const result = Bun.spawnSync([SSH!, "-F", config, "-G", ...args], { env: minimalEnv(), windowsHide: true })
      expect(result.exitCode).toBe(0)
      return result.stdout
        .toString()
        .split(/\r?\n/)
        .filter((line) => /^forward(agent|x11) /.test(line))
        .sort()
    }
    expect(resolve(["devbox"])).toEqual(["forwardagent yes", "forwardx11 yes"])
    for (const args of [[...sshArgs(target), target.host], tunnel])
      expect(resolve(args)).toEqual(["forwardagent no", "forwardx11 no"])
    // OpenSSH applies -A over the earlier -o: the target line's -A is the user's choice for that host.
    const explicit = parseTarget("ssh -A devbox", { profile: PROFILE })
    expect(resolve([...sshArgs(explicit), explicit.host])).toEqual(["forwardagent yes", "forwardx11 no"])
  })
})

// 04 §6.3 "죽은 링크": the tunnel notices a silent link after 12 s (ssh's keepalive every 4 s, 2 unanswered), short
// commands keep upstream's 15 s × 3 so a slow upload (install, update) is not cut.
describe("ssh keepalive: fast on the tunnel, upstream's on short commands", () => {
  test.skipIf(SSH === null)("ssh -G: the tunnel's values win over a config's own, short commands keep 15 s × 3", () => {
    const config = path.join(root, "config-alive")
    fs.writeFileSync(config, "Host devbox\n  HostName devbox.test\n  ServerAliveInterval 60\n  ServerAliveCountMax 10\n")
    const resolve = (args: string[]) => {
      const result = Bun.spawnSync([SSH!, "-F", config, "-G", ...args], { env: minimalEnv(), windowsHide: true })
      expect(result.exitCode).toBe(0)
      return result.stdout
        .toString()
        .split(/\r?\n/)
        .filter((line) => /^serveralive(interval|countmax) /.test(line))
        .sort()
    }
    expect(resolve(tunnel)).toEqual([
      `serveralivecountmax ${Liveness.SERVER_ALIVE_COUNT_MAX}`,
      `serveraliveinterval ${Liveness.SERVER_ALIVE_INTERVAL}`,
    ])
    expect(resolve([...shortArgs(target), target.host])).toEqual(["serveralivecountmax 3", "serveraliveinterval 15"])
    expect(Liveness.SILENT_LIMIT_MS).toBe(12_000)
  })
})
