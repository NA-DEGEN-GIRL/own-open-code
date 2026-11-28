// The real-host gates' test root (Options `remoteTest`, decisions RL35): a gate run installs, registers and listens
// only inside its root on the host, never on a real install's paths or the channel's default port. The 2.4.1-own.6
// chain's cleanup removed the user's real host install because the gates shared those paths.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Controller } from "../../src/controller.js"
import { Options } from "../../src/options.js"
import { RemoteModel } from "../../src/remote/model.js"
import { tunnelArgs } from "../../src/vendor/ssh/command.js"

const ROOT = "/home/u/own-realhost-test/r1a2b3c4"
const REAL = ["/home/u/.local/share", "/home/u/.local/state", "/home/u/.config", "/home/u/.cache"]

/** An inspect report whose shells name `xdg` (or nothing: the defaults under HOME). */
function inspect(xdg: Readonly<Record<string, string>> = {}) {
  const env = (mode: string) =>
    [`OWN_INSPECT_ENV_${mode}_STATE=ok`, `OWN_INSPECT_ENV_${mode}_HOME=/home/u`]
      .concat(Object.entries(xdg).map(([name, value]) => `OWN_INSPECT_ENV_${mode}_${name}=${value}`))
      .join("\n")
  return RemoteModel.parseInspect(
    [
      "OWN_INSPECT_V=1",
      "OWN_INSPECT_HOME=/home/u",
      "OWN_INSPECT_UID=1000",
      env("SHL"),
      env("LOGIN"),
      env("INTERACTIVE"),
      "OWN_INSPECT_DONE=1",
    ].join("\n"),
  )
}

describe("real-host test root (decisions RL35)", () => {
  test("every remote path lies in the test root, whatever the shell reported or the install root says", () => {
    const shells: ReadonlyArray<Readonly<Record<string, string>>> = [
      {},
      { XDG_DATA_HOME: "/home/u/.local/share", XDG_STATE_HOME: "/srv/state" },
    ]
    for (const reported of shells) {
      const paths = RemoteModel.remotePaths(inspect(reported), "login", "/home/u/.local/share/own-open-code", ROOT)
      expect(paths).toEqual({
        home: "/home/u",
        ownHome: `${ROOT}/data/own-open-code`,
        configDir: `${ROOT}/config/own-open-code`,
        upstreamConfigDir: `${ROOT}/config/opencode`,
        stateDir: `${ROOT}/state/opencode`,
        dataDir: `${ROOT}/data/opencode`,
        socketDir: `${ROOT}/data/own-open-code/run`,
      })
      for (const [key, value] of Object.entries(paths)) {
        if (key === "home") continue
        expect(value.startsWith(`${ROOT}/`)).toBe(true)
        for (const real of REAL) expect(value.startsWith(real)).toBe(false)
      }
    }
    // A root too deep for run/ keeps the short socket directory inside it, before /tmp.
    const deep = `/home/u/own-realhost-test/${"d".repeat(30)}`
    expect(RemoteModel.remotePaths(inspect(), "login", null, deep).socketDir).toMatch(
      new RegExp(`^${deep}/\\.own-r/[0-9a-f]{8}$`),
    )
  })

  test("without a test root the paths are the product's (04 §5.3)", () => {
    expect(RemoteModel.remotePaths(inspect(), "login", null)).toMatchObject({
      ownHome: "/home/u/.local/share/own-open-code",
      stateDir: "/home/u/.local/state/opencode",
      configDir: "/home/u/.config/own-open-code",
    })
    expect(RemoteModel.remoteCommand("sh -s")).toBe("sh -s")
  })

  test("remote commands carry the root's XDG values, so login shells and the service resolve inside it", () => {
    expect(RemoteModel.remoteCommand("sh -s", ROOT)).toBe(
      `env XDG_DATA_HOME=${ROOT}/data XDG_CONFIG_HOME=${ROOT}/config XDG_STATE_HOME=${ROOT}/state XDG_CACHE_HOME=${ROOT}/cache sh -s`,
    )
    const args = tunnelArgs(
      { host: "devbox", args: [] },
      { address: "127.0.3.2", port: 1 },
      { host: "127.0.0.1", port: 2 },
      undefined,
      undefined,
      RemoteModel.remoteCommand("sh -s", ROOT),
    )
    expect(args.slice(-2)).toEqual(["devbox", RemoteModel.remoteCommand("sh -s", ROOT)])
  })

  test("a shell that drops the root's XDG values is named, so nothing starts on the real paths", () => {
    expect(RemoteModel.testRootLost(inspect(RemoteModel.testXdg(ROOT)), "login", ROOT)).toBeUndefined()
    expect(RemoteModel.testRootLost(inspect(), "login", ROOT)).toBe("XDG_DATA_HOME")
    expect(
      RemoteModel.testRootLost(
        inspect({ ...RemoteModel.testXdg(ROOT), XDG_STATE_HOME: "/home/u/.local/state" }),
        "login",
        ROOT,
      ),
    ).toBe("XDG_STATE_HOME")
  })

  test("the option takes only a plain absolute root and a non-default port", () => {
    expect(Options.decode({ remoteTest: { root: ROOT, port: 41_234 } }).remoteTest).toEqual({
      root: ROOT,
      port: 41_234,
    })
    for (const root of ["own-realhost-test/r1", "/home/u/x y", "/home/u/'x'", "/home/u/$HOME", "/home/u/dir/"])
      expect(() => Options.decode({ remoteTest: { root, port: 41_234 } })).toThrow()
    expect(() => Options.decode({ remoteTest: { root: ROOT, port: 80 } })).toThrow()
  })

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "own-remote-test-root-"))
  afterAll(() => fs.rmSync(temp, { recursive: true, force: true }))

  test("a host added under a test root targets the root's port, never the channel default", async () => {
    const ssh = path.join(temp, "dot-ssh")
    fs.mkdirSync(ssh, { recursive: true })
    fs.writeFileSync(path.join(ssh, "config"), "Host devbox\n  HostName devbox.invalid\n")
    const controller = new Controller({
      buildId: "test-root",
      version: "0.0.0-test",
      ownHome: path.join(temp, "home"),
      options: { sshDir: ssh, sshCommand: [path.join(temp, "no-ssh")], remoteTest: { root: ROOT, port: 41_234 } },
    })
    await controller.start()
    try {
      const added = await controller.addHost({ alias: "devbox" })
      if (!added.ok) throw new Error("add")
      expect(added.record.remotePort).toBe(41_234)
      expect(added.record.remotePort).not.toBe(RemoteModel.defaultPort())
      expect(controller.remoteCommand("sh -s")).toBe(RemoteModel.remoteCommand("sh -s", ROOT))
    } finally {
      await controller.close()
    }
  })
})
