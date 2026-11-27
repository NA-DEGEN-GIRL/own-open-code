// Skills and MCP servers global first (03 §18.14, §19.6.1; decisions SG 2026-10-26): the skill switches and scopes of
// `skillset.view` and `skillset.switch`, their limits and the declared error, and the changed MCP shapes (a switch with
// no folder is the global one, `mcp.enable` takes `null` to delete one, `mcp.summary` carries the kept switches).
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OwnAccounts, OwnError, OwnMcp, OwnSkillset } from "../src/index.js"
import { roundTrip } from "./fixtures.js"

const methods = OwnAccounts.Definition.methods
const decode = (schema: Schema.Codec<unknown, unknown>, value: unknown) => Schema.decodeUnknownSync(schema)(value)
const rejects = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
  expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()
const input = <M extends keyof typeof methods>(name: M) =>
  // SAFETY: every method's input is an Effect schema with `~standard` attached (Rpc.PortableDefinition).
  methods[name].input as unknown as Schema.Codec<unknown, unknown>
const output = <M extends keyof typeof methods>(name: M) =>
  // SAFETY: as above, for the output.
  methods[name].output as unknown as Schema.Codec<unknown, unknown>

const PROJECT = "D:\\work\\game"

describe("skill switches and scopes", () => {
  test("a switch with no folder is every project's; one with a folder that project's", () => {
    expect(roundTrip(OwnSkillset.Switch, { id: "pdf", enabled: false })).toEqual({ id: "pdf", enabled: false })
    expect(roundTrip(OwnSkillset.Switch, { id: "pdf", directory: PROJECT, enabled: true })).toEqual({
      id: "pdf",
      directory: PROJECT,
      enabled: true,
    })
    rejects(OwnSkillset.Switch, { id: "", enabled: false })
    rejects(OwnSkillset.Switch, { id: "x".repeat(257), enabled: false })
    rejects(OwnSkillset.Switch, { id: "pdf", directory: "", enabled: false })
    rejects(OwnSkillset.Switch, { id: "pdf", directory: "x".repeat(4097), enabled: false })
    rejects(OwnSkillset.Switch, { id: "pdf" })
  })

  test("a scope names the skill's folder and the one project it is used in", () => {
    const scope = { folder: "C:\\Users\\demo\\.config\\own-open-code\\skills\\pdf", directory: PROJECT }
    expect(roundTrip(OwnSkillset.Scope, scope)).toEqual(scope)
    rejects(OwnSkillset.Scope, { folder: scope.folder })
    rejects(OwnSkillset.Scope, { folder: "", directory: PROJECT })
  })

  test("the view: the catalog without content, the records, and what is off in a project", () => {
    const view = {
      catalog: [
        { id: "pdf", name: "PDF", description: "Reads PDFs", path: "C:\\s\\pdf\\SKILL.md", autoinvoke: true },
        { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md" },
      ],
      switches: [{ id: "pdf", enabled: false }],
      scopes: [{ folder: "C:\\s\\deploy", directory: PROJECT }],
      off: [
        { id: "pdf", by: "global", name: "PDF", path: "C:\\s\\pdf\\SKILL.md" },
        { id: "gone", by: "project" },
      ],
    }
    expect(roundTrip(output("skillset.view"), view)).toEqual(view)
    // Content never travels: an unknown field is dropped, not kept.
    const withContent = { ...view, catalog: [{ ...view.catalog[0], content: "# PDF" }] }
    expect(decode(OwnSkillset.View, withContent)).toEqual({ ...view, catalog: [view.catalog[0]] })
    rejects(OwnSkillset.Off, { id: "pdf", by: "folder" })
    expect(roundTrip(input("skillset.view"), {})).toEqual({})
    expect(roundTrip(input("skillset.view"), { directory: PROJECT })).toEqual({ directory: PROJECT })
    rejects(input("skillset.view"), { directory: "" })
  })

  test("a change sets a switch or deletes it (null); a scope change sets or clears a scope; limits hold", () => {
    const change = {
      changes: [
        { id: "pdf", enabled: false },
        { id: "pdf", directory: PROJECT, enabled: true },
        { id: "pdf", directory: PROJECT, enabled: null },
      ],
      scopes: [
        { folder: "C:\\s\\deploy", directory: PROJECT },
        { folder: "C:\\s\\deploy", directory: null },
      ],
    }
    expect(roundTrip(input("skillset.switch"), change)).toEqual(change)
    expect(roundTrip(input("skillset.switch"), { changes: [] })).toEqual({ changes: [] })
    rejects(input("skillset.switch"), { scopes: [] })
    rejects(input("skillset.switch"), { changes: [{ id: "pdf" }] })
    rejects(input("skillset.switch"), { changes: Array.from({ length: 401 }, () => ({ id: "x", enabled: false })) })
    rejects(input("skillset.switch"), {
      changes: [],
      scopes: Array.from({ length: 201 }, () => ({ folder: "C:\\s\\x", directory: null })),
    })
    expect(OwnSkillset.MAX_SWITCHES).toBe(2_000)
    expect(OwnSkillset.MAX_SCOPES).toBe(500)
  })

  test("skillset.switch declares skillset_invalid; both methods are this PC's (remote_managed)", () => {
    expect(Object.keys(methods["skillset.switch"].errors).sort()).toEqual(
      ["internal_error", "remote_managed", "skillset_invalid"].sort(),
    )
    expect(Object.keys(methods["skillset.view"].errors).sort()).toEqual(["internal_error", "remote_managed"])
    const invalid = OwnError.data.skillset_invalid as unknown as Schema.Codec<unknown, unknown>
    for (const field of ["directory", "folder", "changes", "scopes"])
      expect(roundTrip(invalid, { field })).toEqual({ field })
    rejects(invalid, { field: "id" })
  })
})

describe("MCP switches global first", () => {
  test("a kept switch with no folder is the global one", () => {
    expect(roundTrip(OwnMcp.Override, { name: "files", enabled: false })).toEqual({ name: "files", enabled: false })
    expect(roundTrip(OwnMcp.Override, { directory: PROJECT, name: "files", enabled: true })).toEqual({
      directory: PROJECT,
      name: "files",
      enabled: true,
    })
    rejects(OwnMcp.Override, { directory: "", name: "files", enabled: true })
  })

  test("mcp.enable: the folder may be left out, and null deletes the switch", () => {
    const enable = input("mcp.enable")
    expect(roundTrip(enable, { name: "files", enabled: false })).toEqual({ name: "files", enabled: false })
    expect(roundTrip(enable, { directory: PROJECT, name: "files", enabled: null })).toEqual({
      directory: PROJECT,
      name: "files",
      enabled: null,
    })
    rejects(enable, { directory: "", name: "files", enabled: true })
    rejects(enable, { name: "files" })
  })

  test("mcp.summary carries the kept switches beside the servers", () => {
    const summary = {
      servers: [{ name: "files", scope: { type: "global" } }],
      overrides: [
        { name: "files", enabled: false },
        { directory: PROJECT, name: "files", enabled: true },
      ],
    }
    expect(roundTrip(output("mcp.summary"), summary)).toEqual(summary)
    rejects(output("mcp.summary"), { servers: [] })
  })
})
