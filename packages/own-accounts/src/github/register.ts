export * as GitHubConnection from "./register.js"

import type { Registration } from "@opencode/plugin/promise/registration"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Tool } from "@opencode/schema/tool"
import { OwnGitHub } from "@own/protocol"
import { GitHubBridge } from "@own/runtime"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import { Location } from "../location.js"
import type { Logger } from "../logger.js"
import type { Module } from "../module.js"
import { GitHubCaller } from "./caller.js"
import { GitHubCommands } from "./commands.js"
import { GitHubCredential } from "./credential.js"
import { GitHubMask } from "./mask.js"
import { GitHubResolve } from "./resolve.js"
import { GitHubService } from "./service.js"
import { GitHubStore } from "./store.js"
import { GitHubTools } from "./tools.js"

/**
 * The GitHub connection of one Location (16, GH): its `github_*` tools (one tool transform, registered again when
 * what the Location offers changes), the ask on every GitHub write (an agent transform kept last and the `permission`
 * hook, which lets a write run unasked only while core holds a saved `항상 허용` of exactly it, core patch P-047, GH-13,
 * GH-26), git's logins for the shells core starts here (`shell` hook `create.before`, with the conversation and the
 * command's id through core patch P-046), the process-wide answer to git's credential requests, the bridge other own
 * plugins ask (own-team's push, the harnesses' shells) and the masking of the accounts' tokens in every tool result
 * and, as a backstop, in what each model request sends (GH-18, GH-30). The control Location's instance also reads the
 * tool list when it is missing or stale. This PC only: an SSH host's service registers `GitHubRemote` instead, which
 * asks this PC (16 §8). `stop` undoes everything.
 */

/** The tool list is read again after this long, so a server's new tools arrive without a change here. */
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60_000
/**
 * A command core starts that names no id (so no `shell.exited` ends its git login) keeps the login this long from its
 * first use when it has no timeout (in the background).
 */
export const SHELL_TICKET_MS = 60 * 60_000
/** Such a command with a timeout keeps it this long past the timeout, from its first use. */
export const SHELL_GRACE_MS = 60_000
/** A process another own plugin starts through the bridge without saying when it ends: from its first use. */
export const BRIDGE_TICKET_MS = 60 * 60_000
/** The tokens the masker hides are read again after this long (and after every change). */
export const MASK_MAX_AGE_MS = 60_000
/**
 * A conversation's choice keeps a command without a conversation from the folder's account only while the
 * conversation was chosen or active this recently (GH-33): an old one does not take the review tab's git for good.
 */
export const ACTIVE_CHOICE_MS = 7 * 24 * 60 * 60_000

export interface Connection {
  /** OpenCode events (the instance's one subscription, `Events.start`). */
  readonly onEvent: NonNullable<Module.Lifecycle["onEvent"]>
  readonly stop: () => Promise<void>
}

export async function register(deps: Deps): Promise<Connection> {
  const log = deps.log.child("github")
  const hook = Hooks.guard(log)
  const store = GitHubStore.file(deps)
  const first = await store.read().catch(() => GitHubStore.EMPTY)
  const state = {
    offer: await GitHubTools.offer(first, deps.location),
    read: 0,
    stopped: false,
    /** The last masker read; kept when the file or the vault cannot be read (fail closed, GH-30). */
    mask: undefined as { readonly at: number; readonly mask: GitHubMask.Mask } | undefined,
    /** Core's shell commands with a git login, by id: their exit ends it (GH-27). */
    commands: GitHubCommands.make<{ readonly exit: AbortController }>({ now: () => deps.clock.now() }),
  }
  /** What this Location offers, by count, whenever it changes (and at the start when it offers any). */
  const offered = () =>
    log.info("github_tools_offered", {
      location: deps.location.directory,
      read: state.offer.tools.filter((tool) => tool.read).length,
      write: state.offer.tools.filter((tool) => !tool.read).length,
    })
  if (state.offer.tools.length > 0) offered()

  const asks = await writeAsks(deps, log)
  await deps.ctx.tool.transform((editor) =>
    hook.sync("github.tools", () => {
      if (state.offer.tools.length === 0) return
      editor.namespace({ name: GitHubTools.NAMESPACE, description: GitHubTools.DESCRIPTION })
      for (const definition of GitHubTools.definitions(deps, state.offer)) editor.add(definition)
    }),
  )
  // The connected accounts' tokens are cut out of every tool's result in every harness (a shell that printed one, a
  // program that echoed git's login): GH-18.
  await deps.ctx.tool.hook("execute.after", (event) =>
    hook.safe(
      "github.mask",
      async () => {
        const mask = await maskNow()
        if (!mask) return
        if (event.status === "completed") event.result = masked(event.result, mask)
        if (event.status === "error") event.error = maskedError(event.error, mask)
      },
      undefined,
    ),
  )
  // A backstop for what reaches a model without passing a tool's result: a background command's completion notice
  // (`sessions.synthetic`), the user's `!` command output, a token the user typed, a result older than the account
  // (GH-30). Every kind of a conversation's model request carries history: the agent loop (`context`), compaction, a
  // one-off `generate` (the goal reviewer, warming, own-team's judge, `POST /api/session/:id/generate`, the switcher's
  // hand-over) and the title from the first message. On the Claude Agent route a `generate` or compaction request is
  // written as a forked transcript into the account's shared projects folder, so an unmasked one would put the token on
  // disk (MR9 review).
  const backstop = (name: string) => (event: Pick<SessionContext, "messages">) =>
    hook.safe(
      name,
      async () => {
        const mask = await maskNow()
        if (mask) maskMessages(event.messages, mask)
      },
      undefined,
    )
  await deps.ctx.session.hook("context", backstop("github.mask.context"))
  await deps.ctx.session.hook("compaction", backstop("github.mask.compaction"))
  await deps.ctx.session.hook("generate", backstop("github.mask.generate"))
  await deps.ctx.session.hook("title", backstop("github.mask.title"))

  /**
   * The mask of every connected account's token (its refresh token, git's Basic login, their base64 forms) and of the
   * tokens replaced or removed in the last 30 days (by hash), read at most each minute. When the file or the vault
   * cannot be read, the last mask stays (fail closed, GH-30).
   */
  async function maskNow() {
    const now = Date.now()
    if (state.mask && now - state.mask.at < MASK_MAX_AGE_MS) return state.mask.mask
    const read = await GitHubMask.read(deps, state.mask?.mask).catch((error: unknown) => {
      log.warn("github_mask_unread", { error })
      return undefined
    })
    if (!read) return state.mask?.mask
    state.mask = { at: now, mask: read }
    return read
  }

  /**
   * The variables git (and with `gh`, gh) needs in `directory`, or `undefined` where no account applies. A read-only
   * account's site takes no push (GH-17).
   */
  const gitEnv = async (
    directory: string,
    env: Readonly<Record<string, string | undefined>>,
    options: GitHubBridge.Options & { readonly lifetimeMs: number },
  ) => {
    const file = await store.read()
    // Off Windows own cannot tell who asks (GitHubCaller): git keeps the user's own logins there (GH-34).
    if (!file.settings.git || !GitHubCaller.CHECKED) return undefined
    const root = options.sessionID === undefined ? undefined : await GitHubService.rootOf(deps, options.sessionID)
    const resolved = await GitHubResolve.resolve(file, { directory, ...(root === undefined ? {} : { root }) })
    const entry = resolved.entry
    if (!entry || entry.problem) return undefined
    const extra = await GitHubCredential.environment(
      env,
      entry.site,
      { directory, ...(root === undefined ? {} : { root }) },
      {
        lifetime: { ms: options.lifetimeMs, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        readOnly: !entry.write,
      },
    )
    if (!options.gh) return extra
    const token = await GitHubService.tokenFor(deps, entry, file.settings)
    if (!token.ok) return extra
    const site = new URL(entry.site)
    // gh reads GH_TOKEN for github.com and `*.ghe.com`, GH_ENTERPRISE_TOKEN with GH_HOST for a GitHub Enterprise Server.
    const cloud = site.origin === OwnGitHub.GITHUB_COM || site.hostname.endsWith(".ghe.com")
    return cloud
      ? { ...extra, GH_TOKEN: token.token }
      : { ...extra, GH_ENTERPRISE_TOKEN: token.token, GH_HOST: site.host }
  }

  // git in the shells core starts here (the opencode and omo harnesses' shell tool, the user's `!` commands, the review
  // tab's git actions). A conversation's command names its conversation (core patch P-046), so the conversation's own
  // choice applies, `off` too. A command without one gets the folder's account only where no conversation here chose
  // otherwise lately (GH-14, GH-33). The command's id (P-046) lets its exit end its login; its clock starts at its first
  // use, so a command the user approves late or moves to the background still logs in (GH-27).
  await deps.ctx.shell.hook("create.before", (event) =>
    hook.safe(
      "github.shell",
      async () => {
        if (event.sessionID === undefined && (await chosenElsewhere(event.cwd))) return
        const exit = event.id === undefined ? undefined : new AbortController()
        const lifetimeMs = exit
          ? GitHubCredential.MAX_TICKET_MS
          : event.timeout > 0
            ? event.timeout + SHELL_GRACE_MS
            : SHELL_TICKET_MS
        const extra = await gitEnv(event.cwd, event.env, {
          lifetimeMs,
          ...(exit === undefined ? {} : { signal: exit.signal }),
          ...(event.sessionID === undefined ? {} : { sessionID: event.sessionID }),
        })
        if (!extra) return
        Object.assign(event.env, extra)
        if (event.id === undefined || exit === undefined) return
        // A command whose permission was refused never starts, so never exits: the oldest such are let go, their
        // login ended (RL2-L4).
        state.commands.add(event.id, { exit })
      },
      undefined,
    ),
  )

  /**
   * Whether a conversation in or around `directory` (or one whose folder is not known) chose another account (or
   * `off`) than the folder's own, and was chosen or active in the last {@link ACTIVE_CHOICE_MS} (GH-14, GH-33).
   */
  async function chosenElsewhere(directory: string) {
    const file = await store.read()
    const folder = (await GitHubResolve.resolve(file, { directory })).inUse.account
    const now = deps.clock.now()
    // This PC's conversations only: an SSH host's choices are about that host's folders (16 §8).
    const differing = file.sessions.filter(
      (item) => item.host === undefined && (item.account === "off" ? undefined : item.account) !== folder,
    )
    for (const item of differing) {
      const recent = now - item.at < ACTIVE_CHOICE_MS
      const session = recent && item.directory !== undefined ? undefined : await sessionOf(item.sessionID)
      const place = item.directory ?? session?.location.directory
      const near =
        place === undefined || Location.within(directory, place) || Location.within(place, directory)
      if (!near) continue
      if (recent || (session !== undefined && now - millis(session.time.updated) < ACTIVE_CHOICE_MS)) return true
    }
    return false
  }

  /** Core's session, or `undefined` when it is gone or cannot be read. */
  async function sessionOf(sessionID: string) {
    return deps.ctx.session
      .get({ sessionID })
      .then((session) => session ?? undefined)
      .catch(() => undefined)
  }

  const unbridge = GitHubBridge.provide({
    // A caller's signal ends the login with its process; without one it lasts an hour from its first use.
    gitEnv: (directory, options = {}) =>
      gitEnv(directory, process.env, {
        ...options,
        lifetimeMs: options.signal === undefined ? BRIDGE_TICKET_MS : GitHubCredential.MAX_TICKET_MS,
      }),
  })
  const unanswer = GitHubCredential.provide(async (ask) => {
    const file = await store.read()
    if (!file.settings.git) return undefined
    const resolved = await GitHubResolve.resolve(file, {
      directory: ask.directory,
      ...(ask.root === undefined ? {} : { root: ask.root }),
    })
    const entry = resolved.entry
    if (!entry || entry.problem) return undefined
    const site = new URL(entry.site)
    if (ask.protocol !== site.protocol.slice(0, -1) || ask.host.toLowerCase() !== site.host.toLowerCase())
      return undefined
    const repository = repositoryOfPath(ask.path)
    const audit = {
      account: entry.id,
      host: ask.host,
      repository: repository ?? null,
      operation: ask.caller.operation,
      caller: ask.caller.via,
    }
    const refuse = (reason: string) => {
      log.warn("github_git_login_refused", { ...audit, reason })
      return undefined
    }
    // Per repository (GH-19): the request names one GitHub could name, git or git-lfs itself asks, and an account
    // that allows no writes never logs in a push.
    if (!repository) return refuse("no_repository")
    if (!ask.caller.trusted) return refuse("caller")
    if (!entry.write && ask.caller.operation === "push") return refuse("read_only")
    const token = await GitHubService.tokenFor(deps, entry, file.settings)
    if (!token.ok) return refuse(token.problem)
    log.info("github_git_login", audit)
    return { username: entry.login, password: token.token }
  })

  const service = deps.location.control ? GitHubService.create(deps) : undefined
  /** The control instance reads the tool list when accounts exist and it is missing, of other settings, or old. */
  const freshen = (file: GitHubStore.File) => {
    if (!service || file.accounts.length === 0) return
    const stale =
      !file.catalog ||
      file.catalog.key !== GitHubStore.catalogKey(file.settings) ||
      deps.clock.now() - file.catalog.at > CATALOG_MAX_AGE_MS
    if (!stale) return
    void service.refreshCatalog({}).catch((error: unknown) => log.warn("github_catalog_failed", { error }))
  }
  freshen(first)

  const reread = async () => {
    const current = ++state.read
    const file = await store.read()
    const next = await GitHubTools.offer(file, deps.location)
    if (current !== state.read || state.stopped) return
    const before = JSON.stringify(state.offer)
    state.offer = next
    if (JSON.stringify(next) === before) return
    await deps.ctx.tool.reload()
    offered()
  }
  const off = deps.runtime.broadcast.on("github.changed", () => {
    // An account, a token or a renewal changed: the mask reads the tokens again on its next use (the last one stays
    // until then, and when that read fails).
    if (state.mask) state.mask = { ...state.mask, at: 0 }
    void reread().catch((error: unknown) => log.error("github_reload_failed", { error }))
  })

  return {
    onEvent: (event, meta) => {
      if (event.type === "plugin.updated") {
        if (meta.local) asks.again()
        return
      }
      // A command core started here ran (it is never let go) or ended: its git login ends with it (GH-27). Ids are
      // unique, so any Location's event may name one of this instance's commands.
      if (event.type === "shell.created") {
        state.commands.started(event.data.info.id)
        return
      }
      if (event.type !== "shell.exited" && event.type !== "shell.deleted") return
      state.commands.ended(event.data.id)
    },
    stop: async () => {
      state.stopped = true
      off()
      unbridge()
      unanswer()
      state.commands.clear()
      await asks.stop()
    },
  }
}

/**
 * GitHub's writes ask (16 §5.4), in this PC's Locations and in an SSH host's (16 §8). Core's default agent allows every
 * action (`*`) and own's approval modes name only file and shell actions, so without the agent rule a write would run
 * unasked; agents that deny it already keep that. Core applies the config's (and Markdown) agents in a builtin plugin
 * that activates after every configured plugin, so the rule is registered again after each local `plugin.updated`
 * ({@link WriteAsks.again}) and stays last (GH-13). Whatever an agent's or a conversation's rules say (an agent another
 * plugin added later, omo's children with the v1 `*` allow, a config `permission`), the `evaluate` hook makes a write
 * that would run unasked ask, unless core holds a saved `항상 허용` of exactly that tool, repository and account for this
 * project now (GH-13, GH-26). Tighten only, as the read-only roles' hook.
 */
export async function writeAsks(deps: Pick<Deps, "ctx">, log: Logger.Logger) {
  const hook = Hooks.guard(log)
  const state = { agents: undefined as Registration | undefined, moving: Promise.resolve() }
  const relocate = async () => {
    const previous = state.agents
    state.agents = await deps.ctx.agent.transform((editor) =>
      hook.sync("github.agents", () => GitHubTools.askWrites(editor)),
    )
    await previous?.dispose()
  }
  await relocate()
  await deps.ctx.permission.hook("evaluate", (event) =>
    hook.safe("github.evaluate", () => evaluate(event), undefined),
  )

  /**
   * Keeps an allow of a write only while core holds a saved `항상 허용` of exactly each resource for this project
   * (`event.saved`, core patch P-047): a removed one asks again at once in every conversation, an allow-all one too,
   * and a hand-made pattern (`*`, `octo/*`) or another account's never counts (GH-26, GH-31, GH-32).
   */
  function evaluate(event: PermissionEvaluation) {
    if (event.action !== GitHubTools.WRITE_ACTION || event.effect !== "allow") return
    const saved = event.saved ?? []
    if (event.resources.every((resource) => GitHubTools.savedExactly(resource, saved))) return
    event.effect = "ask"
    // Carry a reason, so another own hook's approved extension allow does not lift this ask (L1/L2, MR15).
    if (event.message === undefined) event.message = "A GitHub write asks first unless you saved 항상 허용 for exactly this tool, repository and account."
    log.info("github_write_asks", { agent: event.agent ?? null })
  }

  return {
    /** Registers the agent rule again, last (after this Location's `plugin.updated`). */
    again: () => {
      state.moving = state.moving
        .then(relocate)
        .catch((error: unknown) => log.error("github_agents_register_failed", { error }))
    },
    stop: async () => {
      await state.moving
      await state.agents?.dispose().catch((error: unknown) => log.debug("github_agents_dispose_failed", { error }))
      state.agents = undefined
    },
  }
}

export type WriteAsks = Awaited<ReturnType<typeof writeAsks>>

/** `owner/repo` of git's request path (`owner/repo.git`, git-lfs's `owner/repo.git/info/lfs…`), when GitHub could name it. */
export function repositoryOfPath(value: string | undefined) {
  const match = value === undefined ? null : /^\/?([^/]+)\/([^/]+?)(?:\.git)?(?:\/info\/lfs(?:\/.*)?)?\/?$/.exec(value)
  if (!match || !GitHubTools.validName(match[1]!, match[2]!)) return undefined
  return `${match[1]}/${match[2]}`
}

/**
 * The messages a model request sends, every text of the user's, the system's and the tools' masked in place (the
 * assistant's own words stay: the provider wrote them). A message changes only when a token was in it.
 */
function maskMessages(messages: SessionContext["messages"], mask: GitHubMask.Mask) {
  if (mask.empty) return
  messages.forEach((message, index) => {
    if (message.role === "assistant") return
    const content = message.content.map((part) => {
      if (part.type === "text") {
        const text = mask.text(part.text)
        return text === part.text ? part : { ...part, text }
      }
      if (part.type !== "tool-result") return part
      const result = maskValue(part.result, mask)
      return JSON.stringify(result) === JSON.stringify(part.result) ? part : { ...part, result }
    })
    if (content.every((part, at) => part === message.content[at])) return
    // SAFETY: a plain copy with the same fields; core makes each hook message a `Message` again (`Message.make`).
    messages[index] = { ...message, content } as unknown as (typeof messages)[number]
  })
}

/** A tool result with the accounts' tokens cut out of its text, its files' `data:` URIs, its output and metadata. */
function masked(result: Tool.Result, mask: Pick<GitHubMask.Mask, "text">): Tool.Result {
  const content =
    result.content === undefined
      ? undefined
      : typeof result.content === "string"
        ? mask.text(result.content)
        : result.content.map((part) => {
            if (part.type === "text") return { ...part, text: mask.text(part.text) }
            // A `data:` URI may carry a token's bytes; a file's address stays as it is.
            if (part.uri.startsWith("data:")) return { ...part, uri: mask.text(part.uri) }
            return part
          })
  return {
    ...result,
    ...(content === undefined ? {} : { content }),
    ...(result.output === undefined ? {} : { output: maskValue(result.output, mask) }),
    ...(result.metadata === undefined ? {} : { metadata: maskValue(result.metadata, mask) as Tool.Metadata }),
  }
}

function maskedError(error: Tool.Error, mask: Pick<GitHubMask.Mask, "text">) {
  const message = mask.text(error.message)
  const metadata = error.metadata === undefined ? undefined : (maskValue(error.metadata, mask) as Record<string, unknown>)
  if (message === error.message && JSON.stringify(metadata) === JSON.stringify(error.metadata)) return error
  return new Tool.Error({
    message,
    ...(error.error === undefined ? {} : { error: error.error }),
    ...(metadata === undefined ? {} : { metadata }),
  })
}

/** Every string inside a JSON value, masked. */
function maskValue(value: unknown, mask: Pick<GitHubMask.Mask, "text">): unknown {
  if (typeof value === "string") return mask.text(value)
  if (Array.isArray(value)) return value.map((item) => maskValue(item, mask))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskValue(item, mask)]))
  return value
}

/** A session time as core's promise API gives it (milliseconds or an Effect `DateTime`). */
function millis(value: unknown) {
  if (typeof value === "number") return value
  if (typeof value === "object" && value !== null && "epochMilliseconds" in value) return Number(value.epochMilliseconds)
  return 0
}
