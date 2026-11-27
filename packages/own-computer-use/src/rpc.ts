export * as ComputerRpc from "./rpc.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Rpc } from "@opencode/schema/rpc"
import { SessionID } from "@opencode/schema/session-id"
import { Portable } from "@own/protocol/portable"
import { OwnComputer } from "@own/protocol/rpc-computer"
import { Effect, Stream } from "effect"
import { Audit } from "./core/audit.js"
import { Policy } from "./core/policy.js"
import { Desktop } from "./singleton.js"

export interface Build {
  readonly buildId: string
  readonly version: string
}

/**
 * `own.computer` handlers over the shared desktop, plus this instance's republishing of desktop notices as `status`
 * and `action` events (every Location instance serves its own clients). The definition is registered through
 * `Portable.definition`: the host would run this bundle's Effect schemas with its own `effect` copy, which fails every
 * check (`Schema.Int` refuses 1).
 */
export const register = (ctx: Pick<Context, "rpc">, desktop: Desktop.Desktop, build: Build) =>
  Effect.gen(function* () {
    const view = (sessionID: SessionID) => ({ sessionID, apps: desktop.grants.get(sessionID) ?? [] })
    const grant = (sessionID: SessionID, apps: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const unique = [...new Set(apps.map(Policy.appName).filter((app) => app !== ""))]
        if (unique.length === 0) desktop.grants.delete(sessionID)
        if (unique.length > 0) desktop.grants.set(sessionID, unique)
        yield* desktop.notify({ _tag: "status" })
        return view(sessionID)
      })
    const killSwitch = Effect.map(desktop.killSwitch.state, Desktop.killSwitchView)
    const rpc = yield* ctx.rpc
      .register(Portable.definition(OwnComputer.Definition), {
        status: () => Desktop.status(desktop, build),
        "killswitch.engage": () => desktop.engage("rpc").pipe(Effect.andThen(killSwitch)),
        "killswitch.reset": () => desktop.reset.pipe(Effect.andThen(killSwitch)),
        "session.grants.get": (input) => Effect.succeed(view(input.sessionID)),
        "session.grants.set": (input) => grant(input.sessionID, input.apps),
        "session.grants.revoke": (input) => {
          const revoked = input.apps?.map(Policy.appName)
          const kept = (desktop.grants.get(input.sessionID) ?? []).filter(
            (app) => revoked !== undefined && !revoked.includes(app),
          )
          return grant(input.sessionID, kept)
        },
        "audit.list": (input) =>
          Effect.map(
            Audit.list(desktop.auditDir, {
              sessionID: input.sessionID,
              limit: input.limit ?? 50,
              before: input.before,
            }),
            (entries) => ({ entries }),
          ),
        "helper.restart": () => desktop.restart.pipe(Effect.map(() => desktop.helper())),
      })
      .pipe(Effect.orDie)
    yield* Stream.fromPubSub(desktop.notices).pipe(
      Stream.runForEach((notice) =>
        (notice._tag === "status"
          ? Effect.flatMap(Desktop.status(desktop, build), (status) => rpc.events.emit("status", status))
          : rpc.events.emit("action", notice.action)
        ).pipe(Effect.ignore),
      ),
      // Subscribed before this returns, so no notice published right after registration is lost.
      Effect.forkScoped({ startImmediately: true }),
    )
  })

const StatusOnly = Rpc.define({
  id: OwnComputer.ID,
  methods: { status: OwnComputer.Definition.methods.status },
  events: {},
})

/** When the guard fails only `status` is served, saying why computer use is unavailable. */
export const registerUnavailable = (ctx: Pick<Context, "rpc">, status: OwnComputer.Status) =>
  ctx.rpc
    .register(Portable.definition(StatusOnly), { status: () => Effect.succeed(status) })
    .pipe(Effect.orDie, Effect.asVoid)
