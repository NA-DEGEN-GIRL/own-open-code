// DesktopCli(own) (05 §5.4): the installed release's CLI, never a bundled copy. Upstream copies a ~197 MB bundled CLI
// into userData per version (desktop-cli.ts installCli) and can install it on PATH (macOS). own-desktop bundles no
// CLI, and `install` always fails: the only PATH entry is own.cmd (01 §5.4 "raw exe는 PATH에 두지 않는다").
// Consumers: the replaced BackgroundService (not this), ipc-handlers/app.ts and ipc.ts (menu `installCli`), and the
// inactive SSH/WSL paths.
import { Effect, Layer } from "effect"
import { DesktopCli } from "@opencode/desktop/src/main/service/desktop-cli"
import { readManifestSync } from "../manifest"
import { ownPaths } from "../own-env"

export * as DesktopCliOwn from "./desktop-cli-own"

export function resolveOwnCli(paths = ownPaths()): DesktopCli.Resolved {
  const version = readManifestSync(paths.manifest)?.version ?? "unknown"
  return { version, command: [paths.exe], binary: paths.exe }
}

export const layer = Layer.effect(
  DesktopCli.Service,
  Effect.gen(function* () {
    const resolve = yield* Effect.cached(Effect.sync(() => resolveOwnCli()))
    return DesktopCli.Service.of({
      resolve,
      install: Effect.fail(new Error("The desktop app does not install a command-line tool. Use own.cmd instead.")),
    })
  }),
)
