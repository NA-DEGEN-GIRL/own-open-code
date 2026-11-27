export * as Broker from "./broker.js"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, optional } from "@opencode/schema/schema"
import { Account } from "./account.js"
import { CodexModels } from "./codex-models.js"
import { Compaction } from "./compaction.js"
import { Creator } from "./creator.js"
import { OwnGitHub } from "./github.js"
import { EpochMillis } from "./id.js"
import { Kind } from "./kind.js"
import { Ledger } from "./ledger.js"
import { Limit } from "./limit.js"
import { Plugin } from "./plugin.js"
import { Policy } from "./policy.js"
import { Preset } from "./preset.js"
import { Ratecard } from "./ratecard.js"
import { Registry } from "./registry.js"
import { keyedRecord } from "./util.js"

/**
 * The credential broker protocol between the local own service and a remote own service (04 §8). The local broker
 * (own-accounts `mode:"local"`) listens on one loopback port per SSH host; the remote broker client (own-accounts
 * `mode:"remote"`) reaches it through the tunnel's `-R` forward. Framing: 4-byte big-endian length + UTF-8 JSON,
 * at most {@link MAX_FRAME_BYTES}. The first frame must be `hello` (anything else is closed without logging bytes).
 *
 * Handshake (04 §8.3, HMAC-SHA256 with the epoch key K, lowercase hex, constant-time compare):
 * `hello` (R→L) → `challenge{nonceL, mac=HMAC(K, MAC_LOCAL+hostId|epoch|nonceR|nonceL)}` (L→R) →
 * `auth{mac=HMAC(K, MAC_REMOTE+hostId|epoch|nonceL|nonceR)}` (R→L) → `ready` (L→R) or `reject`.
 * After `ready`: `req`/`res` frames with a numeric `id`, and `push` frames L→R.
 *
 * The constants are kept equal to own-remote's copy (`packages/own-remote/src/protocol/broker.ts`), which owns the
 * transport side (`listen`, `setKey`, arm); a test compares them.
 */

/**
 * Protocol number (04 §5.7): the shape of `hello`, `headers.get`, `observe.push`, `agent.broker.arm` and the mirror
 * `schemaVersion`. Bumped only on an incompatible change; the local broker then also accepts the previous one for a
 * release (an adapter), so {@link SUPPORTED_PROTOS} lists what this build speaks.
 */
export const PROTO = 1
/** Protos the local broker accepts. Only one exists so far, so there is no previous-proto adapter yet. */
export const SUPPORTED_PROTOS: ReadonlyArray<number> = [PROTO]

export const KEY_BYTES = 32
export const MAC_LOCAL = "own-broker/v1|L|"
export const MAC_REMOTE = "own-broker/v1|R|"
export const MAX_FRAME_BYTES = 1_048_576

/** Schema of the mirrored registry view and of the mirror metadata the remote stores with it (04 §9.2). */
export const MIRROR_SCHEMA_VERSION = 1
/** Version of observation items (04 §5.7: per item; the spool format only grows). */
export const ITEM_SCHEMA_VERSION = 1

/** `observe.push` batch bounds (04 §8.4). */
export const PUSH_MAX_ITEMS = 256
export const PUSH_MAX_BYTES = 512 * 1024

/** Lease rules (04 §8.5). */
export const LEASE_SECONDS_DEFAULT = 900
export const LEASE_SECONDS_MIN = 60
export const LEASE_SECONDS_MAX = 14_400
/** A token is leased only up to `expiresAt − 5 min`. */
export const EXPIRY_MARGIN_MS = 5 * 60_000
/** Minimum remaining validity of a leased Codex token (`5 min + 120 s`, the old app's `minimum_validity`). */
export const MIN_VALIDITY_MS = EXPIRY_MARGIN_MS + 120_000
/** A lease is not used within this much of its deadline (a request must not expire mid-flight). */
export const LEASE_TAIL_MS = 30_000
/** The remote asks again in the background at this share of a lease. */
export const LEASE_REFRESH_SHARE = 0.8
/** `headers.get` answer deadline on the remote (04 §8.6 step 4). */
export const HEADERS_TIMEOUT_MS = 5_000
/** Default wait for a reconnect before the sink (04 §8.6 step 4). */
export const BROKER_WAIT_SECONDS_DEFAULT = 10
/** Fail-closed grace (04 §8.7), host setting 0–600 s. */
export const GRACE_SECONDS_DEFAULT = 300
/** Retry cap of core's schedule (`retry.ts`); the grace spreads over at most this many attempts. */
export const CORE_RETRIES = 10
/** Grace delay cap per attempt. */
export const GRACE_DELAY_CAP_MS = 30_000

/** `headers.get` rate per host (04 §8.9). */
export const RATE_PER_SECOND = 30
export const RATE_BURST = 60
/** Handshake failures accepted per host per minute (04 §8.3 step 4). */
export const AUTH_FAILURES_PER_MINUTE = 5
/** A remote `invalidate` triggers a refresh or source re-check at most this often per host and account (04 §8.8). */
export const INVALIDATE_INTERVAL_MS = 5 * 60_000
/** Drain mode lasts at most this long after the local build changed (04 §5.7 `skewDrainHours`). */
export const SKEW_DRAIN_HOURS = 24
/** Remote `ping` interval (04 §8.4). */
export const PING_INTERVAL_MS = 5 * 60_000
/** Audit aggregation window of `remote.lease.issued` (04 §8.9). */
export const AUDIT_WINDOW_MS = 5 * 60_000
/** Clock skew rules (04 §10.5). */
export const CLOCK_SKEW_WARN_MS = 2 * 60_000
export const CLOCK_SKEW_UNTRUSTED_MS = 10 * 60_000
export const FUTURE_TOLERANCE_MS = 5 * 60_000

// ---------------------------------------------------------------------------------------------------------------
// Claude subscription egress relay (04 §8.11)

/**
 * HMAC label of the per-request egress proof v2 (04 §8.11.0 item 3, D3; v2 2026-10-10 for several Claude accounts):
 * `x-own-egress: v2.<epoch>.<n>.<accountID>.<mac>` with
 * `mac = HMAC-SHA256(K, EGRESS_MAC_LABEL + hostId + "|" + epoch + "|" + n + "|" + accountID)`, lowercase hex. `n`
 * counts from 1 in each arm; the relay refuses a counter it saw within {@link EGRESS_REPLAY_WINDOW}. `accountID` is the
 * Claude account the host's conversation is bound to; the MAC covers it, so a request cannot be moved to another
 * account on the way, and the PC signs with that account only (never a default). v1 (no account) is refused.
 */
export const EGRESS_MAC_LABEL = "own-egress/v2|"
/** Request header of the proof (host → PC), and on a relayed response the marker `1` (PC → host). */
export const EGRESS_HEADER = "x-own-egress"
/** Response header of a relay refusal: one of {@link EgressError}; the body never echoes the request. */
export const EGRESS_ERROR_HEADER = "x-own-egress-error"
/** The fail-closed sink marks its answers so observers skip them (04 §8.11.4.6). */
export const FAIL_CLOSED_HEADER = "x-own-fail-closed"
/** Largest request body the relay reads (`413 too_large` above it). */
export const EGRESS_MAX_BODY_BYTES = 32 * 1024 * 1024
/** Relayed requests in flight per host (`429 busy` above it). */
export const EGRESS_MAX_INFLIGHT = 16
/** Relayed requests per host and second, with a burst (`429 rate_limited`). */
export const EGRESS_RATE_PER_SECOND = 10
export const EGRESS_RATE_BURST = 30
/** Counters remembered per epoch: one older than the highest seen by this much, or seen before, is refused (D3). */
export const EGRESS_REPLAY_WINDOW = 1024
/** A host whose relayed request ends in a final 401 is refused `needs_reauth` this long (D2). */
export const EGRESS_REAUTH_HOLD_MS = 60_000
/** A request body still uploading after this long is cut. */
export const EGRESS_UPLOAD_TIMEOUT_MS = 120_000
/** Failed proofs per host and minute before the relay stops reading new connections for that minute. */
export const EGRESS_MAC_FAILURES_PER_MINUTE = 20

/**
 * Why the relay refused a request (`x-own-egress-error`, 04 §8.11.8): `mac` (401), `rate_limited` and `busy` (429),
 * the verdicts other than `enabled` and `needs_reauth` (403), `too_large` (413), `bad_request` (400/404/405/408), and
 * `upstream_unreachable` (502).
 */
export const EgressError = Schema.Literals([
  "mac",
  "rate_limited",
  "busy",
  "off",
  "host_scope",
  "consent",
  "not_ready",
  "billing",
  "needs_reauth",
  "too_large",
  "bad_request",
  "upstream_unreachable",
]).annotate({ identifier: "Own.Broker.EgressError" })
export type EgressError = typeof EgressError.Type

/** The HMAC input of the egress proof for counter `n` and the request's Claude account. */
export function egressMacInput(input: {
  readonly hostId: string
  readonly epoch: number
  readonly n: number
  readonly accountID: string
}) {
  return `${EGRESS_MAC_LABEL}${input.hostId}|${input.epoch}|${input.n}|${input.accountID}`
}

/** `v2.<epoch>.<n>.<accountID>.<mac>`. */
export function egressHeader(input: {
  readonly epoch: number
  readonly n: number
  readonly accountID: string
  readonly mac: string
}) {
  return `v2.${input.epoch}.${input.n}.${input.accountID}.${input.mac}`
}

/** The parts of an `x-own-egress` request header (v2 only), or `undefined` for anything else. */
export function parseEgressHeader(value: string | null) {
  const match =
    value === null ? null : /^v2\.(\d{1,15})\.(\d{1,15})\.(acc_[0-9A-Za-z_]{1,64})\.([0-9a-f]{64})$/.exec(value)
  if (!match) return undefined
  const n = Number(match[2])
  if (n < 1) return undefined
  return { epoch: Number(match[1]), n, accountID: match[3]!, mac: match[4]! }
}

/**
 * The Claude subscription slot as one host may use it (04 §8.11.4.3), judged on the PC: `state` is the verdict
 * (`Plugin.ClaudeRemoteState`), `fast` whether this PC holds the Fast usage-credit consent (`ack:claudeFast`), and
 * `display` the slot's own display metadata (never the connection label, an e-mail, the plugin version or integrity).
 */
export interface ClaudeRemote extends Schema.Schema.Type<typeof ClaudeRemote> {}
export const ClaudeRemote = Schema.Struct({
  state: Plugin.ClaudeRemoteState,
  fast: Schema.Boolean,
  display: Schema.Struct({
    label: Schema.NullOr(Schema.String),
    shortLabel: Schema.String,
    color: Account.Color,
  }),
  /**
   * 02 §8.7, 04 §8.11 (2026-10-10): every Claude account of this PC the host may use (its account scope), display
   * only; tokens never leave the PC. Absent from a PC before several accounts = the slot's own account only.
   */
  accounts: optional(
    Schema.Array(
      Schema.Struct({
        accountID: Account.ID,
        label: Schema.NullOr(Schema.String),
        shortLabel: Schema.String,
        color: Account.Color,
        default: Schema.Boolean,
        /**
         * The PC can sign with it now (the loaded plugin holds its login). A remote service's automatic switch (02
         * §8.8) only moves to an account marked `true`; absent (an older PC) = unknown, never chosen.
         */
        usable: optional(Schema.Boolean),
      }),
    ),
  ),
}).annotate({ identifier: "Own.Broker.ClaudeRemote" })

// ---------------------------------------------------------------------------------------------------------------
// The Claude Agent route on an SSH host (02 §8.10.13, 04 §8.13, CAG-R1)

/**
 * The PC's Claude Agent accounts as one host may use them (its account scope), display only: no folder, e-mail,
 * account uuid or token. `default` is the PC's default when the host may use it, else the first one it may;
 * `loggedIn` whether the PC's Claude Code is logged in there. Absent when the PC has no Claude Agent account or the
 * host may use none of them, and from an older PC: the host then keeps `claude-agent` disabled.
 */
export interface ClaudeAgentRemote extends Schema.Schema.Type<typeof ClaudeAgentRemote> {}
export const ClaudeAgentRemote = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      accountID: Account.ID,
      label: Schema.NullOr(Schema.String),
      shortLabel: Schema.String,
      color: Account.Color,
      default: Schema.Boolean,
      loggedIn: Schema.Boolean,
      /** The account's auto-compaction setting (CAG-50); absent = the kind default, which the mirrored policy holds. */
      compaction: optional(Compaction.Setting),
    }),
  ),
}).annotate({ identifier: "Own.Broker.ClaudeAgentRemote" })

/**
 * The host's claude processes and transcript work run on the PC (02 §8.10.13): each is a stream on the broker channel.
 * `claudeAgent.open` names its kind; a `process` stream answers once the PC's pool granted it a slot (which can wait,
 * so the host asks with a long timeout), a `call` stream at once. Text goes in `claudeAgent.write` (in order, at most
 * {@link CLAUDE_AGENT_CHUNK} characters each) and comes back in `claudeAgent.data` pushes; `claudeAgent.exit` ends it.
 * Normal mode only, like `github.*`: an older PC never meets them.
 */
export const CLAUDE_AGENT_CHUNK = 131_072
/** The host waits this long at most for a pool slot before its turn fails. */
export const CLAUDE_AGENT_OPEN_TIMEOUT_MS = 30 * 60_000
/** Streams open at once per host (processes and calls). */
export const CLAUDE_AGENT_STREAMS_MAX = 64

const StreamID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

export const ClaudeAgentOp = Schema.Literals(["exists", "fork", "remove", "chain", "write", "list", "discard", "version"])
export type ClaudeAgentOp = typeof ClaudeAgentOp.Type

export interface ClaudeAgentOpen extends Schema.Schema.Type<typeof ClaudeAgentOpen> {}
export const ClaudeAgentOpen = Schema.Struct({
  stream: StreamID,
  kind: Schema.Literals(["process", "call"]),
  accountID: Account.ID,
  /** The host folder of the conversation (empty for a folder-wide call); the PC picks its own working folder for it. */
  directory: Schema.String.check(Schema.isMaxLength(4096)),
  op: optional(ClaudeAgentOp),
  sessionID: optional(Schema.String.check(Schema.isMaxLength(128))),
  parentID: optional(Schema.String.check(Schema.isMaxLength(128))),
  side: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Broker.ClaudeAgentOpen" })

/** Why the PC did not open a stream; the message is what the host's conversation shows. */
export const ClaudeAgentRefusal = Schema.Literals(["off", "account", "transcripts", "busy", "closed"]).annotate({
  identifier: "Own.Broker.ClaudeAgentRefusal",
})
export type ClaudeAgentRefusal = typeof ClaudeAgentRefusal.Type

export const ClaudeAgentOpened = Schema.Union([
  Schema.Struct({ opened: Schema.Literal(true) }),
  Schema.Struct({ refused: ClaudeAgentRefusal, message: Schema.String }),
]).annotate({ identifier: "Own.Broker.ClaudeAgentOpened" })
export type ClaudeAgentOpened = typeof ClaudeAgentOpened.Type

export interface ClaudeAgentStart extends Schema.Schema.Type<typeof ClaudeAgentStart> {}
export const ClaudeAgentStart = Schema.Struct({
  stream: StreamID,
  args: Schema.Array(Schema.String).check(Schema.isMaxLength(64)),
  env: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "Own.Broker.ClaudeAgentStart" })

export interface ClaudeAgentWrite extends Schema.Schema.Type<typeof ClaudeAgentWrite> {}
export const ClaudeAgentWrite = Schema.Struct({
  stream: StreamID,
  data: optional(Schema.String.check(Schema.isMaxLength(CLAUDE_AGENT_CHUNK))),
  end: optional(Schema.Boolean),
}).annotate({ identifier: "Own.Broker.ClaudeAgentWrite" })

export interface ClaudeAgentClose extends Schema.Schema.Type<typeof ClaudeAgentClose> {}
export const ClaudeAgentClose = Schema.Struct({ stream: StreamID }).annotate({
  identifier: "Own.Broker.ClaudeAgentClose",
})

/** `claudeAgent.data` (L→R): text of a stream, in order. */
export interface ClaudeAgentData extends Schema.Schema.Type<typeof ClaudeAgentData> {}
export const ClaudeAgentData = Schema.Struct({ stream: StreamID, data: Schema.String }).annotate({
  identifier: "Own.Broker.ClaudeAgentData",
})

/** `claudeAgent.exit` (L→R): the stream ended (claude's exit code, or a call's 0 / 1 with the reason). */
export interface ClaudeAgentExit extends Schema.Schema.Type<typeof ClaudeAgentExit> {}
export const ClaudeAgentExit = Schema.Struct({
  stream: StreamID,
  code: Schema.NullOr(Schema.Finite),
  error: optional(Schema.String),
}).annotate({ identifier: "Own.Broker.ClaudeAgentExit" })

// ---------------------------------------------------------------------------------------------------------------
// Local models through the PC (04 §8.14, SLM)

/**
 * A host's request of this PC's local model (a `로컬 모델` account, 02 §3.3a) goes over the egress forward to a
 * `/local/<accountID><path and query>` route of the PC's relay listener, with this per-request proof:
 * `x-own-local: v1.<epoch>.<n>.<accountID>.<mac>` and
 * `mac = HMAC-SHA256(K, LOCAL_MAC_LABEL + hostId|epoch|n|accountID|<METHOD>|<path and query>)`, lowercase hex. `n`
 * shares the arm's counter (and the PC's replay window) with the Claude and git proofs. The PC sends the request to the
 * account's own server (its base URL on this PC, never one the host names) with the account's key when it has one;
 * the key never leaves the PC. The body and every other header pass as they are, so the server sees the bytes a
 * conversation of this PC would send.
 */
export const LOCAL_MAC_LABEL = "own-local/v1|"
export const LOCAL_HEADER = "x-own-local"
/** The relay listener's route prefix of a local model request. */
export const LOCAL_PATH_PREFIX = "/local/"
/** A refusal of the local model relay: one of {@link LocalError}; the body carries a Korean line for the error card. */
export const LOCAL_ERROR_HEADER = "x-own-local-error"

/**
 * Whether a host sends this account's requests through the PC (04 §8.14): a `로컬 모델` account, and any other `compat`
 * account whose base URL is this PC's loopback (`127.0.0.0/8`, `localhost`, `[::1]`, `0.0.0.0`, the IPv4-mapped loopback): seen from the host that address
 * is the host itself, where nothing of this PC listens and another user's process may. Both sides judge it alike.
 */
export function viaPc(account: { readonly kind: string; readonly compat?: { readonly local?: unknown } }, baseURL: string | undefined) {
  if (account.kind !== "compat") return false
  if (account.compat?.local !== undefined) return true
  const host = baseURL === undefined ? undefined : URL.parse(baseURL)?.hostname
  if (host === undefined) return false
  // `0.0.0.0` and the IPv4-mapped loopback (`[::ffff:127.0.0.1]` parses as `[::ffff:7f00:1]`) are this PC too.
  return (
    host === "localhost" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.startsWith("[::ffff:7f") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/**
 * Why the PC did not relay a local model request: `mac` (401), `rate_limited` and `busy` (429), `bad_request` (400,
 * 404, 405: not a request of the account's server path), `not_found` (404: no such local model on this PC),
 * `host_scope` (403: the account is off for SSH hosts, outside this host's account scope, or disabled), `needs_key`
 * (403: the PC cannot read the account's key), `too_large` (413), `upstream_unreachable` (502: the model server on
 * this PC did not answer the connection).
 */
export const LocalError = Schema.Literals([
  "mac",
  "rate_limited",
  "busy",
  "bad_request",
  "not_found",
  "host_scope",
  "needs_key",
  "too_large",
  "upstream_unreachable",
]).annotate({ identifier: "Own.Broker.LocalError" })
export type LocalError = typeof LocalError.Type

/** The HMAC input of a local model request's proof. */
export function localMacInput(input: {
  readonly hostId: string
  readonly epoch: number
  readonly n: number
  readonly accountID: string
  readonly method: string
  readonly path: string
}) {
  return `${LOCAL_MAC_LABEL}${input.hostId}|${input.epoch}|${input.n}|${input.accountID}|${input.method}|${input.path}`
}

/** `v1.<epoch>.<n>.<accountID>.<mac>`. */
export function localHeader(input: {
  readonly epoch: number
  readonly n: number
  readonly accountID: string
  readonly mac: string
}) {
  return `v1.${input.epoch}.${input.n}.${input.accountID}.${input.mac}`
}

/** The parts of an `x-own-local` header, or `undefined` for anything else. */
export function parseLocalHeader(value: string | null) {
  const match =
    value === null ? null : /^v1\.(\d{1,15})\.(\d{1,15})\.(acc_[0-9A-Za-z_]{1,64})\.([0-9a-f]{64})$/.exec(value)
  if (!match) return undefined
  const n = Number(match[2])
  if (n < 1) return undefined
  return { epoch: Number(match[1]), n, accountID: match[3]!, mac: match[4]! }
}

// ---------------------------------------------------------------------------------------------------------------
// The host's fail-closed sink (04 §8.6 step 5)

/**
 * The host's own-accounts names why a request went to its sink (request header {@link FAIL_REASON_HEADER}), so the
 * sink's 401 tells the conversation the reason instead of a bare `own_broker_unavailable` (SLM): one of these codes.
 * `unavailable`: the PC's broker could not be reached; `refused_<HeadersError>`: the PC refused a credential;
 * `blocked`: no credential went in (this folder's plugin trust, 01 §13.2); `claude_<code>`: the Claude relay's route
 * (04 §8.11.4.4); `local_pc_old`: the PC does not relay local models yet.
 */
export const FAIL_REASON_HEADER = "x-own-fail-reason"



/**
 * The host's GitHub tools and git logins are this PC's (16 §8): tokens never leave the PC. Tool calls go over the
 * broker channel (`github.offer`, `github.account`, `github.call`); git's smart HTTP and Git LFS's API go over the
 * egress forward, to a `/github/<site host>/<owner>/<repo>…` route of the same relay listener, with this per-request
 * proof: `x-own-github: v1.<epoch>.<n>.<mac>` and
 * `mac = HMAC-SHA256(K, GITHUB_MAC_LABEL + hostId|epoch|n|<METHOD>|<path and query>|<place header>)`, lowercase hex.
 * `n` shares the arm's counter (and the PC's replay window) with the Claude proofs. The place header names the folder,
 * its main checkout when it is a linked worktree, and the root conversation the git process was started for.
 */
export const GITHUB_MAC_LABEL = "own-github/v1|"
export const GITHUB_HEADER = "x-own-github"
/** base64url of the JSON {@link GitHubPlace} of a git request (covered by the proof). */
export const GITHUB_PLACE_HEADER = "x-own-github-place"
/** A refusal of the git relay: one of {@link GitHubGitError}, on the PC's answer and the host stub's. */
export const GITHUB_ERROR_HEADER = "x-own-github-error"
/** The ticket the host's git sends its stub (`http.<stub>.extraHeader`); never leaves the host. */
export const GITHUB_TICKET_HEADER = "x-own-github-ticket"
/** A tool result is cut to this many UTF-8 bytes before it goes back (frames are 1 MiB). */
export const GITHUB_RESULT_MAX_BYTES = 640 * 1024
/** The host waits this long for `github.call` (GitHub's MCP call takes up to 120 s). */
export const GITHUB_CALL_TIMEOUT_MS = 150_000
/** The host waits this long for `github.offer` and `github.account`. */
export const GITHUB_ASK_TIMEOUT_MS = 15_000
/** Largest Git LFS API request body the relay reads to tell a download from an upload. */
export const GITHUB_LFS_MAX_BODY_BYTES = 1024 * 1024
/**
 * Largest answer of GitHub the relay reads whole to check it before it goes to the host (GH-45): Git LFS's API (the
 * batch, the locks) and every answer of status 300 or more. Pack streams are not read.
 */
export const GITHUB_CHECKED_ANSWER_MAX_BYTES = 1024 * 1024

/**
 * Why the git relay refused (`x-own-github-error`): `mac` (401), `rate_limited` and `busy` (429), `bad_request` (400,
 * 404, 405: not git's smart HTTP or Git LFS's API of one repository), and 403 for the rest: `ticket` and `caller` (the
 * host's stub: no live ticket, a ticket another command holds, or not this host's git or git-lfs), `off` (no account
 * here, `off`, or git logins off), `site` (another site than the account's), `read_only` (a push of an account that
 * allows no writes), `host_read_only` (a push of a host this PC has not allowed to write, GH-49), `problem` (the
 * account's token cannot be used), `unavailable` (the broker or the relay cannot be reached, 503), and 502 for
 * GitHub's answer the PC would not pass on: `leak` (it carried the account's token or login, GH-45), `unchecked` (an
 * answer the PC checks was larger than it reads, {@link GITHUB_CHECKED_ANSWER_MAX_BYTES}).
 */
export const GitHubGitError = Schema.Literals([
  "mac",
  "rate_limited",
  "busy",
  "bad_request",
  "ticket",
  "caller",
  "off",
  "site",
  "read_only",
  "host_read_only",
  "problem",
  "unavailable",
  "leak",
  "unchecked",
]).annotate({ identifier: "Own.Broker.GitHubGitError" })
export type GitHubGitError = typeof GitHubGitError.Type

/** The HMAC input of a git request's proof. */
export function githubMacInput(input: {
  readonly hostId: string
  readonly epoch: number
  readonly n: number
  readonly method: string
  readonly path: string
  readonly place: string
}) {
  return `${GITHUB_MAC_LABEL}${input.hostId}|${input.epoch}|${input.n}|${input.method}|${input.path}|${input.place}`
}

/** `v1.<epoch>.<n>.<mac>`. */
export function githubHeader(input: { readonly epoch: number; readonly n: number; readonly mac: string }) {
  return `v1.${input.epoch}.${input.n}.${input.mac}`
}

/** The parts of an `x-own-github` header, or `undefined` for anything else. */
export function parseGitHubHeader(value: string | null) {
  const match = value === null ? null : /^v1\.(\d{1,15})\.(\d{1,15})\.([0-9a-f]{64})$/.exec(value)
  if (!match) return undefined
  const n = Number(match[2])
  if (n < 1) return undefined
  return { epoch: Number(match[1]), n, mac: match[3]! }
}

const Folder = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

/**
 * Where a host's GitHub use comes from: its folder (a POSIX path there), the main checkout of the repository when the
 * folder is a linked git worktree (a team area, read on the host from its `.git` files), and the root conversation
 * (the host's own session tree). The PC picks the account as for its own folders (16 §3.2), among the choices kept
 * for this host.
 */
export interface GitHubPlace extends Schema.Schema.Type<typeof GitHubPlace> {}
export const GitHubPlace = Schema.Struct({
  directory: Folder,
  main: optional(Folder),
  root: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
}).annotate({ identifier: "Own.Broker.GitHubPlace" })

/** `github.offer`: the tools a Location of the host offers (as `GitHubTools.offer` for this PC's). */
export interface GitHubOfferGet extends Schema.Schema.Type<typeof GitHubOfferGet> {}
export const GitHubOfferGet = Schema.Struct({ directory: Folder, main: optional(Folder) }).annotate({
  identifier: "Own.Broker.GitHubOfferGet",
})

export interface GitHubTool extends Schema.Schema.Type<typeof GitHubTool> {}
export const GitHubTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input: Schema.Unknown,
  read: Schema.Boolean,
  title: optional(Schema.String),
}).annotate({ identifier: "Own.Broker.GitHubTool" })

/**
 * `git`: whether a git process there may get a login at all (an account is connected and git logins are on), so the
 * host asks `github.account` before a shell command only then.
 */
export interface GitHubOffer extends Schema.Schema.Type<typeof GitHubOffer> {}
export const GitHubOffer = Schema.Struct({ tools: Schema.Array(GitHubTool), git: Schema.Boolean }).annotate({
  identifier: "Own.Broker.GitHubOffer",
})

/** An account as the host sees it: never its token. */
export interface GitHubAccount extends Schema.Schema.Type<typeof GitHubAccount> {}
export const GitHubAccount = Schema.Struct({
  id: OwnGitHub.ID,
  label: Schema.String,
  login: Schema.String,
  site: OwnGitHub.Site,
  write: Schema.Boolean,
}).annotate({ identifier: "Own.Broker.GitHubAccount" })

/**
 * `github.account`'s answer: the account the place uses now (none, or `off`), its problem, and `git`: whether git
 * processes there get a login (the setting, and for a command without a conversation no recent conversation choice of
 * another account around the folder, GH-14, GH-33). `hostWrite`: whether this PC lets this host write on GitHub at all
 * (`writeHosts`, GH-49); without it the host's git is read-only whatever the account allows.
 */
export interface GitHubAccountResult extends Schema.Schema.Type<typeof GitHubAccountResult> {}
export const GitHubAccountResult = Schema.Struct({
  account: optional(GitHubAccount),
  source: OwnGitHub.InUseSource,
  problem: optional(OwnGitHub.Problem),
  git: Schema.Boolean,
  hostWrite: Schema.Boolean,
}).annotate({ identifier: "Own.Broker.GitHubAccountResult" })

/**
 * `github.call`: one tool call, with the account the host asked the user about (a write's permission names it); the
 * PC refuses `account_changed` when the place uses another one now, so an approval never covers another account.
 */
export interface GitHubCall extends Schema.Schema.Type<typeof GitHubCall> {}
export const GitHubCall = Schema.Struct({
  ...GitHubPlace.fields,
  tool: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  input: Schema.Unknown,
  account: OwnGitHub.ID,
}).annotate({ identifier: "Own.Broker.GitHubCall" })

export const GitHubCallError = Schema.Literals([
  "off",
  "account_changed",
  "problem",
  "read_only",
  "host_read_only",
  "unknown_tool",
  "failed",
]).annotate({ identifier: "Own.Broker.GitHubCallError" })
export type GitHubCallError = typeof GitHubCallError.Type

/** The call's text (the token cut out, at most {@link GITHUB_RESULT_MAX_BYTES}), or why it did not run. */
export const GitHubCallResult = Schema.Union([
  Schema.Struct({ text: Schema.String, isError: Schema.Boolean, account: GitHubAccount }),
  Schema.Struct({ error: GitHubCallError, message: Schema.String }),
]).annotate({ identifier: "Own.Broker.GitHubCallResult" })
export type GitHubCallResult = typeof GitHubCallResult.Type

// ---------------------------------------------------------------------------------------------------------------
// Handshake frames

export const Mode = Schema.Literals(["normal", "drain"]).annotate({ identifier: "Own.Broker.Mode" })
export type Mode = typeof Mode.Type

export interface Hello extends Schema.Schema.Type<typeof Hello> {}
export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  proto: Schema.Int,
  hostId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  epoch: NonNegativeInt,
  nonceR: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)),
  /** Remote app version and own build id: equal to the local ones = normal mode, else drain (04 §5.7). */
  version: Schema.String,
  buildId: Schema.String,
  mirrorSchemaVersion: Schema.Int,
  /** The remote spool's stream (04 §10.2). */
  streamId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
}).annotate({ identifier: "Own.Broker.Hello" })

export interface Challenge extends Schema.Schema.Type<typeof Challenge> {}
export const Challenge = Schema.Struct({
  type: Schema.Literal("challenge"),
  nonceL: Schema.String,
  mac: Schema.String,
}).annotate({ identifier: "Own.Broker.Challenge" })

export interface Auth extends Schema.Schema.Type<typeof Auth> {}
export const Auth = Schema.Struct({ type: Schema.Literal("auth"), mac: Schema.String }).annotate({
  identifier: "Own.Broker.Auth",
})

/**
 * Host settings the remote needs for its own fail-closed decisions (04 §8.6–8.7); lease lengths stay local
 * (`headers.get` answers `ttlMs`).
 */
export interface RemoteSettings extends Schema.Schema.Type<typeof RemoteSettings> {}
export const RemoteSettings = Schema.Struct({
  failClosedGraceSeconds: NonNegativeInt,
  brokerWaitMs: NonNegativeInt,
}).annotate({ identifier: "Own.Broker.RemoteSettings" })

export interface Ready extends Schema.Schema.Type<typeof Ready> {}
export const Ready = Schema.Struct({
  type: Schema.Literal("ready"),
  mode: Mode,
  proto: Schema.Int,
  /** The local clock at `ready`, a first skew sample for the remote. */
  localNow: EpochMillis,
  /** Identifies the local install that feeds this mirror (`mirror.from`). */
  from: Schema.String,
  settings: RemoteSettings,
}).annotate({ identifier: "Own.Broker.Ready" })

export const RejectReason = Schema.Literals(["skew", "auth", "proto", "busy"]).annotate({
  identifier: "Own.Broker.RejectReason",
})
export type RejectReason = typeof RejectReason.Type

export interface Reject extends Schema.Schema.Type<typeof Reject> {}
export const Reject = Schema.Struct({ type: Schema.Literal("reject"), reason: RejectReason }).annotate({
  identifier: "Own.Broker.Reject",
})

// ---------------------------------------------------------------------------------------------------------------
// Requests (R→L) and responses

/**
 * `github.*` (16 §8, GH-37) only in normal mode: a host calls them only on a session whose `ready` said `normal` (the
 * same build on both sides), so an older PC never meets them.
 */
export const Method = Schema.Literals([
  "registry.get",
  "template.get",
  "headers.get",
  "observe.push",
  "ping",
  "github.offer",
  "github.account",
  "github.call",
  "claudeAgent.open",
  "claudeAgent.start",
  "claudeAgent.write",
  "claudeAgent.close",
  "creator.get",
  "creator.file",
  "creator.report",
  "codexRow.get",
  "mcp.values",
]).annotate({ identifier: "Own.Broker.Method" })
export type Method = typeof Method.Type

/** What a drain-mode session may call (04 §5.7): enough for running turns to finish, nothing that updates the mirror. */
export const DRAIN_METHODS: ReadonlyArray<Method> = ["headers.get", "observe.push", "ping"]

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  type: Schema.Literal("req"),
  id: PositiveInt,
  method: Method,
  params: Schema.Unknown,
}).annotate({ identifier: "Own.Broker.Request" })

/** Response `error` values (not `headers.get` refusals, which are successful results). */
export const ResponseError = Schema.Literals(["invalid", "unknown_method", "skew_drain", "internal"]).annotate({
  identifier: "Own.Broker.ResponseError",
})
export type ResponseError = typeof ResponseError.Type

export interface Response extends Schema.Schema.Type<typeof Response> {}
export const Response = Schema.Struct({
  type: Schema.Literal("res"),
  id: PositiveInt,
  ok: Schema.Boolean,
  result: optional(Schema.Unknown),
  error: optional(ResponseError),
}).annotate({ identifier: "Own.Broker.Response" })

/** `registry.get` params. `since` is informative (the answer is always the whole view). */
export interface RegistryGet extends Schema.Schema.Type<typeof RegistryGet> {}
export const RegistryGet = Schema.Struct({ since: Schema.NullOr(NonNegativeInt) }).annotate({
  identifier: "Own.Broker.RegistryGet",
})

export interface Revisions extends Schema.Schema.Type<typeof Revisions> {}
export const Revisions = Schema.Struct({
  registryRevision: NonNegativeInt,
  policyRevision: NonNegativeInt,
  ratecardsRevision: NonNegativeInt,
}).annotate({ identifier: "Own.Broker.Revisions" })

/**
 * Money state of one paid account the host may use (07 §5.4 step 4): whether this month's budget is used up. The
 * remote cannot read the local ledger, so this is all its subagent gate knows.
 */
export interface PresetBudget extends Schema.Schema.Type<typeof PresetBudget> {}
export const PresetBudget = Schema.Struct({ exhausted: Schema.Boolean }).annotate({
  identifier: "Own.Broker.PresetBudget",
})

/**
 * The mirrored registry view (04 §9.2). `registry` is an `accounts.json` without secrets or identifiers: accounts
 * keep `{id, kind, label, shortLabel, color, providerID, billing, status, autoSwitch, remote, compaction}` plus the
 * domain ids the file schema needs (`identity` is empty, domains lose `externalId`, `credential`, `budget` and
 * `claudeSlot` are gone). Accounts the host may not use are `disabled` so their slots stay registered with every
 * model disabled. `registry.modelTemplates` is empty: `templates` names each template with a content hash and the
 * remote fetches the ones it does not hold with `template.get` (a template can be hundreds of KB, frames are 1 MiB).
 *
 * T3 (07 §8.1 원격): `presets` is the local `presets.json` and `presetsRevision` its revision (a content hash like
 * `policyRevision`), so the remote gate uses the same presets. `presetsBudget` holds the paid accounts of the view; a
 * paid account missing there counts as used up (fail closed). Budgets gate subagent targets only (07 §5.4 step 4):
 * the remote gate refuses them, and a lease is never refused for budget, as on the local PC. All three are absent
 * from views of older builds, where the remote keeps `평소대로` only.
 *
 * 04 §8.11: `claude` is the PC's verdict for the Claude subscription slot on this host, absent when the PC has no
 * slot detected. A view without it (an older PC) leaves `anthropic` disabled on the host. Like the T3 fields it is
 * optional, so `PROTO` and {@link MIRROR_SCHEMA_VERSION} stay; an older host ignores it (Effect structs drop unknown
 * keys).
 *
 * 10 §6.14 (2.2.6-own.18): `codexRows` names, by content hash, the served Codex model rows this PC's codex harness
 * runs from (`CodexModels.HarnessRow`, the shared list's `harness`), so a host's harness runs new Codex models from
 * the same rows without fetching a model list itself; the host fetches the rows it does not hold with `codexRow.get`
 * (each tens of KB, frames are 1 MiB). Optional like the T3 fields: an older host ignores it, and a host never asks
 * an older PC, whose view has none.
 */
export interface MirrorView extends Schema.Schema.Type<typeof MirrorView> {}
export const MirrorView = Schema.Struct({
  schemaVersion: Schema.Literal(MIRROR_SCHEMA_VERSION),
  ...Revisions.fields,
  registry: Registry.File,
  templates: Schema.Record(Schema.String, Schema.String),
  policy: Policy.File,
  ratecards: Ratecard.File,
  presets: optional(Preset.File),
  presetsRevision: optional(NonNegativeInt),
  presetsBudget: optional(keyedRecord(Account.ID, PresetBudget)),
  claude: optional(ClaudeRemote),
  /** 02 §8.10.13: the PC's Claude Agent accounts this host may use; absent = the route is off on the host. */
  claudeAgent: optional(ClaudeAgentRemote),
  /** 10 §6.14: the served Codex rows by slug → content hash; absent from an older PC. */
  codexRows: optional(Schema.Record(Schema.String, Schema.String)),
  /**
   * 04 §8.14: this PC relays the host's requests of its local models (`로컬 모델` accounts) to their servers on this PC.
   * Absent = an older PC: the host sends them nowhere (the sink, `local_pc_old`).
   */
  localRelay: optional(Schema.Literal(true)),
}).annotate({ identifier: "Own.Broker.MirrorView" })

export interface TemplateGet extends Schema.Schema.Type<typeof TemplateGet> {}
export const TemplateGet = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Own.Broker.TemplateGet" })

/** `codexRow.get` params (10 §6.14): one served Codex row named in `MirrorView.codexRows`. */
export interface CodexRowGet extends Schema.Schema.Type<typeof CodexRowGet> {}
export const CodexRowGet = Schema.Struct({ slug: Schema.String }).annotate({ identifier: "Own.Broker.CodexRowGet" })

/** The row and its hash now; `row: null` when the PC no longer has it (the host then fetches the view again). */
export interface CodexRowResult extends Schema.Schema.Type<typeof CodexRowResult> {}
export const CodexRowResult = Schema.Struct({
  slug: Schema.String,
  hash: Schema.String,
  row: Schema.NullOr(CodexModels.HarnessRow),
}).annotate({ identifier: "Own.Broker.CodexRowResult" })

export interface TemplateResult extends Schema.Schema.Type<typeof TemplateResult> {}
export const TemplateResult = Schema.Struct({
  id: Schema.String,
  hash: Schema.String,
  template: Schema.NullOr(Registry.ModelTemplate),
}).annotate({ identifier: "Own.Broker.TemplateResult" })

/**
 * `mirror` metadata the remote stores in its `accounts.json` next to the view (04 §9.2). A mirror with another
 * `schemaVersion` is not used (guard 1 of the remote mode).
 */
export interface MirrorMeta extends Schema.Schema.Type<typeof MirrorMeta> {}
export const MirrorMeta = Schema.Struct({
  schemaVersion: Schema.Int,
  from: Schema.String,
  ...Revisions.fields,
  fetchedAt: EpochMillis,
  templates: optional(Schema.Record(Schema.String, Schema.String)),
  /** `MirrorView.presetsRevision` of the `presets.json` written with this mirror (T3); absent before. */
  presetsRevision: optional(NonNegativeInt),
  /** `MirrorView.claude` of this mirror (04 §8.11.4.3), so a restarted host keeps the verdict until the next view. */
  claude: optional(ClaudeRemote),
  /** `MirrorView.claudeAgent` of this mirror (02 §8.10.13), kept the same way. */
  claudeAgent: optional(ClaudeAgentRemote),
  /** `MirrorView.codexRows` of the rows written to the host's `codex-meta.json` (10 §6.14); absent before. */
  codexRows: optional(Schema.Record(Schema.String, Schema.String)),
  /** `MirrorView.localRelay` of this mirror (04 §8.14), kept the same way. */
  localRelay: optional(Schema.Literal(true)),
}).annotate({ identifier: "Own.Broker.MirrorMeta" })

/** Why `headers.get` gave no lease (04 §8.4). `source_stale` is for linked Codex accounts only. */
export const HeadersError = Schema.Literals([
  "account_not_remote",
  "needs_reauth",
  "source_stale",
  "exhausted_blocked",
  "rate_limited",
  "not_found",
  "vault_unavailable",
]).annotate({ identifier: "Own.Broker.HeadersError" })
export type HeadersError = typeof HeadersError.Type

export interface HeadersGet extends Schema.Schema.Type<typeof HeadersGet> {}
export const HeadersGet = Schema.Struct({
  providerID: Kind.ProviderID,
  kind: Kind.Own,
  sessionID: Schema.String,
  /** Audit only: the local side cannot check the remote allowlist verdict (04 §15). */
  directory: Schema.String,
  allowlist: Schema.Literal("ok"),
  /** `authHash8` of a lease the provider answered 401 to (04 §8.8). */
  invalidate: optional(Schema.String),
}).annotate({ identifier: "Own.Broker.HeadersGet" })

/**
 * A lease (04 §8.5): only the credential headers (codex `authorization` + `chatgpt-account-id`, siwc
 * `authorization`, keys `authorization` or `x-api-key`), their `authHash8`, and a relative lifetime. `generation` grows when the value
 * changes, so a `revoke{generation}` names the leases it ends.
 */
export interface Lease extends Schema.Schema.Type<typeof Lease> {}
export const Lease = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  authHash8: Schema.String,
  ttlMs: PositiveInt,
  generation: NonNegativeInt,
}).annotate({ identifier: "Own.Broker.Lease" })

export interface Refusal extends Schema.Schema.Type<typeof Refusal> {}
export const Refusal = Schema.Struct({
  error: HeadersError,
  /** `source_stale` only: the source token's remaining life (negative = expired). */
  expiresInMs: optional(Schema.Finite),
}).annotate({ identifier: "Own.Broker.Refusal" })

export const HeadersResult = Schema.Union([Lease, Refusal]).annotate({ identifier: "Own.Broker.HeadersResult" })
export type HeadersResult = typeof HeadersResult.Type

export interface ObservePush extends Schema.Schema.Type<typeof ObservePush> {}
export const ObservePush = Schema.Struct({
  streamId: Schema.String,
  fromSeq: NonNegativeInt,
  /** Decoded one by one (an item of an unknown `schemaVersion` stops the batch without an ack past it). */
  items: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(PUSH_MAX_ITEMS)),
}).annotate({ identifier: "Own.Broker.ObservePush" })

export interface ObserveAck extends Schema.Schema.Type<typeof ObserveAck> {}
export const ObserveAck = Schema.Struct({ ackThrough: NonNegativeInt }).annotate({
  identifier: "Own.Broker.ObserveAck",
})

export interface Ping extends Schema.Schema.Type<typeof Ping> {}
export const Ping = Schema.Struct({
  remoteNow: EpochMillis,
  /** Spool state for `hosts.list.broker` (informative). */
  backlog: optional(NonNegativeInt),
  gaps: optional(NonNegativeInt),
}).annotate({ identifier: "Own.Broker.Ping" })

export interface Pong extends Schema.Schema.Type<typeof Pong> {}
export const Pong = Schema.Struct({ localNow: EpochMillis }).annotate({ identifier: "Own.Broker.Pong" })

// ---------------------------------------------------------------------------------------------------------------
// Creator mirror (17 §10, 04 §9.3): normal mode only, like `github.*` (both sides are this build, so the format is one)

/** `creator.get` params: the host asks for this PC's extensions that reach it; the answer is a `Creator.MirrorView`. */
export interface CreatorGet extends Schema.Schema.Type<typeof CreatorGet> {}
export const CreatorGet = Schema.Struct({}).annotate({ identifier: "Own.Broker.CreatorGet" })

/** `creator.get` result: `view` is absent when this PC runs no own.creator. */
export interface CreatorGetResult extends Schema.Schema.Type<typeof CreatorGetResult> {}
export const CreatorGetResult = Schema.Struct({ view: optional(Creator.MirrorView) }).annotate({
  identifier: "Own.Broker.CreatorGetResult",
})

/**
 * `creator.file` params: one chunk of one file of a version the host's view names (anything else is refused). Read only:
 * no method writes this PC's store.
 */
export interface CreatorFile extends Schema.Schema.Type<typeof CreatorFile> {}
export const CreatorFile = Schema.Struct({
  id: Creator.ID,
  n: PositiveInt,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  offset: NonNegativeInt,
}).annotate({ identifier: "Own.Broker.CreatorFile" })

/** `creator.file` result: base64 bytes from `offset`, the file's size, and whether this chunk ends it. */
export interface CreatorChunk extends Schema.Schema.Type<typeof CreatorChunk> {}
export const CreatorChunk = Schema.Struct({
  data: Schema.String,
  size: NonNegativeInt,
  end: Schema.Boolean,
}).annotate({ identifier: "Own.Broker.CreatorChunk" })

/** `creator.changed` push: the host's view may have changed; it asks `creator.get` again. */
export interface CreatorChanged extends Schema.Schema.Type<typeof CreatorChanged> {}
export const CreatorChanged = Schema.Struct({}).annotate({ identifier: "Own.Broker.CreatorChanged" })

// ---------------------------------------------------------------------------------------------------------------
// MCP servers of this PC on the host (04 §13 "MCP", MH 2026-11-26): normal mode only, like `github.*`. A host's
// installed server asks for the values the user sent to it (`mcp.hosts.send` on the PC); the PC answers from its
// copy, for that host only, and pushes `mcp.changed` when a send or a withdrawal changed what a host may get.

/** `mcp.values` params: the host's server (its own id there). */
export interface McpValuesGet extends Schema.Schema.Type<typeof McpValuesGet> {}
export const McpValuesGet = Schema.Struct({
  server: Schema.String.check(Schema.isPattern(/^mcp_[0-9A-Z]{26}$/)),
}).annotate({ identifier: "Own.Broker.McpValuesGet" })

/**
 * `mcp.values` result: the values sent to this host's server (`env`, `headers`, and the address's `?` part `search`
 * and hidden address `url` under the name `URL`), or `sent: false` when nothing is sent (withdrawn, never sent).
 */
export interface McpValues extends Schema.Schema.Type<typeof McpValues> {}
export const McpValues = Schema.Struct({
  sent: Schema.Boolean,
  env: Schema.Record(Schema.String, Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
  search: optional(Schema.String),
  url: optional(Schema.String),
}).annotate({ identifier: "Own.Broker.McpValues" })

/** The host waits this long for `mcp.values`. */
export const MCP_ASK_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------------------------------------------
// Pushes (L→R)

/** `github.changed` (16 §8): the PC's GitHub accounts, choices, settings or tool list changed; the host asks again. */
export const PushEvent = Schema.Literals([
  "mirror.changed",
  "quota.updated",
  "calibration.updated",
  "account.status",
  "revoke",
  "github.changed",
  "claudeAgent.data",
  "claudeAgent.exit",
  "creator.changed",
  "mcp.changed",
]).annotate({ identifier: "Own.Broker.PushEvent" })
export type PushEvent = typeof PushEvent.Type

/** Pushes a drain-mode session still gets (04 §5.7). */
export const DRAIN_PUSHES: ReadonlyArray<PushEvent> = ["account.status", "revoke"]

export interface Push extends Schema.Schema.Type<typeof Push> {}
export const Push = Schema.Struct({ type: Schema.Literal("push"), event: PushEvent, data: Schema.Unknown }).annotate({
  identifier: "Own.Broker.Push",
})

/**
 * `quota.updated` (04 §8.4): this PC's changed windows, and `dropped`, the windows this PC's store forgot (a removed
 * monthly budget, `Limits.Store.drop`, LV 2026-10-25), which the host forgets too; it only upserts otherwise, so the
 * removed budget stayed there until its month reset. An older host ignores the field.
 */
export interface QuotaUpdated extends Schema.Schema.Type<typeof QuotaUpdated> {}
export const QuotaUpdated = Schema.Struct({
  windows: Schema.Array(Limit.Window),
  dropped: optional(
    Schema.Array(Schema.Struct({ accountID: Limit.Window.fields.accountID, id: Limit.Window.fields.id })),
  ),
}).annotate({
  identifier: "Own.Broker.QuotaUpdated",
})

/**
 * `account.status` (04 §8.4). `scope:"host"`: the local account is unchanged and only this host's leases are blocked
 * (a linked account's `source_stale`, and its release with `status:"ready"`). Without `scope`, the local status.
 */
export interface AccountStatus extends Schema.Schema.Type<typeof AccountStatus> {}
export const AccountStatus = Schema.Struct({
  accountID: Account.ID,
  status: Account.Status,
  reason: optional(Schema.String),
  scope: optional(Schema.Literal("host")),
}).annotate({ identifier: "Own.Broker.AccountStatus" })

export interface Revoke extends Schema.Schema.Type<typeof Revoke> {}
export const Revoke = Schema.Struct({ providerID: Schema.String, generation: optional(NonNegativeInt) }).annotate({
  identifier: "Own.Broker.Revoke",
})

// ---------------------------------------------------------------------------------------------------------------
// Observation items (04 §10.1–10.3)

export const ItemType = Schema.Literals(["ledger", "limits", "event", "authFailure", "gap"]).annotate({
  identifier: "Own.Broker.ItemType",
})
export type ItemType = typeof ItemType.Type

/** The envelope every spool line and pushed item has; `payload` is decoded by `type` and `schemaVersion`. */
export interface Item extends Schema.Schema.Type<typeof Item> {}
export const Item = Schema.Struct({
  seq: PositiveInt,
  /** ULID; the local ledger writer's idempotency is the second line of defense (04 §10.3). */
  eventId: Schema.String,
  schemaVersion: PositiveInt,
  /** Remote clock. */
  at: EpochMillis,
  type: Schema.String,
  payload: Schema.Unknown,
}).annotate({ identifier: "Own.Broker.Item" })

export interface LedgerPayload extends Schema.Schema.Type<typeof LedgerPayload> {}
export const LedgerPayload = Schema.Struct({ eid: Schema.String, line: Ledger.Line }).annotate({
  identifier: "Own.Broker.LedgerPayload",
})

export interface LimitsPayload extends Schema.Schema.Type<typeof LimitsPayload> {}
export const LimitsPayload = Schema.Struct({ windows: Schema.Array(Limit.Window) }).annotate({
  identifier: "Own.Broker.LimitsPayload",
})

/** An events-ledger line of the remote (switches, alerts, exhaustion, …), as its writer would store it. */
export interface EventPayload extends Schema.Schema.Type<typeof EventPayload> {}
export const EventPayload = Schema.Struct({
  eid: Schema.String,
  ts: EpochMillis,
  type: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  accountID: optional(Schema.NullOr(Schema.String)),
  providerID: optional(Schema.NullOr(Schema.String)),
  sessionID: optional(Schema.NullOr(Schema.String)),
  data: optional(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "Own.Broker.EventPayload" })

/** The provider refused a leased credential (04 §10.6). Never a token value, only its `hash8`. */
export interface AuthFailurePayload extends Schema.Schema.Type<typeof AuthFailurePayload> {}
export const AuthFailurePayload = Schema.Struct({
  providerID: Schema.String,
  authHash8: Schema.String,
  status: Schema.Int,
}).annotate({ identifier: "Own.Broker.AuthFailurePayload" })

/** Items the spool dropped on overflow (04 §10.2). */
export interface GapPayload extends Schema.Schema.Type<typeof GapPayload> {}
export const GapPayload = Schema.Struct({ fromSeq: PositiveInt, toSeq: PositiveInt, count: PositiveInt }).annotate({
  identifier: "Own.Broker.GapPayload",
})

/** Payload schema per item type (for {@link ITEM_SCHEMA_VERSION}). */
export const payloads = {
  ledger: LedgerPayload,
  limits: LimitsPayload,
  event: EventPayload,
  authFailure: AuthFailurePayload,
  gap: GapPayload,
} as const

/** Frame encoding (length prefix + JSON). Throws for a value whose encoding exceeds {@link MAX_FRAME_BYTES}. */
export function encodeFrame(value: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value))
  if (body.length > MAX_FRAME_BYTES) throw new RangeError(`broker frame of ${body.length} bytes exceeds the limit`)
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, false)
  frame.set(body, 4)
  return frame
}

/** The HMAC input of the local (challenge) and remote (auth) proofs (04 §8.3). */
export function macInput(side: "L" | "R", input: {
  readonly hostId: string
  readonly epoch: number
  readonly nonceR: string
  readonly nonceL: string
}) {
  return side === "L"
    ? `${MAC_LOCAL}${input.hostId}|${input.epoch}|${input.nonceR}|${input.nonceL}`
    : `${MAC_REMOTE}${input.hostId}|${input.epoch}|${input.nonceL}|${input.nonceR}`
}
