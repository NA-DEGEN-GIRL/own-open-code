// 07 PG2 on a remote service (T3, the unit/integration half; the real host is T3.17): a fake local broker hands the
// remote mirror a view of this PC's registry (ChatGPT 01–03, Sign in with ChatGPT on login 01 and on an unknown
// login, an OpenAI key, DeepSeek) with its presets.json and budget verdicts; the remote service runs its real slots,
// presets and switching modules over that mirror. Covered: (가) a model the LLM writes, (라) a hand-edited
// presets.json, (바) a team session's switches and team context, the money rule from the mirrored verdicts (fail
// closed without one), `session.preset.apply{team}` with a mirrored preset, `presets.list` without repairs, and the
// methods that stay the local PC's. Sessions and agents are fakes, the own service is a fake on 127.0.0.1, every
// account and login is fake.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Schema } from "effect"
import { Account, Kind, OwnAccounts, Policy, Preset, type Broker } from "@own/protocol"
import { ServiceTarget } from "@own/runtime"
import { Mirror } from "../../src/broker/mirror.js"
import { Logger } from "../../src/logger.js"
import { Modules } from "../../src/modules.js"
import { Presets } from "../../src/presets/presets.js"
import { PresetBinding } from "../../src/presets/binding.js"
import { PresetStore } from "../../src/presets/store.js"
import type { Client } from "../../src/remote/client.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { RemoteMirror } from "../../src/remote/mirror.js"
import { Register } from "../../src/rpc/register.js"
import type { RpcTypes } from "../../src/rpc/types.js"
import type { Variant } from "../../src/switching/variant.js"
import type { Telemetry } from "../../src/telemetry/telemetry.js"
import { failure, fakeEditor, memoryStorage, rpcContext } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { messagesOver } from "../support/session-messages.js"
import { partial, seedCards } from "../switching/support.js"
import {
  CHATGPT_01,
  CHATGPT_02,
  CLAUDE_OFF,
  CODEX_A,
  CODEX_B,
  DEEPSEEK,
  DEEPSEEK_KEY,
  DS,
  OAI,
  OPENAI,
  OPENAI_KEY,
  SEATS,
  SIWC_01,
  SIWC_A,
  registry,
} from "../presets/fixtures/catalog-2026-10-01.js"

// Each test boots real modules on a temp OWN_HOME and a loopback server.
setDefaultTimeout(30_000)

const WORKSPACE = process.platform === "win32" ? "C:\\work\\remote" : "/work/remote"
const LOGIN_03 = `sha256:${"3".repeat(64)}`
const CHATGPT_03 = Account.ID.make("acc_cccc")
const CODEX_C = Kind.ProviderID.from("codex", "cccc")
const ROOT = "ses_remote_root"
const MAIN = { providerID: CODEX_A, id: "gpt-6-sol", variant: "high" }
const PARENT = `${CODEX_A}/gpt-6-sol#high`
const DS_FLASH = `${DS}/deepseek-flash#high`

const decodeInfo = Schema.decodeUnknownSync(Preset.Info)

function stored(input: {
  readonly id: string
  readonly name: string
  readonly group: Preset.Group
  readonly roles: Partial<Record<Preset.Role, ReadonlyArray<unknown>>>
}) {
  return decodeInfo({
    ...Preset.builtin(input.group),
    id: input.id,
    name: input.name,
    workers: {
      mode: "by-role",
      roles: Object.fromEntries(
        Object.entries(input.roles).map(([role, targets]) => [role, { targets, effort: "inherit" }]),
      ),
    },
    delegation: "when-useful",
  })
}

const pin = (account: string, model: string) => ({ pin: { account, model } })

/** `ChatGPT · 다른 회사 리뷰` (★): review on DeepSeek, a paid account the user chose first. */
const REVIEW = stored({
  id: "pr_01JB0000000000000000000061",
  name: "다른 회사 리뷰",
  group: "codex",
  roles: { "own-review": [pin(DEEPSEEK_KEY, "deepseek-flash")] },
})
/** PG2 (라): a ChatGPT preset whose explore row was edited by hand onto ChatGPT 02. */
const HAND = stored({
  id: "pr_01JB0000000000000000000062",
  name: "손으로 고친 것",
  group: "codex",
  roles: { explore: [pin(CHATGPT_02, "gpt-6-sol")], "own-review": [pin(DEEPSEEK_KEY, "deepseek-flash")] },
})
/** A pinned model the catalog no longer has: a repair notice on this PC, a status only on the remote. */
const GONE = stored({
  id: "pr_01JB0000000000000000000063",
  name: "없어진 모델",
  group: "codex",
  roles: { "own-review": [pin(OPENAI_KEY, "gpt-4.9-retired")] },
})
/** `Claude 구독`: explore on ChatGPT 01 and review on Sign in with ChatGPT of the same login (one subscription here). */
const SIBLING = stored({
  id: "pr_01JB0000000000000000000064",
  name: "같은 로그인 둘",
  group: "claude-sub",
  roles: { explore: [pin(CHATGPT_01, "gpt-6-sol")], "own-review": [pin(SIWC_01, "gpt-5.5")] },
})

/** presets.json as this PC holds it: the hand edit is in the file (this PC's store drops it on load as well). */
const FILE = {
  version: 1,
  groups: {
    codex: { star: REVIEW.id, presets: [REVIEW, HAND, GONE] },
    "claude-sub": { presets: [SIBLING] },
  },
} as Preset.File

const SEATS_T3 = [
  ...SEATS,
  { kind: "codex" as const, label: "ChatGPT 03", slug: "cccc", identity: { fingerprint: LOGIN_03, login: LOGIN_03 } },
]

interface Facts {
  readonly id: string
  readonly agent?: string
  readonly model?: Variant.Ref
  readonly parentID?: string
}

const stops: Array<() => unknown> = []
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
})

/** A fake own service on 127.0.0.1 that answers the guidance-entry requests with 204 and records them. */
function fakeService() {
  const requests: Array<{ readonly method: string; readonly path: string }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push({ method: request.method, path: new URL(request.url).pathname })
      return new Response(null, { status: 204 })
    },
  })
  stops.push(() => server.stop(true))
  return {
    requests,
    source: ServiceTarget.fixed({ url: `http://127.0.0.1:${server.port}`, password: "fake-password" }),
  }
}

/**
 * A remote service mirrored from this PC: the fake broker builds its views with this PC's `Mirror.build`, the remote
 * `RemoteMirror` writes them, and the remote modules start on what it wrote.
 */
async function rig(input: { readonly budget?: Record<string, Broker.PresetBudget> } = {}) {
  const local = await registry(SEATS_T3)
  const cards = await seedCards()
  const view = {
    budget: input.budget ?? { [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: false } },
    presets: FILE,
  } as { budget: Record<string, Broker.PresetBudget> | undefined; presets: Preset.File | undefined }
  const built = () =>
    Mirror.build({
      registry: local,
      policy: Policy.defaults,
      ratecards: cards,
      scope: { mode: "all" },
      ...(view.presets ? { presets: view.presets } : {}),
      ...(view.budget ? { budget: view.budget } : {}),
    })
  const client = partial<Client.BrokerClient>("broker", {
    request: async (method, params) => {
      const wire = (value: unknown) => ({ ok: true as const, result: JSON.parse(JSON.stringify(value)) as unknown })
      if (method === "registry.get") return wire(built().view)
      const id = (params as { readonly id: string }).id
      const item = built().templates.get(id)
      return wire({ id, hash: item?.hash ?? "", template: item?.template ?? null })
    },
  })

  const service = fakeService()
  const kv = memoryStorage()
  const sessions = new Map<string, Facts>([[ROOT, { id: ROOT, agent: "build", model: MAIN }]])
  const agents = new Map<string, { readonly id: string; readonly model?: Variant.Ref }>()
  const t = await testDeps({
    directory: WORKSPACE,
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }), default: async () => ({ data: null }) },
      storage: kv.storage,
      session: {
        get: async (request: { readonly sessionID: string }) => {
          const found = sessions.get(request.sessionID)
          if (!found) throw new Error(`no session ${request.sessionID}`)
          return { ...found, location: { directory: WORKSPACE } }
        },
        context: async () => [{ id: "msg_remote_1", type: "user" }],
        messages: messagesOver(() => [{ id: "msg_remote_1", type: "user" }]),
        wait: async () => {},
        switchModel: async () => {},
      },
      agent: {
        get: async (request: { readonly agentID: string }) => ({
          location: { directory: WORKSPACE },
          data: agents.get(request.agentID) ?? { id: request.agentID },
        }),
      },
    },
  })
  stops.push(() => t[Symbol.asyncDispose]())
  const mirror = new RemoteMirror.Mirror({ runtime: t.deps.runtime, log: Logger.silent, now: () => t.clock.now() })
  expect(await mirror.sync(client, "own-local")).toBe(true)
  // The broker connection of this process; `none` = a service restarted without the broker (no view in memory).
  const connection = { state: "connected" as "connected" | "none" }
  const deps = {
    ...t.deps,
    remote: partial<RemoteHost.Api>("remote", {
      presetsBudget: () => (connection.state === "connected" ? mirror.presetsBudget() : undefined),
      // No Claude view mirrored: R4's lookup (PF 2026-11-03) finds no Claude account besides the slot.
      claude: () => undefined,
      claudeAgent: () => undefined,
    }),
  }
  const alerts: Telemetry.AlertInput[] = []
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_OFF }),
    telemetry: (base, peers) => ({ ...Modules.FACTORIES.telemetry(base, peers), alert: (alert) => alerts.push(alert) }),
    presets: (base, peers) => Presets.create(base, peers, { service: service.source }),
  })
  await modules.slots.start()
  await modules.presets.start()
  await modules.switching.start()
  stops.push(async () => {
    await modules.switching.stop()
    await modules.presets.stop()
    await modules.slots.stop()
  })
  modules.slots.transformProviders(fakeEditor({ openai: { models: OPENAI }, deepseek: { models: DEEPSEEK } }).editor)

  const counter = { call: 0 }
  return {
    deps,
    kv,
    sessions,
    agents,
    alerts,
    modules,
    service,
    connection,
    local,
    /** A new budget verdict from this PC, fetched like after a `mirror.changed`. */
    budget: async (next: Record<string, Broker.PresetBudget> | undefined) => {
      view.budget = next
      expect(await mirror.sync(client, "own-local")).toBe(true)
    },
    /** The next view's presets.json (`undefined`: this PC sent none), fetched like after a `mirror.changed`. */
    presets: async (next: Preset.File | undefined) => {
      view.presets = next
      expect(await mirror.sync(client, "own-local")).toBe(true)
    },
    /** Binds the root to a preset as `session.preset.apply` stores it (KV), optionally with own.team's context. */
    bind: (presetID: Preset.ID, team?: Preset.Team) =>
      PresetBinding.write(deps, ROOT, {
        presetID,
        group: "codex",
        revision: 1,
        appliedAt: t.clock.now(),
        entryHash: null,
        ...(team ? { team } : {}),
      }),
    /** Runs the gate on one subagent call of the root and returns the event as core then sees it. */
    gate: async (call: Readonly<Record<string, unknown>>) => {
      const event = {
        tool: "subagent",
        sessionID: ROOT,
        id: `call_remote_${++counter.call}`,
        input: { description: "Look", prompt: "Do it", ...call } as unknown,
      }
      await modules.presets.onToolBefore(event)
      return event
    },
    apply: (value: { readonly presetID: string; readonly team?: unknown }) =>
      modules.presets.sessionApply(
        decoded("session.preset.apply", { sessionID: ROOT, ...value }),
        rpcContext<"session.preset.apply">(),
      ),
  }
}

/** An RPC input decoded by the protocol schema, as core hands it to the handler. */
function decoded<N extends RpcTypes.MethodName>(name: N, value: unknown): RpcTypes.Input<N> {
  // SAFETY: the method's input schema decodes to the handler's input type.
  const schema = OwnAccounts.Definition.methods[name].input as unknown as Schema.Codec<RpcTypes.Input<N>, unknown>
  return Schema.decodeUnknownSync(schema)(value)
}

const agentOf = (event: { readonly input: unknown }) => (event.input as { readonly agent: string }).agent
const modelOf = (event: { readonly input: unknown }) => (event.input as { readonly model?: string }).model
const rejected = (event: { readonly input: unknown }) => agentOf(event).startsWith(Preset.REJECT_PREFIX)

describe("PG2 on a remote service (07 §8.4, T3)", () => {
  test("(가) a model the LLM writes: another ChatGPT account is refused, the canonical id runs on the main slot", async () => {
    const r = await rig()
    for (const other of [CODEX_B, CODEX_C, SIWC_A]) {
      const event = await r.gate({ agent: "general", model: `${other}/gpt-6-sol` })
      expect(rejected(event)).toBe(true)
    }
    expect(modelOf(await r.gate({ agent: "general", model: "openai/gpt-6-sol#xhigh" }))).toBe(
      `${CODEX_A}/gpt-6-sol#xhigh`,
    )
    // A role name runs where its row says (the mirrored ★ `다른 회사 리뷰`: review on DeepSeek within budget).
    expect(modelOf(await r.gate({ agent: "general", model: "own-review" }))).toBe(DS_FLASH)
    expect(r.alerts.filter((alert) => alert.code === "subagent_rejected")).toHaveLength(3)
  })

  test("(가) a configured agent model on ChatGPT 02 runs on the parent with subagent_model_overridden", async () => {
    const r = await rig()
    r.agents.set("explore", { id: "explore", model: { providerID: CODEX_B, id: "gpt-6-sol" } })
    const event = await r.gate({ agent: "explore" })
    expect(modelOf(event)).toBe(PARENT)
    expect(r.alerts.map((alert) => alert.code)).toContain("subagent_model_overridden")
  })

  test("(가) opencode_models lists the main slot and the preset's targets only", async () => {
    const r = await rig()
    const listing = (ids: ReadonlyArray<string>) => ({
      providers: ids.map((id) => ({ id, models: [{ id: "m" }] })),
      total: ids.length,
      next: null,
    })
    const event = {
      tool: "opencode_models",
      sessionID: ROOT,
      input: {},
      status: "completed" as const,
      result: { output: listing([CODEX_A, CODEX_B, CODEX_C, DS, OAI, SIWC_A]) as unknown },
    }
    await r.modules.presets.onToolAfter(event)
    expect((event.result.output as { providers: Array<{ id: string }> }).providers.map((item) => item.id)).toEqual([
      CODEX_A,
      DS,
    ])
  })

  test("(라) a ChatGPT 02 target added to presets.json by hand is dropped on load, with preset_entry_dropped", async () => {
    const r = await rig()
    const loaded = r.modules.presets.preset(HAND.id, "codex")
    expect(loaded?.workers.roles.explore?.targets).toEqual([])
    expect<unknown>(loaded?.workers.roles["own-review"]?.targets).toEqual([pin(DEEPSEEK_KEY, "deepseek-flash")])
    expect(r.alerts).toContainEqual(
      expect.objectContaining({ code: "preset_entry_dropped", accountID: CHATGPT_02, subject: `${HAND.id}:explore` }),
    )
    // The explore row has no target left, so explore runs like the main; nothing reaches ChatGPT 02.
    await r.bind(HAND.id)
    const event = await r.gate({ agent: "explore" })
    expect(rejected(event)).toBe(false)
    expect(modelOf(event) ?? PARENT).toBe(PARENT)
  })

  test("R4 is judged again without identities: one login's codex and siwc count as two subscriptions (fail closed)", async () => {
    const r = await rig()
    // This PC knows the login and keeps both pins …
    const lookup = (accountID: string) => r.local.accounts.find((account) => account.id === accountID)
    expect(PresetStore.load(FILE, lookup).dropped.filter((entry) => entry.presetID === SIBLING.id)).toEqual([])
    // … the mirror has no identities, so the remote keeps one OpenAI subscription of the two.
    const loaded = r.modules.presets.preset(SIBLING.id, "claude-sub")
    const pinned = Preset.ROLES.flatMap((role) => loaded?.workers.roles[role]?.targets ?? [])
    expect(pinned).toHaveLength(1)
    // A team of ChatGPT 01 with the same login's siwc account is refused on the remote.
    const team = { teamID: "tm_remote", role: "owner", accounts: [CHATGPT_01, SIWC_01], pinned: [] }
    expect(failure(await r.apply({ presetID: REVIEW.id, team }))).toMatchObject({ type: "same_company_subscription" })
  })

  test("(바) a team session's switch to ChatGPT 02, 03 or the login's siwc account is team_switch_required", async () => {
    const r = await rig()
    await r.bind(REVIEW.id, { teamID: "tm_remote", role: "owner", accounts: [CHATGPT_01], pinned: [] })
    const estimate = (providerID: string) =>
      r.modules.switching.estimate(
        decoded("switch.estimate", { sessionID: ROOT, target: { providerID, id: "gpt-5.6-sol", variant: "high" } }),
        rpcContext<"switch.estimate">(),
      )
    for (const providerID of [CODEX_B, CODEX_C, SIWC_A])
      expect(failure(await estimate(providerID))).toMatchObject({
        type: "team_switch_required",
        data: { teamID: "tm_remote" },
      })
    // A metered key of the same company is no subscription: the team filter lets it through.
    expect(failure(await estimate(OAI))?.type).not.toBe("team_switch_required")
  })
})

describe("money on a remote service (07 §5.4 step 4, T3)", () => {
  test("a paid target the mirror marks used up is refused; within budget it runs", async () => {
    const r = await rig({ budget: { [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: true } } })
    const refused = await r.gate({ agent: "own-review" })
    expect(agentOf(refused)).toBe(Preset.rejection({ reason: "budget", roles: ["own-review"] }))
    expect(r.alerts).toContainEqual(expect.objectContaining({ code: "subagent_rejected", accountID: DEEPSEEK_KEY }))
    await r.budget({ [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: false } })
    const allowed = await r.gate({ agent: "own-review" })
    expect(modelOf(allowed)).toBe(DS_FLASH)
  })

  test("a paid account the mirror does not name, or no mirrored state at all, counts as used up", async () => {
    const r = await rig({ budget: { [OPENAI_KEY]: { exhausted: false } } })
    expect(agentOf(await r.gate({ agent: "own-review" }))).toBe(
      Preset.rejection({ reason: "budget", roles: ["own-review"] }),
    )
    // A view of an older local build carries no verdicts.
    await r.budget(undefined)
    expect(rejected(await r.gate({ agent: "own-review" }))).toBe(true)
    // A restart without the broker: presets.json and the registry are on disk, the money state is not.
    await r.budget({ [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: false } })
    r.connection.state = "none"
    expect(rejected(await r.gate({ agent: "own-review" }))).toBe(true)
    // A configured agent model on the paid account is refused the same way.
    r.agents.set("helper", { id: "helper", model: { providerID: DS, id: "deepseek-flash" } })
    expect(agentOf(await r.gate({ agent: "helper" }))).toBe(
      Preset.rejection({ reason: "budget", roles: ["own-review"] }),
    )
  })
})

describe("per-call effort on a remote service (07 §2.3, §8.1 원격)", () => {
  test("the mirrored ceiling rules, a paid target is never raised, and 이번 메시지만 허용 works on the host", async () => {
    const r = await rig()
    const capped = { ...REVIEW, subagentEffortMax: "high" }
    await r.presets({ ...FILE, groups: { ...FILE.groups, codex: { star: REVIEW.id, presets: [capped, HAND, GONE] } } })
    // The host reads the mirrored file after its `store.changed{presets}`.
    for (const _ of Array.from({ length: 50 })) {
      if (r.modules.presets.preset(REVIEW.id, "codex")?.subagentEffortMax === "high") break
      await Bun.sleep(20)
    }
    expect(r.modules.presets.preset(REVIEW.id, "codex")?.subagentEffortMax).toBe("high")
    const over = Preset.rejection({ reason: "effort-cap", max: "high", once: true })
    expect(agentOf(await r.gate({ agent: "general", model: "#max" }))).toBe(over)
    expect(modelOf(await r.gate({ agent: "general", model: "#high" }))).toBe(PARENT)
    // Review runs on the DeepSeek key: lowering runs, a raise never (no allow-once for a paid target).
    expect(modelOf(await r.gate({ agent: "own-review", model: "#low" }))).toBe(`${DS}/deepseek-flash#low`)
    expect(agentOf(await r.gate({ agent: "own-review", model: "#max" }))).toBe(
      Preset.rejection({ reason: "effort-cap", max: "high", once: false }),
    )
    const allowed = await r.modules.presets.raiseOnce(
      decoded("session.preset.raiseOnce", { sessionID: ROOT, effort: true }),
      rpcContext<"session.preset.raiseOnce">(),
    )
    expect(allowed).toMatchObject({ effort: true })
    expect(modelOf(await r.gate({ agent: "general", model: "#max" }))).toBe(`${CODEX_A}/gpt-6-sol#max`)
    expect(rejected(await r.gate({ agent: "own-review", model: "#max" }))).toBe(true)
  })
})

describe("a passing read error never rebinds (07 §8.1 원격, U3: nothing changes by itself)", () => {
  test("this PC sent no presets (it could not read them): the host keeps its presets and a binding keeps its preset", async () => {
    const r = await rig()
    await r.bind(REVIEW.id)
    // A current local build always sends its budget verdicts; without presets it could not read presets.json.
    await r.presets(undefined)
    await Bun.sleep(100)
    expect(r.modules.presets.star("codex")).toBe(REVIEW.id)
    expect(r.modules.presets.preset(REVIEW.id, "codex")?.id).toBe(REVIEW.id)
    expect((await PresetBinding.read(r.deps, ROOT))?.presetID).toBe(REVIEW.id)
  })

  test("the host's own presets.json cannot be read: the store keeps the last file and nothing is rebound", async () => {
    const r = await rig()
    await r.bind(REVIEW.id)
    await Bun.write(r.deps.runtime.presets.file, "{ not json")
    r.deps.runtime.broadcast.emit("store.changed", { store: "presets", origin: "local" })
    await Bun.sleep(100)
    expect(r.modules.presets.star("codex")).toBe(REVIEW.id)
    expect((await PresetBinding.read(r.deps, ROOT))?.presetID).toBe(REVIEW.id)
  })
})

describe("mirrored presets in session and list RPCs (07 §8.1 원격)", () => {
  test("session.preset.apply{team} with a mirrored preset stores the binding with the team", async () => {
    const r = await rig()
    const team = { teamID: "tm_remote", role: "owner", accounts: [CHATGPT_01], pinned: [] }
    const result = await r.apply({ presetID: REVIEW.id, team })
    expect(failure(result)).toBeUndefined()
    expect(result).toMatchObject({ binding: { presetID: REVIEW.id, group: "codex", team: { teamID: "tm_remote" } } })
    expect(await PresetBinding.read(r.deps, ROOT)).toMatchObject({
      presetID: REVIEW.id,
      team: { teamID: "tm_remote", role: "owner", accounts: [CHATGPT_01] },
    })
    // The guidance entry went to this service (the remote one), not to the local PC.
    expect(r.service.requests.map((request) => request.method)).toEqual(["PUT"])
    // A team holding a second ChatGPT subscription is refused, and the binding stays.
    const broken = { ...team, accounts: [CHATGPT_01, CHATGPT_02] }
    expect(failure(await r.apply({ presetID: HAND.id, team: broken }))).toMatchObject({
      type: "same_company_subscription",
    })
    expect((await PresetBinding.read(r.deps, ROOT))?.presetID).toBe(REVIEW.id)
  })

  test("presets.list lists the mirrored presets and ★ without repair notices", async () => {
    const r = await rig()
    const listed = await r.modules.presets.list(decoded("presets.list", {}), rpcContext<"presets.list">())
    if (!("groups" in listed)) throw new Error("presets.list failed")
    const codex = listed.groups.find((group) => group.group === "codex")
    expect(codex?.star).toBe(REVIEW.id)
    const presets = codex?.presets ?? []
    expect(presets.map((preset) => preset.id)).toEqual([REVIEW.id, Preset.builtinID("codex"), HAND.id, GONE.id])
    // The gone model shows as a status; the notice that would offer a fix is the local PC's.
    expect(presets.find((preset) => preset.id === GONE.id)?.status).toBe("needs_repair")
    expect(listed).not.toHaveProperty("repairs")
    expect(await r.modules.presets.repairs()).toEqual([])
  })

  test("suggesting, saving and removing presets and their defaults stay the local PC's (remote_managed)", async () => {
    const r = await rig()
    const handlers = Register.remoteHandlers(Register.handlers(r.modules, r.deps))
    const refused = async (method: "presets.suggest" | "presets.set" | "presets.remove" | "presets.defaults.set") => {
      const call = handlers[method] as unknown as (input: unknown, context: unknown) => Promise<unknown>
      return failure(await call({}, rpcContext()))
    }
    for (const method of ["presets.suggest", "presets.set", "presets.remove", "presets.defaults.set"] as const)
      expect(await refused(method)).toMatchObject({ type: "remote_managed", data: { method } })
    expect(Register.REMOTE_MANAGED).toEqual(
      expect.arrayContaining(["presets.suggest", "presets.set", "presets.remove", "presets.defaults.set"]),
    )
    expect(Register.REMOTE_MANAGED).not.toContain("presets.list")
    expect(Register.REMOTE_MANAGED).not.toContain("session.preset.apply")
  })
})
