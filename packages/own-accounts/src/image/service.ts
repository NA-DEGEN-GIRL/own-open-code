export * as ImageService from "./service.js"

import { Option, Schema } from "effect"
import { Provider } from "@opencode/schema/provider"
import { LimitRank, OwnImage, type Account } from "@own/protocol"
import type { Deps } from "../deps.js"
import type { Modules } from "../modules.js"
import { Registration } from "../slots/registration.js"
import { Windows } from "../telemetry/windows.js"
import { ImageApi } from "./api.js"

/**
 * The chain of own's image tool (02 §9.6, decisions IM):
 * 1. The user's OpenAI API key accounts in the user's order (`policy.image.keyOrder`, then the others in registry
 *    order), without those turned off for images (`keyOff`) or found used up less than {@link OwnImage.COOLDOWN_MS}
 *    ago. A key that answers with no money or quota (`insufficient_quota`, a billing limit, a quota 429) is marked used
 *    up with the code and the time it was seen (OpenAI has no balance API for project keys, so nothing is guessed) and
 *    the next key is asked. A plain rate limit or a server error is asked again after a wait ({@link RETRIES}); a
 *    refused request ends the chain, since no other key would answer otherwise.
 * 2. Then, while `codexFallback` is on (the default, decisions IM-3), the ChatGPT subscription accounts not turned off
 *    (`codexOff`), from the most remaining limit to the least (`LimitRank`), skipping those at a limit: Codex's own
 *    image generation on the Codex backend, with the backend's model.
 * Every account tried or skipped is a {@link OwnImage.Step} in order, with its reason in Korean for the result card.
 * Keys and tokens stay in this process (`Logins.headers`); nothing here logs a header, a prompt or a key.
 */

export interface Request {
  readonly sessionID: string
  readonly prompt: string
  /** The model for API keys; the family's default when absent. */
  readonly model?: string
  readonly quality?: OwnImage.Quality
  /** The user's default when absent; a GIF's frame size as the tool fitted it (IM-32). */
  readonly size?: ImageApi.Input["size"]
  readonly background?: ImageApi.Input["background"]
  readonly complexity?: OwnImage.Complexity
  /** `output_format` and a GIF's frames (IM-21); anything but PNG is for API keys only. */
  readonly format?: OwnImage.Format
  readonly frames?: number
  readonly frameMs?: number
  readonly images: ImageApi.Input["images"]
  /** The annotation layer over the first image (IM-22); for API keys only. */
  readonly markup?: ImageApi.Input["markup"]
  readonly signal: AbortSignal
  /** Called as the chain moves on (the card's live state). */
  readonly progress?: (steps: ReadonlyArray<OwnImage.Step>, trying: OwnImage.Step) => void
}

export type Outcome =
  | {
      readonly type: "done"
      readonly bytes: Uint8Array
      readonly format: string
      readonly route: "key" | "codex"
      readonly account: Account.Info
      readonly model: string
      readonly costUSD?: number
      readonly tokens?: ReturnType<typeof OwnImage.tokens>
      readonly svgUsage?: OwnImage.SvgUsage
      readonly steps: ReadonlyArray<OwnImage.Step>
    }
  /** No source could make it: every one off, used up, at its limit or failing; `steps` names each with why (IM-13). */
  | { readonly type: "unavailable"; readonly steps: ReadonlyArray<OwnImage.Step> }
  | { readonly type: "refused"; readonly code?: string; readonly status: number; readonly steps: ReadonlyArray<OwnImage.Step> }

/** Waits before asking the same account again after a rate limit or a server error: two more tries at most. */
export const RETRIES = [2_000, 6_000]
/** The longest `retry-after` honored; a longer one moves on to the next account. */
export const MAX_RETRY_AFTER_MS = 20_000
/** One request may take this long (a Sunburst edit at high quality takes minutes). */
export const TIMEOUT_MS = 5 * 60_000
/** The `session-id` of image requests; it names no conversation. */
export const SESSION = "own-accounts:image"
/** own-accounts' KV row of used-up keys: `{[accountID]: OwnImage.Exhausted}`. */
export const KV_EXHAUSTED = "image:exhausted"

const ExhaustedMap = Schema.Record(Schema.String, OwnImage.Exhausted)
const decodeExhausted = Schema.decodeUnknownOption(ExhaustedMap)

export interface Options {
  /** Waits between tries (tests pass a short one). */
  readonly wait?: (ms: number) => Promise<void>
}

export function create(deps: Deps, modules: Modules.All, options: Options = {}) {
  const wait = options.wait ?? ((ms: number) => Bun.sleep(ms))

  const exhausted = async (): Promise<Readonly<Record<string, OwnImage.Exhausted>>> =>
    Option.getOrElse(decodeExhausted(await deps.ctx.storage.get(KV_EXHAUSTED).catch(() => undefined)), () => ({}))
  const writeExhausted = (next: Readonly<Record<string, OwnImage.Exhausted>>) =>
    deps.ctx.storage.set(KV_EXHAUSTED, next as Record<string, Schema.Json>)
  const mark = async (accountID: string, code: string) => {
    const at = deps.clock.now()
    await writeExhausted({ ...(await exhausted()), [accountID]: { code, at, until: at + OwnImage.COOLDOWN_MS } })
  }
  const clear = async (accountID: string) => {
    const current = await exhausted()
    if (!(accountID in current)) return
    await writeExhausted(Object.fromEntries(Object.entries(current).filter((entry) => entry[0] !== accountID)))
  }

  const setting = () => OwnImage.resolve(deps.runtime.policy.cached()?.image)

  /** The API key accounts in chain order, with whether the chain takes each. */
  const keys = () => {
    const resolved = setting()
    return OwnImage.ordered(modules.slots.snapshot().accounts.filter(isKey), resolved.keyOrder).map((account) => ({
      account,
      on: !resolved.keyOff.includes(account.id),
    }))
  }

  /** The subscription accounts from the most remaining limit, with their tightest window. */
  const subscriptions = () => {
    const resolved = setting()
    const now = deps.clock.now()
    return modules.slots
      .snapshot()
      .accounts.filter(isSubscription)
      .map((account) => {
        const windows = deps.runtime.limits.list({ accountID: account.id })
        const lead = LimitRank.ranked(windows, now)[0]
        const used = lead ? LimitRank.facts(lead, now).percent : undefined
        return {
          account,
          on: !resolved.codexOff.includes(account.id),
          used,
          limited:
            deps.runtime.limits.exhaustion(account.id) !== undefined ||
            windows.some((window) => LimitRank.blocks(window, now, undefined)),
        }
      })
      .toSorted((a, b) => Number(a.used === undefined) - Number(b.used === undefined) || (a.used ?? 0) - (b.used ?? 0))
  }

  const view = async (): Promise<OwnImage.View> => {
    const resolved = setting()
    const marks = await exhausted()
    const now = deps.clock.now()
    return {
      setting: {
        family: resolved.family,
        quality: resolved.quality,
        size: resolved.size,
        useKeys: resolved.useKeys,
        codexFallback: resolved.codexFallback,
      },
      keys: keys().map((item) => {
        const marked = marks[item.account.id]
        return {
          accountID: item.account.id,
          label: item.account.label,
          on: item.on,
          ready: ready(item.account),
          ...(marked && marked.until > now ? { exhausted: marked } : {}),
        }
      }),
      codex: subscriptions().map((item) => ({
        accountID: item.account.id,
        label: item.account.label,
        on: item.on,
        ready: ready(item.account),
        ...(item.used === undefined ? {} : { usedPercent: item.used }),
        exhausted: item.limited,
      })),
    }
  }

  const generate = async (request: Request): Promise<Outcome> => {
    const resolved = setting()
    const model = request.model ?? OwnImage.defaultModel(resolved.family)
    const input = (chosen: string): ImageApi.Input => ({
      model: chosen,
      prompt: request.prompt,
      quality: request.quality ?? resolved.quality,
      size: request.size ?? resolved.size,
      images: request.images,
      ...(request.background === undefined ? {} : { background: request.background }),
      ...(request.complexity === undefined ? {} : { complexity: request.complexity }),
      ...(request.format === undefined ? {} : { format: request.format }),
      ...(request.frames === undefined ? {} : { frames: request.frames }),
      ...(request.frameMs === undefined ? {} : { frameMs: request.frameMs }),
      ...(request.markup === undefined ? {} : { markup: request.markup }),
    })
    const steps: OwnImage.Step[] = []
    const marks = await exhausted()
    const now = deps.clock.now()
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)])

    // `API 키 쓰기` off: no key is asked or listed, the subscriptions come first (IM-12).
    for (const item of resolved.useKeys ? keys() : []) {
      const step = (outcome: OwnImage.Step["outcome"], why?: string): OwnImage.Step => ({
        route: "key",
        accountID: item.account.id,
        label: item.account.label,
        outcome,
        ...(why === undefined ? {} : { why }),
      })
      if (!item.on) {
        steps.push(step("skipped", "이미지에 쓰지 않도록 설정했어요"))
        continue
      }
      if (!ready(item.account)) {
        steps.push(step("skipped", `계정을 쓸 수 없는 상태예요 (${item.account.status})`))
        continue
      }
      const marked = marks[item.account.id]
      if (marked && marked.until > now) {
        steps.push(step("skipped", `잔액·한도가 바닥났어요 (${marked.code}, ${clock(marked.at)}에 확인)`))
        continue
      }
      request.progress?.(steps, step("used"))
      const auth = await modules.logins.headers(item.account, SESSION)
      if (!auth.ok) {
        steps.push(step("failed", "금고에서 키를 읽지 못했어요"))
        continue
      }
      const answer = await withRetries(() => ImageApi.openai(deps.endpoints.url.openai, auth.headers, input(model), signal))
      if (answer.ok) {
        if (marked) await clear(item.account.id)
        steps.push(step("used"))
        const usage = answer.usage
        // An SVG's authoring is paid too: priced into the call's cost when the author has a card (IM-34).
        const author = answer.svgUsage && OwnImage.authorCost(answer.svgUsage)
        const image = usage && OwnImage.cost(model, usage)
        return {
          type: "done",
          bytes: answer.bytes,
          format: answer.format,
          route: "key",
          account: item.account,
          model,
          steps,
          ...(usage ? { tokens: OwnImage.tokens(usage) } : {}),
          ...(image === undefined ? {} : { costUSD: Math.round((image + (author ?? 0)) * 1_000_000) / 1_000_000 }),
          ...(answer.svgUsage ? { svgUsage: { ...answer.svgUsage, ...(author === undefined ? {} : { costUSD: author }) } } : {}),
        }
      }
      if (signal.aborted) return { type: "refused", code: "cancelled", status: 0, steps }
      if (answer.failure === "refused")
        return { type: "refused", status: answer.status, steps: [...steps, step("failed", refusedText(answer))], ...(answer.code ? { code: answer.code } : {}) }
      if (answer.failure === "quota") await mark(item.account.id, answer.code ?? `http_${answer.status}`)
      steps.push(step("failed", keyFailureText(answer)))
    }

    // A GIF, an SVG, a JPEG or WebP, or a markup edit: the Codex backend makes PNGs with its own model and takes no
    // format or layer, so no subscription is asked (one line in the card says why) rather than a PNG coming back (IM-21).
    for (const item of resolved.codexFallback && keyOnly(request) === undefined ? subscriptions() : []) {
      const step = (outcome: OwnImage.Step["outcome"], why?: string): OwnImage.Step => ({
        route: "codex",
        accountID: item.account.id,
        label: item.account.label,
        outcome,
        ...(why === undefined ? {} : { why }),
      })
      if (!item.on) {
        steps.push(step("skipped", "이미지에 쓰지 않도록 설정했어요"))
        continue
      }
      if (!ready(item.account)) {
        steps.push(step("skipped", `로그인을 쓸 수 없는 상태예요 (${item.account.status})`))
        continue
      }
      if (item.limited) {
        steps.push(step("skipped", "사용 한도에 닿아 있어요"))
        continue
      }
      request.progress?.(steps, step("used"))
      const auth = await modules.logins.headers(item.account, SESSION)
      if (!auth.ok) {
        steps.push(step("failed", "로그인을 읽지 못했어요"))
        continue
      }
      const answer = await withRetries(() =>
        ImageApi.codex(deps.endpoints.url.codex, { ...auth.headers, originator: Registration.CODEX_HEADERS.originator!, "session-id": SESSION }, input(OwnImage.GPT_IMAGE_2), signal),
      )
      if (answer.response) publish(item.account, answer.response)
      if (answer.ok) {
        steps.push(step("used"))
        return {
          type: "done",
          bytes: answer.bytes,
          format: answer.format,
          route: "codex",
          account: item.account,
          model: OwnImage.GPT_IMAGE_2,
          steps,
        }
      }
      if (signal.aborted) return { type: "refused", code: "cancelled", status: 0, steps }
      if (answer.status === 401) modules.logins.unauthorized(item.account)
      if (answer.failure === "refused")
        return { type: "refused", status: answer.status, steps: [...steps, step("failed", refusedText(answer))], ...(answer.code ? { code: answer.code } : {}) }
      steps.push(
        step(
          "failed",
          answer.status === 429 || answer.failure === "quota"
            ? "사용 한도에 닿았어요"
            : answer.status === 401 || answer.status === 403
              ? "로그인이 거부됐어요"
              : `일시 오류가 계속됐어요 (${answer.status || "연결 실패"})`,
        ),
      )
    }
    return { type: "unavailable", steps: [...steps, ...summaries(resolved, request)] }
  }

  /** The whole groups no account of which was listed: keys switched off or none, the fallback off or none. */
  const summaries = (resolved: OwnImage.Resolved, request: Pick<Request, "format" | "markup">): OwnImage.Step[] => {
    const group = (route: OwnImage.Step["route"], why: string): OwnImage.Step => ({
      route,
      accountID: "",
      label: route === "key" ? "OpenAI API 키" : "Codex 구독",
      outcome: "skipped",
      why,
    })
    return [
      ...(!resolved.useKeys
        ? [group("key", "API 키 쓰기를 껐어요")]
        : keys().length === 0
          ? [group("key", "OpenAI API 키 계정이 없어요")]
          : []),
      ...(!resolved.codexFallback
        ? [group("codex", "Codex 구독으로 대신 만들기를 껐어요")]
        : subscriptions().length === 0
          ? [group("codex", "ChatGPT 구독 계정이 없어요")]
          : keyOnly(request) !== undefined
            ? [group("codex", keyOnly(request)!)]
            : []),
    ]
  }

  /** The same request again after a rate limit or a server error, up to {@link RETRIES}. */
  const withRetries = async (send: () => Promise<ImageApi.Answer>) => {
    const tries = async (left: ReadonlyArray<number>): Promise<ImageApi.Answer> => {
      const answer = await send()
      if (answer.ok || (answer.failure !== "rate" && answer.failure !== "server")) return answer
      const [next, ...rest] = left
      const asked = answer.retryAfter === undefined ? undefined : answer.retryAfter * 1000
      if (next === undefined || (asked !== undefined && asked > MAX_RETRY_AFTER_MS)) return answer
      await wait(asked ?? next)
      return tries(rest)
    }
    return tries(RETRIES)
  }

  /** The answer's `x-codex-*` usage headers → the account's windows, as a session request's would. */
  const publish = (account: Account.Info, response: Response) => {
    const windows = Windows.codexHeaders(
      response.headers,
      { accountID: account.id, providerID: Provider.ID.make(account.providerID) },
      { observedAt: deps.clock.now(), source: response.ok ? "header" : "error" },
    )
    if (windows.length === 0) return
    const changed = deps.runtime.limits.upsert(windows)
    if (changed.length > 0) deps.runtime.broadcast.emit("limits.updated", { windows: changed })
  }

  /**
   * Whether the chain has anything to try now: with `API 키 쓰기` on, a key switched on, usable and not marked used up;
   * with the fallback on, a subscription switched on, usable and not at a limit. Without one the tool answers with the
   * none-available card before it asks the user to approve a paid call, and sends nothing (IM-13).
   */
  const available = async (request: Pick<Request, "format" | "markup"> = {}) => {
    const resolved = setting()
    const marks = await exhausted()
    const now = deps.clock.now()
    const usable = (item: { readonly account: Account.Info; readonly on: boolean }) => item.on && ready(item.account)
    return (
      (resolved.useKeys && keys().some((item) => usable(item) && !((marks[item.account.id]?.until ?? 0) > now))) ||
      (resolved.codexFallback &&
        keyOnly(request) === undefined &&
        subscriptions().some((item) => usable(item) && !item.limited))
    )
  }

  /** The call's ledger line on the slot that answered (`Telemetry.recordImage`). */
  const record = (outcome: Extract<Outcome, { type: "done" }>, sessionID: string) =>
    modules.telemetry.recordImage({
      sessionID,
      providerID: outcome.account.providerID,
      modelID: outcome.model,
      at: deps.clock.now(),
      ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
      ...(outcome.costUSD === undefined ? {} : { costUSD: outcome.costUSD }),
    })

  return { generate, view, clear, setting, record, available }
}

export type Api = ReturnType<typeof create>

/**
 * Why a subscription cannot make this request, or `undefined` when it can: the Codex backend answers with a PNG of its
 * own model (`gpt-image-2`) and takes neither `output_format` nor `markup` (Codex's own tool sends neither).
 */
export function keyOnly(request: Pick<Request, "format" | "markup">) {
  if (request.markup) return "구독(Codex)으로는 표시를 그린 편집(markup)을 할 수 없어요"
  if (request.format === undefined || request.format === "png") return undefined
  if (request.format === "gif" || request.format === "svg")
    return `구독(Codex)으로는 ${request.format.toUpperCase()}를 만들 수 없어요 (OpenAI API 키의 GPT Image 2.6만 돼요)`
  return "구독(Codex)으로는 PNG만 만들 수 있어요"
}

function isKey(account: Account.Info) {
  return account.kind === "oai" && account.status !== "retired"
}

function isSubscription(account: Account.Info) {
  return account.kind === "codex" && account.status !== "retired"
}

/** An account whose credential may be used: ready, or not verified yet (the planner's rule). */
function ready(account: Account.Info) {
  return account.status === "ready" || account.status === "unverified"
}

function keyFailureText(answer: Extract<ImageApi.Answer, { ok: false }>) {
  const code = answer.code ? `, ${answer.code}` : ""
  if (answer.failure === "quota") return `잔액·한도가 바닥났어요 (${answer.status}${code})`
  if (answer.failure === "auth") return `키가 거부됐어요 (${answer.status}${code})`
  if (answer.failure === "access") return `이 키로는 이 모델을 쓸 수 없어요 (${answer.status}${code})`
  return `일시 오류가 계속됐어요 (${answer.status || "연결 실패"}${code})`
}

function refusedText(answer: Extract<ImageApi.Answer, { ok: false }>) {
  return `요청이 거절됐어요 (${answer.status}${answer.code ? `, ${answer.code}` : ""})`
}

/** `HH:MM` of a time, on this PC's clock. */
function clock(at: number) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
