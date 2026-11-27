import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SshConfig } from "../../src/ssh/config.js"
import { Failure } from "../../src/ssh/failure.js"

describe("~/.ssh/config as a file (04 §7.5, §19.1)", () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-config-"))
    fs.mkdirSync(path.join(dir, "conf.d"))
    // Same structure as the user's config (19.1), with made-up values.
    fs.writeFileSync(
      path.join(dir, "config"),
      [
        "Host work_linux",
        "  HostName 192.0.2.1",
        "  User a",
        "  IdentityFile ~/.ssh/k1",
        "Host lab",
        "  HostName 192.0.2.2",
        "  User b",
        "  IdentitiesOnly yes",
        "  ServerAliveInterval 30",
        "Host lab-7676",
        "  HostName 192.0.2.2",
        "  LocalForward 7676 127.0.0.1:7676",
        "  ExitOnForwardFailure yes",
        "Host build-host dev-host",
        "  HostName 192.0.2.3",
        "  StrictHostKeyChecking no",
        "Host *.corp",
        "  DynamicForward 1080",
        "Include conf.d/*",
        "",
      ].join("\n"),
    )
    fs.writeFileSync(path.join(dir, "conf.d", "extra"), "Host deploy\n  HostName 192.0.2.9\n  LocalForward 127.0.9.3:8080 127.0.0.1:80\nInclude ../config\n")
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("aliases without wildcards, forwards and loose host key flags; Include without loops", async () => {
    const blocks = await SshConfig.read(path.join(dir, "config"))
    const aliases = SshConfig.aliases(blocks)
    expect(aliases.map((item) => item.alias)).toEqual(["build-host", "deploy", "dev-host", "lab", "lab-7676", "work_linux"])
    const byName = Object.fromEntries(aliases.map((item) => [item.alias, item]))
    expect(byName["lab-7676"]!.forwards).toBe("yes")
    expect(byName["lab-7676"]!.localhostForward).toBe(true)
    expect(byName["deploy"]!.forwards).toBe("yes")
    expect(byName["deploy"]!.localhostForward).toBe(false)
    // A wildcard block with a forward makes every other alias "maybe" (not resolved by the file parser).
    expect(byName["lab"]!.forwards).toBe("maybe")
    expect(byName["build-host"]!.looseHostKey).toBe(true)
    expect(byName["build-host"]!.siblings).toEqual(["dev-host"])
    expect(byName["work_linux"]!.looseHostKey).toBe(false)
    const detail = SshConfig.detail(blocks, "lab")
    expect(detail.destination).toBe("b@192.0.2.2:22")
    expect(detail.configKeys).toContain("identitiesonly")
  })

  test("`ssh -G` output decides forwards and the destination", () => {
    const resolved = SshConfig.parseResolved(
      "user b\nhostname 192.0.2.2\nport 2222\nlocalforward [127.0.0.1]:7676 [127.0.0.1]:7676\nstricthostkeychecking ask\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n",
    )
    expect(resolved.destination).toBe("b@192.0.2.2:2222")
    expect(resolved.forwardKinds).toEqual(["localforward"])
    expect(SshConfig.looseResolved(resolved)).toBe(false)
    expect(SshConfig.looseResolved(SshConfig.parseResolved("stricthostkeychecking false\nuserknownhostsfile /dev/null\n"))).toBe(true)
  })

  test("localhost binds of LocalForward (the lab-7676 warning)", () => {
    expect(SshConfig.localhostBind("7676 127.0.0.1:7676")).toBe(true)
    expect(SshConfig.localhostBind("localhost:7676 127.0.0.1:7676")).toBe(true)
    expect(SshConfig.localhostBind("127.0.9.3:7676 127.0.0.1:7676")).toBe(false)
    expect(SshConfig.localhostBind("[::1]:7676 127.0.0.1:7676")).toBe(false)
  })
})

describe("ssh failure classification (04 §6.3)", () => {
  test("host keys, auth, forwarding and connection errors", () => {
    expect(Failure.classifyText("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\r\nHost key verification failed.")).toMatchObject({
      error: "host_key",
      detail: "changed",
      pause: true,
    })
    expect(Failure.classifyText("No ED25519 host key is known for lab and you have requested strict checking.\r\nHost key verification failed.")).toMatchObject({
      error: "host_key",
      detail: "unknown",
    })
    expect(Failure.classifyText("tester@lab: Permission denied (publickey).")).toMatchObject({ error: "auth", pause: true })
    expect(Failure.classifyText("channel 2: open failed: administratively prohibited: open failed")).toMatchObject({
      error: "forwarding_disabled",
    })
    expect(Failure.classifyText("ssh: connect to host lab port 22: Connection timed out")).toMatchObject({
      error: "connection",
      pause: false,
    })
    expect(Failure.remoteForwardFailed("Error: remote port forwarding failed for listen path /x/broker-1.sock")).toBe(true)
  })
})
