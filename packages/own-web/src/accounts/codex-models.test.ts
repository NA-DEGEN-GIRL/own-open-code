// `Codex 최신 모델 자동 확인` (07 §4.5, CA 2026-10-19) in own-web, over a fake own.accounts service: the store reads the
// view when the connection comes up and follows `codexModels.changed`; `켬`/`끔` go to `codexModels.set`; an older
// service is `unsupported`; a connection without the scopes reads nothing or reads only. The row's version line and the
// note about models own does not know yet, in Korean and English; where the row and the account card's note are wired
// (Solid components do not render under `bun test`, see accounts/ds-balance.test.tsx). Every account is fake.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createSignal } from "solid-js"
import type { ServerRuntime } from "@/data"
import { OwnRpcError } from "@/data/rpc"
import { createI18n, type I18nParams } from "@/i18n"
import { borrowedNote, codexModels, newerNote, unknownNote, versionLine, type CodexModelsView } from "./codex-models"
import { codexModelsKo, codexModelsText, type CodexModelsKey } from "./codex-models-strings"

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 19, 9, 0, 0)

const VIEW: CodexModelsView = {
  autoVersion: true,
  version: "0.165.0",
  build: "0.164.0",
  latest: { version: "0.165.0", fetchedAt: NOW - 3 * HOUR },
  fetchedAt: NOW - 3 * HOUR,
  rejected: 2,
  accounts: { acc_chatgpt01: 2, acc_chatgpt02: 0 },
}

type Listener = (event: { readonly data: Record<string, unknown> }) => void

/** A fake service: own.accounts' `codexModels.*` and its events. */
function service(input: { readonly old?: boolean; readonly allowed?: (method: string) => boolean } = {}) {
  const state = { view: VIEW }
  const calls: Array<readonly [string, unknown]> = []
  const listeners = new Map<string, Set<Listener>>()
  const [status, setStatus] = createSignal("connecting")
  const methods: Record<string, (payload: Record<string, unknown>) => unknown> = {
    "codexModels.get": () => state.view,
    "codexModels.set": (payload) => {
      const on = payload.autoVersion === true
      state.view = { ...state.view, autoVersion: on, version: on ? "0.165.0" : state.view.build }
      return state.view
    },
  }
  // SAFETY: the store reads only these members.
  const runtime = {
    rpc: {
      allowed: (method: string) => input.allowed?.(method) ?? true,
      call: async (method: string, payload: Record<string, unknown>) => {
        calls.push([method, payload])
        if (input.old) throw new OwnRpcError("rpc.method_not_found", `Unknown RPC method: own.accounts.${method}`)
        return methods[method]!(payload)
      },
    },
    connection: { status },
    own: {
      on: (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>()
        listeners.set(name, set)
        set.add(listener)
        return () => set.delete(listener)
      },
    },
  } as unknown as ServerRuntime
  return {
    runtime,
    state,
    calls,
    async connect() {
      setStatus("connected")
      await codexModels(runtime).load()
    },
    emit(name: string, data: Record<string, unknown>) {
      for (const listener of listeners.get(name) ?? []) listener({ data })
    },
  }
}

const ko = (key: CodexModelsKey, params?: I18nParams) => codexModelsText("ko", key, params)
const en = (key: CodexModelsKey, params?: I18nParams) => codexModelsText("en", key, params)

describe("the Codex model list store", () => {
  test("reads the view when the connection comes up and follows other windows' changes", async () => {
    const fake = service()
    const store = codexModels(fake.runtime)
    expect(store.view()).toBeUndefined()
    expect(fake.calls).toEqual([])
    await fake.connect()
    expect(store.view()).toEqual(VIEW)
    const changed = { ...VIEW, autoVersion: false, version: "0.164.0", rejected: 0 }
    fake.emit("codexModels.changed", { view: changed })
    expect(store.view()).toEqual(changed)
  })

  test("켬 / 끔 store the setting on the service and show its answer", async () => {
    const fake = service()
    const store = codexModels(fake.runtime)
    await fake.connect()
    expect(store.editable()).toBe(true)
    expect((await store.set(false)).version).toBe("0.164.0")
    expect(store.view()).toMatchObject({ autoVersion: false, version: "0.164.0" })
    await store.set(true)
    expect(store.view()).toMatchObject({ autoVersion: true, version: "0.165.0" })
    expect(fake.calls.filter((call) => call[0] === "codexModels.set")).toEqual([
      ["codexModels.set", { autoVersion: false }],
      ["codexModels.set", { autoVersion: true }],
    ])
  })

  test("an older service is unsupported; without read scope nothing is asked; without admin it reads only", async () => {
    const old = service({ old: true })
    await old.connect()
    expect(codexModels(old.runtime).unsupported()).toBe(true)
    expect(codexModels(old.runtime).view()).toBeUndefined()
    const none = service({ allowed: () => false })
    await none.connect()
    expect(none.calls).toEqual([])
    const phone = service({ allowed: (method) => method === "codexModels.get" })
    await phone.connect()
    expect(codexModels(phone.runtime).view()).toEqual(VIEW)
    expect(codexModels(phone.runtime).editable()).toBe(false)
  })
})

describe("the row's lines", () => {
  test("the version asked, and when own last checked; off, the version built into own", () => {
    const i18n = createI18n("ko")
    expect(versionLine(ko, i18n, VIEW, NOW)).toBe("지금 Codex 0.165.0 기준으로 목록을 받아요 · 마지막 확인 3시간 전")
    const { latest: _latest, ...unread } = VIEW
    expect(versionLine(ko, i18n, { ...unread, version: "0.164.0" }, NOW)).toBe(
      "지금 Codex 0.164.0 기준으로 목록을 받아요 · 아직 확인 전이에요",
    )
    expect(versionLine(ko, i18n, { ...VIEW, autoVersion: false, version: "0.164.0" }, NOW)).toBe(
      "지금 Codex 0.164.0 기준으로 목록을 받아요 · own에 들어 있는 버전이에요",
    )
    expect(versionLine(en, createI18n("en"), VIEW, NOW)).toBe("Lists are asked as Codex 0.165.0 · last checked 3 h ago")
  })

  test("models own does not know yet: the shared list's count, or one ChatGPT account's", () => {
    expect(unknownNote(ko, VIEW)).toBe("own이 아직 모르는 Codex 모델 2개는 빠졌어요 · own 업데이트가 필요해요")
    expect(unknownNote(ko, VIEW, "acc_chatgpt01")).toBe(
      "own이 아직 모르는 Codex 모델 2개는 빠졌어요 · own 업데이트가 필요해요",
    )
    // None left out, a list not fetched yet, no answer yet: no note.
    expect(unknownNote(ko, VIEW, "acc_chatgpt02")).toBeUndefined()
    expect(unknownNote(ko, VIEW, "acc_chatgpt03")).toBeUndefined()
    expect(unknownNote(ko, { ...VIEW, rejected: 0 })).toBeUndefined()
    expect(unknownNote(ko, undefined)).toBeUndefined()
    expect(unknownNote(en, VIEW)).toBe("2 Codex models own does not know yet are left out · own needs an update")
  })

  test("10 §6.14: each left-out model with the field and value own cannot run yet; a model of its own row runs", () => {
    const left = [
      { slug: "gpt-7", field: "tool_mode", value: '"code_mode"' },
      { slug: "gpt-7-broken", field: "row", value: "" },
    ]
    const view = { ...VIEW, left, accountLeft: { acc_chatgpt01: left, acc_chatgpt02: [] } }
    expect(unknownNote(ko, view)).toBe(
      'own이 아직 못 돌리는 Codex 모델은 빠졌어요: gpt-7 (tool_mode "code_mode"), gpt-7-broken · own 업데이트가 필요해요',
    )
    expect(unknownNote(ko, view, "acc_chatgpt01")).toBe(unknownNote(ko, view))
    // Nothing left out of that account's list: no note, whatever the old count said.
    expect(unknownNote(ko, { ...view, accounts: { acc_chatgpt02: 1 } }, "acc_chatgpt02")).toBeUndefined()
    expect(unknownNote(en, view)).toBe(
      'Codex models own cannot run yet are left out: gpt-7 (tool_mode "code_mode"), gpt-7-broken · own needs an update',
    )
    // Today's two GPT-6.2 models run from their served rows: nothing is left out and no note shows.
    expect(unknownNote(ko, { ...VIEW, rejected: 0, accounts: {}, left: [], accountLeft: {} }, "acc_chatgpt01")).toBeUndefined()
  })

  test("10 §6.14: models running with a similar model's instructions, and a newer Codex release", () => {
    expect(borrowedNote(ko, VIEW)).toBeUndefined()
    expect(borrowedNote(ko, { ...VIEW, borrowed: [{ slug: "gpt-6.9-sol", from: "gpt-6.2-sol" }] })).toBe(
      "서버가 지시문을 주지 않은 모델은 비슷한 모델의 지시문으로 돌아요: gpt-6.9-sol ← gpt-6.2-sol",
    )
    // The newest release read is newer than the one this build follows.
    expect(newerNote(ko, VIEW)).toBe(
      "새 Codex 0.165.0 출시 · 새 모델은 바로 쓰고, 새 도구와 형식은 own 업데이트가 필요해요",
    )
    expect(newerNote(ko, { ...VIEW, build: "0.165.0" })).toBeUndefined()
    expect(newerNote(ko, { ...VIEW, build: "0.165.1" })).toBeUndefined()
    expect(newerNote(ko, { ...VIEW, latest: { version: "0.170.0", fetchedAt: NOW }, build: "0.165.10" })).toBeDefined()
    const { latest: _latest, ...unread } = VIEW
    expect(newerNote(ko, unread)).toBeUndefined()
    expect(newerNote(en, VIEW)).toBe("Codex 0.165.0 is out · new models work now; new tools and formats need an own update")
  })

  test("every word in Korean and English", () => {
    expect(ko("own.codexModels.title")).toBe("Codex 최신 모델 자동 확인")
    for (const key of Object.keys(codexModelsKo) as CodexModelsKey[]) expect(en(key)).not.toBe(ko(key))
  })
})

describe("where the row and the note are", () => {
  /** Source without comments, so names in comments are not taken for code. */
  const code = async (file: string) =>
    (await Bun.file(path.join(import.meta.dir, file)).text())
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/^\s*\/\/.*$/gm, "")

  test("설정 > 프리셋: the row is on the ChatGPT tab only, under its new-session default model", async () => {
    const page = await code("../settings/presets.tsx")
    const row = page.indexOf("<CodexModelsSetting />")
    expect(row).toBeGreaterThan(page.indexOf("<DefaultModelRow group={props.group} save={props.save} />"))
    expect(page.slice(page.lastIndexOf("<Show", row), row)).toContain('when={props.group === "codex"}')
    const ui = await code("codex-models-ui.tsx")
    expect(ui).toContain('data-testid="presets-codex-models"')
    expect(ui).toContain("store.set(on)")
    expect(ui).toContain("disabled: !store.editable()")
  })

  test("10 §6.14: the model picker marks a model registered from a served row, quietly, from the lazy catalog", async () => {
    const popover = await code("../switcher/popover.tsx")
    expect(popover).toContain('mark.id === item.id && mark.source === "served"')
    expect(popover).toContain('codexText("own.codexModels.served")')
    expect(popover).toContain('data-testid="switcher-model-served"')
    expect(ko("own.codexModels.served")).toBe("모델 정보 일부는 서버 목록 기준이에요")
  })

  test("a ChatGPT account card shows its own list's count", async () => {
    const card = await code("account-card.tsx")
    const note = card.indexOf("<CodexUnknownNote accountID={props.id} />")
    expect(note).toBeGreaterThan(0)
    expect(card.slice(card.lastIndexOf("<Show", note), note)).toContain('when={item().kind === "codex"}')
    expect(await code("codex-models-ui.tsx")).toContain("unknownNote(text, store.view(), props.accountID)")
  })
})
