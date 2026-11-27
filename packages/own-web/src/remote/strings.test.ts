import { describe, expect, test } from "bun:test"
import { PROJECT_STATES, remoteEn, remoteKo } from "./strings"

// The three project states of a host (04 §5.6): the host settings and the add-host card list them from one table, and
// each line says what that state reads.
describe("project states of a host", () => {
  test("are the protocol's three values in the order of the control, each with a label and a line in both languages", () => {
    expect(PROJECT_STATES.map((state) => state.value)).toEqual(["disabled", "instructions", "trusted"])
    for (const state of PROJECT_STATES) {
      expect(remoteKo[state.label]).toBeString()
      expect(remoteKo[state.help]).toBeString()
      expect(remoteEn[state.label]).toBeString()
      expect(remoteEn[state.help]).toBeString()
    }
    expect(PROJECT_STATES.map((state) => remoteKo[state.label])).toEqual(["끔", "지시 파일만 (AGENTS.md)", "켬"])
  })

  test("every line names AGENTS.md, and only the middle one says it reads AGENTS.md but no code", () => {
    for (const state of PROJECT_STATES) expect(remoteKo[state.help]).toContain("AGENTS.md")
    expect(remoteKo["own.remote.projectConfig.off"]).toContain("AGENTS.md도")
    expect(remoteKo["own.remote.projectConfig.instructions"]).toContain("저장소의 코드는 실행되지 않아요")
    expect(remoteKo["own.remote.projectConfig.on"]).toContain("실행돼요")
    // Each line starts with its state's short name, so the list reads without the control.
    expect(remoteKo["own.remote.projectConfig.off"]).toStartWith("끔:")
    expect(remoteKo["own.remote.projectConfig.instructions"]).toStartWith("지시 파일만:")
    expect(remoteKo["own.remote.projectConfig.on"]).toStartWith("켬:")
  })
})
