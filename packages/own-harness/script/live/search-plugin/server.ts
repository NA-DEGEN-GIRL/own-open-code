// Live-test plugin: a core web search provider that runs own-accounts' ChatGPT search request (src/websearch/wire.ts)
// through the live forwarder, so a live session's `websearch` reaches real search without own-accounts and its vault.
// The forwarder adds the credential; this plugin only knows its URL (env OWN_LIVE_SEARCH_URL).
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { SearchWire } from "../../../../own-accounts/src/websearch/wire.js"

export default Plugin.define({
  id: "own.live.search",
  effect: (ctx) =>
    ctx.websearch.transform((editor) => {
      editor.add({
        id: "live-chatgpt",
        name: "ChatGPT (live test)",
        execute: (input) =>
          Effect.promise(async () => {
            const response = await fetch(process.env.OWN_LIVE_SEARCH_URL ?? "", {
              method: "POST",
              headers: { originator: "opencode", "content-type": "application/json", accept: "text/event-stream" },
              body: JSON.stringify(SearchWire.body({ model: "gpt-5.6-luna", effort: "low", query: input.query })),
            })
            return SearchWire.results(SearchWire.read(await response.text()).items)
          }),
      })
      if (editor.default.get() === undefined) editor.default.set("live-chatgpt")
    }),
})
