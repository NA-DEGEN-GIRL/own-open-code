export * as SshRunner from "./runner.js"

import { NodeServices } from "@effect/platform-node"
import { Effect, Exit, ManagedRuntime, Scope } from "effect"
import { createAskpass, type AskpassPrompt } from "../vendor/ssh/askpass.js"
import { minimalEnv, runSsh, SshFailure, sshArgs, type Target } from "../vendor/ssh/command.js"

/**
 * Promise facade over the vendored Effect modules (04 §4.1): one process-lifetime `ManagedRuntime` with
 * `NodeServices` (child processes, sockets, files). Nothing here runs in a Location scope, so closing a Location never
 * kills an ssh child or an askpass server.
 */
export class Runner {
  readonly #runtime = ManagedRuntime.make(NodeServices.layer)
  readonly command: readonly string[] | undefined

  constructor(input: { readonly command?: readonly string[] } = {}) {
    this.command = input.command
  }

  /** A short ssh command (inspect, install, ops, `-G`). Never throws; failures come back classified. */
  async run(input: {
    readonly args: string[]
    readonly env?: Record<string, string>
    readonly stdin?: string | Uint8Array
    readonly timeout?: number
  }): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly failure: SshFailure }> {
    const exit = await this.#runtime.runPromiseExit(
      runSsh({
        args: input.args,
        env: { ...minimalEnv(), ...input.env },
        ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        ...(this.command ? { command: this.command } : {}),
      }),
    )
    if (Exit.isSuccess(exit)) return { ok: true, stdout: exit.value }
    const squashed = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    const error = squashed && "error" in squashed ? squashed.error : undefined
    return { ok: false, failure: SshFailure.from(error ?? new Error("ssh interrupted")) }
  }

  /** `ssh -G <host>` (04 §7.5): resolved config, no connection. */
  resolved(target: Target, env?: Record<string, string>) {
    return this.run({ args: [...sshArgs(target), "-G", target.host], ...(env ? { env } : {}), timeout: 10_000 })
  }

  /** An askpass bridge for one attempt. `close()` ends it and cancels pending helpers. */
  async askpass(input: {
    readonly binary: string
    readonly prompt: (prompt: AskpassPrompt) => void
    readonly clear: (id: string) => void
  }) {
    const scope = await this.#runtime.runPromise(Scope.make())
    const bridge = await this.#runtime.runPromise(
      createAskpass({
        binary: input.binary,
        prompt: (prompt) => Effect.sync(() => input.prompt(prompt)),
        clear: (id) => Effect.sync(() => input.clear(id)),
      }).pipe(Scope.provide(scope)),
    )
    return {
      env: bridge.env,
      respond: (id: string, value: string | null) => this.#runtime.runPromise(bridge.respond(id, value)),
      close: () => this.#runtime.runPromise(Scope.close(scope, Exit.void)),
    }
  }

  dispose() {
    return this.#runtime.dispose()
  }
}

export type Askpass = Awaited<ReturnType<Runner["askpass"]>>
