export * as GitHubRemote from "./remote.js"

import { Option, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import { Broker } from "@own/protocol"
import { GitHubBridge } from "@own/runtime"
import type { Deps } from "../deps.js"
import { Hooks } from "../hooks.js"
import type { Module } from "../module.js"
import type { RemoteHost } from "../remote/host.js"
import { GitHubCommands } from "./commands.js"
import { GitHubCredential } from "./credential.js"
import { GitHubProc } from "./proc.js"
import { GitHubConnection } from "./register.js"
import { GitHubResolve } from "./resolve.js"
import { GitHubService } from "./service.js"
import { GitHubTools } from "./tools.js"

/**
 * GitHub in one Location of an SSH host's own service (16 §8, GH-37): the same `github_*` tools as on the PC, which
 * the PC runs with its account and token; git and git-lfs through the PC's git relay. No token is ever here.
 *
 * - Tools: the PC says which tools this folder offers (`github.offer`, read again when a normal-mode session comes up
 *   and when the PC's GitHub changed); each call asks the PC which account this folder and conversation use
 *   (`github.account`, with the root conversation of the host's own session tree and the folder's main checkout read
 *   here), asks the user for a write in the host's conversation as the PC asks in its own (`GitHubTools.askWrite`, the
 *   same resource with the account, the same agent rule and `evaluate` hook), then has the PC run it with that
 *   account (`github.call`, which refuses when the account changed in between).
 * - git: the shells core starts here and the processes other own plugins start through the bridge get the variables
 *   that send git's requests for the account's site to this host's relay stub (`GitHubCredential.relayEnvironment`,
 *   a ticket per command that ends with it, as on the PC), where the PC adds the login; a read-only account's pushes
 *   stop at once (`pushInsteadOf`) and the PC refuses them too. gh gets no token on a host.
 * - A host the PC has not allowed to write (GH-49) gets no write tools, a write fails before it asks, and its git
 *   pushes stop at once as a read-only account's.
 */

/** The same lifetimes as this PC's (`GitHubConnection`). */
const SHELL_TICKET_MS = 60 * 60_000
const SHELL_GRACE_MS = 60_000
const BRIDGE_TICKET_MS = 60 * 60_000

const decodeOffer = Schema.decodeUnknownOption(Broker.GitHubOffer)
const decodeAccount = Schema.decodeUnknownOption(Broker.GitHubAccountResult)
const decodeCall = Schema.decodeUnknownOption(Broker.GitHubCallResult)

const HOST_READ_ONLY =
  "The PC lets this SSH host only read on GitHub. The user can allow writing for this host in own Settings > GitHub on the PC."

const UNREACHABLE =
  "This SSH host could not reach the PC's GitHub connection (the link to the PC is down). Try again once it is connected."

export interface Connection {
  readonly onEvent: NonNullable<Module.Lifecycle["onEvent"]>
  readonly stop: () => Promise<void>
}

export async function register(
  deps: Deps,
  github: RemoteHost.GitHub,
  /** Tests: another `/proc` for the start of a command's process (GH-48). */
  proc: GitHubProc.Proc = GitHubProc.system,
): Promise<Connection> {
  const log = deps.log.child("github")
  const hook = Hooks.guard(log)
  const state = {
    offer: { tools: [] as ReadonlyArray<Broker.GitHubTool>, git: false },
    read: 0,
    stopped: false,
    /** Each running core shell command's end and ticket, by its id. */
    commands: GitHubCommands.make<{ readonly exit: AbortController; readonly ticket: string }>({
      now: () => deps.clock.now(),
    }),
  }
  const asks = await GitHubConnection.writeAsks(deps, log)

  await deps.ctx.tool.transform((editor) =>
    hook.sync("github.tools", () => {
      if (state.offer.tools.length === 0) return
      editor.namespace({ name: GitHubTools.NAMESPACE, description: GitHubTools.DESCRIPTION })
      for (const tool of state.offer.tools)
        editor.add({
          name: tool.name,
          description: tool.read ? tool.description : `${tool.description}\n\n(Asks the user before it runs.)`,
          input: tool.input as Tool.ValueSchema,
          options: { namespace: GitHubTools.NAMESPACE },
          execute: (input: unknown, context: GitHubTools.Call) => run(tool, input, context),
        })
    }),
  )

  /** The PC's offer for this folder; the tools registered again when it changed. */
  const reread = async () => {
    if (deps.location.control) return
    const current = ++state.read
    const main = await GitHubResolve.mainCheckout(deps.location.directory)
    const reply = await github.ask(
      "github.offer",
      { directory: deps.location.directory, ...(main === undefined ? {} : { main }) } satisfies Broker.GitHubOfferGet,
      { timeoutMs: Broker.GITHUB_ASK_TIMEOUT_MS, wait: false },
    )
    const next = reply.ok ? Option.getOrUndefined(decodeOffer(reply.result)) : undefined
    // The PC was not reached: what this Location offers stays until it is.
    if (!next || current !== state.read || state.stopped) return
    const before = JSON.stringify(state.offer)
    state.offer = next
    if (JSON.stringify(next) === before) return
    await deps.ctx.tool.reload()
    log.info("github_tools_offered", {
      location: deps.location.directory,
      read: next.tools.filter((tool) => tool.read).length,
      write: next.tools.filter((tool) => !tool.read).length,
      remote: true,
    })
  }
  const off = github.on(() => void reread().catch((error: unknown) => log.warn("github_offer_failed", { error })))
  await reread().catch((error: unknown) => log.warn("github_offer_failed", { error }))

  /** Where a call or a git process of this host is, as the PC needs it: the folder, its main checkout, the root. */
  async function placeOf(directory: string, sessionID: string | undefined): Promise<Broker.GitHubPlace> {
    const main = await GitHubResolve.mainCheckout(directory)
    const root = sessionID === undefined ? undefined : await GitHubService.rootOf(deps, sessionID)
    return { directory, ...(main === undefined ? {} : { main }), ...(root === undefined ? {} : { root }) }
  }

  async function run(tool: Broker.GitHubTool, input: unknown, context: GitHubTools.Call): Promise<Tool.Result> {
    const place = await placeOf(deps.location.directory, context.sessionID)
    const asked = await github.ask("github.account", place, { timeoutMs: Broker.GITHUB_ASK_TIMEOUT_MS, wait: true })
    const found = asked.ok ? Option.getOrUndefined(decodeAccount(asked.result)) : undefined
    if (!found) throw new Tool.Error({ message: UNREACHABLE })
    const entry = GitHubTools.usable(found.account, found.source, found.problem)
    // The PC lets this host read only (GH-49): no ask for a write that would not run.
    if (!tool.read && !found.hostWrite) throw new Tool.Error({ message: HOST_READ_ONLY })
    // The host's conversation asks for a write, with the account the PC named (GH-32's resource).
    await GitHubTools.askWrite(deps, tool, entry, input, context)
    const reply = await github.ask(
      "github.call",
      { ...place, tool: tool.name, input, account: entry.id } satisfies Broker.GitHubCall,
      { timeoutMs: Broker.GITHUB_CALL_TIMEOUT_MS, wait: true },
    )
    const result = reply.ok ? Option.getOrUndefined(decodeCall(reply.result)) : undefined
    if (!result) throw new Tool.Error({ message: UNREACHABLE })
    if ("error" in result) throw new Tool.Error({ message: result.message })
    return GitHubTools.answer(result.account, tool, result)
  }

  /**
   * The variables git needs in `directory` on this host and the ticket they hold, or `undefined` where no account's login
   * applies. A `bound` ticket works only for the command process named once it is spawned (GH-48).
   */
  const gitEnv = async (
    directory: string,
    env: Readonly<Record<string, string | undefined>>,
    options: GitHubBridge.Options & { readonly lifetimeMs: number; readonly bound: boolean },
  ) => {
    const stub = github.stub()
    if (!stub || !state.offer.git) return undefined
    const place = await placeOf(directory, options.sessionID)
    const reply = await github.ask("github.account", place, { timeoutMs: Broker.GITHUB_ASK_TIMEOUT_MS, wait: false })
    const found = reply.ok ? Option.getOrUndefined(decodeAccount(reply.result)) : undefined
    if (!found?.account || found.problem || !found.git) return undefined
    const ticket = GitHubCredential.issueTicket(
      { directory, ...(place.root === undefined ? {} : { root: place.root }) },
      {
        ms: options.lifetimeMs,
        bound: options.bound,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    )
    // gh would need the token itself, which never leaves the PC: a host's gh keeps its own login. A host the PC lets
    // read only pushes nowhere, as a read-only account (GH-49).
    return {
      ticket,
      env: GitHubCredential.relayEnvironment(env, found.account.site, stub, ticket, {
        readOnly: !found.account.write || !found.hostWrite,
      }),
    }
  }

  // git in the shells core starts here, as on the PC (GH-14, GH-27): the conversation's choice applies; the PC keeps a
  // command without a conversation off the folder's account where a recent conversation choice differs.
  await deps.ctx.shell.hook("create.before", (event) =>
    hook.safe(
      "github.shell",
      async () => {
        const exit = event.id === undefined ? undefined : new AbortController()
        const lifetimeMs = exit
          ? GitHubCredential.MAX_TICKET_MS
          : event.timeout > 0
            ? event.timeout + SHELL_GRACE_MS
            : SHELL_TICKET_MS
        // With the command's id its ticket is bound to the process `shell.created` names (GH-48).
        const extra = await gitEnv(event.cwd, event.env, {
          lifetimeMs,
          bound: exit !== undefined,
          ...(exit === undefined ? {} : { signal: exit.signal }),
          ...(event.sessionID === undefined ? {} : { sessionID: event.sessionID }),
        })
        if (!extra) return
        Object.assign(event.env, extra.env)
        if (event.id === undefined || exit === undefined) return
        // A refused command never starts: the oldest such are let go and their tickets end, never a running one's
        // (RL2-L4).
        state.commands.add(event.id, { exit, ticket: extra.ticket })
      },
      undefined,
    ),
  )

  const unbridge = GitHubBridge.provide({
    gitEnv: async (directory, options = {}) => {
      const found = await gitEnv(directory, process.env, {
        ...options,
        lifetimeMs: options.signal === undefined ? BRIDGE_TICKET_MS : GitHubCredential.MAX_TICKET_MS,
        bound: options.pid !== undefined,
      })
      if (!found) return undefined
      // The caller names the process it spawns with these variables (GH-48).
      options.pid?.then(
        (pid) => GitHubCredential.started(found.ticket, GitHubProc.holder(proc, pid)),
        () => GitHubCredential.started(found.ticket, undefined),
      )
      return found.env
    },
  })

  return {
    onEvent: (event, meta) => {
      if (event.type === "plugin.updated") {
        if (meta.local) asks.again()
        return
      }
      if (event.type === "shell.created") {
        // The command's process (core P-046): its ticket works for it alone (GH-48).
        const command = state.commands.started(event.data.info.id)
        if (command) GitHubCredential.started(command.ticket, GitHubProc.holder(proc, event.data.info.pid))
        return
      }
      if (event.type !== "shell.exited" && event.type !== "shell.deleted") return
      state.commands.ended(event.data.id)
    },
    stop: async () => {
      state.stopped = true
      off()
      unbridge()
      state.commands.clear()
      await asks.stop()
    },
  }
}
