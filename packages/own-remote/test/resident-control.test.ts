// The control Location end to end in one process: core's real Location graph boots own-remote (local mode,
// `lingerSeconds: 0`) in OWN_HOME\control and in a project, and core's real LocationActivity sweep runs on a clock moved
// past its hour. The idle project goes; the control Location, own-remote's instance in it and the process-lifetime SSH
// controller (04 §4.1) stay: own-runtime writes the control Location's config with
// `experimental.location_idle_timeout: false` (upstream v2.1; core patch P-037 until the v2.2.1 sync). Without it the
// sweep evicts the control Location as well, and with `lingerSeconds: 0` the controller closes with its last instance
// (real-host RH-8: the tunnels and the broker went).
import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Clock, Duration, Effect, Layer, RcMap } from "effect"
import { Runtime } from "@own/runtime"
import { Bus } from "../../core/src/bus"
import { Database } from "../../core/src/database/database"
import { Job } from "../../core/src/job"
import { AppNodeBuilder } from "../../core/src/effect/app-node-builder"
import { Location } from "../../core/src/location"
import { LocationActivity } from "../../core/src/location-activity"
import { LocationServiceMap } from "../../core/src/location-services"
import { Plugin } from "../../core/src/plugin"
import { AbsolutePath } from "../../core/src/schema"
import { SessionExecution } from "../../core/src/session/execution"
import { SessionStore } from "../../core/src/session/store"
import { offlineModels } from "../../core/test/fixture/models"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { makeGlobalNode } from "../../util/src/effect/app-node"
import { LayerNode } from "../../util/src/effect/layer-node"
import { Global } from "../../util/src/global"
import { Build } from "../src/build.js"
import { Singleton } from "../src/singleton.js"

const REMOTE = path.resolve(import.meta.dir, "..")

// LocationActivity measures idleness on this clock (core browser-idle.test.ts): its sweep sleeps in real time, the
// test moves only the time it compares against.
const idle = { millis: 0 }
const live = Clock.Clock.defaultValue()
const activityClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe() + idle.millis,
  currentTimeMillis: Effect.sync(() => live.currentTimeMillisUnsafe() + idle.millis),
  currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe() + BigInt(idle.millis) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => live.currentTimeNanosUnsafe() + BigInt(idle.millis) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: live.monotonicTimeNanos,
  sleep: (duration) => live.sleep(duration),
}

const it = testEffect(Layer.empty)

it.live(
  "core's hourly sweep keeps OWN_HOME/control and the SSH controller and evicts an idle project",
  () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped("own-remote-resident-")).path
      const ownHome = path.join(root, "own-home")
      const projectDir = path.join(root, "project")
      const buildId = `resident-${process.pid}-${Date.now()}`
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(ownHome, "control"), { recursive: true })
        await fs.mkdir(projectDir, { recursive: true })
        await fs.mkdir(path.join(root, "dot-ssh"), { recursive: true })
        await fs.mkdir(path.join(root, "config"), { recursive: true })
        // The service's global config, as the launcher writes it: own-remote in every Location of the process.
        await Bun.write(
          path.join(root, "config", "opencode.json"),
          JSON.stringify({
            update: "disable",
            share: "disabled",
            plugins: [
              {
                package: REMOTE,
                options: {
                  home: ownHome,
                  buildId,
                  version: "2.0.18-own.9",
                  sshDir: path.join(root, "dot-ssh"),
                  sshCommand: ["C:\\definitely\\not\\ssh.exe"],
                  lingerSeconds: 0,
                },
              },
            ],
          }),
        )
      })
      // Guard 1 (04 §16.1): own-remote runs only in a managed service.
      const marker = process.env[Build.ENV_MARKER]
      yield* Effect.acquireRelease(
        Effect.sync(() => (process.env[Build.ENV_MARKER] = "1")),
        () =>
          Effect.sync(() => {
            if (marker === undefined) delete process.env[Build.ENV_MARKER]
            else process.env[Build.ENV_MARKER] = marker
          }),
      )
      const data = path.join(root, "data")
      const cache = path.join(root, "cache")
      const layer = AppNodeBuilder.build(
        LayerNode.group([Database.node, Bus.node, LocationServiceMap.node, LocationActivity.node]),
        [
          Global.node.replace(
            Global.layerWith({
              data,
              cache,
              config: path.join(root, "config"),
              state: path.join(root, "state"),
              tmp: path.join(root, "tmp"),
              bin: path.join(cache, "bin"),
              log: path.join(data, "log"),
              repos: path.join(data, "repos"),
            }),
          ),
          offlineModels,
          LocationActivity.node.replace(
            makeGlobalNode({
              service: LocationActivity.Service,
              layer: LocationActivity.layer({ sweepInterval: "100 millis" }).pipe(
                Layer.provide(Layer.succeed(Clock.Clock, activityClock)),
              ),
              deps: [Bus.node, Job.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
            }),
          ),
        ],
      )

      yield* Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        // Clients spell the control directory their own way (here with forward slashes); core keys what they send.
        const control = Location.Ref.make({
          directory: AbsolutePath.make(path.join(ownHome, "control").replaceAll("\\", "/")),
        })
        const project = Location.Ref.make({ directory: AbsolutePath.make(projectDir) })
        for (const ref of [control, project]) {
          const context = yield* locations.contextEffect(ref).pipe(Effect.scoped)
          yield* Plugin.awaitActivation.pipe(Effect.provideContext(context))
        }
        const instances = () => Runtime.peek(buildId)?.roles[Build.PLUGIN_ID] ?? 0
        const controller = () => (globalThis as Record<symbol, unknown>)[Singleton.key(buildId)]
        const cached = (ref: Location.Ref) => RcMap.has(locations.rcMap, LocationServiceMap.canonical(ref))
        expect(instances()).toBe(2)
        expect(controller()).toBeDefined()

        // Neither Location has a session event: past the hour the next sweep (100 ms) evicts every one not resident.
        idle.millis += Duration.toMillis(Duration.minutes(61))
        yield* settle(() => cached(project).pipe(Effect.map((present) => !present && instances() < 2)))
        expect(yield* cached(control)).toBe(true)
        expect(instances()).toBe(1)
        expect(controller()).toBeDefined()

        // Hours later, many sweeps on: still there.
        idle.millis += Duration.toMillis(Duration.hours(3))
        yield* Effect.sleep("1 second")
        expect(yield* cached(control)).toBe(true)
        expect(instances()).toBe(1)
        expect(controller()).toBeDefined()
      }).pipe(Effect.provide(layer))
    }),
  120_000,
)

/** Polls in real time: eviction and plugin cleanup run on the sweep's own fiber. */
function settle(done: () => Effect.Effect<boolean>, attempts = 200): Effect.Effect<void, string> {
  return done().pipe(
    Effect.flatMap((ok) => {
      if (ok) return Effect.void
      if (attempts === 0) return Effect.fail("the sweep did not evict the idle project")
      return Effect.sleep("50 millis").pipe(Effect.andThen(settle(done, attempts - 1)))
    }),
  )
}
