export * as ClaudeStatus from "./status.js"

import { Effect, Semaphore, SubscriptionRef } from "effect"
import type { ClaudeIO } from "./io.js"
import { ClaudeProbe } from "./probe.js"
import { ClaudeQueryOptions } from "./query-options.js"

export type State =
  | { readonly type: "checking" }
  | { readonly type: "missing" }
  | { readonly type: "failed"; readonly message: string }
  | {
      readonly type: "ready"
      readonly probe: ClaudeProbe.Result
      readonly configDir?: string
      readonly fromChat?: boolean
    }

export interface Interface {
  readonly state: SubscriptionRef.SubscriptionRef<State>
  readonly refresh: () => Effect.Effect<void>
  // What a chat's own process found when it started
  readonly report: (next: State) => Effect.Effect<void>
}

export const make = Effect.fn("ClaudeStatus.make")(function* (
  io: ClaudeIO.Interface,
  connection: () => Effect.Effect<Record<string, string>>,
  configDirs: () => Effect.Effect<readonly string[]> = () => Effect.succeed([]),
  // OWN-PATCH(P-044) begin
  // The process pool's side start (CAG-38): the check's claude counts against the cap while it runs, never waiting.
  side: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E> = (effect) => effect,
  // OWN-PATCH(P-044) end
) {
  const state = yield* SubscriptionRef.make<State>({ type: "checking" })
  const lock = yield* Semaphore.make(1)

  // Serialized so a reconnect checks again after startup, rather than racing it with an older account snapshot.
  const refresh = Effect.fn("ClaudeStatus.refresh")(function* () {
    const executable = io.which()
    if (!executable) return yield* SubscriptionRef.set(state, { type: "missing" })
    const env = ClaudeQueryOptions.withoutDefaultFolder(yield* connection(), io)
    // OWN-PATCH(P-052) begin
    // own-accounts names the account folder in its provider fold, which a Location may set up after this check first
    // runs: until a folder is named the check waits instead of failing (the connection would read as logged out).
    if (io.requiresFolder && !env.CLAUDE_CONFIG_DIR && (yield* SubscriptionRef.get(state)).type === "checking") return
    // OWN-PATCH(P-052) end
    // OWN-PATCH(P-045) begin
    // Building the options fails without an account folder (own's route not set up); that is a failed check too.
    const next = yield* Effect.try({
      try: () => ClaudeQueryOptions.base({ executable, io, connection: env }),
      catch: (cause) => new ClaudeProbe.ProbeError({ cause }),
    }).pipe(
      // OWN-PATCH(P-044) begin
      // OWN-PATCH(P-051) begin
      Effect.flatMap((options) => side(ClaudeProbe.run(options, io.version))),
      // OWN-PATCH(P-051) end
      // OWN-PATCH(P-044) end
      // OWN-PATCH(P-045) end
      Effect.map((probe): State => ({ type: "ready", probe, configDir: env.CLAUDE_CONFIG_DIR })),
      Effect.catch((error) =>
        Effect.logWarning("Claude Code login check failed", { cause: error.cause }).pipe(
          Effect.as<State>({
            type: "failed",
            message: error.cause instanceof Error ? error.cause.message : String(error.cause),
          }),
        ),
      ),
    )
    yield* SubscriptionRef.set(state, next)
  }, lock.withPermit)

  // A model with its own configDir runs another account, which must not replace the provider's login, prices and models.
  // Every folder in the provider's list is its own, so those follow the folder a chat last started on.
  const report = Effect.fn("ClaudeStatus.report")(function* (next: State) {
    if (next.type === "ready") {
      const own = [yield* connection(), ...(yield* configDirs()).map((dir) => ({ CLAUDE_CONFIG_DIR: dir }))].map(
        (env) => ClaudeQueryOptions.withoutDefaultFolder(env, io).CLAUDE_CONFIG_DIR,
      )
      if (!own.some((dir) => dir === next.configDir)) return
    }
    yield* SubscriptionRef.set(state, next)
  })

  return { state, refresh, report } satisfies Interface
})
