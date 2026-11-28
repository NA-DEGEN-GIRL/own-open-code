export * as Options from "./options.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "@opencode/schema/schema"

export const LogLevel = Schema.Literals(["debug", "info", "warn", "error"])
export type LogLevel = typeof LogLevel.Type

/**
 * `ctx.options` of own-remote (`{ "package": "<dir>", "options": { … } }`). No secrets.
 * Local mode (04 §4.1): the SSH controller. Agent mode (04 §3.1): runs inside the remote service.
 */
export const Info = Schema.Struct({
  mode: optional(Schema.Literals(["local", "agent"])),
  /** `OWN_HOME` (02 §2.3). Development and tests must set it. */
  home: optional(Schema.String),
  /** Overrides the bundle build id; tests give every own plugin the same value. */
  buildId: optional(Schema.String),
  /**
   * Version a remote service must run for a live connection (04 §5.7). Default: the bundle's expected app version
   * (the release version). Development and tests set it to the version of the bundle they install.
   */
  version: optional(Schema.String),
  /** ssh executable (04 §14.1). Default `C:\Windows\System32\OpenSSH\ssh.exe`. */
  sshPath: optional(Schema.String),
  /** Replaces `[sshPath]` with an argv prefix. Tests only (the fake-SSH harness). */
  sshCommand: optional(Schema.Array(Schema.String)),
  /** Askpass helper (04 §14.2). Default: the installed version's `<OWN_HOME>\app\<version>\opencode.exe`. A real executable. */
  askpassHelper: optional(Schema.String),
  /** Directory of the remote bundles. Default: the installed version's `<OWN_HOME>\app\<version>\remote`. */
  remoteBundles: optional(Schema.String),
  /** `~/.ssh` of the user (config discovery, identity file rule). Default `%USERPROFILE%\.ssh`. */
  sshDir: optional(Schema.String),
  /** codex-multi-provider control-center root for `legacy.*` (04 §19). Read only. */
  legacyRoot: optional(Schema.String),
  /** Seconds the process-lifetime controller outlives its last reference (04 §4.1). Default 30. */
  lingerSeconds: optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 }))),
  /** Keep-part epoch check interval pushed into ensure (04 §7.4). Default 15. Tests shorten it. */
  keepIntervalSeconds: optional(PositiveInt),
  /**
   * How long a short remote script may run: inspect (04 §5.4), an operation's plan or step, and ensure until its report,
   * which comes once the remote service registered (04 §6.1 steps 5–7). Default 120000; install and update keep their
   * own longer limits. The own-web remote e2e lengthens it: its fake host is Git Bash, slow on a busy PC, and boots the
   * remote server from source.
   */
  scriptTimeoutMs: optional(PositiveInt),
  /** Readiness timeout of `GET /api/info` after ensure (04 §6.1 step 8). Default 30000. */
  readyTimeoutMs: optional(PositiveInt),
  /** Reconnect backoff schedule in ms (04 §6.3). Default 1, 2, 5, 10, 30 s. */
  backoffMs: optional(Schema.Array(PositiveInt)),
  /** Upper bound of a drain wait (04 §6.4 step 3). Default 30 minutes. */
  drainCapMs: optional(PositiveInt),
  /** Heartbeat expiry of a prompt owner (04 §6.3). Default 30000. */
  ownerTimeoutMs: optional(PositiveInt),
  /** Remote `OWN_HOME` override for every host (tests: the fake remote uses a temp root). */
  remoteInstallRoot: optional(Schema.String),
  /**
   * Tests only (the real-host gates, decisions RL35): every host's install, its XDG data, config, state and cache roots
   * live under `root` (an absolute directory on the host: `<root>/data`, `<root>/config`, `<root>/state`,
   * `<root>/cache`) and its service listens on `port`, so a gate run shares no path, registration or port with a real
   * install of the same account. Remote commands run as `env XDG_…=<root>/… <command>`. Never set by the app.
   */
  remoteTest: optional(
    Schema.Struct({
      root: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9._/-]+[A-Za-z0-9._-]$/)),
      port: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65_535 })),
    }),
  ),
  /**
   * M1 gateway (05 §13.4). Whether it runs is `OWN_HOME\gateway.json` (set through `gateway.configure.*`); these only
   * move its inputs for development and tests.
   */
  gateway: optional(
    Schema.Struct({
      /** Registration file of the local service (`{url, password}`). Default: the channel's `service-<channel>.json`. */
      registration: optional(Schema.String),
      /** own-web build served to devices. Default: the installed version's `<OWN_HOME>\app\<version>\web`. */
      webRoot: optional(Schema.String),
      /** argv prefix replacing `tailscale.exe` (tests); `null` skips detection (reported as missing). */
      tailscaleCommand: optional(Schema.NullOr(Schema.Array(Schema.String))),
      /** Audit window in ms (default 5 minutes). */
      auditIntervalMs: optional(PositiveInt),
      /**
       * Vault of the app listener's key (08 §3.2). `memory`: tests only (a new key every start). Default: the installed
       * version's `own-vault.exe`.
       */
      vault: optional(Schema.Union([Schema.Literal("memory"), Schema.Struct({ exePath: optional(Schema.String) })])),
      /** argv replacing `netsh interface portproxy show v4tov4` (tests); `null` skips detection. */
      portproxyCommand: optional(Schema.NullOr(Schema.Array(Schema.String))),
      /** Adds `127.0.0.1:<app port>` to the app routes (tests and development on one PC). */
      appLoopbackRoute: optional(Schema.Boolean),
    }),
  ),
  logLevel: optional(LogLevel),
})
export type Info = typeof Info.Type

const decodeInfo = Schema.decodeUnknownSync(Info)

export function decode(input: unknown): Info {
  return decodeInfo(input ?? {})
}
