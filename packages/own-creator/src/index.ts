import { watch } from "node:fs"
import fs from "node:fs/promises"
import { Plugin } from "@opencode/plugin/effect"
import { CreatorBridge, Home } from "@own/runtime"
import { Effect, Result, Semaphore } from "effect"
import { Authored } from "./authored.js"
import { Build } from "./build.js"
import { CommandTools } from "./command-tools.js"
import { Fragments } from "./fragments.js"
import { HarnessText } from "./harness.js"
import { CreatorHooks } from "./hooks.js"
import { Mirror } from "./mirror.js"
import { Options } from "./options.js"
import { CodePlugins } from "./plugins.js"
import { CreatorRpc } from "./rpc.js"
import { Remote } from "./remote.js"
import { Rules } from "./rules.js"
import { Runtime } from "./runtime.js"
import { Servers } from "./servers.js"
import { CreatorState } from "./state.js"
import { CreatorStore } from "./store.js"
import { CreatorTools } from "./tools.js"
import MODE from "./text/mode.md" with { type: "text" }

/**
 * own.creator (17): creator mode and own's extensions. The store is `OWN_HOME\creator` (store.ts); this plugin reads it
 * in every Location and applies the extensions in force there: prompt fragments as instruction entries (fragments.ts),
 * command tools (command-tools.ts), tool rules (rules.ts), retry and compaction additions (hooks.ts), agents, commands
 * and skills (authored.ts), generated MCP servers (servers.ts, C2) and code plugins' config entries and trust approvals
 * (plugins.ts, C3, off by default). Creator mode is the agent `creator` with its tools (tools.ts), which stage code
 * versions before they exist (staging.ts); Settings > 확장 talks to the `own.creator` RPC (rpc.ts). A change reloads only
 * the domains whose items changed, without a restart: writes in this process tell every instance at once, and a watch
 * on the store's folder catches the rest.
 *
 * On an SSH host (`mode: "remote"`, 17 §10) the store is a read-only mirror of the PC's, kept by {@link Mirror}
 * through the broker: the same files apply the same way (command tools on the host's shell with its approvals, C2
 * servers in the host's sandbox after the host's own staging, C3 only with that host's allowance), but there is no
 * creator mode and no Settings RPC there. On this PC the store is offered to the hosts read only ({@link Remote}).
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = Result.getOrUndefined(Options.decodeResult(ctx.options))
      if (
        options === undefined ||
        process.env[Build.ENV_MARKER] !== "1" ||
        ctx.app.version !== Build.EXPECTED_APP_VERSION
      ) {
        warn("guard_failed", { appVersion: ctx.app.version, options: options !== undefined })
        return
      }
      if (!options.enabled) return
      const remote = options.mode === "remote"
      const store = new CreatorStore.Store(Home.resolve({ home: options.home }), {
        app: Build.EXPECTED_APP_VERSION,
        mirror: remote,
      })
      yield* Effect.promise(() => fs.mkdir(store.root, { recursive: true }))
      yield* Effect.promise(() => Runtime.materialize(store.root))
      const untrack = CodePlugins.track(store.root, ctx.location.directory)
      yield* Effect.addFinalizer(() => Effect.sync(untrack))
      const state = new CreatorState.State(store, ctx.location.directory)
      state.set(yield* Effect.promise(() => store.read()))
      const lock = yield* Semaphore.make(1)
      const registered = { servers: Servers.fingerprint(state) }
      const emitter: { emit?: (changed: { ids: string[]; at: number }) => Effect.Effect<void> } = {}
      const sync = () =>
        Effect.promise(() =>
          CodePlugins.sync(store, state.snapshot, process.env.OPENCODE_CONFIG_DIR, { create: remote }),
        ).pipe(
          Effect.tap((result) =>
            result.reason === undefined ? Effect.void : Effect.sync(() => warn("plugins_sync", { reason: result.reason })),
          ),
          Effect.catchCause((cause) => Effect.sync(() => warn("plugins_sync_failed", { cause: String(cause) }))),
        )
      const reload = () =>
        lock
          .withPermits(1)(
            Effect.gen(function* () {
              const before = fingerprints(state)
              const ids = new Set(state.snapshot.file.extensions.map((entry) => `${entry.id}:${entry.updatedAt}`))
              state.set(yield* Effect.promise(() => store.read()))
              // Before the steps below, which may fail: a host must hear of a withdrawn allowance whatever happens here.
              offer?.invalidate()
              const after = fingerprints(state)
              if (after.tools !== before.tools) yield* ctx.tool.reload()
              if (after.agents !== before.agents) yield* ctx.agent.reload()
              if (after.skills !== before.skills) yield* ctx.skill.reload()
              if (after.commands !== before.commands) yield* ctx.command.reload()
              // Against what core last got: a stopped server changes nothing in the store.
              const servers = Servers.fingerprint(state)
              if (servers !== registered.servers) {
                registered.servers = servers
                yield* ctx.mcp.reload()
              }
              yield* sync()
              yield* Fragments.refresh(ctx, state, MODE)
              const changed = state.snapshot.file.extensions
                .filter((entry) => !ids.has(`${entry.id}:${entry.updatedAt}`))
                .map((entry) => entry.id)
              if (changed.length > 0 || ids.size !== state.snapshot.file.extensions.length)
                yield* emitter.emit?.({ ids: changed, at: Date.now() }) ?? Effect.void
            }),
          )
          .pipe(Effect.catchCause((cause) => Effect.sync(() => warn("reload_failed", { cause: String(cause) }))))
      // 17 §10: this PC offers its store to the hosts, read only; a host keeps a mirror of it.
      const offer = remote ? undefined : Remote.provide(store)
      if (offer !== undefined) yield* Effect.addFinalizer(() => Effect.sync(offer.close))
      yield* Authored.register(ctx, state, !remote)
      yield* CommandTools.register(ctx, state)
      yield* Rules.register(ctx, state)
      yield* CreatorHooks.register(ctx, state)
      yield* Fragments.register(ctx, state, MODE)
      yield* Servers.register(ctx, state, process.execPath, (id, n) =>
        Effect.promise(() => store.confirm(id, n)).pipe(Effect.asVoid),
      )
      // Before the code plugins in the config set up in this Location: their trust approvals exist.
      yield* sync()
      if (remote) {
        const detach = Mirror.attach(store, {
          bun: process.execPath,
          ...(process.env.OPENCODE_CONFIG_DIR === undefined ? {} : { configDir: process.env.OPENCODE_CONFIG_DIR }),
          applied: (snapshot) => Effect.runPromise(HarnessText.sync(ctx, store, snapshot).pipe(Effect.asVoid)),
          reload: () => Effect.runPromise(reload()),
        })
        yield* Effect.addFinalizer(() => Effect.sync(detach))
      }
      if (!remote) yield* CreatorTools.register(ctx, state, reload, {
        bun: process.execPath,
        ...(options.registry === undefined ? {} : { registry: options.registry }),
      })
      // A stopped or started server: every instance re-registers its servers, this one before the RPC answers.
      if (!remote) {
        emitter.emit = yield* CreatorRpc.register(ctx, state, reload, () =>
          Effect.sync(() => CreatorStore.poke(store.root)).pipe(Effect.andThen(reload())),
        )
        // A host's report changes only what Settings shows.
        const unreport = CreatorBridge.onReport(
          () => void Effect.runFork(emitter.emit?.({ ids: [], at: Date.now() }) ?? Effect.void),
        )
        yield* Effect.addFinalizer(() => Effect.sync(unreport))
      }
      // Writes in this process (any Location's instance, Settings) and changes from outside it (another process, a
      // hand edit): both end in one reload, which does nothing when nothing this Location applies changed.
      const unsubscribe = CreatorStore.onChange(store.root, () => void Effect.runFork(reload()))
      const timer: { current?: ReturnType<typeof setTimeout> } = {}
      // The whole folder: a version's files changed by hand read as tampered at once and stop applying.
      const watcher = watch(store.root, { recursive: true }, (_, name) => {
        const file = String(name ?? "").replaceAll("\\", "/")
        // A code plugin's crash: only Settings needs to hear of it.
        if (file.startsWith("run/")) return void Effect.runFork(emitter.emit?.({ ids: [], at: Date.now() }) ?? Effect.void)
        if (
          file === "" ||
          /^(?:trash|skills|stage|logs|runtime|temp|cache)\//.test(file) ||
          file.endsWith(".lock") ||
          file.includes(".tmp")
        )
          return
        clearTimeout(timer.current)
        timer.current = setTimeout(() => void Effect.runFork(reload()), 150)
      })
      watcher.on("error", () => undefined)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe()
          clearTimeout(timer.current)
          watcher.close()
        }),
      )
    }),
})

function fingerprints(state: CreatorState.State) {
  return {
    tools: state.fingerprint(["tool.command"]),
    agents: state.fingerprint(["agent"]),
    skills: state.fingerprint(["skill"]),
    commands: state.fingerprint(["command"]),
  }
}

function warn(message: string, fields: Readonly<Record<string, unknown>>) {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "warn", scope: Build.PLUGIN_ID, msg: message, ...fields })}\n`,
  )
}
