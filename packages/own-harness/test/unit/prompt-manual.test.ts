// The manual's 10.13 change list (script/prompt-manual.ts): it is what variant.ts says, every change of every harness
// has its anchor there (설정 > 에이전트 방식's `자세히` opens it), and so does the built manual page own-web ships. Its
// headings and 10.13's table name the models CodexVariant gives each tier.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { Catalog } from "../../src/codex/catalog.js"
import { CodexVariant } from "../../src/codex/variant.js"
import { Prompts } from "../../src/prompts.js"
import { anchor, block, context, entries, GROUPS, MANUAL, MODELS, rewrite } from "../../script/prompt-manual.js"

const PAGE = path.join(path.dirname(MANUAL), "own-open-code-manual.html")

describe("the manual's change list (10.13)", () => {
  test("is up to date with variant.ts (`bun run prompt-manual` rewrites it)", async () => {
    const text = await Bun.file(MANUAL).text()
    expect(rewrite(text, block(await entries()))).toBe(text)
  })

  test("every change, every replacement included, has one anchor in the chapter and in the built page", async () => {
    const list = await entries()
    const ids = list.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const item of CodexVariant.REPLACEMENTS) expect(ids).toContain(`codex.base.${item.id}`)
    for (const item of CodexVariant.SPAWN_AGENT_REPLACEMENTS) expect(ids).toContain(`codex.spawn.${item.id}`)
    for (const harness of ["pi", "dsh"] as const) {
      const preview = await Effect.runPromise(
        Prompts.preview(context(), { harness, prompt: "own", model: MODELS.fallback }),
      )
      for (const change of preview.changes) expect(ids).toContain(change.id)
    }
    const chapter = await Bun.file(MANUAL).text()
    const page = existsSync(PAGE) ? await Bun.file(PAGE).text() : undefined
    for (const id of ids) {
      expect([id, chapter.split(`id="${anchor(id)}"`).length]).toEqual([id, 2])
      if (page !== undefined) expect([id, page.includes(`id="${anchor(id)}"`)]).toEqual([id, true])
    }
  })

  test("every entry applies somewhere: one or more approval modes, one or both sampled Codex tiers", async () => {
    for (const item of await entries()) expect([item.id, item.modes?.length !== 0]).toEqual([item.id, true])
  })

  test("the headings and 10.13's table name the models CodexVariant.lean gives each tier", async () => {
    const tier = (id: string) =>
      CodexVariant.lean(Catalog.lookup(id), "own")
        ? "lean"
        : CodexVariant.revised(Catalog.lookup(id), "own") && "fallback"
    // `Claude Opus 4.8 이후, Fable, Mythos`
    for (const id of [MODELS.lean.modelID, "claude-opus-4-8", "claude-fable-5", "claude-mythos-5-1"])
      expect([id, tier(id)]).toEqual([id, "lean"])
    // `그 밖의 목록 밖 모델(Claude Sonnet, DeepSeek 등)`
    for (const id of [MODELS.fallback.modelID, "claude-sonnet-5-5", "claude-opus-4-7"])
      expect([id, tier(id)]).toEqual([id, "fallback"])
    expect(tier(MODELS.catalog.modelID)).toBe(false)
    const chapter = await Bun.file(MANUAL).text()
    const lean = GROUPS.find((group) => group.models === "lean")!.title
    expect(lean).toBe("Codex 방식 · Claude Opus 4.8 이후, Fable, Mythos")
    expect(chapter).toContain(`| ${lean} |`)
    expect(GROUPS.find((group) => group.models === "fallback")!.title).toContain("(Claude Sonnet, DeepSeek 등)")
    // The table counts the fallback tier's rewritten spans.
    const count = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열"][
      CodexVariant.REPLACEMENTS.length
    ]
    expect(chapter).toContain(`파일 고치는 방법 등 ${count} 곳을 고쳐요`)
  })

  test("Codex's catalog models get none of them", async () => {
    const preview = await Effect.runPromise(
      Prompts.preview(context(), { harness: "codex", prompt: "own", model: MODELS.catalog }),
    )
    expect(preview.changes.filter((change) => change.applies)).toEqual([])
  })

  test("an anchor is the change id with dashes", () => {
    expect(anchor("codex.base.where")).toBe("pc-codex-base-where")
    expect(anchor("dsh.zone")).toBe("pc-dsh-zone")
  })
})
