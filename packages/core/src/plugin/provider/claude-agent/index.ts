import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Option, Stream, SubscriptionRef } from "effect"
import { ClaudeAccounts } from "./claude/accounts.js"
import { ClaudeIO } from "./claude/io.js"
// OWN-PATCH(P-039) begin
import { ClaudeObserver } from "./claude/observer.js"
// OWN-PATCH(P-039) end
// OWN-PATCH(P-052) begin
import { ClaudeRelay } from "./claude/relay.js"
// OWN-PATCH(P-052) end
import { ClaudeSessions } from "./claude/sessions.js"
import { ClaudeStatus } from "./claude/status.js"
import { ClaudeAISDK } from "./aisdk.js"
import { ClaudeInstructions } from "./instructions.js"
import { ClaudeIntegration } from "./integration.js"
import { ClaudeProvider } from "./provider.js"
import { ClaudeSessionHooks } from "./session.js"
import { ClaudeWebSearchProvider } from "./websearch.js"
import { Environment } from "../../../environment/index.js"
import { EnvironmentUnavailable } from "../../../environment/unavailable.js"
import { Location } from "../../../location.js"
import type { PluginInternal } from "../../internal.js"

export const ID = "opencode.provider.claude-agent"

// Tests pass a fake ClaudeIO here. The registry lives outside setup's scope, so a reload can adopt its processes.
// Restart tests pass their own and close it, as an exiting opencode would.
export const make = (io: ClaudeIO.Interface, registry = ClaudeSessions.registry()) =>
  define({
    id: ID,
    effect: Effect.fn("ClaudeAgent.Plugin")(function* (ctx) {
      // Claude Agent runs the local `claude` binary, so skip it where opencode cannot start local processes.
      const environment = yield* Effect.serviceOption(Environment.Service)
      const location = yield* Effect.serviceOption(Location.Service)
      const remote = Option.isSome(environment)
        ? !environment.value.hostsServer || environment.value.spawner === EnvironmentUnavailable.spawner
        : Option.isSome(location) && location.value.workspaceID !== undefined
      if (remote) return

      // OWN-PATCH(P-044) begin
      const status = yield* ClaudeStatus.make(
        io,
        () => ClaudeProvider.connection(ctx),
        () => ClaudeProvider.configDirs(ctx),
        registry.side,
      )
      // OWN-PATCH(P-044) end
      const sessions = yield* registry.attach({ io, status, storage: ctx.storage, directory: ctx.location.directory })
      // OWN-PATCH(P-039) begin
      const context = yield* Effect.context<never>()
      const usage = (configDir: string) =>
        Effect.runPromiseWith(context)(
          ClaudeProvider.connection(ctx).pipe(
            Effect.flatMap((connection) => sessions.usage({ ...connection, CLAUDE_CONFIG_DIR: configDir })),
          ),
        )
      // OWN-PATCH(P-044) begin
      // OWN-PATCH(P-052) begin
      // SSH hosts' claude processes run here through own's broker (02 §8.10.13), with this provider's connection.
      const hosts = ClaudeRelay.server({
        io,
        connection: () => Effect.runPromiseWith(context)(ClaudeProvider.connection(ctx)),
        slot: registry.host,
      })
      const unserve = ClaudeObserver.serve(
        usage,
        (configDir, close) => Effect.runPromise(registry.busy(configDir, close)),
        hosts,
      )
      // OWN-PATCH(P-052) end
      // OWN-PATCH(P-044) end
      yield* Effect.addFinalizer(() => Effect.sync(unserve))
      // OWN-PATCH(P-039) end
      // OWN-PATCH(P-043) begin
      // A while after start, the account folder's transcripts that no record points to go (once per folder).
      yield* Effect.sleep("1 minute").pipe(
        Effect.andThen(ClaudeProvider.connection(ctx)),
        Effect.flatMap((connection) =>
          connection.CLAUDE_CONFIG_DIR ? sessions.sweep(connection.CLAUDE_CONFIG_DIR) : Effect.void,
        ),
        Effect.forkScoped,
      )
      // OWN-PATCH(P-043) end
      yield* ctx.event
        .subscribe({
          types: [
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.deleted",
          ],
        })
        .pipe(
          Stream.runForEach((event) => {
            if (event.type !== "session.deleted") return sessions.idle(event.data.sessionID)
            return Effect.andThen(
              sessions.remove(event.data.sessionID),
              ctx.storage.remove(ClaudeAccounts.key(event.data.sessionID)),
            )
          }),
          Effect.forkScoped({ startImmediately: true }),
        )
      // OWN-PATCH(P-052) begin
      // own-accounts names the account folder in its provider fold. Plugins load in the background since upstream
      // v2.4.0 (#63814), so that fold can land after this plugin's first check, which then waits for a folder (status.ts)
      // and nothing else would start it again: models were never listed. A provider update that names the folder of a
      // connected account re-runs a check still waiting for one.
      if (io.requiresFolder)
        yield* ctx.event.subscribe({ types: ["provider.updated"] }).pipe(
          Stream.runForEach(() =>
            Effect.gen(function* () {
              if ((yield* SubscriptionRef.get(status.state)).type !== "checking") return
              if (!(yield* ClaudeProvider.connection(ctx)).CLAUDE_CONFIG_DIR) return
              if (!(yield* ctx.integration.connection.active(ClaudeProvider.ID))) return
              yield* status.refresh()
            }),
          ),
          Effect.forkScoped({ startImmediately: true }),
        )
      // OWN-PATCH(P-052) end
      yield* ClaudeProvider.register(ctx, status, io)
      yield* ClaudeIntegration.register(ctx, status)
      yield* ClaudeAISDK.register(ctx, sessions)
      yield* ClaudeSessionHooks.register(ctx)
      yield* ClaudeInstructions.register(ctx)
      yield* ClaudeWebSearchProvider.register(ctx, io)
    }),
  } satisfies PluginInternal.InternalPlugin)

export const ClaudeAgentPlugin = make(ClaudeIO.real)
