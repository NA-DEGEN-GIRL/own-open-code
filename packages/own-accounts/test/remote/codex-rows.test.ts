// Served Codex rows to an SSH host (10 §6.14, own.18): this PC's `Mirror.build` names the rows its codex harness runs
// from by content hash (`codexRows`) and answers `codexRow.get`; the host's mirror fetches the rows it does not hold,
// writes them to its own `codex-meta.json` as the shared snapshot's `harness`, announces `store.changed{codex-meta}`,
// and fetches nothing again while the hashes stay. A view without `codexRows` (an older PC) leaves the host's file
// alone. The host's model list is never fetched: nothing here has a Codex endpoint. Real runtime on a temp OWN_HOME;
// every account is fake.

import { describe, expect, test } from "bun:test"
import { Broker, CodexModels, Policy, type Ratecard, type Registry } from "@own/protocol"
import { Mirror } from "../../src/broker/mirror.js"
import { Logger } from "../../src/logger.js"
import type { Client } from "../../src/remote/client.js"
import { RemoteMirror } from "../../src/remote/mirror.js"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import { testDeps } from "../support/deps.js"
import { partial } from "../switching/support.js"
import { registry } from "../presets/fixtures/catalog-2026-10-01.js"

const ratecards: Ratecard.File = { schemaVersion: 1, updatedAt: "2026-10-01", cards: [] }

/** A served row the harness can run (the fields `CodexModels.HarnessRow` keeps), with fixture texts. */
function row(slug: string, text: string): CodexModels.HarnessRow {
  return {
    slug,
    description: "fixture",
    visibility: "list",
    priority: 1,
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    model_messages: { instructions_template: text },
  }
}

/** A fake local broker over `Mirror.build`, counting the row requests. */
function broker(local: Registry.File) {
  const state = { codex: [row("gpt-6.9-nova", "nova v1")] as ReadonlyArray<CodexModels.HarnessRow> | undefined }
  const asked: string[] = []
  const built = () =>
    Mirror.build({
      registry: local,
      policy: Policy.defaults,
      ratecards,
      scope: { mode: "all" },
      ...(state.codex ? { codex: state.codex } : {}),
    })
  const client = partial<Client.BrokerClient>("client", {
    request: async (method, params) => {
      const wire = (value: unknown) => ({ ok: true as const, result: JSON.parse(JSON.stringify(value)) as unknown })
      if (method === "registry.get") return wire(built().view)
      if (method === "codexRow.get") {
        const slug = (params as { readonly slug: string }).slug
        asked.push(slug)
        const item = built().codexRows.get(slug)
        return wire({ slug, hash: item?.hash ?? "", row: item?.row ?? null } satisfies Broker.CodexRowResult)
      }
      const id = (params as { readonly id: string }).id
      const item = built().templates.get(id)
      return wire({ id, hash: item?.hash ?? "", template: item?.template ?? null })
    },
  })
  return { state, client, asked, view: () => built().view }
}

async function host() {
  const t = await testDeps({})
  const runtime = t.deps.runtime
  const mirror = new RemoteMirror.Mirror({ runtime, log: Logger.silent, now: () => t.clock.now() })
  const stores: string[] = []
  const stop = runtime.broadcast.on("store.changed", (change) => void stores.push(change.store))
  return {
    t,
    runtime,
    mirror,
    stores,
    harness: async () => (await CodexMeta.file(runtime.layout).read()).kinds.codex?.harness,
    async [Symbol.asyncDispose]() {
      stop()
      await t[Symbol.asyncDispose]()
    },
  }
}

describe("served Codex rows reach a host (10 §6.14)", () => {
  test("the PC names its rows by hash and answers codexRow.get; no rows, no field", async () => {
    const local = await registry()
    const built = Mirror.build({ registry: local, policy: Policy.defaults, ratecards, scope: { mode: "all" }, codex: [row("gpt-6.9-nova", "x")] })
    expect(Object.keys(built.view.codexRows ?? {})).toEqual(["gpt-6.9-nova"])
    expect(built.view.codexRows?.["gpt-6.9-nova"]).toBe(Mirror.hash(row("gpt-6.9-nova", "x")))
    expect(built.codexRows.get("gpt-6.9-nova")?.row.model_messages.instructions_template).toBe("x")
    const older = Mirror.build({ registry: local, policy: Policy.defaults, ratecards, scope: { mode: "all" } })
    expect(older.view.codexRows).toBeUndefined()
    // The view stays one frame: the rows travel apart.
    expect(JSON.stringify(built.view)).not.toContain("instructions_template")
  })

  test("the host fetches the rows it does not hold, writes them as its harness rows and fetches nothing again", async () => {
    await using h = await host()
    const fake = broker(await registry())
    expect(await h.mirror.sync(fake.client, "pc")).toBe(true)
    expect(fake.asked).toEqual(["gpt-6.9-nova"])
    expect((await h.harness())?.map((item) => item.model_messages.instructions_template)).toEqual(["nova v1"])
    expect(h.stores).toContain("codex-meta")
    expect(RemoteMirror.metaOf(await h.runtime.registry.read())?.codexRows).toEqual(fake.view().codexRows)
    // The same rows: nothing is fetched or written.
    const before = h.stores.length
    expect(await h.mirror.sync(fake.client, "pc")).toBe(true)
    expect(fake.asked).toEqual(["gpt-6.9-nova"])
    expect(h.stores.length).toBe(before)
    // A changed row and a new one: only those are fetched.
    fake.state.codex = [row("gpt-6.9-nova", "nova v2"), row("gpt-7-sol", "seven")]
    expect(await h.mirror.sync(fake.client, "pc")).toBe(true)
    expect(fake.asked).toEqual(["gpt-6.9-nova", "gpt-6.9-nova", "gpt-7-sol"])
    expect((await h.harness())?.map((item) => item.model_messages.instructions_template)).toEqual(["nova v2", "seven"])
    // A row gone from the PC's list goes from the host's too.
    fake.state.codex = [row("gpt-7-sol", "seven")]
    expect(await h.mirror.sync(fake.client, "pc")).toBe(true)
    expect((await h.harness())?.map((item) => item.slug)).toEqual(["gpt-7-sol"])
  })

  test("a view from an older PC (no codexRows) leaves the host's rows alone", async () => {
    await using h = await host()
    const fake = broker(await registry())
    await h.mirror.sync(fake.client, "pc")
    fake.state.codex = undefined
    const before = h.stores.length
    expect(await h.mirror.sync(fake.client, "pc")).toBe(true)
    expect((await h.harness())?.map((item) => item.slug)).toEqual(["gpt-6.9-nova"])
    expect(h.stores.slice(before)).not.toContain("codex-meta")
  })
})
