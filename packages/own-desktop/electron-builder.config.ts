// own-desktop packaging (05 §4.5): upstream's electron-builder config spread and overridden, never edited.
// Kept from upstream: files (minus sourcemaps), win icon, the signing hook when upstream has one (v2.2 signs outside
// electron-builder, so none now), NSIS oneClick per-user. build/installer.nsh is own's include: upstream's icacls grant
// for the sandbox (its include is no longer pulled in, its v2.2 macros clash), the service install/uninstall and the
// uninstall cleanup of the toast activator, the Start-menu shortcut and the notification settings (05 §7.4, §10.4).
// Changed: own identity (appId = AUMID, product name, install folder from the package name), no `opencode://`
// declaration, no publish target (no app-update.yml, so the updater has nothing to check), no bundled CLI (the installed
// version's opencode.exe, app\<version>\ from app\current.json, is used, 05 §5.4) and therefore a no-op afterPack
// (upstream's fails without the CLI).
// One-step install (USER-GUIDE §2): with OWN_DESKTOP_PAYLOAD (own/scripts/build-desktop.ps1 sets it to the build
// output that holds app\ and bin\), the service payload rides along as resources\own-payload and installer.nsh runs
// `own.ps1 install --from <it> --move` after the shell is in place.
// 원격 PC 전용 build (OWN_DESKTOP_CLIENT_ONLY=1, own/scripts/build-desktop-client.ps1, e.g. the Windows ARM64
// installer): never a payload (that installer is shell-only, so installer.nsh's service macros are not compiled in) and
// its own artifact name, own-desktop-client-<version>-win-<arch>.exe. The architecture is electron-builder's --arm64
// flag; OWN_ELECTRON_DIST must then point at that architecture's Electron (the cached x64 one would be packaged
// otherwise), and OPENCODE_TARGET picks upstream's node-pty prebuild filter (files) and the main bundle's import.
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Configuration, CustomWindowsSign, WindowsConfiguration } from "electron-builder"
import upstream from "../desktop/electron-builder.config.ts"
import { AUMID, PRODUCT_NAME } from "./src/shared/identity.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
// Windows only (05 §1.2): upstream's macOS and Linux sections carry its app ids and signing hooks, so they are dropped
// (the prod channel's `dmg` volume icon since v2.2.5 too).
const { mac: _mac, dmg: _dmg, linux: _linux, deb: _deb, rpm: _rpm, ...base } = upstream as Configuration
const baseWin: WindowsConfiguration = base.win ?? {}

/** Where the payload lands in the install folder: $INSTDIR\resources\own-payload\{app,bin} (installer.nsh). */
export const PAYLOAD_RESOURCE = "own-payload"

/** A file of the service payload inside the packaged app. */
export function isPayloadPath(file: string) {
  return new RegExp(`[\\\\/]resources[\\\\/]${PAYLOAD_RESOURCE}[\\\\/]`, "i").test(file)
}

/**
 * Upstream's signing hook (a no-op off GitHub Actions) for the shell only: the payload's files are hashed into
 * app\manifest.json before packaging and `own.ps1 install` refuses files that differ, so signing them here would break
 * the install. A signed opencode.exe has to be signed before build-desktop.ps1 computes the manifest.
 */
export function payloadSafeSign(sign: WindowsConfiguration["signtoolOptions"]) {
  const upstreamSign = sign?.sign
  if (typeof upstreamSign !== "function") return sign
  const wrapped: CustomWindowsSign = async (configuration, packager) => {
    if (isPayloadPath(configuration.path)) return
    return upstreamSign(configuration, packager)
  }
  return { ...sign, sign: wrapped }
}

/** electron-builder's defaults (NsisOptions.preCompressedFileExtensions) plus the remote bundles' .gz. */
const PRE_COMPRESSED = [".avi", ".mov", ".m4v", ".mp4", ".m4p", ".qt", ".mkv", ".webm", ".vmdk", ".gz"]

/**
 * The Electron build to package: OWN_ELECTRON_DIST, else the one `bun run electron:install` put into
 * node_modules/electron/dist (from the @electron/get cache), else electron-builder downloads its own.
 */
function electronDist(env: NodeJS.ProcessEnv) {
  if (env.OWN_ELECTRON_DIST) return env.OWN_ELECTRON_DIST
  try {
    const dist = path.join(path.dirname(createRequire(import.meta.url).resolve("electron/package.json")), "dist")
    return existsSync(path.join(dist, "electron.exe")) ? dist : undefined
  } catch {
    return undefined
  }
}

/** The staged service payload (build output with app\manifest.json and bin\own.ps1), or undefined. */
export function payloadRoot(env: NodeJS.ProcessEnv): string | undefined {
  const root = env.OWN_DESKTOP_PAYLOAD
  if (!root) return undefined
  if (!existsSync(path.join(root, "app", "manifest.json")) || !existsSync(path.join(root, "bin", "own.ps1")))
    throw new Error(
      `OWN_DESKTOP_PAYLOAD=${root} has no app\\manifest.json and bin\\own.ps1 (own/scripts/build-desktop.ps1 stages them)`,
    )
  return path.resolve(root)
}

/** OWN_DESKTOP_CLIENT_ONLY=1: the 원격 PC 전용 shell (src/main/client-only.ts). */
export function isClientOnly(env: NodeJS.ProcessEnv) {
  return env.OWN_DESKTOP_CLIENT_ONLY === "1"
}

export function ownBuilderConfig(env: NodeJS.ProcessEnv = process.env): Configuration {
  const dist = electronDist(env)
  const client = isClientOnly(env)
  if (client && env.OWN_DESKTOP_PAYLOAD)
    throw new Error("OWN_DESKTOP_CLIENT_ONLY=1 builds a shell-only installer: unset OWN_DESKTOP_PAYLOAD")
  const payload = client ? undefined : payloadRoot(env)
  return {
    ...base,
    appId: AUMID,
    productName: PRODUCT_NAME,
    // No spaces in the executable path (05 §4.5, §4.6): %LOCALAPPDATA%\Programs\own-desktop\own-desktop.exe.
    executableName: "own-desktop",
    artifactName: client
      ? "own-desktop-client-${version}-${os}-${arch}.${ext}"
      : "own-desktop-${version}-${os}-${arch}.${ext}",
    directories: {
      ...base.directories,
      // build-own.ps1 writes only under own/.out (FORK §8.2); tests point OWN_DESKTOP_OUT at a scratch folder.
      output: env.OWN_DESKTOP_OUT ?? path.resolve(here, "../../own/.out/desktop"),
    },
    // OWN_VERSION (own/scripts/build-desktop.ps1): the release version for the app's package.json, the artifact name
    // and the exe's file version, so a 2.0.18-own.N build needs no package.json edit (05 §10.1 step 5).
    extraMetadata: {
      ...base.extraMetadata,
      desktopName: "dev.own.opencode.desktop.desktop",
      ...(env.OWN_VERSION ? { version: env.OWN_VERSION } : {}),
    },
    protocols: [],
    publish: null,
    extraResources: payload
      ? [
          { from: path.join(payload, "app"), to: `${PAYLOAD_RESOURCE}/app` },
          { from: path.join(payload, "bin"), to: `${PAYLOAD_RESOURCE}/bin` },
        ]
      : [],
    afterPack: async () => {},
    files: [...((base.files as string[] | undefined) ?? []), "!out/renderer/**/*.map"],
    // own's main bundle carries the browser's ffi-rs binding as a chunk (out/main/chunks/ffi-rs.<target>.node) where
    // upstream ships node_modules/ffi-rs; it loads from disk like upstream's unpacked copy. Upstream's electronFuses
    // (cookie encryption with DPAPI, no ELECTRON_RUN_AS_NODE, no --inspect) are kept as they come in `base`.
    asarUnpack: [...((base.asarUnpack as string[] | undefined) ?? []), "out/main/chunks/*.node"],
    // portable is never used: it self-extracts about 200 MB on every launch.
    win: { ...baseWin, target: ["nsis"], signtoolOptions: payloadSafeSign(baseWin.signtoolOptions) },
    nsis: {
      ...base.nsis,
      include: path.join(here, "build", "installer.nsh"),
      // No updater (publish: null), so no differential blockmap: one solid LZMA2 archive instead of 1 MB
      // non-solid blocks, about 10% smaller for the shell and the payload.
      differentialPackage: false,
      // The remote bundles are .tar.gz already; NSIS stores them instead of 7z working through ~180 MB for nothing.
      preCompressedFileExtensions: PRE_COMPRESSED,
    },
    ...(dist ? { electronDist: dist } : {}),
  }
}

export default ownBuilderConfig()
