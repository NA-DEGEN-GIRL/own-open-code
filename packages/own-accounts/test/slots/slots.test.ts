import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Account, Preset, type Ledger, type Registry } from "@own/protocol"
import { Hash, Lock, Store } from "@own/runtime"
import { ChatgptSharing } from "../../src/credentials/sharing.js"
import { Modules } from "../../src/modules.js"
import type { Plugins } from "../../src/plugins/plugins.js"
import { Templates } from "../../src/slots/templates.js"
import { Views } from "../../src/slots/views.js"
import { StoreWatch } from "../../src/slots/watch.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { testDeps } from "../support/deps.js"
import { catalogModel, failure, fakeEditor, memoryStorage, price, registryWith, rpcContext } from "./support.js"

const CLAUDE_OFF: Plugins.ClaudeSlot = { detected: false, version: null, integrity: null, verified: false }

async function setup(
  input: {
    readonly registry?: Registry.File
    readonly claude?: Plugins.ClaudeSlot
    /** The control Location, which alone writes the template diff (07 §4.4). */
    readonly control?: boolean
    /** Receives the log lines. */
    readonly logs?: string[]
  } = {},
) {
  const reloads: number[] = []
  const lists: number[] = []
  const alerts: Telemetry.AlertInput[] = []
  const forgotten: string[] = []
  const storage = memoryStorage()
  const t = await testDeps({
    ctx: {
      provider: {
        reload: async () => {
          reloads.push(1)
        },
        list: async () => {
          lists.push(1)
          return []
        },
      },
      storage: storage.storage,
    },
    control: input.control ?? false,
    logs: input.logs,
  })
  if (input.registry) await t.deps.runtime.registry.write(input.registry)
  const claude = { value: input.claude ?? CLAUDE_OFF }
  const modules = t.modules({
    plugins: (deps, peers) => ({ ...Modules.FACTORIES.plugins(deps, peers), claudeSlot: () => claude.value }),
    telemetry: (deps, peers) => ({ ...Modules.FACTORIES.telemetry(deps, peers), alert: (alert) => alerts.push(alert) }),
    logins: (deps, peers) => ({
      ...Modules.FACTORIES.logins(deps, peers),
      forget: async (account) => {
        forgotten.push(account.id)
        return { ok: true }
      },
      replaceKey: async (_account, key) =>
        key.includes("rejected")
          ? { ok: false, error: "probe_failed", message: "unauthorized", status: 401 }
          : { ok: true, keyHint: Hash.keyHint(key), detected: { organizationId: "org-new" } },
    }),
  })
  await modules.slots.start()
  return {
    t,
    modules,
    slots: modules.slots,
    kv: storage.values,
    reloads,
    lists,
    alerts,
    forgotten,
    claude,
    async [Symbol.asyncDispose]() {
      await modules.slots.stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

const OPENAI = [
  catalogModel("openai", "gpt-5.5"),
  catalogModel("openai", "gpt-5.4"),
  catalogModel("openai", "gpt-6-sol", { time: { released: 1_800_000_000_000 } }),
]

function newKeyAccount(kind: "oai" | "anth" | "ds", id: string, label = "key") {
  return {
    id: Account.ID.make(id),
    kind,
    label,
    identity: { keyHint: "sk-…9fQ2" },
    cacheDomain: { scope: "api_key" as const },
    quotaDomain: { scope: "api_key" as const },
  }
}

describe("slot registry in memory", () => {
  test("start loads the registry; slot() and account() answer from memory", async () => {
    const registry = await registryWith([
      { kind: "oai", label: "A", slug: "aaaa" },
      { kind: "codex", label: "C", slug: "cccc", identity: { chatgptAccountId: "acct" } },
    ])
    await using s = await setup({ registry })
    const slot = s.slots.slot("own-oai-aaaa")
    expect(slot).toMatchObject({ providerID: "own-oai-aaaa", kind: "oai", canonical: "openai", retired: false })
    expect<unknown>(slot?.account.id).toBe("acc_aaaa")
    expect(s.slots.slot("own-codex-cccc")?.canonical).toBe("openai")
    expect(s.slots.slot("openai")).toBeUndefined()
    expect(s.slots.slot("anthropic")).toBeUndefined()
    expect(s.slots.account("acc_cccc")?.kind).toBe("codex")
    expect(s.slots.snapshot().revision).toBe(1)
  })

  test("an unreadable accounts.json leaves no slots and is never overwritten", async () => {
    const t = await testDeps({ ctx: { provider: { reload: async () => {} } } })
    await using _t = t
    await Bun.write(t.deps.runtime.layout.accounts, "{ not json")
    const slots = Modules.FACTORIES.slots(t.deps, () => t.modules())
    await slots.start()
    expect(slots.snapshot().accounts).toEqual([])
    await slots.stop()
    expect(await Bun.file(t.deps.runtime.layout.accounts).text()).toBe("{ not json")
  })
})

describe("createAccount", () => {
  test("captures the kind's template from the fold snapshot and shares it with the next slot of the kind", async () => {
    await using s = await setup()
    const fold = fakeEditor({ openai: { models: OPENAI } })
    s.slots.transformProviders(fold.editor)
    const first = await s.slots.createAccount(newKeyAccount("oai", "acc_first", "업무"))
    if (!first.ok) throw new Error(first.reason)
    expect(first.account).toMatchObject({
      id: "acc_first",
      kind: "oai",
      label: "업무",
      shortLabel: "업",
      billing: "metered",
      autoSwitch: true,
      status: "ready",
      pollBalance: null,
      identity: { keyHint: "sk-…9fQ2" },
    })
    expect(first.account.providerID).toMatch(/^own-oai-[a-z0-9]{4,8}$/)
    expect(first.account).not.toHaveProperty("credential")
    const registry = s.slots.snapshot()
    const slot = registry.slots[first.account.providerID]
    expect(slot).toMatchObject({ kind: "oai", accounts: ["acc_first"], pooling: "off" })
    // A new session's model is the group default in presets.json (07 §2.2), never a slot field any more.
    expect(slot).not.toHaveProperty("defaultModel")
    expect(await s.modules.presets.defaultFor({ kind: "oai", providerID: first.account.providerID })).toEqual({
      providerID: first.account.providerID,
      id: "gpt-6-sol",
    })
    const template = registry.modelTemplates[slot?.modelTemplate ?? ""]
    expect(template).toMatchObject({ kind: "oai", source: "snapshot", sourceProvider: "openai" })
    expect(template?.models.map((model) => String(model.id))).toEqual(["gpt-5.5", "gpt-5.4", "gpt-6-sol"])
    expect(registry.cacheDomains[first.account.cacheDomain]).toEqual({
      kind: "oai",
      scope: "api_key",
      poolingVerified: false,
    })

    const second = await s.slots.createAccount(newKeyAccount("oai", "acc_second"))
    if (!second.ok) throw new Error(second.reason)
    const after = s.slots.snapshot()
    expect(second.account.providerID).not.toBe(first.account.providerID)
    expect(after.slots[second.account.providerID]?.modelTemplate).toBe(slot?.modelTemplate ?? "")
    expect(Object.keys(after.modelTemplates)).toHaveLength(1)
    expect(second.account.cacheDomain).not.toBe(first.account.cacheDomain)
    expect<unknown>(s.slots.slot(second.account.providerID)?.account.id).toBe("acc_second")
    await expect(s.slots.createAccount(newKeyAccount("oai", "acc_first"))).rejects.toThrow("already registered")
  })

  test("a registered slot shows up in the next fold with the snapshot's models", async () => {
    await using s = await setup()
    s.slots.transformProviders(fakeEditor({ openai: { models: OPENAI } }).editor)
    const created = await s.slots.createAccount(newKeyAccount("oai", "acc_fold"))
    if (!created.ok) throw new Error(created.reason)
    const fold = fakeEditor({ openai: { models: OPENAI } })
    s.slots.transformProviders(fold.editor)
    const record = fold.records.get(created.account.providerID)
    expect(record?.provider).toMatchObject({ activation: "enabled", canonical: "openai", name: "OpenAI · key" })
    expect([...(record?.models.keys() ?? [])]).toEqual(["gpt-5.5", "gpt-5.4", "gpt-6-sol"])
    // hideBuiltinProviders "auto" (policy default) hides the built-in openai once an oai account exists.
    expect(fold.records.get("openai")?.provider.activation).toBe("disabled")
  })

  test("same org external id shares the cache domain; the slot stays separate (R-ID-2)", async () => {
    await using s = await setup()
    s.slots.transformProviders(fakeEditor({ openai: { models: OPENAI } }).editor)
    const org = { scope: "openai_org" as const, externalId: "org-1" }
    const a = await s.slots.createAccount({ ...newKeyAccount("oai", "acc_org_a"), cacheDomain: org })
    const b = await s.slots.createAccount({ ...newKeyAccount("oai", "acc_org_b"), cacheDomain: org })
    if (!a.ok || !b.ok) throw new Error("create failed")
    expect(b.account.cacheDomain).toBe(a.account.cacheDomain)
    expect(b.account.providerID).not.toBe(a.account.providerID)
    const list = await s.slots.list({}, rpcContext<"accounts.list">())
    if (failure(list) || !("accounts" in list)) throw new Error("list failed")
    expect<unknown>(list.accounts.find((view) => view.id === "acc_org_a")?.cacheDomain).toEqual({
      id: a.account.cacheDomain,
      sharedWith: ["acc_org_b"],
    })
  })

  test("falls back to the bundled template when the anthropic snapshot lost its prices", async () => {
    await using s = await setup()
    s.slots.transformProviders(
      fakeEditor({ anthropic: { models: [catalogModel("anthropic", "claude-x", { cost: [] })] } }).editor,
    )
    const created = await s.slots.createAccount(newKeyAccount("anth", "acc_anth"))
    if (!created.ok) throw new Error(created.reason)
    const registry = s.slots.snapshot()
    const template = registry.modelTemplates[registry.slots[created.account.providerID]?.modelTemplate ?? ""]
    expect(template?.source).toBe("bundled")
    expect(template?.models.every((model) => model.cost.length > 0)).toBe(true)
  })

  test("unpriced metered models are left out with a template_cost_missing alert", async () => {
    await using s = await setup()
    s.slots.transformProviders(
      fakeEditor({
        deepseek: {
          models: [
            catalogModel("deepseek", "deepseek-v4-pro"),
            catalogModel("deepseek", "deepseek-free", { cost: [] }),
          ],
        },
      }).editor,
    )
    const created = await s.slots.createAccount(newKeyAccount("ds", "acc_ds"))
    if (!created.ok) throw new Error(created.reason)
    expect(created.account.pollBalance).toBe(true)
    expect(created.account.billing).toBe("prepaid")
    const registry = s.slots.snapshot()
    expect(
      registry.modelTemplates[registry.slots[created.account.providerID]?.modelTemplate ?? ""]?.models.map((m) =>
        String(m.id),
      ),
    ).toEqual(["deepseek-v4-pro"])
    expect(s.alerts.map((alert) => alert.code)).toEqual(["template_cost_missing"])
  })

  test("without any fold yet it forces one, then uses the bundled template", async () => {
    await using s = await setup()
    const created = await s.slots.createAccount({
      ...newKeyAccount("oai", "acc_codex"),
      kind: "codex",
      identity: { chatgptAccountId: "acct-9", fingerprint: "sha256:x" },
    })
    if (!created.ok) throw new Error(created.reason)
    expect(s.lists.length).toBe(1)
    expect(created.account).toMatchObject({ billing: "subscription", autoSwitch: false })
    const registry = s.slots.snapshot()
    expect(registry.slots[created.account.providerID]).toMatchObject({ kind: "codex", transport: "websocket" })
    expect(registry.modelTemplates[registry.slots[created.account.providerID]?.modelTemplate ?? ""]?.source).toBe(
      "bundled",
    )
  })

  test("compat builds its own template and keeps a linked credential ref", async () => {
    await using s = await setup()
    const compat = await s.slots.createAccount({
      ...newKeyAccount("oai", "acc_compat"),
      kind: "compat",
      baseURL: "http://127.0.0.1:8080/v1",
      compatModels: [{ id: "local-model", contextLimit: 64_000, cost: { input: 0.5, output: 1 } }],
    })
    if (!compat.ok) throw new Error(compat.reason)
    const registry = s.slots.snapshot()
    expect(registry.slots[compat.account.providerID]).toMatchObject({ baseURL: "http://127.0.0.1:8080/v1" })
    expect(registry.modelTemplates[registry.slots[compat.account.providerID]?.modelTemplate ?? ""]?.source).toBe("user")
    expect(
      await s.slots.createAccount({
        ...newKeyAccount("oai", "acc_compat2"),
        kind: "compat",
        compatModels: [{ id: "m" }],
      }),
    ).toEqual({ ok: false, error: "template_unavailable", reason: "compat_context_required:m" })
  })
})

describe("mutate and reconcile (02 §3.8)", () => {
  test("a change bumps the revision, broadcasts store.changed and reloads providers; no change does nothing", async () => {
    const registry = await registryWith([{ kind: "oai", label: "A", slug: "aaaa" }])
    await using s = await setup({ registry })
    const seen: unknown[] = []
    const off = s.t.deps.runtime.broadcast.on("store.changed", (payload) => seen.push(payload))
    const before = s.slots.snapshot().revision
    const next = await s.slots.mutate((current) => ({
      ...current,
      accounts: current.accounts.map((account) => ({ ...account, label: "B" })),
    }))
    expect(next.revision).toBe(before + 1)
    expect(s.slots.account("acc_aaaa")?.label).toBe("B")
    expect(seen).toEqual([{ store: "accounts", origin: "local", revision: before + 1 }])
    await Bun.sleep(0)
    expect(s.reloads.length).toBeGreaterThan(0)
    await s.slots.mutate(() => undefined)
    expect(seen).toHaveLength(1)
    off()
  })

  test("a change written by another instance is adopted from the process cache", async () => {
    const registry = await registryWith([{ kind: "oai", label: "A", slug: "aaaa" }])
    await using s = await setup({ registry })
    const written = await s.t.deps.runtime.registry.update((current) => ({
      ...current,
      accounts: current.accounts.map((account) => ({ ...account, color: "rose" as const })),
    }))
    s.t.deps.runtime.broadcast.emit("store.changed", { store: "accounts", origin: "local", revision: written.revision })
    expect(s.slots.account("acc_aaaa")?.color).toBe("rose")
    expect(s.slots.snapshot().revision).toBe(written.revision)
  })

  test("the Claude slot and policy changes reload providers; the fold follows the ack", async () => {
    await using s = await setup()
    const fold = () => {
      const editor = fakeEditor({ anthropic: { info: { activation: "auto" } } })
      s.slots.transformProviders(editor.editor)
      return editor.records.get("anthropic")?.provider.activation
    }
    expect(fold()).toBe("disabled")
    s.claude.value = { detected: true, version: "0.4.0", integrity: "sha512-x", verified: false }
    expect(fold()).toBe("disabled")
    s.claude.value = { ...s.claude.value, verified: true }
    s.t.deps.runtime.broadcast.emit("claudeSlot.changed", { reason: "ack" })
    expect(fold()).toBe("auto")
    await Bun.sleep(0)
    expect(s.reloads.length).toBe(1)

    await s.t.deps.runtime.policy.write({
      ...(await s.t.deps.runtime.policy.read()),
      hideBuiltinProviders: [Provider.ID.make("xai")],
    })
    s.t.deps.runtime.broadcast.emit("store.changed", { store: "policy", origin: "local" })
    await Bun.sleep(0)
    const editor = fakeEditor({ xai: { info: { activation: "auto" } } })
    s.slots.transformProviders(editor.editor)
    expect(editor.records.get("xai")?.provider.activation).toBe("disabled")
  })

  test("the leader broadcasts an external change of accounts.json once, and ignores its own writes", async () => {
    const registry = await registryWith([{ kind: "oai", label: "A", slug: "aaaa" }])
    await using s = await setup({ registry })
    const seen: Array<{ readonly store: string; readonly origin: string }> = []
    const off = s.t.deps.runtime.broadcast.on("store.changed", (payload) => seen.push(payload))
    const clock = s.t.clock
    // Own write: content equals the process cache, so nothing is broadcast as external.
    await s.slots.mutate((current) => ({ ...current, accounts: current.accounts.map((a) => ({ ...a, label: "own" })) }))
    await waitForWatcher(clock)
    expect(seen.filter((item) => item.origin === "external")).toEqual([])
    // Another process rewrites the file.
    const external = { ...s.slots.snapshot(), revision: s.slots.snapshot().revision + 5 }
    const text = JSON.stringify({ ...external, accounts: external.accounts.map((a) => ({ ...a, label: "external" })) })
    await fs.writeFile(s.t.deps.runtime.layout.accounts, text)
    await waitForWatcher(clock)
    expect<unknown>(seen.filter((item) => item.origin === "external")).toEqual([
      { store: "accounts", origin: "external", revision: external.revision },
    ])
    expect(s.slots.account("acc_aaaa")?.label).toBe("external")
    off()
  })
})

describe("account RPCs", () => {
  test("views pair a codex account with the same login's siwc account: one subscription (07 §5.4 R4)", async () => {
    const login = Hash.fingerprint("acct-same", "user-same")
    const registry = await registryWith([
      {
        kind: "codex",
        label: "ChatGPT 01",
        slug: "c201",
        identity: { chatgptAccountId: "acct-same", fingerprint: login },
      },
      {
        kind: "siwc",
        label: "ChatGPT 01 앱",
        slug: "s201",
        identity: { fingerprint: Hash.fingerprint("oaiapp_same", "user-same"), login },
      },
      {
        kind: "codex",
        label: "ChatGPT 02",
        slug: "c202",
        identity: { fingerprint: Hash.fingerprint("acct-2", "user-2") },
      },
    ])
    const [codex, siwc, other] = registry.accounts.map((info) => Views.account(registry, info, []))
    if (!codex || !siwc || !other) throw new Error("missing views")
    expect(Preset.loginOf(codex)).toBe(login)
    expect(Preset.oneSubscription(codex, siwc)).toBe(true)
    expect(Preset.oneSubscription(codex, other)).toBe(false)
    expect(Preset.oneSubscription(siwc, other)).toBe(false)
  })

  test("accounts.list returns views without guard identity facts, plus the Claude slot when installed", async () => {
    const registry = await registryWith([
      {
        kind: "codex",
        label: "업무",
        slug: "c111",
        identity: { chatgptAccountId: "acct-1", fingerprint: "sha256:fp", emailMasked: "na***@x", plan: "plus" },
        credential: {
          type: "linked-codex-source",
          source: { app: "codex-multi-provider", profileID: "02", alias: "개인", authPath: "C:\\fake\\auth.json" },
          linkedAt: "2026-09-27T00:00:00Z",
        },
      },
      { kind: "oai", label: "API", slug: "o111", identity: { keyHint: "sk-…abcd" } },
    ])
    await using s = await setup({
      registry,
      claude: { detected: true, version: "0.4.0", integrity: "i", verified: false },
    })
    const result = await s.slots.list({}, rpcContext<"accounts.list">())
    if (failure(result) || !("accounts" in result)) throw new Error("list failed")
    expect(result.revision).toBe(s.slots.snapshot().revision)
    const [codex, oai, claude] = result.accounts
    expect(codex).toMatchObject({
      id: "acc_c111",
      identity: { emailMasked: "na***@x", plan: "plus" },
      connection: {
        type: "oauth",
        method: "codex-linked",
        source: { app: "codex-multi-provider", profileID: "02", alias: "개인", mode: "linked", superseded: false },
      },
      thirdParty: false,
      readOnly: false,
      limitsSummary: { worst: null },
    })
    expect(codex?.identity).not.toHaveProperty("chatgptAccountId")
    expect(codex?.identity).not.toHaveProperty("fingerprint")
    // 07 §5.4 R4: a codex fingerprint is its ChatGPT login, which the view carries for own.team's and own-web's lookups.
    expect(codex?.identity).toMatchObject({ login: "sha256:fp" })
    expect(oai).toMatchObject({ connection: { type: "key", method: "api-key" }, identity: { keyHint: "sk-…abcd" } })
    expect(claude).toMatchObject({
      id: "acc_claude_slot",
      kind: "claude-sub",
      providerID: "anthropic",
      status: "unverified",
      thirdParty: true,
      readOnly: true,
      plugin: { installed: true, acknowledged: false, version: "0.4.0" },
    })
    expect(JSON.stringify(result)).not.toContain("auth.json")
    expect(oai?.lastUsedAt).toBeNull()

    // `lastUsedAt` follows the newest ledger line of the account seen in this process.
    // SAFETY: slots reads only `accountID` and `ts` of a line.
    const line = (ts: number) => ({ accountID: "acc_o111", ts }) as unknown as Ledger.Line
    s.t.deps.runtime.broadcast.emit("ledger.line", { eid: "e1", line: line(1_790_000_000_000) })
    s.t.deps.runtime.broadcast.emit("ledger.line", { eid: "e0", line: line(1_789_000_000_000) })
    const later = await s.slots.list({}, rpcContext<"accounts.list">())
    if (failure(later) || !("accounts" in later)) throw new Error("list failed")
    expect(later.accounts.find((item) => item.id === "acc_o111")?.lastUsedAt).toBe(1_790_000_000_000)
    expect(later.accounts.find((item) => item.id === "acc_c111")?.lastUsedAt).toBeNull()
  })

  test("accounts.update changes display fields, enables/disables, and denies what the kind does not have", async () => {
    const registry = await registryWith([{ kind: "oai", label: "A", slug: "aaaa" }])
    await using s = await setup({ registry })
    const context = rpcContext<"accounts.update">()
    const updated = await s.slots.update(
      { accountID: "acc_aaaa" as never, label: "New", color: "teal", enabled: false },
      context,
    )
    expect(failure(updated)).toBeUndefined()
    expect(s.slots.account("acc_aaaa")).toMatchObject({ label: "New", color: "teal", status: "disabled" })
    const fold = fakeEditor()
    s.slots.transformProviders(fold.editor)
    expect([...(fold.records.get("own-oai-aaaa")?.models.values() ?? [])].every((model) => !model.enabled)).toBe(true)
    await s.slots.update({ accountID: "acc_aaaa" as never, enabled: true }, context)
    expect(s.slots.account("acc_aaaa")?.status).toBe("ready")

    expect(
      failure(await s.slots.update({ accountID: "acc_aaaa" as never, pollBalance: false }, context)),
    ).toMatchObject({
      type: "policy_denied",
      data: { field: "pollBalance" },
    })
    expect(failure(await s.slots.update({ accountID: "acc_none" as never, label: "x" }, context))).toMatchObject({
      type: "account_not_found",
    })
    const replaced = await s.slots.update(
      { accountID: "acc_aaaa" as never, replaceKey: "sk-fake-replacement-000000001234" },
      context,
    )
    expect(failure(replaced)).toBeUndefined()
    expect(s.slots.account("acc_aaaa")?.identity).toMatchObject({ keyHint: "sk-…1234", organizationId: "org-new" })
    expect(JSON.stringify(replaced)).not.toContain("sk-fake-replacement")
    // A rejected replacement is the declared `probe_failed` (HTTP 400), and the stored key hint stays.
    const rejected = await s.slots.update(
      { accountID: "acc_aaaa" as never, replaceKey: "sk-fake-rejected-0000000000009999" },
      context,
    )
    expect(failure(rejected)).toMatchObject({ type: "probe_failed", data: { status: 401, message: "unauthorized" } })
    expect(s.slots.account("acc_aaaa")?.identity).toMatchObject({ keyHint: "sk-…1234" })
  })

  test("accounts.update{refreshCatalog} re-pins every slot of the kind to a new template", async () => {
    const registry = await registryWith([
      { kind: "oai", label: "A", slug: "aaaa" },
      { kind: "oai", label: "B", slug: "bbbb" },
    ])
    await using s = await setup({ registry })
    s.slots.transformProviders(
      fakeEditor({ openai: { models: [catalogModel("openai", "gpt-new", { cost: [price(2, 8)] })] } }).editor,
    )
    const result = await s.slots.update(
      { accountID: "acc_aaaa" as never, refreshCatalog: true },
      rpcContext<"accounts.update">(),
    )
    expect(failure(result)).toBeUndefined()
    const after = s.slots.snapshot()
    const ids = new Set(Object.values(after.slots).map((slot) => slot.modelTemplate))
    expect(ids.size).toBe(1)
    const [id] = [...ids]
    expect(after.modelTemplates[id ?? ""]?.models.map((model) => String(model.id))).toEqual(["gpt-new"])
    expect(Object.keys(after.modelTemplates)).toEqual([id ?? ""])
  })

  test("remove: plan is side-effect free, disable keeps the vault, delete shreds and retires the slot", async () => {
    const registry = await registryWith([
      { kind: "oai", label: "A", slug: "aaaa" },
      {
        kind: "codex",
        label: "L",
        slug: "llll",
        credential: {
          type: "linked-codex-source",
          source: { app: "codex-multi-provider", profileID: "01", alias: null, authPath: "C:\\fake\\auth.json" },
          linkedAt: "2026-09-27T00:00:00Z",
        },
      },
    ])
    await using s = await setup({ registry })
    const linkedPlan = await s.slots.removePlan(
      { accountID: "acc_llll" as never, mode: "delete" },
      rpcContext<"accounts.remove.plan">(),
    )
    expect(linkedPlan).toMatchObject({ willShredVault: false, affectedSessions: [] })

    const plan = await s.slots.removePlan(
      { accountID: "acc_aaaa" as never, mode: "delete" },
      rpcContext<"accounts.remove.plan">(),
    )
    if (failure(plan) || !("nonce" in plan)) throw new Error("plan failed")
    expect(plan.willShredVault).toBe(true)
    expect(s.forgotten).toEqual([])
    expect(s.slots.account("acc_aaaa")?.status).toBe("ready")

    const executed = await s.slots.removeExecute({ nonce: plan.nonce }, rpcContext<"accounts.remove.execute">())
    expect(failure(executed)).toBeUndefined()
    expect(s.forgotten).toEqual(["acc_aaaa"])
    expect(s.slots.account("acc_aaaa")?.status).toBe("retired")
    expect(s.slots.snapshot().slots["own-oai-aaaa"]?.retired).toBe(true)
    expect(s.slots.slot("own-oai-aaaa")?.retired).toBe(true)
    // The provider id stays registered with every model disabled (R-ID-3).
    const fold = fakeEditor()
    s.slots.transformProviders(fold.editor)
    expect(fold.records.get("own-oai-aaaa")?.provider.activation).toBe("enabled")
    expect([...(fold.records.get("own-oai-aaaa")?.models.values() ?? [])].some((model) => model.enabled)).toBe(false)

    expect(
      failure(await s.slots.removeExecute({ nonce: plan.nonce }, rpcContext<"accounts.remove.execute">())),
    ).toMatchObject({
      type: "nonce_invalid",
    })
    expect(
      failure(
        await s.slots.removePlan(
          { accountID: "acc_aaaa" as never, mode: "delete" },
          rpcContext<"accounts.remove.plan">(),
        ),
      ),
    ).toMatchObject({ type: "account_not_found" })
    expect(
      failure(
        await s.slots.removePlan(
          { accountID: Account.ID.claudeSlot, mode: "delete" },
          rpcContext<"accounts.remove.plan">(),
        ),
      ),
    ).toMatchObject({ type: "policy_denied" })
  })
})

describe("live catalog values (07 §4.4, §6.2 #4–#6)", () => {
  test("each fold registers the catalog window; the pinned template keeps only what reaches the request", async () => {
    const ids = ["gpt-6.1-sol", "gpt-6-astra"]
    const api = { context: 1_050_000, input: 922_000, output: 128_000 }
    // A Codex template pinned before T0: every model at the 272k subscription default.
    const pinned = Templates.fromCatalog(
      "codex",
      ids.map((id) => catalogModel("openai", id, { limit: { context: 400_000, input: 272_000, output: 128_000 } })),
      "2026-09-28T00:00:00Z",
    )
    if (!pinned.ok) throw new Error(pinned.reason)
    const base = await registryWith([{ kind: "codex", label: "P", slug: "pppp" }])
    await using s = await setup({ registry: { ...base, modelTemplates: { tpl_codex_test: pinned.template } } })
    const fold = (limit: typeof api) => {
      const editor = fakeEditor({ openai: { models: ids.map((id) => catalogModel("openai", id, { limit })) } })
      s.slots.transformProviders(editor.editor)
      const models = [...(editor.records.get("own-codex-pppp")?.models.values() ?? [])]
      return Object.fromEntries(models.map((model) => [model.id, model.limit.input]))
    }
    expect(fold(api)).toEqual({ "gpt-6.1-sol": 922_000, "gpt-6-astra": 872_000 })
    expect(s.slots.compaction("own-codex-pppp", "gpt-6.1-sol")?.triggerTokens).toBe(783_700)
    expect(s.slots.compaction("own-codex-pppp", "gpt-6-astra")?.triggerTokens).toBe(741_200)
    const list = await s.slots.list({}, rpcContext<"accounts.list">())
    if (failure(list) || !("accounts" in list)) throw new Error("list failed")
    expect(list.accounts[0]?.compaction?.effective.map((item) => [String(item.modelID), item.triggerTokens])).toEqual([
      ["gpt-6.1-sol", 783_700],
      ["gpt-6-astra", 741_200],
    ])

    // A catalog change reaches the next registration; the pinned template stays as it was.
    expect(fold({ ...api, input: 500_000 })["gpt-6.1-sol"]).toBe(500_000)
    expect(s.slots.compaction("own-codex-pppp", "gpt-6.1-sol")?.triggerTokens).toBe(425_000)
    expect(s.slots.model("own-codex-pppp", "gpt-6.1-sol")?.limit.input).toBe(500_000)
    expect(s.slots.snapshot().modelTemplates.tpl_codex_test).toEqual(pinned.template)
  })

  test("siwc stays plan-billed and takes the live API window, also over a lowered template (02 §3.2c, R8)", async () => {
    const bundled = await Templates.bundled("siwc")
    if (!bundled) throw new Error("no bundled siwc template")
    // An older build lowered gpt-5.5 to the 272k its account catalog named; upstream reads no such window (209346a0fe).
    const plan: ChatgptSharing.RemoteModel = {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      visibility: "list",
      context_window: 272_000,
      input_modalities: ["text"],
    }
    expect(ChatgptSharing.deriveModels([plan], bundled, "2026-10-01T00:00:00Z")).toBeUndefined()
    const lowered = {
      ...bundled,
      models: bundled.models.map((model) =>
        model.id === "gpt-5.5" ? { ...model, limit: { context: 272_000, input: 272_000, output: 128_000 } } : model,
      ),
    }
    const base = await registryWith([{ kind: "siwc", label: "S", slug: "ssss" }])
    await using s = await setup({ registry: { ...base, modelTemplates: { tpl_siwc_test: lowered } } })
    const fold = (limit: { context: number; input: number; output: number }) => {
      const editor = fakeEditor({
        openai: { models: ["gpt-5.5", "gpt-5.6-sol"].map((id) => catalogModel("openai", id, { limit })) },
      })
      s.slots.transformProviders(editor.editor)
      return [...(editor.records.get("own-siwc-ssss")?.models.values() ?? [])]
    }
    const api = { context: 1_050_000, input: 922_000, output: 128_000 }
    const models = fold(api)
    const gpt55 = models.find((item) => item.id === "gpt-5.5")
    expect(gpt55?.limit).toEqual(api)
    expect(gpt55?.cost).toEqual([])
    expect(s.slots.model("own-siwc-ssss", "gpt-5.5")?.cost).toEqual([])
    expect(s.slots.compaction("own-siwc-ssss", "gpt-5.5")?.triggerTokens).toBe(783_700)
    // The window follows the live catalog both ways, like every catalog kind (07 §4.4).
    const larger = fold({ context: 2_000_000, input: 1_900_000, output: 128_000 })
    expect(larger.find((item) => item.id === "gpt-5.6-sol")?.limit.input).toBe(1_900_000)
    expect(larger.find((item) => item.id === "gpt-5.5")?.limit.input).toBe(1_900_000)
  })

  test("a slot the live catalog cannot build is logged and left out; the other slots and the fold's rules still apply", async () => {
    const registry = await registryWith([
      { kind: "codex", label: "C", slug: "cbad" },
      { kind: "ds", label: "D", slug: "dgood" },
    ])
    const logs: string[] = []
    await using s = await setup({ registry, logs })
    // Another fold left an `openai` entry malformed: reading its limit throws for every slot built from `openai`.
    const broken = Object.defineProperty(catalogModel("openai", "gpt-5.6-sol"), "limit", {
      get: () => {
        throw new Error("catalog limit unreadable")
      },
    })
    const fold = fakeEditor({
      openai: { info: { activation: "auto" }, models: [broken] },
      deepseek: { info: { activation: "auto" }, models: [catalogModel("deepseek", "deepseek-chat")] },
      anthropic: { info: { activation: "auto" }, models: [catalogModel("anthropic", "claude-a")] },
    })
    expect(() => s.slots.transformProviders(fold.editor)).not.toThrow()
    expect(fold.records.has("own-codex-cbad")).toBe(false)
    expect(fold.records.get("own-ds-dgood")?.models.size).toBeGreaterThan(0)
    // The built-in hiding (`auto`: the kinds in use) and the Claude slot rule ran in the same fold.
    expect(fold.records.get("openai")?.provider.activation).toBe("disabled")
    expect(fold.records.get("deepseek")?.provider.activation).toBe("disabled")
    expect(fold.records.get("anthropic")?.provider.activation).toBe("disabled")
    const failed = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "slot_fold_failed")
    expect(failed).toEqual([expect.objectContaining({ providerID: "own-codex-cbad", reason: "definition_failed" })])
    // The next fold with a usable catalog registers the slot again.
    const healed = fakeEditor({ openai: { models: [catalogModel("openai", "gpt-5.5")] } })
    s.slots.transformProviders(healed.editor)
    expect(healed.records.get("own-codex-cbad")?.models.size).toBeGreaterThan(0)
  })
})

describe("pinned template diff (07 §4.4)", () => {
  const CODEX = ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol"]
  const API = { context: 1_050_000, input: 922_000, output: 128_000 }

  /** A Codex account whose template was pinned before gpt-6.1-sol, on the control Location unless told otherwise. */
  async function codexSetup(control = true) {
    const pinned = Templates.fromCatalog(
      "codex",
      CODEX.map((id) => catalogModel("openai", id)),
      "2026-09-28T00:00:00Z",
    )
    if (!pinned.ok) throw new Error(pinned.reason)
    const base = await registryWith([{ kind: "codex", label: "P", slug: "pppp" }])
    const s = await setup({ registry: { ...base, modelTemplates: { tpl_codex_test: pinned.template } }, control })
    const writes = { count: 0 }
    const registry = s.t.deps.runtime.registry
    const update = registry.update.bind(registry)
    registry.update = (change) => {
      writes.count++
      return update(change)
    }
    /** One provider fold over these `openai` catalog models; returns the slot's registered models. */
    const fold = (models: ReadonlyArray<Model.Info>) => {
      const editor = fakeEditor({ openai: { models } })
      expect(s.slots.transformProviders(editor.editor)).toBeUndefined()
      return [...(editor.records.get("own-codex-pppp")?.models.values() ?? [])]
    }
    return Object.assign(s, { pinned: pinned.template, writes, fold })
  }

  type Rig = Awaited<ReturnType<typeof codexSetup>>

  const catalog = (ids: ReadonlyArray<string>, extra: Partial<Model.Info> = {}) =>
    ids.map((id) => catalogModel("openai", id, { limit: API, ...extra }))

  const template = (s: Rig) => s.slots.snapshot().modelTemplates.tpl_codex_test

  const view = async (s: Rig) => {
    const list = await s.slots.list({}, rpcContext<"accounts.list">())
    if (failure(list) || !("accounts" in list)) throw new Error("list failed")
    return list.accounts.find((item) => item.id === "acc_pppp")
  }

  const iso = (s: Rig) => new Date(s.t.clock.now()).toISOString().replace(/\.\d{3}Z$/, "Z")

  test("a new catalog id is written after the fold with addedAt; nothing else changes", async () => {
    await using s = await codexSetup()
    s.fold(catalog(CODEX))
    const before = s.slots.snapshot()
    const defaultModel = await s.modules.presets.defaultFor({ kind: "codex", providerID: "own-codex-pppp" })
    await settle()
    expect(s.writes.count).toBe(0)

    // The fold itself is synchronous and writes nothing; it registers the template as pinned.
    const registered = s.fold(catalog([...CODEX, "gpt-6.1-sol"]))
    expect(s.writes.count).toBe(0)
    expect(s.slots.snapshot()).toBe(before)
    expect(registered.map((model) => String(model.id))).toEqual(CODEX)

    await until(() => s.slots.snapshot().revision > before.revision)
    const at = iso(s)
    const models = template(s)?.models ?? []
    expect<unknown>(models.slice(0, 3)).toEqual(s.pinned.models)
    expect(models[3]).toMatchObject({ id: "gpt-6.1-sol", addedAt: at, cost: [], enabled: true })
    expect(template(s)).not.toHaveProperty("update")
    expect({ ...s.slots.snapshot(), revision: 0, modelTemplates: {} }).toEqual({
      ...before,
      revision: 0,
      modelTemplates: {},
    })

    // The next fold registers it with the catalog window (07 §6.2 #4: 922k -> 783,700); core never sees the mark.
    const next = s.fold(catalog([...CODEX, "gpt-6.1-sol"]))
    const added = next.find((model) => model.id === "gpt-6.1-sol")
    expect(added).toMatchObject({ enabled: true, limit: API, cost: [] })
    expect(added).not.toHaveProperty("addedAt")
    expect(s.slots.compaction("own-codex-pppp", "gpt-6.1-sol")?.triggerTokens).toBe(783_700)
    expect<unknown>((await view(s))?.models).toEqual([{ id: "gpt-6.1-sol", addedAt: at }])

    // No binding, preset, lighter pair or group default moves to it.
    expect(await s.modules.presets.defaultFor({ kind: "codex", providerID: "own-codex-pppp" })).toEqual(defaultModel)
    expect(await Bun.file(s.t.deps.runtime.layout.presets).exists()).toBe(false)
    expect(s.kv.size).toBe(0)
    expect(s.alerts).toEqual([])

    // The same catalog again: nothing more to write.
    const writes = s.writes.count
    s.fold(catalog([...CODEX, "gpt-6.1-sol"]))
    await settle()
    expect(s.writes.count).toBe(writes)
  })

  test("a vanished id stays, marked missing upstream and running as deprecated, until it comes back", async () => {
    await using s = await codexSetup()
    const start = s.slots.snapshot().revision
    s.fold(catalog(["gpt-6-sol", "gpt-6-astra"]))
    await until(() => s.slots.snapshot().revision > start)
    expect(template(s)?.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({ upstream: "missing" })
    expect(template(s)?.models.map((model) => String(model.id))).toEqual(CODEX)
    expect(s.slots.model("own-codex-pppp", "gpt-5.6-sol")).toMatchObject({ enabled: true, status: "deprecated" })
    const registered = s.fold(catalog(["gpt-6-sol", "gpt-6-astra"])).find((model) => model.id === "gpt-5.6-sol")
    // Still registered and enabled, so a session on it keeps running (U3); `deprecated` keeps pickers off it.
    expect(registered).toMatchObject({ enabled: true, status: "deprecated" })
    expect(registered).not.toHaveProperty("upstream")
    expect<unknown>((await view(s))?.models).toEqual([{ id: "gpt-5.6-sol", upstream: "missing" }])
    // Repair notices are 07 §4.3's (presets); the diff raises none.
    expect(s.alerts).toEqual([])

    const marked = s.slots.snapshot().revision
    s.fold(catalog(CODEX))
    await until(() => s.slots.snapshot().revision > marked)
    expect(template(s)?.models).toEqual(s.pinned.models)
    expect(s.slots.model("own-codex-pppp", "gpt-5.6-sol")).toMatchObject({ enabled: true, status: "active" })
    expect((await view(s))?.models).toBeUndefined()
  })

  test("live limit, price, status and release date register without a template rewrite", async () => {
    await using s = await codexSetup()
    const registered = s.fold(catalog(CODEX, { status: "beta", time: { released: 42 }, cost: [price(3, 9)] }))
    await settle()
    expect(s.writes.count).toBe(0)
    expect(template(s)).toEqual(s.pinned)
    expect(registered.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
      status: "beta",
      time: { released: 42 },
      cost: [],
    })
  })

  test("a fixed-field change flags template.update once, with one alert; refreshCatalog clears it", async () => {
    await using s = await codexSetup()
    const start = s.slots.snapshot().revision
    const renamed = [
      ...catalog(CODEX).map((model) => (model.id === "gpt-6-sol" ? { ...model, name: "GPT-6 Sol" } : model)),
      ...catalog(["gpt-6.1-sol"]),
    ]
    const registered = s.fold(renamed)
    await until(() => s.slots.snapshot().revision > start)
    const at = iso(s)
    expect(template(s)?.update).toEqual({ detectedAt: at, fields: ["name"] })
    // The name reaches the request bytes, so it stays pinned until the user applies the update.
    expect(registered.find((model) => model.id === "gpt-6-sol")?.name).toBe("GPT-6-SOL")
    expect(s.alerts.map((alert) => [alert.code, alert.severity])).toEqual([["template_update_available", "info"]])
    expect(await view(s)).toMatchObject({ templateUpdate: { detectedAt: at, fields: ["name"] } })

    s.t.clock.advance(60_000)
    const writes = s.writes.count
    s.fold(renamed)
    await settle()
    expect(s.writes.count).toBe(writes)
    expect(s.alerts).toHaveLength(1)

    const result = await s.slots.update(
      { accountID: "acc_pppp" as never, refreshCatalog: true },
      rpcContext<"accounts.update">(),
    )
    expect(failure(result)).toBeUndefined()
    const refreshed = s.slots.snapshot()
    const current = refreshed.modelTemplates[refreshed.slots["own-codex-pppp"]?.modelTemplate ?? ""]
    expect(current).not.toHaveProperty("update")
    expect(current?.models.find((model) => model.id === "gpt-6-sol")?.name).toBe("GPT-6 Sol")
    // The model the diff added keeps its `새` tag through the refresh.
    expect(current?.models.find((model) => model.id === "gpt-6.1-sol")?.addedAt).toBe(at)
    const after = await view(s)
    expect(after).not.toHaveProperty("templateUpdate")
    expect<unknown>(after?.models).toEqual([{ id: "gpt-6.1-sol", addedAt: at }])
    await settle()
    expect(s.alerts).toHaveLength(1)
  })

  test("only the control Location writes", async () => {
    await using s = await codexSetup(false)
    s.fold(catalog([...CODEX, "gpt-6.1-sol"]))
    await settle()
    expect(s.writes.count).toBe(0)
    expect(template(s)).toEqual(s.pinned)
  })

  test("siwc: diffed against its sharing set like every kind; a non-sharing id is never added", async () => {
    const bundled = await Templates.bundled("siwc")
    if (!bundled) throw new Error("no bundled siwc template")
    await using s = await setup({
      registry: await registryWith([{ kind: "siwc", label: "S", slug: "ssss" }]),
      control: true,
    })
    const start = s.slots.snapshot().revision
    const editor = fakeEditor({
      openai: {
        models: [
          ...bundled.models
            .filter((model) => model.id !== "gpt-5.6-terra-fast")
            .map((model) => catalogModel("openai", model.id, { ...model, limit: API, cost: [price(2, 8)] })),
          catalogModel("openai", "gpt-6.2-sol"),
        ],
      },
    })
    s.slots.transformProviders(editor.editor)
    // Plan-billed whatever the priced catalog says, with the catalog's window (merged Templates.live rule).
    const gpt55 = editor.records.get("own-siwc-ssss")?.models.get("gpt-5.5")
    expect(gpt55?.cost).toEqual([])
    expect(gpt55?.limit).toEqual(API)
    await until(() => s.slots.snapshot().revision > start)
    const written = s.slots.snapshot().modelTemplates.tpl_siwc_test
    expect(written?.models.map((model) => String(model.id))).toEqual(bundled.models.map((model) => String(model.id)))
    expect(written?.models.filter((model) => model.upstream).map((model) => String(model.id))).toEqual([
      "gpt-5.6-terra-fast",
    ])
    expect(written).not.toHaveProperty("update")
  })
})

describe("setup reads", () => {
  test("a second Location's instance starts from the stores the first one read", async () => {
    await using t = await testDeps({
      ctx: { provider: { reload: async () => {}, list: async () => [] }, storage: memoryStorage().storage },
    })
    // Written around the runtime, so its stores start without a cached copy.
    const registry = await registryWith([{ kind: "oai", label: "A", slug: "aaaa" }])
    await Store.accounts({ layout: t.deps.runtime.layout, mutex: new Lock.Mutex() }).write(registry)
    const reads = { policy: 0, registry: 0, ratecards: 0 }
    const count = <T>(name: keyof typeof reads, store: { read: () => Promise<T> }) => {
      const read = store.read.bind(store)
      store.read = () => {
        reads[name]++
        return read()
      }
    }
    count("policy", t.deps.runtime.policy)
    count("registry", t.deps.runtime.registry)
    count("ratecards", t.deps.runtime.ratecards)
    const other = { ...t.deps, location: { directory: path.join(t.home, "other"), control: false } }
    const instances = [t.deps, other].map((deps) => Modules.create(deps))
    for (const modules of instances)
      for (const name of ["slots", "logins", "telemetry", "switching"] as const) await modules[name].start()
    expect(reads).toEqual({ policy: 1, registry: 1, ratecards: 1 })
    expect<unknown>(instances.map((modules) => modules.slots.slot("own-oai-aaaa")?.account.id)).toEqual([
      "acc_aaaa",
      "acc_aaaa",
    ])
    for (const modules of instances)
      for (const name of ["switching", "telemetry", "logins", "slots"] as const) await modules[name].stop()
  })
})

describe("store fallbacks", () => {
  test("an empty home starts with an empty registry", async () => {
    await using s = await setup()
    expect(s.slots.snapshot()).toEqual(Store.emptyRegistry())
  })
})

/** Lets background work a fold started (the template diff write) run to its end. */
async function settle() {
  for (const _ of Array.from({ length: 5 })) await Bun.sleep(10)
}

async function until(probe: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
  await settle()
}

/** Lets the fs watcher report, then fires the debounce timer on the manual clock and lets the check finish. */
async function waitForWatcher(clock: { advance(ms: number): void }) {
  for (const _ of Array.from({ length: 20 })) {
    await Bun.sleep(25)
    clock.advance(StoreWatch.DEBOUNCE_MS)
  }
  await Bun.sleep(50)
}
