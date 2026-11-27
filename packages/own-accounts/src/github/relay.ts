export * as GitHubRelay from "./relay.js"

import { Tool } from "@opencode/schema/tool"
import { Broker } from "@own/protocol"
import type { Deps } from "../deps.js"
import { GitHubApi } from "./api.js"
import { GitHubMask } from "./mask.js"
import { GitHubResolve } from "./resolve.js"
import { GitHubService } from "./service.js"
import { GitHubStore } from "./store.js"
import { GitHubTools } from "./tools.js"

/**
 * This PC's side of GitHub on an SSH host (16 §8, GH-37). Tokens never leave the PC: the host's tools ask this PC
 * which tools its folder offers (`github.offer`), which account its folder and conversation use
 * (`github.account`, for the host's write ask and its git environment), and to run one call (`github.call`); the host's
 * git and git-lfs reach GitHub through this PC's egress relay, which asks {@link gate} per request and adds the
 * account's login itself. The account is picked as for this PC's folders (16 §3.2) among the choices kept for that host
 * (its project folders, its conversations, its team areas through the main checkout the host read), else the default.
 * Every answer names an account by id, name and login only; logs name the host. A host writes on GitHub (write tools,
 * git pushes) only once the user allowed it for that host (`settings.writeHosts`, GH-49): a new host only reads.
 */

/** A host's conversation choice keeps its folder's git commands without a conversation off the folder's account this long (GH-33). */
export const ACTIVE_CHOICE_MS = 7 * 24 * 60 * 60_000

/**
 * The tools a folder of `hostId` offers (as `GitHubTools.offer` for this PC's folders); its writes only when this PC
 * lets the host write (GH-49).
 */
export async function offer(deps: Deps, hostId: string, params: Broker.GitHubOfferGet): Promise<Broker.GitHubOffer> {
  const file = await GitHubStore.file(deps).read()
  const offered = await GitHubTools.offerAt(file, placeOf(hostId, params))
  const write = hostWrites(file, hostId)
  return {
    tools: offered.tools.filter((tool) => tool.read || write).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
      read: tool.read,
      ...(tool.title === undefined ? {} : { title: tool.title }),
    })),
    git: file.settings.git && file.accounts.length > 0,
  }
}

/**
 * The account a place of `hostId` uses now, and whether its git processes get a login: the setting, and for a command
 * without a conversation no recent choice of another account by a conversation around its folder (GH-14, GH-33).
 */
export async function account(
  deps: Deps,
  hostId: string,
  params: Broker.GitHubPlace,
): Promise<Broker.GitHubAccountResult> {
  const file = await GitHubStore.file(deps).read()
  const resolved = await GitHubResolve.resolve(file, placeOf(hostId, params))
  const entry = resolved.entry
  const git =
    file.settings.git && (params.root !== undefined || !(await chosenElsewhere(deps, file, hostId, params)))
  return {
    ...(entry === undefined ? {} : { account: summary(entry) }),
    source: resolved.inUse.source,
    ...(entry?.problem === undefined ? {} : { problem: entry.problem }),
    git,
    hostWrite: hostWrites(file, hostId),
  }
}

/** Whether this PC lets `hostId` write on GitHub (`settings.writeHosts`, GH-49). */
export function hostWrites(file: GitHubStore.File, hostId: string) {
  return (file.settings.writeHosts ?? []).includes(hostId)
}

/**
 * One tool call of `hostId`: the place's account now must be the one the host asked the user about (a write's
 * permission names it), the tool one the place offers, a write one the account and this PC's allowance for the host
 * allow (GH-49); then the call as this PC's (`GitHubTools.invoke`: the token cut out of what comes back), its text with
 * every connected account's tokens cut out as this PC's tool results are (`GitHubMask`, GH-50) and cut to
 * {@link Broker.GITHUB_RESULT_MAX_BYTES}.
 */
export async function call(deps: Deps, hostId: string, params: Broker.GitHubCall): Promise<Broker.GitHubCallResult> {
  const file = await GitHubStore.file(deps).read()
  const place = placeOf(hostId, params)
  const resolved = await GitHubResolve.resolve(file, place)
  const entry = resolved.entry
  const log = deps.log.child("github")
  if (!entry) return refuse("off", GitHubTools.noAccountText(resolved.inUse.source))
  if (entry.id !== params.account)
    return refuse(
      "account_changed",
      "The GitHub account for this conversation or project changed since the call was asked. Run it again.",
    )
  if (entry.problem) return refuse("problem", GitHubService.problemText(entry.problem))
  const tool = (await GitHubTools.offerAt(file, place)).tools.find((item) => item.name === params.tool)
  if (!tool) return refuse("unknown_tool", `The GitHub tool ${params.tool} is not offered here.`)
  if (!tool.read && !entry.write)
    return refuse(
      "read_only",
      `The GitHub account "${entry.label}" (${entry.login}) allows reading only. The user can allow writing in own Settings > GitHub.`,
    )
  if (!tool.read && !hostWrites(file, hostId)) return refuse("host_read_only", HOST_READ_ONLY)
  const result = await GitHubTools.invoke(deps, entry, file.settings, tool, params.input).catch((error: unknown) => ({
    error: error instanceof Tool.Error ? error.message : "GitHub's MCP server could not be reached.",
  }))
  // Another account's token, a refresh token or a retired one may be in what came back too (GH-50). When the mask
  // cannot be read (the file), the result does not go to the host.
  const mask = await GitHubMask.read(deps).catch((error: unknown) => {
    log.warn("github_mask_unread", { error })
    return undefined
  })
  if (!mask) return refuse("failed", "The call ran, but own could not check GitHub's answer for tokens, so it is not shown here.")
  if ("error" in result) return refuse("failed", mask.text(result.error))
  log.info("github_remote_tool", { remote: hostId, tool: tool.name, account: entry.id, write: !tool.read })
  return { text: cut(mask.text(result.text)), isError: result.isError, account: summary(entry) }

  function refuse(error: Broker.GitHubCallError, message: string): Broker.GitHubCallResult {
    log.info("github_remote_tool_refused", { remote: hostId, tool: params.tool, error })
    return { error, message }
  }
}

/** A git or git-lfs request of a host as the relay read it. */
export interface Ask {
  readonly method: string
  /** After `/github`: `/<site host>/<owner>/<repo>[.git]/<git's or LFS's path>`. */
  readonly path: string
  readonly search: string
  readonly place: Broker.GitHubPlace
  /** A Git LFS batch request's `operation` (`download`, `upload`), read by the relay. */
  readonly lfs?: string
}

export type Gate =
  | {
      readonly ok: true
      /** Where the request goes: the account's site, the same repository and path. */
      readonly upstream: string
      /** `Basic` of the account's login and token: added by the relay, never sent to the host. */
      readonly authorization: string
      /**
       * What GitHub's answer must not carry back to the host (GH-45): the token, its base64 forms, git's Basic login of
       * it and its forms, and {@link authorization} itself.
       */
      readonly secrets: ReadonlyArray<string>
      readonly operation: "push" | "fetch"
    }
  | { readonly ok: false; readonly status: number; readonly code: Broker.GitHubGitError }

/**
 * Whether a host's git request goes to GitHub, and with which login: git's smart HTTP (`info/refs` of
 * `git-upload-pack` or `git-receive-pack`, the two services' POSTs) or Git LFS's API (the batch, locks) of one
 * repository GitHub could name, on the site of the account the place uses now, git logins on, the account usable;
 * a push (`git-receive-pack`, an LFS upload, a lock change) of an account that allows no writes (GH-38) or of a host this
 * PC has not allowed to write (GH-49) never. The upstream query of `info/refs` is made again from the one service read
 * (GH-47).
 */
export async function gate(deps: Deps, hostId: string, ask: Ask): Promise<Gate> {
  const parsed = parse(ask)
  if (!parsed) return { ok: false, status: 404, code: "bad_request" }
  const log = deps.log.child("github")
  const file = await GitHubStore.file(deps).read()
  const audit = { remote: hostId, host: parsed.site, repository: parsed.repository, operation: parsed.operation }
  const refuse = (code: Broker.GitHubGitError, status = 403): Gate => {
    log.warn("github_git_login_refused", { ...audit, caller: "relay", reason: code })
    return { ok: false, status, code }
  }
  if (!file.settings.git) return refuse("off")
  const resolved = await GitHubResolve.resolve(file, placeOf(hostId, ask.place))
  const entry = resolved.entry
  if (!entry) return refuse("off")
  if (ask.place.root === undefined && (await chosenElsewhere(deps, file, hostId, ask.place))) return refuse("off")
  if (parsed.site.toLowerCase() !== new URL(entry.site).host.toLowerCase()) return refuse("site")
  if (entry.problem) return refuse("problem")
  if (!entry.write && parsed.operation === "push") return refuse("read_only")
  if (parsed.operation === "push" && !hostWrites(file, hostId)) return refuse("host_read_only")
  const token = await GitHubService.tokenFor(deps, entry, file.settings)
  if (!token.ok) return refuse("problem")
  const urls = GitHubApi.urls(deps, entry.site)
  if (!urls) return refuse("unavailable", 503)
  log.info("github_git_login", { ...audit, account: entry.id, caller: "relay" })
  const authorization = `Basic ${Buffer.from(`${entry.login}:${token.token}`).toString("base64")}`
  return {
    ok: true,
    upstream: `${urls.web.replace(/\/+$/, "")}${parsed.rest}${parsed.query}`,
    authorization,
    secrets: [...GitHubMask.loginForms(entry.login, token.token), authorization],
    operation: parsed.operation,
  }
}

/**
 * The parts of a git request: the site's host, the repository, the path after the site (as GitHub serves it), the query
 * that goes upstream and whether it pushes; `undefined` for anything else than git's smart HTTP and Git LFS's API with
 * the methods git and git-lfs use. `info/refs` goes upstream with exactly the one `service` judged here (a second
 * `service` GitHub might read instead never goes, GH-47); other routes keep their query (the locks list's filters).
 */
export function parse(ask: Pick<Ask, "method" | "path" | "search" | "lfs">) {
  const match =
    /^\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)(\/([^/]+)\/([^/]+?)(\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/locks(?:\/verify|\/[A-Za-z0-9_-]{1,64}\/unlock)?))$/.exec(
      ask.path,
    )
  if (!match) return undefined
  const [, site, rest, owner, repo, , route] = match
  if (!GitHubTools.validName(owner!, repo!)) return undefined
  const services = new URLSearchParams(ask.search).getAll("service")
  const service = services.length === 1 ? services[0]! : null
  const method = ask.method.toUpperCase()
  const operation = operationOf(route!, method, service, ask.lfs)
  if (!operation) return undefined
  const query = route === "info/refs" ? `?service=${service}` : ask.search
  return { site: site!, repository: `${owner}/${repo}`, rest: rest!, query, operation }
}

function operationOf(route: string, method: string, service: string | null, lfs: string | undefined) {
  if (route === "info/refs") {
    if (method !== "GET") return undefined
    if (service === "git-upload-pack") return "fetch" as const
    if (service === "git-receive-pack") return "push" as const
    return undefined
  }
  if (route === "git-upload-pack") return method === "POST" ? ("fetch" as const) : undefined
  if (route === "git-receive-pack") return method === "POST" ? ("push" as const) : undefined
  if (route === "info/lfs/objects/batch") {
    if (method !== "POST") return undefined
    if (lfs === "download") return "fetch" as const
    // An upload, or a batch whose operation could not be read: a push.
    return "push" as const
  }
  // Locks: listing reads, anything else (create, verify before a push, unlock) changes them.
  if (method === "GET") return route === "info/lfs/locks" ? ("fetch" as const) : undefined
  return method === "POST" ? ("push" as const) : undefined
}

/** Why a host's write does not run: this PC has not allowed that host to write (GH-49). */
const HOST_READ_ONLY =
  "This SSH host may only read on GitHub. The user can allow writing for this host in own Settings > GitHub on the PC."

/** The account as a host may know it. */
export function summary(entry: GitHubStore.Entry): Broker.GitHubAccount {
  return { id: entry.id, label: entry.label, login: entry.login, site: entry.site, write: entry.write }
}

/** A place of `hostId` for `GitHubResolve.resolve` and `GitHubTools.offerAt`. */
function placeOf(hostId: string, place: { readonly directory: string; readonly main?: string; readonly root?: string }) {
  return {
    directory: place.directory,
    host: hostId,
    ...(place.main === undefined ? {} : { main: place.main }),
    ...(place.root === undefined ? {} : { root: place.root }),
  }
}

/**
 * Whether a conversation of `hostId` in or around the place's folder (or one whose folder is not known) chose another
 * account (or `off`) than the folder's own in the last {@link ACTIVE_CHOICE_MS}. This PC cannot read the host's
 * sessions, so only the choice's own time counts (GH-33 also counts a session's last activity on this PC).
 */
async function chosenElsewhere(
  deps: Pick<Deps, "clock">,
  file: GitHubStore.File,
  hostId: string,
  place: { readonly directory: string; readonly main?: string },
) {
  const folder = (await GitHubResolve.resolve(file, placeOf(hostId, place))).inUse.account
  const now = deps.clock.now()
  return file.sessions.some(
    (item) =>
      item.host === hostId &&
      (item.account === "off" ? undefined : item.account) !== folder &&
      now - item.at < ACTIVE_CHOICE_MS &&
      (item.directory === undefined ||
        GitHubStore.within(place.directory, item.directory, hostId) ||
        GitHubStore.within(item.directory, place.directory, hostId)),
  )
}

/** `text` cut to {@link Broker.GITHUB_RESULT_MAX_BYTES} UTF-8 bytes, with a note when it was. */
export function cut(text: string) {
  const max = Broker.GITHUB_RESULT_MAX_BYTES
  const bytes = Buffer.from(text)
  if (bytes.length <= max) return text
  // A character split at the cut decodes as U+FFFD: dropped.
  const kept = new TextDecoder().decode(bytes.subarray(0, max)).replace(/�+$/u, "")
  return `${kept}\n\n[own: the result was cut at ${max / 1024} KiB on its way to this host]`
}
