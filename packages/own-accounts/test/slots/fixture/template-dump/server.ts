// Test-only plugin used by `test/slots/generate-templates.ts`: writes the catalog providers' model definitions, as a
// provider fold sees them before any model transform, to the file given in its `out` option. Never loaded in
// production.

import { writeFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { Templates } from "../../../../src/slots/templates.js"

const decodeOptions = Schema.decodeUnknownSync(Schema.Struct({ out: Schema.String }))

export default Plugin.define({
  id: "own.test.template-dump",
  setup: async (ctx) => {
    const options = decodeOptions(ctx.options)
    await ctx.provider.transform((editor) => {
      const dump = Object.fromEntries(
        Templates.SOURCES.map((source) => [source, [...(editor.get(source)?.models.values() ?? [])]]),
      )
      writeFileSync(options.out, JSON.stringify(dump))
    })
  },
})
