export * as OwnGitHub from "./github.js"

import { Schema } from "effect"
import { optional, statics } from "@opencode/schema/schema"
import { EpochMillis, Nonce, ulid } from "./id.js"
import { HostID } from "./rpc-remote.js"

/**
 * GitHub connection (16, GH 2026-10-31): several GitHub accounts, each a name, its login and its token, and which one
 * a project, a team area or a conversation uses. own.accounts keeps them in `OWN_HOME\github.json` (names, logins and
 * folders only) and each account's token as one vault item `github-<id>`, so no file and no answer holds a token.
 * Every Location gets the `github_*` tools (GitHub's own MCP server's tools, asked through own with the account the
 * conversation uses), read-only unless an account allows writing, and a write asks the user first. git's logins for
 * the account's site come from own too, for the git and gh processes own and its agents start (16 §6).
 */

/** own's id of a connected account (`gh_<ulid>`); its vault item is `github-<id>`. */
export const ID = Schema.String.check(Schema.isPattern(/^gh_[0-9A-Z]{26}$/)).pipe(
  Schema.brand("Own.GitHub.ID"),
  Schema.annotate({ identifier: "Own.GitHub.ID" }),
  statics((schema) => ({ create: () => schema.make("gh_" + ulid()) })),
)
export type ID = typeof ID.Type

/** github.com, or a GitHub Enterprise site: the address of its web pages (`https://github.example.com`), no path. */
export const SITE_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/
export const Site = Schema.String.check(Schema.isPattern(SITE_PATTERN)).annotate({ identifier: "Own.GitHub.Site" })
export type Site = typeof Site.Type

export const GITHUB_COM = "https://github.com"

/**
 * The permission action of a GitHub write (16 §5.4): every agent asks it (`{github.write, *, ask}`), including agents
 * other own plugins define (own-omo's), and `항상 허용` saves `<tool> <owner>/<repo>` under it.
 */
export const WRITE_ACTION = "github.write"

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))

/**
 * What kind of token an account holds, read from its prefix: a fine-grained personal access token (`github_pat_`),
 * a classic one (`ghp_`), an OAuth app's (`gho_`), a GitHub App's user token (`ghu_`), or none of these.
 */
export const TokenKind = Schema.Literals(["fine-grained", "classic", "oauth", "app-user", "unknown"]).annotate({
  identifier: "Own.GitHub.TokenKind",
})
export type TokenKind = typeof TokenKind.Type

/** How it was connected: a token the user pasted, or a login in the browser with a code (device flow). */
export const Source = Schema.Literals(["token", "device"]).annotate({ identifier: "Own.GitHub.Source" })
export type Source = typeof Source.Type

/**
 * Why an account cannot be used now: GitHub refused its token (`token_invalid`: revoked, deleted or wrong), its
 * expiry passed (`token_expired`), the vault does not give its token (`vault_missing`).
 */
export const Problem = Schema.Literals(["token_invalid", "token_expired", "vault_missing"]).annotate({
  identifier: "Own.GitHub.Problem",
})
export type Problem = typeof Problem.Type

/** One connected account. `hint` is the token's last four characters (`…9fQ2`); never the token. */
export interface Account extends Schema.Schema.Type<typeof Account> {}
export const Account = Schema.Struct({
  id: ID,
  label: Label,
  site: Site,
  /** The GitHub user the token belongs to (`GET /user`). */
  login: Schema.String,
  /** The user's display name, when set. */
  name: optional(Schema.String),
  source: Source,
  tokenKind: TokenKind,
  hint: Schema.String,
  /** The account allows GitHub's write tools (creating pull requests, comments, files…); each write still asks. */
  write: Schema.Boolean,
  /** A classic or OAuth token's scopes (`X-OAuth-Scopes`); a fine-grained token names none. */
  scopes: optional(Schema.Array(Schema.String)),
  /** When the token expires, as GitHub said (`GitHub-Authentication-Token-Expiration`). */
  expiresAt: optional(EpochMillis),
  addedAt: EpochMillis,
  /** The last time own asked GitHub who the token is. */
  checkedAt: optional(EpochMillis),
  problem: optional(Problem),
}).annotate({ identifier: "Own.GitHub.Account" })

/** An account, or `off`: no GitHub in this project or conversation, whatever the default says. */
export const Choice = Schema.Union([ID, Schema.Literal("off")]).annotate({ identifier: "Own.GitHub.Choice" })
export type Choice = typeof Choice.Type

/**
 * An SSH host's id (`OwnRemote.HostID`, 04): a choice with it is about that host's folders and conversations, whose
 * GitHub calls and git logins this PC relays (16 §8, GH-37). A choice without it is this PC's.
 */
export const Host = HostID
export type Host = typeof Host.Type

/**
 * A project folder's choice; it covers the folders inside it (the deepest folder with a choice wins) and the linked
 * git worktrees of a repository there (a team area uses its project's choice until it has its own). `host`: a folder
 * of that SSH host (a POSIX path there).
 */
export interface ProjectChoice extends Schema.Schema.Type<typeof ProjectChoice> {}
export const ProjectChoice = Schema.Struct({ directory: Text, account: Choice, host: optional(Host) }).annotate({
  identifier: "Own.GitHub.ProjectChoice",
})

/**
 * A conversation's choice, over its folder's. `directory` is where the conversation was when it was chosen; `host`
 * the SSH host it lives on.
 */
export interface SessionChoice extends Schema.Schema.Type<typeof SessionChoice> {}
export const SessionChoice = Schema.Struct({
  sessionID: Text,
  account: Choice,
  directory: optional(Text),
  host: optional(Host),
  at: EpochMillis,
}).annotate({ identifier: "Own.GitHub.SessionChoice" })

/** GitHub's own MCP server, which own asks for the account in use: its hosted server, or a program on this PC. */
export const Server = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remote"), url: Schema.String.check(Schema.isMinLength(1)) }),
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(Schema.isMaxLength(32)),
  }),
]).annotate({ identifier: "Own.GitHub.Server" })
export type Server = typeof Server.Type

/** GitHub's hosted MCP server (16 §5.1). */
export const HOSTED = "https://api.githubcopilot.com/mcp/"

/** A toolset name of GitHub's MCP server (`repos`, `pull_requests` …). */
export const Toolset = Schema.String.check(Schema.isPattern(/^[a-z][a-z_]{0,39}$/)).annotate({
  identifier: "Own.GitHub.Toolset",
})

/** The toolsets own asks for unless the user chose others (GitHub's defaults plus `actions`, 16 §5.2). */
export const DEFAULT_TOOLSETS: ReadonlyArray<string> = ["context", "repos", "issues", "pull_requests", "actions"]

export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const Settings = Schema.Struct({
  server: Server,
  toolsets: Schema.Array(Toolset).check(Schema.isMaxLength(30)),
  /** git and gh started by own and its agents use the account in use for its site (16 §6). */
  git: Schema.Boolean,
  /**
   * The client ID of the user's own OAuth app or GitHub App with device flow on, for `브라우저로 로그인` (16 §4.2). Not
   * a secret; own ships none of its own and never borrows another product's.
   */
  clientID: optional(Schema.String),
  /**
   * The SSH hosts that may write on GitHub through this PC (16 §8.11, GH-49): their write tools and their git pushes.
   * Every other host, a new one too, only reads, whatever its account allows.
   */
  writeHosts: optional(Schema.Array(Host)),
}).annotate({ identifier: "Own.GitHub.Settings" })

/** Where the account in use came from, for the indicator (16 §3.3). */
export const InUseSource = Schema.Literals(["session", "project", "worktree", "default", "off", "none"]).annotate({
  identifier: "Own.GitHub.InUseSource",
})
export type InUseSource = typeof InUseSource.Type

export interface InUse extends Schema.Schema.Type<typeof InUse> {}
export const InUse = Schema.Struct({
  account: optional(ID),
  source: InUseSource,
  /** The folder whose choice applies (`project`, `worktree`), or the conversation's choice's folder. */
  directory: optional(Schema.String),
}).annotate({ identifier: "Own.GitHub.InUse" })

/** The tools own last read from GitHub's MCP server (names only), for the page. */
export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}
export const Catalog = Schema.Struct({
  at: EpochMillis,
  read: Schema.Array(Schema.String),
  write: Schema.Array(Schema.String),
  /** The server's name and version as it gave them. */
  server: optional(Schema.String),
}).annotate({ identifier: "Own.GitHub.Catalog" })

/** Every `github.*` answer. `vault: "unavailable"`: the tokens cannot be read for now. */
export interface View extends Schema.Schema.Type<typeof View> {}
export const View = Schema.Struct({
  accounts: Schema.Array(Account),
  default: optional(ID),
  projects: Schema.Array(ProjectChoice),
  sessions: Schema.Array(SessionChoice),
  settings: Settings,
  catalog: optional(Catalog),
  vault: Schema.Literals(["ok", "unavailable"]),
  /** With `github.view{directory, sessionID}`: the account those would use now. */
  inUse: optional(InUse),
}).annotate({ identifier: "Own.GitHub.View" })

export interface ViewInput extends Schema.Schema.Type<typeof ViewInput> {}
export const ViewInput = Schema.Struct({
  directory: optional(Text),
  sessionID: optional(Text),
  /** `directory` and `sessionID` are that SSH host's (16 §8): `inUse` as the host's calls would get it. */
  host: optional(Host),
}).annotate({
  identifier: "Own.GitHub.ViewInput",
})

/** `github.add.token`: a personal access token the user made; own asks GitHub whose it is before storing it. */
export interface AddTokenInput extends Schema.Schema.Type<typeof AddTokenInput> {}
export const AddTokenInput = Schema.Struct({
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  label: optional(Label),
  site: optional(Site),
  write: optional(Schema.Boolean),
}).annotate({ identifier: "Own.GitHub.AddTokenInput" })

/** `github.device.start`: a login in the browser with the user's own app (`settings.clientID`). */
export interface DeviceStartInput extends Schema.Schema.Type<typeof DeviceStartInput> {}
export const DeviceStartInput = Schema.Struct({
  label: optional(Label),
  site: optional(Site),
  write: optional(Schema.Boolean),
}).annotate({ identifier: "Own.GitHub.DeviceStartInput" })

/** The code to type on GitHub's page, and how long and how often own waits for the login. */
export interface DeviceStart extends Schema.Schema.Type<typeof DeviceStart> {}
export const DeviceStart = Schema.Struct({
  nonce: Nonce,
  userCode: Schema.String,
  verificationUri: Schema.String,
  expiresAt: EpochMillis,
  intervalMs: Schema.Finite,
}).annotate({ identifier: "Own.GitHub.DeviceStart" })

export const DeviceState = Schema.Literals(["waiting", "done", "expired", "denied", "failed", "cancelled"]).annotate({
  identifier: "Own.GitHub.DeviceState",
})
export type DeviceState = typeof DeviceState.Type

export interface DeviceStatus extends Schema.Schema.Type<typeof DeviceStatus> {}
export const DeviceStatus = Schema.Struct({
  state: DeviceState,
  /** `done`: the account connected. */
  account: optional(ID),
  /** `failed`: GitHub's or own's words (never a token). */
  message: optional(Schema.String),
  view: optional(View),
}).annotate({ identifier: "Own.GitHub.DeviceStatus" })

export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}
export const UpdateInput = Schema.Struct({
  id: ID,
  label: optional(Label),
  write: optional(Schema.Boolean),
  /** A new token for the same GitHub user (a renewed or replaced token); own checks it first. */
  token: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
}).annotate({ identifier: "Own.GitHub.UpdateInput" })

/**
 * Where a choice is kept: the default, a project folder (a team area's folder too), or one conversation; `host` for a
 * folder or a conversation of that SSH host (16 §8).
 */
export const Target = Schema.Union([
  Schema.Struct({ type: Schema.Literal("default") }),
  Schema.Struct({ type: Schema.Literal("project"), directory: Text, host: optional(Host) }),
  Schema.Struct({
    type: Schema.Literal("session"),
    sessionID: Text,
    directory: optional(Text),
    host: optional(Host),
  }),
]).annotate({ identifier: "Own.GitHub.Target" })
export type Target = typeof Target.Type

/** `account: null` deletes the choice there (the folder's, the default's or nothing applies again). */
export interface BindInput extends Schema.Schema.Type<typeof BindInput> {}
export const BindInput = Schema.Struct({ target: Target, account: Schema.NullOr(Choice) }).annotate({
  identifier: "Own.GitHub.BindInput",
})

/** `clientID: null` removes it; fields left out stay. */
export interface SettingsInput extends Schema.Schema.Type<typeof SettingsInput> {}
export const SettingsInput = Schema.Struct({
  server: optional(Server),
  toolsets: optional(Schema.Array(Toolset).check(Schema.isMaxLength(30))),
  git: optional(Schema.Boolean),
  clientID: optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
  /** The whole list of SSH hosts that may write (16 §8.11); left out, it stays. */
  writeHosts: optional(Schema.Array(Host).check(Schema.isMaxLength(200))),
}).annotate({ identifier: "Own.GitHub.SettingsInput" })

/** Where an MCP server tool call went and what came back, for the page's `도구 확인`. */
export interface Check extends Schema.Schema.Type<typeof Check> {}
export const Check = Schema.Struct({
  at: EpochMillis,
  ok: Schema.Boolean,
  account: optional(Account),
  catalog: optional(Catalog),
  /** Why it failed, the token cut out. */
  error: optional(Schema.String),
}).annotate({ identifier: "Own.GitHub.Check" })

/** The last four characters of a token of 12 or more, for the page; shorter tokens show none. */
export function hint(token: string) {
  return token.length >= 12 ? `…${token.slice(-4)}` : ""
}

/** The token kind by its prefix (GitHub's documented prefixes). */
export function tokenKind(token: string): TokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained"
  if (token.startsWith("ghp_")) return "classic"
  if (token.startsWith("gho_")) return "oauth"
  if (token.startsWith("ghu_")) return "app-user"
  return "unknown"
}
