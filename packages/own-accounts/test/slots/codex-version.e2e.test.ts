// End to end on a real upstream server: the Codex model list asked as the newest Codex release (07 §4.5, decision CA
// of 2026-10-19, "최신 버전 자동 확인").
// - The fake Codex backend gates its list like the live one: a row is listed only when the asking `client_version`
//   reaches its `minimal_client_version`. `gpt-6.1-sol-next` (made up, from 0.172.0; its slug extends the bundled Codex
//   catalog's `gpt-6.1-sol`) is a model models.dev already lists (a catalog variant), so the template diff registers it
//   with its catalog window while the Codex list hides its row.
// - The fake npm registry first says 0.171.0 (this build's own version): nothing changes. A day later it says 0.172.0:
//   the next start reads it and asks every list as it, so `gpt-6.1-sol-next` gets its Codex window (900k) with no
//   rebuild.
// - `gpt-7-preview` (also from 0.172.0) names an apply_patch tool own's Codex harness does not have: left out and
//   counted with that field (`codexModels.get` `rejected`, `left`). `gpt-6.9-sol` is a model the harness's bundled
//   catalog does not know whose row the harness can run (10 §6.14): kept, not counted, running from its served row
//   (it has no instructions, so it borrows the nearest bundled model's, `borrowed`).
// - `codexModels.set{autoVersion:false}` asks as this build again (the window goes back) and reads no release; on
//   again, the newest release.
// own-accounts loads from its package directory (`startPresetRig`, control Location on) with one linked ChatGPT
// account. Every credential is fake; the fakes bind 127.0.0.1; nothing reaches npm or chatgpt.com.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import path from "node:path"
import { CodexModels } from "@own/protocol"
import { Schema } from "effect"
import { CodexMeta } from "../../src/slots/codex-meta.js"
import {
  bundledCatalog,
  catalogVariant,
  replaceFile,
  startFakeCodex,
  startPresetRig,
  waitUntil,
  type FakeCodex,
  type PresetRig,
} from "../e2e-kit"
import { isRecord } from "../e2e-kit/fakes/shared"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const STEP_TIMEOUT = 120_000

const ONE = { accountID: "acct-ca-01", email: "one@example.test", plan: "pro" }
const SLOT = "own-codex-pg01"
const BUILD = CodexMeta.BACKEND.clientVersion
const DAY = CodexMeta.LATEST.everyMs

/** The fixture of the backend's list (07 Appendix A), its malformed row left out. */
const LISTED: ReadonlyArray<Record<string, unknown>> = (
  JSON.parse(await Bun.file(path.join(import.meta.dir, "fixture", "codex-models.json")).text()) as {
    models: Array<Record<string, unknown>>
  }
).models.filter((row) => typeof row.slug === "string")
/** Listed from Codex 0.172.0 on, every harness value one own handles. */
const NEWER = {
  slug: "gpt-6.1-sol-next",
  display_name: "GPT-6.1 Sol Next",
  visibility: "list",
  minimal_client_version: "0.172.0",
  priority: 1,
  context_window: 272_000,
  max_context_window: 900_000,
  default_reasoning_level: "low",
  shell_type: "shell_command",
  apply_patch_tool_type: "freeform",
  truncation_policy: { mode: "tokens", limit: 10_000 },
  tool_mode: "code_mode_only",
}
/** Listed from 0.172.0 on, with every harness value own handles, a model the bundled Codex catalog does not know. */
const UNCATALOGUED = { ...NEWER, slug: "gpt-6.9-sol", display_name: "GPT-6.9 Sol", priority: 3 }
/** Listed from 0.172.0 on, with an apply_patch tool own's Codex harness does not have. */
const UNKNOWN = {
  slug: "gpt-7-preview",
  display_name: "GPT-7 Preview",
  visibility: "list",
  minimal_client_version: "0.172.0",
  priority: 2,
  apply_patch_tool_type: "json_patch",
}

/** The live backend's gating: only the rows the asking `client_version` reaches. */
function modelList(clientVersion: string | undefined) {
  const asked = clientVersion ?? "0.0.0"
  return {
    models: [...LISTED, NEWER, UNKNOWN, UNCATALOGUED].filter(
      (row) =>
        typeof row.minimal_client_version !== "string" || Bun.semver.order(row.minimal_client_version, asked) <= 0,
    ),
  }
}

/** A fake npm registry: `@openai/codex`'s `latest` manifest with `version`, each request's headers recorded. */
function fakeRegistry(version: string) {
  const seen: Array<{ readonly path: string; readonly headers: Readonly<Record<string, string>> }> = []
  const latest = { version }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers.entries()) })
      if (url.pathname !== CodexMeta.LATEST.path) return new Response("not found", { status: 404 })
      return Response.json({ name: "@openai/codex", version: latest.version, license: "Apache-2.0" })
    },
  })
  return { seen, latest, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const fixture: { codex?: FakeCodex; registry?: ReturnType<typeof fakeRegistry>; rig?: PresetRig } = {}

beforeAll(async () => {
  const codex = startFakeCodex({ modelList })
  const registry = fakeRegistry(BUILD)
  Object.assign(fixture, { codex, registry })
  fixture.rig = await startPresetRig({
    name: "ca",
    codex,
    chatgpt: [{ id: "01", tokens: codex.login(ONE) }],
    endpoints: { npmRegistry: registry.url },
    catalog: catalogVariant(await bundledCatalog(), [
      {
        provider: "openai",
        add: "gpt-6.1-sol-next",
        from: "gpt-6-sol",
        set: { name: "GPT-6.1 Sol Next", release_date: "2026-10-18", last_updated: "2026-10-18" },
      },
    ]),
    control: true,
    models: [{ providerID: SLOT, id: "gpt-6.1-sol-next" }],
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.rig?.stop()
  await Promise.all([fixture.codex?.stop(), fixture.registry?.stop()])
}, 60_000)

describe("CA: the Codex model list asked as the newest Codex release (07 §4.5)", () => {
  test("the registry says this build's version: the list is asked as it and the newer model's row stays hidden", async () => {
    const rig = required(fixture.rig)
    const codex = required(fixture.codex)
    const registry = required(fixture.registry)
    const view = await waitUntil(async () => {
      const answer = await codexModels(rig)
      return answer.fetchedAt !== undefined && answer
    }, "the first list never arrived")
    expect(view).toMatchObject({ autoVersion: true, version: BUILD, build: BUILD, latest: { version: BUILD } })
    expect(view.rejected).toBe(0)
    expect(registry.seen).toHaveLength(1)
    // A captured template may ask again (with its etag): every read asked as this build.
    expect(new Set(codex.modelListReads.map((read) => read.clientVersion))).toEqual(new Set([BUILD]))
    // The model is registered from the catalog, its Codex window unknown: the catalog's.
    expect(await registered(rig, NEWER.slug)).toMatchObject({ input: 922_000 })
    // Nothing of the user went to the registry.
    const headers = registry.seen[0]?.headers ?? {}
    expect(headers["user-agent"]).toBe(CodexMeta.LATEST.userAgent)
    for (const name of ["authorization", "cookie", "chatgpt-account-id", "session-id", "originator"])
      expect(headers[name]).toBeUndefined()
  })

  test(
    "a day later Codex 0.172.0 is out: the next start reads it and the newer model gets its Codex window, no rebuild",
    async () => {
      const rig = required(fixture.rig)
      const codex = required(fixture.codex)
      const registry = required(fixture.registry)
      registry.latest.version = "0.172.0"
      // A day passes: the release read at the first start is older than a day when the service starts again.
      const file = path.join(rig.home, "codex-meta.json")
      const stored = Schema.decodeUnknownSync(CodexModels.File)(await Bun.file(file).json())
      const latest = required(stored.latest)
      await replaceFile(file, JSON.stringify({ ...stored, latest: { ...latest, fetchedAt: latest.fetchedAt - DAY } }))
      await rig.restart()
      await waitUntil(
        async () => (await registered(rig, NEWER.slug))?.input === 900_000,
        "the newer model never got its Codex window",
      )
      expect(registry.seen).toHaveLength(2)
      expect(codex.modelListReads.at(-1)?.clientVersion).toBe("0.172.0")
      const view = await codexModels(rig)
      expect(view).toMatchObject({
        autoVersion: true,
        version: "0.172.0",
        build: BUILD,
        latest: { version: "0.172.0" },
        // gpt-7-preview: own's Codex harness has no such apply_patch tool, so its row is left out and counted with the
        // field; gpt-6.9-sol runs from its served row (no instructions: the nearest bundled model's).
        rejected: 1,
        accounts: { [rig.accounts["01"]?.id ?? ""]: 1 },
        left: [{ slug: "gpt-7-preview", field: "apply_patch_tool_type", value: '"json_patch"' }],
        borrowed: [{ slug: UNCATALOGUED.slug, from: CodexModels.nearest(UNCATALOGUED.slug) }],
      })
      const meta = Schema.decodeUnknownSync(CodexModels.File)(await Bun.file(file).json())
      expect(meta.kinds.codex?.models.map((model) => model.slug)).toContain(NEWER.slug)
      expect(meta.kinds.codex?.models.map((model) => model.slug)).not.toContain("gpt-7-preview")
      expect(meta.kinds.codex?.models.map((model) => model.slug)).toContain(UNCATALOGUED.slug)
      expect(meta.kinds.codex?.harness?.map((row) => row.slug)).toContain(UNCATALOGUED.slug)
      // models.dev does not list it: the codex slot registers it from its row (10 §6.14), with the row's name and window,
      // and the account's view marks it `served` (the picker's quiet note).
      await waitUntil(
        async () => (await registered(rig, UNCATALOGUED.slug))?.input === 900_000,
        "the served-only model never registered",
      )
      const named = (await rig.server.models()).find((item) => item.providerID === SLOT && item.id === UNCATALOGUED.slug)
      expect(isRecord(named) && named.name).toBe(UNCATALOGUED.display_name)
      const listed = await rig.call("accounts.list", {})
      const account = (listed.accounts as ReadonlyArray<Record<string, unknown>>).find((item) => item.providerID === SLOT)
      expect(account?.models).toContainEqual({ id: UNCATALOGUED.slug, source: "served" })
    },
    STEP_TIMEOUT,
  )

  test(
    "off asks as this build again and reads no release; on again asks as the newest release",
    async () => {
      const rig = required(fixture.rig)
      const codex = required(fixture.codex)
      const registry = required(fixture.registry)
      const off = Schema.decodeUnknownSync(CodexModels.View)(
        await rig.call("codexModels.set", { autoVersion: false }),
      )
      expect(off).toMatchObject({ autoVersion: false, version: BUILD, latest: { version: "0.172.0" } })
      await waitUntil(
        async () => (await registered(rig, NEWER.slug))?.input === 922_000,
        "the newer model kept its Codex window with the setting off",
      )
      expect(codex.modelListReads.at(-1)?.clientVersion).toBe(BUILD)
      expect(await codexModels(rig)).toMatchObject({ autoVersion: false, version: BUILD, rejected: 0 })
      const on = Schema.decodeUnknownSync(CodexModels.View)(await rig.call("codexModels.set", { autoVersion: true }))
      expect(on).toMatchObject({ autoVersion: true, version: "0.172.0" })
      await waitUntil(
        async () => (await registered(rig, NEWER.slug))?.input === 900_000,
        "the newer model never got its Codex window back",
      )
      // The release read this day is still fresh: no second read.
      expect(registry.seen).toHaveLength(2)
      // Every window and device heard the setting change.
      const changed = rig.events.own("codexModels.changed").map((event) => event.data.view)
      expect(changed.some((view) => isRecord(view) && view.autoVersion === false && view.version === BUILD)).toBe(true)
      expect(rig.server.logs()).not.toMatch(/hook_failed|event_handler_failed|codex_meta_refresh_failed/)
    },
    STEP_TIMEOUT,
  )
})

/** `codexModels.get` decoded. */
async function codexModels(rig: PresetRig) {
  return Schema.decodeUnknownSync(CodexModels.View)(await rig.call("codexModels.get", {}))
}

/** The `limit` a model of the ChatGPT account is registered with (`GET /api/model`). */
async function registered(rig: PresetRig, id: string) {
  const model = (await rig.server.models()).find((item) => item.providerID === SLOT && item.id === id)
  return isRecord(model) && isRecord(model.limit) ? model.limit : undefined
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture not ready")
  return value
}

