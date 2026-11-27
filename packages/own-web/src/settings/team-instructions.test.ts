// 팀 지시문 (06 §9.8, 2026-11-14): the block is counted on the text it sends (Windows line breaks once, trimmed, as
// own.team stores it), so the counter and the protocol's 2,000-character check agree; a line that starts like the
// harness's markers is refused here as the protocol refuses it; 기본으로 되돌리기 sends `null`; there is no compare
// view; screen copy and model text sit in sibling elements; and the page's words, in both languages.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { OwnTeam } from "@own/protocol/rpc-team"
import { Schema } from "effect"
import { teamEn, teamKo, teamText } from "@/team/strings"
import { blockProblem, BREAKERS, normalize, ROLES } from "./team-instructions"

const page = () => Bun.file(path.join(import.meta.dir, "team-instructions.tsx")).text()
const block = Schema.is(OwnTeam.InstructionBlock)

describe("the block (06 §9.8)", () => {
  test("Windows line breaks count once and the ends are trimmed, as own.team stores it", () => {
    expect(normalize("  가\r\n나\r\n\r\n")).toBe("가\n나")
    expect(normalize("가\n나")).toBe("가\n나")
    // 1,000 lines of one character each: 1,999 with \n, 2,998 if \r\n counted twice.
    const windows = Array.from({ length: 1_000 }, () => "가").join("\r\n")
    expect(normalize(windows).length).toBe(1_999)
    expect(blockProblem(windows, OwnTeam.INSTRUCTIONS_MAX)).toBeUndefined()
    // What the page sends is what the protocol takes.
    expect(block(normalize(windows))).toBe(true)
  })

  test("over the limit: refused here as the protocol refuses it", () => {
    const most = "가".repeat(OwnTeam.INSTRUCTIONS_MAX)
    expect(blockProblem(most, OwnTeam.INSTRUCTIONS_MAX)).toBeUndefined()
    expect(block(most)).toBe(true)
    expect(blockProblem(`${most}가`, OwnTeam.INSTRUCTIONS_MAX)).toBe("over")
    expect(block(`${most}가`)).toBe(false)
    // Trimmed first: spaces around the text do not count.
    expect(blockProblem(`  ${most}  `, OwnTeam.INSTRUCTIONS_MAX)).toBeUndefined()
  })

  test("a line that starts like the harness's markers is refused, anywhere in the block; inside a line it is fine", () => {
    expect(BREAKERS).toEqual(OwnTeam.INSTRUCTION_BREAKERS)
    for (const start of BREAKERS) {
      for (const text of [`${start}x`, `첫 줄\n${start}x`, `첫 줄\r\n${start}x`]) {
        expect(blockProblem(text, OwnTeam.INSTRUCTIONS_MAX), text).toBe("breaker")
        expect(block(normalize(text)), text).toBe(false)
      }
      const inside = `줄 안의 ${start}`
      expect(blockProblem(inside, OwnTeam.INSTRUCTIONS_MAX), inside).toBeUndefined()
      expect(block(inside), inside).toBe(true)
    }
  })

  test("the patch: one role's block, or `null` to reset it; empty resets too", () => {
    const patch = Schema.is(OwnTeam.SettingsPatch)
    for (const role of ROLES) {
      expect(patch({ instructions: { [role]: "나만의 방식" } }), role).toBe(true)
      expect(patch({ instructions: { [role]: null } }), role).toBe(true)
      expect(patch({ instructions: { [role]: "" } }), role).toBe(true)
    }
    expect(ROLES).toEqual(["main", "owner", "peer"])
  })
})

describe("the page (06 §9.8)", () => {
  test("it saves the normalised block, resets with `null` after a confirm, and has no compare view", async () => {
    const source = await page()
    expect(source).toContain("onSave({ instructions: { [at]: normalize(value()) } })")
    expect(source).toContain("onSave({ instructions: { [at]: null } })")
    expect(source).toContain('testid="settings-team-instructions-reset-ask"')
    expect(source).not.toMatch(/compare|diff|비교/i)
    // The count is of the normalised text, out of the limit the server sends.
    expect(source).toContain("normalize(value()).length")
    expect(source).toContain("props.view.limit")
  })

  test("screen copy and model text sit in sibling elements: no screen-copy element holds the model's text", async () => {
    const source = await page()
    const ui = [
      ...source.matchAll(/<div[^>]*data-testid="settings-team-instructions-ui"[^>]*>([\s\S]*?)\n {6}<\/div>/g),
    ]
    expect(ui.length).toBe(3)
    for (const match of ui) {
      expect(match[1]).not.toContain("settings-team-instructions-base")
      expect(match[1]).not.toContain("settings-team-instructions-block")
      expect(match[1]).not.toMatch(/\.program|\.guard|value\(\)\}/)
    }
    expect(source).toContain('data-testid="settings-team-instructions-base"')
    expect(source).toContain('data-testid="settings-team-instructions-block"')
  })

  test("its words, in both languages, with the same placeholders", () => {
    const keys = Object.keys(teamKo).filter((key) => key.startsWith("own.team.instructions."))
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) expect((teamEn as Record<string, string>)[key], key).toBeTruthy()
    const ko = (key: Parameters<typeof teamText.text>[1], params?: Record<string, string | number>) =>
      teamText.text("ko", key, params)
    expect(ko("own.team.instructions.baseNote")).toBe(
      "모델이 받는 글 그대로예요. 프로그램이 지키는 규칙이라 고칠 수 없어요.",
    )
    expect(ko("own.team.instructions.baseArea")).toBe(
      "'…' 자리에는 영역마다 다른 값이 들어가요. 영역에 따라 안내 몇 줄이 더 붙기도 해요.",
    )
    expect(ko("own.team.instructions.count", { n: "1,999", max: "2,000" })).toBe("1,999 / 2,000자")
    expect(ko("own.team.instructions.breaker")).toBe(
      "'</context>', '<context key=', 'Today's date:'로 시작하는 줄은 쓸 수 없어요.",
    )
    expect(ko("own.team.instructions.block")).toBe("일하는 방식")
    expect(ko("own.team.instructions.reset")).toBe("기본으로 되돌리기")
  })
})
