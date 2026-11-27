import { describe, expect, test } from "bun:test"
import { teamText } from "@/team/strings"
import { roleLabel } from "./rows"

describe("team main row (06 §9.4)", () => {
  const main = teamText.text("ko", "own.team.role.main")

  test("the role word does not repeat what the title says: the default title 팀 메인 reads 팀 메인, not 메인 팀 메인", () => {
    expect(roleLabel("팀 메인", main)).toBeUndefined()
  })

  test("the English title says the role word too, in another case", () => {
    expect(roleLabel("Team main", teamText.text("en", "own.team.role.main"))).toBeUndefined()
  })

  test("a renamed main keeps its role word", () => {
    expect(roleLabel("정리 작업", main)).toBe(main)
    expect(roleLabel(undefined, main)).toBe(main)
  })
})
