// Worktree and background catalogs: every key has English, the same placeholders, and Korean particles resolve.
import { describe, expect, test } from "bun:test"
import { backgroundEn, backgroundKo, backgroundText } from "@/background/strings"
import { backgroundViewEn, backgroundViewKo } from "@/background/view-strings"
import type { ServerRuntime } from "@/data"
import { rootLabelKey } from "./api"
import { worktreePanelEn, worktreePanelKo } from "./panel-strings"
import { worktreeEn, worktreeKo, worktreeText } from "./strings"

const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).toSorted()

const catalogs = [
  ["worktree", worktreeKo, worktreeEn],
  ["worktree panel", worktreePanelKo, worktreePanelEn],
  ["background", backgroundKo, backgroundEn],
  ["background view", backgroundViewKo, backgroundViewEn],
] as const

describe("catalogs", () => {
  for (const [name, ko, en] of catalogs)
    test(`${name}: English for every key, same placeholders`, () => {
      const english = en as Record<string, string | undefined>
      for (const [key, value] of Object.entries(ko)) {
        expect(english[key], key).toBeDefined()
        expect(params(english[key]!), key).toEqual(params(value))
      }
    })

  test("no key is defined twice across the split catalogs", () => {
    const keys = catalogs.flatMap(([, ko]) => Object.keys(ko))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("Korean particles follow the name", () => {
    expect(worktreeText.text("ko", "own.worktree.created", { name: "calm-otter" })).toBe(
      "작업 폴더 calm-otter를 만들었어요",
    )
    expect(worktreeText.text("ko", "own.worktree.created", { name: "witty-falcon" })).toBe(
      "작업 폴더 witty-falcon을 만들었어요",
    )
    expect(backgroundText.text("en", "own.background.done.shell", { label: "bun test", code: 1 })).toBe(
      "bun test — finished (exit 1)",
    )
  })
})

describe("the project's own checkout (03 §14.1, 06 §9.1)", () => {
  // SAFETY: rootLabelKey reads only `team.teamsOfProject`.
  const runtime = (teamProject: string) =>
    ({
      team: { teamsOfProject: (projectID: string) => (projectID === teamProject ? [{ team: { id: "team_1" } }] : []) },
    }) as unknown as ServerRuntime

  test("is 메인 폴더 in a project with a team on, else 프로젝트 폴더", () => {
    expect(worktreeText.text("ko", rootLabelKey(runtime("prj_team"), "prj_team"))).toBe("메인 폴더")
    expect(worktreeText.text("ko", rootLabelKey(runtime("prj_team"), "prj_plain"))).toBe("프로젝트 폴더")
    expect(worktreePanelKo["own.worktree.homeHint"]).toBe("팀 메인이 일하는 폴더에서 바로 작업해요")
  })
})
