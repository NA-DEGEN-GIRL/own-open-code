export * as Policy from "./policy.js"

import path from "node:path"
import { OwnAccounts, Voice } from "@own/protocol"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnImportRouting } from "@own/protocol/rpc-import-routing"
import { OwnTeamRouting } from "@own/protocol/rpc-team-routing"
import { OwnRemote } from "../protocol/rpc-remote.js"

/**
 * What a device may send through `/srv/<serverKey>/api/*` (05 §13.4 "범위 강제", §13.5 범위 표). An allow list: every
 * upstream route is listed with the device scope it needs or as always blocked, and a route that is not listed is
 * refused (an upstream addition fails closed, 05 §13.8). Plugin RPC is decided by the protocol tables
 * (`OwnAccounts.MethodScope`, `OwnRemote.MethodScope`, `OwnTeamRouting.MethodScope`, `OwnImportRouting.MethodScope`,
 * `OwnHarness.MethodScope`), never by a copy here; `own.computer` passes only its watch and stop methods (`COMPUTER_METHODS`), and `own.import`
 * only on this PC, by its table (09 §5.5 I2: the views `read`, the migration `prompt`, the roots setting `local`).
 * Devices paired on the app listener (`kind: "app"`, 08 §3.5) go through the same rules: only the scopes count, never
 * the device kind.
 *
 * `test/gateway/policy.test.ts` checks that every route of `packages/protocol/openapi.json` has an entry.
 *
 * The viewer socket of the browser pane (`/own/browser/…`, 05 §8.10) is the gateway's own route, not a relayed one: it
 * is not in {@link ROUTES} and is decided by {@link browserView}. The device scope `browser` opens nothing here.
 */

export type DeviceScope = OwnRemote.DeviceScope

export type Need =
  /** Needs this device scope. */
  | { readonly kind: "scope"; readonly scope: DeviceScope }
  /** Never through the gateway, whatever the scopes (05 §13.4 "항상 막는 경로"). */
  | { readonly kind: "blocked"; readonly reason: string }
  /** `POST /api/rpc/:rpcID/:method`: the protocol tables decide, with the body (`scopeOf`). */
  | { readonly kind: "rpc" }
  /** `prompt`, and the decision must not be `always` (05 §13.5 "권한 응답은 한 번만"). */
  | { readonly kind: "permission-reply" }
  /** `prompt`, and the body must not write `permissions` (own-web uses `session.approval.set`, an `admin` RPC). */
  | { readonly kind: "session-update" }
  /**
   * `POST /api/session` (`prompt`) and `POST /api/experimental/session/import` (`admin`). A device's new session gets
   * its approval mode the way own-web sets it, through `session.approval.set` (묻기, 읽기 전용 or 전체 허용, decided by
   * `OwnAccounts.scopeOf`), and its agent by name; its `permissions` carry nothing else (decisions RL5-4): none, or only
   * own-web's browser deny ({@link deviceRules}). The one exception is a hand-over (`새 세션으로 인계`, own-web
   * `switcher/flow.ts`), which copies its source's rules as they are: the body names the source
   * (`metadata.own.seededFrom`, {@link handoffSource}) and the relay reads it and passes only rules equal to the
   * source's that do not allow `computer` ({@link handedOver}), like a fork. An import's `info.permissions` (`admin`)
   * must not allow `computer`: computer use is turned on only on the PC (01 §10.2). A child (`parentID`,
   * {@link parentOf}) is also refused when its parent's rules allow `computer`, like a fork.
   */
  | { readonly kind: "session-create"; readonly scope: "prompt" | "admin"; readonly rules: "permissions" | "info" }
  /**
   * `POST /api/session/:sessionID/fork` (`prompt`): a fork copies its source's rules into a new top-level session, so
   * the relay also reads the source first and refuses the fork when those rules allow `computer` ({@link forkable}).
   */
  | { readonly kind: "session-fork" }
  /**
   * `POST /api/session/:sessionID/form/:formID/reply` (`prompt`): the answer must not be the computer-use allow
   * (`OwnComputer.ALLOW_ANSWER`), which grants an app in `question` approval; app grants stay on the PC (01 §10.2).
   */
  | { readonly kind: "form-reply" }
  /**
   * `POST /api/session/:sessionID/prompt` (`prompt`): the relay reads the body (up to {@link PROMPT_BODY_LIMIT}) and
   * forwards it with the device stamp ({@link stamp}), so own.team can tell a device's reply from the PC's when it
   * approves a voice plan (06 §2.9).
   */
  | { readonly kind: "prompt" }
  /**
   * `POST /api/experimental/fs/write` (`files`): upstream writes wherever `?path=` resolves, outside the Location too,
   * so the relay also reads the server's temp folder (`GET /api/info`) and passes only a path inside it
   * ({@link tmpWritable}): attachment uploads and staged git inputs, never a startup script, hook or config.
   */
  | { readonly kind: "fs-write" }

const scope = (value: DeviceScope): Need => ({ kind: "scope", scope: value })
const blocked = (reason: string): Need => ({ kind: "blocked", reason })

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/** `[method, path template (upstream's), need]`. `:x` is one segment, a trailing `*` the rest. */
export const ROUTES: ReadonlyArray<readonly [Method, string, Need]> = [
  // Server and catalogs
  ["GET", "/api/info", scope("read")],
  ["GET", "/api/location", scope("read")],
  ["POST", "/api/location/reload", blocked("location_reload")],
  ["GET", "/api/agent", scope("read")],
  ["GET", "/api/agent/:agentID", scope("read")],
  ["GET", "/api/command", scope("read")],
  ["GET", "/api/skill", scope("read")],
  ["GET", "/api/model", scope("read")],
  ["GET", "/api/model/default", scope("read")],
  ["GET", "/api/provider", scope("read")],
  ["GET", "/api/provider/:providerID", scope("read")],
  ["GET", "/api/plugin", scope("read")],
  ["POST", "/api/plugin/check", scope("admin")],
  // Installs code into the process.
  ["POST", "/api/plugin/update", blocked("plugin_install")],
  ["GET", "/api/mcp", scope("read")],
  ["GET", "/api/mcp/resource", scope("read")],
  ["PUT", "/api/experimental/mcp/:server", scope("admin")],
  ["DELETE", "/api/experimental/mcp/:server", scope("admin")],
  ["POST", "/api/experimental/mcp/:server/connect", scope("admin")],
  ["POST", "/api/experimental/mcp/:server/disconnect", scope("admin")],
  ["GET", "/api/websearch/provider", scope("read")],
  ["POST", "/api/websearch", scope("prompt")],
  ["GET", "/api/experimental/migration/v1", scope("read")],
  // The raw config may hold provider keys written by hand: an admin read, never a write.
  ["GET", "/api/config", scope("admin")],
  ["GET", "/api/config/shell", scope("terminal")],
  ["PATCH", "/api/experimental/config", blocked("config_write")],
  ["GET", "/api/debug/location", scope("admin")],
  ["DELETE", "/api/debug/location", scope("admin")],
  // A heap snapshot of the service holds every secret in its memory (upstream v2.2).
  ["POST", "/api/debug/heap-dump", blocked("heap_dump")],
  // GUI plugin bundles of the desktop app (upstream v2.2): own-web loads none.
  ["GET", "/api/plugin/gui", blocked("plugin_gui")],
  ["GET", "/api/event", scope("read")],

  // Credentials, integrations (logins, keys, OAuth), pairing: always blocked (05 §13.4).
  // GET /api/credential returns every stored credential with its secret (upstream 4c33a253aa).
  ["GET", "/api/credential", blocked("credential")],
  ["POST", "/api/credential", blocked("credential")],
  ["PATCH", "/api/credential/:credentialID", blocked("credential")],
  ["DELETE", "/api/credential/:credentialID", blocked("credential")],
  ["POST", "/api/credential/:credentialID/activate", blocked("credential")],
  ["GET", "/api/integration", blocked("integration")],
  ["GET", "/api/integration/:integrationID", blocked("integration")],
  ["POST", "/api/integration/:integrationID/connect/command", blocked("integration")],
  ["GET", "/api/integration/:integrationID/connect/command/:attemptID", blocked("integration")],
  ["DELETE", "/api/integration/:integrationID/connect/command/:attemptID", blocked("integration")],
  ["POST", "/api/integration/:integrationID/connect/key", blocked("integration")],
  ["POST", "/api/integration/:integrationID/connect/external", blocked("integration")],
  ["POST", "/api/integration/:integrationID/connect/oauth", blocked("integration")],
  ["GET", "/api/integration/:integrationID/connect/oauth/:attemptID", blocked("integration")],
  ["DELETE", "/api/integration/:integrationID/connect/oauth/:attemptID", blocked("integration")],
  ["POST", "/api/integration/:integrationID/connect/oauth/:attemptID/complete", blocked("integration")],
  ["POST", "/api/experimental/integration/wellknown", blocked("integration")],
  ["POST", "/api/pair", blocked("pair")],
  // The landing route of an upstream pairing link (POST /api/pair creates its code).
  ["GET", "/auth/connect/:code", blocked("pair")],
  // Realtime voice sessions (upstream d4a6223d01) are minted with a server-stored OpenAI or xAI API key. own's voice
  // input uses only its dedicated voice key (VOICE, 02 §3.9), and own-web does not call this route.
  ["POST", "/api/experimental/voice/session", blocked("voice_realtime")],
  // Upstream v2.2's speech catalog for the same server-key voice features; own-web's voice input does not use it.
  ["GET", "/api/experimental/voice/models", blocked("voice_realtime")],
  // MCP servers of a client and the token that registers one (upstream v2.2): an MCP server runs with the service's
  // rights, and own-web registers none.
  ["GET", "/api/experimental/client-mcp", blocked("client_mcp")],
  ["POST", "/api/experimental/client-mcp/token", blocked("client_mcp")],
  // Model calls outside a session on the service's credentials (upstream v2.2): text, images and decisions.
  ["POST", "/api/experimental/generate/text", blocked("generate")],
  ["POST", "/api/experimental/generate/image", blocked("generate")],
  ["POST", "/api/experimental/generate/decisions", blocked("generate")],
  // Videos made on the service's credentials outside a session (upstream v2.4.0): own-web does not offer them.
  ["POST", "/api/experimental/generate/video", blocked("generate")],
  ["GET", "/api/experimental/generate/video/:id", blocked("generate")],
  // Automations run prompts, scripts and shell commands later on the service without the device (upstream v2.4.0,
  // the schedules before them since v2.2): own-web does not offer them, and own lists none of their tools (MR18).
  ["POST", "/api/experimental/automation", blocked("automation")],
  ["GET", "/api/experimental/automation", blocked("automation")],
  ["GET", "/api/experimental/automation/:automationID", blocked("automation")],
  ["DELETE", "/api/experimental/automation/:automationID", blocked("automation")],
  ["POST", "/api/experimental/automation/:automationID/pause", blocked("automation")],
  ["POST", "/api/experimental/automation/:automationID/resume", blocked("automation")],
  // Stored media blobs (upstream v2.4.0, `media_blob`, off in own's channel): own-web reads media from messages.
  ["GET", "/api/experimental/blob/:id", blocked("blob")],
  // Other machines this service drives (upstream v2.4.0, `machines`, off in own's channel).
  ["GET", "/api/experimental/machine/link", blocked("machine")],
  ["GET", "/api/experimental/machine", blocked("machine")],
  ["POST", "/api/experimental/machine", blocked("machine")],
  ["DELETE", "/api/experimental/machine/:name", blocked("machine")],
  // Plan usage of the service's provider logins (upstream v2.2): own-web shows own's limits through own.accounts.
  ["GET", "/api/experimental/usage/limits", blocked("usage_limits")],
  // Artifacts from pluggable providers, previewed as served HTML and PDF (upstream v2.2.4, `experimental.artifacts`,
  // off by default): own-web does not offer them, and a view would serve a provider's pages under the gateway's origin.
  ["GET", "/api/experimental/artifacts/providers", blocked("artifacts")],
  ["GET", "/api/experimental/artifacts", blocked("artifacts")],
  ["POST", "/api/experimental/artifacts", blocked("artifacts")],
  ["GET", "/api/experimental/artifacts/:artifactID", blocked("artifacts")],
  ["PATCH", "/api/experimental/artifacts/:artifactID", blocked("artifacts")],
  ["DELETE", "/api/experimental/artifacts/:artifactID", blocked("artifacts")],
  ["GET", "/api/experimental/artifacts/:artifactID/view/*", blocked("artifacts")],
  // Background jobs of every session, with their kinds and status (upstream v2.2.6, experimental): own-web does not
  // read it, and it lists work across sessions a device may not hold.
  ["GET", "/api/experimental/job", blocked("job")],
  ["POST", "/api/experimental/job/:id/cancel", blocked("job")],

  // Projects and sessions
  ["GET", "/api/project", scope("read")],
  ["PATCH", "/api/project/:projectID", scope("admin")],
  ["GET", "/api/session", scope("read")],
  ["POST", "/api/session", { kind: "session-create", scope: "prompt", rules: "permissions" }],
  ["GET", "/api/session/active", scope("read")],
  ["GET", "/api/session/:sessionID", scope("read")],
  ["PATCH", "/api/session/:sessionID", { kind: "session-update" }],
  ["DELETE", "/api/session/:sessionID", scope("admin")],
  ["POST", "/api/session/:sessionID/agent", scope("prompt")],
  ["POST", "/api/session/:sessionID/model", scope("switch")],
  ["POST", "/api/session/:sessionID/background", scope("prompt")],
  ["POST", "/api/session/:sessionID/command", scope("prompt")],
  ["POST", "/api/session/:sessionID/compact", scope("prompt")],
  ["GET", "/api/session/:sessionID/context", scope("read")],
  ["GET", "/api/session/:sessionID/diff", scope("files")],
  ["PUT", "/api/session/:sessionID/environment", scope("terminal")],
  ["POST", "/api/session/:sessionID/fork", { kind: "session-fork" }],
  ["GET", "/api/session/:sessionID/form", scope("read")],
  ["POST", "/api/session/:sessionID/form", scope("prompt")],
  ["GET", "/api/session/:sessionID/form/:formID", scope("read")],
  ["DELETE", "/api/session/:sessionID/form/:formID", scope("prompt")],
  ["POST", "/api/session/:sessionID/form/:formID/reply", { kind: "form-reply" }],
  ["POST", "/api/session/:sessionID/generate", scope("prompt")],
  ["GET", "/api/session/:sessionID/inbox", scope("read")],
  ["DELETE", "/api/session/:sessionID/inbox/:inboxID", scope("prompt")],
  ["PATCH", "/api/session/:sessionID/inbox/:inboxID", scope("prompt")],
  ["POST", "/api/session/:sessionID/interrupt", scope("prompt")],
  ["GET", "/api/session/:sessionID/message", scope("read")],
  ["GET", "/api/session/:sessionID/message/:messageID", scope("read")],
  ["POST", "/api/session/:sessionID/move", scope("admin")],
  ["GET", "/api/session/:sessionID/permission", scope("read")],
  ["POST", "/api/session/:sessionID/permission", scope("prompt")],
  ["GET", "/api/session/:sessionID/permission/:requestID", scope("read")],
  ["POST", "/api/session/:sessionID/permission/:requestID/reply", { kind: "permission-reply" }],
  ["POST", "/api/session/:sessionID/prompt", { kind: "prompt" }],
  // Context reset and its undo (core P-035, 03 §18.18): like compact, the prompt scope.
  ["POST", "/api/session/:sessionID/reset", scope("prompt")],
  ["DELETE", "/api/session/:sessionID/reset/:resetID", scope("prompt")],
  ["DELETE", "/api/session/:sessionID/revert", scope("prompt")],
  ["POST", "/api/session/:sessionID/revert/commit", scope("prompt")],
  ["POST", "/api/session/:sessionID/revert/stage", scope("prompt")],
  ["POST", "/api/session/:sessionID/shell", scope("terminal")],
  ["POST", "/api/session/:sessionID/synthetic", scope("prompt")],
  ["POST", "/api/session/:sessionID/view", scope("read")],
  ["GET", "/api/form", scope("read")],
  ["GET", "/api/permission/request", scope("read")],
  // Saved "always allow" rules live on the desktop (01 §13.4): listing and removing them is admin.
  ["GET", "/api/permission/saved", scope("admin")],
  ["PATCH", "/api/permission/saved/:id", scope("admin")],
  ["DELETE", "/api/permission/saved/:id", scope("admin")],
  ["GET", "/api/experimental/session/stats", scope("read")],
  ["POST", "/api/experimental/session/import", { kind: "session-create", scope: "admin", rules: "info" }],
  ["GET", "/api/experimental/session/:sessionID/export", scope("read")],
  ["GET", "/api/experimental/session/:sessionID/log", scope("read")],
  ["POST", "/api/experimental/session/:sessionID/skill", scope("prompt")],
  ["POST", "/api/experimental/session/:sessionID/wait", scope("read")],
  ["GET", "/api/experimental/session/:sessionID/instructions/entries", scope("read")],
  ["PUT", "/api/experimental/session/:sessionID/instructions/entries/:key", scope("prompt")],
  ["DELETE", "/api/experimental/session/:sessionID/instructions/entries/:key", scope("prompt")],
  ["POST", "/api/experimental/generate", scope("prompt")],

  // Files (05 §13.5 `files`): fs.list, contents, diffs, uploads into the server's temp folder
  ["GET", "/api/fs/list", scope("files")],
  ["GET", "/api/fs/find", scope("files")],
  ["GET", "/api/fs/read/*", scope("files")],
  ["POST", "/api/experimental/fs/write", { kind: "fs-write" }],
  // Media stored by hash (upstream v2.2, `experimental.media_blob`) and file watches: own-web uses neither.
  ["GET", "/api/experimental/media/:hash", blocked("media")],
  ["POST", "/api/experimental/fs/watch", blocked("fs_watch")],
  ["DELETE", "/api/experimental/fs/watch", blocked("fs_watch")],
  ["GET", "/api/reference", scope("files")],
  // Repository metadata (branch, base, root) is what the header chip shows: a read. Changed files and diffs are files.
  ["GET", "/api/vcs", scope("read")],
  ["GET", "/api/vcs/base", scope("read")],
  ["GET", "/api/vcs/branch", scope("read")],
  ["GET", "/api/vcs/diff", scope("files")],
  ["GET", "/api/vcs/status", scope("files")],
  // `git init` in the Location (upstream 41516c78c8): refused like before it was listed, until own-web offers it.
  ["POST", "/api/vcs/init", blocked("vcs_init")],
  ["GET", "/api/worktree", scope("read")],
  ["POST", "/api/worktree", scope("admin")],
  ["DELETE", "/api/worktree", scope("admin")],
  ["POST", "/api/worktree/refresh", scope("admin")],

  // Terminal (05 §13.5 `terminal`): PTY, shells
  ["GET", "/api/pty", scope("terminal")],
  ["POST", "/api/pty", scope("terminal")],
  ["GET", "/api/pty/:ptyID", scope("terminal")],
  ["PUT", "/api/pty/:ptyID", scope("terminal")],
  ["DELETE", "/api/pty/:ptyID", scope("terminal")],
  ["GET", "/api/pty/:ptyID/connect", scope("terminal")],
  ["POST", "/api/pty/:ptyID/connect-token", scope("terminal")],
  ["GET", "/api/shell", scope("terminal")],
  ["POST", "/api/shell", scope("terminal")],
  ["GET", "/api/shell/:id", scope("terminal")],
  ["DELETE", "/api/shell/:id", scope("terminal")],
  ["GET", "/api/shell/:id/output", scope("terminal")],
  ["GET", "/api/experimental/session/:sessionID/terminal", scope("terminal")],
  ["POST", "/api/experimental/session/:sessionID/terminal", scope("terminal")],
  ["GET", "/api/experimental/session/:sessionID/terminal/read", scope("terminal")],
  ["GET", "/api/experimental/persistent-pty/:ptyID", scope("terminal")],
  ["PUT", "/api/experimental/persistent-pty/:ptyID", scope("terminal")],
  ["DELETE", "/api/experimental/persistent-pty/:ptyID", scope("terminal")],
  ["GET", "/api/experimental/persistent-pty/:ptyID/connect", scope("terminal")],
  ["POST", "/api/experimental/persistent-pty/:ptyID/connect-token", scope("terminal")],
  ["GET", "/api/experimental/persistent-pty/:ptyID/snapshot", scope("terminal")],
  // Service internals (restart handoff, shutdown of every terminal): never from a device.
  ["POST", "/api/experimental/persistent-pty/handoff", blocked("service_internal")],
  ["POST", "/api/experimental/persistent-pty/shutdown", blocked("service_internal")],

  // Plugin RPC
  ["POST", "/api/rpc/:rpcID/:method", { kind: "rpc" }],
]

/** WebSocket upgrades the gateway relays (PTY, ticket flow of upstream, 05 §13.4 "프록시"). */
export const WEBSOCKET_ROUTES: ReadonlyArray<string> = ["/api/pty/:ptyID/connect", "/api/experimental/persistent-pty/:ptyID/connect"]

interface Compiled {
  readonly method: Method
  readonly template: string
  readonly pattern: RegExp
  readonly need: Need
  /** Literal segments first: `/api/session/active` must win over `/api/session/:sessionID`. */
  readonly rank: number
}

function compile(template: string) {
  const parts = template.split("/").map((part) => {
    if (part === "*") return "(?:.*)"
    if (part.startsWith(":")) return "([^/]+)"
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  })
  return new RegExp(`^${parts.join("/")}$`)
}

const COMPILED: ReadonlyArray<Compiled> = ROUTES.map(([method, template, need]) => ({
  method,
  template,
  pattern: compile(template),
  need,
  rank: template.split("/").filter((part) => part.startsWith(":") || part === "*").length,
})).sort((a, b) => a.rank - b.rank)

export interface Match {
  readonly template: string
  readonly need: Need
  readonly params: ReadonlyArray<string>
}

/** The rule of an upstream request (`apiPath` starts with `/api/`). Unlisted routes are refused. */
export function classify(method: string, apiPath: string): Match {
  const upper = method.toUpperCase()
  if (apiPath.includes("/../") || apiPath.endsWith("/..") || apiPath.includes("//") || apiPath.includes("\\"))
    return { template: apiPath, need: blocked("path"), params: [] }
  for (const route of COMPILED) {
    if (route.method !== upper && !(upper === "HEAD" && route.method === "GET")) continue
    const match = route.pattern.exec(apiPath)
    if (match) return { template: route.template, need: route.need, params: match.slice(1) }
  }
  return { template: apiPath, need: blocked("not_allowlisted"), params: [] }
}

export type Decision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 413; readonly type: string; readonly scope: string }

const MAX_BODY = 64 * 1024

/** Upstream route or plugin RPC decision for a device. `body` is the JSON of an inspected request. */
export function decide(input: {
  readonly need: Need
  readonly params: ReadonlyArray<string>
  readonly scopes: ReadonlySet<string>
  readonly server: "local" | "host"
  readonly body?: unknown
}): Decision {
  const deny = (scope: string): Decision => ({ ok: false, status: 403, type: "scope_denied", scope })
  switch (input.need.kind) {
    case "blocked":
      return deny(`blocked:${input.need.reason}`)
    case "scope":
      return input.scopes.has(input.need.scope) ? { ok: true } : deny(input.need.scope)
    case "permission-reply": {
      if (!input.scopes.has("prompt")) return deny("prompt")
      const decision = field(input.body, "decision")
      // 01 §13.4 / 05 §13.5: "always" is saved only on the PC.
      if (decision !== "once" && decision !== "reject") return deny("local")
      return { ok: true }
    }
    case "session-update": {
      if (!input.scopes.has("prompt")) return deny("prompt")
      if (typeof input.body === "object" && input.body !== null && "permissions" in input.body) return deny("local")
      if (marksHelper(field(input.body, "metadata"))) return deny("local")
      return { ok: true }
    }
    case "session-fork":
    case "prompt":
      return input.scopes.has("prompt") ? { ok: true } : deny("prompt")
    case "form-reply": {
      if (!input.scopes.has("prompt")) return deny("prompt")
      if (grantsComputer(field(input.body, "answer"))) return deny("local")
      return { ok: true }
    }
    case "fs-write":
      return input.scopes.has("files") ? { ok: true } : deny("files")
    case "session-create": {
      if (!input.scopes.has(input.need.scope)) return deny(input.need.scope)
      const session = input.need.rules === "info" ? field(input.body, "info") : input.body
      const rules = field(session, "permissions")
      if (allowsComputer(rules)) return deny("local")
      // A hand-over's copied rules are compared with its source by the relay (`handedOver`), which reads it first.
      if (input.need.rules === "permissions" && !deviceRules(rules) && handoffSource(session) === undefined)
        return deny("local")
      if (marksHelper(field(session, "metadata"))) return deny("local")
      return { ok: true }
    }
    case "rpc": {
      const [rpcID, method] = input.params.map((part) => safeDecode(part))
      return rpc(rpcID, method, field(input.body, "input"), input.scopes, input.server)
    }
  }
}

/**
 * The `own.computer` methods a device may call (05 §13.4): see the status and press Stop. A device that can prompt (or
 * switch) a session that has computer use on can make the agent act, so it can also stop it. Turning computer use on,
 * allowing it again after a stop, the per-session grants, the helper and the audit log stay on the PC (01 §10.2).
 */
export const COMPUTER_METHODS: ReadonlySet<string> = new Set<OwnComputer.MethodName>(["status", "killswitch.engage"])

/**
 * Plugin RPC through the gateway: `own.accounts`, `own.remote`, `own.team`, `own.import` and `own.harness` by their
 * scope tables, `own.computer` to stop. On a remote host (`server: "host"`) `own.accounts`, `own.team` and `own.harness`
 * keep their tables, while `own.remote` (the agent methods there), `own.computer` (no computer use off this PC) and
 * `own.import` (not on a host in v1) are refused.
 */
export function rpc(
  rpcID: string | undefined,
  method: string | undefined,
  payload: unknown,
  scopes: ReadonlySet<string>,
  server: "local" | "host",
): Decision {
  const deny = (scope: string): Decision => ({ ok: false, status: 403, type: "scope_denied", scope })
  if (!rpcID || !method) return deny("unknown")
  if (rpcID === OwnAccounts.ID) {
    if (!Object.hasOwn(OwnAccounts.MethodScope, method)) return deny("unknown")
    // Voice input is this PC's (02 §3.9): its keys are in this PC's vault, and a recording never goes to a host. So are
    // the web search services' keys (02 §9.2).
    if ((method.startsWith("voice.") || method.startsWith("websearch.key.")) && server !== "local") return deny("remote")
    // Turning computer use on lets an agent drive this PC's mouse and keyboard: only on the PC itself (01 §10.2).
    if (method === "session.approval.set" && field(payload, "computerUse") === "on") return deny("local")
    // Only own.team passes a switch's `teamOp` and a binding's `team` (07 §8.1, 02 §5.11 #7): from a device they would
    // move a team session onto another subscription of the team's company, or clear or widen its team R4 context.
    if (TEAM_OP_METHODS.has(method) && carries(payload, "teamOp")) return deny("local")
    if (method === "session.preset.apply" && carries(payload, "team")) return deny("local")
    // The input decides some calls (`scopeOf`: a strict approval mode needs only `prompt`, MUX).
    const needed = OwnAccounts.scopeOf(method as OwnAccounts.MethodName, payload)
    if (needed === "local") return deny("local")
    return scopes.has(needed) ? { ok: true } : deny(needed)
  }
  if (rpcID === OwnComputer.ID) {
    // Only this PC's service drives this desktop; a remote host has no computer use.
    if (server !== "local") return deny("remote")
    if (!COMPUTER_METHODS.has(method)) return deny(Object.hasOwn(OwnComputer.MethodScope, method) ? "local" : "unknown")
    // `drive` in the own.computer table, read as own-web's client does: a device that can prompt or switch.
    return scopes.has("prompt") || scopes.has("switch") ? { ok: true } : deny("drive")
  }
  if (rpcID === OwnRemote.ID) {
    // `/srv/<hostId>`: the remote server only has `agent.*` (the broker key, command execution): always blocked (04 §12.7).
    if (server !== "local") return deny("remote")
    if (!Object.hasOwn(OwnRemote.MethodScope, method)) return deny("unknown")
    const name = method as OwnRemote.MethodName
    if (OwnRemote.deviceAllows(scopes, name, payload)) return { ok: true }
    return deny(OwnRemote.scopeOf(name, payload))
  }
  if (rpcID === OwnTeamRouting.ID) {
    // The same table on every server: a remote host's team (`/srv/<hostId>`, 06 §2.7 T3) answers like this PC's.
    if (!Object.hasOwn(OwnTeamRouting.MethodScope, method)) return deny("unknown")
    // Confirms of destructive steps, push and team settings writes are `local`: never a remote device (06 §2.7).
    const needed = OwnTeamRouting.MethodScope[method as keyof typeof OwnTeamRouting.MethodScope]
    if (needed === "local") return deny("local")
    return scopes.has(needed) ? { ok: true } : deny(needed)
  }
  if (rpcID === OwnImportRouting.ID) {
    // own.import reads other tools' files on this PC; a remote host has no own.import in v1 (09 §5.5).
    if (server !== "local") return deny("remote")
    if (!Object.hasOwn(OwnImportRouting.MethodScope, method)) return deny("unknown")
    // `local` stays on the PC's own clients: the roots setting, every conversation on the PC outside own's project
    // folders (`scope: "all"`) and an import that keeps secrets (`redact: false`).
    const needed = OwnImportRouting.scopeOf(method as keyof typeof OwnImportRouting.MethodScope, payload)
    if (needed === "local") return deny("local")
    return scopes.has(needed) ? { ok: true } : deny(needed)
  }
  if (rpcID === OwnHarness.ID) {
    // The same table on every server: remote installs carry own.harness too (10 §6.1). `drive` (a session's harness
    // switch) reads as in own.remote's table: `switch`, what a model switch on a session needs.
    if (!Object.hasOwn(OwnHarness.MethodScope, method)) return deny("unknown")
    const needed = OwnHarness.MethodScope[method as OwnHarness.MethodName]
    if (needed === "local") return deny("local")
    const scope = needed === "drive" ? "switch" : needed
    return scopes.has(scope) ? { ok: true } : deny(scope)
  }
  return deny("unknown_rpc")
}

/** The `own.accounts` methods whose `teamOp` only own.team passes (07 §5.5, §8.1). */
const TEAM_OP_METHODS: ReadonlySet<string> = new Set<OwnAccounts.MethodName>([
  "switch.estimate",
  "switch.apply",
  "switch.schedule",
])

/**
 * Routes whose JSON body the gateway must read before deciding or stamping (≤ 64 KiB, `notes.put` 1 MiB,
 * `voice.transcribe` the recording cap, a prompt 4 MiB, 05 §13.4 "본문 검사").
 */
export function needsBody(need: Need) {
  return (
    need.kind === "rpc" ||
    need.kind === "permission-reply" ||
    need.kind === "session-update" ||
    need.kind === "session-create" ||
    need.kind === "form-reply" ||
    need.kind === "prompt"
  )
}

/**
 * A device prompt's body with the device stamp (05 §13.4, 06 §2.9): `metadata[OwnRemote.DEVICE_META]` holds the
 * device's scopes, sorted. A value the client sent is replaced; the other metadata keys stay. A body that is not a JSON
 * object passes unchanged: upstream refuses it.
 */
export function stamp(body: unknown, scopes: ReadonlySet<string>) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body
  const metadata = field(body, "metadata")
  const kept = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata : {}
  const value: OwnRemote.DeviceStamp = { scopes: OwnRemote.DEVICE_SCOPES.filter((item) => scopes.has(item)).sort() }
  return { ...body, metadata: { ...kept, [OwnRemote.DEVICE_META]: value } }
}

export const BODY_LIMIT = MAX_BODY

/**
 * `own.accounts` `notes.put` carries a whole workspace note (up to `Notes.TEXT_MAX` characters, about 600 KB of Hangul
 * as JSON, 02 §9.2), so its body is read up to 1 MiB. The decision needs only the method from the path, like every
 * `notes.*` method: the cap bounds the inspection, it does not widen what a device may do.
 */
export const NOTES_BODY_LIMIT = 1024 * 1024

/**
 * `own.accounts` `voice.transcribe` carries a recording (base64, at most `Voice.MAX_AUDIO_BASE64` characters, 02 §3.9),
 * so its body may be larger than {@link BODY_LIMIT}; the method is decided by the URL alone, the body only has to be
 * read to be relayed. Its own cap (the recording, the hint and the JSON around them) still bounds what the gateway
 * holds in memory.
 */
export const VOICE_BODY_LIMIT = Voice.MAX_AUDIO_BASE64 + 64 * 1024

/**
 * A prompt is read whole to be stamped ({@link stamp}). Attachments are uploaded on their own (own-web
 * `attachments/upload.ts`), so a large prompt body is only a long paste; 4 MiB bounds what the gateway holds.
 */
export const PROMPT_BODY_LIMIT = 4 * 1024 * 1024

/**
 * How much of a body the gateway reads before deciding (05 §13.4 "본문 검사"): {@link BODY_LIMIT}, or
 * {@link NOTES_BODY_LIMIT} for `notes.put`, {@link VOICE_BODY_LIMIT} for `voice.transcribe` and
 * {@link PROMPT_BODY_LIMIT} for a prompt.
 */
export function bodyLimit(match: Match) {
  if (match.need.kind === "prompt") return PROMPT_BODY_LIMIT
  if (match.need.kind !== "rpc") return BODY_LIMIT
  const [rpcID, method] = match.params.map((part) => safeDecode(part))
  if (rpcID !== OwnAccounts.ID) return BODY_LIMIT
  if (method === "notes.put") return NOTES_BODY_LIMIT
  if (method === "voice.transcribe") return VOICE_BODY_LIMIT
  return BODY_LIMIT
}

/**
 * Whether a device may fork the session `source` (the body of upstream `GET /api/session/:sessionID`): only one that
 * was read and whose rules do not allow `computer`, which the fork would copy (01 §10.2: computer use is turned on
 * only on the PC).
 */
export function forkable(source: unknown) {
  const info = field(source, "data")
  return typeof info === "object" && info !== null && !allowsComputer(field(info, "permissions"))
}

/**
 * The rules a device may create a session with (decisions RL5-4): none (`undefined`, `null`, `[]`), or only own-web's
 * browser deny (`policy/browser.ts` `BROWSER_DENY`, rule 1 of a window without the browser pane). The approval mode
 * follows through `session.approval.set`; anything else (an allow, an ask, another deny) stays on the PC.
 */
export function deviceRules(rules: unknown) {
  if (rules === undefined || rules === null) return true
  return Array.isArray(rules) && rules.every((rule) => sameRule(rule, BROWSER_DENY))
}

const BROWSER_DENY = { action: "browser", resource: "*", effect: "deny" } as const

/**
 * The session a hand-over body copies its rules from (`metadata.own.seededFrom`, own-web `switcher/flow.ts`), when its
 * `permissions` are not {@link deviceRules}; the relay reads it and decides with {@link handedOver}.
 */
export function handoffSource(body: unknown) {
  if (deviceRules(field(body, "permissions"))) return undefined
  const source = field(field(field(body, "metadata"), "own"), "seededFrom")
  return typeof source === "string" ? source : undefined
}

/**
 * Whether a hand-over's `permissions` are exactly those of its source (`source`, the body of upstream
 * `GET /api/session/:sessionID`), rule for rule and in order, and the source is {@link forkable}: the new session gets
 * nothing its source does not have, as with a fork. A source that could not be read is refused.
 */
export function handedOver(body: unknown, source: unknown) {
  if (!forkable(source)) return false
  const copied = field(body, "permissions")
  const kept = field(field(source, "data"), "permissions") ?? []
  return (
    Array.isArray(copied) &&
    Array.isArray(kept) &&
    copied.length === kept.length &&
    copied.every((rule, index) => sameRule(rule, kept[index]))
  )
}

/** One permission rule, exactly `{action, resource, effect}` (upstream's schema has no other keys). */
function sameRule(rule: unknown, other: unknown) {
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return false
  if (Object.keys(rule).length !== 3) return false
  return (
    field(rule, "action") === field(other, "action") &&
    field(rule, "resource") === field(other, "resource") &&
    field(rule, "effect") === field(other, "effect") &&
    typeof field(rule, "action") === "string"
  )
}

/**
 * The parent a `POST /api/session` body names (`parentID`, upstream 19f203837e). A child takes its parent's rules unless
 * the body passes its own (`session-child-inherits`), so the relay reads the parent first and decides like a fork
 * ({@link forkable}).
 */
export function parentOf(body: unknown) {
  const parentID = field(body, "parentID")
  return typeof parentID === "string" ? parentID : undefined
}

/**
 * Whether a device may write `paths` (every `path` query value of `POST /api/experimental/fs/write`): exactly one
 * absolute path strictly inside the server's temp folder (`info`, the body of that server's `GET /api/info`), where
 * own-web stages attachments and git inputs. Upstream resolves the path against the Location and does not confine it
 * (`core/src/filesystem.ts`), so anything else could write a startup script, a git hook or a config that runs code.
 * The folder's form picks the path rules: a Windows server (`C:\…`) refuses device, UNC and root-relative paths and
 * any `:` past the drive's (an alternate data stream), and compares case-insensitively. A segment of only dots and
 * spaces (`..`, `. .`) is refused everywhere: Windows trims trailing dots and spaces.
 */
export function tmpWritable(paths: ReadonlyArray<string>, info: unknown) {
  const tmp = field(field(info, "paths"), "tmp")
  const target = paths.length === 1 ? paths[0] : undefined
  if (typeof tmp !== "string" || target === undefined || target.includes("\0")) return false
  const windows = DRIVE.test(tmp)
  const flavor = windows ? path.win32 : path.posix
  if (!flavor.isAbsolute(tmp) || !flavor.isAbsolute(target)) return false
  if (windows && (!DRIVE.test(target) || target.indexOf(":", 2) >= 0)) return false
  if (target.split(/[\\/]/).some((segment, index) => index > 0 && /^[. ]*$/.test(segment))) return false
  const fold = (value: string) => (windows ? value.toLowerCase() : value)
  const root = fold(flavor.resolve(tmp))
  return fold(flavor.resolve(target)).startsWith(root.endsWith(flavor.sep) ? root : root + flavor.sep)
}

const DRIVE = /^[A-Za-z]:[\\/]/

/**
 * A form answer (`Form.Answer`: a value per field, a string or a list of them) that holds the computer-use allow
 * answer anywhere: the plugin gate grants on that exact string.
 */
function grantsComputer(answer: unknown) {
  if (typeof answer !== "object" || answer === null) return false
  return Object.values(answer).some((value) =>
    Array.isArray(value) ? value.includes(OwnComputer.ALLOW_ANSWER) : value === OwnComputer.ALLOW_ANSWER,
  )
}

/**
 * Session rules that would turn computer use on or list its tools: a rule whose action matches `computer` (core's
 * wildcard: `*`, `?`, case-insensitive) and is not a deny.
 */
function allowsComputer(rules: unknown) {
  if (!Array.isArray(rules)) return false
  return rules.some((rule) => {
    const action = field(rule, "action")
    return typeof action === "string" && field(rule, "effect") !== "deny" && wildcard(action).test("computer")
  })
}

/** Core's wildcard (`packages/core/src/util/wildcard.ts`), case-insensitive as on the Windows service. */
function wildcard(pattern: string) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  // `name *` also matches the bare name.
  return new RegExp(`^${source.endsWith(" .*") ? `${source.slice(0, -3)}( .*)?` : source}$`, "si")
}

// ---------------------------------------------------------------------------------------------------------------
// The browser pane on a device (05 §8.10)

export type BrowserDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403; readonly type: "scope_denied"; readonly scope: string }
  | { readonly ok: false; readonly status: 404; readonly type: "browser_unavailable" }

/**
 * Whether a device may open the viewer socket of a browser pane (`RemoteBrowser.SOCKET_PATH`, 05 §8.10.2): it holds
 * `browser` and `read` and may see the server, which is this PC (`local`) or one of this PC's SSH hosts (`hosts`, the
 * ids in its registry): the PC's desktop pane holds the panes of both (05 §8.6, §8.10.8). Any other server key answers
 * "not here" rather than "not allowed". `hosts` absent: the scopes only (whether a device could open any viewer). What
 * the viewer may send (input, actions) follows the device's `prompt`, which the route hands the hub as `control`.
 */
export function browserView(input: {
  readonly scopes: ReadonlySet<string>
  readonly servers: OwnRemote.ServerScope
  readonly serverKey?: string
  readonly hosts?: ReadonlyArray<string>
}): BrowserDecision {
  const deny = (scope: string): BrowserDecision => ({ ok: false, status: 403, type: "scope_denied", scope })
  if (!input.scopes.has("browser")) return deny("browser")
  if (!input.scopes.has("read")) return deny("read")
  const key = input.serverKey
  if (key === undefined) return { ok: true }
  if (!serverAllowed(input.servers, key)) return deny("server")
  if (key !== "local" && !input.hosts?.includes(key)) return { ok: false, status: 404, type: "browser_unavailable" }
  return { ok: true }
}

/**
 * Whether a session's rules take the browser tools away for good (core's `whollyDisabled("browser", rules)`, own-web
 * `policy/browser.ts` `browserRemoved`): the last rule whose action matches `browser` is a `*` deny. The desktop
 * window never attaches such a session, so the relay does not wait for its pane before a prompt (05 §8.10.5).
 */
export function browserRemoved(rules: unknown) {
  if (!Array.isArray(rules)) return false
  const last = rules.findLast((rule) => {
    const action = field(rule, "action")
    return typeof action === "string" && wildcard(action).test("browser")
  })
  return field(last, "resource") === "*" && field(last, "effect") === "deny"
}

/**
 * Whether the desktop window would attach the browser pane of the session `source` (the body of upstream
 * `GET /api/session/:sessionID`): it was read, and its rules keep the browser ({@link browserRemoved}).
 */
export function paneAttachable(source: unknown) {
  const info = field(source, "data")
  return typeof info === "object" && info !== null && !browserRemoved(field(info, "permissions"))
}

/**
 * Session metadata carrying own.import's helper marker (`own.import: {helper: true, …}`, 09 §4.4). own-web hides such a
 * session everywhere and own.import's activation cleanup interrupts and removes it, so only own.import on the PC may
 * write it; a device that could would delete any session (an `admin` route) with `prompt` alone. The rest of the key
 * passes: own-web's pin and archive flags write the whole metadata back, an imported conversation's `own.import` too.
 */
function marksHelper(metadata: unknown) {
  return field(field(metadata, OwnImportRouting.META_KEY), "helper") === true
}

/** Whether the body names `name` at all (`null` included: `team: null` clears a binding's team context). */
function carries(body: unknown, name: string) {
  return typeof body === "object" && body !== null && name in body
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null && name in body ? (body as Record<string, unknown>)[name] : undefined
}

function safeDecode(value: string | undefined) {
  if (value === undefined) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Event stream (05 §13.4 "이벤트 거르기")

/** Which servers a device may see. */
export function serverAllowed(servers: OwnRemote.ServerScope, key: string) {
  return servers.mode === "all" || servers.keys.includes(key)
}

/**
 * Whether one SSE frame goes to the device. `local` events of `own.remote` (`host.prompt`, `device.pairing.*`) and
 * host events outside the device's `servers` are dropped; `own.team` events pass when declared (06 §2.7: team, area,
 * outbox, integration, op and notice events, all read), from this PC's team and a host's alike; `own.import` events
 * pass when its table declares them `read` (09 §5.3: they carry no conversation content, so no payload filter);
 * declared `own.harness` events pass like the upstream session events they follow (a session's harness, no content;
 * a host's reach only devices that may see that host, as below); events of other plugin RPC ids are dropped too
 * (unknown scope). Comments (`: heartbeat`) and upstream session
 * events pass. A host's stream (`/srv/<hostId>/api/event`) reaches only devices whose `servers` include that host: the
 * route refuses the others before relaying (`serverAllowed`).
 */
export function frameVisible(frame: string, servers: OwnRemote.ServerScope): boolean {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(line.charAt(5) === " " ? 6 : 5))
    .join("\n")
  if (data === "") return true
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return false
  }
  if (typeof event !== "object" || event === null) return false
  const type = (event as { type?: unknown }).type
  if (typeof type !== "string") return false
  if (!type.startsWith("rpc.")) return true
  if (type.startsWith(`rpc.${OwnAccounts.ID}.`)) return true
  if (type.startsWith(`rpc.${OwnTeamRouting.ID}.`))
    return Object.hasOwn(OwnTeamRouting.EventOrigin, type.slice(`rpc.${OwnTeamRouting.ID}.`.length))
  if (type.startsWith(`rpc.${OwnHarness.ID}.`))
    return Object.hasOwn(OwnHarness.Definition.events, type.slice(`rpc.${OwnHarness.ID}.`.length))
  if (type.startsWith(`rpc.${OwnImportRouting.ID}.`)) {
    const eventName = type.slice(`rpc.${OwnImportRouting.ID}.`.length)
    return (
      Object.hasOwn(OwnImportRouting.EventScope, eventName) &&
      OwnImportRouting.EventScope[eventName as keyof typeof OwnImportRouting.EventScope] === "read"
    )
  }
  if (!type.startsWith(`rpc.${OwnRemote.ID}.`)) return false
  const name = type.slice(`rpc.${OwnRemote.ID}.`.length)
  if (!Object.hasOwn(OwnRemote.EventScope, name)) return false
  if (OwnRemote.EventScope[name as OwnRemote.EventName] !== "read") return false
  const payload = (event as { data?: unknown }).data
  const hostId = field(payload, "hostId")
  if (typeof hostId === "string" && !serverAllowed(servers, hostId)) return false
  const item = field(payload, "item")
  const serverKey = field(item, "serverKey")
  if (typeof serverKey === "string" && !serverAllowed(servers, serverKey)) return false
  return true
}
