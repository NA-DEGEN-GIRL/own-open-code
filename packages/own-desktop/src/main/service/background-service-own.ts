// BackgroundService(own) (05 §5.3): replaces upstream's layer, which calls `Service.ensure` without a registration
// file and so targets upstream's `service.json`, stopping a user's upstream service of another version (G-D1). Same
// order for the initial connection and every reconnect:
//   1. discover the launcher's registration (`service-own.json`, `service-local.json` in dev; paths from the env
//      snapshot) — adopt it when healthy, never ensure, never pass a version;
//   2. dev channel: never start anything, wait for the development service;
//   3. otherwise run `own.ps1 start` once (launcher.ts, one launcher run at a time; a reconnect first waits up to
//      5 s for a restart under way) and discover again (10 s, 250 ms); nothing starts while 완전 종료 holds starts
//      (launcher.ts holdStarts, 05 §7.3);
//   4. publish {url, password} to SidecarCredentials: main injects Basic, the renderer only learns the url.
// The password is re-read on every reconnect because a restarted service may keep the port and change it.
import { Effect, Layer } from "effect"
import { BackgroundService } from "@opencode/desktop/src/main/service/background-service"
import { BackgroundServiceMachine } from "@opencode/desktop/src/main/service/background-service-machine"
import { SidecarCredentials } from "@opencode/desktop/src/main/service/sidecar-credentials"
import { clientOnly } from "../client-only"
import { readManifest } from "../manifest"
import { ownPaths } from "../own-env"
import { discoverService, waitForService, type DiscoveredService } from "./discover"
import { exclusive, launcherCommand, runLauncher, START_TIMEOUT_MS, startsHeld } from "./launcher"

export * as BackgroundServiceOwn from "./background-service-own"

/** Dev channel (05 §5.1): how long the shell waits for a development service before failing, and how often it looks. */
const DEV_WAIT = { timeoutMs: 120_000, intervalMs: 3_000 }
/** After the launcher returned (05 §5.3 step 6). */
const AFTER_LAUNCHER = { timeoutMs: 10_000, intervalMs: 250 }
/** A single look (inside the launcher queue, after any restart this shell was running). */
const ONCE = { timeoutMs: 0, intervalMs: 0 }
/** Reconnect: an outside restart may be under way; look for this long before starting the service ourselves. */
const RECONNECT_GRACE = { timeoutMs: 5_000, intervalMs: 250 }

/** Why the shell has no service; own-web shows it after its own `서비스를 시작하지 못했어요.` (03 §8). */
export class OwnServiceError extends Error {
  override readonly name = "OwnServiceError"
}

export const layer = Layer.effect(
  BackgroundService.Service,
  Effect.gen(function* () {
    return BackgroundService.Service.of(
      // Upstream's connection machine (v2.2.6) with own's connect for both modes: no entry-module probe to adopt (own's
      // main never runs upstream's sidecar probe), and the credentials are published where `connect` found them.
      yield* BackgroundServiceMachine.make({
        probe: Effect.succeed(undefined),
        ensure: connect,
        publish: SidecarCredentials.set,
      }),
    )
  }),
)

const connect = Effect.fn("BackgroundServiceOwn.connect")(function* (mode: "initial" | "reconnect") {
  // 원격 PC 전용 build: no service on this PC, so nothing is discovered or started. Only upstream's renderer asks for
  // the connection, and this build's page (src/client) never does; the initial attempt just records why.
  if (clientOnly) return yield* Effect.fail(new OwnServiceError("원격 PC 전용 빌드라 이 PC의 서비스를 쓰지 않아요"))
  const paths = ownPaths()
  yield* Effect.logInfo("own: discovering service", { mode, channel: paths.channel, registration: paths.registration })
  let service: DiscoveredService | undefined = yield* Effect.promise(() => discoverService(paths.registration))
  if (!service && paths.channel === "local") {
    yield* Effect.logWarning("own: no development service registered yet; waiting", { registration: paths.registration })
    service = yield* Effect.promise(() => waitForService(paths.registration, DEV_WAIT))
    if (!service)
      return yield* Effect.fail(
        new OwnServiceError(`개발 서비스가 없어요. 개발 서비스를 먼저 띄우세요(${paths.registration})`),
      )
  }
  if (!service) {
    // One launcher run at a time in this shell (launcher.ts `exclusive`): a reconnect while own:service.restart is
    // bringing the service back waits for that run and adopts its service. A reconnect also gives a restart from
    // outside (`own restart` in a terminal) a moment before starting anything itself.
    const log = Effect.runForkWith(yield* Effect.context())
    const started = yield* Effect.promise(() =>
      exclusive(async () => {
        const again = await waitForService(paths.registration, mode === "reconnect" ? RECONNECT_GRACE : ONCE)
        if (again) return { kind: "found" as const, service: again }
        // 완전 종료 (05 §7.3) stopped it on purpose and the shell is on its way out.
        if (startsHeld()) return { kind: "held" as const }
        const command = launcherCommand(paths, "start")
        log(Effect.logInfo("own: starting the service through the launcher", { file: command.file, args: command.args }))
        const result = await runLauncher(command, { timeoutMs: START_TIMEOUT_MS })
        log(Effect.logInfo("own: launcher finished", { code: result.code, timedOut: result.timedOut }))
        if (result.code !== 0 || result.timedOut) return { kind: "failed" as const, result }
        return { kind: "found" as const, service: await waitForService(paths.registration, AFTER_LAUNCHER) }
      }),
    )
    if (started.kind === "held") return yield* Effect.fail(new OwnServiceError("앱을 끄는 중이에요"))
    if (started.kind === "failed") {
      const result = started.result
      const reason = result.timedOut
        ? "런처가 시간 안에 끝나지 않았어요"
        : `런처가 오류로 끝났어요(종료 코드 ${result.code ?? "?"})`
      return yield* Effect.fail(new OwnServiceError(result.stderr ? `${reason}\n${result.stderr}` : reason))
    }
    service = started.service
    if (!service)
      return yield* Effect.fail(
        new OwnServiceError(`런처가 끝난 뒤에도 정상 서비스를 찾지 못했어요(${paths.registration})`),
      )
  }
  if (!service.password) return yield* Effect.fail(new OwnServiceError("서비스가 인증 정보를 주지 않았어요"))
  const url = new URL(service.url)
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
  const ready = { url: url.origin, password: service.password } satisfies SidecarCredentials.Data
  SidecarCredentials.set(ready)
  yield* Effect.logInfo("own: service ready", { mode, url: url.origin, version: service.version })
  // 05 §5.3 step 10, off the renderer's path: a service that is not the installed release (raw exe, another
  // version) is reported here; the renderer shows guard 2's banner from host.service.status().managed.
  const version = service.version
  yield* Effect.forkDetach(
    Effect.promise(() => readManifest(paths.manifest)).pipe(
      Effect.flatMap((manifest) =>
        manifest?.version && version && manifest.version !== version
          ? Effect.logWarning("own: service version differs from the installed release", {
              service: version,
              installed: manifest.version,
            })
          : Effect.void,
      ),
    ),
  )
  return ready
})
