export * as Bindings from "./binding.js"

import { Option, Schema } from "effect"
import { SessionID } from "@opencode/schema/session-id"
import { Account, ClaudeAgent as Route, Kv } from "@own/protocol"
import type { Deps } from "../deps.js"
import { PresetBinding } from "../presets/binding.js"

/**
 * Which Claude Agent account a conversation runs on (02 §8.10, CAG phase 2): one per session tree and per team (07 R4),
 * the same rules as the Claude slot's accounts (02 §8.7). KV `claude-agent:session:<root>` holds a tree's account,
 * `claude-agent:team:<teamID>` a team's, which wins for every member root. A tree without one starts on the default
 * account and keeps it; only the user moves it ({@link Api.rebind}, CAG-D3), never a limit.
 */

export interface Host {
  /** The account, while it exists. */
  readonly exists: (accountID: string) => boolean
  readonly defaultID: () => Account.ID | undefined
  /** The account the root's preset names (PF 2026-11-03), for a tree that has none yet. */
  readonly preferred?: (root: string) => Promise<Account.ID | undefined>
}

export type Found = Awaited<ReturnType<ReturnType<typeof make>["bindingOf"]>>

const Bound = Schema.Struct({ accountID: Account.ID, at: Schema.Finite })
const decodeBound = Schema.decodeUnknownOption(Bound)
const toJson = Schema.decodeUnknownSync(Schema.Json)
const isSessionID = Schema.is(SessionID)

export function make(deps: Deps, host: Host) {
  const roots = new Map<string, string>()
  const cached = new Map<string, Account.ID>()
  const last = new Map<string, Account.ID>()
  const locks = new Map<string, Promise<void>>()

  /** A session's root: the runtime's index, else core's parent chain. A failed read throws (fail closed). */
  const rootOf = async (sessionID: string): Promise<string> => {
    const known = roots.get(sessionID)
    if (known) return known
    const parentID =
      deps.runtime.sessions.get(sessionID)?.parentID ??
      (await deps.ctx.session.get({ sessionID: sessionID as SessionID }))?.parentID ??
      undefined
    const root = parentID ? await rootOf(parentID) : sessionID
    roots.set(sessionID, root)
    return root
  }

  /** The team of a root (its preset binding's team context), read every time: own.team adopts roots at any time. */
  const teamOf = async (root: string) => (await PresetBinding.read(deps, root))?.team ?? null

  const readBound = async (key: string) => {
    const known = cached.get(key)
    if (known !== undefined) return known
    const value = await deps.ctx.storage.get(key)
    const bound = value === undefined ? undefined : Option.getOrUndefined(decodeBound(value))?.accountID
    if (bound !== undefined) cached.set(key, bound)
    return bound ?? null
  }

  const write = async (key: string, accountID: Account.ID) => {
    await deps.ctx.storage.set(key, toJson({ accountID, at: deps.clock.now() }))
    cached.set(key, accountID)
  }

  const bindingOf = async (sessionID: string) => {
    const root = await rootOf(sessionID)
    const team = await teamOf(root)
    const rootBound = await readBound(Kv.claudeAgentSession(root))
    const teamBound = team === null ? null : await readBound(Kv.claudeAgentTeam(team.teamID))
    return { root, team, rootBound, bound: team === null ? rootBound : teamBound }
  }

  /** Where a tree without a binding starts: a team's named account, the root's own, a member's, else the default. */
  const initial = async (found: Found) => {
    const present = (accountID: Account.ID | null) => (accountID !== null && host.exists(accountID) ? accountID : undefined)
    if (found.team === null)
      return present(found.rootBound) ?? (await host.preferred?.(found.root)) ?? host.defaultID()
    const named = found.team.accounts.find((accountID) => host.exists(accountID))
    if (named) return named
    if (present(found.rootBound)) return found.rootBound!
    for (const root of await teamRoots(found.team.teamID)) {
      const bound = present(await readBound(Kv.claudeAgentSession(root)).catch(() => null))
      if (bound) return bound
    }
    return host.defaultID()
  }

  const locked = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key)
    })
    return next
  }

  /** Every session the runtime knows in the tree of `root`. */
  const tree = (root: string) => {
    const found = [root]
    for (let index = 0; index < found.length; index++)
      for (const child of deps.runtime.sessions.children(found[index]!)) found.push(child.sessionID)
    return found
  }

  /** The roots of a team among the sessions this instance knows. */
  const teamRoots = async (teamID: string) => {
    const known = [
      ...new Set([
        ...roots.keys(),
        ...deps.runtime.sessions.list({ providerID: Route.PROVIDER_ID }).map((item) => item.sessionID),
      ]),
    ]
    const resolved = await Promise.all(known.map((sessionID) => rootOf(sessionID).catch(() => undefined)))
    const candidates = [...new Set(resolved.filter((root) => root !== undefined))]
    const teams = await Promise.all(candidates.map((root) => teamOf(root).then((team) => team?.teamID, () => undefined)))
    return candidates.filter((_root, index) => teams[index] === teamID)
  }

  return {
    rootOf,
    bindingOf,
    tree,
    teamRoots,
    write,
    readBound,

    /** The last account a request or binding gave this session; the default before one ran (sync, for folds). */
    peek: (sessionID: string | undefined) => {
      if (sessionID === undefined) return host.defaultID()
      const root = roots.get(sessionID)
      const known = last.get(sessionID) ?? (root === undefined ? undefined : last.get(root))
      return known !== undefined && host.exists(known) ? known : host.defaultID()
    },

    /** The account a session's tree runs on (no write): its binding, else the account it would start on. */
    accountOf: async (sessionID: string) => {
      const found = await bindingOf(sessionID)
      const accountID = found.bound !== null && host.exists(found.bound) ? found.bound : await initial(found)
      if (accountID !== undefined) last.set(sessionID, accountID)
      return accountID
    },

    /**
     * The account a request of `sessionID` runs on, settling its tree once (a team's binding wins; a member root's own
     * follows it). `gone`: the tree is bound to an account that no longer exists (the request is refused, never moved
     * to another account here). `none`: the route has no account.
     */
    settle: async (sessionID: string): Promise<Account.ID | "gone" | "none"> => {
      const first = await bindingOf(sessionID)
      const key = first.team === null ? Kv.claudeAgentSession(first.root) : Kv.claudeAgentTeam(first.team.teamID)
      return locked(key, async () => {
        const found = await bindingOf(sessionID)
        if (found.bound !== null && !host.exists(found.bound)) return "gone"
        const accountID = found.bound ?? (await initial(found))
        if (accountID === undefined) return "none"
        if (found.team === null) {
          if (found.bound === null) await write(Kv.claudeAgentSession(found.root), accountID)
        } else {
          if (found.bound === null) await write(Kv.claudeAgentTeam(found.team.teamID), accountID)
          if (found.rootBound !== null && found.rootBound !== accountID)
            await write(Kv.claudeAgentSession(found.root), accountID)
        }
        last.set(sessionID, accountID)
        last.set(found.root, accountID)
        return accountID
      })
    },

    /** Writes a tree's (or its team's, with every member root) account; answers the known sessions that moved. */
    move: async (sessionID: string, accountID: Account.ID) => {
      const found = await bindingOf(sessionID)
      if (found.team === null) {
        await write(Kv.claudeAgentSession(found.root), accountID)
        return { sessions: [...new Set(tree(found.root))], teamID: undefined }
      }
      await write(Kv.claudeAgentTeam(found.team.teamID), accountID)
      const members = [...new Set([found.root, ...(await teamRoots(found.team.teamID))])]
      for (const root of members) {
        const own = await readBound(Kv.claudeAgentSession(root)).catch(() => null)
        if (own !== null && own !== accountID) await write(Kv.claudeAgentSession(root), accountID)
      }
      return { sessions: [...new Set(members.flatMap(tree))], teamID: found.team.teamID }
    },

    /** Roots and teams bound to `accountID` (KV), and the known sessions last seen on it. */
    boundTo: async (accountID: Account.ID) => {
      const scan = async (prefix: string, after?: string): Promise<string[]> => {
        const result = await deps.ctx.storage.scan({ prefix, ...(after === undefined ? {} : { after }), limit: 1000 })
        const found = result.entries.flatMap((item) =>
          Option.getOrUndefined(decodeBound(item.value))?.accountID === accountID ? [item.key.slice(prefix.length)] : [],
        )
        return result.next === undefined || result.entries.length === 0
          ? found
          : [...found, ...(await scan(prefix, result.next))]
      }
      const teams = await scan(Kv.CLAUDE_AGENT_TEAM_PREFIX)
      const rooted = await scan(Kv.CLAUDE_AGENT_SESSION_PREFIX)
      const seen = [...last.entries()].filter((item) => item[1] === accountID).map((item) => item[0])
      return { teams, sessions: [...new Set([...rooted, ...seen])].filter(isSessionID) }
    },

    /** Another instance (or this one) moved these sessions: their cached bindings go. */
    forget: (change: { readonly sessionIDs: ReadonlyArray<string>; readonly accountID: string }) => {
      for (const sessionID of change.sessionIDs) {
        last.set(sessionID, change.accountID as Account.ID)
        const root = roots.get(sessionID) ?? sessionID
        cached.delete(Kv.claudeAgentSession(root))
      }
      for (const key of [...cached.keys()]) if (key.startsWith(Kv.CLAUDE_AGENT_TEAM_PREFIX)) cached.delete(key)
    },

    drop: (sessionID: string) => {
      roots.delete(sessionID)
      last.delete(sessionID)
    },
  }
}
