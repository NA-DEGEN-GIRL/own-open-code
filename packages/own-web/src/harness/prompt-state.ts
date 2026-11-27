// 설정 > 에이전트 방식 (10 §3.11, harness/prompt-page.tsx): what the page knows and does over one service's own.harness
// client, apart from its drawing so that unit tests drive it with a fake client, as default-state.ts does for 설정 > 일반.
// The page shows what a 에이전트 방식 sends a model under a variant (`prompt.preview`), own's changes, and edits the
// user's 내 지시문 (`prompt.custom.set`, scope `local`: read-only on a phone or another PC). Unsaved edits are kept per
// 에이전트 방식 while the page is open; they are not stored anywhere else. The model starts on the last one picked on
// this device (per server, localStorage), else the model the user works with (`initialModel`: what a new conversation
// would start on, else the latest conversation's), else the service's first; one the service no longer offers is
// dropped for the service's first. The conversation list and the account defaults may load after the page opens: until
// a model is picked or remembered, the preview moves to the usual model once it is known. `비교` previews the variant
// beside the chosen one too (개선판 beside 원본 and 내 지시문, 원본 beside 개선판) with the same model and mode; when only
// that second preview fails, the chosen one still shows and 비교 says it could not load the other. Claude Agent 기본
// (02 §8.10) previews without a variant, 비교 or 내 지시문: Claude Code's own prompt, then OpenCode's role and rules.
// OpenCode 기본 has no preview; its `하위 에이전트` comes from `prompt.subagent`, read once while the page is open
// (none from a service before it, which then shows no such part).
import type { OwnHarness } from "@own/protocol/rpc-harness"
import type { CustomHarnessID, HarnessID, PreviewHarnessID, PromptID } from "@own/protocol/rpc-harness-routing"
import { batch, createEffect, createSignal, on } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { HarnessOutput } from "@/data/harness-rpc"
import { OwnRpcError } from "@/data/rpc"
import type { FeatureText } from "@/queue/text"
import type { ToastInput } from "@/switcher/toast"
import { newSessionHarness, variantHarness } from "./index"
import type { PromptsKey } from "./prompt-strings"

type Preview = OwnHarness.PromptPreview
type Model = OwnHarness.FallbackModel

export function promptPageState(input: {
  readonly runtime: () => Pick<ServerRuntime, "key" | "harness">
  readonly t: FeatureText<PromptsKey>
  readonly toast: (toast: ToastInput) => void
  /** The project on screen, whose folder the environment part names; the service's own Location when none. */
  readonly directory: () => string | undefined
  /** The model the user works with on this server, when known (prompt-page.tsx). */
  readonly initialModel?: () => Model | undefined
}) {
  const harness = () => input.runtime().harness
  const [list, setList] = createSignal<HarnessOutput<"list">>()
  const [tab, setTab] = createSignal<HarnessID>("codex")
  const [prompt, setPrompt] = createSignal<PromptID>("own")
  const [model, setModel] = createSignal<Model>()
  const [mode, setMode] = createSignal<OwnHarness.ApprovalMode>("ask")
  const [preview, setPreview] = createSignal<Preview>()
  const [compare, setCompare] = createSignal(false)
  const [partner, setPartner] = createSignal<Preview>()
  const [partnerFailed, setPartnerFailed] = createSignal(false)
  const [problem, setProblem] = createSignal<"unavailable" | "failed">()
  const [coreSubagent, setCoreSubagent] = createSignal<OwnHarness.PromptSubagent>()
  const [loading, setLoading] = createSignal(false)
  const [drafts, setDrafts] = createSignal<Partial<Record<CustomHarnessID, string>>>({})
  const [busy, setBusy] = createSignal(false)
  // Only the answer to the latest preview counts: an earlier one may arrive after it.
  let asked = 0
  // A model came from a pick, this device's memory or the usual model: later changes of the usual one do not move it.
  let settled = false

  const editing = (): CustomHarnessID | undefined => {
    const current = tab()
    return variantHarness(current)
  }
  /** The 에이전트 방식 the page previews: one with variants, or Claude Agent 기본 (Claude Code's own prompt). */
  const previewed = (): PreviewHarnessID | undefined => (tab() === "claude-code" ? "claude-code" : editing())
  /** The service knows 내 지시문 (2026-10-18 on). */
  const supported = () => list()?.prompts.includes("custom") === true
  const saved = () => preview()?.custom?.text
  const draft = () => {
    const current = editing()
    return current === undefined ? undefined : drafts()[current]
  }
  const text = () => draft() ?? saved() ?? ""
  const limit = () => preview()?.limit ?? 100_000
  const dirty = () => draft() !== undefined && draft() !== (saved() ?? "")
  const invalid = (): "empty" | "too_long" | undefined => {
    if (text().trim() === "") return "empty"
    return text().length > limit() ? "too_long" : undefined
  }
  const setDraft = (value: string | undefined) => {
    const current = editing()
    if (current === undefined) return
    setDrafts((all) => {
      const next = { ...all }
      if (value === undefined) delete next[current]
      else next[current] = value
      return next
    })
  }

  async function refresh() {
    const current = previewed()
    if (current === undefined) {
      setPreview(undefined)
      if (tab() === "opencode" && coreSubagent() === undefined && harness().allowed("prompt.subagent"))
        await harness()
          .call("prompt.subagent", {})
          .then(setCoreSubagent, () => undefined)
      return
    }
    // Claude Agent 기본 has no variants: it sends Claude Code's own prompt whichever is asked, and nothing to compare.
    const variants = editing() !== undefined
    const id = ++asked
    const chosen = model()
    const directory = input.directory()
    const ask = (variant: PromptID) =>
      harness().call("prompt.preview", {
        harness: current,
        prompt: variant,
        mode: mode(),
        ...(chosen === undefined ? {} : { model: chosen }),
        ...(directory === undefined ? {} : { directory }),
      })
    setLoading(true)
    // 비교's second preview failing alone leaves the chosen one on screen (`null` here).
    await Promise.all([
      ask(variants ? prompt() : "reference"),
      variants && compare()
        ? ask(prompt() === "own" ? "reference" : "own").then(
            (value) => value,
            () => null,
          )
        : undefined,
    ]).then(
      ([next, other]) => {
        if (id !== asked) return
        // A remembered or usual model the service no longer offers: preview the service's first instead.
        if (chosen !== undefined && !next.models.some((entry) => sameModel(entry, chosen))) {
          setModel(undefined)
          return refresh()
        }
        // One update, so that 비교 never pairs the new preview with the previous partner.
        batch(() => {
          setPreview(next)
          setPartner(other ?? undefined)
          setPartnerFailed(other === null)
          setProblem(undefined)
          if (chosen === undefined) setModel({ providerID: next.model.providerID, modelID: next.model.modelID })
        })
      },
      (error: unknown) => {
        if (id !== asked) return
        batch(() => {
          setPreview(undefined)
          setPartner(undefined)
          setPartnerFailed(false)
          setProblem(problemOf(error))
        })
      },
    )
    if (id === asked) setLoading(false)
  }

  function remember(next: HarnessOutput<"list">) {
    setList(next)
    newSessionHarness.remember(input.runtime().key, next)
  }

  createEffect(
    on(
      () => [list(), input.initialModel?.()] as const,
      ([loaded, usual]) => {
        if (settled || loaded === undefined || usual === undefined) return
        settled = true
        const current = model()
        if (current !== undefined && sameModel(current, usual)) return
        setModel(usual)
        void refresh()
      },
    ),
  )

  return {
    list,
    tab,
    previewed,
    prompt,
    model,
    mode,
    preview,
    /** OpenCode 기본's `하위 에이전트` (core's `subagent`), once its tab was shown on a service that answers it. */
    coreSubagent,
    compare,
    /**
     * 비교's two previews, left first in the variants' order (원본, 개선판, 내 지시문), with own's changes to mark between
     * 원본 and 개선판 (none between 개선판 and 내 지시문: what differs there is the user's own text).
     */
    comparison: () => {
      const main = preview()
      const beside = partner()
      if (!compare() || main === undefined || beside === undefined) return undefined
      const [left, right] = ORDER.indexOf(main.prompt) < ORDER.indexOf(beside.prompt) ? [main, beside] : [beside, main]
      const changes = left.prompt === "reference" ? right.changes.filter((change) => change.applies) : []
      return { left, right, changes }
    },
    /** 비교 is on and its second preview failed while the chosen one loaded. */
    partnerFailed: () => compare() && partnerFailed(),
    problem,
    loading,
    busy,
    supported,
    /** False on a phone or another PC (scope `local`). */
    editable: () => harness().allowed("prompt.custom.set"),
    /** The variants to pick from: 내 지시문 only on services that know it. */
    prompts: (): readonly PromptID[] => (supported() ? ["reference", "own", "custom"] : ["reference", "own"]),
    /** The editor's text: the unsaved edit, else the saved 내 지시문. */
    text,
    saved,
    limit,
    /** Whether the editor shows: a saved text or an edit in progress (else the page offers the starting texts). */
    started: () => draft() !== undefined || saved() !== undefined,
    dirty,
    invalid,
    async load() {
      if (!harness().allowed("list")) return
      const answered = await harness()
        .call("list", {})
        .then(
          (next) => next,
          (error: unknown) => problemOf(error),
        )
      if (typeof answered === "string") return setProblem(answered)
      const start = rememberedModel(input.runtime().key) ?? input.initialModel?.()
      settled = start !== undefined
      setModel(start)
      remember(answered)
      setTab(answered.default)
      setPrompt(answered.prompts.includes(answered.defaultPrompt) ? answered.defaultPrompt : "own")
      await refresh()
    },
    refresh,
    choose(next: {
      readonly harness?: HarnessID
      readonly prompt?: PromptID
      readonly model?: Model
      readonly mode?: OwnHarness.ApprovalMode
      readonly compare?: boolean
    }) {
      if (next.harness !== undefined) setTab(next.harness)
      if (next.compare !== undefined) setCompare(next.compare)
      if (next.prompt !== undefined) setPrompt(next.prompt)
      if (next.model !== undefined) {
        settled = true
        setModel(next.model)
        rememberModel(input.runtime().key, next.model)
      }
      if (next.mode !== undefined) setMode(next.mode)
      return refresh()
    },
    edit: (value: string) => setDraft(value),
    /** Starts (or restarts) the edit from what `variant` sends the previewed model. */
    start(variant: "reference" | "own") {
      const starts = preview()?.starts
      if (starts !== undefined) setDraft(starts[variant])
    },
    discard: () => setDraft(undefined),
    async save() {
      const current = editing()
      if (current === undefined || busy() || !dirty() || invalid() !== undefined) return
      setBusy(true)
      await harness()
        .call("prompt.custom.set", { harness: current, text: text() })
        .then(
          async (next) => {
            remember(next)
            setDraft(undefined)
            input.toast({ message: input.t("own.prompts.custom.saved") })
            await refresh()
          },
          (error: unknown) => input.toast({ message: failure(error), tone: "danger" }),
        )
      setBusy(false)
    },
    /** 기본으로 되돌리기: deletes the saved text; conversations on 내 지시문 run 개선판 from their next request. */
    async reset() {
      const current = editing()
      if (current === undefined || busy()) return
      setBusy(true)
      await harness()
        .call("prompt.custom.set", { harness: current, text: null })
        .then(
          async (next) => {
            remember(next)
            setDraft(undefined)
            input.toast({ message: input.t("own.prompts.custom.resetDone") })
            await refresh()
          },
          (error: unknown) => input.toast({ message: failure(error), tone: "danger" }),
        )
      setBusy(false)
    },
  }

  function failure(error: unknown) {
    if (error instanceof OwnRpcError && error.type === "prompt_invalid") {
      const data = error.data as { readonly reason?: string; readonly limit?: number } | undefined
      return data?.reason === "too_long"
        ? input.t("own.prompts.custom.tooLong", { limit: (data.limit ?? limit()).toLocaleString() })
        : input.t("own.prompts.custom.empty")
    }
    return input.t("own.prompts.custom.failed")
  }
}

export type PromptPageState = ReturnType<typeof promptPageState>

const ORDER: readonly PromptID[] = ["reference", "own", "custom"]

/** The model last picked on this page, per server (a per-device convenience: nothing else reads it). */
export const MODEL_KEY = "own.web.prompts.model"

/**
 * A service without own.harness (`rpc.unavailable`) or an older one without the prompt page (`rpc.method_not_found`,
 * until it restarts on this version) cannot show it: that is said plainly, without a retry. Anything else failed.
 */
function problemOf(error: unknown): "unavailable" | "failed" {
  return error instanceof OwnRpcError && (error.type === "rpc.unavailable" || error.type === "rpc.method_not_found")
    ? "unavailable"
    : "failed"
}

function sameModel(a: Model, b: Model) {
  return a.providerID === b.providerID && a.modelID === b.modelID
}

function readPicks(): Record<string, Model> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MODEL_KEY) ?? "{}")
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Model>) : {}
  } catch {
    return {}
  }
}

function rememberedModel(serverKey: string): Model | undefined {
  const value = readPicks()[serverKey]
  return typeof value?.providerID === "string" && typeof value.modelID === "string"
    ? { providerID: value.providerID, modelID: value.modelID }
    : undefined
}

function rememberModel(serverKey: string, model: Model) {
  try {
    localStorage.setItem(
      MODEL_KEY,
      JSON.stringify({ ...readPicks(), [serverKey]: { providerID: model.providerID, modelID: model.modelID } }),
    )
  } catch {}
}

/** `text` cut into pieces at each case-insensitive match of `query`, for highlighting; one piece when `query` is empty. */
export function searchPieces(text: string, query: string) {
  if (query === "") return [{ text, match: false }]
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // A capturing split puts every match at an odd index.
  return text
    .split(new RegExp(`(${escaped})`, "gi"))
    .flatMap((piece, index) => (piece === "" ? [] : [{ text: piece, match: index % 2 === 1 }]))
}
