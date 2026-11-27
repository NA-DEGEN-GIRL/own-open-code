import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  Account,
  Alert,
  Cache,
  CodexModels,
  Credential,
  Estimate,
  Kind,
  Kv,
  Ledger,
  Limit,
  OwnAccounts,
  OwnError,
  OwnID,
  Plugin,
  Policy,
  Preset,
  Ratecard,
  Registry,
  Switch,
  Voice,
} from "../src/index.js"

const namespaces = [
  Account,
  Alert,
  Cache,
  CodexModels,
  Credential,
  Estimate,
  Kind,
  Kv,
  Ledger,
  Limit,
  OwnAccounts,
  OwnError,
  OwnID,
  Plugin,
  Policy,
  Preset,
  Ratecard,
  Registry,
  Switch,
  Voice,
]
const schemas = [
  ...new Set(namespaces.flatMap((namespace) => Object.values(namespace).filter((value) => Schema.isSchema(value)))),
]

describe("contract hygiene", () => {
  test("public identifiers are namespaced and unique", () => {
    const identifiers = schemas.flatMap((schema) => {
      const identifier = schema.ast.annotations?.identifier
      return typeof identifier === "string" ? [identifier] : []
    })
    expect(identifiers.length).toBeGreaterThan(80)
    expect(identifiers.filter((identifier) => !identifier.startsWith("Own."))).toEqual([])
    expect(identifiers.filter((identifier, index) => identifiers.indexOf(identifier) !== index)).toEqual([])
  })

  test("the synthetic Claude slot id and account id schema are shared", () => {
    expect(Account.ID.claudeSlot).toBe(Account.ID.make("acc_claude_slot"))
    expect<string>(Registry.ClaudeSlot.fields.accountID.literal).toBe(Account.ID.claudeSlot)
  })

  test("optional properties omit undefined when encoding", () => {
    const encoded = Schema.encodeSync(Account.Identity)({ emailMasked: "na***@gmail.com", plan: undefined })
    expect(encoded).toEqual({ emailMasked: "na***@gmail.com" })
  })
})
