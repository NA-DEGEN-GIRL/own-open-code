// The entry's first import (05 §5.2). ES module order runs this before upstream `configureApplication()`, which
// changes process.env (`OPENCODE_DISABLE_EMBEDDED_WEB_UI`, test-root `XDG_*`) as do later layers (NO_PROXY). The
// snapshot is what the launcher receives unchanged, and every path the shell uses is computed from it, so the shell
// and the launcher (`own.ps1` Get-OwnPaths, same variables) always agree on the registration file and OWN_HOME.
// Nothing here scrubs or adds variables, env hygiene being the launcher's job (01 §5.3 step 1), with one exception:
// a build that is not a development shell drops ELECTRON_RENDERER_URL first (`devShell`).
import os from "node:os"
import path from "node:path"
import { installedApp, pointerFile, type InstalledApp } from "./install-pointer"

/** Shell main start, epoch ms: the `own:shell-start` origin for PF1 (03 §20.1 B1, 05 T0-6). */
export const shellStartedAt = Date.now()

/**
 * A development shell (`electron-vite dev`: scripts/dev.ts, the manual's pictures), the only kind that loads its
 * renderer from `ELECTRON_RENDERER_URL` (decisions RL5-3). Upstream's `loadWindow` and `isRendererUrl` read that variable
 * on every call, so in a release build a value in the environment would load any page with the preload's `window.own`
 * and give its origin the renderer's IPC and permissions. A build constant: every build drops it here, before anything
 * reads it, whatever the environment says.
 */
export const devShell = import.meta.env.OWN_DEV_SHELL === "1"
if (!devShell) delete process.env.ELECTRON_RENDERER_URL

export const envSnapshot: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
)

/** `local`: development shell against the local-channel service (05 §5.1, 11.2). Never starts anything. */
export type OwnChannel = "own" | "local"

export interface OwnPaths {
  readonly channel: OwnChannel
  /** `<XDG_STATE_HOME | USERPROFILE\.local\state>\opencode\service-own.json` (`service-local.json` in dev). */
  readonly registration: string
  readonly ownHome: string
  readonly launcher: string
  /** `OWN_HOME\app\current.json`, the version pointer (install-pointer.ts). */
  readonly pointer: string
  /** The installed release, resolved from the pointer at this call; undefined when nothing is installed. */
  readonly installed: InstalledApp | undefined
  /** Its folder `OWN_HOME\app\<version>`; `OWN_HOME\app\current` (does not exist) when nothing is installed. */
  readonly app: string
  readonly manifest: string
  readonly web: string
  readonly exe: string
  readonly control: string
  /** Launcher service config (`OWN_CONFIG_DIR\service-own.json`), read for the trust mode only. */
  readonly serviceConfig: string
}

/**
 * Every path the shell uses. The installed release is resolved on each call (app\current.json, never a junction), so
 * callers that run later (IPC, a window's reload) see a version switch the launcher made meanwhile.
 */
export function ownPaths(
  env: Readonly<Record<string, string | undefined>> = envSnapshot,
  resolve: (ownHome: string) => InstalledApp | undefined = installedApp,
): OwnPaths {
  const channel: OwnChannel = env.OWN_DESKTOP_CHANNEL === "local" ? "local" : "own"
  const home = env.USERPROFILE || os.homedir()
  const state = env.XDG_STATE_HOME || path.join(home, ".local", "state")
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local")
  const ownHome = env.OWN_HOME || path.join(localAppData, "own-open-code")
  const configDir =
    env.OWN_CONFIG_DIR || path.join(home, ".config", channel === "local" ? "own-open-code-dev" : "own-open-code")
  const installed = resolve(ownHome)
  const app = installed?.dir ?? path.join(ownHome, "app", "current")
  return {
    channel,
    registration: path.join(state, "opencode", channel === "local" ? "service-local.json" : "service-own.json"),
    ownHome,
    launcher: path.join(ownHome, "bin", "own.ps1"),
    pointer: pointerFile(ownHome),
    installed,
    app,
    manifest: path.join(app, "manifest.json"),
    web: path.join(app, "web"),
    exe: path.join(app, "opencode.exe"),
    control: path.join(ownHome, "control"),
    serviceConfig: path.join(configDir, "service-own.json"),
  }
}
