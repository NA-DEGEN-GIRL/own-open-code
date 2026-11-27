// The entry of the omo runtime bundle (script/bundle.ts): the vendored oh-my-opencode v5.1.50 sources
// (own/vendor/oh-my-opencode, SUL-1.0, patched by patches/v5.1.50.json) are bundled from here into `omo-runtime.js`.
// `@omo/*` is the staged `packages/omo-opencode/src/*`, `@omo-root/*` the staged tree's root. This file is not
// type-checked with the host (the vendored sources are not in any tsconfig); `runtime.d.ts` declares what it exports and
// the host imports only those names.
import { _setLoggerForTesting as setCompatLogger } from "@omo-root/packages/claude-code-compat-core/src/shared/logger"
import { _setLoggerForTesting as setLogger } from "@omo/shared/logger"

export { createPluginModule } from "@omo/testing/create-plugin-module"
export { createManagers } from "@omo/create-managers"
/** omo's hook set, which the host wraps to keep the todo continuation out of own.team's sessions (src/runtime.ts). */
export { createHooks } from "@omo/create-hooks"
export { setVersionCache } from "@omo/shared/opencode-version"
export { getSessionAgent, setMainSession } from "@omo/features/claude-code-session-state"
export { AGENT_DISPLAY_NAMES, getAgentConfigKey } from "@omo/shared/agent-display-names"
export { getAgentToolRestrictions } from "@omo/shared/agent-tool-restrictions"
export { OhMyOpenCodeConfigSchema } from "@omo/config/schema/oh-my-opencode-config"
/** omo's internal hook names: own's baseline turns off every one it does not run (src/config.ts). */
export { HookNameSchema } from "@omo/config/schema/hooks"
export { OMO_INTERNAL_INITIATOR_MARKER } from "@omo/shared/internal-initiator-marker"
/** The zod copy omo's tool arguments are made with, which the host turns into JSON Schema and validates with. */
export { z } from "zod"

/** Points both omo loggers (omo-opencode's and claude-code-compat-core's) at `filePath`, 10 MB per file. */
export function setLogFile(filePath: string) {
  setLogger({ filePath, maxSizeBytes: 10_000_000 })
  setCompatLogger({ filePath, maxSizeBytes: 10_000_000 })
}

export const version = "5.1.50"
