// own's image tool and the imagegen skill (02 §9.6, decisions US5, IM): core's `experimental_image_generate` is never
// listed; own's `image_generate` only while `policy.imageGenerate` is on, with a `model` choice only for the `auto`
// family; the skill follows the family and is always there. The chain is image/service.test.ts; the real server
// image/flow.e2e.test.ts and image/tool.e2e.test.ts.

import { describe, expect, test } from "bun:test"
import { OwnImage, Policy } from "@own/protocol"
import { ImageService } from "../../src/image/service.js"
import { ImageTool } from "../../src/image/tool.js"
import type { Modules } from "../../src/modules.js"
import { PolicyRules } from "../../src/switching/policy.js"
import { testDeps } from "../support/deps.js"

type Listed = { name: string; input: { properties: Record<string, { enum?: string[] }> }; description: string }
type ToolEditor = { remove(id: string): void; add(tool: Listed): void }
type SkillEditor = { add(skill: { id: string; path: string; content: string; description?: string }): void }

function context() {
  const state = {
    folds: [] as Array<(editor: ToolEditor) => void>,
    skillFolds: [] as Array<(editor: SkillEditor) => void>,
    reloads: 0,
    skillReloads: 0,
  }
  const ctx = {
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => void state.folds.push(callback),
      reload: async () => void state.reloads++,
    },
    skill: {
      transform: async (callback: (editor: SkillEditor) => void) => void state.skillFolds.push(callback),
      reload: async () => void state.skillReloads++,
    },
  }
  /** The tools after the folds, starting from core's list with its image, video and automation tools in it. */
  const listed = () => {
    const tools = new Map<string, Listed | undefined>([
      ["read", undefined],
      ["shell", undefined],
      [Policy.IMAGE_GENERATE_TOOL, undefined],
      [Policy.VIDEO_GENERATE_TOOL, undefined],
      ...Policy.AUTOMATION_TOOLS.map((id) => [id, undefined] as const),
    ])
    for (const fold of state.folds) fold({ remove: (id) => void tools.delete(id), add: (tool) => void tools.set(tool.name, tool) })
    return tools
  }
  const skills = () => {
    const added: Array<{ id: string; path: string; content: string }> = []
    for (const fold of state.skillFolds) fold({ add: (skill) => void added.push(skill) })
    return added
  }
  return { ctx, state, listed, skills }
}

async function settled(read: () => number, count: number) {
  for (let tries = 0; tries < 100 && read() < count; tries++) await Bun.sleep(5)
}

const modules = { slots: { snapshot: () => ({ accounts: [] }) } } as unknown as Modules.All

describe("ImageTool (decisions US5, IM)", () => {
  test("off by default; on lists own's tool instead of core's; a family change reloads the tool and the skill", async () => {
    const fake = context()
    await using t = await testDeps({ ctx: fake.ctx, control: true })
    const set = async (patch: Parameters<typeof PolicyRules.apply>[1]) => {
      await t.deps.runtime.policy.update((stored) => PolicyRules.apply(stored, patch))
      t.deps.runtime.broadcast.emit("store.changed", { store: "policy", origin: "local" })
    }
    const stop = await ImageTool.register(t.deps, modules)
    expect([...fake.listed().keys()]).toEqual(["read", "shell"])

    await set({ imageGenerate: true })
    await settled(() => fake.state.reloads, 1)
    const on = fake.listed()
    expect([...on.keys()]).toEqual(["read", "shell", ImageTool.NAME])
    expect(on.get(ImageTool.NAME)?.input.properties.model?.enum).toEqual(["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"])
    expect(on.get(ImageTool.NAME)?.input.properties.complexity?.enum).toEqual(["low", "medium", "high"])

    // Another policy change folds nothing new.
    await set({ horizonRequests: 7 })
    await Bun.sleep(30)
    expect(fake.state.reloads).toBe(1)

    await set({ image: { family: "gpt-image-2" } })
    await settled(() => fake.state.skillReloads, 1)
    const fixed = fake.listed().get(ImageTool.NAME)
    expect(fixed?.input.properties.model).toBeUndefined()
    // gpt-image-2 takes no complexity (IM-17), so the tool does not offer it.
    expect(fixed?.input.properties.complexity).toBeUndefined()
    expect(fixed?.description).not.toContain("complexity")
    expect(fixed?.description).toContain("fixed the model to gpt-image-2")
    expect(fake.skills()[0]?.content).toContain("fixed the model to `gpt-image-2`")

    await set({ imageGenerate: false })
    await settled(() => fake.state.reloads, 3)
    expect([...fake.listed().keys()]).toEqual(["read", "shell"])
    stop()
  })

  test("the imagegen skill: own's built-in path, the family's model guidance, Codex's prompting, no CLI or shell key", () => {
    const added: Array<{ id: string; path: string; content: string; description?: string }> = []
    ImageTool.addSkill({ add: (skill: (typeof added)[number]) => void added.push(skill) } as never, "auto")
    const skill = added[0]!
    expect(skill).toMatchObject({ id: "imagegen", path: "/builtin/own/imagegen.md" })
    expect(skill.content).toContain("### Choosing the model")
    expect(skill.content).toContain(OwnImage.FLARE)
    expect(skill.content).toContain(OwnImage.SUNBURST)
    expect(skill.content).toContain("### Complexity")
    expect(skill.content).not.toContain("gpt-image-2.5")
    expect(skill.content).toContain("설정 > 이미지 만들기")
    expect(skill.content).not.toContain("컴퓨터 사용")
    expect(skill.content).toContain("# Prompting best practices")
    expect(skill.content).toContain("# Sample prompts")
    expect(skill.content).not.toContain("{{MODEL_SECTION}}")
    expect(skill.content).not.toMatch(/OPENAI_API_KEY|scripts\/image_gen\.py|\$CODEX_HOME|view_image/)
    expect(skill.content.startsWith("---")).toBe(false)
    for (const family of OwnImage.FAMILIES.filter((item) => item !== "auto"))
      expect(ImageTool.modelSection(family)).toContain(`fixed the model to \`${OwnImage.defaultModel(family)}\``)
  })

  test("the model parameter: both 2.6 models under auto, others (a retired 2.5 id too) refused; a fixed family refuses any", async () => {
    const fake = context()
    await using t = await testDeps({ ctx: { ...fake.ctx, permission: { assert: async () => { throw new Error("asked") } }, storage: { get: async () => undefined, set: async () => undefined } }, control: true })
    const service = ImageService.create(t.deps, modules)
    const call = (model: string) =>
      ImageTool.run(t.deps, service, { prompt: "x", model }, {
        sessionID: "ses_1",
        agent: "build",
        messageID: "msg_1",
        id: "call_1",
        signal: new AbortController().signal,
        progress: async () => undefined,
      } as never)
    // No account at all: the allowed models pass the check, and the card says no account can make images; nothing
    // is asked (the context's permission would throw) and no request is sent.
    for (const model of [OwnImage.FLARE, OwnImage.SUNBURST]) {
      const result = await call(model)
      expect((result.metadata?.[OwnImage.CARD_KEY] as OwnImage.CardData).status).toBe("unavailable")
      expect(String(result.content)).toContain("지금 이미지를 만들 수 있는 계정이 없어요")
    }
    await expect(call("gpt-image-1")).rejects.toThrow(`Use ${OwnImage.FLARE} or ${OwnImage.SUNBURST}`)
    // IM-16: an old conversation naming a 2.5 model is told the 2.6 ids, not silently moved.
    await expect(call("gpt-image-2.5-flare")).rejects.toThrow("Use gpt-image-2.6-flare or gpt-image-2.6-sunburst, or omit model")
    await t.deps.runtime.policy.update((stored) => PolicyRules.apply(stored, { image: { family: "flare" } }))
    await expect(call(OwnImage.SUNBURST)).rejects.toThrow("fixed the image model to gpt-image-2.6-flare")
  })

  test("PolicyRules.apply keeps the switch and merges the image setting; absent reads as off and auto", () => {
    expect(Policy.imageGenerate(Policy.defaults)).toBe(false)
    const on = PolicyRules.apply(Policy.defaults, { imageGenerate: true })
    expect(on.imageGenerate).toBe(true)
    expect(PolicyRules.apply(on, { horizonRequests: 5 }).imageGenerate).toBe(true)
    expect(Policy.imageGenerate(PolicyRules.apply(on, { imageGenerate: false }))).toBe(false)
    expect(OwnImage.resolve(on.image)).toEqual(OwnImage.DEFAULTS)
    const chosen = PolicyRules.apply(on, { image: { family: "sunburst", quality: "low" } })
    const merged = PolicyRules.apply(chosen, { image: { codexFallback: false } })
    expect(merged.image).toEqual({ family: "sunburst", quality: "low", codexFallback: false })
    expect(PolicyRules.apply(merged, { horizonRequests: 3 }).image).toEqual(merged.image)
  })
})
