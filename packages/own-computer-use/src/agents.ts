export * as Agents from "./agents.js"

import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Exit, Scope, Semaphore, Stream } from "effect"
import { Gate } from "./gate.js"

/**
 * The agent-wide {computer, *, deny} (`Gate.DENY`), so every catalog leaves the tools out until a session allows them.
 * Core applies the config's (and markdown) agents in a builtin plugin that activates after every configured plugin
 * (`post`, `packages/core/src/plugin/internal.ts`), so a transform registered only in setup never sees them. Core runs
 * transforms in registration order, so this one is registered in setup and again after every `plugin.updated` of this
 * Location (published once its plugins activated), and the previous registration is dropped: it stays last until the
 * next activation (surface `builtin-plugin-placement`, `plugin-updated-after-activation`; the same pattern as
 * own-accounts' `presets/agents.ts`, 07 §5.4). One registration is live at a time, moves run one after another, and
 * the plugin's scope drops the last one on stop.
 */
export const register = (ctx: Pick<Context, "agent" | "event" | "location">) =>
  Effect.gen(function* () {
    const plugin = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    const current: { scope?: Scope.Closeable } = {}
    const move = lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = current.scope
        const next = yield* Scope.fork(plugin)
        yield* ctx.agent.transform(deny).pipe(Scope.provide(next))
        current.scope = next
        if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      }),
    )
    // Subscribed before the setup registration, so this Location's first `plugin.updated` cannot slip in between.
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "plugin.updated" && event.location?.directory === ctx.location.directory),
      Stream.runForEach(() => move),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* move
  })

function deny(editor: AgentEditor) {
  for (const agent of editor.list())
    editor.update(agent.id, (info) => {
      info.permissions.push({ ...Gate.DENY })
    })
}
