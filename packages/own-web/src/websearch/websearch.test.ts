// 웹 검색 (03 §18.2, WM 2026-10-19): the services as the page, the search cards and the hint describe them, the card
// titles session-ui shows (through transcript/tool-alias.ts and adapter/ui-i18n.ts), the hint's case, the page's place
// in 설정, and the wiring of the page, the card line, the hint and the first-use card. Solid components do not render
// under `bun test` (it compiles JSX for React); e2e/websearch renders them, so their wiring is checked in the source.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { SessionMessageInfo } from "@opencode/client"
import { Approval, SearchKey } from "@own/protocol"
import { uiI18nSource } from "@/adapter/ui-i18n"
import { translate } from "@/i18n"
import type { FeatureText } from "@/queue/text"
import { parseRoute, SETTINGS_GROUPS } from "@/routing/routes"
import { createToolAliases, unwrapped, withToolAliases } from "@/transcript/tool-alias"
import { NO_RESULTS, stateTexts } from "./card"
import {
  asked,
  baseName,
  cardTitle,
  costOf,
  current,
  facts,
  foundBy,
  freeWhileChatGPT,
  keyedOf,
  keylessOf,
  keyServiceOf,
  MULTI,
  multiCost,
  multiRows,
  noteKey,
  ordered,
  paid,
  serviceName,
} from "./services"
import { webSearchKo, webSearchText, type WebSearchKey } from "./strings"
import { dismissHint, hintDismissed, KEYLESS, webSearchUsed } from "./used"

const REPO = path.join(import.meta.dir, "../../../..")
const ko: FeatureText<WebSearchKey> = (key, params) => webSearchText.text("ko", key, params)
const en: FeatureText<WebSearchKey> = (key, params) => webSearchText.text("en", key, params)

const LISTED = [
  { id: "exa", name: "Exa" },
  { id: "firecrawl", name: "Firecrawl" },
  { id: "own-chatgpt", name: "ChatGPT" },
  { id: "parallel", name: "Parallel" },
  { id: "tavily", name: "Tavily" },
  { id: "tinyfish", name: "TinyFish" },
]

/** Source without comments, so names in comments are not taken for code. */
const code = async (file: string) =>
  (await Bun.file(path.join(import.meta.dir, "..", file)).text())
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/^\s*\/\/.*$/gm, "")

describe("the services (what the server lists)", () => {
  test("own's keyless list is exactly the services core registers in plugin/websearch", async () => {
    const dir = path.join(REPO, "packages/core/src/plugin/websearch")
    const ids = new Set<string>()
    for (const file of new Bun.Glob("*.ts").scanSync({ cwd: dir }))
      // Since v2.2.6 (a809a4755f) a keyed service registers through WebSearchProvider.register.
      for (const match of (await Bun.file(path.join(dir, file)).text()).matchAll(
        /(?:editor\.add|WebSearchProvider\.register)\((?:ctx, )?\{\s*id: "([\w-]+)"/g,
      ))
        ids.add(match[1]!)
    expect([...ids].sort()).toEqual([...KEYLESS])
  })

  test("names: the server's, else the known one, else the id", () => {
    expect(serviceName("own-chatgpt")).toBe("ChatGPT")
    expect(serviceName("tinyfish")).toBe("TinyFish")
    expect(serviceName("fake-search", [{ id: "fake-search", name: "Fake Search" }])).toBe("Fake Search")
    expect(serviceName("brand-new")).toBe("brand-new")
  })

  test("cost: ChatGPT's subscription, a keyless service free until a key is in use, another service unknown", () => {
    expect(costOf("own-chatgpt")).toBe("subscription")
    for (const id of KEYLESS) expect(costOf(id)).toBe("free")
    expect(costOf("parallel", { parallel: "key" })).toBe("key")
    expect(costOf("exa", { exa: "env" })).toBe("env")
    expect(costOf("fake-search")).toBe("unknown")
  })

  test("cost: own's DeepSeek from the balance and Brave with the key in own's vault; only those two are paid", () => {
    expect(costOf("own-deepseek")).toBe("balance")
    expect(costOf("brave")).toBe("vault")
    expect(serviceName("own-deepseek")).toBe("DeepSeek")
    expect(serviceName("brave")).toBe("Brave")
    expect(["own-deepseek", "brave"].every(paid)).toBe(true)
    expect([...KEYLESS, "own-chatgpt", "fake-search"].some(paid)).toBe(false)
  })

  test("order: ChatGPT first, then the server's order", () => {
    expect(ordered(LISTED).map((item) => item.id)).toEqual([
      "own-chatgpt",
      "exa",
      "firecrawl",
      "parallel",
      "tavily",
      "tinyfish",
    ])
  })

  test("the service in use: a choice wins; without one ChatGPT while listed, else not decided here", () => {
    expect(current({ type: "service", id: "parallel" }, LISTED)).toEqual({
      type: "service",
      id: "parallel",
      chosen: true,
      missing: false,
    })
    expect(current(undefined, LISTED)).toEqual({ type: "service", id: "own-chatgpt", chosen: false, missing: false })
    expect(
      current(
        undefined,
        LISTED.filter((item) => item.id !== "own-chatgpt"),
      ),
    ).toEqual({ type: "unset" })
    expect(current({ type: "any" }, LISTED)).toEqual({ type: "any" })
    expect(current({ type: "off" }, LISTED)).toEqual({ type: "off" })
    // Chosen, but its plugin or account is gone: core falls back to a first-use answer or asks.
    expect(current({ type: "service", id: "own-chatgpt" }, [{ id: "exa", name: "Exa" }])).toMatchObject({
      missing: true,
    })
  })
})

describe("words (the page, the card, the hint)", () => {
  test("cost and destination lines, as the user asked for them", () => {
    const chatgpt = { id: "own-chatgpt", name: "ChatGPT" }
    const parallel = { id: "parallel", name: "Parallel" }
    expect(facts(chatgpt, undefined, ko)).toEqual(["ChatGPT 구독 사용량에서 빠져요", "검색어가 ChatGPT(OpenAI)로 가요"])
    expect(facts(parallel, {}, ko)).toEqual(["무료 · 키 없음 · 사용량 제한 있음", "검색어가 Parallel로 가요"])
    expect(facts(parallel, { parallel: "key" }, ko)).toEqual([
      "내 Parallel 키로 검색해요 · Parallel 요금이 붙어요",
      "검색어가 Parallel로 가요",
    ])
    expect(facts({ id: "exa", name: "Exa" }, { exa: "env" }, ko)[0]).toBe(
      "환경 변수의 Exa 키로 검색해요 · Exa 요금이 붙어요",
    )
    expect(facts({ id: "fake-search", name: "Fake Search" }, {}, ko)).toEqual(["검색어가 Fake Search로 가요"])
    expect(facts(parallel, {}, en)).toEqual(["Free · no key · usage limits", "Queries go to Parallel"])
    // own's DeepSeek and Brave (SP 2026-10-19): price, who pays, and where the query goes.
    expect(facts({ id: "own-deepseek", name: "DeepSeek" }, undefined, ko)).toEqual([
      "DeepSeek 잔액에서 빠져요 · 1,000건에 약 $0.75",
      "검색어가 중국(DeepSeek) 서버로 가요",
    ])
    expect(facts({ id: "brave", name: "Brave" }, undefined, ko)).toEqual([
      "내 키 · 요금 붙음 · 1,000건에 약 $5(매달 $5어치 무료)",
      "검색어가 Brave로 가요",
    ])
  })

  test("every keyless service and ChatGPT has its own note; another service none", () => {
    for (const id of [...KEYLESS, "own-chatgpt", "own-deepseek", "brave"])
      expect(webSearchKo[noteKey(id)!]).toBeTruthy()
    expect(ko(noteKey("own-deepseek")!)).toContain("결과가 있는 검색에만 요금이 붙고")
    expect(ko(noteKey("brave")!)).toContain("ZDR은 엔터프라이즈 요금제만")
    expect(noteKey("fake-search")).toBeUndefined()
    expect(ko("own.ws.note.parallel")).toContain("5,000건")
    expect(ko("own.ws.note.tinyfish")).toContain("무료")
  })

  test("card titles: the service and its cost, with the right particle", () => {
    expect(cardTitle("own-chatgpt", LISTED, {}, ko)).toBe("ChatGPT로 검색")
    expect(cardTitle("parallel", LISTED, {}, ko)).toBe("Parallel로 검색 (무료)")
    expect(cardTitle("exa", LISTED, { exa: "key" }, ko)).toBe("Exa로 검색 (내 키)")
    expect(cardTitle("tavily", LISTED, { tavily: "env" }, ko)).toBe("Tavily로 검색 (내 키)")
    expect(cardTitle("fake-search", [{ id: "fake-search", name: "Fake Search" }], {}, ko)).toBe("Fake Search로 검색")
    expect(cardTitle("own-deepseek", undefined, undefined, ko)).toBe("DeepSeek로 검색 (잔액)")
    expect(cardTitle("brave", undefined, undefined, ko)).toBe("Brave로 검색 (내 키)")
    expect(cardTitle("own-chatgpt", undefined, undefined, en)).toBe("Search with ChatGPT")
    expect(cardTitle("parallel", undefined, undefined, en)).toBe("Search with Parallel (free)")
  })

  test("the hint, the change link and the empty-free note", () => {
    expect(ko("own.ws.hint", { name: "Parallel" })).toBe(
      "웹 검색이 무료 서비스(Parallel)로 가고 있어요 · ChatGPT 구독으로 바꿀까요?",
    )
    expect(ko("own.ws.card.change")).toBe("검색 서비스 바꾸기")
    expect(ko("own.ws.card.empty", { name: "Exa" })).toBe(
      "결과가 없어요. 키 없이 쓰는 Exa의 무료 한도가 찼을 수도 있어요.",
    )
    expect(ko("own.ws.saved", { choice: ko("own.ws.any") })).toBe(
      "웹 검색 서비스를 목록의 서비스 중 하나(자동)으로 바꿨어요",
    )
    for (const key of Object.keys(webSearchKo) as WebSearchKey[]) expect(en(key), key).not.toBe(ko(key))
  })
})

describe("own's keyed variants of the keyless services (SK 2026-10-23)", () => {
  const KEYED = [
    { id: "exa", name: "Exa" },
    { id: "own-exa", name: "Exa (내 키)" },
    { id: "own-chatgpt", name: "ChatGPT" },
    { id: "parallel", name: "Parallel" },
    { id: "tavily", name: "Tavily" },
    { id: "brave", name: "Brave" },
    { id: "own-tavily", name: "Tavily (내 키)" },
  ]

  test("ids: own-accounts' keyed variants of exactly the keyless services, and back", () => {
    expect(KEYLESS.map(keyedOf)).toEqual(SearchKey.KEYED.map(SearchKey.providerID))
    expect([...KEYLESS]).toEqual([...SearchKey.KEYED])
    for (const id of KEYLESS) expect(keylessOf(keyedOf(id))).toBe(id)
    for (const id of ["exa", "own-chatgpt", "own-deepseek", "own-multi", "brave", "own-", "own-brave"])
      expect(keylessOf(id)).toBeUndefined()
  })

  test("a keyed variant: the user's key from own's vault, its price, its name, and right after its keyless row", () => {
    for (const id of KEYLESS) expect(costOf(keyedOf(id))).toBe("vault")
    expect(serviceName("own-exa", KEYED)).toBe("Exa (내 키)")
    expect(serviceName("own-firecrawl")).toBe("Firecrawl (내 키)")
    expect(baseName("own-tavily", KEYED)).toBe("Tavily")
    expect(ordered(KEYED).map((item) => item.id)).toEqual([
      "own-chatgpt",
      "exa",
      "own-exa",
      "parallel",
      "tavily",
      "own-tavily",
      "brave",
    ])
    // A keyed variant whose keyless service is not listed keeps its own place.
    expect(ordered(KEYED.filter((item) => item.id !== "tavily")).map((item) => item.id)).toContain("own-tavily")
    expect(["own-exa", "own-firecrawl", "own-parallel", "own-tavily"].every(paid)).toBe(true)
    // TinyFish is free with a key too.
    expect(paid("own-tinyfish")).toBe(false)
  })

  test("the cost note says it is the user's key and billed, with the report's price; the query goes to the service", () => {
    expect(facts({ id: "own-exa", name: "Exa (내 키)" }, {}, ko)).toEqual([
      "내 키 · 요금 붙음 · 1,000건에 약 $7(매달 $10어치 무료)",
      "검색어가 Exa로 가요",
    ])
    expect(facts({ id: "own-parallel", name: "Parallel (내 키)" }, {}, ko)[0]).toBe(
      "내 키 · 요금 붙음 · 1,000건에 약 $5(매달 5,000건 무료)",
    )
    expect(facts({ id: "own-tavily", name: "Tavily (내 키)" }, {}, ko)[0]).toBe(
      "내 키 · 요금 붙음 · 1,000건에 약 $8(매달 1,000크레딧 무료)",
    )
    expect(facts({ id: "own-firecrawl", name: "Firecrawl (내 키)" }, {}, ko)[0]).toBe(
      "내 키 · 요금 붙음 · 1,000건에 약 $2~8(매달 1,000크레딧 무료)",
    )
    expect(facts({ id: "own-tinyfish", name: "TinyFish (내 키)" }, {}, ko)[0]).toBe(
      "내 키 · 지금은 요금 없음(2026-05-04부터 무료)",
    )
    // The keyless row beside it stays free.
    expect(facts({ id: "exa", name: "Exa" }, {}, ko)[0]).toBe("무료 · 키 없음 · 사용량 제한 있음")
    expect(facts({ id: "own-exa", name: "Exa (내 키)" }, {}, en)[0]).toContain("Your own key · billed")
    expect(noteKey("own-exa")).toBe("own.ws.note.exa")
    expect(cardTitle("own-exa", KEYED, {}, ko)).toBe("Exa로 검색 (내 키)")
    expect(cardTitle("own-tavily", undefined, undefined, en)).toBe("Search with Tavily (your key)")
    expect(multiCost(["own-exa", "own-tavily", "own-tinyfish"], KEYED, {})).toEqual({
      usd: 0.015,
      subscription: false,
      unknown: [],
    })
  })

  test("the key entry sits under Brave, under a keyed variant while listed, else under the keyless row", () => {
    expect(keyServiceOf("brave", KEYED)).toBe("brave")
    expect(keyServiceOf("own-exa", KEYED)).toBe("exa")
    expect(keyServiceOf("exa", KEYED)).toBeUndefined()
    expect(keyServiceOf("parallel", KEYED)).toBe("parallel")
    expect(keyServiceOf("own-chatgpt", KEYED)).toBeUndefined()
    expect(keyServiceOf("fake-search", KEYED)).toBeUndefined()
    expect(ko("own.ws.key.add", { name: "Exa" })).toBe("Exa 키 넣기…")
    expect(ko("own.ws.key.replace", { name: "Exa" })).toBe("Exa 키 바꾸기…")
    expect(ko("own.ws.key.add", { name: "Brave" })).toBe("Brave 키 넣기…")
    expect(ko("own.ws.key.none", { name: "Exa" })).toBe("없음 · 넣으면 ‘Exa (내 키)’를 고를 수 있어요")
    expect(ko("own.ws.key.saved", { hint: "…a1B2" })).toBe("저장됨 …a1B2")
  })

  test("여러 서비스 함께: one row per service, asked with the key while its keyed variant is listed", () => {
    expect(multiRows(ordered(KEYED)).map((item) => item.id)).toEqual([
      "own-chatgpt",
      "own-exa",
      "parallel",
      "own-tavily",
      "brave",
    ])
    expect(asked("exa", KEYED)).toBe("own-exa")
    expect(asked("own-parallel", KEYED)).toBe("parallel")
    expect(asked("own-tinyfish", KEYED)).toBe("own-tinyfish")
    expect(asked("brave", KEYED)).toBe("brave")
    // The same rule as own-accounts' `KeyedSearch.resolve`.
    expect(Bun.file(path.join(REPO, "packages/own-accounts/src/websearch/keyed.ts")).text()).resolves.toContain(
      "if (listed.includes(idOf(service))) return idOf(service)",
    )
    expect(ko("own.ws.multi.pickNote")).toContain("여기서 키를 넣은 서비스는 그 키로 물어요")
  })
})

describe("여러 서비스 함께 (MS 2026-10-19)", () => {
  test("a mode, not a service: never in the page's list; the choice reads as multi", () => {
    expect(MULTI).toBe(Approval.WEB_SEARCH_MULTI)
    expect(costOf("own-multi")).toBe("multi")
    expect(ordered([...LISTED, { id: "own-multi", name: "여러 서비스" }]).map((item) => item.id)).not.toContain(
      "own-multi",
    )
    expect(current({ type: "multi" }, LISTED)).toEqual({ type: "multi" })
    expect(facts({ id: "own-multi", name: "여러 서비스" }, undefined, ko)).toEqual([])
    // The hint never offers ChatGPT for a multi-service search's id.
    expect(freeWhileChatGPT(["own-multi"], LISTED)).toBeUndefined()
  })

  test("the card names the services that found its results; the line counts them", () => {
    const text = [
      "## [A](https://a.test)\n\nabout a\n\nFound by: ChatGPT, Exa",
      "## [B](https://b.test)\n\nFound by: Exa",
      "## [C](https://c.test)\n\nFound by: Parallel, ChatGPT",
    ].join("\n\n")
    expect(foundBy([text])).toEqual([
      { name: "ChatGPT", count: 2 },
      { name: "Exa", count: 2 },
      { name: "Parallel", count: 1 },
    ])
    const names = foundBy([text]).map((item) => item.name)
    expect(cardTitle("own-multi", LISTED, {}, ko, names)).toBe("여러 서비스로 검색 · ChatGPT·Exa·Parallel")
    expect(cardTitle("own-multi", LISTED, {}, ko)).toBe("여러 서비스로 검색")
    expect(cardTitle("own-multi", LISTED, {}, en, ["Exa"])).toBe("Search with several services · Exa")
    expect(ko("own.ws.card.found", { counts: "ChatGPT 2 · Exa 2" })).toBe("결과를 찾은 서비스: ChatGPT 2 · Exa 2")
    // A tool state's text parts, as the transcript hands them over.
    expect(
      stateTexts({
        content: [
          { type: "text", text },
          { type: "file", url: "x" },
        ],
      }),
    ).toEqual([text])
    expect(stateTexts({})).toEqual([])
    // own-accounts writes the same line (`MultiSearch.FOUND_BY`).
    expect(Bun.file(path.join(REPO, "packages/own-accounts/src/websearch/multi.ts")).text()).resolves.toContain(
      'export const FOUND_BY = "Found by: "',
    )
  })

  test("the cost of one search: paid services summed, ChatGPT's subscription and unknown prices named", () => {
    const listed = [...LISTED, { id: "own-deepseek", name: "DeepSeek" }, { id: "brave", name: "Brave" }]
    expect(multiCost(["own-chatgpt", "exa", "parallel"], listed, {})).toEqual({
      usd: 0,
      subscription: true,
      unknown: [],
    })
    const paidOnes = multiCost(["own-deepseek", "brave", "exa"], listed, { exa: "key" })
    expect(paidOnes.usd).toBeCloseTo(0.01275, 6)
    expect(paidOnes).toMatchObject({ subscription: false, unknown: [] })
    expect(multiCost(["fake-search"], [{ id: "fake-search", name: "Fake Search" }], {})).toEqual({
      usd: 0,
      subscription: false,
      unknown: ["Fake Search"],
    })
    expect(ko("own.ws.multi.cost", { usd: "$0.0058", thousand: "$5.75" })).toBe(
      "검색 한 번에 최대 약 $0.0058 (1,000번이면 약 $5.75)",
    )
  })

  test("the page: a mode choice, checkboxes, the cost line, and 저장 sends the checked services", async () => {
    const page = await code("websearch/settings.tsx")
    expect(page).toContain("data-testid={`settings-websearch-mode-${item}`}")
    expect(page).toContain('role="checkbox"')
    expect(page).toContain("data-testid={`settings-websearch-multi-${service.id}`}")
    expect(page).toContain('data-testid="websearch-multi-cost"')
    expect(page).toContain('save({ type: "multi", services: [...checked()] })')
    // The checkboxes start from what the server says `여러 서비스 함께` asks (stored, else own's default).
    expect(page).toContain("info.state()?.multi?.services")
    // 자동 explains that paid services may be drawn and points to the mode.
    expect(page).toContain('text("own.ws.note.anyPaid"')
    expect(page).toContain('text("own.ws.note.anyMulti")')
  })

  test("the grouped label puts the titles first: `ChatGPT로 검색 · 1번`", () => {
    const source = uiI18nSource(() => "ko")
    expect(source.plural("ui.messagePart.tools.used", 1, { tools: "ChatGPT로 검색" })).toBe("ChatGPT로 검색 · 1번")
    expect(source.plural("ui.messagePart.tools.used", 3, { tools: "읽기, 여러 서비스로 검색" })).toBe(
      "읽기, 여러 서비스로 검색 · 3번",
    )
    const english = uiI18nSource(() => "en")
    expect(english.plural("ui.messagePart.tools.used", 1, { tools: "Read" })).toBe("Read · 1 call")
    expect(english.plural("ui.messagePart.tools.used", 2, { tools: "Read" })).toBe("Read · 2 calls")
  })
})

describe("the card title through session-ui", () => {
  const search = (metadata?: Record<string, unknown>) =>
    ({
      id: "msg_1",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "call_1",
          name: "websearch",
          state: { status: "completed", input: { query: "q" }, content: [{ type: "text", text: "x" }], metadata },
        },
      ],
    }) as unknown as SessionMessageInfo

  test("the service id reads as own's title; own code gets the id back; other metadata stays", () => {
    const aliases = createToolAliases({
      webSearchTitle: (provider, state) => `T:${provider}:${stateTexts(state).join()}`,
    })
    const source = search({ provider: "parallel", other: 1 })
    const wrapped = aliases.wrap(source) as unknown as {
      content: Array<{ name: string; state: { metadata: Record<string, unknown> } }>
    }
    const part = wrapped.content[0]!
    expect(part.name).toBe("websearch")
    // The title gets the service id and the tool's state (a multi-service search's text names its services).
    expect(part.state.metadata.provider).toBe("T:parallel:x")
    expect(part.state.metadata.other).toBe(1)
    // Stable wrappers (session-ui's identity caches) and the raw objects for own code.
    expect(aliases.wrap(source)).toBe(aliases.wrap(source))
    expect((unwrapped(part) as unknown as { state: { metadata: { provider: string } } }).state.metadata.provider).toBe(
      "parallel",
    )
    expect(unwrapped(aliases.wrap(source))).toBe(source)
    // A search before the service is known, and the aliasing without titles, leave the part alone.
    expect((aliases.wrap(search()) as unknown as typeof wrapped).content[0]!.state.metadata).toBeUndefined()
    expect(withToolAliases(source)).toBe(source)
  })

  test("session-ui's template is the title alone; without a service it is 웹 검색", () => {
    const source = uiI18nSource(() => "ko")
    expect(source.t("ui.tool.websearch.provider", { provider: "ChatGPT로 검색" })).toBe("ChatGPT로 검색")
    expect(source.t("ui.tool.websearch")).toBe("웹 검색")
    expect(uiI18nSource(() => "en").t("ui.tool.websearch.provider", { provider: "Search with Exa" })).toBe(
      "Search with Exa",
    )
  })

  test("core's empty answer text is the one the card's note looks for", async () => {
    const tool = await Bun.file(path.join(REPO, "packages/core/src/tool/plugin/websearch.ts")).text()
    expect(tool).toContain(`export const NO_RESULTS = "${NO_RESULTS}"`)
    expect(tool).toContain("metadata: { provider: result.providerID }")
  })
})

describe("the one-time hint", () => {
  const assistant = (provider: string | undefined, status = "completed") =>
    ({
      id: `msg_${provider}`,
      type: "assistant",
      time: { created: 1, completed: status === "completed" ? 2 : undefined },
      content: [
        { type: "text", id: "t", text: "hi" },
        {
          type: "tool",
          id: `call_${provider}`,
          name: "websearch",
          state: { status, input: {}, metadata: provider ? { provider } : {} },
        },
        {
          type: "tool",
          id: "c2",
          name: "read",
          state: { status: "completed", input: {}, metadata: { provider: "x" } },
        },
      ],
    }) as unknown as SessionMessageInfo

  test("the services a conversation's searches used, once each, oldest first", () => {
    expect(
      webSearchUsed([
        assistant("parallel"),
        assistant("own-chatgpt", "running"),
        assistant("parallel"),
        assistant(undefined),
        { id: "u", type: "user", text: "q" } as unknown as SessionMessageInfo,
      ]),
    ).toEqual(["parallel", "own-chatgpt"])
  })

  test("only a free keyless service while ChatGPT is listed; a key or no ChatGPT service means no hint", () => {
    expect(freeWhileChatGPT(["own-chatgpt", "parallel"], LISTED)).toBe("parallel")
    expect(freeWhileChatGPT(["parallel"], LISTED, { parallel: "key" })).toBeUndefined()
    expect(
      freeWhileChatGPT(
        ["parallel"],
        LISTED.filter((item) => item.id !== "own-chatgpt"),
      ),
    ).toBeUndefined()
    expect(freeWhileChatGPT(["fake-search", "own-chatgpt"], LISTED)).toBeUndefined()
  })

  test("closing it is remembered in this browser", () => {
    localStorage.removeItem("own.web.websearch.hint")
    dismissHint()
    expect(hintDismissed()).toBe(true)
    expect(localStorage.getItem("own.web.websearch.hint")).toBe("done")
  })

  test("the banner loads the hint lazily and only for a free service's search that is not closed", async () => {
    const banners = await code("shell/session-banners.tsx")
    expect(banners).toContain('lazy(() => import("@/websearch/hint"))')
    expect(banners).not.toMatch(/^import .*@\/websearch\/hint/m)
    expect(banners).toContain("!hintDismissed() && searched().some(isKeyless)")
    const hint = await code("websearch/hint.tsx")
    // It never changes the service by itself: only its button does, and a choice dismisses it.
    expect(hint.match(/\.set\(/g)).toHaveLength(1)
    expect(hint).toContain("onClick={() => void switchToChatGPT()}")
    expect(hint).toContain('rpc.allowed("websearch.set")')
  })
})

describe("the page and the ways to it", () => {
  test("설정 > 모델·계정 > 웹 검색 at /settings/websearch, after 자동 압축 and 출력 상한", () => {
    expect(SETTINGS_GROUPS.find((group) => group.id === "models")?.sections).toEqual([
      "presets",
      "policy",
      "compaction",
      "output",
      "websearch",
      // IS (2026-11-08): 이미지 만들기, the other tool models call, after it.
      "image",
    ])
    expect(parseRoute("/settings/websearch").route).toEqual({ name: "settings", section: "websearch" })
    expect(translate("ko", "own.settings.websearch")).toBe("웹 검색")
    expect(translate("ko", "own.settings.websearch.hint")).toBe("검색 서비스, 비용, 검색어가 가는 곳")
    expect(translate("ko", "own.settings.approval.hint")).not.toContain("웹 검색")
  })

  test("the page: current service first, ChatGPT recommended, 저장 and 기본으로, the Codex and price notes", async () => {
    const page = await code("websearch/settings.tsx")
    expect(await code("settings/index.tsx")).toContain('lazy(() => import("@/websearch/settings"))')
    expect(page).toContain('data-testid="websearch-now"')
    expect(page).toContain("<Show when={props.service.id === CHATGPT}>")
    expect(page).toContain('save({ type: "default" })')
    expect(page).toContain('text("own.ws.codex")')
    expect(page).toContain('text("own.ws.prices")')
    // Any choice saved here also answers the hint.
    expect(page).toContain("dismissHint()")
    expect(ko("own.ws.codex")).toContain("Codex 방식")
  })

  test("each service's key sits under its row; without a key Brave is a row that cannot be chosen", async () => {
    const page = await code("websearch/settings.tsx")
    expect(page).toContain("{option.service && keyRow(option.service.id)}")
    expect(page).toContain("<For each={multiRows(listed())}>")
    expect(page).toContain("{keyRow(service.id)}")
    expect(page).toContain('data-testid="settings-websearch-brave-needkey"')
    expect(page).toContain("{keyRow(BRAVE)}")
    const key = await code("websearch/search-key.tsx")
    expect(key).toContain('rpc.call("websearch.key.set", { service: service(), key: value })')
    expect(key).toContain('rpc.allowed("websearch.key.set")')
    expect(key).toContain("`settings-websearch-${service()}-key${part}`")
    // The typed key leaves the field before the request goes out.
    expect(key.indexOf('setKey("")')).toBeLessThan(key.indexOf('rpc.call("websearch.key.set"'))
    expect(ko("own.ws.brave.needKey")).toBe("키 필요")
    expect(ko("own.ws.key.add", { name: "Brave" })).toBe("Brave 키 넣기…")
    // 승인·권한 no longer holds it.
    expect(await code("requests/settings.tsx")).not.toContain("SearchKeyRow")
  })

  test("승인·권한 links to it and no longer writes the service", async () => {
    const approval = await code("requests/settings.tsx")
    expect(approval).toContain('router.navigate({ name: "settings", section: "websearch" })')
    expect(approval).not.toContain("websearch.set")
  })

  test("every search card has the line to the page; the first-use card links there and recommends ChatGPT", async () => {
    const transcript = await code("transcript/session.tsx")
    expect(transcript).toContain("createToolAliases({ webSearchTitle: useWebSearchTitle(server, props.directory) })")
    expect(transcript).toContain("<SearchLineView row={() => timelineRow(row())} onSizeChange={onSizeChange} />")
    expect(await code("websearch/card.tsx")).toContain('router.navigate({ name: "settings", section: "websearch" })')
    const dock = await code("requests/websearch-dock.tsx")
    expect(dock).toContain('data-testid="websearch-settings"')
    expect(dock).toContain('data-testid="websearch-allow-chatgpt"')
    expect(dock).toContain('data-variant={chatgpt() ? undefined : "primary"}')
    // The paid services' cost under `allow` (core's random may draw them) and under their names in the list.
    expect(dock).toContain("props.ws.options().filter((option) => paid(option.value))")
    expect(dock).toContain("<Show when={paid(option.value)}>")
    expect(translate("ko", "own.websearch.body")).toContain("설정 > 웹 검색에서")
    expect(translate("ko", "own.websearch.disableWarn")).toContain("설정 > 웹 검색에서")
  })
})
