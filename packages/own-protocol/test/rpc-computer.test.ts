import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Rpc } from "@opencode/schema/rpc"
import { OwnComputer } from "../src/rpc-computer.js"
import { roundTrip, SESSION } from "./fixtures.js"

const Definition = OwnComputer.Definition
const methodNames = Object.keys(Definition.methods) as ReadonlyArray<OwnComputer.MethodName>
const input = (name: OwnComputer.MethodName) => Definition.methods[name].input as Schema.Codec<unknown, unknown>
const output = (name: OwnComputer.MethodName) => Definition.methods[name].output as Schema.Codec<unknown, unknown>

describe("own.computer definition", () => {
  test("declares the computer-use methods and events under its own id", () => {
    expect(Definition.id).toBe("own.computer")
    expect<ReadonlyArray<string>>([...methodNames].sort()).toEqual(
      [
        "status",
        "killswitch.engage",
        "killswitch.reset",
        "session.grants.get",
        "session.grants.set",
        "session.grants.revoke",
        "audit.list",
        "helper.restart",
      ].sort(),
    )
    expect(Object.keys(Definition.events).sort()).toEqual(["action", "status"])
  })

  test("every method has a scope; only reads and the Stop button are not local", () => {
    expect(Object.keys(OwnComputer.MethodScope).sort()).toEqual([...methodNames].sort())
    expect(Object.entries(OwnComputer.MethodScope).filter(([, scope]) => scope !== "local")).toEqual([
      ["status", "read"],
      ["audit.list", "read"],
      ["killswitch.engage", "drive"],
    ])
  })

  test("no rpc.* error names and every schema is portable (Standard Schema) and still an Effect schema", () => {
    const schemas = [
      ...methodNames.flatMap((name) => {
        const method = Definition.methods[name]
        expect(Object.keys(method.errors).filter((error) => error.startsWith("rpc."))).toEqual([])
        return [method.input, method.output]
      }),
      ...Object.values(Definition.events).map((event) => event.schema),
    ]
    for (const schema of schemas) {
      expect(Schema.isSchema(schema)).toBe(true)
      expect(typeof schema["~standard"].validate).toBe("function")
    }
    const portable: Rpc.PortableDefinition = Definition
    expect(portable.id).toBe(OwnComputer.ID)
  })
})

describe("method examples", () => {
  test("status: available with details, or only the reason", () => {
    const available = {
      available: true,
      buildId: "0123456789ab",
      version: "2.0.18-own.4",
      driver: "windows",
      approval: "session",
      policy: { allowApps: ["notepad"], denyApps: [], allowTerminals: false, allowSubagents: false },
      helper: { running: true, version: "0.1.0", protocol: 1 },
      killSwitch: { engaged: true, reason: "user_chord", at: 1_790_000_000_000 },
      lease: { holder: SESSION },
      grants: [{ sessionID: SESSION, apps: ["notepad"] }],
    }
    expect(roundTrip(output("status"), available)).toEqual(available)
    const unavailable = { available: false, reason: "unsupported", buildId: "dev", version: "0.0.0-dev" }
    expect(roundTrip(output("status"), unavailable)).toEqual(unavailable)
    expect(() => Schema.decodeUnknownSync(output("status"))({ ...unavailable, reason: "other" })).toThrow()
  })

  test("kill switch and helper", () => {
    expect(roundTrip(output("killswitch.engage"), { engaged: true, reason: "rpc", at: 5 })).toEqual({
      engaged: true,
      reason: "rpc",
      at: 5,
    })
    expect(roundTrip(output("killswitch.reset"), { engaged: false })).toEqual({ engaged: false })
    expect(roundTrip(output("helper.restart"), { running: false })).toEqual({ running: false })
  })

  test("session grants are bounded app names", () => {
    expect(roundTrip(input("session.grants.set"), { sessionID: SESSION, apps: ["notepad", "chrome"] })).toEqual({
      sessionID: SESSION,
      apps: ["notepad", "chrome"],
    })
    expect(roundTrip(input("session.grants.revoke"), { sessionID: SESSION })).toEqual({ sessionID: SESSION })
    expect(() => Schema.decodeUnknownSync(input("session.grants.set"))({ sessionID: SESSION, apps: [""] })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(input("session.grants.set"))({
        sessionID: SESSION,
        apps: Array.from({ length: 65 }, (_, index) => `app${index}`),
      }),
    ).toThrow()
  })

  test("audit list: limit 1–200, redacted entries", () => {
    expect(roundTrip(input("audit.list"), { sessionID: SESSION, limit: 200, before: 10 })).toEqual({
      sessionID: SESSION,
      limit: 200,
      before: 10,
    })
    expect(() => Schema.decodeUnknownSync(input("audit.list"))({ limit: 0 })).toThrow()
    expect(() => Schema.decodeUnknownSync(input("audit.list"))({ limit: 201 })).toThrow()
    const entry = {
      ts: 1_790_000_000_000,
      sessionID: SESSION,
      callID: "call_1",
      tool: "type",
      target: { app: "notepad", titleHash: "0123456789ab" },
      args: { text: { length: 5, sha256: "abcdefabcdef" } },
      outcome: "ok",
      ms: 120,
    }
    expect(roundTrip(output("audit.list"), { entries: [entry] })).toEqual({ entries: [entry] })
  })

  test("events", () => {
    const action = {
      sessionID: SESSION,
      tool: "left_click",
      app: "notepad",
      outcome: "denied",
      code: "app_denied",
      at: 1,
    }
    expect(roundTrip(Definition.events.action.schema as Schema.Codec<unknown, unknown>, action)).toEqual(action)
  })
})
