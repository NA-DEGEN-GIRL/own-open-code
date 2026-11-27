// own's stand-in for OpenCode 1's `@opencode-ai/plugin` inside the omo runtime bundle (script/resolve.ts). omo uses only
// `tool()`, which returns the tool definition as it is, and `tool.schema`, which is zod; everything else it imports
// from the package is a type. own-omo turns those definitions into OpenCode 2 tools (src/host/tools.ts).
import { z } from "zod"

export function tool<Definition>(definition: Definition): Definition {
  return definition
}

tool.schema = z
