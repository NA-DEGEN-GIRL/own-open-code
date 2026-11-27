// own-plugin-server.ts: the `server.ts` own writes into every C3 version (own/docs/17 §12.2). Core loads the version
// folder as a local plugin and runs this file; it registers the plugin's hooks through own's shim (`own-shim.ts`), with
// the options own.creator wrote into the `plugins` entry. Nothing else of the plugin API is handed on.

import path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { load } from "./own-shim.js"

const folder = path.dirname(fileURLToPath(import.meta.url))
// `ext\<id>\v<n>`: the plugin's id names the extension, so two code plugins never share one.
const extension = path.basename(path.dirname(folder))

export default Plugin.define({
  id: `own.creator.ext.${extension}`,
  effect: (ctx) =>
    Effect.gen(function* () {
      const runner = yield* Effect.promise(() => load(ctx.options, folder, extension, ctx.location.directory))
      if (runner === undefined) return
      // SAFETY: the shim reads only the fields it names from the event and writes back the ones the hook may change.
      const run = (hook: "context" | "compaction", event: unknown) =>
        Effect.promise(() => runner.run(hook, event as Record<string, unknown>))
      if (runner.hooks.includes("context")) yield* ctx.session.hook("context", (event) => run("context", event))
      if (runner.hooks.includes("compaction"))
        yield* ctx.session.hook("compaction", (event) => run("compaction", event))
    }),
})
