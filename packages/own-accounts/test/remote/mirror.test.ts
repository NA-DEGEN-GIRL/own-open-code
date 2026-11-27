// The registry mirror of a remote service and presets.json (T3, 07 §8.1 원격, 04 §9.2): a fake broker answers
// `registry.get` / `template.get` with views this PC's `Mirror.build` makes; the remote side writes presets.json
// atomically before the meta that names its revision, then announces `store.changed{presets}`; the same revision
// writes nothing, the money state stays in memory, and a view without presets (an older local build) leaves the
// remote presets store with each group's `평소대로` only. Real runtime, slots and presets modules on a temp OWN_HOME;
// every account is fake.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { Option, Schema } from "effect"
import { optional } from "@opencode/schema/schema"
import { Broker, Policy, Preset, type Ratecard, type Registry } from "@own/protocol"
import { Mirror } from "../../src/broker/mirror.js"
import { Logger } from "../../src/logger.js"
import { Modules } from "../../src/modules.js"
import type { Client } from "../../src/remote/client.js"
import type { RemoteHost } from "../../src/remote/host.js"
import { RemoteMirror } from "../../src/remote/mirror.js"
import { memoryStorage } from "../slots/support.js"
import { testDeps } from "../support/deps.js"
import { partial } from "../switching/support.js"
import { CHATGPT_01, CLAUDE_OFF, DEEPSEEK_KEY, OPENAI_KEY, registry } from "../presets/fixtures/catalog-2026-10-01.js"

const ratecards: Ratecard.File = { schemaVersion: 1, updatedAt: "2026-10-01", cards: [] }
const PRESET_ID = Preset.ID.make("pr_01JB0000000000000000000051")

/** `presets.json` of this PC: one ChatGPT preset (★), review on the DeepSeek key. */
function presetsFile(name: string): Preset.File {
  const preset = {
    ...Preset.builtin("codex"),
    id: PRESET_ID,
    name,
    workers: {
      mode: "by-role",
      roles: {
        "own-review": { targets: [{ pin: { account: DEEPSEEK_KEY, model: "deepseek-flash" } }], effort: "inherit" },
      },
    },
  }
  return Schema.decodeUnknownSync(Preset.File)({
    version: 1,
    groups: { codex: { star: PRESET_ID, presets: [preset] } },
  })
}

/** A fake local broker: answers the remote's requests with the view `Mirror.build` makes now. */
function broker(local: Registry.File) {
  const state = {
    presets: presetsFile("리뷰") as Preset.File | undefined,
    budget: { [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: false } } as
      | Record<string, Broker.PresetBudget>
      | undefined,
    registry: local,
  }
  const built = () =>
    Mirror.build({
      registry: state.registry,
      policy: Policy.defaults,
      ratecards,
      scope: { mode: "all" },
      ...(state.presets ? { presets: state.presets } : {}),
      ...(state.budget ? { budget: state.budget } : {}),
    })
  const client = partial<Client.BrokerClient>("client", {
    request: async (method, params) => {
      // Over the wire: JSON both ways.
      const wire = (value: unknown) => ({ ok: true as const, result: JSON.parse(JSON.stringify(value)) as unknown })
      if (method === "registry.get") return wire(built().view)
      const id = (params as { readonly id: string }).id
      const item = built().templates.get(id)
      return wire({ id, hash: item?.hash ?? "", template: item?.template ?? null })
    },
  })
  return { state, client, view: () => built().view }
}

/** A remote service's runtime with the mirror, and its real slots and presets modules (started on demand). */
async function remote() {
  const t = await testDeps({
    ctx: {
      provider: { reload: async () => {}, list: async () => [] },
      model: { list: async () => ({ data: [] }) },
      storage: memoryStorage().storage,
    },
  })
  const runtime = t.deps.runtime
  const mirror = new RemoteMirror.Mirror({ runtime, log: Logger.silent, now: () => t.clock.now() })
  const stores: string[] = []
  const stop = runtime.broadcast.on("store.changed", (change) => void stores.push(change.store))
  const deps = {
    ...t.deps,
    remote: partial<RemoteHost.Api>("remote", {
      presetsBudget: () => mirror.presetsBudget(),
      claude: () => undefined,
      claudeAgent: () => undefined,
    }),
  }
  const modules = Modules.create(deps, {
    plugins: (base, peers) => ({ ...Modules.FACTORIES.plugins(base, peers), claudeSlot: () => CLAUDE_OFF }),
  })
  const started = { value: false }
  return {
    t,
    runtime,
    mirror,
    stores,
    modules,
    start: async () => {
      await modules.slots.start()
      await modules.presets.start()
      started.value = true
    },
    async [Symbol.asyncDispose]() {
      stop()
      if (started.value) {
        await modules.presets.stop()
        await modules.slots.stop()
      }
      await t[Symbol.asyncDispose]()
    },
  }
}

const meta = async (runtime: { readonly registry: { read(): Promise<Registry.File> } }) =>
  RemoteMirror.metaOf(await runtime.registry.read())

/** Waits for work started by a broadcast (a store reload) to show. */
async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not reached")
    await Bun.sleep(5)
  }
}

describe("the remote mirror writes presets.json (T3)", () => {
  test("presets.json is written atomically before the meta names its revision, then store.changed{presets}", async () => {
    await using r = await remote()
    const local = await registry()
    const fake = broker(local)
    expect(await r.mirror.sync(fake.client, "own-local")).toBe(true)
    const view = fake.view()
    // The file holds exactly the local PC's presets, and no temp file is left next to it.
    expect(await Bun.file(r.runtime.presets.file).json()).toEqual(JSON.parse(JSON.stringify(view.presets)))
    expect((await fs.readdir(r.t.home)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    expect(await meta(r.runtime)).toMatchObject({
      registryRevision: local.revision,
      presetsRevision: view.presetsRevision,
    })
    // The presets announcement comes after the accounts file (with the meta) was written.
    expect(r.stores.filter((store) => store === "accounts" || store === "presets")).toEqual(["accounts", "presets"])
    // The money state stays in memory with the view.
    expect(r.mirror.presetsBudget()).toEqual({
      [OPENAI_KEY]: { exhausted: false },
      [DEEPSEEK_KEY]: { exhausted: false },
    })
  })

  test("the same revision writes nothing; a budget-only change stays in memory; a registry change keeps presets.json", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    await r.mirror.sync(fake.client, "own-local")
    const before = await fs.stat(r.runtime.presets.file)
    const announced = r.stores.length
    await Bun.sleep(20)

    expect(await r.mirror.sync(fake.client, "own-local")).toBe(true)
    expect(r.stores.length).toBe(announced)

    fake.state.budget = { [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: true } }
    await r.mirror.sync(fake.client, "own-local")
    expect(r.stores.length).toBe(announced)
    expect(r.mirror.presetsBudget()?.[DEEPSEEK_KEY]).toEqual({ exhausted: true })

    fake.state.registry = {
      ...fake.state.registry,
      revision: fake.state.registry.revision + 1,
      accounts: fake.state.registry.accounts.map((account) =>
        account.id === CHATGPT_01 ? { ...account, label: "ChatGPT 01 (집)" } : account,
      ),
    }
    await r.mirror.sync(fake.client, "own-local")
    expect(r.stores.slice(announced)).toEqual(["accounts"])
    expect((await fs.stat(r.runtime.presets.file)).mtimeMs).toBe(before.mtimeMs)
    expect((await meta(r.runtime))?.presetsRevision).toBe(fake.view().presetsRevision!)

    fake.state.presets = presetsFile("리뷰 2")
    await r.mirror.sync(fake.client, "own-local")
    expect(r.stores.slice(announced)).toEqual(["accounts", "accounts", "presets"])
    expect((await Bun.file(r.runtime.presets.file).json()).groups.codex.presets[0].name).toBe("리뷰 2")
  })

  test("the remote presets store lists what the mirror wrote and follows it", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    await r.mirror.sync(fake.client, "own-local")
    await r.start()
    const store = r.modules.presets
    expect(store.star("codex")).toBe(PRESET_ID)
    expect(store.presetsOf("codex").map((preset) => preset.name)).toEqual(["리뷰"])
    expect(store.budgets()).toEqual({ [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: false } })

    fake.state.presets = presetsFile("리뷰 2")
    await r.mirror.sync(fake.client, "own-local")
    await until(() => store.presetsOf("codex")[0]?.name === "리뷰 2")
  })
})

describe("a view without presets: 평소대로 only from an older local build; kept from a current one", () => {
  test("nothing is written, the meta names no revision and a stray presets.json is not used", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    fake.state.presets = undefined
    fake.state.budget = undefined
    // A presets.json that is not the mirror's (left on the host by hand) must not count.
    await Bun.write(r.runtime.presets.file, `${JSON.stringify(presetsFile("손으로 둔 것"))}\n`)
    await r.mirror.sync(fake.client, "own-local")
    expect((await meta(r.runtime))?.presetsRevision).toBeUndefined()
    expect(r.stores).not.toContain("presets")
    expect(r.mirror.presetsBudget()).toBeUndefined()
    await r.start()
    const store = r.modules.presets
    expect(store.presetsOf("codex")).toEqual([])
    expect(store.star("codex")).toBeUndefined()
    expect(store.preset(Preset.builtinID("codex"), "codex")?.id).toBe(Preset.builtinID("codex"))
    // No mirrored money state: every paid account counts as used up.
    expect(store.budgets()).toEqual({})
  })

  test("presets come with a newer view and go again with an older one", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    fake.state.presets = undefined
    fake.state.budget = undefined
    await r.mirror.sync(fake.client, "own-local")
    await r.start()
    const store = r.modules.presets

    fake.state.presets = presetsFile("리뷰")
    fake.state.budget = { [OPENAI_KEY]: { exhausted: false }, [DEEPSEEK_KEY]: { exhausted: false } }
    await r.mirror.sync(fake.client, "own-local")
    await until(() => store.star("codex") === PRESET_ID)

    // An older local build (no presets, no budget verdicts) again.
    fake.state.presets = undefined
    fake.state.budget = undefined
    await r.mirror.sync(fake.client, "own-local")
    expect((await meta(r.runtime))?.presetsRevision).toBeUndefined()
    await until(() => store.presetsOf("codex").length === 0)
    expect(store.star("codex")).toBeUndefined()
  })

  test("a current local build that sends no presets (it could not read them) leaves the host's presets as they are", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    await r.mirror.sync(fake.client, "own-local")
    await r.start()
    const store = r.modules.presets
    const revision = (await meta(r.runtime))?.presetsRevision
    expect(revision).toBeDefined()
    const changes = r.stores.filter((name) => name === "presets").length

    fake.state.presets = undefined
    await r.mirror.sync(fake.client, "own-local")
    expect((await meta(r.runtime))?.presetsRevision).toBe(revision)
    expect(r.stores.filter((name) => name === "presets")).toHaveLength(changes)
    expect(store.star("codex")).toBe(PRESET_ID)
    // The budget verdicts still follow the view.
    expect(r.mirror.presetsBudget()).toEqual(fake.state.budget)
  })
})

describe("a model pool preset in the mirror (T4, 07 §8.1 원격)", () => {
  const POOL_ID = Preset.ID.make("pr_01JB0000000000000000000052")
  const card = { name: "GPT-6 Luna", window: 922_000, reasoning: true, summary: "made-up text", at: 1 }
  const pooled = Schema.decodeUnknownSync(Preset.File)({
    version: 1,
    groups: {
      codex: {
        presets: [
          {
            ...Preset.builtin("codex"),
            id: POOL_ID,
            name: "모델 묶음",
            revision: 1,
            delegation: "when-useful",
            workers: { mode: "same", roles: {}, pool: [{ key: "gpt-6-luna", model: "gpt-6-luna", card }] },
          },
        ],
      },
    },
  })

  test("the host reads the pool with the PC's frozen cards", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    fake.state.presets = pooled
    expect(await r.mirror.sync(fake.client, "own-local")).toBe(true)
    await r.start()
    expect<unknown>(r.modules.presets.preset(POOL_ID, "codex")?.workers.pool).toEqual([
      { key: "gpt-6-luna", model: "gpt-6-luna", card },
    ])
  })

  test("an older host in the drain window decodes the view without the pool: 모두 메인과 같게, no mirror_invalid", async () => {
    await using r = await remote()
    const fake = broker(await registry())
    fake.state.presets = pooled
    expect(await r.mirror.sync(fake.client, "own-local")).toBe(true)
    const wire: unknown = JSON.parse(JSON.stringify(fake.view()))
    // The schemas of the build before T4, copied.
    const OldWorkers = Schema.Struct({
      mode: Schema.Literals(["same", "single", "by-role"]),
      single: optional(Preset.Target),
      roles: Preset.Workers.fields.roles,
    })
    const OldInfo = Schema.Struct({ ...Preset.Info.fields, workers: OldWorkers })
    const OldGroup = Schema.Struct({ ...Preset.GroupState.fields, presets: optional(Schema.Array(OldInfo)) })
    const OldFile = Schema.Struct({ ...Preset.File.fields, groups: Schema.Record(Schema.String, OldGroup) })
    const OldView = Schema.Struct({ ...Broker.MirrorView.fields, presets: optional(OldFile) })
    const decoded = Schema.decodeUnknownOption(OldView)(wire)
    expect(Option.isSome(decoded)).toBe(true)
    const workers = Option.getOrUndefined(decoded)?.presets?.groups.codex?.presets?.[0]?.workers
    expect(workers).toEqual({ mode: "same", roles: {} })
  })
})
