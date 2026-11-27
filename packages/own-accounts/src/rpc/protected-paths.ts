export * as ProtectedPathsRpc from "./protected-paths.js"

import type { Deps } from "../deps.js"
import type { Modules } from "../modules.js"
import type { RpcTypes } from "./types.js"

/**
 * Owner: 에이전트가 못 여는 파일·폴더 (01 §13, 03 §18.8, PP). Every service answers for itself, an SSH host included (it
 * places the built-in list in its own home folder and keeps its own user list), so these are not remote-managed.
 * Global methods at the control Location; the change reaches every Location's hook through the runtime broadcast.
 */
export type Methods =
  | "protectedPaths.get"
  | "protectedPaths.add"
  | "protectedPaths.remove"
  | "protectedPaths.suggest"
  | "protectedPaths.patterns"

export function handlers(modules: Modules.All, deps: Deps): RpcTypes.Group<Methods> {
  const changed = (view: ReturnType<typeof modules.protection.view>) =>
    void deps.emitter.global("protectedPaths.changed", { paths: view })
  return {
    "protectedPaths.get": async () => modules.protection.view(),
    "protectedPaths.add": async (input, context) => {
      const result = await modules.protection.add(input.path)
      if (!result.ok)
        return context.error("protected_path_invalid", `the path cannot be protected (${result.reason})`, {
          reason: result.reason,
          path: result.path,
        })
      if (result.changed) changed(result.view)
      return result.view
    },
    "protectedPaths.remove": async (input) => {
      const result = await modules.protection.remove(input.path)
      if (result.changed) changed(result.view)
      return result.view
    },
    "protectedPaths.suggest": () => modules.protection.suggest(),
    "protectedPaths.patterns": async () => ({ patterns: modules.protection.patterns() }),
  }
}
