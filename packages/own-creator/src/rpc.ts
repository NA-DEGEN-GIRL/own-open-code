export * as CreatorRpc from "./rpc.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Creator } from "@own/protocol/creator"
import { Portable } from "@own/protocol/portable"
import { OwnCreator } from "@own/protocol/rpc-creator"
import { Effect } from "effect"
import { Build } from "./build.js"
import { HarnessText } from "./harness.js"
import { CodePlugins } from "./plugins.js"
import { Remote } from "./remote.js"
import { Runtime } from "./runtime.js"
import { Servers } from "./servers.js"
import type { CreatorState } from "./state.js"
import type { CreatorStore } from "./store.js"
import { CreatorTools } from "./tools.js"
import { Views } from "./views.js"

/**
 * `own.creator` handlers for Settings > 확장 (17 §8). Every write is the user's (`by: "user"`); `loosen.set` is the only
 * way an allow rule turns on. Registered through `Portable.definition` (own-harness `rpc.ts`).
 */
export const register = (
  ctx: Pick<Context, "rpc" | "location">,
  state: CreatorState.State,
  reload: () => Effect.Effect<void>,
  stopped: () => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const store = state.store
    const list = () =>
      Effect.promise(async (): Promise<OwnCreator.List> => {
        const snapshot = await store.read()
        const crashes = await CodePlugins.crashes(store.root)
        const remote = Remote.hostViews(snapshot)
        return {
          extensions: Views.views(snapshot, crashes, remote.lines),
          format: Creator.FORMAT,
          root: store.root,
          stages: CreatorTools.stagesOf(snapshot),
          settings: { plugins: snapshot.file.settings?.plugins === true },
          stopped: Servers.stoppedIds(store.root),
          hosts: remote.hosts,
          buildId: Build.BUILD_ID,
          version: Build.PLUGIN_VERSION,
        }
      })
    const exists = (id: string) =>
      Effect.promise(() => store.read()).pipe(
        Effect.map((snapshot) => snapshot.file.extensions.some((entry) => entry.id === id)),
      )
    const settle = (outcome: CreatorStore.Outcome) =>
      Effect.gen(function* () {
        if (!outcome.ok) return outcome
        yield* HarnessText.sync(ctx, store, outcome.snapshot)
        yield* reload()
        return outcome
      })
    const rpc = yield* ctx.rpc
      .register(Portable.definition(OwnCreator.Definition), {
        list,
        "version.get": (input, context) =>
          Effect.gen(function* () {
            const found = yield* Effect.promise(() => store.version(input.id, input.version))
            if (!found.ok && found.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!found.ok)
              return yield* Effect.fail(
                context.error("version_not_found", "no such version", { id: input.id, version: input.version }),
              )
            return {
              id: input.id,
              n: input.version,
              ...(found.raw === undefined ? {} : { extension: found.raw }),
              problems: found.problems.map((problem) => ({ ...problem })),
              effects:
                found.extension === undefined ? [] : Creator.effects(found.extension).map((effect) => ({ ...effect })),
            }
          }),
        "enabled.set": (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(yield* Effect.promise(() => store.enable(input.id, input.enabled, "user")))
            if (!outcome.ok && outcome.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!outcome.ok && outcome.reason === "invalid")
              return yield* Effect.fail(
                context.error("invalid", "the extension cannot be turned on", { problems: [...outcome.problems] }),
              )
            return yield* list()
          }),
        rollback: (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(yield* Effect.promise(() => store.rollback(input.id, input.version, "user")))
            if (!outcome.ok && outcome.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!outcome.ok && outcome.reason === "version_not_found")
              return yield* Effect.fail(
                context.error("version_not_found", "no such version", { id: input.id, version: input.version }),
              )
            if (!outcome.ok && outcome.reason === "invalid")
              return yield* Effect.fail(
                context.error("invalid", "that version cannot apply", { problems: [...outcome.problems] }),
              )
            return yield* list()
          }),
        remove: (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(yield* Effect.promise(() => store.remove(input.id)))
            if (!outcome.ok)
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            return yield* list()
          }),
        "scope.set": (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(
              yield* Effect.promise(() =>
                store.scope(input.id, input.projects, "user", undefined, input.hostProjects),
              ),
            )
            if (!outcome.ok && outcome.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!outcome.ok && outcome.reason === "scope_invalid")
              return yield* Effect.fail(
                context.error("scope_invalid", "those folders cannot be used", { problems: [...outcome.problems] }),
              )
            return yield* list()
          }),
        "hosts.set": (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(yield* Effect.promise(() => store.hosts(input.id, input.hosts)))
            if (!outcome.ok) return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            return yield* list()
          }),
        "hostTrust.set": (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(
              yield* Effect.promise(() => store.hostTrust(input.id, input.host, input.version, input.trusted)),
            )
            if (!outcome.ok && outcome.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!outcome.ok && outcome.reason === "version_not_found")
              return yield* Effect.fail(
                context.error("version_not_found", "no such version", { id: input.id, version: input.version }),
              )
            if (!outcome.ok && outcome.reason === "invalid")
              return yield* Effect.fail(
                context.error("invalid", "that version cannot be allowed on a host", { problems: [...outcome.problems] }),
              )
            return yield* list()
          }),
        "loosen.set": (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(
              yield* Effect.promise(() => store.loosen(input.id, input.version, input.approved)),
            )
            if (!outcome.ok && outcome.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!outcome.ok)
              return yield* Effect.fail(
                context.error("version_not_found", "no such version", { id: input.id, version: input.version }),
              )
            return yield* list()
          }),
        "plugins.set": (input) =>
          Effect.gen(function* () {
            yield* settle(yield* Effect.promise(() => store.settings({ plugins: input.enabled })))
            return yield* list()
          }),
        "trust.set": (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* settle(
              yield* Effect.promise(() => store.trust(input.id, input.version, input.trusted)),
            )
            if (!outcome.ok && outcome.reason === "not_found")
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            if (!outcome.ok && outcome.reason === "version_not_found")
              return yield* Effect.fail(
                context.error("version_not_found", "no such version", { id: input.id, version: input.version }),
              )
            if (!outcome.ok && outcome.reason === "invalid")
              return yield* Effect.fail(
                context.error("invalid", "that version cannot be trusted", { problems: [...outcome.problems] }),
              )
            return yield* list()
          }),
        "mcp.stop": (input, context) =>
          Effect.gen(function* () {
            if (!(yield* exists(input.id)))
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            Servers.setStopped(store.root, input.id, true)
            yield* Effect.promise(() => Runtime.log(store.root, input.id, ["stopped by the user (멈추기)"]))
            yield* stopped()
            return yield* list()
          }),
        "mcp.start": (input, context) =>
          Effect.gen(function* () {
            if (!(yield* exists(input.id)))
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            Servers.setStopped(store.root, input.id, false)
            yield* Effect.promise(() => Runtime.log(store.root, input.id, ["started again by the user (다시 시작)"]))
            yield* stopped()
            return yield* list()
          }),
        "log.get": (input, context) =>
          Effect.gen(function* () {
            if (!(yield* exists(input.id)))
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            const lines = yield* Effect.promise(() => Runtime.readLog(store.root, input.id))
            return { id: input.id, lines }
          }),
        "crashes.clear": (input, context) =>
          Effect.gen(function* () {
            if (!(yield* exists(input.id)))
              return yield* Effect.fail(context.error("not_found", "no such extension", { id: input.id }))
            yield* Effect.promise(() => CodePlugins.clearCrashes(store.root, input.id))
            yield* Effect.promise(() => Runtime.log(store.root, input.id, ["crashes cleared by the user (다시 켜기)"]))
            yield* reload()
            return yield* list()
          }),
      })
      .pipe(Effect.orDie)
    return (changed: OwnCreator.Changed) => rpc.events.emit("changed", changed).pipe(Effect.ignore)
  })
