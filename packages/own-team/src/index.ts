import path from "node:path"
import { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { OwnID } from "@own/protocol"
import { Home, Runtime } from "@own/runtime"
import { Build } from "./build.js"
import { Identity } from "./git/identity.js"
import { Hooks } from "./hooks/index.js"
import type { Hub } from "./hub.js"
import { Intake } from "./intake.js"
import { Log } from "./log.js"
import { Options } from "./options.js"
import { RemoteEnv } from "./remote/env.js"
import { HealthRpc } from "./rpc/health.js"
import { TeamRpc } from "./rpc/handlers.js"
import { Services } from "./services.js"
import { SessionHttp } from "./sessions/http.js"
import { Singleton } from "./singleton.js"
import { Tools } from "./tools/index.js"
import { WorktreeChatTools } from "./worktree-chat/tools.js"
import { WorktreeHome } from "./worktree-home/strategy.js"

/**
 * own.team (06): team mode. Third in the plugin order (06 §2.6). One instance per Location; the controller (registry,
 * ops, hub, feature services) is a process-lifetime singleton of the build (`singleton.ts`). Setup: guard 1 → runtime
 * (leadership group `own.team`, the control location leads) → controller → RPC `own.team` (events only from the
 * leader) → team tools and agent denies → hooks → this Location's event intake. Guard failures register `health`
 * only. A remote service (`mode: "remote"`, 06 §4.13) loads in full the same way, with the bundled git-lfs first on
 * the `PATH` of own's git calls (`remote/env.ts`) before the controller resumes any op. Cleanup runs in reverse.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  setup: async (ctx) => {
    const options = Options.decode(ctx.options)
    const layout = Home.layout(Home.resolve({ home: options.home }))
    // RH-20: the service's stderr is read by nobody once it runs (a host service's parent closes it), so the lines also
    // go to OWN_HOME\logs\own-team.log, the guard's refusal included.
    const log = Log.create({
      level: options.logLevel ?? "info",
      scope: Build.PLUGIN_ID,
      file: path.join(layout.logs, "own-team.log"),
    })
    const buildId = options.buildId ?? Build.BUILD_ID
    const mode = options.mode ?? "local"
    const guard = HealthRpc.guard({ appVersion: ctx.app.version, env: process.env, mode })
    if (guard.guard !== "ok") {
      log.warn("guard_failed", { guard: guard.guard, reason: guard.reason, mode })
      const registration = await HealthRpc.registerOnly(ctx, { guard: guard.guard, buildId, mode })
      return () => registration.dispose()
    }

    const control = Identity.same(ctx.location.directory, layout.control)
    // `role`: own.team elects its own leader among its own instances (own-runtime `Runtime.Options.role`).
    const runtime = await Runtime.acquire({ buildId, home: options.home, preferLeader: control, role: Build.PLUGIN_ID })
    const stack = new AsyncDisposableStack()
    stack.defer(() => runtime.release())
    try {
      // This instance's module copy (its hooks and tools) and the controller's each hold remote mode (06 §4.13).
      if (mode === "remote") stack.defer(RemoteEnv.enter(runtime.layout.root))
      const slot = Singleton.acquire({
        buildId,
        home: runtime.layout.root,
        log: log.child("controller"),
        clock: Services.system,
        source: SessionHttp.source({ service: options.service, channel: ctx.app.channel }),
        ...(mode === "remote" ? { tools: RemoteEnv.tools(runtime.layout.root) } : {}),
        ...(options.lingerSeconds === undefined ? {} : { lingerSeconds: options.lingerSeconds }),
      })
      stack.defer(() => slot.release())
      const controller = slot.controller
      const services = controller.services
      stack.defer(
        controller.attach({ ctx, directory: ctx.location.directory, control, leader: () => runtime.isLeader() }),
      )
      const registration = await ctx.rpc.register(
        TeamRpc.definition(),
        TeamRpc.create({ services, leader: () => runtime.isLeader(), log: log.child("rpc") }),
      )
      stack.defer(() => registration.dispose())
      stack.defer(
        controller.hub.subscribe((event) => {
          // Only the leader publishes (06 §2.6); every event gets a fresh eventId and origin "global".
          if (!runtime.isLeader()) return
          void emit(registration, event).catch((error: unknown) =>
            log.warn("emit_failed", { event: event.name, error }),
          )
        }),
      )
      const tools = await Tools.register({ ctx, services, log: log.child("tools") })
      stack.defer(() => tools.dispose())
      // 06 §4.12a: worktrees outside team mode default to the project's `.worktrees` too.
      const home = await WorktreeHome.register(ctx)
      stack.defer(() => home.dispose())
      // 06 §13: worktree conversations, in every conversation (no team needed).
      const chats = await WorktreeChatTools.register({ ctx, services, log: log.child("worktree-chat") })
      stack.defer(() => chats.dispose())
      stack.defer(await Hooks.register({ ctx, services, log: log.child("hooks") }))
      const instance = controller.instanceID(ctx.location.directory)
      stack.defer(
        Intake.start({
          ctx,
          hub: controller.hub,
          dedup: controller.dedup,
          log: log.child("intake"),
          local: (event) => {
            if (event.type === "plugin.updated" && here(event, ctx.location.directory)) void tools.relocate()
          },
          // RH-20: a stream read again misses what came meanwhile; the resume catches up and drains the outboxes.
          restarted: () => void controller.resume(),
          status: (status) => {
            if (instance !== undefined) services.status.setIntake(instance, status)
          },
        }),
      )
      log.info("ready", { buildId, mode, location: ctx.location.directory, control, leader: runtime.isLeader() })
    } catch (error) {
      log.error("setup_failed", { error })
      await stack.disposeAsync()
      throw error
    }
    return () => stack.disposeAsync()
  },
})

/** Emits a hub event through this instance's registration with the `eventId`/`origin` envelope (06 §2.7). */
function emit(registration: Pick<RpcRegistration<TeamRpc.Definition>, "events">, event: Hub.Outgoing) {
  // SAFETY: `event` pairs an event name of `OwnTeam.Definition` with that event's body; the union erases the pairing.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const emitAny = registration.events.emit as unknown as (name: string, data: unknown) => Promise<void>
  return emitAny(event.name, { eventId: OwnID.EventID.create(), origin: "global", ...event.data })
}

/** An event of this Location (or one without a Location). */
function here(event: Hub.Incoming, directory: string) {
  return event.location?.directory === undefined || Identity.same(event.location.directory, directory)
}
