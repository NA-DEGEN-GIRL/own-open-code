// OWN-PATCH(P-046) begin
// The shell hook's `create.before` names the session that starts a command (`metadata.sessionID`), so a plugin can
// apply that session's choices to the command's environment; a command no session starts has none.
import { expect } from "bun:test"
import { Effect, Layer, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { SessionSchema } from "@opencode/core/session/schema"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { it } from "./lib/effect"

/** A spawner whose every process exits 0 at once: nothing runs. */
const exited = Layer.effect(
  Environment.Service,
  Effect.gen(function* () {
    const host = yield* Environment.Service
    return Environment.Service.of({
      ...host,
      spawner: ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            pid: ProcessId(4242),
            exitCode: Effect.succeed(ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      ),
    })
  }),
).pipe(Layer.provide(hostEnvironmentLayer))

it.live("create.before names the session that starts the command, and no other, and the command's id", () =>
  Effect.gen(function* () {
    const sessionID = SessionSchema.ID.create()
    const seen: Array<string | undefined> = []
    const ids: Array<readonly [string | undefined, string]> = []
    yield* Effect.gen(function* () {
      const shell = yield* Shell.Service
      const record = (invocation: { readonly sessionID?: string; readonly id?: string }) =>
        Effect.sync(() => void seen.push(invocation.sessionID)).pipe(Effect.as(invocation.id))
      const create = (input: Parameters<typeof shell.create>[0]) =>
        Effect.gen(function* () {
          const named: Array<string | undefined> = []
          const info = yield* shell.create(input, (invocation) =>
            record(invocation).pipe(Effect.map((id) => void named.push(id))),
          )
          ids.push([named[0], info.id])
        })
      yield* create({ shell: "sh", command: "a", timeout: 0, metadata: { sessionID } })
      yield* create({ shell: "sh", command: "b", timeout: 0 })
      yield* create({ shell: "sh", command: "c", timeout: 0, metadata: { sessionID: "not a session" } })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(Shell.node, [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(exited),
        ]),
      ),
    )
    expect(seen).toEqual([sessionID, undefined, undefined])
    // The id the hooks see is the command's (what `shell.exited` names), so a plugin can end what it gave the command.
    for (const [named, id] of ids) expect(named).toBe(id)
  }),
)

it.live("shell.created names the spawned process's id", () =>
  Effect.gen(function* () {
    const created: Array<{ readonly id: string; readonly pid?: number }> = []
    const id = yield* Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* bus.listen((event) =>
        Effect.sync(() => {
          if (event.type !== "shell.created") return
          created.push((event.data as { readonly info: { readonly id: string; readonly pid?: number } }).info)
        }),
      )
      const shell = yield* Shell.Service
      return (yield* shell.create({ shell: "sh", command: "a", timeout: 0 })).id
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Shell.node, Bus.node]), [
          Location.node.replace(tempLocationLayer),
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          Environment.node.replace(exited),
        ]),
      ),
    )
    // A plugin ties the ticket it gave the command to this process (own-accounts, GH-48). Since v2.3.0 a local Windows
    // command runs through upstream's process daemon, which reports the real process's pid instead of the fake's.
    expect(created).toHaveLength(1)
    expect(created[0]?.id).toBe(id)
    expect(created[0]?.pid).toBe(process.platform === "win32" ? created[0]?.pid : 4242)
    expect(created[0]?.pid).toBeGreaterThan(0)
  }),
)
// OWN-PATCH(P-046) end
