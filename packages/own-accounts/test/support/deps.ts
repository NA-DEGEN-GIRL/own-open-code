// Unit-test support shared by every module agent: a real runtime on a temp OWN_HOME with the in-memory vault, a
// manual clock, a silent (or captured) logger and a plugin context built from the parts a test provides. Every
// credential used with it must be fake.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Runtime, Vault } from "@own/runtime"
import { Build } from "../../src/build.js"
import { Clock } from "../../src/clock.js"
import type { Deps } from "../../src/deps.js"
import { Emitter } from "../../src/emitter.js"
import { Endpoints } from "../../src/endpoints.js"
import { Events } from "../../src/events.js"
import { Logger } from "../../src/logger.js"
import { Modules } from "../../src/modules.js"
import type { Options } from "../../src/options.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { removeTree } from "../e2e-kit/harness/remove.js"

let builds = 0

export interface TestDepsInput {
  /**
   * The context parts the code under test uses, e.g. `{ storage, session: { switchModel } }`. Anything else throws
   * when touched, so a test fails loudly instead of silently using a default.
   */
  readonly ctx?: Readonly<Record<string, unknown>>
  readonly options?: Options.Info
  readonly directory?: string
  readonly control?: boolean
  readonly leader?: boolean
  /** Receives log lines instead of dropping them. */
  readonly logs?: string[]
  /**
   * Writes log lines into this file the way the service writes `OWN_HOMElogsown-accounts.log` (its scope
   * `own.accounts`, level info), e.g. to read back what a module logged.
   */
  readonly logFile?: string
  /** Replaces the in-memory vault transport, e.g. to record requests. */
  readonly vault?: Vault.Transport
  /** `Deps.configDir` (`OPENCODE_CONFIG_DIR` at setup); absent by default. */
  readonly configDir?: string
  /** `Deps.remote`: a remote service's process-wide part (a fake of the members the code under test reads). */
  readonly remote?: RemoteHost.Api
}

export async function testDeps(input: TestDepsInput = {}) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "own-accounts-test-")))
  const clock = Clock.manual()
  const runtime = await Runtime.acquire({
    buildId: `test-accounts-${process.pid}-${++builds}`,
    home,
    vault: { transport: input.vault ?? Vault.memory({ now: clock.now }) },
    now: clock.now,
  })
  const logs = input.logs
  const log =
    input.logFile !== undefined
      ? Logger.create({ scope: Build.PLUGIN_ID, level: "info", sink: (line) => logs?.push(line), file: input.logFile })
      : logs
        ? Logger.create({ scope: "test", level: "debug", sink: (line) => logs.push(line) })
        : Logger.silent
  const emitter = new Emitter.Publisher({ isLeader: () => input.leader ?? true, log })
  const deps: Deps.Deps = {
    ctx: strictContext(input.ctx ?? {}),
    runtime,
    // A Codex home that does not exist: no test ever reads this PC's `.codex` (07 §2.2 reads it for the ChatGPT
    // group).
    options: {
      home,
      codexHome: path.join(home, "codex-home"),
      claudeHome: path.join(home, "claude-home"),
      ...input.options,
    },
    // The leader's `wham/usage` poll (telemetry/poller.ts) runs on a clock advance for any codex account with a stored
    // login: without an override it goes to a closed local port, never to chatgpt.com.
    endpoints: Endpoints.resolve({ chatgpt: "http://127.0.0.1:9/backend-api", ...input.options?.endpoints }),
    log,
    clock,
    emitter,
    places: new Events.Places(),
    configDir: input.configDir,
    ...(input.remote ? { remote: input.remote } : {}),
    location: { directory: input.directory ?? home, control: input.control ?? false },
  }
  return {
    deps,
    clock,
    home,
    /** Creates every module (with optional fake factories) without starting them. */
    modules: (overrides: Partial<Modules.Factories> = {}) => Modules.create(deps, overrides),
    async [Symbol.asyncDispose]() {
      await runtime.release()
      // Windows can hold a file just written (the indexer, Defender) for a moment under a full run's load; the e2e
      // harness waits as long (e2e-kit/harness/opencode-server.ts).
      await removeTree(home)
    },
  }
}

function strictContext(parts: Readonly<Record<string, unknown>>): Plugin.Context {
  const context = new Proxy(parts, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then") return undefined
      if (key in target) return target[key]
      throw new Error(`test context: ctx.${key} was not provided`)
    },
  })
  // SAFETY: tests provide only the context members the code under test uses; any other access throws above.
  return context as unknown as Plugin.Context
}
