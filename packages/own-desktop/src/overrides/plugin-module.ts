// Substitutes packages/desktop/src/main/plugin/module.ts @ 79349e840f (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for upstream's GUI plugin host (plugin/host.ts, electron.vite.config.ts, 05 §4.3); same
// single export.
// own: upstream lists the plugins of the app's own server that ship a `./gui-experimental` bundle and evaluates each
// bundle in main (`require` reaches `electron` and every Node built-in), whether or not the plugin is enabled. own's
// service loads the user's local plugins after an approval that covers their server entry only, and the shell runs no
// GUI plugin but its built-ins (05 §8.1), so no bundle is evaluated here: every evaluation fails with "unavailable"
// before any of its code runs. The host lists such a plugin with that failure and never activates it.
import { PluginError } from "@opencode/desktop/src/main/plugin/error"
import type { Plugin } from "../../../plugin/src/gui/main"

export async function evaluateMain(
  _code: string,
): Promise<{ readonly setup: Plugin.MainSetup; readonly i18n?: undefined; readonly os?: undefined }> {
  throw new PluginError("unavailable", { message: "own-desktop runs no GUI plugin of the service (05 §8.1)" })
}
