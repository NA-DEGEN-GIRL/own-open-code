// 설정 > 웹 검색 end to end (03 §18.2, WM 2026-10-19), on a server with ChatGPT accounts and nothing chosen:
// - the page from the settings list (모델·계정 > 웹 검색): ChatGPT answers by default, every listed service is there with
//   its cost and destination, ChatGPT first and recommended;
// - a search in a conversation is titled `ChatGPT로 검색` and its line `검색 서비스 바꾸기` opens the page; switching to
//   `Fake Search` there makes the next search `Fake Search로 검색`; `기본으로` brings ChatGPT back;
// - a conversation whose first message read answers with the state from before a turn gets the turn and its search
//   card back from a second read (transcript/read.ts);
// - a choice made elsewhere (the RPC, as an older 설정 or the first-use card left it) of the free `Parallel` shows the
//   card `Parallel로 검색 (무료)`, an empty answer's note, and the one-time hint, whose `ChatGPT로 바꾸기` switches back;
// - 여러 서비스 함께 (MS 2026-10-19): the mode, own's default checkboxes, the cost line, a saved selection, a search
//   card `여러 서비스로 검색 · …` with the services that found its results, and back to one service;
// - own's DeepSeek and Brave show their cost; Brave without a key is a `키 필요` row with the key entry under it, and
//   a stored key lists Brave (SP 2026-10-19, own's vault through `websearch.key.set`);
// - a keyless service's own key (SK 2026-10-23): Exa's key under the Exa row adds `Exa (내 키)` right under the free
//   one with its price; chosen, a search goes to the backend's fake Exa with the key and its card reads
//   `Exa로 검색 (내 키)`; `여러 서비스 함께` shows one Exa row, asked with the key and priced in the cost line (also
//   once chosen with own's default selection); removing the key takes the row away;
// - 승인·권한's link and the palette's `웹 검색 서비스 바꾸기` lead to the page; a phone-wide window fits it.
// Parallel here is the e2e kit's memory stand-in with core's id (its option `parallel`), and the keyed variants ask the
// backend's fakes of the five services: nothing leaves this PC.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"

const TMP = process.env.OWN_WEB_WEBSEARCH_E2E_TMP ?? ""
const state = JSON.parse(fs.readFileSync(path.join(TMP, "backend.json"), "utf8")) as {
  readonly control: string
  readonly config: string
  readonly session: { readonly id: string }
  /** The fake keys the backend's fakes of the five services take. */
  readonly searchKeys: Readonly<Record<"exa" | "firecrawl" | "parallel" | "tavily" | "tinyfish", string>>
}
/** Screenshots for a look at the page (not compared): `<tmp>/shots`. */
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(TMP, "shots", `${name}.png`), fullPage: true })

async function rpc(request: APIRequestContext, method: string, input: unknown) {
  const response = await request.post(`/api/rpc/own.accounts/${method}`, {
    data: { input },
    params: { "location[directory]": state.control },
  })
  expect(response.status(), method).toBe(200)
  return ((await response.json()) as { output: unknown }).output
}

/** core's loaded `websearch` value (the config watcher reloaded the file), or `undefined` without one. */
async function loaded(request: APIRequestContext) {
  const entries = (await (await request.get("/api/config")).json()) as ReadonlyArray<{
    readonly type?: string
    readonly info?: { readonly websearch?: unknown }
  }>
  return entries.filter((entry) => entry.type === "document" && entry.info && "websearch" in entry.info).at(-1)?.info
    ?.websearch
}

/** The service ids of the conversation's searches, oldest first (the list comes newest first). */
async function searches(request: APIRequestContext) {
  const body = (await (await request.get(`/api/session/${state.session.id}/message`)).json()) as {
    readonly data?: ReadonlyArray<{
      readonly type: string
      readonly time: { readonly created: number }
      readonly content?: ReadonlyArray<{
        readonly name?: string
        readonly state?: { readonly metadata?: { provider?: string } }
      }>
    }>
  }
  return [...(body.data ?? [])]
    .sort((a, b) => a.time.created - b.time.created)
    .flatMap((message) =>
      (message.content ?? []).flatMap((part) => (part.name === "websearch" ? [part.state?.metadata?.provider] : [])),
    )
}

/** Sends `text` in the test conversation and waits for the turn to end. */
async function send(page: Page, text: string) {
  await page.goto(`/srv/local/s/${state.session.id}`)
  const composer = page.locator("#own-composer-input")
  await composer.fill(text)
  await composer.press("Control+Enter")
  await expect(page.getByTestId("composer-stop"))
    .toBeVisible({ timeout: 30_000 })
    .catch(() => undefined)
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 60_000 })
}

/** The newest row with a search (the transcript mounts only the rows on screen). */
const lastSearch = (page: Page) =>
  page
    .locator(".own-row")
    .filter({ has: page.getByTestId("websearch-line") })
    .last()

test.describe.configure({ mode: "serial" })

test("the page from the settings list and from a search card; a switch shows on the next search; 기본으로", async ({
  page,
  request,
}) => {
  await page.goto("/settings")
  await page.getByTestId("settings-group-models").getByTestId("settings-nav-websearch").click()
  await expect(page).toHaveURL(/\/settings\/websearch$/)
  const now = page.getByTestId("websearch-now")
  await expect(now.getByTestId("websearch-now-name")).toHaveText("ChatGPT")
  await expect(now.getByTestId("websearch-now-source")).toHaveText("기본값")
  await expect(now.getByTestId("websearch-now-facts")).toContainText("ChatGPT 구독 사용량에서 빠져요")
  await expect(now.getByTestId("websearch-now-facts")).toContainText("검색어가 ChatGPT(OpenAI)로 가요")
  await expect(now.getByTestId("websearch-now-why")).toHaveText("ChatGPT 계정이 있어서 이 앱이 기본으로 써요.")
  // Every service the server lists, ChatGPT first and recommended, then 자동 and 끄기.
  const options = page.getByTestId("settings-websearch").getByRole("radio")
  await expect(options.first()).toHaveAttribute("data-testid", "settings-websearch-service:own-chatgpt")
  await expect(options.first()).toHaveAttribute("aria-checked", "true")
  await expect(options.first().getByTestId("websearch-recommended")).toHaveText("추천")
  for (const id of ["exa", "firecrawl", "parallel", "tavily", "tinyfish", "fake-search"])
    await expect(page.getByTestId(`settings-websearch-service:${id}`)).toBeVisible()
  await expect(page.getByTestId("settings-websearch-service:parallel")).toContainText(
    "무료 · 키 없음 · 사용량 제한 있음 · 검색어가 Parallel로 가요",
  )
  await expect(options.nth(-2)).toHaveAttribute("data-testid", "settings-websearch-any")
  await expect(options.last()).toHaveAttribute("data-testid", "settings-websearch-off")
  await expect(page.getByTestId("settings-websearch-save")).toBeDisabled()
  await expect(page.getByTestId("settings-websearch-default")).toBeDisabled()
  await expect(page.getByTestId("websearch-codex-note")).toContainText("Codex 방식")
  await page.getByTestId("settings-content").evaluate((element) => (element.scrollTop = 0))
  await shot(page, "1-page-default")

  // A search: titled with the service that answered; its line opens the page.
  await send(page, "[websearch] bun 1.4 release notes")
  await expect.poll(() => searches(request)).toEqual(["own-chatgpt"])
  await expect(lastSearch(page)).toContainText("ChatGPT로 검색")
  await shot(page, "2-card-chatgpt")
  await lastSearch(page).getByTestId("websearch-change").click()
  await expect(page).toHaveURL(/\/settings\/websearch$/)

  // Switch to Fake Search; core reloads the config file; the next search uses it.
  await page.getByTestId("settings-websearch-service:fake-search").click()
  await page.getByTestId("settings-websearch-save").click()
  await expect(page.getByText("웹 검색 서비스를 Fake Search로 바꿨어요")).toBeVisible()
  await expect(now.getByTestId("websearch-now-name")).toHaveText("Fake Search")
  await expect(now.getByTestId("websearch-now-source")).toHaveText("직접 고름")
  await expect(now.getByTestId("websearch-now-facts")).toHaveText("검색어가 Fake Search로 가요")
  await expect(page.getByTestId("settings-websearch-default")).toBeEnabled()
  await expect.poll(() => loaded(request)).toEqual({ provider: "fake-search" })
  await send(page, "[websearch] second query")
  await expect.poll(() => searches(request)).toEqual(["own-chatgpt", "fake-search"])
  await expect(lastSearch(page)).toContainText("Fake Search로 검색")

  // 기본으로: the choice is removed and ChatGPT answers again.
  await page.goto("/settings/websearch")
  await page.getByTestId("settings-websearch-default").click()
  await expect(page.getByText("웹 검색 서비스를 기본값으로 바꿨어요")).toBeVisible()
  await expect(now.getByTestId("websearch-now-name")).toHaveText("ChatGPT")
  await expect(now.getByTestId("websearch-now-source")).toHaveText("기본값")
  expect(JSON.parse(fs.readFileSync(state.config, "utf8"))).not.toHaveProperty("websearch")
  await expect.poll(() => loaded(request)).toBeUndefined()
  await send(page, "[websearch] third query")
  await expect.poll(() => searches(request)).toEqual(["own-chatgpt", "fake-search", "own-chatgpt"])
  await expect(lastSearch(page)).toContainText("ChatGPT로 검색")
})

test("a first message read that answers after the turn ran: the turn and its search card come back", async ({
  page,
  request,
}) => {
  // The transcript chunk loads lazily, so a conversation opened just before a prompt reads its messages a moment
  // later; an answer from before the turn then dropped the step that searched (seen in this suite, 2026-10-24). Here
  // the first read (no cursor) answers with the server's state from before the prompt once the turn has ended, and
  // the read after it is held until the dropped turn has been seen gone.
  const first = { held: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  const reread = Promise.withResolvers<void>()
  const reads = { count: 0 }
  await page.route(/\/api\/session\/[^/]+\/message\?/, async (route) => {
    if (route.request().method() !== "GET" || route.request().url().includes("cursor=")) return route.continue()
    reads.count++
    if (reads.count > 2) return route.continue()
    if (reads.count === 2) {
      await reread.promise
      return route.continue()
    }
    const response = await route.fetch()
    first.held.resolve()
    await first.release.promise
    await route.fulfill({ response })
  })
  const before = (await searches(request)).length
  await page.goto(`/srv/local/s/${state.session.id}`)
  await first.held.promise
  const composer = page.locator("#own-composer-input")
  await composer.fill("[websearch] opened just before the prompt")
  await composer.press("Control+Enter")
  await expect.poll(async () => (await searches(request)).length).toBe(before + 1)
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout: 60_000 })
  const prompt = page.locator(".own-row").filter({ hasText: "opened just before the prompt" })
  first.release.resolve()
  // The old answer lands: the turn is gone until the second read (transcript/read.ts) brings it back.
  await expect.poll(() => reads.count, { timeout: 10_000 }).toBe(2)
  await expect(prompt).toHaveCount(0)
  reread.resolve()
  await expect(prompt).toHaveCount(1)
  await expect(lastSearch(page)).toContainText("ChatGPT로 검색")
})

test("a free service chosen elsewhere: the card says so, an empty answer gets its note, the hint switches back", async ({
  page,
  request,
}) => {
  // As an older 설정 (its first option was `자동`) or the first-use card could leave it: here Parallel by RPC.
  await rpc(request, "websearch.set", { choice: { type: "service", id: "parallel" } })
  await expect.poll(() => loaded(request)).toEqual({ provider: "parallel" })
  await send(page, "[websearch] [empty] release notes")
  await expect.poll(async () => (await searches(request)).at(-1)).toBe("parallel")
  await expect(lastSearch(page)).toContainText("Parallel로 검색 (무료)")
  await expect(lastSearch(page).getByTestId("websearch-empty")).toHaveText(
    "결과가 없어요. 키 없이 쓰는 Parallel의 무료 한도가 찼을 수도 있어요.",
  )
  const hint = page.getByTestId("websearch-hint")
  await expect(hint).toContainText("웹 검색이 무료 서비스(Parallel)로 가고 있어요 · ChatGPT 구독으로 바꿀까요?")
  await shot(page, "3-hint")
  await hint.getByTestId("websearch-hint-switch").click()
  await expect(page.getByText("웹 검색 서비스를 ChatGPT로 바꿨어요")).toBeVisible()
  await expect(hint).toHaveCount(0)
  expect(await rpc(request, "websearch.get", {})).toMatchObject({ choice: { type: "service", id: "own-chatgpt" } })
  await expect.poll(() => loaded(request)).toEqual({ provider: "own-chatgpt" })
  // Once answered, the hint stays away in this browser even when a free service answers again.
  await rpc(request, "websearch.set", { choice: { type: "service", id: "parallel" } })
  await expect.poll(() => loaded(request)).toEqual({ provider: "parallel" })
  await send(page, "[websearch] once more")
  await expect(lastSearch(page)).toContainText("Parallel로 검색 (무료)")
  await expect(page.getByTestId("websearch-hint")).toHaveCount(0)
  await rpc(request, "websearch.set", { choice: { type: "default" } })
})

test("DeepSeek and Brave: their cost lines; the Brave key next to its row lists Brave, removing it takes it away", async ({
  page,
  request,
}) => {
  // own's DeepSeek (the backend's DeepSeek API account lists it; SP 2026-10-19): never the default, its cost shown.
  await page.goto("/settings/websearch")
  await expect(page.getByTestId("settings-websearch-service:own-deepseek")).toContainText(
    "DeepSeek 잔액에서 빠져요 · 1,000건에 약 $0.75 · 검색어가 중국(DeepSeek) 서버로 가요",
  )
  // Brave without a key: a row that cannot be chosen (`키 필요`) and the key entry under it.
  const needKey = page.getByTestId("settings-websearch-brave-needkey")
  await expect(needKey).toContainText("키 필요")
  await expect(needKey).toContainText("내 키 · 요금 붙음 · 1,000건에 약 $5")
  await expect(page.getByTestId("settings-websearch-service:brave")).toHaveCount(0)
  const key = page.getByTestId("settings-websearch-brave-key")
  await expect(key.getByTestId("settings-websearch-brave-key-state")).toHaveText(
    "Brave 키: 없음 · 넣으면 Brave를 고를 수 있어요",
  )
  await key.getByTestId("settings-websearch-brave-key-open").click()
  await key.getByTestId("settings-websearch-brave-key-input").fill("BSAfake-e2e-web-Zt9q")
  await key.getByTestId("settings-websearch-brave-key-save").click()
  // Stored in own's vault: Brave is listed (the server's list follows `websearch.updated`) with its cost line.
  await expect(page.getByTestId("settings-websearch-service:brave")).toContainText(
    "내 키 · 요금 붙음 · 1,000건에 약 $5(매달 $5어치 무료) · 검색어가 Brave로 가요",
  )
  await expect(needKey).toHaveCount(0)
  await expect(key.getByTestId("settings-websearch-brave-key-state")).toHaveText("Brave 키: 저장됨 …Zt9q")
  await expect(key.getByTestId("settings-websearch-brave-key-input")).toHaveCount(0)
  expect(await rpc(request, "websearch.key.get", {})).toEqual({
    keys: ["brave", "exa", "firecrawl", "parallel", "tavily", "tinyfish"].map((service) =>
      service === "brave" ? { service, configured: true, keyHint: "…Zt9q" } : { service, configured: false },
    ),
    vault: "ok",
  })
  await key.getByRole("button", { name: "지우기" }).click()
  await key.getByTestId("settings-websearch-brave-key-remove").click()
  await expect(page.getByTestId("settings-websearch-service:brave")).toHaveCount(0)
  await expect(needKey).toBeVisible()
  await expect(key.getByTestId("settings-websearch-brave-key-state")).toContainText("없음")
})

test("Exa with the user's key: its own row beside the free one; chosen, the card says so; 여러 서비스 함께 asks it", async ({
  page,
  request,
}) => {
  const key = state.searchKeys.exa
  await page.goto("/settings/websearch")
  const exa = page.getByTestId("settings-websearch-service:exa")
  const keyed = page.getByTestId("settings-websearch-service:own-exa")
  await expect(exa).toContainText("무료 · 키 없음 · 사용량 제한 있음 · 검색어가 Exa로 가요")
  await expect(keyed).toHaveCount(0)
  // Every keyless service has its key entry under its row.
  for (const id of ["exa", "firecrawl", "parallel", "tavily", "tinyfish"])
    await expect(page.getByTestId(`settings-websearch-${id}-key-state`)).toContainText("없음")
  const entry = page.getByTestId("settings-websearch-exa-key")
  await expect(entry.getByTestId("settings-websearch-exa-key-state")).toHaveText(
    "Exa 키: 없음 · 넣으면 ‘Exa (내 키)’를 고를 수 있어요",
  )
  await entry.getByTestId("settings-websearch-exa-key-open").click()
  await entry.getByTestId("settings-websearch-exa-key-input").fill(key)
  await entry.getByTestId("settings-websearch-exa-key-save").click()

  // In own's vault: `Exa (내 키)` is listed right under the free Exa, with the key's price; the free one stays.
  await expect(keyed).toContainText("Exa (내 키)")
  await expect(keyed).toContainText("내 키 · 요금 붙음 · 1,000건에 약 $7(매달 $10어치 무료) · 검색어가 Exa로 가요")
  await expect(exa).toContainText("무료 · 키 없음 · 사용량 제한 있음")
  const radios = await page
    .getByTestId("settings-websearch")
    .getByRole("radio")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-testid")))
  expect(radios.indexOf("settings-websearch-service:own-exa")).toBe(
    radios.indexOf("settings-websearch-service:exa") + 1,
  )
  await expect(page.getByTestId("settings-websearch-exa-key-state")).toHaveText(`Exa 키: 저장됨 …${key.slice(-4)}`)
  await expect(page.getByTestId("settings-websearch-exa-key-input")).toHaveCount(0)
  expect(await rpc(request, "websearch.key.get", {})).toMatchObject({
    keys: expect.arrayContaining([{ service: "exa", configured: true, keyHint: `…${key.slice(-4)}` }]),
  })
  await keyed.scrollIntoViewIfNeeded()
  await shot(page, "7-exa-key")

  // Chosen, the next search goes to the fake Exa with the key; its card names the service and the key.
  await keyed.click()
  await page.getByTestId("settings-websearch-save").click()
  await expect(page.getByText("웹 검색 서비스를 Exa (내 키)로 바꿨어요")).toBeVisible()
  const now = page.getByTestId("websearch-now")
  await expect(now.getByTestId("websearch-now-facts")).toContainText("내 키 · 요금 붙음 · 1,000건에 약 $7")
  await expect.poll(() => loaded(request)).toEqual({ provider: "own-exa" })
  await send(page, "[websearch] keyed exa query")
  await expect.poll(async () => (await searches(request)).at(-1)).toBe("own-exa")
  await expect(lastSearch(page)).toContainText("Exa로 검색 (내 키)")
  await shot(page, "8-exa-card")

  // 여러 서비스 함께: one Exa row, the keyed one, checked by default and priced; nothing is saved here.
  await page.goto("/settings/websearch")
  await page.getByTestId("settings-websearch-mode-multi").click()
  const box = (id: string) => page.getByTestId(`settings-websearch-multi-${id}`)
  await expect(box("exa")).toHaveCount(0)
  await expect(box("own-exa")).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("websearch-multi-cost")).toHaveText(
    "검색 한 번에 최대 약 $0.007 (1,000번이면 약 $7) · ChatGPT 구독 사용량도 조금 써요",
  )
  // Chosen with own's default selection (nothing stored, SK-5): 지금 쓰는 서비스 names the keyed Exa and its price too.
  await rpc(request, "websearch.set", { choice: { type: "multi" } })
  await expect.poll(() => loaded(request)).toEqual({ provider: "own-multi" })
  expect(await rpc(request, "websearch.get", {})).toMatchObject({ multi: { custom: false } })
  await page.goto("/settings/websearch")
  const facts = page.getByTestId("websearch-now").getByTestId("websearch-now-facts")
  await expect(facts).toContainText("Exa (내 키)")
  await expect(facts).toContainText("검색 한 번에 최대 약 $0.007 (1,000번이면 약 $7) · ChatGPT 구독 사용량도 조금 써요")
  await page.getByTestId("settings-websearch-mode-single").click()

  // Removing the key takes `Exa (내 키)` away; the free Exa stays, with the key entry back under it.
  await page.getByTestId("settings-websearch-exa-key").getByRole("button", { name: "지우기" }).click()
  await page.getByTestId("settings-websearch-exa-key-remove").click()
  await expect(keyed).toHaveCount(0)
  await expect(exa).toBeVisible()
  await expect(page.getByTestId("settings-websearch-exa-key-state")).toContainText("없음")
  await rpc(request, "websearch.set", { choice: { type: "default" } })
  await expect.poll(() => loaded(request)).toBeUndefined()
})

test("여러 서비스 함께: the mode, the checkboxes and the cost line; a search names the services that found it", async ({
  page,
  request,
}) => {
  await page.goto("/settings/websearch")
  await expect(page.getByTestId("settings-websearch-mode-single")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("settings-websearch-mode-multi").click()
  await expect(page.getByTestId("settings-websearch-mode-multi")).toHaveAttribute("aria-checked", "true")
  // Own's default: ChatGPT and the keyless services checked; paid DeepSeek and a plugin's service not.
  const box = (id: string) => page.getByTestId(`settings-websearch-multi-${id}`)
  for (const id of ["own-chatgpt", "exa", "firecrawl", "parallel", "tavily", "tinyfish"])
    await expect(box(id)).toHaveAttribute("aria-checked", "true")
  for (const id of ["own-deepseek", "fake-search"]) await expect(box(id)).toHaveAttribute("aria-checked", "false")
  const cost = page.getByTestId("websearch-multi-cost")
  await expect(cost).toHaveText("검색 한 번에 드는 돈: 없음 · ChatGPT 구독 사용량도 조금 써요")
  await box("own-deepseek").click()
  await expect(cost).toHaveText(
    "검색 한 번에 최대 약 $0.00075 (1,000번이면 약 $0.75) · ChatGPT 구독 사용량도 조금 써요",
  )
  await box("own-deepseek").click()
  await page.getByTestId("settings-content").evaluate((element) => (element.scrollTop = 0))
  await shot(page, "5-multi-mode")
  // Only services that answer without the network here: ChatGPT (the fake Codex), the Parallel stand-in, Fake Search.
  for (const id of ["exa", "firecrawl", "tavily", "tinyfish", "fake-search"]) await box(id).click()
  await page.getByTestId("settings-websearch-save").click()
  await expect(
    page.getByText("웹 검색을 여러 서비스 함께 쓰기로 바꿨어요: ChatGPT, Fake Search, Parallel"),
  ).toBeVisible()
  const now = page.getByTestId("websearch-now")
  await expect(now.getByTestId("websearch-now-name")).toHaveText("여러 서비스 함께")
  await expect(now.getByTestId("websearch-now-source")).toHaveText("직접 고름")
  await expect(now.getByTestId("websearch-now-facts")).toContainText("ChatGPT, Fake Search, Parallel에 함께 물어요")
  expect(await rpc(request, "websearch.get", {})).toMatchObject({
    choice: { type: "multi" },
    multi: { services: ["own-chatgpt", "fake-search", "parallel"], custom: true },
  })
  await expect.poll(() => loaded(request)).toEqual({ provider: "own-multi" })

  // A search asks all three; the card names those that found results and the line counts them.
  await send(page, "[websearch] multi service query")
  await expect.poll(async () => (await searches(request)).at(-1)).toBe("own-multi")
  const card = lastSearch(page)
  await expect(card).toContainText("여러 서비스로 검색 · ")
  for (const name of ["ChatGPT", "Fake Search", "Parallel"]) await expect(card).toContainText(name)
  await expect(card.getByTestId("websearch-found")).toContainText("결과를 찾은 서비스: ")
  await expect(card.getByTestId("websearch-found")).toContainText("Parallel 1")
  await expect(card.getByTestId("websearch-change")).toBeVisible()
  await shot(page, "6-multi-card")

  // Back to one service keeps the checked ones for next time.
  await page.goto("/settings/websearch")
  await page.getByTestId("settings-websearch-mode-single").click()
  await page.getByTestId("settings-websearch-service:own-chatgpt").click()
  await page.getByTestId("settings-websearch-save").click()
  await expect(page.getByTestId("websearch-now-name")).toHaveText("ChatGPT")
  await page.getByTestId("settings-websearch-mode-multi").click()
  await expect(box("fake-search")).toHaveAttribute("aria-checked", "true")
  await expect(box("exa")).toHaveAttribute("aria-checked", "false")
  await rpc(request, "websearch.set", { choice: { type: "default" } })
  await expect.poll(() => loaded(request)).toBeUndefined()
})

test("승인·권한 and the palette lead to the page; a phone-wide window fits it", async ({ page, request }) => {
  await expect.poll(() => loaded(request)).toBeUndefined()
  await page.goto("/settings/approval")
  const link = page.getByTestId("settings-websearch-link")
  await expect(link).toContainText("검색 서비스 고르기는 웹 검색 페이지에 있어요.")
  await expect(link.getByTestId("settings-websearch-link-now")).toHaveText("지금 쓰는 서비스: ChatGPT")
  await link.getByTestId("settings-websearch-open").click()
  await expect(page).toHaveURL(/\/settings\/websearch$/)

  await page.goto(`/srv/local/s/${state.session.id}`)
  await page.locator("#own-composer-input").waitFor()
  await page.keyboard.press("Control+KeyK")
  // The palette is a lazy chunk: type once its input has the focus (as e2e/shell.spec.ts does).
  await expect(page.getByTestId("palette-input")).toBeFocused()
  await page.keyboard.type("웹 검색 서비스 바꾸기")
  await expect(page.getByRole("option", { name: /웹 검색 서비스 바꾸기/ }).first()).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/settings\/websearch$/)

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto("/settings/websearch")
  await expect(page.getByTestId("websearch-now-name")).toHaveText("ChatGPT")
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await shot(page, "4-narrow")
})
