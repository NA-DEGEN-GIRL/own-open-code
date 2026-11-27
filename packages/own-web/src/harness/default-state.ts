// Settings > 일반 `새 대화의 에이전트 방식` (harness/default-setting.tsx, 10 §3.8): what the row knows and does over one
// service's own.harness client, apart from its drawing so that unit tests drive it with a fake client.
import { OwnHarnessRouting, type HarnessID, type PromptID } from "@own/protocol/rpc-harness-routing"
import { createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { HarnessOutput } from "@/data/harness-rpc"
import { OwnRpcError } from "@/data/rpc"
import type { I18n } from "@/i18n"
import type { ToastInput } from "@/switcher/toast"
import { newSessionHarness, runs, variantHarness } from "./index"

export function harnessDefaultState(input: {
  readonly runtime: () => Pick<ServerRuntime, "key" | "harness">
  readonly t: I18n["t"]
  readonly toast: (toast: ToastInput) => void
  /** omo (원본)'s line, from its lazy strings (omo-strings.ts); empty until they loaded. */
  readonly omoDescription?: () => string
}) {
  const harness = () => input.runtime().harness
  const [list, setList] = createSignal<HarnessOutput<"list">>()
  const [missing, setMissing] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const allowed = () => harness().allowed("defaults.set") && !missing()
  const label = (id: HarnessID, prompt: PromptID) =>
    id !== "opencode" && prompt !== "reference"
      ? `${input.t(`own.harness.name.${id}`)} · ${input.t(`own.harness.prompt.short.${prompt}`)}`
      : input.t(`own.harness.name.${id}`)

  return {
    /** What `list` answered; the row stays away until it did (a service without own.harness shows nothing). */
    list,
    busy,
    /** False on a phone or another PC (scope `local`) and on an older service without `defaults.set`. */
    allowed,
    /** The chosen 에이전트 방식's one-line description, as its menu row says it (`own.harness.desc.*`). */
    description: () => {
      const current = list()
      if (current === undefined) return undefined
      return current.default === "omo" ? input.omoDescription?.() : input.t(`own.harness.desc.${current.default}`)
    },
    note: () =>
      missing()
        ? input.t("own.harness.default.unavailable")
        : input.t(allowed() ? "own.harness.default.note" : "own.harness.default.readOnly"),
    /** OpenCode 기본 and omo (원본) have no prompt variant to choose. */
    promptShown: () => {
      const current = list()
      return current !== undefined && variantHarness(current.default) !== undefined
    },
    /** The 에이전트 방식 a new conversation can start with: omo only while the service offers it. */
    harnesses: () =>
      (["codex", "pi", "dsh", "omo", "opencode"] as const).filter((id) => id !== "omo" || list()?.harnesses.includes(id)),
    /** The variants the service offers: 내 지시문 only on services from 2026-10-18 on. */
    prompts: () => OwnHarnessRouting.PROMPTS.filter((id) => list()?.prompts.includes(id) === true),
    /** The prompt row's note: says so when the default is 내 지시문 but the default 에이전트 방식 has no saved text. */
    promptNote: () => {
      const current = list()
      const missing =
        current !== undefined &&
        current.defaultPrompt === "custom" &&
        runs("custom", current.default, { prompts: current.prompts, custom: current.custom ?? [] }) !== "custom"
      return input.t(missing ? "own.harness.default.customMissing" : "own.harness.default.promptNote")
    },
    async load() {
      if (!harness().allowed("list")) return
      await harness()
        .call("list", {})
        .then(setList, () => undefined)
    },
    async save(choice: { readonly harness: HarnessID; readonly prompt: PromptID }) {
      const current = list()
      if (!current || busy() || !allowed()) return
      if (choice.harness === current.default && choice.prompt === current.defaultPrompt) return
      setBusy(true)
      await harness()
        .call("defaults.set", { harness: choice.harness, prompt: choice.prompt })
        .then(
          (next) => {
            setList(next)
            newSessionHarness.remember(input.runtime().key, next)
            input.toast({
              message: input.t("own.harness.default.saved", { name: label(next.default, next.defaultPrompt) }),
            })
          },
          (error: unknown) => {
            // An older service answers method_not_found: it keeps its plugin options until it restarts on this version.
            const old = error instanceof OwnRpcError && error.type === "rpc.method_not_found"
            if (old) setMissing(true)
            input.toast({
              message: input.t(old ? "own.harness.default.unavailable" : "own.harness.default.failed"),
              tone: "danger",
            })
          },
        )
        .finally(() => setBusy(false))
    },
  }
}
