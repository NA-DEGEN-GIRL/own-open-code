// Substitutes packages/gui-plugins/src/main.ts @ 79349e840f (MIT). See own/ledger/vendored.yaml
// Swapped in at build time for upstream's GUI plugin host (desktop plugin/host.ts, electron.vite.config.ts, 05 §4.3);
// same single export.
// own: the shell's built-in GUI plugins are the native browser pane (05 §8.1) and own's `explorer` (05 §7.10: main's
// side of `탐색기에서 열기` / `탐색기에서 보기`, src/explorer; not in the 원격 PC 전용 build, whose page never asks).
// Upstream's others are left out, so their code is not even in the bundle:
//  - updater: own updates through its installer and `own.ps1 install` (01 §5.5). Upstream's turns itself on when the
//    app is packaged and CHANNEL is not "dev", and own builds are CHANNEL=prod (overrides/constants.ts);
//  - ssh and wsl: SSH runs in the service (own-remote, 04); WSL is out of scope;
//  - pairing: devices pair through own's gateway (05 §13.5), not upstream's LAN pairing; its keep-screen-awake store
//    goes with it (05 §7.6);
//  - context, btw, debug, terminal, file, review, details, microsoft-office, sources, goal: window-only plugins of
//    upstream's renderer, which own-web replaces.
// A plugin of the service that ships a `./gui-experimental` bundle never runs in the shell: overrides/plugin-module.ts
// evaluates none and overrides/plugin-manager.ts enables none but the built-ins.
// Imports of packages this package does not depend on point at their sources.
import { compose } from "../../../plugin/src/gui/host"
import browser from "../../../gui-plugins/src/browser"
import { clientOnly } from "../main/client-only"

/** Built-in plugins with their main entries, by id. */
export const builtins = compose({
  browser: { ...browser, mainEntry: () => import("../../../gui-plugins/src/browser/main") },
  ...(clientOnly ? {} : { explorer: { mainEntry: () => import("../explorer/main") } }),
})
