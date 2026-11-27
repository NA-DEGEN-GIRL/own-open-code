import { describe, expect, test } from "bun:test"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnHarnessRouting, type HarnessID, type PromptID } from "@own/protocol/rpc-harness-routing"
import { createHarnessRpc, HARNESS_ID, HARNESS_SCOPE } from "@/data/harness-rpc"
import { ALL_SCOPES, type OwnScope } from "@/data/rpc"
import { translate } from "@/i18n"
import {
  harnessScreen,
  menuHarnesses,
  newSessionHarness,
  omoDescription,
  pendingHarnessMenu,
  requestHarnessMenu,
  runs,
  variantHarness,
} from "./index"

describe("own.harness client contract", () => {
  test("id and scope table match the definition", () => {
    expect(HARNESS_ID).toBe(OwnHarness.ID)
    expect(HARNESS_SCOPE).toEqual(OwnHarness.MethodScope)
    expect(Object.keys(HARNESS_SCOPE).sort()).toEqual(Object.keys(OwnHarness.Definition.methods).sort())
  })

  test("a read-only device may read but not switch; a switch needs switch, as the gateway decides (10 §6.1)", () => {
    const rpc = (scopes: ReadonlySet<OwnScope>) =>
      createHarnessRpc({
        client: () => {
          throw new Error("not called")
        },
        control: async () => "C:/work",
        scopes: () => scopes,
      })
    expect(rpc(ALL_SCOPES).allowed("session.set")).toBe(true)
    expect(rpc(new Set<OwnScope>(["read"])).allowed("session.get")).toBe(true)
    expect(rpc(new Set<OwnScope>(["read"])).allowed("session.set")).toBe(false)
    expect(rpc(new Set<OwnScope>(["read", "prompt"])).allowed("session.set")).toBe(false)
    expect(rpc(new Set<OwnScope>(["read", "prompt", "switch"])).allowed("session.set")).toBe(true)
  })
})

describe("new-session 에이전트 방식", () => {
  const list = (harness: HarnessID, prompt: PromptID) => ({
    harnesses: [...OwnHarnessRouting.IDS],
    default: harness,
    prompts: [...OwnHarnessRouting.PROMPTS],
    defaultPrompt: prompt,
    buildId: "b",
    version: "v",
  })
  const A = harnessScreen({ name: "project", serverKey: "local", projectID: "prj_a" })
  const B = harnessScreen({ name: "project", serverKey: "local", projectID: "prj_b" })

  test("names nothing until the service's default is known, so the server stamps its own", () => {
    newSessionHarness.reset()
    expect(newSessionHarness.metadata("fresh", A)).toEqual({})
  })

  test("the service's default goes into the metadata; a one-time pick wins on its server only", () => {
    newSessionHarness.reset()
    newSessionHarness.remember("local", list("pi", "own"))
    expect(newSessionHarness.metadata("local", A)).toEqual({ "own.harness": { id: "pi", v: 1, prompt: "own" } })
    newSessionHarness.pick("local", A, { harness: "opencode", prompt: "reference" })
    expect(OwnHarness.harnessOf(newSessionHarness.metadata("local", A))).toBe("opencode")
    expect(newSessionHarness.picked("ssh-1", A)).toBeUndefined()
    expect(newSessionHarness.metadata("ssh-1", A)).toEqual({})
  })

  test("a pick made on one project's screen never reaches another project or home", () => {
    newSessionHarness.reset()
    newSessionHarness.remember("local", list("codex", "reference"))
    newSessionHarness.pick("local", A, { harness: "pi", prompt: "own" })
    // Pi on project A, then 설정 (the header pill unmounts), then project B: B creates with the default.
    expect(newSessionHarness.shown("local", B)).toEqual({ harness: "codex", prompt: "reference" })
    expect(newSessionHarness.metadata("local", B)).toEqual({ "own.harness": { id: "codex", v: 1 } })
    expect(newSessionHarness.metadata("local", harnessScreen({ name: "home" }))).toEqual({
      "own.harness": { id: "codex", v: 1 },
    })
    expect(newSessionHarness.metadata("local", A)).toEqual({ "own.harness": { id: "pi", v: 1, prompt: "own" } })
    expect(A).not.toBe(harnessScreen({ name: "project", serverKey: "ssh-1", projectID: "prj_a" }))
  })

  test("reset() drops the pick and the default shows again; nothing is stored in the window", () => {
    newSessionHarness.remember("local", list("codex", "reference"))
    newSessionHarness.pick("local", A, { harness: "pi", prompt: "own" })
    newSessionHarness.reset()
    expect(newSessionHarness.metadata("local", A)).toEqual({ "own.harness": { id: "codex", v: 1 } })
    expect(Object.keys(localStorage).filter((key) => key.startsWith("own.web.harness"))).toEqual([])
  })
})

describe("Claude Agent 기본 (`claude-code`, 02 §8.10)", () => {
  const list = (harness: HarnessID, prompt: PromptID) => ({
    harnesses: [...OwnHarnessRouting.IDS],
    default: harness,
    prompts: [...OwnHarnessRouting.PROMPTS],
    defaultPrompt: prompt,
    buildId: "b",
    version: "v",
  })
  const HOME = harnessScreen({ name: "home" })
  const AGENT = OwnHarnessRouting.CLAUDE_AGENT

  test("a new conversation on a Claude Agent model runs it unless this screen picked another", () => {
    newSessionHarness.reset()
    newSessionHarness.remember("local", list("codex", "own"))
    expect(newSessionHarness.metadata("local", HOME, AGENT)).toEqual({
      "own.harness": { id: "claude-code", v: 1, prompt: "own" },
    })
    // Another provider keeps the service's default.
    expect(newSessionHarness.metadata("local", HOME, "own-oai-alpha")).toEqual({
      "own.harness": { id: "codex", v: 1, prompt: "own" },
    })
    // Before `list` answered, still named: the service would stamp it for this provider anyway.
    expect(OwnHarnessRouting.harnessOf(newSessionHarness.metadata("fresh", HOME, AGENT))).toBe("claude-code")
    newSessionHarness.pick("local", HOME, { harness: "pi", prompt: "own" })
    expect(newSessionHarness.metadata("local", HOME, AGENT)).toEqual({
      "own.harness": { id: "pi", v: 1, prompt: "own" },
    })
    newSessionHarness.reset()
  })

  test("a pick of it counts on the Claude Agent route only", () => {
    newSessionHarness.reset()
    newSessionHarness.remember("local", list("dsh", "reference"))
    newSessionHarness.pick("local", HOME, { harness: "claude-code", prompt: "reference" })
    expect(newSessionHarness.shown("local", HOME, AGENT)?.harness).toBe("claude-code")
    expect(newSessionHarness.shown("local", HOME, "own-ds-main")).toEqual({ harness: "dsh", prompt: "reference" })
    newSessionHarness.reset()
  })

  test("the menu offers it on a Claude Agent model or while the conversation runs it; the others stay", () => {
    const offer = { harnesses: [...OwnHarnessRouting.IDS] }
    expect(menuHarnesses(offer, "codex", false)).not.toContain("claude-code")
    expect(menuHarnesses(offer, "codex", true)).toEqual([...OwnHarnessRouting.IDS])
    expect(menuHarnesses(offer, "claude-code", false)).toContain("claude-code")
    // A service that does not offer it lists it only as the conversation's own.
    expect(menuHarnesses({ harnesses: ["opencode", "codex"] }, "codex", true)).toEqual(["opencode", "codex"])
  })

  test("no prompt variants; its labels", () => {
    expect(variantHarness("claude-code")).toBeUndefined()
    expect(variantHarness("codex")).toBe("codex")
    expect(runs("custom", "claude-code", { prompts: [...OwnHarnessRouting.PROMPTS], custom: ["codex"] })).toBe("own")
    expect(translate("ko", "own.harness.name.claude-code")).toBe("Claude Agent 기본")
    expect(translate("ko", "own.harness.short.claude-code")).toBe("Claude")
    expect(translate("ko", "own.harness.desc.claude-code")).toBe(
      "Claude Agent 계정에서 Claude 자신의 기본 지시문과 own의 도구로 일해요.",
    )
  })
})

describe("the session ⋯ item `에이전트 방식 바꾸기…`", () => {
  test("a request no pill takes is dropped, so it never opens later when that conversation's pill mounts", async () => {
    requestHarnessMenu("local", "ses_elsewhere")
    expect(pendingHarnessMenu()).toEqual({ serverKey: "local", sessionID: "ses_elsewhere" })
    await Promise.resolve()
    expect(pendingHarnessMenu()).toBeUndefined()
  })
})

describe("the pill and its menu: DeepSeek 방식 (13)", () => {
  test("the menu lists every harness the protocol knows with a name, a short name and a one-line description", () => {
    expect(OwnHarnessRouting.IDS).toContain("dsh")
    // omo's line is in its lazy strings (omo-strings.ts); its name and short name are src/i18n keys.
    for (const id of OwnHarnessRouting.IDS.filter((id): id is Exclude<HarnessID, "omo"> => id !== "omo"))
      for (const kind of ["name", "short", "desc"] as const) {
        expect(translate("ko", `own.harness.${kind}.${id}`)).not.toBe(`own.harness.${kind}.${id}`)
        expect(translate("en", `own.harness.${kind}.${id}`)).not.toBe(`own.harness.${kind}.${id}`)
      }
    expect(translate("ko", "own.harness.name.dsh")).toBe("DeepSeek 방식")
    expect(translate("ko", "own.harness.short.dsh")).toBe("DeepSeek")
    expect(translate("ko", "own.harness.label", { name: translate("ko", "own.harness.name.dsh") })).toBe(
      "에이전트 방식: DeepSeek 방식",
    )
  })

  test("omo (원본)'s line comes from its lazy strings on the first read, into a signal (no resource to suspend on)", async () => {
    omoDescription("ko")
    for (let tick = 0; tick < 50 && omoDescription("ko") === ""; tick++) await Bun.sleep(10)
    expect(omoDescription("ko")).toStartWith("oh-my-opencode(omo) 코드를 그대로 가져와 돌려요.")
    expect(omoDescription("en")).toStartWith("Runs oh-my-opencode (omo) as it is")
  })

  test("each variant of DeepSeek 방식 has its line; 내 지시문 without a saved text runs 개선판", () => {
    for (const prompt of OwnHarnessRouting.PROMPTS)
      expect(translate("ko", `own.harness.prompt.desc.dsh.${prompt}`)).not.toBe(`own.harness.prompt.desc.dsh.${prompt}`)
    expect(OwnHarnessRouting.CUSTOM_HARNESSES).toContain("dsh")
    expect(runs("custom", "dsh", { prompts: [...OwnHarnessRouting.PROMPTS], custom: [] })).toBe("own")
    expect(runs("custom", "dsh", { prompts: [...OwnHarnessRouting.PROMPTS], custom: ["dsh"] })).toBe("custom")
  })
})
