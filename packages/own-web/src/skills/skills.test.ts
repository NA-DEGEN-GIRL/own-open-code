// Skills list (03 §19.6): project vs global by path (Windows paths too), the search order, and when `바로 실행`
// (`session.skill`) is offered.
import { describe, expect, test } from "bun:test"
import type { ServerRuntime } from "@/data"
import { loadSkills } from "./actions"
import { filterSkills, runBlock, skillSource, skillViews } from "./model"

const skills = [
  {
    id: "review-guide",
    name: "Review guide",
    description: "리뷰 체크리스트",
    path: "C:\\repo\\skills\\review-guide\\SKILL.md",
    content: "",
  },
  {
    id: "deploy",
    name: "Deploy",
    description: "배포 절차\n두 줄",
    autoinvoke: true,
    path: "C:/Users/me/.config/opencode/skills/deploy/SKILL.md",
    content: "",
  },
  { id: "git-review", name: "Git review", path: "c:/REPO/skills/git-review/SKILL.md", content: "" },
]

describe("skills", () => {
  test("project skills first (by name), then global; Windows paths compare without case", () => {
    const views = skillViews(skills, "C:\\repo")
    expect(views.map((view) => [view.id, view.source])).toEqual([
      ["git-review", "project"],
      ["review-guide", "project"],
      ["deploy", "global"],
    ])
    expect(views.find((view) => view.id === "deploy")).toMatchObject({ auto: true, description: "배포 절차 두 줄" })
    expect(skillSource("/home/me/repo/skills/a/SKILL.md", "/home/me/repo/")).toBe("project")
    expect(skillSource("/home/me/repo2/skills/a/SKILL.md", "/home/me/repo")).toBe("global")
    expect(skillSource("/home/me/Repo/a", "/home/me/repo")).toBe("global")
    expect(skillSource("/x", undefined)).toBe("global")
    // SK2: core's own skills are `기본 제공` here as in 설정 > 스킬, and come last.
    expect(skillSource("/builtin/opencode.md", "C:\\repo")).toBe("builtin")
    // Core's built-in skills are in memory since upstream v2.2.6 (69269e4ebe).
    expect(skillSource("skill://opencode/SKILL.md", "C:\\repo")).toBe("builtin")
    expect(
      skillViews([{ id: "opencode", name: "a", path: "/builtin/opencode.md", content: "" }, ...skills], "C:\\repo").map(
        (view) => view.source,
      ),
    ).toEqual(["project", "project", "global", "builtin"])
  })

  test("search: equal, prefix, word prefix, contained, then description", () => {
    const views = skillViews(skills, "C:\\repo")
    expect(filterSkills(views, "").length).toBe(3)
    expect(filterSkills(views, "review").map((view) => view.id)).toEqual(["review-guide", "git-review"])
    expect(filterSkills(views, "@deploy").map((view) => view.id)).toEqual(["deploy"])
    expect(filterSkills(views, "guide").map((view) => view.id)).toEqual(["review-guide"])
    expect(filterSkills(views, "체크").map((view) => view.id)).toEqual(["review-guide"])
    expect(filterSkills(views, "없는말")).toEqual([])
  })

  test("바로 실행 needs an open, idle, top-level session and the prompt scope", () => {
    const base = { sessionID: "ses_1", busy: false, child: false, canPrompt: true }
    expect(runBlock(base)).toBeUndefined()
    expect(runBlock({ ...base, sessionID: undefined })).toBe("noSession")
    expect(runBlock({ ...base, busy: true })).toBe("busy")
    expect(runBlock({ ...base, child: true })).toBe("child")
    expect(runBlock({ ...base, canPrompt: false })).toBe("scope")
  })
})

describe("loadSkills", () => {
  /** The data layer's per-location skill catalog: `sync` reads the server (or fails), `list` is what was read. */
  const runtime = (read: () => Promise<void>, known: typeof skills | undefined) =>
    ({ data: { location: { skill: { sync: read, list: () => known } } } }) as unknown as ServerRuntime
  const offline = () => Promise.reject(new TypeError("Failed to fetch"))
  const online = () => Promise.resolve()

  test("disconnected: the list read before, stale or not, rather than an error (as before SG)", async () => {
    expect(await loadSkills(runtime(offline, skills), "C:/repo")).toEqual(skills)
  })

  test("disconnected with no list read yet: the read's error; connected: the fresh list", async () => {
    await expect(loadSkills(runtime(offline, undefined), "C:/repo")).rejects.toThrow("Failed to fetch")
    expect(await loadSkills(runtime(online, skills.slice(0, 1)), "C:/repo")).toEqual(skills.slice(0, 1))
    expect(await loadSkills(runtime(online, undefined), "C:/repo")).toEqual([])
  })
})
