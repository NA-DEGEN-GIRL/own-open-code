// Substitutes packages/desktop/src/main/plugin/manager.ts @ 79349e840f (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for upstream's GUI plugin host (plugin/host.ts, electron.vite.config.ts, 05 §4.3); same
// single export with the same members.
// own: no GUI plugin but the built-ins ever runs in the shell (05 §8.1). Upstream enables every plugin of the app's own
// server that ships a `./gui-experimental` bundle unless the user turned it off, and keeps that switch in the desktop
// database. Here:
//  - enabled() is true for the built-ins (overrides/gui-plugins.ts: the browser pane) and false for everything else,
//    so the host activates no service plugin's main setup (and overrides/plugin-module.ts evaluates none anyway);
//  - setEnabled() fails: "builtin" for a built-in (as upstream), "unavailable" for any other id, so PluginEnable and
//    PluginDisable never write a row that a later build could read as consent.
import { PluginError } from "@opencode/desktop/src/main/plugin/error"
import type { Database } from "@opencode/desktop/src/main/storage/database"

export function createManager(_db: Database, builtins: readonly string[]) {
  return {
    enabled: (id: string) => builtins.includes(id),
    setEnabled(id: string, _enabled: boolean): void {
      throw new PluginError(builtins.includes(id) ? "builtin" : "unavailable")
    },
  }
}
