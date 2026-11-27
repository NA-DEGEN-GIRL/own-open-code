// Substitutes packages/desktop/src/main/constants.ts @ 698800f59c (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for every importer (electron.vite.config.ts, 05 §4.3); keeps all five exports.
// own: own identity so userData, the single-instance lock and the AUMID never collide with installed "OpenCode" /
// "OpenCode Dev" (`ai.opencode.desktop[.dev]`); the development build gets its own id as well. Upstream dropped
// UPDATER_ENABLED (f406d93a66): the updater is now a GUI plugin that runs when packaged and CHANNEL is not "dev",
// so it stays off because the shell's built-in GUI plugin list has no updater (src/overrides/gui-plugins.ts).
import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"
// Upstream reads CHANNEL for the macOS menu (native/menu.ts) and the GUI plugins' build info (plugin/host.ts).
export const CHANNEL: Channel = "prod"
export const VERSION = app.getVersion()
export const APP_NAME = app.isPackaged ? "Own OpenCode" : "Own OpenCode Local"
export const APP_ID = app.isPackaged ? "dev.own.opencode.desktop" : "dev.own.opencode.desktop.local"
// The Windows AppUserModelID (taskbar grouping, toasts, jump list) is the app id, as before upstream split it out
// (identity.ts): upstream gives its unpackaged runs a separate one so a first toast's Start Menu shortcut cannot shadow
// the installed OpenCode Dev; own's local id already differs from the installed one.
export const APP_USER_MODEL_ID = APP_ID
