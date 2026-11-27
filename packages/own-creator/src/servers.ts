export * as Servers from "./servers.js"

import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Creator } from "@own/protocol/creator"
import { Effect } from "effect"
import { Match } from "./match.js"
import { Runtime } from "./runtime.js"
import { Safety } from "./safety.js"
import { Staging } from "./staging.js"
import type { CreatorState } from "./state.js"
import { CreatorTools } from "./tools.js"

/**
 * C2 in the service (17 §11): each `mcp.server` item in force in this Location is an MCP server of core's config path
 * (`ctx.mcp.transform`), named `creator-<id>-<name>`. Its command is own's host (`runtime/mcp-host.ts`) with the
 * server's version folder, the conversation's project folder as its working folder and the allow-listed environment;
 * a new version is a new command, so core restarts only that server. Its tools are Code Mode tools unless `direct`.
 *
 * Every call asks (core's MCP tools ask their own permission, named like the tool): own's `evaluate` hook turns it into
 * an ask under 묻기 and 읽기 전용 whatever the agent's rules say, and under 전체 허용 it asks once per version (the first
 * call of a version the user has not approved yet). A completed call records the approval (`confirmed`).
 */

type Ctx = Pick<Context, "mcp" | "permission" | "tool" | "session" | "location">

/** Servers stopped in this process (Settings' 멈추기), per store: they stay off until 다시 시작 or a restart. */
const stopped = new Map<string, Set<string>>()

export function isStopped(root: string, id: string) {
  return stopped.get(root)?.has(id) === true
}

export function setStopped(root: string, id: string, stop: boolean) {
  const set = stopped.get(root) ?? new Set<string>()
  stopped.set(root, set)
  if (stop) set.add(id)
  else set.delete(id)
}

export function stoppedIds(root: string) {
  return [...(stopped.get(root) ?? [])]
}

/** The servers in force in this Location, each with the extension and version that holds it. */
export function inForce(state: CreatorState.State) {
  return Match.items(state.list, "mcp.server")
    .filter((entry) => Match.where(entry.item.when, state.directory))
    .map((entry) => ({
      id: entry.owner.loaded.entry.id,
      version: entry.owner.loaded.entry.active,
      dir: entry.owner.loaded.dir,
      item: entry.item,
      entry: entry.owner.loaded.entry,
      name: Creator.serverName(entry.owner.loaded.entry.id, entry.item.name),
    }))
}

export const register = (ctx: Ctx, state: CreatorState.State, bun: string, confirm: (id: string, n: number) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* ctx.mcp.transform((editor) => {
      inForce(state)
        .filter((server) => !isStopped(state.store.root, server.id))
        .forEach((server) => {
          const fence = Safety.fence({ project: ctx.location.directory, home: state.store.home, env: process.env, item: server.item })
          editor.set(server.name, {
            type: "local",
            command: Staging.hostCommand({
              bun,
              host: Runtime.paths(state.store.root).host,
              bundle: path.join(server.dir, "servers", server.item.name, Runtime.BUNDLE),
              quickjs: Runtime.quickjs(),
              fence,
              log: Runtime.logFile(state.store.root, server.id),
              label: `${server.id} v${server.version} ${server.item.name}`,
            }),
            environment: { ...Safety.serverEnv(process.env, {}), BUN_BE_BUN: "1" },
            cwd: ctx.location.directory,
            codemode: server.item.direct !== true,
            timeout: { startup: 30_000, catalog: 15_000, execution: (server.item.timeoutSeconds ?? 60) * 1000 + 5_000 },
          })
        })
    })
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.effect === "deny" || !event.action.startsWith(Creator.SERVER_PREFIX)) return
        const server = serverOf(state, event.action)
        // A creator tool core still lists while this instance does not (a version that just changed, a mirror still
        // being applied): never let it through unasked.
        if (server === undefined) {
          event.effect = "ask"
          event.message = "A creator extension tool that is not in force here right now: approve this call yourself."
          return
        }
        const facts = yield* Match.facts(ctx, event.sessionID, event.agent)
        if (facts !== undefined && !Match.when(server.item.when, facts)) {
          event.effect = "deny"
          event.message = `This tool is not available in this conversation (extension '${server.id}').`
          return
        }
        const mode = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(
          Effect.map((info) => CreatorTools.modeOf(info.permissions ?? [])),
          Effect.orElseSucceed(() => "ask" as const),
        )
        // 읽기 전용 denies a C2 tool outright (a read-only role may not call one, F4/MR15); own-accounts' read-only
        // roles also deny by the `creator-` prefix, so this holds even where that hook did not run.
        if (mode === "read-only") {
          event.effect = "deny"
          event.message = "This conversation is read-only (읽기 전용): it may not call creator extension tools."
          return
        }
        // 전체 허용 lets a call through once the user approved one call of this version; every other mode asks. An ask
        // another own hook wrote with its reason stays (tighten only, MR14).
        if (event.effect === "ask" && event.message !== undefined) return
        event.effect = mode === "full" && server.entry.confirmed.includes(server.version) ? "allow" : "ask"
      }),
    )
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.status !== "completed") return
        const server = serverOf(state, event.tool)
        if (server === undefined || server.entry.confirmed.includes(server.version)) return
        yield* confirm(server.id, server.version)
      }),
    )
  })

/** The server whose tools `name` (a tool or its permission, `<server>_<tool>`) belongs to. */
function serverOf(state: CreatorState.State, name: string) {
  if (!name.startsWith("creator-")) return undefined
  return inForce(state).find((server) => name.startsWith(`${server.name}_`))
}

/** A hash of what the servers in force register, to reload core's MCP servers only when it changed. */
export function fingerprint(state: CreatorState.State) {
  return JSON.stringify(
    inForce(state).map((server) => [server.name, server.version, isStopped(state.store.root, server.id), server.item]),
  )
}
