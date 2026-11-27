// own's omo config against the built runtime's schema (OWN_OMO_RUNTIME or own/.out/omo; `bun script/bundle.ts`).
import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"
import { OmoConfig } from "../../src/config.js"
import type { OmoRuntime } from "../../src/omo-runtime.js"
import { Runtime } from "../../src/runtime.js"

// SAFETY: omo-runtime.js is the bundle of src/runtime-entry.ts, whose exports omo-runtime.d.ts declares.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const runtime = (await import(pathToFileURL(Runtime.locate()).href)) as OmoRuntime
const MODEL = "fake-ds/deepseek-v4-pro"

describe("own's omo config (15 §4.8)", () => {
  test("the baseline is valid omo config", () => {
    const parsed = runtime.OhMyOpenCodeConfigSchema.safeParse(OmoConfig.baseline(MODEL, runtime.HookNameSchema.options))
    expect(parsed.success).toBe(true)
  })

  test("every hook omo knows is off except the MVP's, which all exist", () => {
    const all = runtime.HookNameSchema.options
    for (const hook of OmoConfig.ENABLED_HOOKS) expect(all).toContain(hook)
    const config = OmoConfig.baseline(MODEL, all)
    expect([...config.disabled_hooks].sort()).toEqual(all.filter((hook) => !(OmoConfig.ENABLED_HOOKS as ReadonlyArray<string>).includes(hook)).sort())
    expect(config.disabled_hooks.length + OmoConfig.ENABLED_HOOKS.length).toBe(all.length)
  })

  test("telemetry, updates, fallbacks and the features outside the MVP are off; agents and categories on own's model", () => {
    const config = OmoConfig.resolve(runtime, { model: MODEL })
    expect(config).toMatchObject({
      telemetry: false,
      auto_update: false,
      model_fallback: false,
      runtime_fallback: false,
      team_mode: { enabled: false },
      tmux: { enabled: false },
      claude_code: { mcp: false, commands: false, skills: false, agents: false, hooks: false, plugins: false },
      disabled_mcps: ["websearch", "context7", "grep_app", "lsp"],
    })
    for (const agent of ["sisyphus", ...OmoConfig.AGENTS]) expect((config.agents as Record<string, { model: string }>)[agent]?.model).toBe(MODEL)
    for (const category of OmoConfig.CATEGORIES)
      expect((config.categories as Record<string, { model: string }>)[category]?.model).toBe(MODEL)
  })

  test("the user's config is merged over the baseline; own's policies and models win", () => {
    const config = OmoConfig.resolve(runtime, {
      model: MODEL,
      user: {
        telemetry: true,
        disabled_hooks: [],
        background_task: { defaultConcurrency: 2 },
        agents: { oracle: { model: "openai/gpt-5.5", temperature: 0.3 } },
        categories: { quick: { model: "openai/gpt-5.5-mini" } },
      },
    })
    expect(config.telemetry).toBe(false)
    expect((config.disabled_hooks as ReadonlyArray<string>).length).toBeGreaterThan(0)
    expect(config.background_task).toMatchObject({ defaultConcurrency: 2 })
    expect((config.agents as Record<string, Record<string, unknown>>).oracle).toMatchObject({ model: MODEL, temperature: 0.3 })
    expect((config.categories as Record<string, Record<string, unknown>>).quick).toMatchObject({ model: MODEL })
  })

  test("a config omo cannot read stops the start", () => {
    expect(() => OmoConfig.resolve(runtime, { model: MODEL, user: { agents: { oracle: { temperature: "hot" } } } })).toThrow(
      /not valid for omo/,
    )
  })
})
