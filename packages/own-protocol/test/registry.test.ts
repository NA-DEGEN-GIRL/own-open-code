import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Account, Credential, Kind, Registry } from "../src/index.js"
import { accountsFile, CODEX_ACCOUNT, roundTrip, templateModel } from "./fixtures.js"

const decode = Schema.decodeUnknownSync(Registry.File)

describe("accounts.json", () => {
  test("decodes the 02 §2.4.1 example and encodes it back unchanged", () => {
    const file = decode(accountsFile)
    expect(file.accounts.map((account): string => account.providerID)).toEqual(["own-codex-7k2m", "own-anth-w3p8"])
    expect(file.slots["own-codex-7k2m"].transport).toBe("websocket")
    expect(file.accounts[0].credential).toBeUndefined()
    expect(roundTrip(Registry.File, accountsFile)).toEqual(accountsFile)
  })

  test("template models are Model.Info without providerID", () => {
    expect(roundTrip(Registry.TemplateModel, templateModel)).toEqual(templateModel)
    expect(Object.keys(Registry.TemplateModel.fields)).not.toContain("providerID")
  })

  test("keeps unknown fields when decoded and encoded with preserveUnknown", () => {
    const future = {
      ...accountsFile,
      futureTopLevel: { enabled: true },
      accounts: [{ ...accountsFile.accounts[0], futureAccountField: 7 }, accountsFile.accounts[1]],
    }
    expect(roundTrip(Registry.File, future, { keepUnknown: true })).toEqual(future)
    expect(roundTrip(Registry.File, future)).toEqual(accountsFile)
  })

  test("rejects malformed registry keys instead of silently dropping them", () => {
    const badSlot = {
      ...accountsFile,
      slots: { ...accountsFile.slots, "own-codex-7K2M": accountsFile.slots["own-codex-7k2m"] },
    }
    expect(() => decode(badSlot)).toThrow()
    const badDomain = {
      ...accountsFile,
      cacheDomains: { ...accountsFile.cacheDomains, domain: accountsFile.cacheDomains.cd_7k2m },
    }
    expect(() => decode(badDomain)).toThrow()
    expect(() =>
      decode({ ...accountsFile, modelTemplates: { codex: accountsFile.modelTemplates.tpl_codex_20260926 } }),
    ).toThrow()
  })

  test("rejects wrong schema versions, unknown kinds and statuses", () => {
    expect(() => decode({ ...accountsFile, schemaVersion: 2 })).toThrow()
    expect(() => decode({ ...accountsFile, accounts: [{ ...accountsFile.accounts[0], kind: "claude-sub" }] })).toThrow()
    expect(() => decode({ ...accountsFile, accounts: [{ ...accountsFile.accounts[0], status: "gone" }] })).toThrow()
    expect(() => decode({ ...accountsFile, accounts: [{ ...accountsFile.accounts[0], id: "01JAX3" }] })).toThrow()
  })

  test("a Sign in with ChatGPT account has its own kind, method and chatgpt_sharing domains", () => {
    const siwc = {
      ...accountsFile.accounts[0],
      id: "acc_01JAXBABCDEFGHJKMNPQRSTVWX",
      kind: "siwc",
      providerID: "own-siwc-r4t6",
      cacheDomain: "cd_r4t6",
      quotaDomain: "qd_r4t6",
      identity: { emailMasked: "na***@gmail.com", fingerprint: "sha256:9a1f00" },
      method: "chatgpt-siwc",
    }
    const file = {
      ...accountsFile,
      cacheDomains: {
        ...accountsFile.cacheDomains,
        cd_r4t6: { kind: "siwc", scope: "chatgpt_sharing", externalId: "oaiapp_fake0123", poolingVerified: false },
      },
      quotaDomains: {
        ...accountsFile.quotaDomains,
        qd_r4t6: { kind: "siwc", scope: "chatgpt_sharing", externalId: "oaiapp_fake0123" },
      },
      accounts: [...accountsFile.accounts, siwc],
      slots: {
        ...accountsFile.slots,
        "own-siwc-r4t6": { kind: "siwc", accounts: [siwc.id], pooling: "off", modelTemplate: "tpl_siwc_20261001" },
      },
    }
    expect(roundTrip(Registry.File, file)).toEqual(file)
    expect(decode(file).accounts[2]).toMatchObject({ kind: "siwc", method: "chatgpt-siwc" })
    expect(() =>
      decode({ ...file, accounts: [...accountsFile.accounts, { ...siwc, method: "chatgpt-sharing" }] }),
    ).toThrow()
  })

  test("a slot needs at least one account", () => {
    const slot = { ...accountsFile.slots["own-codex-7k2m"], accounts: [] }
    expect(() => Schema.decodeUnknownSync(Registry.Slot)(slot)).toThrow()
  })
})

describe("pinned template diff (07 §4.4, T2)", () => {
  const template = accountsFile.modelTemplates.tpl_codex_20260926
  const added = { ...templateModel, id: "gpt-6.1-sol", modelID: "gpt-6.1-sol", addedAt: "2026-10-01T09:00:00Z" }
  const missing = { ...templateModel, upstream: "missing" }
  const update = { detectedAt: "2026-10-02T03:04:05Z", fields: ["name", "variants"] }

  test("a pre-T2 registry still decodes, with none of the T2 marks", () => {
    const file = decode(accountsFile)
    const pinned = file.modelTemplates[Object.keys(file.modelTemplates)[0] ?? ""]
    expect(pinned?.update).toBeUndefined()
    expect(pinned?.models.map((item) => [item.addedAt, item.upstream])).toEqual([[undefined, undefined]])
    expect(roundTrip(Registry.File, accountsFile)).toEqual(accountsFile)
  })

  test("a model added after capture carries addedAt; a model gone upstream stays with upstream: missing", () => {
    const file = { ...accountsFile, modelTemplates: { tpl_codex_20260926: { ...template, models: [missing, added] } } }
    expect(roundTrip(Registry.File, file)).toEqual(file)
    const models = decode(file).modelTemplates.tpl_codex_20260926?.models ?? []
    expect(models.map((item) => [String(item.id), item.addedAt, item.upstream])).toEqual([
      ["gpt-5.5", undefined, "missing"],
      ["gpt-6.1-sol", "2026-10-01T09:00:00Z", undefined],
    ])
    expect(() => Schema.decodeUnknownSync(Registry.TemplateModel)({ ...templateModel, upstream: "gone" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Registry.TemplateModel)({ ...templateModel, addedAt: "yesterday" })).toThrow()
    // Still a Model.Info without providerID.
    expect(Object.keys(Registry.TemplateModel.fields)).not.toContain("providerID")
  })

  test("a fixed-field change waits on the template as update{detectedAt, fields}", () => {
    const file = { ...accountsFile, modelTemplates: { tpl_codex_20260926: { ...template, update } } }
    expect(roundTrip(Registry.File, file)).toEqual(file)
    expect(decode(file).modelTemplates.tpl_codex_20260926?.update).toEqual(update)
    expect(roundTrip(Registry.ModelTemplate, template)).toEqual(template)
    expect(() => Schema.decodeUnknownSync(Registry.ModelTemplate)({ ...template, update: { fields: [] } })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Registry.ModelTemplate)({ ...template, update: { ...update, fields: [""] } }),
    ).toThrow()
  })
})

describe("credential refs", () => {
  const source = {
    app: "codex-multi-provider",
    profileID: "a1a1a1a1-0000-4000-8000-000000000001",
    alias: "personal",
    authPath: "D:\\#Projects\\codex-multi-provider\\work\\control-center\\profiles\\a1a1a1a1\\codex\\auth.json",
  }
  const withCredential = (credential: unknown) => ({
    ...accountsFile,
    accounts: [{ ...accountsFile.accounts[0], credential }, accountsFile.accounts[1]],
  })

  const legacy = {
    app: "codex-multi-provider",
    providerRef: "legacy:deepseek",
    name: "DeepSeek",
    path: "D:\\#Projects\\codex-multi-provider\\profiles\\deepseek.dpapi",
  }

  test("accounts may be vault, linked-codex-source, takeover-codex-source or linked-legacy-key", () => {
    const refs = [
      { type: "vault" },
      { type: "linked-codex-source", source, linkedAt: "2026-09-27T01:02:03.456Z" },
      { type: "takeover-codex-source", source, takenOverAt: "2026-09-27T01:02:03Z" },
      { type: "linked-legacy-key", source: legacy, linkedAt: "2026-09-28T01:02:03Z" },
      {
        type: "linked-legacy-key",
        source: {
          ...legacy,
          providerRef: "dpapi:207a1ccd-b02d-42f3-b559-8c577bf22e9c",
          name: null,
          path: "D:\\x\\codex-multi-provider\\work\\control-center\\credentials\\207a1ccd-b02d-42f3-b559-8c577bf22e9c.dpapi",
        },
        linkedAt: "2026-09-28T01:02:03Z",
      },
    ]
    for (const ref of refs) {
      expect<string | undefined>(decode(withCredential(ref)).accounts[0].credential?.type).toBe(ref.type)
      expect(roundTrip(Registry.File, withCredential(ref))).toEqual(withCredential(ref))
    }
  })

  test("linked refs hold a source location only", () => {
    expect(() => decode(withCredential({ type: "linked-codex-source", source, linkedAt: "yesterday" }))).toThrow()
    expect(() =>
      decode(
        withCredential({
          type: "linked-codex-source",
          source: { ...source, app: "codex-cli" },
          linkedAt: "2026-09-27T01:02:03Z",
        }),
      ),
    ).toThrow()
    expect(() =>
      decode(
        withCredential({
          type: "linked-codex-source",
          source: { ...source, profileID: "..\\escape" },
          linkedAt: "2026-09-27T01:02:03Z",
        }),
      ),
    ).toThrow()
    expect(() => decode(withCredential({ type: "copied", source }))).toThrow()
    // A linked key names the old app's credential ref, never a key; unknown refs are refused.
    for (const providerRef of ["deepseek", "legacy:other", "dpapi:../x", "dpapi:207A1CCD-B02D-42F3-B559-8C577BF22E9C"])
      expect(() =>
        decode(
          withCredential({
            type: "linked-legacy-key",
            source: { ...legacy, providerRef },
            linkedAt: "2026-09-28T01:02:03Z",
          }),
        ),
      ).toThrow()
    expect(() =>
      decode(
        withCredential({
          type: "linked-legacy-key",
          source: { ...legacy, path: "" },
          linkedAt: "2026-09-28T01:02:03Z",
        }),
      ),
    ).toThrow()
  })

  test("the credential tag is exhaustive", () => {
    const describe = (ref: Credential.Ref) =>
      Credential.Ref.match(ref, {
        vault: () => "vault",
        "linked-codex-source": (linked) => `linked:${linked.source.profileID}`,
        "takeover-codex-source": (takeover) => `takeover:${takeover.source.profileID}`,
        "linked-legacy-key": (linked) => `key:${linked.source.providerRef}`,
      })
    expect(describe({ type: "vault" })).toBe("vault")
    expect(
      describe(
        Schema.decodeUnknownSync(Credential.Ref)({
          type: "linked-codex-source",
          source,
          linkedAt: "2026-09-27T01:02:03Z",
        }),
      ),
    ).toBe(`linked:${source.profileID}`)
    expect(
      describe(
        Schema.decodeUnknownSync(Credential.Ref)({
          type: "linked-legacy-key",
          source: legacy,
          linkedAt: "2026-09-28T01:02:03Z",
        }),
      ),
    ).toBe("key:legacy:deepseek")
  })
})

describe("ids", () => {
  test("own provider ids follow own-<kind>-<slug>", () => {
    expect(Kind.ProviderID.parse("own-codex-7k2m")).toEqual({ kind: "codex", slug: "7k2m" })
    expect(Kind.ProviderID.parse("own-compat-b5n0abcd")).toEqual({ kind: "compat", slug: "b5n0abcd" })
    for (const invalid of [
      "anthropic",
      "openai",
      "own-codex-7K2M",
      "own-foo-1234",
      "own-codex-abc",
      "own-codex-123456789",
      "own-oai-a/b1",
    ])
      expect(Kind.ProviderID.parse(invalid)).toBeUndefined()
    for (const kind of Kind.own) {
      const id = Kind.ProviderID.create(kind)
      expect(Kind.ProviderID.parse(id)?.kind).toBe(kind)
      expect(Schema.is(Kind.ProviderID)(id)).toBe(true)
    }
    expect(Kind.ProviderID.from("oai", "q9x1")).toBe(Kind.ProviderID.make("own-oai-q9x1"))
    expect(() => Kind.ProviderID.from("oai", "Q9")).toThrow()
  })

  test("siwc slots use the own-siwc-<slug> form", () => {
    expect(Kind.ProviderID.parse("own-siwc-r4t6")).toEqual({ kind: "siwc", slug: "r4t6" })
    expect(Kind.ProviderID.from("siwc", "r4t6")).toBe(Kind.ProviderID.make("own-siwc-r4t6"))
    expect(Kind.ProviderID.parse("own-siwc-R4T6")).toBeUndefined()
    expect(Schema.is(Kind.Any)("siwc")).toBe(true)
    expect(Schema.is(Kind.Api)("siwc")).toBe(false)
  })

  test("ChatGPT OAuth kinds are codex and siwc", () => {
    expect(Kind.OAuth.literals).toEqual(["codex", "siwc"])
    expect(Kind.own.filter((kind) => Kind.isOAuth(kind))).toEqual(["codex", "siwc"])
    for (const kind of ["oai", "anth", "ds", "xai", "or", "compat", "claude-sub", "openai", ""])
      expect(Kind.isOAuth(kind)).toBe(false)
  })

  test("every own kind has provider metadata", () => {
    expect(Object.keys(Kind.meta).sort()).toEqual([...Kind.own].sort())
    expect(Kind.meta.codex.canonical).toBe("openai")
    expect(Kind.meta.siwc).toEqual({
      canonical: "openai",
      package: "@opencode/ai/providers/openai",
      billing: "subscription",
      builtin: "openai",
      writesCanonical: true,
    })
    expect(Kind.meta.compat.writesCanonical).toBe(false)
    expect(Kind.meta.ds.package).toBe("@opencode/ai/providers/deepseek")
  })

  test("account ids are acc_<ulid> or the synthetic Claude slot id", () => {
    const id = Account.ID.create()
    expect(id).toMatch(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(Account.ID.claudeSlot).toBe(Account.ID.make("acc_claude_slot"))
    expect(Schema.is(Account.ID)(CODEX_ACCOUNT)).toBe(true)
    expect(Schema.is(Account.ID)("account_1")).toBe(false)
  })
})

describe("trust.json", () => {
  test("is a bare array of approvals", () => {
    const trust = [
      {
        location: "D:\\tmp\\cloned",
        source: "local:D:\\tmp\\cloned\\.opencode\\plugins\\x.ts",
        sha256: "9f1c".padEnd(64, "0"),
        approvedAt: "2026-09-26T11:30:00Z",
      },
    ]
    expect(roundTrip(Registry.TrustFile, trust)).toEqual(trust)
    expect(() => Schema.decodeUnknownSync(Registry.TrustFile)([{ ...trust[0], sha256: "9f1c" }])).toThrow()
  })
})
