// A remote host's team mode and presets (06 §4.13, §9.2; 07 §8.1 원격; TG17's and 07 PG2's screens) in the whole
// own-web app in Edge against backend.ts. The page's own.remote calls go to the backend's fake own.remote, which lists
// two fake SSH hosts whose `/srv/<host>/api` is this one server (backend.ts header): `h-e2ehost`, a current host, and
// `h-e2eold`, an older one. One PC window:
//   - a remote conversation's composer lists the host's own presets (its mirror of this PC's) and applies one there,
//     never writing presets to the host; the older host lists `평소대로` only, with the neutral line;
//   - 팀 모드 켜기 on a host that answers `lfs_missing`: exactly one upload of the large-file tool through this PC's
//     own.remote (`hosts.tools.ensure`), then enable once more and on to the team main; a failed upload says why and
//     never tries again;
//   - no forbidden word, placeholder or page error anywhere these screens showed.
// Runs after the T1 and T2 specs (playwright.config.ts); without this suite's backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { enableTeam } from "./flows"

interface RemoteState {
  readonly dev: string
  readonly device: string
  readonly control: string
  readonly presets: { readonly deepseek: string }
  readonly t3: {
    readonly remote: {
      readonly home: string
      readonly seed: string
      readonly presets: string
      readonly hosts: Readonly<Record<string, string>>
    }
  }
}

interface Calls {
  readonly ensure: readonly string[]
  readonly hosts: readonly string[]
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as RemoteState
const relay = () => state().t3.remote
/** The current host (mirrored presets, the upload works) and the older one (no mirror, the upload fails). */
const HOST = "h-e2ehost"
const OLD = "h-e2eold"

/** 06 §9.1, word for word (team.spec.ts checks T1's screens the same way). */
const FORBIDDEN = [
  "worktree",
  "branch",
  "브랜치",
  "commit",
  "커밋",
  "merge",
  "머지",
  "rebase",
  "stash",
  "sparse",
  "LFS",
  "HEAD",
  "checkout",
  "push",
  "PR",
  "캐시",
  "환경 변수",
  "의존성",
  "보류",
]
const ALSO = ["홈 폴더", "이 PC", "this PC"]
const PLACEHOLDER = /\{\w+\}/

/** Upper-case ASCII words match as whole words with their case; other ASCII words anywhere, any case. */
function hits(text: string, word: string) {
  if (/^[A-Z]+$/.test(word)) return new RegExp(`\\b${word}\\b`).test(text)
  if (/^[a-z ]+$/.test(word)) return text.toLowerCase().includes(word)
  return text.includes(word)
}

/** Every text these screens showed, checked as it is read and once more at the end. */
const seen: string[] = []

/** The area folders inside the main folder (06 §4.12 프로젝트 안) are data: `.worktrees\<slug>`. */
const FOLDERS = /\.worktrees(?=[\\/])/g

async function words(locator: Locator) {
  const texts = (await locator.allInnerTexts()).map((text) => text.replace(FOLDERS, ""))
  for (const text of texts) {
    seen.push(text)
    expect(
      FORBIDDEN.concat(ALSO).filter((word) => hits(text, word)),
      text,
    ).toEqual([])
    expect(text, text).not.toMatch(PLACEHOLDER)
  }
  return texts.join("\n")
}

test.describe.configure({ mode: "serial" })

test.describe("원격 호스트의 큰 파일 도구와 미러 프리셋 (06 §4.13, 07 §8.1 원격, TG20)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    // This window's own.remote is the backend's fake (its hosts), for this spec only.
    await context.route(`${state().dev}/api/rpc/own.remote/**`, async (route) => {
      const request = route.request()
      const method = new URL(request.url()).pathname.split("/").at(-1) ?? ""
      const response = await route.fetch({
        url: `${state().device}/own-e2e/remote/${method}`,
        method: request.method(),
        headers: request.headers(),
        postData: request.postDataBuffer() ?? undefined,
      })
      await route.fulfill({ response })
    })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    // A failed run leaves no team on for the next spec (the hosts are this server).
    if (page) await off(page, relay().home)
    await context?.close()
  })

  test("a remote composer lists the host's mirror of this PC's presets and applies one there (07 §8.1 원격)", async () => {
    await openOn(page, HOST, relay().presets)
    const button = page.getByTestId("composer-preset")
    await expect(button).toBeEnabled({ timeout: 60_000 })
    await button.click()
    const menu = page.getByTestId("preset-menu")
    const item = menu.getByTestId("preset-menu-item").filter({ hasText: "DeepSeek 기본" })
    await expect(item).toBeVisible({ timeout: 30_000 })
    await expect(menu.getByTestId("preset-menu-note")).not.toContainText("평소대로만")
    // A remote service has no repairs; editing opens this PC's editor.
    await expect(menu.getByTestId("preset-menu-repair")).toHaveCount(0)
    await expect(menu.getByTestId("preset-menu-edit")).toBeVisible()
    await words(menu)
    await item.click()
    await expect(button).toContainText("DeepSeek 기본", { timeout: 30_000 })
    await words(button)
    const sent = await calls(page)
    expect(sent.hosts).toContain(`${HOST} own.accounts/presets.list`)
    expect(sent.hosts).toContain(`${HOST} own.accounts/session.preset.apply`)
    // Presets are written on this PC only (a remote service answers `remote_managed`).
    expect(sent.hosts.filter((call) => /own\.accounts\/presets\.(set|remove|defaults\.set)$/.test(call))).toEqual([])
    const binding = await rpc(page, "own.accounts", "session.preset.get", { sessionID: relay().presets }, relay().home)
    expect((binding.binding as { readonly presetID: string }).presetID).toBe(state().presets.deepseek)
  })

  test("an older host without the mirror lists 평소대로 only, with the neutral line", async () => {
    await openOn(page, OLD, relay().presets)
    const button = page.getByTestId("composer-preset")
    await expect(button).toBeEnabled({ timeout: 60_000 })
    await button.click()
    const menu = page.getByTestId("preset-menu")
    await expect(menu.getByTestId("preset-menu-note")).toHaveText(
      "이 원격 서버에는 아직 프리셋이 없어 평소대로만 써요",
      { timeout: 30_000 },
    )
    await expect(menu.getByTestId("preset-menu-item")).toHaveCount(1)
    await expect(menu.getByTestId("preset-menu-item")).toContainText("평소대로")
    await expect(menu.getByTestId("preset-menu-new")).toHaveCount(0)
    await expect(menu.getByTestId("preset-menu-recent")).toHaveCount(0)
    await words(menu)
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
  })

  test("팀 모드 켜기 where the upload fails: one upload through this PC, the reason, no second enable", async () => {
    await openOn(page, OLD, relay().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page)
    const toasts = page.getByTestId("toasts")
    await expect(toasts).toContainText(
      "원격 호스트에 큰 파일 도구를 준비하지 못했어요: 준비한 도구 파일이 기록과 달라 올리지 않았어요",
      { timeout: 60_000 },
    )
    await words(toasts)
    const sent = await calls(page)
    expect(sent.ensure).toEqual([OLD])
    expect(sent.hosts.filter((call) => call === `${OLD} own.team/enable`)).toHaveLength(1)
    expect(await teamsOn(page, relay().home)).toEqual([])
    // Nothing moved: still the same conversation.
    expect(current(page)).toBe(relay().seed)
  })

  test("팀 모드 켜기 on a host without the large-file tool: one upload, enable again, the team main (06 §4.13)", async () => {
    await openOn(page, HOST, relay().seed)
    await menu(page, "session-menu", "session-menu-team-enable")
    await enableTeam(page)
    const toasts = page.getByTestId("toasts")
    await expect(toasts).toContainText("원격 호스트에 큰 파일 도구를 준비하는 중…", { timeout: 30_000 })
    await words(toasts)
    await expect.poll(() => current(page), { timeout: 120_000 }).not.toBe(relay().seed)
    expect(new URL(page.url()).pathname).toBe(`/srv/${HOST}/s/${current(page)}`)
    const card = page.locator('[data-testid="team-card"][data-kind="enable"]').first()
    await expect(card).toHaveAttribute("data-state", "done", { timeout: 120_000 })
    await expect(card.getByTestId("team-card-line").first()).toHaveText("메인에게 할 일을 말하면 영역을 나눠 맡겨요.")
    await words(card)
    expect(await teamsOn(page, relay().home)).toHaveLength(1)
    const sent = await calls(page)
    expect(sent.ensure).toEqual([OLD, HOST])
    expect(sent.hosts.filter((call) => call === `${HOST} own.team/enable`)).toHaveLength(2)
  })

  test("nothing showed a forbidden word or a placeholder; no page error", () => {
    expect(seen.length).toBeGreaterThan(5)
    const text = seen.join("\n")
    expect(FORBIDDEN.concat(ALSO).filter((word) => hits(text, word))).toEqual([])
    expect(text).not.toMatch(PLACEHOLDER)
    expect(errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------

/** A conversation through a fake host (`/srv/<host>/s/<id>`): the host's runtime attaches once own.remote resolved it. */
async function openOn(page: Page, host: string, sessionID: string) {
  await page.goto(`/srv/${host}/s/${sessionID}`)
  await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)).toBeVisible({
    timeout: 60_000,
  })
  await unfold(page)
}

/** With the sidebar and the work panel open the composer folds its tools behind ⋯ (03 §4.6): unfold them. */
async function unfold(page: Page) {
  await expect(page.getByTestId("composer-switcher")).toBeVisible({ timeout: 60_000 })
  const more = page.getByTestId("composer-more")
  if ((await more.isVisible()) && (await more.getAttribute("aria-expanded")) !== "true") await more.click()
}

/** The conversation on screen (`/srv/<server>/s/<id>`). */
function current(page: Page) {
  return new URL(page.url()).pathname.split("/").at(-1)!
}

/** Opens a `HostMenu` and picks an item. */
async function menu(page: Page, button: string, item: string) {
  await page.getByTestId(button).first().click()
  await page.getByTestId(item).click()
}

/** What reached the fake own.remote and the fake hosts (backend.ts `GET /own-e2e/calls`). */
async function calls(page: Page) {
  return (await (await page.request.get(`${state().device}/own-e2e/calls`)).json()) as Calls
}

/** An RPC through the page's API path (the dev proxy adds the server's auth), by default at the control location. */
async function rpc(page: Page, id: string, method: string, input: unknown, directory = state().control) {
  const response = await page.request.post(
    `/api/rpc/${id}/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    { data: { input } },
  )
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`${id} ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

/** The teams that are on in the project whose main folder is `home`. */
async function teamsOn(page: Page, home: string) {
  const output = await rpc(page, "own.team", "team.list", {})
  return (output.teams as ReadonlyArray<{ readonly id: string; readonly state: string; readonly home: string }>)
    .filter((item) => item.state === "on" && same(item.home, home))
    .map((item) => item.id)
}

/** Turns off every team still on in `home`'s project (a failed run's leftovers), keeping its folders. */
async function off(page: Page, home: string) {
  for (const teamID of await teamsOn(page, home).catch(() => []))
    await rpc(page, "own.team", "disable", { teamID }).catch(() => undefined)
  await expect.poll(async () => (await teamsOn(page, home)).length, { timeout: 60_000 }).toBe(0)
}

function same(a: string, b: string) {
  const normal = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return normal(a) === normal(b)
}
