import { expect, test } from "bun:test"
import { teamTitle } from "./title"

test("an English screen says own.team's own titles in English", () => {
  expect(teamTitle("팀 메인", "main", "en")).toBe("Team main")
  expect(teamTitle("Game logic · 담당", "owner", "en")).toBe("Game logic · Owner")
})

test("a Korean screen, a title the user gave and other conversations stay as they are", () => {
  expect(teamTitle("팀 메인", "main", "ko")).toBe("팀 메인")
  expect(teamTitle("게임 로직 · 담당", "owner", "ko")).toBe("게임 로직 · 담당")
  expect(teamTitle("정리 작업", "main", "en")).toBe("정리 작업")
  expect(teamTitle("팀 메인", undefined, "en")).toBe("팀 메인")
  expect(teamTitle("메모 · 담당", "peer", "en")).toBe("메모 · 담당")
  expect(teamTitle(undefined, "main", "en")).toBeUndefined()
})
