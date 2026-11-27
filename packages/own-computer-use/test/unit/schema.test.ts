import { describe, expect, test } from "bun:test"
import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect"
import { Errors } from "../../src/core/errors.js"
import { ToolSchema } from "../../src/core/schema.js"

const decode = (name: ToolSchema.Name, input: unknown) => ToolSchema.decode(name, input)
const ok = (name: ToolSchema.Name, input: unknown) => Result.getOrThrow(decode(name, input))
const failure = (name: ToolSchema.Name, input: unknown) => {
  const result = decode(name, input)
  if (Result.isSuccess(result)) throw new Error(`${name} accepted ${JSON.stringify(input)}`)
  return result.failure
}

describe("tool inputs", () => {
  test("the tool set mirrors Anthropic's computer toolset members plus window tools", () => {
    const names: ReadonlyArray<string> = [...ToolSchema.NAMES].toSorted()
    expect(names).toEqual(
      [
        "screenshot",
        "zoom",
        "cursor_position",
        "list_windows",
        "focus_window",
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "left_click_drag",
        "mouse_move",
        "left_mouse_down",
        "left_mouse_up",
        "scroll",
        "type",
        "key",
        "hold_key",
        "wait",
      ].toSorted(),
    )
    for (const name of ToolSchema.NAMES) {
      // core `registrationError`: tool names and every Code Mode path segment
      expect(`computer_${name}`).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
      expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
      expect(ToolSchema.DESCRIPTIONS[name].length).toBeGreaterThan(10)
    }
  })

  test("valid inputs normalize into actions", () => {
    expect(ok("screenshot", {})).toEqual({ _tag: "screenshot", display: undefined, quality: undefined })
    expect(ok("screenshot", { display: 1, quality: "high" })).toEqual({
      _tag: "screenshot",
      display: 1,
      quality: "high",
    })
    expect(ok("zoom", { region: [10, 20, 110, 70] })).toEqual({
      _tag: "zoom",
      region: [10, 20, 110, 70],
      captureId: undefined,
    })
    expect(ok("left_click", { coordinate: [5, 6] })).toEqual({
      _tag: "click",
      button: "left",
      count: 1,
      at: { x: 5, y: 6 },
      modifiers: [],
      captureId: undefined,
    })
    expect(ok("right_click", {})).toMatchObject({ button: "right", count: 1, at: undefined })
    expect(ok("middle_click", {})).toMatchObject({ button: "middle", count: 1 })
    expect(ok("double_click", { coordinate: [1, 1], text: "shift+ctrl" })).toMatchObject({
      button: "left",
      count: 2,
      modifiers: ["ctrl", "shift"],
    })
    expect(ok("triple_click", { coordinate: [1, 1], captureId: "cap_ab1" })).toMatchObject({
      count: 3,
      captureId: "cap_ab1",
    })
    expect(ok("left_click_drag", { start_coordinate: [1, 2], coordinate: [30, 40], text: "alt" })).toEqual({
      _tag: "drag",
      from: { x: 1, y: 2 },
      to: { x: 30, y: 40 },
      modifiers: ["alt"],
      captureId: undefined,
    })
    expect(ok("mouse_move", { coordinate: [0, 0] })).toEqual({ _tag: "move", to: { x: 0, y: 0 }, captureId: undefined })
    expect(ok("left_mouse_down", {})).toEqual({ _tag: "button", button: "left", action: "down" })
    expect(ok("left_mouse_up", undefined)).toEqual({ _tag: "button", button: "left", action: "up" })
    expect(ok("scroll", { scroll_direction: "down", scroll_amount: 3 })).toEqual({
      _tag: "scroll",
      at: undefined,
      direction: "down",
      amount: 3,
      modifiers: [],
      captureId: undefined,
    })
    expect(ok("type", { text: "a\r\nb\tc" })).toEqual({ _tag: "type", text: "a\nb\tc" })
    expect(ok("key", { text: "ctrl+s" })).toMatchObject({ _tag: "key", repeat: 1, chords: [{ modifiers: ["ctrl"] }] })
    expect(ok("key", { text: "Down Down Return", repeat: 3 })).toMatchObject({ repeat: 3 })
    expect(ok("hold_key", { text: "shift", duration: 0.25 })).toEqual({
      _tag: "hold_key",
      chord: { modifiers: ["shift"] },
      durationMs: 250,
    })
    expect(ok("wait", { duration: 1.5 })).toEqual({ _tag: "wait", durationMs: 1500 })
    expect(ok("wait", { duration: 0 })).toEqual({ _tag: "wait", durationMs: 0 })
    expect(ok("focus_window", { windowId: "0x1a2b" })).toEqual({ _tag: "focus_window", windowId: "0x1a2b" })
    expect(ok("cursor_position", {})).toEqual({ _tag: "cursor_position" })
    expect(ok("list_windows", {})).toEqual({ _tag: "list_windows" })
  })

  test("every normalized action satisfies the Action schema", () => {
    const actions = [
      ok("screenshot", {}),
      ok("zoom", { region: [0, 0, 2, 2] }),
      ok("double_click", { coordinate: [3, 4], text: "ctrl" }),
      ok("left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] }),
      ok("scroll", { coordinate: [1, 1], scroll_direction: "left", scroll_amount: 30 }),
      ok("key", { text: "ctrl+shift+t 가" }),
      ok("hold_key", { text: "ctrl+alt", duration: 10 }),
      ok("type", { text: "x" }),
    ]
    for (const action of actions) expect(Schema.is(ToolSchema.Action)(action)).toBe(true)
  })

  test.each([
    ["left_click", { coordinate: [-1, 0] }],
    ["left_click", { coordinate: [0, 10_001] }],
    ["left_click", { coordinate: [Number.NaN, 2] }],
    ["left_click", { coordinate: [1, 2, 3] }],
    ["left_click", { coordinate: "1,2" }],
    ["left_click", { text: "hyper" }],
    ["left_click", { text: "ctrl+a" }],
    ["left_click", { text: "" }],
    ["zoom", { region: [10, 10, 5, 20] }],
    ["zoom", { region: [10, 10, 20, 10] }],
    ["zoom", {}],
    ["left_click_drag", { coordinate: [1, 1] }],
    ["mouse_move", {}],
    ["scroll", { scroll_direction: "down", scroll_amount: 0 }],
    ["scroll", { scroll_direction: "down", scroll_amount: 31 }],
    ["scroll", { scroll_direction: "sideways", scroll_amount: 1 }],
    ["type", { text: "" }],
    ["type", { text: "x".repeat(4_001) }],
    ["type", { text: "bell\u0007" }],
    ["key", { text: "" }],
    ["key", { text: "Foo_Bar" }],
    ["key", { text: "ctrl+" }],
    ["key", { text: "ctrl+a", repeat: 0 }],
    ["key", { text: "ctrl+a", repeat: 101 }],
    ["key", { text: Array.from({ length: 17 }, () => "a").join(" ") }],
    ["hold_key", { text: "shift", duration: 0.01 }],
    ["hold_key", { text: "shift", duration: 10.5 }],
    ["hold_key", { text: "a+b", duration: 1 }],
    ["wait", { duration: -1 }],
    ["wait", { duration: 31 }],
    ["screenshot", { display: -1 }],
    ["screenshot", { quality: "ultra" }],
    ["focus_window", { windowId: "" }],
  ] as const)("%s rejects %j", (name, input) => {
    const error = failure(name, input)
    expect(error.code).toBe("invalid_input")
    expect(error.message.startsWith("[computer.invalid_input] ")).toBe(true)
    expect(error.message).toContain(`computer.${name}`)
  })
})

describe("JSON Schema export", () => {
  // The same import core runs on a plain JSON Schema tool input (`core/src/tool/runtime.ts` `jsonSchema`).
  const imported = (name: ToolSchema.Name) =>
    Schema.make<Schema.Codec<unknown>>(
      SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(ToolSchema.jsonSchema(name))).ast,
    )

  test("every input exports an object schema that core can import (no pattern keywords)", () => {
    for (const name of ToolSchema.NAMES) {
      const schema = ToolSchema.jsonSchema(name)
      expect(schema.type).toBe("object")
      expect(JSON.stringify(schema)).not.toContain('"pattern"')
      // Parameter descriptions reach the model; annotations on wrappers would be dropped silently.
      for (const property of Object.values(schema.properties ?? {})) expect(property).toHaveProperty("description")
      expect(() => imported(name)).not.toThrow()
    }
  })

  test("the exported schema accepts the valid inputs and rejects structurally invalid ones", () => {
    const valid: ReadonlyArray<readonly [ToolSchema.Name, unknown]> = [
      ["screenshot", {}],
      ["left_click", { coordinate: [5, 6], text: "shift" }],
      ["left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] }],
      ["scroll", { scroll_direction: "up", scroll_amount: 30 }],
      ["key", { text: "ctrl+s", repeat: 100 }],
      ["hold_key", { text: "shift", duration: 0.05 }],
      ["type", { text: "hello" }],
      ["zoom", { region: [0, 0, 10, 10] }],
    ]
    const invalid: ReadonlyArray<readonly [ToolSchema.Name, unknown]> = [
      ["left_click", { coordinate: [-1, 0] }],
      ["left_click", { coordinate: [1] }],
      ["scroll", { scroll_direction: "up", scroll_amount: 31 }],
      ["scroll", { scroll_direction: "around", scroll_amount: 1 }],
      ["key", { text: "ctrl+s", repeat: 0 }],
      ["hold_key", { text: "shift", duration: 11 }],
      ["type", { text: "x".repeat(4_001) }],
      ["wait", {}],
    ]
    for (const [name, input] of valid)
      expect(Result.isSuccess(Schema.decodeUnknownResult(imported(name))(input))).toBe(true)
    for (const [name, input] of invalid)
      expect(Result.isFailure(Schema.decodeUnknownResult(imported(name))(input))).toBe(true)
  })

  test("fractional pixels are rounded to the pixel they fall in; other numbers stay strict", () => {
    expect(ok("left_click", { coordinate: [595.5, 387.2] })).toMatchObject({ at: { x: 596, y: 387 } })
    expect(ok("zoom", { region: [0.4, 0, 10.6, 10] })).toMatchObject({ region: [0, 0, 11, 10] })
    expect(Result.isFailure(decode("left_click", { coordinate: ["670", "432"] }))).toBe(true)
    expect(Result.isFailure(decode("scroll", { scroll_direction: "up", scroll_amount: 1.5 }))).toBe(true)
  })

  test("tuples name their item type, so a renderer without prefixItems still shows numbers", () => {
    const ordinate = { type: "integer", minimum: 0, maximum: ToolSchema.MAX_COORDINATE }
    const properties = (name: ToolSchema.Name) =>
      (ToolSchema.jsonSchema(name) as { properties: Record<string, Record<string, unknown>> }).properties
    for (const [name, field] of [
      ["left_click", "coordinate"],
      ["left_click_drag", "start_coordinate"],
      ["scroll", "coordinate"],
      ["zoom", "region"],
    ] as const)
      expect(properties(name)[field]).toMatchObject({ type: "array", items: ordinate })
    expect(properties("left_click").coordinate).toMatchObject({ minItems: 2, maxItems: 2 })
  })
})

describe("errors", () => {
  test("messages carry [computer.<code>] and model guidance", () => {
    for (const code of Errors.Code.literals) {
      const message = Errors.format(code)
      expect(message.startsWith(`[computer.${code}] `)).toBe(true)
      expect(message.length).toBeGreaterThan(`[computer.${code}] `.length + 20)
    }
    expect(new Errors.ComputerError("app_denied", "cmd is a terminal").message).toBe(
      `[computer.app_denied] cmd is a terminal. ${Errors.format("app_denied").slice("[computer.app_denied] ".length)}`,
    )
  })

  test("driver failures map onto model-facing codes", () => {
    expect(Errors.fromDriver(new Errors.DriverError("timeout", "no answer in 10000 ms")).code).toBe("timeout")
    expect(Errors.fromDriver(new Errors.DriverError("unavailable", "helper missing")).code).toBe("driver_unavailable")
    expect(Errors.fromDriver(new Errors.DriverError("protocol", "bad hello")).code).toBe("driver_unavailable")
    expect(Errors.fromDriver(new Errors.DriverError("desktop_unavailable", "secure desktop")).code).toBe(
      "desktop_unavailable",
    )
    expect(Errors.fromDriver(new Errors.DriverError("unknown_window", "gone")).code).toBe("unknown_window")
    expect(Errors.fromDriver(new Errors.DriverError("failed", "SendInput 0")).message).toContain("SendInput 0")
  })
})
