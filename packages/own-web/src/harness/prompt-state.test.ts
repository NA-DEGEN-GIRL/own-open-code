// 설정 > 에이전트 방식 (10 §3.11) over the real own.harness client (`createHarnessRpc`, its scope table) and a fake
// transport that stores 내 지시문 like the service: the first preview follows the service's default, picks re-ask the
// preview, an edit saves and resets with the toasts the page shows, a phone sees it read-only, an older service has no
// 내 지시문 and no preview. OpenCode 기본's 하위 에이전트 is read once from `prompt.subagent`. Then the pill's side:
// 내 지시문 of a 에이전트 방식 without a saved text runs 개선판.
import { beforeEach, describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnHarnessRouting, type HarnessID, type PromptID } from "@own/protocol/rpc-harness-routing"
import { createRoot, createSignal } from "solid-js"
import { createHarnessRpc } from "@/data/harness-rpc"
import { ALL_SCOPES, type OwnScope } from "@/data/rpc"
import type { ToastInput } from "@/switcher/toast"
import { newSessionHarness, runs } from "./index"
import { MODEL_KEY, promptPageState, searchPieces } from "./prompt-state"
import { promptsText } from "./prompt-strings"

const STARTS = { reference: "Codex's fallback prompt", own: "own's lean text\n{{patch}}" }
const CORE: OwnHarness.PromptSubagent = {
  kind: "core",
  tool: { name: "subagent", description: "Spawns an agent.\n\nAvailable subagents:\n- explore: Read-only search." },
  agent: "build",
  opening: "You are a subagent spawned by another session.\n",
  guidance: "",
  cut: { lines: 2000, bytes: 51200 },
}

/** A service whose own.harness answers `list`, `prompt.preview` and `prompt.custom.set`, or one from before them. */
function service(
  options: {
    readonly scopes?: ReadonlySet<OwnScope>
    readonly older?: boolean
    /** A service without own.harness: these methods answer `rpc.unavailable`. */
    readonly unavailable?: ReadonlySet<string>
    /** These methods fail as a service error would. */
    readonly broken?: ReadonlySet<string>
    /** Variants whose preview fails, as a service error would. */
    readonly failing?: Set<PromptID>
  } = {},
) {
  const custom: Partial<Record<"codex" | "pi", string>> = {}
  const defaults = { harness: "codex" as HarnessID, prompt: "own" as PromptID }
  const calls: Array<{ readonly method: string; readonly input: Record<string, unknown> }> = []
  const list = () => ({
    harnesses: [...OwnHarnessRouting.IDS],
    default: defaults.harness,
    prompts: options.older ? ["reference", "own"] : [...OwnHarnessRouting.PROMPTS],
    defaultPrompt: defaults.prompt,
    ...(options.older ? {} : { custom: (["codex", "pi"] as const).filter((id) => custom[id] !== undefined) }),
    buildId: "b",
    version: "v",
  })
  const preview = (input: Record<string, unknown>): OwnHarness.PromptPreview => {
    const harness = input.harness as "codex" | "pi"
    const prompt = input.prompt as PromptID
    const text = custom[harness]
    const model = (input.model as OwnHarness.FallbackModel | undefined) ?? {
      providerID: "an",
      modelID: "claude-opus-5-5",
    }
    return {
      harness,
      prompt,
      applied: prompt === "custom" && text === undefined ? "own" : prompt,
      model: { ...model, name: model.modelID },
      tier: "lean",
      responses: false,
      mode: (input.mode as OwnHarness.ApprovalMode | undefined) ?? "ask",
      parts: [
        {
          kind: "base",
          role: "system",
          text: prompt === "custom" && text !== undefined ? text : prompt === "own" ? "own's lean text" : "Codex's",
          editable: true,
        },
        { kind: "permissions", role: "system", text: "<permissions instructions>", editable: false },
      ],
      tools: [{ name: "exec_command", description: "Runs a command." }],
      changes: [
        {
          id: "codex.lean",
          title: "짧은 기본 지시문",
          why: "짧게 써요.",
          part: "base",
          before: "a",
          after: "b",
          applies: true,
        },
        {
          id: "codex.base.1",
          title: "어디서 일하는지",
          why: "알려요.",
          part: "base",
          before: "c",
          after: "d",
          applies: false,
        },
      ],
      starts: STARTS,
      ...(text === undefined ? {} : { custom: { text, updatedAt: 1 } }),
      models: [
        { providerID: "an", modelID: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { providerID: "oa", modelID: "gpt-5.5", name: "GPT-5.5" },
      ],
      examples: false,
      limit: 100_000,
    }
  }
  // SAFETY: createHarnessRpc uses only `rpc.call` of the client.
  const client = {
    rpc: {
      call: async (request: { readonly method: string; readonly input: Record<string, unknown> }) => {
        calls.push({ method: request.method, input: request.input })
        if (options.unavailable?.has(request.method))
          throw { _tag: "RpcError", type: "rpc.unavailable", message: "RPC is unavailable" }
        if (options.broken?.has(request.method)) throw { _tag: "RpcError", type: "internal", message: "broken" }
        if (request.method === "list") return { output: list() }
        if (options.older) throw { _tag: "RpcError", type: "rpc.method_not_found", message: request.method }
        if (request.method === "prompt.preview" && options.failing?.has(request.input.prompt as PromptID))
          throw { _tag: "RpcError", type: "internal", message: "preview failed" }
        if (request.method === "prompt.preview") return { output: preview(request.input) }
        if (request.method === "prompt.subagent") return { output: CORE }
        if (request.method === "prompt.custom.set") {
          const harness = request.input.harness as "codex" | "pi"
          const text = request.input.text as string | null
          // Stands for a text another client made too long since this page read the limit.
          if (text === "TOO LONG")
            throw {
              _tag: "RpcError",
              type: "prompt_invalid",
              message: "x",
              data: { reason: "too_long", limit: 100_000 },
            }
          if (text === null) delete custom[harness]
          else custom[harness] = text
          return { output: list() }
        }
        throw new Error(`unexpected ${request.method}`)
      },
    },
  } as unknown as OpenCodeClient
  const harness = createHarnessRpc({
    client: () => client,
    control: async () => "C:/own/control",
    scopes: () => options.scopes ?? ALL_SCOPES,
  })
  return { runtime: { key: "local", harness }, calls, custom, defaults }
}

function page(
  runtime: ReturnType<typeof service>["runtime"],
  initialModel?: () => OwnHarness.FallbackModel | undefined,
) {
  const toasts: ToastInput[] = []
  const state = createRoot(() =>
    promptPageState({
      runtime: () => runtime,
      t: (key, params) => promptsText.text("ko", key, params),
      toast: (toast) => toasts.push(toast),
      directory: () => "D:/work/app",
      initialModel,
    }),
  )
  return { state, toasts }
}

// The last pick is kept per device; every test starts without one.
beforeEach(() => localStorage.removeItem(MODEL_KEY))

describe("설정 > 에이전트 방식", () => {
  test("opens on the service's default and previews it for the first model, in the project's folder", async () => {
    const pc = service()
    const { state } = page(pc.runtime)
    await state.load()
    expect([state.tab(), state.prompt(), state.mode()]).toEqual(["codex", "own", "ask"])
    expect(pc.calls.map((call) => call.method)).toEqual(["list", "prompt.preview"])
    expect(pc.calls[1]!.input).toEqual({ harness: "codex", prompt: "own", mode: "ask", directory: "D:/work/app" })
    expect(state.model()).toEqual({ providerID: "an", modelID: "claude-opus-5-5" })
    expect(state.preview()?.parts[0]?.text).toBe("own's lean text")
    expect(state.prompts()).toEqual(["reference", "own", "custom"])
    // Another model, mode and variant ask again, with the picked model.
    await state.choose({ model: { providerID: "oa", modelID: "gpt-5.5" }, mode: "full", prompt: "reference" })
    expect(pc.calls.at(-1)!.input).toEqual({
      harness: "codex",
      prompt: "reference",
      mode: "full",
      model: { providerID: "oa", modelID: "gpt-5.5" },
      directory: "D:/work/app",
    })
    // OpenCode 기본 has nothing to preview: only its 하위 에이전트, read once.
    await state.choose({ harness: "opencode" })
    expect(state.preview()).toBeUndefined()
    expect(pc.calls.at(-1)).toEqual({ method: "prompt.subagent", input: {} })
    expect(state.coreSubagent()).toEqual(CORE)
    await state.choose({ harness: "codex" })
    await state.choose({ harness: "opencode" })
    expect(pc.calls.filter((call) => call.method === "prompt.subagent")).toHaveLength(1)
    // omo has neither.
    const before = pc.calls.length
    await state.choose({ harness: "omo" })
    expect(pc.calls.length).toBe(before)
  })

  test("OpenCode 기본's 하위 에이전트: none from a service before prompt.subagent, or when it fails", async () => {
    const older = service({ older: true })
    const old = page(older.runtime)
    await old.state.load()
    await old.state.choose({ harness: "opencode" })
    expect(older.calls.at(-1)!.method).toBe("prompt.subagent")
    expect(old.state.coreSubagent()).toBeUndefined()
    const broken = service({ broken: new Set(["prompt.subagent"]) })
    const failing = page(broken.runtime)
    await failing.state.load()
    await failing.state.choose({ harness: "opencode" })
    expect(failing.state.coreSubagent()).toBeUndefined()
    // A failed read is asked again the next time the tab is shown.
    await failing.state.choose({ harness: "opencode" })
    expect(broken.calls.filter((call) => call.method === "prompt.subagent")).toHaveLength(2)
  })

  test("Claude Agent 기본: one preview without a variant or 비교, nothing to edit (02 §8.10)", async () => {
    const pc = service()
    const { state } = page(pc.runtime)
    await state.load()
    await state.choose({ compare: true, prompt: "custom" })
    const before = pc.calls.length
    await state.choose({ harness: "claude-code" })
    expect(state.previewed()).toBe("claude-code")
    // Asked once, as `원본` whichever variant the other tabs left chosen: Claude Code's prompt has none.
    expect(pc.calls.slice(before).map((call) => call.input)).toEqual([
      {
        harness: "claude-code",
        prompt: "reference",
        mode: "ask",
        model: { providerID: "an", modelID: "claude-opus-5-5" },
        directory: "D:/work/app",
      },
    ])
    expect(state.comparison()).toBeUndefined()
    // Back on Codex the variant and 비교 are as they were.
    await state.choose({ harness: "codex" })
    expect([state.prompt(), state.compare(), state.previewed()]).toEqual(["custom", true, "codex"])
  })

  test("내 지시문: start from 개선판, edit, save; the next preview shows it; reset falls back to 개선판", async () => {
    newSessionHarness.reset()
    const pc = service()
    const { state, toasts } = page(pc.runtime)
    await state.load()
    await state.choose({ prompt: "custom" })
    expect(state.preview()?.applied).toBe("own")
    expect(state.started()).toBe(false)
    state.start("own")
    expect(state.text()).toBe(STARTS.own)
    // The copy itself is not a change worth saving until it differs from what is saved (nothing yet).
    expect(state.dirty()).toBe(true)
    state.edit("Answer in Korean.\n{{patch}}")
    await state.save()
    expect(pc.custom.codex).toBe("Answer in Korean.\n{{patch}}")
    expect(toasts.at(-1)).toEqual({ message: "내 지시문을 저장했어요" })
    expect(state.preview()?.applied).toBe("custom")
    expect(state.saved()).toBe("Answer in Korean.\n{{patch}}")
    expect(state.dirty()).toBe(false)
    // The pill learns from the answer that codex has a text now.
    expect(runs("custom", "codex", newSessionHarness.offer("local"))).toBe("custom")
    expect(runs("custom", "pi", newSessionHarness.offer("local"))).toBe("own")

    // A blank edit cannot be saved.
    state.edit("   ")
    expect(state.invalid()).toBe("empty")
    await state.save()
    expect(pc.custom.codex).toBe("Answer in Korean.\n{{patch}}")
    state.discard()
    expect(state.text()).toBe("Answer in Korean.\n{{patch}}")

    await state.reset()
    expect(pc.custom.codex).toBeUndefined()
    expect(toasts.at(-1)).toEqual({ message: "내 지시문을 지웠어요. 내 지시문을 고른 대화는 개선판으로 일해요." })
    expect(state.preview()?.applied).toBe("own")
    expect(state.started()).toBe(false)
    expect(runs("custom", "codex", newSessionHarness.offer("local"))).toBe("own")
  })

  test("edits are kept per 에이전트 방식 while the page is open", async () => {
    const { state } = page(service().runtime)
    await state.load()
    await state.choose({ prompt: "custom" })
    state.edit("codex edit")
    await state.choose({ harness: "pi" })
    expect(state.text()).toBe("")
    state.edit("pi edit")
    await state.choose({ harness: "codex" })
    expect(state.text()).toBe("codex edit")
  })

  test("a phone sees the text but cannot edit; an older service has no 내 지시문 and says it cannot preview", async () => {
    const phone = page(service({ scopes: new Set<OwnScope>(["read"]) }).runtime)
    await phone.state.load()
    expect(phone.state.preview()).toBeDefined()
    expect(phone.state.editable()).toBe(false)

    const older = service({ older: true })
    const old = page(older.runtime)
    await old.state.load()
    expect(old.state.supported()).toBe(false)
    expect(old.state.prompts()).toEqual(["reference", "own"])
    expect(old.state.problem()).toBe("unavailable")
    expect(old.state.preview()).toBeUndefined()
  })

  test("a service without own.harness (rpc.unavailable) says the page is unavailable, from the list or a preview", async () => {
    const none = page(service({ unavailable: new Set(["list", "prompt.preview"]) }).runtime)
    await none.state.load()
    expect([none.state.list(), none.state.problem()]).toEqual([undefined, "unavailable"])

    const previewOnly = page(service({ unavailable: new Set(["prompt.preview"]) }).runtime)
    await previewOnly.state.load()
    expect(previewOnly.state.list()).toBeDefined()
    expect([previewOnly.state.preview(), previewOnly.state.problem()]).toEqual([undefined, "unavailable"])
  })

  test("a list that failed for another reason is a failure, and loading again recovers", async () => {
    const broken = new Set(["list"])
    const pc = service({ broken })
    const { state } = page(pc.runtime)
    await state.load()
    expect([state.list(), state.problem()]).toEqual([undefined, "failed"])
    broken.clear()
    await state.load()
    expect(state.list()).toBeDefined()
    expect([state.preview()?.prompt, state.problem()]).toEqual(["own", undefined])
  })

  test("비교 previews the variant beside the chosen one too, with the same model and mode", async () => {
    const pc = service()
    const { state } = page(pc.runtime)
    await state.load()
    expect(state.comparison()).toBeUndefined()
    const asked = () => pc.calls.slice(-2).map((call) => [call.method, call.input.prompt, call.input.mode])
    await state.choose({ compare: true })
    expect(asked()).toEqual([
      ["prompt.preview", "own", "ask"],
      ["prompt.preview", "reference", "ask"],
    ])
    // 원본 on the left, 개선판 on the right, with 개선판's changes for this model to mark.
    expect([state.comparison()?.left.prompt, state.comparison()?.right.prompt]).toEqual(["reference", "own"])
    expect(state.comparison()?.changes.map((change) => change.id)).toEqual(["codex.lean"])
    await state.choose({ prompt: "reference", mode: "full" })
    expect(asked()).toEqual([
      ["prompt.preview", "reference", "full"],
      ["prompt.preview", "own", "full"],
    ])
    expect([state.comparison()?.left.prompt, state.comparison()?.right.prompt]).toEqual(["reference", "own"])
    // 내 지시문 beside 개선판: what differs is the user's text, nothing of own's to mark.
    await state.choose({ prompt: "custom" })
    expect([state.comparison()?.left.prompt, state.comparison()?.right.prompt]).toEqual(["own", "custom"])
    expect(state.comparison()?.changes).toEqual([])
    // Off again: one preview per pick.
    await state.choose({ compare: false })
    const before = pc.calls.length
    await state.choose({ prompt: "own" })
    expect(pc.calls.length - before).toBe(1)
    expect(state.comparison()).toBeUndefined()
  })

  test("비교 whose second preview fails keeps the chosen one and says so; a retry that works compares", async () => {
    const failing = new Set<PromptID>(["reference"])
    const pc = service({ failing })
    const { state } = page(pc.runtime)
    await state.load()
    await state.choose({ compare: true })
    expect([state.preview()?.prompt, state.comparison(), state.partnerFailed(), state.problem()]).toEqual([
      "own",
      undefined,
      true,
      undefined,
    ])
    failing.clear()
    await state.refresh()
    expect([state.comparison()?.left.prompt, state.partnerFailed()]).toEqual(["reference", false])
    // The chosen preview failing is the page's failure, as without 비교.
    failing.add("own")
    await state.refresh()
    expect([state.preview(), state.partnerFailed(), state.problem()]).toEqual([undefined, false, "failed"])
  })

  test("a save the service refuses says why and keeps the edit", async () => {
    const pc = service()
    const { state, toasts } = page(pc.runtime)
    await state.load()
    await state.choose({ prompt: "custom" })
    state.edit("TOO LONG")
    await state.save()
    expect(toasts.at(-1)).toEqual({ message: "100,000자까지 쓸 수 있어요", tone: "danger" })
    expect(pc.custom.codex).toBeUndefined()
    expect([state.text(), state.dirty(), state.busy()]).toEqual(["TOO LONG", true, false])
  })
})

describe("설정 > 에이전트 방식 › model", () => {
  const gpt = { providerID: "oa", modelID: "gpt-5.5" }
  const opus = { providerID: "an", modelID: "claude-opus-5-5" }
  const previews = (pc: ReturnType<typeof service>) =>
    pc.calls.filter((call) => call.method === "prompt.preview").map((call) => call.input.model)

  test("starts on the model the user works with, not the service's first", async () => {
    const pc = service()
    const { state } = page(pc.runtime, () => gpt)
    await state.load()
    expect(previews(pc)).toEqual([gpt])
    expect(state.model()).toEqual(gpt)
    expect(state.preview()?.model.modelID).toBe("gpt-5.5")
  })

  test("a usual model known only after the page opened moves the preview there, until the user picks one", async () => {
    const pc = service()
    const [usual, setUsual] = createRoot(() => createSignal<OwnHarness.FallbackModel>())
    const { state } = page(pc.runtime, usual)
    await state.load()
    expect(state.model()).toEqual(opus)
    // The conversation list loads: the preview follows the model the user works with, once.
    setUsual(gpt)
    await Bun.sleep(0)
    expect(previews(pc)).toEqual([undefined, gpt])
    expect(state.preview()?.model.modelID).toBe("gpt-5.5")
    await state.choose({ model: opus })
    setUsual({ providerID: "oa", modelID: "gpt-6" })
    await Bun.sleep(0)
    expect(state.model()).toEqual(opus)
    expect(previews(pc)).toEqual([undefined, gpt, opus])
  })

  test("a pick is remembered on this device per server and wins on the next visit", async () => {
    const first = page(service().runtime, () => gpt)
    await first.state.load()
    await first.state.choose({ model: opus })
    expect(JSON.parse(localStorage.getItem(MODEL_KEY)!)).toEqual({ local: opus })
    const pc = service()
    const next = page(pc.runtime, () => gpt)
    await next.state.load()
    expect(previews(pc)).toEqual([opus])
    expect(next.state.model()).toEqual(opus)
  })

  test("a remembered model the service no longer offers falls back to the service's first", async () => {
    localStorage.setItem(MODEL_KEY, JSON.stringify({ local: { providerID: "gone", modelID: "old-model" } }))
    const pc = service()
    const { state } = page(pc.runtime)
    await state.load()
    expect(previews(pc)).toEqual([{ providerID: "gone", modelID: "old-model" }, undefined])
    expect(state.model()).toEqual(opus)
    expect(state.preview()?.model.modelID).toBe("claude-opus-5-5")
    // Unreadable storage is no pick.
    localStorage.setItem(MODEL_KEY, "not json")
    const again = service()
    await page(again.runtime).state.load()
    expect(previews(again)).toEqual([undefined])
  })
})

describe("searchPieces", () => {
  test("cuts at every case-insensitive match and keeps the rest", () => {
    expect(searchPieces("Apply a patch. PATCH twice", "patch")).toEqual([
      { text: "Apply a ", match: false },
      { text: "patch", match: true },
      { text: ". ", match: false },
      { text: "PATCH", match: true },
      { text: " twice", match: false },
    ])
    expect(searchPieces("a.b", ".")).toEqual([
      { text: "a", match: false },
      { text: ".", match: true },
      { text: "b", match: false },
    ])
    expect(searchPieces("text", "")).toEqual([{ text: "text", match: false }])
  })
})

describe("pill: 내 지시문 without a saved text", () => {
  test("runs 개선판, and a service from before 내 지시문 offers two variants", () => {
    const offer = { prompts: [...OwnHarnessRouting.PROMPTS], custom: ["pi" as const] }
    expect(runs("custom", "pi", offer)).toBe("custom")
    expect(runs("custom", "codex", offer)).toBe("own")
    expect(runs("reference", "codex", offer)).toBe("reference")
    expect(newSessionHarness.offer("never-listed")).toEqual({
      harnesses: ["opencode", "codex", "pi", "dsh"],
      prompts: ["reference", "own"],
      custom: [],
    })
  })

  test("a conversation opened directly asks the server once, then knows its saved 내 지시문", async () => {
    const pc = service()
    pc.custom.codex = "mine"
    const runtime = { ...pc.runtime, key: "direct" } as unknown as Parameters<typeof newSessionHarness.ensure>[0]
    newSessionHarness.ensure(runtime)
    newSessionHarness.ensure(runtime)
    await Bun.sleep(0)
    expect(pc.calls.map((call) => call.method)).toEqual(["list"])
    expect(runs("custom", "codex", newSessionHarness.offer("direct"))).toBe("custom")
  })
})
