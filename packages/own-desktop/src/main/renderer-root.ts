// Which page the renderer shows (05 §5.5). Pure: the entry passes what it read (own-shell.ts registerRenderer).
import type { OwnRendererSource } from "../preload/own-api"
import type { OwnManifest } from "./manifest"

export interface RendererChoice {
  readonly root: string
  readonly source: OwnRendererSource
}

/**
 * The installed own-web (`app\<version>\web`, the version named by app\current.json) when the manifest's rpcHash is
 * this shell's and its index.html exists; otherwise the shell's own fallback page, with the reason. A dev URL
 * (`ELECTRON_RENDERER_URL`, kept by a development shell only: own-env.ts `devShell`) wins: upstream `loadWindow` loads
 * it instead of `oc://renderer`.
 */
export function selectRenderer(input: {
  readonly devUrl?: string
  readonly manifest?: OwnManifest
  readonly webIndexExists: boolean
  readonly webRoot: string
  readonly fallbackRoot: string
  readonly rpcHash: string
}): RendererChoice {
  if (input.devUrl) return { root: input.fallbackRoot, source: { source: "dev", url: input.devUrl } }
  if (!input.manifest || !input.webIndexExists)
    return {
      root: input.fallbackRoot,
      source: { source: "fallback", reason: "missing", uiVersion: input.manifest?.version },
    }
  if (input.manifest.rpcHash !== input.rpcHash)
    return {
      root: input.fallbackRoot,
      source: {
        source: "fallback",
        reason: "skew",
        uiVersion: input.manifest.version,
        uiRpcHash: input.manifest.rpcHash,
      },
    }
  return { root: input.webRoot, source: { source: "installed", root: input.webRoot, uiVersion: input.manifest.version } }
}

/**
 * 원격 PC 전용 build (client-only.ts): its fallback root holds the remote-client page (src/client), shown whatever is
 * installed and never moved by movedRoot. The source says `missing` because OwnRendererSource is part of the rpcHash
 * contract; the page never reads it. Separate from selectRenderer so the full shell's bundle stays as it was.
 */
export function clientRenderer(fallbackRoot: string): RendererChoice {
  return { root: fallbackRoot, source: { source: "fallback", reason: "missing" } }
}

/**
 * After a version switch (01 §5.5 step 7): the installed UI's root moves to the newly installed version's web on the
 * next page load, as reads through the app\current junction used to. Only an installed UI moves (the fallback page and
 * a dev URL stay what the start chose), and only to a web that has its index.html (an uninstall keeps the last one).
 * The new UI may carry another rpcHash: own-web's own T0 check shows the mismatch screen then (05 §5.5).
 * Returns the new root, or undefined when it stays.
 */
export function movedRoot(input: {
  readonly source: OwnRendererSource
  readonly current: string
  readonly installedWeb: string
  readonly webIndexExists: (dir: string) => boolean
  readonly platform?: NodeJS.Platform
}) {
  if (input.source.source !== "installed") return undefined
  const same =
    (input.platform ?? process.platform) === "win32"
      ? input.current.toLowerCase() === input.installedWeb.toLowerCase()
      : input.current === input.installedWeb
  if (same || !input.webIndexExists(input.installedWeb)) return undefined
  return input.installedWeb
}
