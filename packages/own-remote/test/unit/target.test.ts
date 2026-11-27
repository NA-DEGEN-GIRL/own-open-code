import { describe, expect, test } from "bun:test"
import { identityFileAllowed, parseTarget, shortArgs, sshArgs, tunnelArgs } from "../../src/vendor/ssh/command.js"

const PROFILE = "C:\\Users\\tester"

describe("target parser (04 §7.2): a UI line cannot run local commands or leak local credentials", () => {
  test("accepts aliases, user@host, ports, jump hosts and identity files under %USERPROFILE%\\.ssh", () => {
    expect(parseTarget("devbox", { profile: PROFILE })).toEqual({ host: "devbox", args: [] })
    expect(parseTarget('ssh -p 2222 -i "~/.ssh/work key" -J gateway user@devbox', { profile: PROFILE })).toEqual({
      host: "user@devbox",
      args: ["-p", "2222", "-i", "~/.ssh/work key", "-J", "gateway"],
    })
    expect(parseTarget("ssh -i C:\\Users\\tester\\.ssh\\id_ed25519 host", { profile: PROFILE }).args).toEqual([
      "-i",
      "C:\\Users\\tester\\.ssh\\id_ed25519",
    ])
    expect(parseTarget("ssh -o IdentityFile=C:/Users/tester/.ssh/k -o User=deploy -o Port=22 host", { profile: PROFILE }).host).toBe("host")
    expect(parseTarget("ssh -J jump@bastion:2200,second host", { profile: PROFILE }).args).toEqual(["-J", "jump@bastion:2200,second"])
    expect(parseTarget("ssh user@[::1]", { profile: PROFILE }).host).toBe("user@[::1]")
  })

  test("rejects the 04 §7.2 list and upstream's own rejections", () => {
    for (const input of [
      "ssh -F x host",
      "ssh -Fx host",
      "ssh -o ProxyCommand=calc.exe host",
      "ssh -o proxycommand=calc host",
      "ssh -o IdentityAgent=\\\\.\\pipe\\x host",
      "ssh -i \\\\host\\share\\k host",
      "ssh -i //host/share/k host",
      "ssh -i \\\\?\\C:\\k host",
      "ssh -i %d/k host",
      "ssh -o identityfile=$HOME/k host",
      "ssh -i C:\\Users\\tester\\.ssh\\..\\secret host",
      "ssh -i D:\\keys\\k host",
      "ssh -i keys/k host",
      "ssh -J 'a;b' host",
      "ssh -o ProxyJump=a|b host",
      "ssh -o LocalCommand=x host",
      "",
      "ssh host whoami",
      "host;whoami",
      "ssh user:password@host",
      "ssh -t host",
      "ssh -o RemoteCommand=whoami host",
      "ssh -L 1234:x:80 host",
      "ssh -R 1234:x:80 host",
      "ssh -p 70000 host",
      'ssh -i "key host',
      "host\nwhoami",
      "host\0",
    ])
      expect(() => parseTarget(input, { profile: PROFILE }), input).toThrow()
  })

  test("identity files: only local drive paths under the profile's .ssh", () => {
    expect(identityFileAllowed("~/.ssh/id_ed25519", PROFILE)).toBe(true)
    expect(identityFileAllowed("c:/users/TESTER/.ssh/k", PROFILE)).toBe(true)
    expect(identityFileAllowed("C:\\Users\\tester\\.sshx\\k", PROFILE)).toBe(false)
    expect(identityFileAllowed("\\\\.\\C:\\k", PROFILE)).toBe(false)
    expect(identityFileAllowed("${HOME}/.ssh/k", PROFILE)).toBe(false)
  })

  test("short commands clear config forwards; the tunnel keeps -L/-R and runs `sh -s` on stdin", () => {
    const target = parseTarget("devbox", { profile: PROFILE })
    expect(sshArgs(target)).toContain("PermitLocalCommand=no")
    expect(shortArgs(target).slice(-2)).toEqual(["-o", "ClearAllForwardings=yes"])
    const args = tunnelArgs(
      target,
      { address: "127.0.3.2", port: 24817 },
      { host: "127.0.0.1", port: 31872 },
      { remote: { socket: "/home/u/.local/share/own-open-code/run/broker-12.sock" }, localPort: 40001 },
    )
    expect(args.slice(0, 4)).toEqual(["-o", "ControlMaster=no", "-o", "ControlPersist=no"])
    expect(args).not.toContain("ClearAllForwardings=yes")
    expect(args).toContain("ExitOnForwardFailure=yes")
    expect(args.slice(-6)).toEqual([
      "-L",
      "127.0.3.2:24817:127.0.0.1:31872",
      "-R",
      "/home/u/.local/share/own-open-code/run/broker-12.sock:127.0.0.1:40001",
      "devbox",
      "sh -s",
    ])
    const tcp = tunnelArgs(target, { address: "127.0.3.2", port: 1 }, { host: "127.0.0.1", port: 2 }, {
      remote: { tcpPort: 45000 },
      localPort: 3,
    })
    expect(tcp).toContain("127.0.0.1:45000:127.0.0.1:3")
  })

  test("04 §8.11.4.2: the Claude egress relay is a second -R of the same form, never without the broker's", () => {
    const target = parseTarget("devbox", { profile: PROFILE })
    const run = "/home/u/.local/share/own-open-code/run"
    const socket = tunnelArgs(
      target,
      { address: "127.0.3.2", port: 24817 },
      { host: "127.0.0.1", port: 31872 },
      { remote: { socket: `${run}/broker-12.sock` }, localPort: 40001 },
      { remote: { socket: `${run}/egress-12.sock` }, localPort: 40002 },
    )
    expect(socket.slice(-8)).toEqual([
      "-L",
      "127.0.3.2:24817:127.0.0.1:31872",
      "-R",
      `${run}/broker-12.sock:127.0.0.1:40001`,
      "-R",
      `${run}/egress-12.sock:127.0.0.1:40002`,
      "devbox",
      "sh -s",
    ])
    // Both forwards succeed or the session fails (then the TCP fallback runs).
    expect(socket).toContain("ExitOnForwardFailure=yes")
    const tcp = tunnelArgs(
      target,
      { address: "127.0.3.2", port: 1 },
      { host: "127.0.0.1", port: 2 },
      { remote: { tcpPort: 45000 }, localPort: 3 },
      { remote: { tcpPort: 51234 }, localPort: 4 },
    )
    expect(tcp.filter((arg) => arg === "-R")).toHaveLength(2)
    expect(tcp).toContain("127.0.0.1:45000:127.0.0.1:3")
    expect(tcp).toContain("127.0.0.1:51234:127.0.0.1:4")
    const alone = tunnelArgs(target, { address: "127.0.3.2", port: 1 }, { host: "127.0.0.1", port: 2 }, undefined, {
      remote: { tcpPort: 51234 },
      localPort: 4,
    })
    expect(alone).not.toContain("-R")
  })
})
