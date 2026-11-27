// `own:service.*` and `own:support.*` handlers (05 §5.5, §5.6), loaded on first use so the entry stays small (R-D1).
// The sender check lives in own-shell.ts, where the channels are registered.
import { existsSync, mkdirSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { app, shell } from "electron"
import log from "electron-log/main.js"
import type { OwnOpenInBrowserResult, OwnServiceRestartResult, OwnServiceStatus } from "../preload/own-api"
import { readManifest } from "./manifest"
import { ownPaths } from "./own-env"
import { discoverService } from "./service/discover"
import {
  exclusive,
  launcherCommand,
  openInBrowserResult,
  RESTART_TIMEOUT_MS,
  restartArgs,
  restartResult,
  runLauncher,
  START_TIMEOUT_MS,
} from "./service/launcher"

const logger = log.scope("own")

/** [로그 폴더] (05 §5.5): the shell's logs (main.log, own.log) in Explorer. */
export async function openLogs(): Promise<boolean> {
  const folder = app.getPath("logs")
  try {
    mkdirSync(folder, { recursive: true })
  } catch {}
  const failure = await shell.openPath(folder)
  if (failure) logger.warn("open logs failed", { failure })
  return !failure
}

let opening: Promise<OwnOpenInBrowserResult> | undefined

/**
 * [브라우저로 열기] (05 §5.5): `own open --browser` with the env snapshot, like every launcher run (5.3 step 4). The
 * launcher starts or reuses the service, makes a pairing link and opens the browser; a service of another version
 * with running sessions is not replaced (exit 4, 5.7). One run at a time.
 */
export function openInBrowser(): Promise<OwnOpenInBrowserResult> {
  opening ??= (async (): Promise<OwnOpenInBrowserResult> => {
    const paths = ownPaths()
    if (paths.channel === "local") return { ok: false, detail: "개발 채널이에요. Vite 개발 서버를 여세요" }
    // powershell.exe reports a missing -File in the console code page, which would reach the screen garbled.
    if (!existsSync(paths.launcher))
      return { ok: false, detail: `런처를 찾지 못했어요: ${paths.launcher}. 설치 파일을 다시 실행하세요` }
    const command = launcherCommand(paths, "open", ["--browser"])
    logger.info("launcher open --browser", { file: command.file, args: command.args })
    const result = await exclusive(() => runLauncher(command, { timeoutMs: START_TIMEOUT_MS }))
    logger.info("launcher open --browser finished", { code: result.code, timedOut: result.timedOut })
    return openInBrowserResult(result)
  })().finally(() => (opening = undefined))
  return opening
}

export async function serviceStatus(): Promise<OwnServiceStatus> {
  const paths = ownPaths()
  const [service, manifest, mode] = await Promise.all([
    discoverService(paths.registration),
    readManifest(paths.manifest),
    serviceMode(paths.serviceConfig),
  ])
  const version = service?.version
  return {
    running: !!service,
    version,
    registration: paths.registration,
    // Guard 2 (01 §5.4): the running service must be the installed release. The dev channel has no release.
    managed: !!service && (!manifest?.version || !version || manifest.version === version),
    mode,
  }
}

let restarting: Promise<OwnServiceRestartResult> | undefined

export function serviceRestart(input: unknown): Promise<OwnServiceRestartResult> {
  // One launcher at a time: a second request while one runs gets the same answer.
  restarting ??= restart(input).finally(() => (restarting = undefined))
  return restarting
}

async function restart(input: unknown): Promise<OwnServiceRestartResult> {
  const paths = ownPaths()
  if (paths.channel === "local")
    return { ok: false, refused: "launcher_failed", detail: "개발 채널이에요. 개발 서비스를 다시 시작하세요" }
  const value = (typeof input === "object" && input !== null ? input : {}) as {
    force?: unknown
    claudeConfigDir?: unknown
  }
  const args = restartArgs(
    {
      force: value.force === true,
      claudeConfigDir: typeof value.claudeConfigDir === "string" ? value.claudeConfigDir : undefined,
    },
    isDirectory,
  )
  if (!args.ok) return { ok: false, refused: "launcher_failed", detail: args.detail }
  if (!existsSync(paths.launcher))
    return {
      ok: false,
      refused: "launcher_failed",
      detail: `런처를 찾지 못했어요: ${paths.launcher}. 설치 파일을 다시 실행하세요`,
    }
  const command = launcherCommand(paths, "restart", args.args)
  logger.info("launcher restart", { file: command.file, args: command.args })
  const result = await exclusive(() => runLauncher(command, { timeoutMs: RESTART_TIMEOUT_MS }))
  logger.info("launcher restart finished", { code: result.code, timedOut: result.timedOut })
  return restartResult(result)
}

async function serviceMode(file: string): Promise<OwnServiceStatus["mode"]> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    const env = (JSON.parse(text) as { env?: Record<string, unknown> }).env
    return env?.OPENCODE_CONFIG_PROJECT_DISABLE === "1" ? "untrusted" : "trusted"
  } catch {
    return undefined
  }
}

function isDirectory(value: string) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}
