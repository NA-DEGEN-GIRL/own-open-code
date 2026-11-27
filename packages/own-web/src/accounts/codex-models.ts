// Codex 모델 목록 (07 §4.5, CA 2026-10-19): which Codex version this PC's service asks the ChatGPT accounts' model lists
// as, the setting `Codex 최신 모델 자동 확인`, and the rows own left out because it does not know them yet. One store per
// runtime for the window's life, read when the connection comes up (again after every reconnect) and kept by
// `codexModels.changed`; 설정 > 프리셋's ChatGPT tab and the ChatGPT account cards read it. An older service without the
// methods is `unsupported`: the row says so and the cards say nothing.
import { createEffect, createRoot, on } from "solid-js"
import { createStore } from "solid-js/store"
import { OwnRpcError, type ServerRuntime } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import type { I18n, I18nParams } from "@/i18n"
import { ago } from "@/limits/format"
import type { CodexModelsKey } from "./codex-models-strings"

export type CodexModelsView = OwnOutput<"codexModels.get">

export type CodexModelsRuntime = Pick<ServerRuntime, "rpc" | "connection"> & {
  readonly own: Pick<ServerRuntime["own"], "on">
}

type Text = (key: CodexModelsKey, params?: I18nParams) => string

const stores = new WeakMap<object, ReturnType<typeof createCodexModels>>()

/** The window's store of this runtime's Codex model list version, created and watched on first use. */
export function codexModels(runtime: CodexModelsRuntime) {
  const existing = stores.get(runtime)
  if (existing) return existing
  const store = createRoot(() => createCodexModels(runtime))
  stores.set(runtime, store)
  return store
}

/**
 * The row's version line: `지금 Codex 0.165.0 기준으로 목록을 받아요 · 마지막 확인 3시간 전`; off, `… · own에 들어 있는
 * 버전이에요`; on before the first read, `… · 아직 확인 전이에요`.
 */
export function versionLine(text: Text, i18n: I18n, view: CodexModelsView, now: number) {
  const latest = view.latest
  const tail = !view.autoVersion
    ? text("own.codexModels.buildOnly")
    : latest
      ? text("own.codexModels.checked", { when: ago(i18n, now, latest.fetchedAt) })
      : text("own.codexModels.notChecked")
  return `${text("own.codexModels.version", { version: view.version })} · ${tail}`
}

/**
 * The models own left out (07 §4.5, 10 §6.14) of the shared list, or with `accountID` of that ChatGPT account's list:
 * each with the field and value own's harness cannot run yet (`own이 아직 못 돌리는 Codex 모델은 빠졌어요: gpt-7 (tool_mode
 * "code_mode") · own 업데이트가 필요해요`); from an older service, which keeps no reasons, the count. `undefined` when none
 * was left out or the account's list was not fetched yet.
 */
export function unknownNote(text: Text, view: CodexModelsView | undefined, accountID?: string) {
  const left = accountID === undefined ? view?.left : view?.accountLeft?.[accountID]
  if (left !== undefined)
    return left.length === 0
      ? undefined
      : text("own.codexModels.leftOut", {
          list: left
            .map((item) => (item.field === "row" ? item.slug : `${item.slug} (${item.field} ${item.value})`))
            .join(", "),
        })
  const count = accountID === undefined ? view?.rejected : view?.accounts[accountID]
  return count ? text("own.codexModels.unknown", { n: count }) : undefined
}

/** The runtime models running with a bundled model's instructions (`gpt-6.9-sol ← gpt-6.2-sol`); `undefined` when none. */
export function borrowedNote(text: Text, view: CodexModelsView | undefined) {
  const borrowed = view?.borrowed ?? []
  if (borrowed.length === 0) return undefined
  return text("own.codexModels.borrowed", { list: borrowed.map((item) => `${item.slug} ← ${item.from}`).join(", ") })
}

/**
 * `새 Codex 0.172.0 출시 · …` when the newest release own read is newer than the one this build follows: new models run
 * from their served rows at once (10 §6.14), new tools and request formats wait for an own update.
 */
export function newerNote(text: Text, view: CodexModelsView | undefined) {
  const latest = view?.latest?.version
  if (view === undefined || latest === undefined || !newer(latest, view.build)) return undefined
  return text("own.codexModels.newer", { latest })
}

function newer(a: string, b: string) {
  const [x, y] = [a, b].map((version) => version.split(".").map(Number))
  const index = x!.findIndex((part, at) => part !== y![at])
  return index >= 0 && x![index]! > y![index]!
}

function createCodexModels(runtime: CodexModelsRuntime) {
  const [state, setState] = createStore<{ view?: CodexModelsView; unsupported: boolean }>({ unsupported: false })
  let loading: Promise<void> | undefined
  const remember = (view: CodexModelsView) => setState({ view, unsupported: false })

  function load() {
    if (!runtime.rpc.allowed("codexModels.get")) return Promise.resolve()
    loading ??= runtime.rpc
      .call("codexModels.get", {})
      .then(remember, (error: unknown) => {
        // An older service (method_not_found) or a remote one (the setting is the PC's): nothing to show.
        if (error instanceof OwnRpcError && (error.type === "rpc.method_not_found" || error.type === "remote_managed"))
          setState({ view: undefined, unsupported: true })
      })
      .finally(() => {
        loading = undefined
      })
    return loading
  }

  createEffect(
    on(
      () => runtime.connection.status(),
      (status) => {
        if (status === "connected") void load()
      },
    ),
  )
  runtime.own.on("codexModels.changed", (event) => remember(event.data.view))

  return {
    /** What the service answered; `undefined` until it did (or on an older service). */
    view: () => state.view,
    /** The service has no such setting (an older build). */
    unsupported: () => state.unsupported,
    load,
    /** This connection may change the setting (`admin`); a phone without it reads it only. */
    editable: () => runtime.rpc.allowed("codexModels.set"),
    /** `켬` / `끔`: the service stores it and answers the new view. */
    async set(autoVersion: boolean) {
      const view = await runtime.rpc.call("codexModels.set", { autoVersion })
      remember(view)
      return view
    },
  }
}
