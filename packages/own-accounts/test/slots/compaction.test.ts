// Auto-compaction settings of the slots module (02 §4.7, §9.2 `accounts.list`/`accounts.update`), the runtime session
// index behind `accounts.list.sessions` and `accounts.remove.plan.affectedSessions`, and the core config reader.
// Every credential is fake.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Account, Compaction, type Registry } from "@own/protocol"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { CoreConfig } from "../../src/slots/core-config.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, failure, fakeEditor, memoryStorage, registryWith, rpcContext } from "./support.js"

const CLAUDE_ON: Plugins.ClaudeSlot = { detected: true, version: "0.4.0", integrity: "i", verified: true }
const CLAUDE_OFF: Plugins.ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }

async function setup(input: { readonly registry: Registry.File; readonly claude?: Plugins.ClaudeSlot }) {
  const reloads: number[] = []
  const t = await testDeps({
    ctx: {
      provider: {
        reload: async () => {
          reloads.push(1)
        },
        list: async () => [],
      },
      storage: memoryStorage().storage,
    },
  })
  await t.deps.runtime.registry.write(input.registry)
  const modules = t.modules({
    plugins: (deps, peers) => ({
      ...Modules.FACTORIES.plugins(deps, peers),
      claudeSlot: () => input.claude ?? CLAUDE_OFF,
    }),
  })
  await modules.slots.start()
  return {
    t,
    slots: modules.slots,
    reloads,
    async [Symbol.asyncDispose]() {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

describe("accounts.list compaction and sessions", () => {
  test("stored setting, thresholds per model, session counts and the login method", async () => {
    const registry = await registryWith([
      { kind: "ds", label: "DS", slug: "d111" },
      { kind: "codex", label: "C", slug: "c111" },
    ])
    const withMethod: Registry.File = {
      ...registry,
      accounts: registry.accounts.map((account) =>
        account.kind === "codex" ? { ...account, method: "chatgpt-device" as const } : account,
      ),
    }
    await using s = await setup({ registry: withMethod, claude: CLAUDE_ON })
    const sessions = s.t.deps.runtime.sessions
    sessions.update("ses_a", { providerID: "own-ds-d111", modelID: "deepseek-v4-pro", busy: true, P: 100_000 })
    sessions.update("ses_b", { providerID: "own-ds-d111", modelID: "deepseek-v4-pro" })
    sessions.update("ses_c", { providerID: "anthropic", modelID: "claude-opus-5-5" })
    // The Claude slot's thresholds come from the anthropic catalog the fold saw.
    const anthropic = catalogModel("anthropic", "claude-opus-5-5", { limit: { context: 1_000_000, output: 128_000 } })
    s.slots.transformProviders(fakeEditor({ anthropic: { models: [anthropic] } }).editor)
    const result = await s.slots.list({}, rpcContext<"accounts.list">())
    if (failure(result) || !("accounts" in result)) throw new Error("list failed")
    const [ds, codex, claude] = result.accounts
    expect(ds?.sessions).toEqual({ running: 1, total: 2 })
    expect<unknown>(ds?.compaction).toEqual({
      setting: null,
      effective: [
        { modelID: "deepseek-flash", windowTokens: 1_048_576, triggerTokens: 891_290, source: "v2" },
        { modelID: "deepseek-v4-pro", windowTokens: 1_048_576, triggerTokens: 891_290, source: "v2" },
      ],
    })
    expect(codex?.connection).toEqual({ type: "oauth", method: "chatgpt-device" })
    expect(codex?.sessions).toEqual({ running: 0, total: 0 })
    expect<unknown>(codex?.compaction?.effective.find((item) => item.modelID === "gpt-5.6-cyber")).toEqual({
      modelID: "gpt-5.6-cyber",
      windowTokens: 272_000,
      triggerTokens: 231_200,
      source: "v2",
    })
    expect(claude).toMatchObject({
      id: "acc_claude_slot",
      sessions: { running: 0, total: 1 },
      compaction: {
        setting: null,
        effective: [{ modelID: "claude-opus-5-5", windowTokens: 1_000_000, triggerTokens: 850_000, source: "v2" }],
      },
    })
  })
})

describe("accounts.update{compaction} (02 §4.7.3–4.7.5)", () => {
  test("ranges, dry run impact, storing moves the registered window, null resets", async () => {
    const registry = await registryWith([{ kind: "ds", label: "DS", slug: "d111" }])
    await using s = await setup({ registry, claude: CLAUDE_ON })
    const sessions = s.t.deps.runtime.sessions
    sessions.update("ses_big", {
      providerID: "own-ds-d111",
      modelID: "deepseek-v4-pro",
      P: 300_000,
      revertStaged: true,
    })
    sessions.update("ses_mid", { providerID: "own-ds-d111", modelID: "deepseek-v4-pro", P: 210_000 })
    sessions.update("ses_small", { providerID: "own-ds-d111", modelID: "deepseek-v4-pro", P: 50_000 })
    const context = rpcContext<"accounts.update">()
    const accountID = Account.ID.make("acc_d111")

    expect(failure(await s.slots.update({ accountID, compaction: { triggerPercent: 95 } }, context))).toMatchObject({
      type: "setting_out_of_range",
      data: { field: "compaction.triggerPercent", min: 10, max: 90 },
    })
    expect(
      failure(await s.slots.update({ accountID, compaction: { maxTriggerTokens: 50_000 } }, context)),
    ).toMatchObject({ type: "setting_out_of_range", data: { field: "compaction.maxTriggerTokens", min: 63_000 } })

    // Dry run: the sessions at or above the new threshold, nothing stored.
    const revision = s.slots.snapshot().revision
    const dry = await s.slots.update({ accountID, compaction: { maxTriggerTokens: 200_000 }, dryRun: true }, context)
    if (failure(dry) || !("account" in dry)) throw new Error("dry run failed")
    expect<unknown>(dry.compactionImpact).toEqual({
      sessions: [
        { sessionID: "ses_big", P: 300_000, triggerTokens: 200_000, truncates: true, revertStaged: true },
        { sessionID: "ses_mid", P: 210_000, triggerTokens: 200_000, truncates: false },
      ],
    })
    expect(s.slots.snapshot().revision).toBe(revision)
    expect(s.slots.account("acc_d111")?.compaction).toBeUndefined()

    // Stored: the registry bumps, the view and the fold follow (limit.input = ctx_eff, core's ceiling = T_slot).
    const saved = await s.slots.update({ accountID, compaction: { maxTriggerTokens: 200_000 } }, context)
    if (failure(saved) || !("account" in saved)) throw new Error("update failed")
    expect<unknown>(saved.compactionImpact?.sessions.map((row) => row.sessionID)).toEqual(["ses_big", "ses_mid"])
    expect(s.slots.snapshot().revision).toBe(revision + 1)
    expect(s.slots.account("acc_d111")?.compaction).toEqual({ maxTriggerTokens: 200_000 })
    expect(saved.account.compaction?.setting).toEqual({ maxTriggerTokens: 200_000 })
    expect<unknown>(saved.account.compaction?.effective[1]).toEqual({
      modelID: "deepseek-v4-pro",
      windowTokens: 1_048_576,
      triggerTokens: 200_000,
      source: "account",
    })
    const fold = fakeEditor()
    s.slots.transformProviders(fold.editor)
    const pro = fold.records.get("own-ds-d111")?.models.get("deepseek-v4-pro")
    expect(Compaction.ceiling(pro?.limit.input ?? 0)).toBe(200_000)
    expect(pro?.limit.context).toBe(1_048_576)
    expect(s.slots.compaction("own-ds-d111", "deepseek-v4-pro")).toMatchObject({ triggerTokens: 200_000 })

    // Account × model; a new setting replaces the whole account value.
    await s.slots.update(
      { accountID, compaction: { models: { "deepseek-flash": { maxTriggerTokens: 100_000 } } } },
      context,
    )
    expect(s.slots.compaction("own-ds-d111", "deepseek-flash")).toMatchObject({
      triggerTokens: 100_000,
      source: "accountModel",
    })
    expect(s.slots.compaction("own-ds-d111", "deepseek-v4-pro")).toMatchObject({ triggerTokens: 891_290 })

    // `null` goes back to the kind default and drops the stored field.
    await s.slots.update({ accountID, compaction: null }, context)
    expect(s.slots.account("acc_d111")).not.toHaveProperty("compaction")
    expect(s.slots.compaction("own-ds-d111", "deepseek-flash")).toMatchObject({
      triggerTokens: 891_290,
      source: "v2",
    })

    // Not ours: the Claude slot keeps the v2 default.
    expect(
      failure(await s.slots.update({ accountID: Account.ID.claudeSlot, compaction: { triggerPercent: 50 } }, context)),
    ).toMatchObject({ type: "policy_denied", data: { field: "compaction" } })
  })
})

describe("session index consumers", () => {
  test("accounts.remove.plan names the sessions bound to the slot", async () => {
    const registry = await registryWith([
      { kind: "oai", label: "A", slug: "aaaa" },
      { kind: "oai", label: "B", slug: "bbbb" },
    ])
    await using s = await setup({ registry })
    const sessions = s.t.deps.runtime.sessions
    sessions.update("ses_1", { providerID: "own-oai-aaaa", modelID: "gpt-5.4" })
    sessions.update("ses_2", { providerID: "own-oai-bbbb", modelID: "gpt-5.4" })
    sessions.update("ses_3", { providerID: "own-oai-aaaa", modelID: "gpt-5.4" })
    // A switch away removes it from the plan.
    sessions.update("ses_3", { providerID: "own-oai-bbbb" })
    const plan = await s.slots.removePlan(
      { accountID: Account.ID.make("acc_aaaa"), mode: "disable" },
      rpcContext<"accounts.remove.plan">(),
    )
    expect(plan).toMatchObject({ affectedSessions: ["ses_1"], willShredVault: false })
  })
})

describe("core config (own global opencode.jsonc)", () => {
  test("keep moves T_floor; a missing file means core defaults; unknown without a config dir", async () => {
    const registry = await registryWith([{ kind: "ds", label: "DS", slug: "d111" }])
    await using s = await setup({ registry })
    const dir = await fs.mkdtemp(path.join(s.t.home, "config-"))
    const previous = process.env.OPENCODE_CONFIG_DIR
    try {
      delete process.env.OPENCODE_CONFIG_DIR
      expect(await s.slots.refreshCore()).toEqual(CoreConfig.UNKNOWN)
      process.env.OPENCODE_CONFIG_DIR = dir
      expect(await s.slots.refreshCore()).toEqual({ keepTokens: 15_000, auto: true, buffer: null, model: null })
      await fs.writeFile(
        path.join(dir, "opencode.jsonc"),
        [
          "{",
          "  // own",
          '  "model": "own-ds-d111/deepseek-v4-pro",',
          '  "compaction": { "keep": { "tokens": 30000 }, "buffer": 5000 }',
          "}",
          "",
        ].join("\n"),
      )
      const reloads = s.reloads.length
      expect(await s.slots.refreshCore()).toEqual({
        keepTokens: 30_000,
        auto: true,
        buffer: 5_000,
        model: "own-ds-d111/deepseek-v4-pro",
      })
      expect(s.reloads.length).toBe(reloads + 1)
      expect(s.slots.compaction("own-ds-d111", "deepseek-v4-pro")).toMatchObject({ floorTokens: 78_000 })
      // Writing keep keeps comments and other keys.
      expect(await CoreConfig.writeKeep(dir, 12_000)).toEqual({ ok: true })
      const text = await fs.readFile(path.join(dir, "opencode.jsonc"), "utf8")
      expect(text).toContain("// own")
      expect(CoreConfig.values(text)).toEqual({
        keepTokens: 12_000,
        auto: true,
        buffer: 5_000,
        model: "own-ds-d111/deepseek-v4-pro",
      })
      // Upstream v2.2.2 also takes a share of the window; the self-test reports it like a token count.
      expect(CoreConfig.values('{ "compaction": { "buffer": "20%" } }').buffer).toBe("20%")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previous
    }
  })

  test("core's background compaction is written off once when the user's file names none (MR18-8)", async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "own-background-"))
    const file = path.join(dir, "opencode.jsonc")
    try {
      // No file: nothing is created (the launcher writes the first one).
      expect(await CoreConfig.ensureBackgroundOff(dir)).toEqual({ changed: false })
      expect(await fs.readdir(dir)).toEqual([])
      await fs.writeFile(file, ["{", "  // own", '  "compaction": { "auto": true }', "}", ""].join("\r\n"))
      expect(await CoreConfig.ensureBackgroundOff(dir)).toEqual({ changed: true })
      const text = await fs.readFile(file, "utf8")
      expect(text).toContain("// own")
      expect(text).toContain('"background": false')
      // The user's own value wins, and a second start writes nothing.
      expect(await CoreConfig.ensureBackgroundOff(dir)).toEqual({ changed: false })
      await fs.writeFile(file, '{ "compaction": { "background": true } }')
      expect(await CoreConfig.ensureBackgroundOff(dir)).toEqual({ changed: false })
      expect(await fs.readFile(file, "utf8")).toBe('{ "compaction": { "background": true } }')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("the web search service (03 §18.2) is core's `websearch` key; comments and line endings stay", async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "own-websearch-"))
    const file = path.join(dir, "opencode.jsonc")
    try {
      // No file yet: the write creates one with only the key.
      expect(await CoreConfig.writeWebSearch(dir, { type: "any" })).toEqual({ ok: true })
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ websearch: { provider: "random" } })
      await fs.writeFile(
        file,
        ["{\r", "  // own\r", '  "websearch": false,\r', '  "share": "disabled"\r', "}\r", ""].join("\n"),
      )
      expect(CoreConfig.webSearchOf(await fs.readFile(file, "utf8"))).toEqual({ type: "off" })
      expect(await CoreConfig.writeWebSearch(dir, { type: "service", id: "exa" })).toEqual({ ok: true })
      const text = await fs.readFile(file, "utf8")
      expect(text).toContain("// own")
      expect(
        text
          .split("\n")
          .slice(0, -1)
          .every((line) => line.endsWith("\r")),
      ).toBe(true)
      expect(CoreConfig.webSearchOf(text)).toEqual({ type: "service", id: "exa" })
      // `default` (설정 > 웹 검색 `기본으로`) removes only the key (with the comment just above it); the other keys and
      // the line endings stay.
      expect(await CoreConfig.writeWebSearch(dir, { type: "default" })).toEqual({ ok: true })
      const reset = await fs.readFile(file, "utf8")
      expect(CoreConfig.webSearchOf(reset)).toBeUndefined()
      expect(reset).toBe('{\r\n  "share": "disabled"\r\n}\r\n')
      // Without a file there is nothing to remove: none is created.
      const empty = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "own-websearch-"))
      expect(await CoreConfig.writeWebSearch(empty, { type: "default" })).toEqual({ ok: true })
      expect(await fs.readdir(empty)).toEqual([])
      await fs.rm(empty, { recursive: true, force: true })
      // Values core would not take, and text that is not JSONC, read as no choice; a write leaves broken text alone.
      expect(CoreConfig.webSearchOf('{ "websearch": { "provider": "" } }')).toBeUndefined()
      expect(CoreConfig.webSearchOf('{ "websearch": true }')).toBeUndefined()
      await fs.writeFile(file, '{ "websearch": ')
      expect(CoreConfig.webSearchOf('{ "websearch": ')).toBeUndefined()
      expect(await CoreConfig.writeWebSearch(dir, { type: "off" })).toEqual({
        ok: false,
        reason: "config_parse_failed",
      })
      expect(await fs.readFile(file, "utf8")).toBe('{ "websearch": ')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
