import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { OwnAccounts } from "../src/rpc.js"
import { OwnRemote } from "../src/rpc-remote.js"
import { Portable } from "../src/portable.js"

type Standard = { "~standard": { validate: (value: unknown) => Result } }

/** What the host (`packages/core/src/rpc.ts` `encode`/`parse`) does with a method schema. */
type Result = { value?: unknown; issues?: { message: string }[] }

function hostEncode(schema: unknown, value: unknown): Promise<Result> {
  if (Schema.isSchema(schema))
    return Effect.runPromise(Schema.encodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(value)).then(
      (encoded) => ({ value: encoded }),
      (error: unknown) => ({ issues: [{ message: String((error as Error).message) }] }),
    )
  return Promise.resolve((schema as Standard)["~standard"].validate(value))
}

describe("Portable.definition", () => {
  test("replaces every Effect schema with a plain Standard Schema object", () => {
    for (const source of [OwnAccounts.Definition, OwnRemote.Definition, OwnRemote.AgentDefinition]) {
      const portable = Portable.definition(source)
      expect(portable.id).toBe(source.id)
      expect(Object.keys(portable.methods).sort()).toEqual(Object.keys(source.methods).sort())
      expect(Object.keys(portable.events).sort()).toEqual(Object.keys(source.events).sort())
      for (const method of Object.values(portable.methods) as { input: unknown; output: unknown; errors?: object }[]) {
        for (const schema of [method.input, method.output, ...Object.values(method.errors ?? {})]) {
          expect(Schema.isSchema(schema)).toBe(false)
          expect(typeof (schema as Standard)["~standard"].validate).toBe("function")
        }
      }
      for (const event of Object.values(portable.events) as { schema: unknown }[]) expect(Schema.isSchema(event.schema)).toBe(false)
    }
  })

  test("decodes inputs and encodes outputs with the same rules as the Effect schemas", () => {
    const portable = Portable.definition(OwnRemote.Definition)
    const status = portable.methods["gateway.status"] as unknown as { input: Standard; output: Standard }
    expect(status.input["~standard"].validate({})).toEqual({ value: {} })
    const view = {
      enabled: false,
      state: "off",
      problem: null,
      bind: "127.0.0.1",
      port: null,
      url: null,
      publicOrigin: null,
      tailscale: { state: "missing", version: null, dnsName: null, serving: null, serveCommand: null },
      devices: { active: 0, pairing: 0 },
    }
    expect(status.output["~standard"].validate(view)).toEqual({ value: view })
    const broken = status.output["~standard"].validate({ ...view, devices: { active: 1.5, pairing: 0 } })
    expect(broken.issues?.[0]?.message).toContain("Expected an integer")
  })

  test("07 §8.1 preset methods: inputs decode and outputs encode through the portable definition", () => {
    const methods = Portable.definition(OwnAccounts.Definition).methods as unknown as Record<
      string,
      { input: Standard; output: Standard; errors: Record<string, Standard> }
    >
    const SAVED = "pr_01JB0000000000000000000000"
    const ref = { providerID: "own-codex-7k2m", id: "gpt-6-astra", variant: "high" }
    const caps = { concurrent: 3, perMessage: 12, perSession: 100 }
    const binding = {
      presetID: SAVED,
      group: "codex",
      revision: 1,
      appliedAt: 1790000000000,
      entryHash: null,
      ultra: { before: "high" },
    }
    const draft = {
      name: "가볍게 나눠 쓰기",
      group: "codex",
      workers: { mode: "by-role", roles: { explore: { targets: [{ rel: "lighter" }], effort: "inherit" } } },
      delegation: "when-useful",
      caps,
      ultraCaps: null,
    }
    const info = { ...draft, id: SAVED, revision: 1 }
    const resolution = {
      main: ref,
      roles: {
        explore: { targets: [{ target: { rel: "lighter" }, skip: "lighter-unknown" }], use: ref, fallback: true },
      },
    }
    const cases: Array<[string, unknown, unknown]> = [
      [
        "presets.suggest",
        { group: "codex", template: "light-split" },
        {
          draft,
          rows: { explore: { targets: [{ rel: "lighter" }], fill: "lighter" } },
          starters: [{ template: "local-explore", name: "로컬로 탐색", available: false, problem: "no-local" }],
        },
      ],
      ["presets.set", { preset: draft, dryRun: true }, { preset: info, resolution, warnings: [], dryRun: true }],
      ["presets.remove", { presetID: SAVED }, { presetID: SAVED, group: "codex", star: "builtin:codex" }],
      [
        "presets.defaults.set",
        { group: "codex", star: SAVED, newSession: "star", ultraCaps: "save" },
        { group: "codex", defaultModel: null },
      ],
      [
        "session.preset.get",
        { sessionID: "ses_1" },
        {
          binding,
          preset: info,
          resolution,
          caps,
          counts: { running: 1, message: 2, session: 3 },
          spend: 0,
        },
      ],
      [
        "session.preset.apply",
        { sessionID: "ses_1", presetID: SAVED, team: null },
        { binding, resolution: null, entry: "unchanged", dryRun: false },
      ],
      [
        "session.ultra.set",
        { sessionID: "ses_1", on: false },
        { on: false, variant: { from: "max", to: "high" }, estimate: null, dryRun: false },
      ],
      ["session.preset.raiseOnce", { sessionID: "ses_1", perMessage: 24 }, { perMessage: 24 }],
      [
        "session.preset.consent",
        { sessionID: "ses_1", accountID: "acc_deepseek", allow: true },
        { accountID: "acc_deepseek", allow: true },
      ],
    ]
    for (const [name, input, output] of cases) {
      const method = methods[name]
      expect({ name, input: method?.input["~standard"].validate(input) }).toEqual({ name, input: { value: input } })
      expect({ name, output: method?.output["~standard"].validate(output) }).toEqual({
        name,
        output: { value: output },
      })
    }
    expect(
      methods["session.preset.raiseOnce"]?.input["~standard"].validate({ sessionID: "ses_1", perMessage: 0 }).issues
        ?.length,
    ).toBeGreaterThan(0)
    expect(
      methods["presets.set"]?.errors.same_company_subscription?.["~standard"].validate({ accountID: "acc_chatgpt02" }),
    ).toEqual({
      value: { accountID: "acc_chatgpt02" },
    })
    const events = Portable.definition(OwnAccounts.Definition).events as unknown as Record<string, { schema: Standard }>
    const changed = { eventId: "01JB0000000000000000000000", origin: "session", sessionID: "ses_1", binding }
    expect(events["session.preset.changed"]?.schema["~standard"].validate(changed)).toEqual({ value: changed })
  })

  test("devices.pair.start: appRoute is optional and only configured or loopback (08 §4.3)", () => {
    const start = Portable.definition(OwnRemote.Definition).methods["devices.pair.start"] as unknown as { input: Standard }
    const base = { name: "모바일 미리보기 (이 PC)", scopes: ["read"], servers: { mode: "all" }, expiresDays: 7 }
    expect(start.input["~standard"].validate(base)).toEqual({ value: base })
    for (const appRoute of ["configured", "loopback"])
      expect(start.input["~standard"].validate({ ...base, appRoute })).toEqual({ value: { ...base, appRoute } })
    expect(start.input["~standard"].validate({ ...base, appRoute: "tailnet" }).issues?.length).toBeGreaterThan(0)
  })
})

// The release bug this guards: a plugin bundle has its own `effect`; the host's parser fails every integer check of
// a schema built by that copy. Bundle own-protocol (with effect inlined) like FORK §8.2 step 3 and run the host path.
describe("across two copies of effect (a release plugin bundle inside opencode.exe)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "own-portable-"))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test("raw Effect definitions fail the host's integer check; portable ones pass", async () => {
    const src = path.join(import.meta.dir, "..", "src").replaceAll("\\", "/")
    const entry = path.join(dir, "portable-probe.ts")
    fs.writeFileSync(
      entry,
      [
        `import { OwnRemote } from "${src}/rpc-remote.ts"`,
        `import { Portable } from "${src}/portable.ts"`,
        `export const raw = OwnRemote.Definition`,
        `export const portable = Portable.definition(OwnRemote.Definition)`,
        ``,
      ].join("\n"),
    )
    const built = await Bun.build({ entrypoints: [entry], outdir: path.join(dir, "out"), target: "bun", format: "esm" })
    expect(built.success).toBe(true)
    const copy = (await import(path.join(dir, "out", "portable-probe.js"))) as {
      raw: typeof OwnRemote.Definition
      portable: typeof OwnRemote.Definition
    }
    const value = { active: 0, pairing: 0 }
    const devices = (definition: typeof OwnRemote.Definition) =>
      ((definition.methods["gateway.status"].output as unknown as { fields: { devices: unknown } }).fields?.devices ??
        undefined) as unknown
    // The raw schema from the bundle is an Effect schema to the host, which then cannot run its checks.
    const rawDevices = devices(copy.raw)
    expect(Schema.isSchema(rawDevices)).toBe(true)
    expect((await hostEncode(rawDevices, value)).issues?.[0]?.message).toContain("Expected an integer")
    // The portable method output is validated by the bundle's own copy.
    const output = copy.portable.methods["gateway.status"].output
    expect(Schema.isSchema(output)).toBe(false)
    const view = {
      enabled: true,
      state: "listening",
      problem: null,
      bind: "127.0.0.1",
      port: 28539,
      url: "http://127.0.0.1:28539",
      publicOrigin: null,
      tailscale: { state: "missing", version: null, dnsName: null, serving: null, serveCommand: null },
      devices: value,
    }
    const result = await hostEncode(output, view)
    expect(result.issues).toBeUndefined()
  })
})
