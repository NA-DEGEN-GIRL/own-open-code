import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Option } from "effect"
import { Registry } from "../../src/registry.js"
import { RemoteModel } from "../../src/remote/model.js"
import { Token } from "../../src/token.js"
import { ServerAuth } from "../../../server/src/auth.js"

describe("remote paths (04 §5.3, §7.4)", () => {
  test("the socket directory is run/ unless the longest socket path passes 100 bytes", () => {
    expect(RemoteModel.socketDir("/home/u/.local/share/own-open-code", "/home/u", "1000")).toBe(
      "/home/u/.local/share/own-open-code/run",
    )
    const deep = "/home/" + "d".repeat(80)
    const own = `${deep}/.local/share/own-open-code`
    const hash = createHash("sha256").update(own).digest("hex").slice(0, 8)
    expect(RemoteModel.socketDir(own, deep, "1000")).toBe(`/tmp/own-1000/${hash}`)
    const medium = "/home/" + "m".repeat(45)
    expect(RemoteModel.socketDir(`${medium}/.local/share/own-open-code`, "/home/u", "1000")).toBe(
      `/home/u/.own-r/${createHash("sha256").update(`${medium}/.local/share/own-open-code`).digest("hex").slice(0, 8)}`,
    )
    expect(Buffer.byteLength(RemoteModel.socketPath("/tmp/own-1000/abcdef01", 1_790_000_000))).toBeLessThanOrEqual(100)
    // 04 §8.11.4.2: the egress socket sits next to the broker's with a name of the same length.
    for (const dir of ["/tmp/own-1000/abcdef01", "/home/u/.local/share/own-open-code/run"]) {
      expect(RemoteModel.egressSocketPath(dir, 1_790_000_000)).toBe(`${dir}/egress-1790000000.sock`)
      expect(RemoteModel.egressSocketPath(dir, 1_790_000_000).length).toBe(RemoteModel.socketPath(dir, 1_790_000_000).length)
    }
  })

  test("the channel default port matches upstream `defaultPort` (10000 + sha1(channel)[0..8] % 50000)", () => {
    // packages/cli/src/services/service-config.ts:34-38 with Hash.fast = sha1 (packages/util/src/hash.ts)
    const upstream = 10_000 + (Number.parseInt(createHash("sha1").update("own").digest("hex").slice(0, 8), 16) % 50_000)
    expect(RemoteModel.defaultPort()).toBe(upstream)
    expect(RemoteModel.defaultPort()).toBeGreaterThanOrEqual(10_000)
  })

  const paths = {
    home: "/home/u",
    ownHome: "/home/u/.local/share/own-open-code",
    configDir: "/home/u/.config/own-open-code",
    upstreamConfigDir: "/home/u/.config/opencode",
    stateDir: "/home/u/.local/state/opencode",
    dataDir: "/home/u/.local/share/opencode",
    socketDir: "/home/u/.local/share/own-open-code/run",
  }
  const plugins = "/home/u/.local/share/own-open-code/app/current/plugins"

  test("managed config: own-accounts, own-remote, own-team, own-telemetry, own-harness, own-omo, own-creator with absolute paths, update/share off, deny rules (04 §5.6, 06 §4.13, §8.11.14, 10 §6.1, 15 §1, 17 §10)", () => {
    const config = JSON.parse(RemoteModel.managedConfig(paths))
    expect(config.plugins).toEqual([
      { package: `${plugins}/own-accounts`, options: { mode: "remote", home: paths.ownHome } },
      { package: `${plugins}/own-remote`, options: { mode: "agent", home: paths.ownHome } },
      { package: `${plugins}/own-team`, options: { mode: "remote", home: paths.ownHome } },
      { package: `${plugins}/own-telemetry`, options: { home: paths.ownHome } },
      // After the others, as on this PC; no options: new host sessions get the plugin's default harness.
      { package: `${plugins}/own-harness` },
      // Last, as on this PC; omo's folders and log in this install's OWN_HOME.
      { package: `${plugins}/own-omo`, options: { home: paths.ownHome } },
      // Last, as on this PC (17 §10): a read-only mirror of the PC's extensions in this install's OWN_HOME.
      { package: `${plugins}/own-creator`, options: { home: paths.ownHome, mode: "remote" } },
    ])
    // own-computer-use never runs on a remote host (06 §2.6); claude-auth is never installed there (04 §8.11.5).
    expect(JSON.stringify(config)).not.toContain("own-computer-use")
    expect(JSON.stringify(config)).not.toContain("claude-auth")
    expect(JSON.stringify(config)).not.toContain("~")
    expect(config.update).toBe("disable")
    expect(config.permissions[0]).toEqual({ action: "shell", resource: "*", effect: "ask" })
    expect(config.permissions).toContainEqual({ action: "read", resource: "/home/u/.local/share/own-open-code/run/*", effect: "deny" })
  })

  test("the tool folder joins pathPrepend through the hosts.update validation (06 §4.13)", () => {
    const dir = RemoteModel.toolDir(paths.ownHome, "git-lfs")
    expect(dir).toBe("/home/u/.local/share/own-open-code/tools/git-lfs/current")
    expect(RemoteModel.validatePathPrepend(["/opt/bin", dir])).toBeUndefined()
  })

  test("service env: markers, TMPDIR under OWN_HOME, the three project states, provider keys refused", () => {
    const record = {
      projectConfig: "disabled",
      env: { EDITOR: "vim", OPENAI_API_KEY: "x", ANTHROPIC_BASE_URL: "y" },
    } as unknown as Registry.HostRecord
    const paths = { ownHome: "/o", configDir: "/c/own" } as Registry.RemotePaths
    const env = RemoteModel.serviceEnv(record, paths)
    expect(env).toMatchObject({ OWN_REMOTE: "1", OWN_OPEN_CODE: "1", TMPDIR: "/o/tmp", OPENCODE_CONFIG_PROJECT_DISABLE: "1", EDITOR: "vim" })
    // Decisions TLM: upstream's update check and signed-out OpenCode models off, whatever the host's variables say.
    const quiet = RemoteModel.serviceEnv(
      { ...record, env: { OPENCODE_DISABLE_FREE_MODELS: "0", OPENCODE_DISABLE_AUTOUPDATE: "0" } },
      paths,
    )
    expect(quiet).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.OPENCODE_CONFIG_PROJECT_INSTRUCTIONS).toBeUndefined()
    // `instructions` keeps the variable every service version knows and adds one only a new service reads, so an
    // older service falls back to `disabled`, never to `trusted`.
    const instructions = RemoteModel.serviceEnv({ ...record, projectConfig: "instructions" }, paths)
    expect(instructions).toMatchObject({ OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_CONFIG_PROJECT_INSTRUCTIONS: "1" })
    const trusted = RemoteModel.serviceEnv({ ...record, projectConfig: "trusted" }, paths)
    expect(trusted.OPENCODE_CONFIG_PROJECT_DISABLE).toBeUndefined()
    expect(trusted.OPENCODE_CONFIG_PROJECT_INSTRUCTIONS).toBeUndefined()
    // A host variable stored before the name was managed cannot switch a state.
    const stored = { ...record, env: { OPENCODE_CONFIG_PROJECT_INSTRUCTIONS: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "0" } }
    expect(RemoteModel.serviceEnv(stored, paths)).toMatchObject({ OPENCODE_CONFIG_PROJECT_DISABLE: "1" })
    expect(RemoteModel.serviceEnv(stored, paths).OPENCODE_CONFIG_PROJECT_INSTRUCTIONS).toBeUndefined()
    expect(RemoteModel.serviceEnv({ ...stored, projectConfig: "trusted" }, paths).OPENCODE_CONFIG_PROJECT_DISABLE).toBeUndefined()
    expect(RemoteModel.serviceEnv({ ...stored, projectConfig: "trusted" }, paths).OPENCODE_CONFIG_PROJECT_INSTRUCTIONS).toBeUndefined()
    expect(RemoteModel.validateEnv({ OPENCODE_CONFIG_PROJECT_INSTRUCTIONS: "1" })).toContain("managed")
    expect(RemoteModel.validateEnv({ OPENCODE_CONFIG_PROJECT_DISABLE: "0" })).toContain("managed")
    expect(new Set(["disabled", "instructions", "trusted"].map((projectConfig) => RemoteModel.settingsHash({ ...record, shellEnv: "login", pathPrepend: [], projectConfig } as unknown as Registry.HostRecord))).size).toBe(3)
    expect(RemoteModel.validateEnv({ OPENAI_API_KEY: "x" })).toContain("provider")
    expect(RemoteModel.validateEnv({ OWN_REMOTE: "0" })).toContain("managed")
    expect(RemoteModel.validateEnv({ OK_NAME: "v" })).toBeUndefined()
    expect(RemoteModel.validatePathPrepend(["/opt/bin", "relative"])).toBe("relative")
    expect(RemoteModel.validatePathPrepend(["/a:b"])).toBe("/a:b")
  })

  test("04 §8.11.14: a host NO_PROXY gets the loopback added, the user's entries kept first", () => {
    const record = (env: Record<string, string>) => ({ projectConfig: "disabled", env }) as unknown as Registry.HostRecord
    const paths = { ownHome: "/o", configDir: "/c/own" } as Registry.RemotePaths
    expect(RemoteModel.serviceEnv(record({ NO_PROXY: "corp.example,.internal" }), paths).NO_PROXY).toBe(
      "corp.example,.internal,127.0.0.1,localhost",
    )
    expect(RemoteModel.serviceEnv(record({ no_proxy: "localhost, 127.0.0.1" }), paths).no_proxy).toBe("localhost,127.0.0.1")
    // None set on the host: nothing in the config env (start.sh adds the loopback to the login shell's value).
    expect(RemoteModel.serviceEnv(record({}), paths).NO_PROXY).toBeUndefined()
    expect(RemoteModel.withLoopback("")).toBe("127.0.0.1,localhost")
  })
})

describe("epochs and ids (04 §2)", () => {
  test("epoch = max(previous + 1, now seconds): never goes back", () => {
    expect(Registry.nextEpoch(0, 1_790_000_000_000)).toBe(1_790_000_000)
    expect(Registry.nextEpoch(1_790_000_500, 1_790_000_000_000)).toBe(1_790_000_501)
  })
  test("host ids", () => {
    for (let i = 0; i < 50; i++) expect(Registry.newHostId()).toMatch(/^h-[a-z0-9]{6,8}$/)
  })
})

describe("server tokens (04 §12.1) cross-checked with upstream verifySession", () => {
  const config = { password: Option.some("remote-service-password"), username: "opencode" }
  test("a token own-remote signs is accepted by the upstream server code until it expires", () => {
    const now = Date.now()
    const token = Token.sign("remote-service-password", now + 12 * 3600_000)
    expect(ServerAuth.verifySession(token, config, now)).toBe(true)
    expect(ServerAuth.verifySession(token, config, now + 13 * 3600_000)).toBe(false)
    expect(ServerAuth.verifySession(token, { ...config, password: Option.some("rotated") }, now)).toBe(false)
    expect(Token.expiresAt(token)).toBe(Math.floor((now + 12 * 3600_000) / 1000) * 1000)
  })
  test("upstream issueSession and ours agree on the format", () => {
    const upstream = ServerAuth.issueSession(config, 1_790_000_000_000)!
    const [expires] = upstream.split(".")
    expect(Token.sign("remote-service-password", Number(expires) * 1000)).toBe(upstream)
  })
})
