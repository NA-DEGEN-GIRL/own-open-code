// Settings > 일반 `새 대화의 에이전트 방식` (10 §3.8) over the real own.harness client (`createHarnessRpc`, its scope
// table) and a fake transport: the saved toast and what the next new conversation names, an older service without
// `defaults.set`, a phone's read-only row, and the prompt row that OpenCode 기본 does not have. Then the composer's side:
// `session.create` gets the shown value, a one-time pick or else the remembered default.
import { describe, expect, test } from "bun:test"
import type { OpenCodeClient } from "@opencode/client"
import { OwnHarnessRouting, type HarnessID, type PromptID } from "@own/protocol/rpc-harness-routing"
import { createRoot } from "solid-js"
import { createHarnessRpc } from "@/data/harness-rpc"
import { ALL_SCOPES, type OwnScope } from "@/data/rpc"
import { translate } from "@/i18n"
import type { ToastInput } from "@/switcher/toast"
import { harnessDefaultState } from "./default-state"
import { harnessScreen, newSessionHarness } from "./index"

const list = (harness: HarnessID, prompt: PromptID) => ({
  harnesses: [...OwnHarnessRouting.IDS],
  default: harness,
  prompts: [...OwnHarnessRouting.PROMPTS],
  defaultPrompt: prompt,
  buildId: "b",
  version: "v",
})

/** A service whose own.harness answers `list` and stores `defaults.set`, or refuses it like an older build. */
function service(options: { readonly scopes?: ReadonlySet<OwnScope>; readonly oldBuild?: boolean } = {}) {
  const stored = { harness: "codex" as HarnessID, prompt: "reference" as PromptID }
  const calls: string[] = []
  // SAFETY: createHarnessRpc uses only `rpc.call` of the client.
  const client = {
    rpc: {
      call: async (request: { readonly method: string; readonly input: { harness: HarnessID; prompt: PromptID } }) => {
        calls.push(request.method)
        if (request.method === "defaults.set") {
          if (options.oldBuild) throw { _tag: "RpcError", type: "rpc.method_not_found", message: "defaults.set" }
          stored.harness = request.input.harness
          stored.prompt = request.input.prompt
        }
        return { output: list(stored.harness, stored.prompt) }
      },
    },
  } as unknown as OpenCodeClient
  const harness = createHarnessRpc({
    client: () => client,
    control: async () => "C:/own/control",
    scopes: () => options.scopes ?? ALL_SCOPES,
  })
  return { runtime: { key: "local", harness }, calls }
}

function row(runtime: ReturnType<typeof service>["runtime"]) {
  const toasts: ToastInput[] = []
  const state = createRoot(() =>
    harnessDefaultState({
      runtime: () => runtime,
      t: (key, params) => translate("ko", key, params),
      toast: (toast) => toasts.push(toast),
    }),
  )
  return { state, toasts }
}

const HOME = harnessScreen({ name: "home" })

describe("Settings > 일반 › 새 대화의 에이전트 방식", () => {
  test("DeepSeek 방식 can be the default, with its one-line description beside the row", async () => {
    newSessionHarness.reset()
    const pc = service()
    const { state, toasts } = row(pc.runtime)
    await state.load()
    await state.save({ harness: "dsh", prompt: "own" })
    expect(state.list()?.default).toBe("dsh")
    expect(state.description()).toBe(
      "DeepSeek가 만든 코딩 에이전트(dsh)의 지시문과 도구로 일해요. DeepSeek V4 모델에 맞춰져 있어요.",
    )
    expect(translate("ko", "own.harness.name.dsh")).toBe("DeepSeek 방식")
    expect(toasts.at(-1)?.message).toContain("DeepSeek 방식")
    expect(newSessionHarness.metadata("local", HOME)).toEqual({ "own.harness": { id: "dsh", v: 1, prompt: "own" } })
    newSessionHarness.reset()
  })

  test("choosing Pi saves it on the service, says so and becomes the next new conversation's", async () => {
    newSessionHarness.reset()
    const pc = service()
    const { state, toasts } = row(pc.runtime)
    await state.load()
    expect(state.list()?.default).toBe("codex")
    expect(state.note()).toBe("팀 모드 대화, 휴대폰과 다른 PC에서 만든 대화도 이 값으로 시작해요.")
    expect(state.description()).toBe(translate("ko", "own.harness.desc.codex"))
    await state.save({ harness: "pi", prompt: "own" })
    expect(pc.calls).toEqual(["list", "defaults.set"])
    expect(state.list()?.default).toBe("pi")
    expect(toasts).toEqual([{ message: "새 대화의 에이전트 방식을 Pi 방식 · 개선판으로 정했어요" }])
    // The composer's side: no pick on this screen, so session.create names the remembered default.
    expect(newSessionHarness.metadata("local", HOME)).toEqual({ "own.harness": { id: "pi", v: 1, prompt: "own" } })
    newSessionHarness.pick("local", HOME, { harness: "opencode", prompt: "reference" })
    expect(OwnHarnessRouting.harnessOf(newSessionHarness.metadata("local", HOME))).toBe("opencode")
    newSessionHarness.reset()
  })

  test("omo (원본) is offered only where the service lists it, has no 지시문 row and its line from its lazy strings", async () => {
    newSessionHarness.reset()
    const pc = service()
    const toasts: ToastInput[] = []
    const { omoText } = await import("./omo-strings")
    const state = createRoot(() =>
      harnessDefaultState({
        runtime: () => pc.runtime,
        t: (key, params) => translate("ko", key, params),
        toast: (toast) => toasts.push(toast),
        omoDescription: () => omoText.text("ko", "own.omo.desc"),
      }),
    )
    await state.load()
    expect(state.harnesses()).toEqual(["codex", "pi", "dsh", "omo", "opencode"])
    await state.save({ harness: "omo", prompt: "reference" })
    expect(state.promptShown()).toBe(false)
    expect(state.description()).toStartWith("oh-my-opencode(omo) 코드를 그대로 가져와 돌려요.")
    expect(toasts.at(-1)?.message).toContain("omo (원본)")
    expect(translate("en", "own.harness.name.omo")).toBe("omo (original)")
    expect(omoText.text("en", "own.omo.page")).toContain("SUL-1.0")
    // A service whose list leaves omo out (own-omo not running there) does not offer it.
    const without = service()
    const plain = row({
      ...without.runtime,
      harness: {
        ...without.runtime.harness,
        call: (async (method: string, input: unknown) => {
          const answer = (await without.runtime.harness.call(method as "list", input as never)) as unknown as {
            harnesses: HarnessID[]
          }
          return { ...answer, harnesses: answer.harnesses.filter((id) => id !== "omo") }
        }) as typeof without.runtime.harness.call,
      },
    })
    await plain.state.load()
    expect(plain.state.harnesses()).toEqual(["codex", "pi", "dsh", "opencode"])
    newSessionHarness.reset()
  })

  test("the same choice again calls nothing", async () => {
    const pc = service()
    const { state, toasts } = row(pc.runtime)
    await state.load()
    await state.save({ harness: "codex", prompt: "reference" })
    expect(pc.calls).toEqual(["list"])
    expect(toasts).toEqual([])
  })

  test("an older service without defaults.set locks the row and says it keeps its options", async () => {
    const pc = service({ oldBuild: true })
    const { state, toasts } = row(pc.runtime)
    await state.load()
    expect(state.allowed()).toBe(true)
    await state.save({ harness: "pi", prompt: "reference" })
    expect(state.allowed()).toBe(false)
    expect(state.note()).toBe(translate("ko", "own.harness.default.unavailable"))
    expect(toasts).toEqual([{ message: translate("ko", "own.harness.default.unavailable"), tone: "danger" }])
    expect(state.list()?.default).toBe("codex")
    await state.save({ harness: "pi", prompt: "reference" })
    expect(pc.calls).toEqual(["list", "defaults.set"])
  })

  test("a phone or another PC (no local scope) reads the value and is told where to change it", async () => {
    const phone = service({ scopes: new Set<OwnScope>(["read", "prompt", "switch"]) })
    const { state } = row(phone.runtime)
    await state.load()
    expect(state.list()?.default).toBe("codex")
    expect(state.allowed()).toBe(false)
    expect(state.note()).toBe("PC의 앱 창에서 바꿀 수 있어요.")
    await state.save({ harness: "pi", prompt: "reference" })
    expect(phone.calls).toEqual(["list"])
  })

  test("OpenCode 기본 has no 지시문 row; a device without read shows no row at all", async () => {
    const pc = service()
    const { state } = row(pc.runtime)
    await state.load()
    expect(state.promptShown()).toBe(true)
    await state.save({ harness: "opencode", prompt: "reference" })
    expect(state.promptShown()).toBe(false)
    const blind = row(service({ scopes: new Set<OwnScope>() }).runtime)
    await blind.state.load()
    expect(blind.state.list()).toBeUndefined()
  })
})
