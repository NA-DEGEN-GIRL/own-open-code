// 02 §4.8, 06 §10.1: a speed (Fast, Ultrafast) is each conversation's own. own.team never sets or copies one: not when
// an area owner follows the team main (`팀과 같게`), not when an owner rotates, not when a team moves accounts. The
// user turns it on in each conversation's composer.

import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import path from "node:path"

const SRC = path.join(import.meta.dir, "..", "..", "src")

describe("speed is per conversation (02 §4.8)", () => {
  test("own.team's source never calls session.speed.*", async () => {
    const files = [...new Glob("**/*.ts").scanSync(SRC)]
    const texts = await Promise.all(files.map((file) => Bun.file(path.join(SRC, file)).text()))
    expect(files.filter((_, index) => texts[index]?.includes("session.speed."))).toEqual([])
  })
})
