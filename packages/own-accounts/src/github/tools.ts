export * as GitHubTools from "./tools.js"

import type { AgentEditor } from "@opencode/plugin/promise/agent"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Tool } from "@opencode/schema/tool"
import { OwnGitHub } from "@own/protocol"
import type { Deps } from "../deps.js"
import { McpProbe } from "../mcp/probe.js"
import { GitHubApi } from "./api.js"
import { GitHubMcp } from "./mcp.js"
import { GitHubReads } from "./reads.js"
import { GitHubResolve } from "./resolve.js"
import { GitHubService } from "./service.js"
import { GitHubStore } from "./store.js"

/**
 * The `github_*` tools of a Location (16 §5.3): GitHub's MCP server's tools as the catalog lists them, under the
 * namespace `github` (so a model sees them as a GitHub MCP server's tools would be, `github_get_file_contents` …), in
 * every harness. Each call finds the account its conversation uses (`GitHubResolve`) and goes out with that account's
 * token through own's MCP session of that account. A read (`GitHubReads.isRead`) runs at once; any other tool is a
 * write, which needs an account that allows writing and asks the user first (`github.write`, the tool, the repository
 * and the account: `항상 허용` keeps exactly that for the project, and only for a repository GitHub could name, GH-16,
 * GH-26, GH-32).
 */

export const NAMESPACE = "github"

export const DESCRIPTION =
  "GitHub through the GitHub account chosen for this conversation or project in own (Settings > GitHub). " +
  "Read tools run at once; write tools (creating pull requests, comments, files, merges) ask the user first. " +
  "Each result starts with the account it ran as."

/** The permission action of a write; reads use none. */
export const WRITE_ACTION = OwnGitHub.WRITE_ACTION

/**
 * Appends `{github.write, *, ask}` to every agent whose rules would allow a GitHub write, after removing an earlier
 * copy, so it stays after the agent's own `*` allow however often the transform runs. A later session or project rule
 * (`항상 허용` of one tool and repository) still wins; an agent that denies the action keeps its deny.
 */
export function askWrites(editor: AgentEditor) {
  for (const agent of editor.list())
    editor.update(String(agent.id), (info) => {
      const rest = info.permissions.filter((rule) => !sameRule(rule, ASK_WRITES))
      if (effectOf(rest, WRITE_ACTION) !== "allow") {
        info.permissions = rest
        return
      }
      info.permissions = [...rest, { ...ASK_WRITES }]
    })
}

const ASK_WRITES = { action: WRITE_ACTION, resource: "*", effect: "ask" as const }

function sameRule(a: { action: string; resource: string; effect: string }, b: typeof ASK_WRITES) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

/** The effect of the last rule whose action pattern matches `action` (core's order: the last match wins). */
export function effectOf(rules: ReadonlyArray<{ action: string; effect: string }>, action: string) {
  return rules.findLast((rule) => wildcard(action, rule.action))?.effect ?? "ask"
}

/**
 * Whether `input` matches `pattern` as core's permission rules match (`packages/core/src/util/wildcard.ts`, surface
 * `permission-wildcard-match`): `*` any run, `?` one character, `\` read as `/`, a trailing ` *` also matching
 * nothing, and on Windows without regard to case. own-accounts is another bundle, so the rule is kept here.
 */
export function wildcard(input: string, pattern: string) {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  const tail = escaped.endsWith(" .*") ? `${escaped.slice(0, -3)}( .*)?` : escaped
  return new RegExp(`^${tail}$`, process.platform === "win32" ? "si" : "s").test(input.replaceAll("\\", "/"))
}

/** What a call needs of core's tool context. */
export type Call = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id" | "signal">

/** What a Location offers: nothing, or the catalog's reads and, when some account here may write, its writes. */
export interface Offer {
  readonly tools: ReadonlyArray<GitHubStore.CatalogTool>
}

/**
 * The tools a Location offers now: none in the control Location, without a catalog, or where no account applies
 * (the folder's choice, the default, or a conversation's choice made in this folder); writes only when one of those
 * accounts allows writing.
 */
export async function offer(file: GitHubStore.File, location: Deps["location"]): Promise<Offer> {
  if (location.control) return { tools: [] }
  return offerAt(file, { directory: location.directory })
}

/**
 * {@link offer} of a folder: this PC's, or with `host` an SSH host's (16 §8), its choices only and its folder's main
 * checkout as the host read it.
 */
export async function offerAt(
  file: GitHubStore.File,
  place: { readonly directory: string; readonly host?: string; readonly main?: string },
): Promise<Offer> {
  if (!file.catalog || file.accounts.length === 0) return { tools: [] }
  const here = await GitHubResolve.resolve(file, place)
  const chosen = file.sessions
    .filter(
      (item) =>
        item.host === place.host &&
        item.directory !== undefined &&
        GitHubStore.within(item.directory, place.directory, place.host),
    )
    .flatMap((item) => file.accounts.filter((entry) => entry.id === item.account))
  const accounts = [...(here.entry ? [here.entry] : []), ...chosen]
  if (accounts.length === 0) return { tools: [] }
  const write = accounts.some((entry) => entry.write)
  const server = file.catalog.server
  // A catalog read before GH-15 holds the server's hint alone: each tool is judged again.
  const tools = file.catalog.tools.map((tool) => ({ ...tool, read: GitHubReads.isRead(tool.name, tool.read, server) }))
  return { tools: tools.filter((tool) => tool.read || write) }
}

/** The tool definitions of an offer, each calling {@link run}. */
export function definitions(deps: Deps, offered: Offer) {
  return offered.tools.map((tool) => ({
    name: tool.name,
    description: tool.read ? tool.description : `${tool.description}\n\n(Asks the user before it runs.)`,
    input: tool.input as Tool.ValueSchema,
    options: { namespace: NAMESPACE },
    execute: (input: unknown, context: Call) => run(deps, tool, input, context),
  }))
}

/** One call: the account, the write checks and ask, the MCP call, the token cut out of anything quoted. */
export async function run(
  deps: Deps,
  tool: GitHubStore.CatalogTool,
  input: unknown,
  context: Call,
): Promise<Tool.Result> {
  const file = await GitHubStore.file(deps).read()
  const root = await GitHubService.rootOf(deps, context.sessionID)
  const resolved = await GitHubResolve.resolve(file, { directory: deps.location.directory, root })
  const entry = usable(resolved.entry, resolved.inUse.source, resolved.entry?.problem)
  await askWrite(deps, tool, entry, input, context)
  return answer(entry, tool, await invoke(deps, entry, file.settings, tool, input, context.signal))
}

/** The account a call runs as, or the tool error that says why there is none (`off`, none, a problem). */
export function usable<E>(
  entry: E | undefined,
  source: OwnGitHub.InUseSource,
  problem: OwnGitHub.Problem | undefined,
): E {
  if (!entry) throw new Tool.Error({ message: noAccountText(source) })
  if (problem) throw new Tool.Error({ message: GitHubService.problemText(problem) })
  return entry
}

/** Why a call has no account: `off` there, or none chosen. */
export function noAccountText(source: OwnGitHub.InUseSource) {
  return source === "off"
    ? "GitHub is turned off for this conversation or project (own Settings > GitHub)."
    : "No GitHub account is chosen for this conversation or project. Ask the user to connect one in own Settings > GitHub."
}

/**
 * A write's checks before it runs: refused for an account that allows reading only, else asked as core tools ask. Also
 * an SSH host's (16 §8): the host's core asks in the host's conversation, with the account the PC named.
 */
export async function askWrite(
  deps: Pick<Deps, "ctx">,
  tool: Pick<GitHubStore.CatalogTool, "name" | "read">,
  entry: Pick<GitHubStore.Entry, "id" | "label" | "login" | "site" | "write">,
  input: unknown,
  context: Call,
) {
  if (tool.read) return
  if (!entry.write)
    throw new Tool.Error({
      message: `The GitHub account "${entry.label}" (${entry.login}) allows reading only. The user can allow writing in own Settings > GitHub.`,
    })
  const resource = resourceOf(tool.name, repositoryOf(input), entry)
  // Asks as core tools do (`HarnessPermission.assert`): the agent's and the conversation's rules, then the user.
  // `항상 허용` saves the tool, a repository GitHub could name and the account; core reads a saved resource as a
  // pattern, so a name the model made up (`*`, `?`) or a tool without a repository may be allowed once only (GH-16).
  // An allow under account A never covers account B (GH-32).
  await deps.ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action: WRITE_ACTION,
    resources: [resource],
    save: parseResource(resource) ? [resource] : [],
    metadata: { tool: tool.name, account: entry.label, login: entry.login, site: entry.site },
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
}

/** The account line every result starts with (16 §3.3). */
export function head(entry: Pick<GitHubStore.Entry, "login" | "label">) {
  return `GitHub account: ${entry.login} (${entry.label})`
}

/** A call's answer to the model: its text after the account line, or a tool error with the server's words. */
export function answer(
  entry: Pick<GitHubStore.Entry, "login" | "label" | "site">,
  tool: Pick<GitHubStore.CatalogTool, "read">,
  result: { readonly text: string; readonly isError: boolean },
): Tool.Result {
  if (result.isError)
    throw new Tool.Error({ message: `${head(entry)}\n\n${result.text || "GitHub's MCP server reported an error"}` })
  return {
    content: `${head(entry)}\n\n${result.text}`,
    metadata: { github: { account: entry.label, login: entry.login, site: entry.site, write: !tool.read } },
  }
}

/**
 * The MCP call of an account the checks passed: its token (renewed when due), its session, the token cut out of what
 * comes back (a failure as a {@link Tool.Error} with the token cut out too); a token GitHub refuses marks the account.
 * Shared by this PC's tools and the calls this PC relays for an SSH host (16 §8).
 */
export async function invoke(
  deps: Deps,
  entry: GitHubStore.Entry,
  settings: OwnGitHub.Settings,
  tool: Pick<GitHubStore.CatalogTool, "name" | "read">,
  input: unknown,
  signal?: AbortSignal,
) {
  const target = await GitHubService.targetFor(deps, entry, settings, { readOnly: !entry.write })
  if (!target.ok) throw new Tool.Error({ message: target.message })
  const result = await GitHubMcp.call(target.target, tool.name, input, signal).catch(async (error: unknown) => {
    if (error instanceof GitHubMcp.McpError && error.kind === "auth") await refused(deps, entry, error, target.token)
    throw new Tool.Error({ message: McpProbe.mask(message(error), [target.token]) })
  })
  const text = McpProbe.mask(result.text, [target.token])
  if (result.isError) return { text, isError: true }
  const repository = repositoryOf(input)
  deps.log.child("github").info("github_tool", {
    tool: tool.name,
    account: entry.id,
    write: !tool.read,
    ...(repository ? { repository } : {}),
  })
  return { text, isError: false }
}

/**
 * GitHub's MCP server refused the account's token: the account says so until a check or a new token clears it. A 403
 * also answers a token that may not reach one repository or toolset (an organization's policy, a missing permission):
 * GitHub's `/user` is asked first, and only a token it refuses too marks the account (GH-20).
 */
async function refused(deps: Deps, entry: GitHubStore.Entry, error: GitHubMcp.McpError, token: string) {
  if (error.status === 403) {
    const urls = GitHubApi.urls(deps, entry.site)
    const asked = urls ? await GitHubApi.whoami(urls.api, token) : undefined
    if (!asked || asked.ok || asked.failure.type !== "github_token_invalid") {
      deps.log.child("github").info("github_tool_forbidden", { id: entry.id })
      return
    }
  }
  await GitHubStore.file(deps).update((current) => ({
    ...current,
    accounts: current.accounts.map((item) =>
      item.id === entry.id ? { ...item, problem: "token_invalid" as OwnGitHub.Problem } : item,
    ),
  }))
  deps.log.child("github").warn("github_token_refused", { id: entry.id })
  deps.runtime.broadcast.emit("github.changed", {})
  void deps.emitter.global("github.changed", {})
}

/**
 * A write's permission resource: `<tool> <owner>/<repo> as <login> (<account id>)`, or without a repository
 * `<tool> as <login> (<account id>)`. The account is part of it, so `항상 허용` given under one account never lets
 * another write (GH-32).
 */
export function resourceOf(tool: string, repository: string | undefined, entry: Pick<GitHubStore.Entry, "id" | "login">) {
  return `${tool}${repository === undefined ? "" : ` ${repository}`} as ${entry.login} (${entry.id})`
}

/**
 * The parts of a write's resource that `항상 허용` may keep: a tool name, an owner and a repository GitHub could name,
 * a GitHub login and an account id; `undefined` for anything else (a made-up name, no repository, a hand-edited
 * pattern). None of the parts holds a pattern character of core's rules (GH-16, GH-31).
 */
export function parseResource(resource: string) {
  const match = /^([A-Za-z0-9_]+) ([^/ ]+)\/([^/ ]+) as ([^ ]+) \(([A-Za-z0-9_]+)\)$/.exec(resource)
  if (!match) return undefined
  const [, tool, owner, repo, login, account] = match
  if (!validName(owner!, repo!) || !validName(login!, "login")) return undefined
  return { tool: tool!, repository: `${owner}/${repo}`, login: login!, account: account! }
}

/**
 * Whether the project's saved approvals of `github.write` (core's `evaluate` names them, P-047) hold exactly
 * `resource`, a resource `항상 허용` may keep: the same text, without regard to case on Windows as core matches it, never
 * a pattern that matches it (GH-26, GH-31).
 */
export function savedExactly(resource: string, saved: ReadonlyArray<string>) {
  if (!parseResource(resource)) return false
  const same = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() === resource.toLowerCase() : value === resource
  return saved.some(same)
}

/** `owner/repo` of a call's input, as GitHub's tools name them (`owner` and `repo`), when it has them. */
export function repositoryOf(input: unknown) {
  if (!isRecord(input)) return undefined
  if (typeof input.owner === "string" && typeof input.repo === "string") return `${input.owner}/${input.repo}`
  return undefined
}

/**
 * Whether the input's `owner` and `repo` are names GitHub allows (GH-16): an account or organization of letters,
 * digits, `-` and `_` (managed users' `_shortcode`) up to 39 characters, starting with a letter or digit; a repository
 * of letters, digits, `-`, `_` and `.` up to 100, not `.` or `..`. None of these is a pattern character of core's rules.
 */
export function validRepository(input: unknown) {
  if (!isRecord(input) || typeof input.owner !== "string" || typeof input.repo !== "string") return false
  return validName(input.owner, input.repo)
}

/** {@link validRepository} of an owner and a repository name (git's credential requests name them too). */
export function validName(owner: string, repo: string) {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(owner) &&
    /^[A-Za-z0-9._-]{1,100}$/.test(repo) &&
    repo !== "." &&
    repo !== ".."
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
