// The `explorer` plugin Ipc (05 §7.10): `탐색기에서 열기` / `탐색기에서 보기` and the SSH file explorer program of 설정.
// own-web calls it by name through upstream's PluginCall (packages/own-web/src/host/desktop.ts), like the browser
// pane, so `window.own` and its contract file stay as they are. A shell without this plugin answers `unavailable`,
// and own-web then says the desktop app is older than the screen.
// Imports of packages this package does not depend on point at their sources.
import { Schema } from "effect"
import { Ipc } from "../../../plugin/src/gui/core"
import { TEMPLATE_MAX } from "../shared/explorer"

const text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

/** `ExplorerResult` of src/shared/explorer.ts; `reason` only with `ok: false`. */
const Result = Schema.Struct({
  ok: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
})

/** `ExplorerProgram`: no `program` until the user picked one. */
const Program = Schema.Struct({ program: Schema.optionalKey(Schema.String), template: Schema.String })

export const Explorer = Ipc.define({
  id: "explorer",
  methods: {
    // A path of this PC inside an open folder: a folder opens in Explorer, a file is shown selected in its folder.
    reveal: { input: Schema.Struct({ path: text(4_096) }), output: Result },
    // A path on an SSH host: starts the chosen program with the template's arguments.
    launch: { input: Schema.Struct({ host: text(255), path: text(4_096) }), output: Result },
    program: { output: Program },
    // Main's own file dialog picks the program; the page never names one.
    pick: { output: Program },
    template: {
      input: Schema.Struct({ template: Schema.String.check(Schema.isMaxLength(TEMPLATE_MAX)) }),
      output: Program,
    },
    clear: { output: Program },
  },
})
