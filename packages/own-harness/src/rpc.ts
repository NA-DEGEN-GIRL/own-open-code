export * as HarnessRpc from "./rpc.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Portable } from "@own/protocol/portable"
import { Effect } from "effect"
import { Build } from "./build.js"
import { Custom } from "./custom.js"
import { Defaults } from "./defaults.js"
import { Fallback } from "./fallback.js"
import { Gate } from "./gate.js"
import { Prompts } from "./prompts.js"
import { Registry } from "./registry.js"
import { Sessions } from "./sessions.js"

/**
 * `own.harness` handlers. Registered through `Portable.definition`: the host would run this bundle's Effect schemas with
 * its own `effect` copy (see own-computer-use `src/rpc.ts`).
 */
export const register = (
  ctx: Pick<Context, "rpc" | "session" | "model" | "storage" | "tool" | "location" | "agent">,
  deps: {
    /** Options' `default` and `prompt`: what a new top-level session runs until Settings stores a choice. */
    readonly defaults: Defaults.Defaults
    readonly busy: (sessionID: string) => boolean
    /** Options' `compactionFallback`: the automatic choice of compaction stand-ins. */
    readonly compactionFallback: ReadonlyArray<string>
  },
) =>
  Effect.gen(function* () {
    // Bound once registration returns; no handler runs before that.
    let emit = (_: OwnHarness.Changed): Effect.Effect<void> => Effect.void
    // `omo` is offered only where own-omo runs (15 §2.2): its tools, gated by `own_harness_omo`, are registered here.
    const omoAvailable = Effect.suspend(() => ctx.tool.list()).pipe(
      Effect.map((tools) => tools.some((tool) => tool.options?.permission === Gate.OMO_ACTION)),
      Effect.orElseSucceed(() => false),
    )
    const unavailable = (harness: OwnHarness.HarnessID) =>
      harness === "omo" ? Effect.map(omoAvailable, (available) => !available) : Effect.succeed(false)
    const list = () =>
      Effect.all([Defaults.read(ctx, deps.defaults), Custom.saved(ctx), omoAvailable]).pipe(
        Effect.map(([defaults, custom, omo]) => ({
          harnesses: Registry.ALL.map((harness) => harness.id).filter((id) => id !== "omo" || omo),
          default: defaults.harness,
          prompts: [...OwnHarness.PROMPTS],
          defaultPrompt: defaults.prompt,
          custom,
          buildId: Build.BUILD_ID,
          version: Build.PLUGIN_VERSION,
        })),
      )
    const rpc = yield* ctx.rpc
      .register(Portable.definition(OwnHarness.Definition), {
        list,
        "defaults.set": (input, context) =>
          Effect.gen(function* () {
            if (yield* unavailable(input.harness))
              return yield* Effect.fail(
                context.error("harness_unavailable", "own-omo is not running here", { harness: input.harness }),
              )
            yield* Defaults.save(ctx, input, deps.defaults)
            return yield* list()
          }),
        "session.get": (input, context) =>
          Effect.flatMap(Sessions.get(ctx, input.sessionID), (binding) =>
            binding === undefined
              ? Effect.fail(context.error("session_not_found", "no such session", { sessionID: input.sessionID }))
              : Effect.succeed(binding),
          ),
        "session.set": (input, context) =>
          Effect.gen(function* () {
            if (yield* unavailable(input.harness))
              return yield* Effect.fail(
                context.error("harness_unavailable", "own-omo is not running here", { harness: input.harness }),
              )
            const result = yield* Sessions.set(
              ctx,
              input.sessionID,
              input.harness,
              input.prompt,
              deps.busy(input.sessionID),
            )
            if (result._tag === "not_found")
              return yield* Effect.fail(
                context.error("session_not_found", "no such session", { sessionID: input.sessionID }),
              )
            if (result._tag === "busy")
              return yield* Effect.fail(
                context.error("session_busy", "the session is running", { sessionID: input.sessionID }),
              )
            if (result.previous !== input.harness || input.prompt !== undefined)
              yield* emit({
                sessionID: input.sessionID,
                harness: input.harness,
                previous: result.previous,
                prompt: result.binding.prompt,
              })
            return result.binding
          }),
        "compaction.get": () => Fallback.view(ctx, deps.compactionFallback),
        "compaction.set": (input) =>
          Fallback.save(ctx, input.models).pipe(Effect.andThen(Fallback.view(ctx, deps.compactionFallback))),
        "prompt.preview": (input) => Prompts.preview(ctx, input),
        "prompt.subagent": () => Prompts.subagent(ctx),
        "prompt.custom.set": (input, context) =>
          Effect.gen(function* () {
            const problem = input.text === null ? undefined : Custom.problem(input.text)
            if (problem !== undefined)
              return yield* Effect.fail(
                context.error("prompt_invalid", "the 내 지시문 text cannot be saved", {
                  reason: problem,
                  limit: Custom.LIMIT,
                }),
              )
            yield* Custom.save(ctx, input.harness, input.text)
            return yield* list()
          }),
      })
      .pipe(Effect.orDie)
    emit = (changed) => rpc.events.emit("session.changed", changed).pipe(Effect.ignore)
  })
