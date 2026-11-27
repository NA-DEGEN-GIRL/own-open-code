// The preset fixes of 2026-11-03 (decisions PF): the model pool editor's offer lists every Claude subscription account
// and every Claude Agent account (not only account 1), the Claude subscription's models are the catalog's current ones,
// an OpenAI-compatible account on this PC or the LAN offers local, free models (never "only when others fail"), the
// recommended pool skips the models the user hid, and a pin to a Claude account counts once in R4 like the slot.
// Fake accounts, catalogs and logins only.

import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Model } from "@opencode/schema/model"
import { Account, ClaudeAgent, Kind, OwnID, Preset, type Registry } from "@own/protocol"
import { Templates } from "../../src/slots/templates.js"
import { rpcContext } from "../slots/support.js"
import { CLAUDE, OPENAI, DEEPSEEK, SEATS, harness, model, registry, type Harness } from "./fixtures/catalog-2026-10-01.js"

const CL_02 = Account.ID.make("acc_01J9PFC4AD0000000000000002")
const CL_03 = Account.ID.make("acc_01J9PFC4AD0000000000000003")
const AGENT = Account.ID.make("acc_01J9PFAGENT00000000000001")
const LOCAL = Account.ID.make("acc_lcl1")
const CLOUD = Account.ID.make("acc_cld1")

const at = (month: number, day: number, year = 2026) => Date.UTC(year, month - 1, day)

/** The `anthropic` lineup of the bundled models.dev snapshot (packages/core/src/models-dev/snapshot.txt, 2026-11). */
const ANTHROPIC_NOW = [
  model("anthropic", "claude-haiku-4-5", { family: "claude-haiku", released: at(10, 15, 2025), price: 1 }),
  model("anthropic", "claude-opus-4-5", { family: "claude-opus", released: at(11, 24, 2025), price: 5 }),
  model("anthropic", "claude-opus-4-8", { family: "claude-opus", released: at(5, 28), price: 5 }),
  model("anthropic", "claude-fable-5-1", { family: "claude-fable", released: at(9, 1), price: 10 }),
  model("anthropic", "claude-opus-5-5", { family: "claude-opus", released: at(9, 22), price: 5 }),
  model("anthropic", "claude-sonnet-5-5", { family: "claude-sonnet", released: at(9, 28), price: 3 }),
  model("anthropic", "claude-haiku-5-5", { family: "claude-haiku", released: at(10, 7), price: 1 }),
]

const AGENT_MODELS = [
  model(ClaudeAgent.PROVIDER_ID, "claude-opus-5-5", { family: "claude-opus", released: at(9, 22) }),
  model(ClaudeAgent.PROVIDER_ID, "claude-sonnet-5-5", { family: "claude-sonnet", released: at(9, 28) }),
]

function claudeAccount(accountID: Account.ID, label: string, folder: string): Registry.ClaudeAccount {
  return {
    accountID,
    key: folder.toLowerCase(),
    configDir: folder,
    label,
    shortLabel: label,
    color: "teal",
    managed: true,
    addedAt: "2026-10-10T00:00:00Z",
  }
}

/** Three Claude subscription accounts (AC-01 is the slot's own) and one Claude Agent account. */
async function claudeRegistry(): Promise<Registry.File> {
  const base = await registry()
  return {
    ...base,
    claudeSlot: { accountID: "acc_claude_slot", label: "AC-01", shortLabel: "CL1", color: "indigo" },
    claudeAccounts: [
      claudeAccount(CL_02, "AC-02", path.join("C:", "t", "pf-claude-02")),
      claudeAccount(CL_03, "AC-03", path.join("C:", "t", "pf-claude-03")),
    ],
    claudeAgents: [
      {
        accountID: AGENT,
        configDir: path.join("C:", "t", "pf-agent-01"),
        label: "CA-01",
        shortLabel: "CA",
        color: "amber",
        addedAt: "2026-10-31T00:00:00Z",
      },
    ],
  }
}

async function pool(h: Harness, group: Preset.Group) {
  const out = await h.presets.suggest({ group }, rpcContext())
  if (!("draft" in out) || !out.pool) throw new Error(`suggest failed: ${JSON.stringify(out)}`)
  return out.pool
}

describe("Claude accounts in the model pool editor (PF 2026-11-03)", () => {
  test("every Claude subscription account and the Claude Agent account is offered, not only account 1", async () => {
    await using h = await harness({
      registry: await claudeRegistry(),
      catalog: { openai: OPENAI, anthropic: ANTHROPIC_NOW, deepseek: DEEPSEEK },
      listed: AGENT_MODELS,
    })
    const offer = await pool(h, "codex")
    const claude = offer.candidates.filter((item) => item.company === "anthropic")
    expect(new Set(claude.map((item) => item.account))).toEqual(new Set([CLAUDE, CL_02, CL_03, AGENT]))
    expect(claude.every((item) => item.runs === "subscription")).toBe(true)
    // One company's accounts share a model's name, so switching `[계정 ▾]` keeps the checks (07 §8.1).
    const opus = claude.filter((item) => item.model === "claude-opus-5-5")
    expect(new Set(opus.map((item) => item.key))).toEqual(new Set(["claude-opus-5-5"]))
  })

  test("the Claude subscription lists the catalog's current models: Opus, Sonnet and Haiku 5.5 and Fable 5.1", async () => {
    await using h = await harness({
      registry: await claudeRegistry(),
      catalog: { openai: OPENAI, anthropic: ANTHROPIC_NOW, deepseek: DEEPSEEK },
    })
    const offer = await pool(h, "codex")
    for (const account of [CLAUDE, CL_02, CL_03]) {
      const models = offer.candidates.filter((item) => item.account === account).map((item) => String(item.model))
      expect(models).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]))
      expect(models).toContain("claude-fable-5-1")
      expect(models).toHaveLength(ANTHROPIC_NOW.length)
    }
  })

  test("a pin to Claude account 3 saves (R4 counts the slot's accounts once) and is that account's inventory", async () => {
    await using h = await harness({ registry: await claudeRegistry() })
    const saved = await h.presets.set(
      {
        preset: {
          name: "Claude 3 리뷰",
          group: "codex",
          workers: {
            mode: "same",
            roles: {},
            pool: [{ key: "claude-opus-5-5", model: Model.ID.make("claude-opus-5-5"), account: CL_03 }],
          },
          delegation: "model",
          caps: Preset.CAPS,
          ultraCaps: null,
        },
      },
      rpcContext(),
    )
    expect(saved).toMatchObject({ preset: { workers: { pool: [{ account: CL_03 }] } } })
    expect(await h.presets.resolver.inventory(CL_03)).toMatchObject({ account: CL_03, kind: "claude-sub" })
    expect(h.presets.resolver.lookup(CL_03)).toMatchObject({ id: CLAUDE, kind: "claude-sub" })
  })
})

describe("local model accounts in the pool editor (PF 2026-11-03, 02 §3.3a)", () => {
  async function compatRegistry(): Promise<Registry.File> {
    const base = await registry([
      ...SEATS,
      { kind: "compat", label: "local-flash-1", slug: "lcl1", baseURL: "http://127.0.0.1:8080/v1" },
      { kind: "compat", label: "Cloud", slug: "cld1", baseURL: "https://api.example.test/v1" },
    ])
    const template = (ids: ReadonlyArray<string>) => {
      const built = Templates.fromCompat(
        ids.map((id) => ({ id, contextLimit: 1_000_000 })),
        "2026-10-01T00:00:00Z",
      )
      if (!built.ok) throw new Error(built.reason)
      return built.template
    }
    return {
      ...base,
      // The local model marker (02 §3.3a) makes lcl1 a local model; the cloud account has none.
      accounts: base.accounts.map((account) =>
        account.providerID === Kind.ProviderID.from("compat", "lcl1")
          ? { ...account, compat: { ...account.compat, local: { format: "chat" as const } } }
          : account,
      ),
      slots: Object.fromEntries(
        Object.entries(base.slots).map(([id, slot]) =>
          slot.kind === "compat"
            ? [id, { ...slot, modelTemplate: OwnID.TemplateID.make(`tpl_${id.replaceAll("-", "_")}`) }]
            : [id, slot],
        ),
      ),
      modelTemplates: {
        ...base.modelTemplates,
        tpl_own_compat_lcl1: template(["local-flash-model-q4-0001"]),
        tpl_own_compat_cld1: template(["cloud-model"]),
      },
    }
  }

  test("the compat group's local model is its own free section, the cloud one still costs money", async () => {
    await using h = await harness({ registry: await compatRegistry() })
    expect(h.presets.resolver.localCompat(Kind.ProviderID.from("compat", "lcl1"))).toBe(true)
    expect(h.presets.resolver.localCompat(Kind.ProviderID.from("compat", "cld1"))).toBe(false)
    const offer = await pool(h, "compat")
    const local = offer.candidates.find((item) => item.model === "local-flash-model-q4-0001")
    expect(local).toMatchObject({ runs: "local" })
    expect(local?.account).toBeUndefined()
    expect(offer.candidates.find((item) => item.model === "cloud-model")).toMatchObject({ runs: "main-paid" })
  })

  test("another group offers it as a local model, not behind the paid accounts", async () => {
    await using h = await harness({ registry: await compatRegistry() })
    const offer = await pool(h, "codex")
    expect(offer.candidates.find((item) => item.account === LOCAL)).toMatchObject({ runs: "local" })
    expect(offer.candidates.find((item) => item.account === CLOUD)).toMatchObject({ runs: "paid" })
  })
})

describe("hidden models (PF 2026-11-03)", () => {
  test("the recommended pool skips a hidden model; it stays a candidate the editor can show", async () => {
    await using h = await harness()
    const before = await pool(h, "codex")
    expect(before.recommended).toContain("gpt-6.1-sol")
    await h.deps.runtime.policy.update((stored) => ({
      ...stored,
      hiddenModels: [{ group: "codex", model: "gpt-6.1-sol" }],
    }))
    const after = await pool(h, "codex")
    expect(after.recommended).not.toContain("gpt-6.1-sol")
    expect(after.candidates.some((item) => item.model === "gpt-6.1-sol")).toBe(true)
  })
})

describe("renaming a Claude Agent account (PF 2026-11-03)", () => {
  test("accounts.update sets its name in the registry; its folder and login stay, budget-like fields are refused", async () => {
    await using h = await harness({ registry: await claudeRegistry(), listed: AGENT_MODELS })
    const before = h.modules.slots.snapshot().claudeAgents?.[0]
    const renamed = await h.modules.slots.update({ accountID: AGENT, label: "작업용 Claude" }, rpcContext())
    expect(renamed).toMatchObject({ account: { id: AGENT, label: "작업용 Claude", kind: "claude-agent" } })
    const after = h.modules.slots.snapshot().claudeAgents?.[0]
    expect(after).toEqual({ ...before!, label: "작업용 Claude" })
    const listed = await h.modules.slots.list({}, rpcContext())
    expect("accounts" in listed && listed.accounts.find((account) => account.id === AGENT)?.label).toBe(
      "작업용 Claude",
    )
    const refused = await h.modules.slots.update({ accountID: AGENT, budget: { monthlyUSD: 5 } }, rpcContext())
    expect(refused).toMatchObject({ type: "policy_denied" })
  })
})
