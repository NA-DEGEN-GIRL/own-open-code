// E2E entry of own-accounts for the slots/auth tests. It runs the setup of `src/index.ts` (same order, same shared
// modules, hooks and RPC) with two peers replaced until their owners land them:
//   - `logins.headers` = `runtime.credentials.headersFor` without a refresher, which is what the credentials module
//     wraps (API keys and linked codex sources need no refresher);
//   - `plugins.trustStatus` = "ok" (the test Location has no project plugins; the allowlist is the plugins module's).
// Everything else is the production code. Remove the overrides and load `packages/own-accounts` once both land.

import { Plugin } from "@opencode/plugin"
import { Home, Runtime, Vault } from "@own/runtime"
import { Build } from "../../../../src/build.js"
import { Clock } from "../../../../src/clock.js"
import type { Deps } from "../../../../src/deps.js"
import { Emitter } from "../../../../src/emitter.js"
import { Endpoints } from "../../../../src/endpoints.js"
import { Events } from "../../../../src/events.js"
import { Guard } from "../../../../src/health/guard.js"
import { Hooks } from "../../../../src/hooks.js"
import { Location } from "../../../../src/location.js"
import { Logger } from "../../../../src/logger.js"
import { Modules } from "../../../../src/modules.js"
import { Options } from "../../../../src/options.js"
import { Register } from "../../../../src/rpc/register.js"

const OVERRIDES: Partial<Modules.Factories> = {
  logins: (deps, peers) => ({
    ...Modules.FACTORIES.logins(deps, peers),
    headers: (account, sessionID) => deps.runtime.credentials.headersFor({ account, sessionID }),
  }),
  plugins: (deps, peers) => ({
    ...Modules.FACTORIES.plugins(deps, peers),
    trustStatus: () => "ok",
    trustSettled: async () => "ok",
  }),
}

export default Plugin.define({
  id: Build.PLUGIN_ID,
  setup: async (ctx) => {
    const options = Options.decode(ctx.options)
    const log = Logger.create({ level: options.logLevel, scope: Build.PLUGIN_ID })
    const guard = Guard.check({ appVersion: ctx.app.version, env: process.env })
    if (guard.guard !== "ok") throw new Error(`guard ${guard.guard}: ${guard.reason ?? ""}`)
    const layout = Home.layout(Home.resolve({ home: options.home }))
    const control = Location.same(ctx.location.directory, layout.control)
    const runtime = await Runtime.acquire({
      buildId: options.buildId ?? Build.BUILD_ID,
      home: options.home,
      vault: options.vault === "memory" ? { transport: Vault.memory() } : (options.vault ?? {}),
      preferLeader: control,
      secretCacheSeconds: options.secretCacheSeconds,
    })
    const emitter = new Emitter.Publisher({ isLeader: () => runtime.isLeader(), log: log.child("emitter") })
    const deps: Deps.Deps = {
      ctx,
      runtime,
      options,
      endpoints: Endpoints.resolve(options.endpoints),
      log,
      clock: Clock.system,
      emitter,
      places: new Events.Places(),
      location: { directory: ctx.location.directory, control },
    }
    const modules = Modules.create(deps, OVERRIDES)
    await Modules.start(modules, log)
    await Hooks.register(deps, modules)
    await Register.register(deps, modules)
    const stopEvents = Events.start(deps, modules)
    log.info("ready", { location: ctx.location.directory, fixture: "slots-auth" })
    return async () => {
      await stopEvents()
      await Modules.stop(modules, log)
      emitter.unbind()
      await runtime.release()
    }
  },
})
