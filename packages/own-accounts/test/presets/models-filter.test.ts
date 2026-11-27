// The `opencode_models` filter (07 §5.4 "`models` 도구 거르기", T0): only the main provider's models reach the LLM.
// Real slots and presets modules on a temp OWN_HOME; the sessions are fakes and every account is fake.

import { describe, expect, test } from "bun:test"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import type { ModelsFilter } from "../../src/presets/models-filter.js"
import { testDeps } from "../support/deps.js"
import { memoryStorage, registryWith } from "../slots/support.js"

const CX01 = "own-codex-cx01"
const CX02 = "own-codex-cx02"
const DS = "own-ds-ds01"
const ROOT = "ses_models_root"
const CHILD = "ses_models_child"
/** A root stored without a model: its main is unknown. */
const BARE = "ses_models_bare"

const CLAUDE_OFF: Plugins.ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }

async function setup() {
  const sessions = new Map<string, Readonly<Record<string, unknown>>>([
    [ROOT, { id: ROOT, model: { providerID: CX01, id: "gpt-6-sol" } }],
    [CHILD, { id: CHILD, parentID: ROOT, model: { providerID: CX01, id: "gpt-6-luna" } }],
    [BARE, { id: BARE }],
  ])
  const t = await testDeps({
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      storage: memoryStorage().storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const found = sessions.get(request.sessionID)
          if (!found) throw new Error(`session not found: ${request.sessionID}`)
          return { ...found, location: { directory: "D:/work" } }
        },
      },
    },
  })
  await t.deps.runtime.registry.write(
    await registryWith([
      { kind: "codex", label: "ChatGPT 01", slug: "cx01" },
      { kind: "codex", label: "ChatGPT 02", slug: "cx02" },
      { kind: "ds", label: "DeepSeek", slug: "ds01" },
    ]),
  )
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => CLAUDE_OFF }),
  })
  await modules.slots.start()
  return {
    filter: async (event: ModelsFilter.After) => {
      await modules.presets.onToolAfter(event)
      return event
    },
    async [Symbol.asyncDispose]() {
      await modules.presets.stop()
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

/** A `models` entry as core lists it (fake values). */
const entry = (providerID: string, id: string) => ({
  id: `${providerID}/${id}`,
  name: id.toUpperCase(),
  released: 0,
  variants: ["low", "high"],
  cost: [],
  status: "active",
})

const listing = (
  providers: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
  page: { readonly total: number; readonly next: number | null },
) => ({
  providers: providers.map(([id, models]) => ({
    id,
    name: `ChatGPT · ${id}`,
    models: models.map((model) => entry(id, model)),
  })),
  ...page,
})

const completed = (output: unknown, input: unknown = {}, sessionID = ROOT): ModelsFilter.After => ({
  tool: "opencode_models",
  sessionID,
  input,
  status: "completed",
  result: { output, content: JSON.stringify(output), metadata: { note: "kept" } },
})

const resultOf = (event: ModelsFilter.After) => (event.status === "completed" ? event.result : undefined)
const outputOf = (event: ModelsFilter.After) => resultOf(event)?.output

describe("opencode_models execute.after (PG2 (가))", () => {
  test("other providers are removed: the main provider's entries stay as core wrote them", async () => {
    await using s = await setup()
    const event = await s.filter(
      completed(
        listing(
          [
            [CX01, ["gpt-6-sol", "gpt-6-luna"]],
            [CX02, ["gpt-6-sol"]],
            [DS, ["deepseek-flash"]],
          ],
          { total: 4, next: null },
        ),
      ),
    )
    expect(outputOf(event)).toEqual({
      providers: [
        {
          id: CX01,
          name: `ChatGPT · ${CX01}`,
          models: [entry(CX01, "gpt-6-sol"), entry(CX01, "gpt-6-luna")],
        },
      ],
      total: 2,
      next: null,
    })
    expect(JSON.stringify(event)).not.toContain(CX02)
    // Core renders the text from the filtered output; metadata stays.
    expect(resultOf(event)?.content).toBeUndefined()
    expect(resultOf(event)?.metadata).toEqual({ note: "kept" })
  })

  test("a page past the main provider's last model ends the listing; `total` counts up to this page", async () => {
    await using s = await setup()
    const event = await s.filter(
      completed(
        listing(
          [
            [CX01, ["gpt-5.5"]],
            [CX02, ["gpt-6-sol", "gpt-6-luna"]],
          ],
          { total: 30, next: 23 },
        ),
        { offset: 20, limit: 3 },
      ),
    )
    expect(outputOf(event)).toMatchObject({ total: 21, next: null })
  })

  test("a page of main models keeps `next`; other providers' count leaves `total`", async () => {
    await using s = await setup()
    const event = await s.filter(completed(listing([[CX01, ["gpt-6-sol", "gpt-6-luna"]]], { total: 9, next: 2 })))
    expect(outputOf(event)).toMatchObject({ total: 2, next: 2 })
  })

  test("nothing of the main provider: the empty listing keeps its shape", async () => {
    await using s = await setup()
    const event = await s.filter(completed(listing([[CX02, ["gpt-6-sol"]]], { total: 1, next: null })))
    expect(outputOf(event)).toEqual({ providers: [], total: 0, next: null })
  })

  test("a child session lists its root's main provider", async () => {
    await using s = await setup()
    const event = await s.filter(
      completed(
        listing(
          [
            [CX01, ["gpt-6-sol"]],
            [CX02, ["gpt-6-sol"]],
          ],
          { total: 2, next: null },
        ),
        {},
        CHILD,
      ),
    )
    expect(outputOf(event)).toMatchObject({ providers: [{ id: CX01 }], total: 1 })
  })

  test("a main the filter cannot find lists nothing (decision 2026-10-02)", async () => {
    await using s = await setup()
    const page = () =>
      listing(
        [
          [CX01, ["gpt-6-sol"]],
          [CX02, ["gpt-6-sol"]],
        ],
        { total: 30, next: 12 },
      )
    // A root without a stored model, and a session the lookup cannot find.
    for (const sessionID of [BARE, "ses_models_missing"]) {
      const event = await s.filter(completed(page(), { offset: 10, limit: 2 }, sessionID))
      expect(outputOf(event)).toEqual({ providers: [], total: 0, next: null })
      expect(resultOf(event)?.content).toBeUndefined()
      expect(resultOf(event)?.metadata).toEqual({ note: "kept" })
    }
  })

  test("other tools, failed calls and unknown output shapes are untouched", async () => {
    await using s = await setup()
    const other = { ...completed(listing([[CX02, ["gpt-6-sol"]]], { total: 1, next: null })), tool: "read" }
    const otherResult = resultOf(other)
    await s.filter(other)
    expect(resultOf(other)).toBe(otherResult)

    const failed: ModelsFilter.After = { tool: "opencode_models", sessionID: ROOT, input: {}, status: "error" }
    expect(await s.filter(failed)).toEqual({ tool: "opencode_models", sessionID: ROOT, input: {}, status: "error" })

    const odd = completed({ models: ["x"] })
    const oddResult = resultOf(odd)
    await s.filter(odd)
    expect(resultOf(odd)).toBe(oddResult)
  })
})
