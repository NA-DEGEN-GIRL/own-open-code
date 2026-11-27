import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { OwnID, Portable } from "@own/protocol"
import { Home, Runtime } from "@own/runtime"
import { Build } from "./build.js"
import type { Events } from "./events.js"
import { GatewaySlot } from "./gateway/index.js"
import { Log } from "./log.js"
import { Options } from "./options.js"
import { OwnRemote } from "./protocol/rpc-remote.js"
import { Handlers } from "./rpc/handlers.js"
import { Singleton } from "./singleton.js"

/**
 * own-remote (04). Two modes from the plugin option `mode`:
 * - `local` (default): the SSH controller of the local service. The controller is a process-lifetime singleton
 *   (04 §4.1); this instance registers RPC `own.remote` and, when it leads, republishes controller events.
 * - `agent`: inside a remote service (`OWN_REMOTE=1`): `agent.realpath`, `agent.status`, `agent.broker.arm`,
 *   `agent.probe` only, and SIGUSR1 no longer writes a heap snapshot (`muteHeapSignal`).
 * Guard 1 failures leave the plugin out quietly (04 §16.1): no RPC, no ssh.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  setup: async (ctx) => {
    const options = Options.decode(ctx.options)
    const mode = options.mode ?? "local"
    // The service's stderr is read by nobody once it runs (RH-20), so on this PC the lines (the gateway's pairing steps
    // among them) also go to OWN_HOME\logs\own-remote.log. A host's agent keeps stderr only.
    const log = Log.create({
      level: options.logLevel ?? "info",
      scope: Build.PLUGIN_ID,
      ...(mode === "local"
        ? { file: path.join(Home.layout(Home.resolve({ home: options.home })).logs, "own-remote.log") }
        : {}),
    })
    const buildId = options.buildId ?? Build.BUILD_ID

    if (mode === "agent") {
      if (process.env[Build.ENV_REMOTE] !== "1") {
        log.warn("guard_failed", { mode, reason: "not a remote own service" })
        return
      }
      muteHeapSignal()
      const home = Home.resolve({ home: options.home })
      const registration = await ctx.rpc.register(
        Portable.definition(OwnRemote.AgentDefinition),
        Handlers.agent({ buildId, version: ctx.app.version, home }),
      )
      return () => registration.dispose()
    }

    const expected = options.version ?? Build.EXPECTED_APP_VERSION
    if (process.env[Build.ENV_MARKER] !== "1" || (options.version === undefined && ctx.app.version !== expected)) {
      log.warn("guard_failed", { mode, appVersion: ctx.app.version })
      return
    }
    const layout = Home.layout(Home.resolve({ home: options.home }))
    const control = samePath(ctx.location.directory, layout.control)
    // `role`: own-remote elects its own leader; own-accounts' control instance leads only own-accounts (own-runtime).
    const runtime = await Runtime.acquire({ buildId, home: options.home, preferLeader: control, role: Build.PLUGIN_ID })
    const stack = new AsyncDisposableStack()
    stack.defer(() => runtime.release())
    try {
      const controllerInput = {
        buildId,
        version: expected,
        ownHome: runtime.layout.root,
        options,
        log: log.child("controller"),
        services: runtime,
      }
      const slot = Singleton.acquire(controllerInput)
      stack.defer(() => slot.release())
      // M1 gateway (05 §13.4): process-lifetime like the controller; while enabled it pins the runtime and the
      // controller itself, so the listener outlives this Location.
      const gateway = GatewaySlot.acquire(
        {
          buildId,
          ownHome: runtime.layout.root,
          channel: ctx.app.channel,
          options: options.gateway ?? {},
          log: log.child("gateway"),
          pin: async () => {
            const pinned = await Runtime.acquire({ buildId, home: options.home, role: GATEWAY_ROLE })
            const held = Singleton.acquire(controllerInput)
            return {
              controller: held.controller,
              release: async () => {
                await held.release()
                await pinned.release()
              },
            }
          },
        },
        options.lingerSeconds ?? 30,
      )
      gateway.gateway.useController(() => slot.controller)
      stack.defer(() => gateway.release())
      // Portable (Standard Schema) definitions: a release bundle has its own `effect` (own-protocol portable.ts).
      const registration = await ctx.rpc.register(
        portableDefinition(),
        Handlers.local({ ...slot, gateway: gateway.gateway }),
      )
      stack.defer(() => registration.dispose())
      const publish = (event: Events.Event) => {
        // Only the leader publishes (04 §16.3); every event carries a fresh eventId.
        if (!runtime.isLeader()) return
        void registration.events
          .emit(event.name, { eventId: OwnID.EventID.create(), ...event.data } as never)
          .catch((error: unknown) => log.warn("emit_failed", { event: event.name, error }))
      }
      stack.defer(slot.controller.hub.subscribe(publish))
      stack.defer(gateway.gateway.hub.subscribe(publish))
      log.info("ready", { buildId, location: ctx.location.directory, control, leader: runtime.isLeader() })
    } catch (error) {
      log.error("setup_failed", { error })
      await stack.disposeAsync()
      throw error
    }
    return () => stack.disposeAsync()
  },
})

/**
 * SEC-1 (04 §15): upstream `Heap.listen` (packages/cli/src/heap.ts) writes a V8 heap snapshot into the log folder on
 * SIGUSR1 (not on Windows). The remote agent's shell runs as the same uid, so `kill -USR1` would put the armed broker
 * key and the leases on disk (04 §8.3 keeps them in memory only). Every listener gives way to one no-op: with no
 * listener at all, SIGUSR1 ends the process. Setup runs again for each Location and still leaves one listener.
 * `OWN_REMOTE_ALLOW_HEAP_SIGNAL=1` keeps upstream's snapshot for debugging.
 */
export function muteHeapSignal(platform = process.platform, env = process.env) {
  if (platform === "win32" || env.OWN_REMOTE_ALLOW_HEAP_SIGNAL === "1") return
  process.removeAllListeners("SIGUSR1")
  process.on("SIGUSR1", () => {})
}

let portable: typeof OwnRemote.Definition | undefined
function portableDefinition() {
  return (portable ??= Portable.definition(OwnRemote.Definition))
}

/** Runtime leadership group of the gateway's pin: never an own.remote or own.accounts leader. */
const GATEWAY_ROLE = "own.remote.gateway"

function samePath(a: string, b: string) {
  const normalize = (value: string) => value.replace(/[\\/]+$/, "").replaceAll("\\", "/").toLowerCase()
  return normalize(a) === normalize(b)
}
