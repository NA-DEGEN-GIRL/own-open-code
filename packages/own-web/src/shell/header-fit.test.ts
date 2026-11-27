// The conversation header's give-way order (03 §4.4, MR7-17): the steps, which one is kept, and the rules shell.css has
// for each. The fit itself measures a laid-out header, which bun's DOM does not have: e2e shell.spec.ts and
// team.spec.ts check it.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { GIVE_WAY, giveWay } from "./header-fit"

const css = readFileSync(path.join(import.meta.dir, "../styles/shell.css"), "utf8")

describe("header give-way order", () => {
  test("nothing gives way first; then the cache text, the computer chip, the team pill, the approval, 에이전트 방식 and Git items, the title's floor twice, the Stop mark last", () => {
    expect(GIVE_WAY[0]).toBe("")
    const tokens = GIVE_WAY.slice(1).map((step, index) => {
      const before = GIVE_WAY[index]!.split(" ").filter(Boolean)
      const now = step.split(" ")
      expect(now.slice(0, -1)).toEqual(before)
      return now.at(-1)
    })
    expect(tokens).toEqual(["cache", "computer", "team", "approval", "harness", "git", "title", "title-min", "stop"])
  })

  test("the steps are tried in order and the first that fits is kept; the Stop mark goes only when that fits, else the kill switch stays", () => {
    const tried: string[] = []
    expect(giveWay((give) => (tried.push(give), give.endsWith("team")))).toBe("cache computer team")
    expect(tried).toEqual(GIVE_WAY.slice(0, 4))
    expect(giveWay((give) => give.endsWith("stop"))).toBe(GIVE_WAY.at(-1)!)
    // A long custom account name that no step makes whole: every step but the Stop mark's, the account shortened.
    expect(giveWay(() => false)).toBe("cache computer team approval harness git title title-min")
  })

  test("each step has its rule in shell.css, and none touches the model or the account", () => {
    for (const token of GIVE_WAY.at(-1)!.split(" ")) expect(css).toContain(`.own-header[data-give~="${token}"]`)
    const rules = css.split("}").filter((rule) => rule.includes("[data-give~="))
    expect(rules.filter((rule) => /data-part|running-on/.test(rule))).toEqual([])
    // Both forms are in the DOM: the short one shows only once its step gives way.
    expect(css).toContain(".own-give-short {\n  display: none !important;\n}")
  })
})
