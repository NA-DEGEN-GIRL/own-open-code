// A web search service for e2e tests (`WEBSEARCH_FIXTURE_PLUGIN`): `fake-search` answers every query with one result
// built from the query, without any network. The real services core lists stay listed; a test selects this one.
// Like core's keyless services it has an integration of the same id with a key method, so a test can store a (fake)
// key for it and see `websearch.get` report it (`keys`, 03 §18.2); the answers do not change with a key.
// With the option `parallel: true` it also stands in for core's keyless `parallel` (same id and name, answered from
// memory, so a test can show a free service's search without reaching search.parallel.ai); a query with `[empty]`
// gets no results there, as Exa's and Firecrawl's keyless servers look to core when their free tier is used up
// (upstream #54311).
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "own.test.websearch",
  setup: async (ctx) => {
    await ctx.integration.transform((editor) => {
      editor.update("fake-search", (integration) => {
        integration.name = "Fake Search"
      })
      editor.method.update({ integrationID: "fake-search", method: { type: "key" } })
    })
    const parallel = ctx.options.parallel === true
    await ctx.websearch.transform((editor) => {
      editor.add({
        id: "fake-search",
        name: "Fake Search",
        execute: async (input) => [
          {
            url: `https://search.example.test/?q=${encodeURIComponent(input.query)}`,
            title: `result for ${input.query}`,
            content: "fake search result",
            time: {},
          },
        ],
      })
      if (!parallel) return
      editor.add({
        id: "parallel",
        name: "Parallel",
        execute: async (input) =>
          input.query.includes("[empty]")
            ? []
            : [
                {
                  url: `https://parallel.example.test/?q=${encodeURIComponent(input.query)}`,
                  title: `parallel result for ${input.query}`,
                  content: "fake parallel result",
                  time: {},
                },
              ],
      })
    })
  },
})
