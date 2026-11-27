export * as Skills from "./skills.js"

import type { SkillEditor } from "@opencode/plugin/effect/skill"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Exit, Scope, Semaphore, Stream } from "effect"

/**
 * The Claude desktop app syncs Anthropic's own skills into `~/.claude/skills/synced/<org>_<id>/<skill>/SKILL.md`
 * (built-in-browser, chrome-browser, computer-use, docs, docx, google-workspace, …). Core reads `~/.claude/skills` as a
 * compatibility root (`core/src/config/plugin/compatibility.ts`), so every own session listed them: about 12k
 * characters per request in every harness, all about tools that exist only in the Claude app (`mcp__Claude_Browser__*`,
 * `ToolSearch`, the docs connector). They are left out; the user's own skills in `~/.claude/skills` stay.
 */
const SYNCED = /[\\/]\.claude[\\/]skills[\\/]synced[\\/]/i

export function synced(path: string) {
  return SYNCED.test(path)
}

/**
 * Removes them in a skill transform registered again after every `plugin.updated` of this Location, so it runs after
 * the config plugins core applies after the configured ones (the compatibility root among them; Gate's pattern).
 */
export const register = (ctx: Pick<Context, "skill" | "event" | "location">) =>
  Effect.gen(function* () {
    const plugin = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    const current: { scope?: Scope.Closeable } = {}
    const move = lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = current.scope
        const next = yield* Scope.fork(plugin)
        yield* ctx.skill.transform(drop).pipe(Scope.provide(next))
        current.scope = next
        if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      }),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "plugin.updated" && event.location?.directory === ctx.location.directory),
      Stream.runForEach(() => move),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* move
  })

function drop(editor: SkillEditor) {
  editor
    .list()
    .filter((skill) => synced(skill.path))
    .forEach((skill) => editor.remove(skill.id))
}
