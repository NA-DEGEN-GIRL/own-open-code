// own-accounts' cache verdict for the own-harness e2e tests (CC-16). own-harness asks core for the whole history (P-034)
// only when own-accounts' compaction hook wrote `full` into the metadata, and these tests run without own-accounts.
// Listed before own-harness, this plugin writes the warm verdict into every compaction's metadata, as own-accounts does
// on a warm Anthropic cache, except in a session titled "no verdict" (`full-prefix.ts` NO_VERDICT), which shows what
// own-harness does on its own.
import { Plugin } from "@opencode/plugin"
import { CompactionCache } from "@own/protocol/compaction-cache"

export default Plugin.define({
  id: "own.test.cache-verdict",
  setup: async (ctx) => {
    await ctx.session.hook("compaction", async (event) => {
      const info = await ctx.session.get({ sessionID: event.sessionID })
      if (info.title === "no verdict") return
      event.metadata = { ...event.metadata, [CompactionCache.CACHE_KEY]: { prefix: "full", reason: "warm" } }
    })
  },
})
