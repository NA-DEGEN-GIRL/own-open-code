import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Controller } from "../../src/controller.js"
import { Registry } from "../../src/registry.js"

// The three project states (04 §5.6): records written before them keep their value, new hosts get `instructions`.
describe("host registry: project states across versions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-registry-"))
  const record = (id: string, projectConfig: string) => ({
    id,
    alias: id,
    name: id,
    target: id,
    loopback: 1,
    localPort: 24_817,
    remotePort: null,
    autoConnect: false,
    accounts: { mode: "all" },
    leaseSeconds: 900,
    failClosedGraceSeconds: 300,
    tokenTtlHours: 12,
    installRoot: null,
    projectConfig,
    shellEnv: "login",
    env: {},
    pathPrepend: [],
    hostIdentity: null,
    epoch: 0,
    // Written before `egressTcpPort` existed, like a record of an old install.
    broker: { mode: "socket", tcpPort: null },
    remote: null,
    platform: null,
    warnings: [],
    pendingSettings: false,
    appliedSettings: null,
    recentFolders: [],
    probedSettings: null,
    addedAt: 1_790_000_000_000,
  })
  const write = (dir: string, hosts: ReadonlyArray<unknown>) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "hosts.json"),
      JSON.stringify({ schemaVersion: 1, installId: "0".repeat(32), revision: 3, hosts }),
    )
  }

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  test("stored `disabled` and `trusted` hosts load with their value; nothing is migrated", async () => {
    const dir = path.join(root, "old")
    write(dir, [record("h-off", "disabled"), record("h-on", "trusted")])
    const before = fs.readFileSync(path.join(dir, "hosts.json"), "utf8")
    const store = new Registry.Store({ dir, lockDir: path.join(root, "locks") })
    const loaded = await store.load()
    expect(loaded.hosts.map((host) => [host.id, host.projectConfig])).toEqual([
      ["h-off", "disabled"],
      ["h-on", "trusted"],
    ])
    // Loading rewrites nothing.
    expect(fs.readFileSync(path.join(dir, "hosts.json"), "utf8")).toBe(before)
    // A later change of another field keeps the stored state.
    await store.patchHost("h-off", { autoConnect: true })
    expect(store.get("h-off")).toMatchObject({ projectConfig: "disabled", autoConnect: true })
  })

  test("`instructions` is a stored value; an unknown value is refused", async () => {
    const dir = path.join(root, "new")
    write(dir, [record("h-mid", "instructions")])
    const store = new Registry.Store({ dir, lockDir: path.join(root, "locks") })
    expect((await store.load()).hosts[0]!.projectConfig).toBe("instructions")
    const bad = path.join(root, "bad")
    write(bad, [record("h-bad", "everything")])
    await expect(new Registry.Store({ dir: bad, lockDir: path.join(root, "locks") }).load()).rejects.toThrow()
  })

  test("a newly added host defaults to `instructions`, beside older hosts that keep theirs", async () => {
    const home = path.join(root, "home")
    write(path.join(home, "remote"), [record("h-off", "disabled")])
    const ssh = path.join(root, "dot-ssh")
    fs.mkdirSync(ssh, { recursive: true })
    fs.writeFileSync(path.join(ssh, "config"), "Host devbox\n  HostName devbox.invalid\n")
    const controller = new Controller({
      buildId: "registry-test",
      version: "0.0.0-test",
      ownHome: home,
      options: { sshDir: ssh, sshCommand: [path.join(root, "no-ssh")] },
    })
    await controller.start()
    try {
      const added = await controller.addHost({ alias: "devbox" })
      if (!added.ok) throw new Error("add")
      expect(Registry.DEFAULTS.projectConfig).toBe("instructions")
      expect(added.record.projectConfig).toBe("instructions")
      expect(controller.view(added.record.id)!.projectConfig).toBe("instructions")
      expect(controller.view("h-off")!.projectConfig).toBe("disabled")
    } finally {
      await controller.close()
    }
  })
})
