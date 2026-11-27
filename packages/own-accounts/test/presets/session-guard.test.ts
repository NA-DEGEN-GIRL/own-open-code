// The gone-main guard (07 §4.3 "실행 중인 세션의 메인 모델은 저절로 바꾸지 않는다"): a root whose main model, or its
// reasoning level, is gone from what its account offers. `session.preset.get` says so with the 02 switch to offer, and
// a user prompt to such a root raises `session_model_unavailable` / `session_variant_unavailable` when it is admitted,
// before its step runs. Nothing is ever switched by itself. A model the catalog dropped while the pinned template keeps
// it (`upstream: "missing"`, 07 §4.4) is not gone: it stays registered, so a session on it runs on (U3). Real slots and
// presets modules over the 2026-10-01 fixture catalog with ChatGPT's `gpt-5.5` gone from the template and `gpt-6-luna`
// marked missing upstream; a fake session core; every account and Codex file is fake.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SessionID } from "@opencode/schema/session-id"
import { Preset } from "@own/protocol"
import type { Module } from "../../src/module.js"
import { Modules } from "../../src/modules.js"
import { PresetBinding } from "../../src/presets/binding.js"
import type { Variant } from "../../src/switching/variant.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { until } from "../plugins/support.js"
import { failure, fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import {
  ANTHROPIC,
  CLAUDE_ON,
  CODEX_A,
  DEEPSEEK,
  DS,
  OPENAI,
  registry,
  templateID,
} from "./fixtures/catalog-2026-10-01.js"

setDefaultTimeout(30_000)

const WORKSPACE = process.platform === "win32" ? "C:\\work\\guard" : "/work/guard"

/** Codex's upgrade hint of the gone model (07 §4.5), as the Codex CLI caches it. */
const CACHE = JSON.stringify({
  models: [{ slug: "gpt-5.5", upgrade: { model: "gpt-6-sol", retirement_at: "2026-10-14T00:00:00Z" } }],
})

interface Facts {
  readonly model?: Variant.Ref
  readonly parentID?: string
}

const stops: Array<() => unknown> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

/** A handler's output, failing the test on a declared error. */
function ok<T>(value: T): Exclude<T, { readonly type: string; readonly message: string }> {
  const declared = failure(value)
  if (declared) throw new Error(`${declared.type}: ${declared.message}`)
  // SAFETY: `failure` recognises every declared error of the fake context, so what is left is the output.
  return value as Exclude<T, { readonly type: string; readonly message: string }>
}

async function rig(input: { readonly sessions: Record<string, Facts>; readonly codex?: Record<string, string> }) {
  const kv = memoryStorage()
  const sessions = new Map<string, Facts>(Object.entries(input.sessions))
  const switches: unknown[] = []
  const t = await testDeps({
    directory: WORKSPACE,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const facts = sessions.get(request.sessionID)
          if (!facts) throw new Error(`no session ${request.sessionID}`)
          return { id: request.sessionID, ...facts, location: { directory: WORKSPACE } }
        },
        switchModel: async (request: unknown) => {
          switches.push(request)
        },
      },
    },
  })
  stops.push(() => t[Symbol.asyncDispose]())
  const codexHome = path.join(t.home, "codex-fixture")
  await fs.mkdir(codexHome)
  await Promise.all(
    Object.entries(input.codex ?? {}).map(([name, text]) => fs.writeFile(path.join(codexHome, name), text)),
  )
  const deps = { ...t.deps, options: { ...t.deps.options, codexHome } }
  // ChatGPT's template without `gpt-5.5` (as `refreshCatalog` leaves it after the catalog dropped it: gone), and with
  // `gpt-6-luna` the catalog dropped since, kept and marked missing upstream (07 §4.4: it runs on as `deprecated`).
  const base = await registry()
  const template = base.modelTemplates[templateID("codex")]
  if (!template) throw new Error("fixture")
  await deps.runtime.registry.write({
    ...base,
    modelTemplates: {
      ...base.modelTemplates,
      [templateID("codex")]: {
        ...template,
        models: template.models
          .filter((item) => item.id !== "gpt-5.5")
          .map((item) => (item.id === "gpt-6-luna" ? { ...item, upstream: "missing" } : item)),
      },
    },
  })
  const alerts: Telemetry.AlertInput[] = []
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_ON }),
    telemetry: (base, peers) => ({ ...Modules.FACTORIES.telemetry(base, peers), alert: (alert) => alerts.push(alert) }),
  })
  await modules.slots.start()
  await modules.presets.start()
  stops.push(async () => {
    await modules.presets.stop()
    await modules.slots.stop()
  })
  modules.slots.transformProviders(
    fakeEditor({
      openai: { models: OPENAI.filter((item) => item.id !== "gpt-5.5" && item.id !== "gpt-6-luna") },
      anthropic: { models: ANTHROPIC },
      deepseek: { models: DEEPSEEK },
    }).editor,
  )
  const get = async (sessionID: string) =>
    ok(await modules.presets.sessionGet({ sessionID: SessionID.make(sessionID) }, rpcContext()))
  /** A prompt admitted to the session's inbox (`session.inbox.enqueued`), as core publishes it before the step. */
  const prompt = (sessionID: string, input: { readonly type?: string; readonly local?: boolean } = {}) => {
    // SAFETY: `type` and `data` follow the event schema for the members the presets module reads.
    const event = {
      id: `evt_${sessionID}`,
      created: deps.clock.now(),
      type: "session.inbox.enqueued",
      location: { directory: WORKSPACE },
      data: { sessionID, inboxID: `msg_${sessionID}`, item: { type: input.type ?? "user" } },
    } as unknown as Module.OpenCodeEvent
    return modules.presets.onEvent?.(event, { local: input.local ?? true })
  }
  return { deps, sessions, switches, alerts, modules, get, prompt }
}

describe("a main whose model is gone (07 §4.3)", () => {
  test("session.preset.get says main.missing 'model' with Codex's successor; the next prompt raises session_model_unavailable; nothing switches", async () => {
    const gone = { providerID: CODEX_A, id: "gpt-5.5", variant: "high" }
    const r = await rig({ sessions: { ses_gone: { model: gone } }, codex: { "models_cache.json": CACHE } })
    const view = await r.get("ses_gone")
    expect<unknown>(view.main).toEqual({ missing: "model", suggestion: { id: "gpt-6-sol", variant: "high" } })
    // The rest of the view is as before: no binding written, the caps and counts of an unbound root.
    expect(view).toMatchObject({ binding: null, caps: Preset.CAPS, counts: { running: 0, message: 0, session: 0 } })
    expect(r.alerts).toEqual([])

    await r.prompt("ses_gone")
    await until(() => r.alerts.length === 1)
    expect(r.alerts[0]).toMatchObject({
      code: "session_model_unavailable",
      severity: "warning",
      sessionID: "ses_gone",
    })
    expect(r.alerts[0]?.message).toBe(
      "이 대화의 모델 gpt-5.5이(가) 없어졌습니다. 다음 메시지 전에 모델을 바꾸세요(제안: gpt-6-sol · high). 저절로 바꾸지 않습니다.",
    )
    expect(r.switches).toEqual([])
    expect(r.sessions.get("ses_gone")?.model).toEqual(gone)
    expect(await PresetBinding.read(r.deps, "ses_gone")).toBeUndefined()
    expect<unknown>((await r.get("ses_gone")).main).toEqual(view.main)
  })

  test("without Codex metadata the offer is what a new session on that account starts on, at the session's level", async () => {
    const r = await rig({ sessions: { ses_gone: { model: { providerID: CODEX_A, id: "gpt-5.5", variant: "xhigh" } } } })
    expect<unknown>((await r.get("ses_gone")).main).toEqual({
      missing: "model",
      suggestion: { id: "gpt-6-astra", variant: "xhigh" },
    })
  })
})

describe("a main whose level is gone (07 §4.3, §2.3)", () => {
  test("main.missing 'variant' with the level refitted to the model's levels; the prompt raises session_variant_unavailable", async () => {
    const level = { providerID: DS, id: "deepseek-v4-pro", variant: "medium" }
    const r = await rig({ sessions: { ses_level: { model: level } } })
    expect<unknown>((await r.get("ses_level")).main).toEqual({
      missing: "variant",
      suggestion: { id: "deepseek-v4-pro", variant: "high" },
    })
    await r.prompt("ses_level")
    await until(() => r.alerts.length === 1)
    expect(r.alerts[0]).toMatchObject({ code: "session_variant_unavailable", sessionID: "ses_level" })
    expect(r.alerts[0]?.message).toBe(
      "deepseek-v4-pro에서 추론 강도 'medium'이(가) 없어졌습니다. 다음 메시지 전에 'high'(으)로 바꾸세요. 저절로 바꾸지 않습니다.",
    )
    expect(r.switches).toEqual([])
    expect(r.sessions.get("ses_level")?.model).toEqual(level)
  })
})

describe("a main that runs (07 §4.3)", () => {
  test("no main field and no alert: a listed level, no level, `default`, a child, a synthetic item, another Location", async () => {
    const gone = { providerID: CODEX_A, id: "gpt-5.5", variant: "high" }
    const r = await rig({
      sessions: {
        // Dropped by the catalog but kept by the pinned template: still registered, so it runs (07 §4.4, U3).
        ses_dropped: { model: { providerID: CODEX_A, id: "gpt-6-luna", variant: "high" } },
        ses_sol: { model: { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" } },
        ses_plain: { model: { providerID: CODEX_A, id: "gpt-6-sol" } },
        ses_default: { model: { providerID: CODEX_A, id: "gpt-6-sol", variant: "default" } },
        ses_claude: { model: { providerID: "anthropic", id: "claude-opus-5-5" } },
        ses_child: { model: gone, parentID: "ses_sol" },
        ses_gone: { model: gone },
      },
    })
    for (const sessionID of ["ses_dropped", "ses_sol", "ses_plain", "ses_default", "ses_claude"]) {
      expect((await r.get(sessionID)).main).toBeUndefined()
      await r.prompt(sessionID)
    }
    // A subagent's own session follows its root (the gate resolves it); only user prompts of this Location count.
    await r.prompt("ses_child")
    await r.prompt("ses_gone", { type: "synthetic" })
    await r.prompt("ses_gone", { local: false })
    await Bun.sleep(50)
    expect(r.alerts).toEqual([])
    expect(r.switches).toEqual([])
  })
})
