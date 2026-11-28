// 별칭 (owner alias) and 팀 룸 (06 §2.7, §9.9, 2026-11-27) in the whole own-web app in Edge against backend.ts. Its
// `lounge` project gets three areas, `화면` ui, `서버` api and `문서` docs, each with an owner conversation.
//   - 별칭 바꾸기… in the area menu writes the alias on the owner seat (a name the team already uses is refused in
//     the form); the sidebar row shows `민지 · 화면 · 담당`, the owner's pill `영역: 민지 · 화면 · 담당`;
//   - the team main's work panel has a 팀 룸 tab (a conversation outside the team has none): one character per area
//     at a desk, labelled with the alias and the area name, the busy owner typing; a click on a label or a character
//     opens that owner conversation;
//   - the scene draws only while the tab shows and the window has focus; reduced motion draws one still frame;
//   - without WebGL the same labels show as a list; a 390 px phone and a narrow panel fit without a side scroll;
//   - the room fills its canvas: what is drawn (floor, seats, labels) spans most of the limiting side, wide, narrow and
//     on the phone, and no label or badge leaves the canvas (./src/team/room/fit.ts frames it).
// Screenshots of the room (wide, narrow and its panel, phone, the list) go to own/.out/room (`OWN_WEB_ROOM_SHOTS` overrides). No
// placeholder or page error anywhere. Runs after the T1 and T2 specs (playwright.config.ts); without this suite's
// backend it skips.
import fs from "node:fs"
import path from "node:path"
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test"
import { enableTeam } from "./flows"

interface RoomState {
  readonly control: string
  readonly t3: {
    readonly room: {
      readonly home: string
      readonly seed: string
      readonly areas: ReadonlyArray<{ readonly slug: string; readonly name: string }>
    }
  }
}

interface AreaInfo {
  readonly id: string
  readonly name: string
  readonly owner: { readonly sessionID: string | null; readonly alias?: string }
}

const TMP = process.env.OWN_WEB_TEAM_E2E_TMP
const state = () => JSON.parse(fs.readFileSync(path.join(TMP!, "backend.json"), "utf8")) as RoomState
const lounge = () => state().t3.room
const SHOTS = process.env.OWN_WEB_ROOM_SHOTS ?? path.resolve(process.cwd(), "..", "..", "own", ".out", "room")
const ALIAS = "민지"
const PLACEHOLDER = /\{\w+\}/

test.describe.configure({ mode: "serial" })

test.describe("별칭 and 팀 룸 (06 §2.7, §9.9, 2026-11-27)", () => {
  test.skip(!TMP, "needs e2e/team/backend.ts: bun run test:e2e:team")

  let context: BrowserContext
  let page: Page
  const errors: string[] = []
  const ids = { team: "", main: "", owners: {} as Record<string, string> }

  test.beforeAll(async ({ browser }) => {
    fs.mkdirSync(SHOTS, { recursive: true })
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "ko-KR" })
    page = await context.newPage()
    page.on("pageerror", (error) => errors.push(error.message))
  })

  test.afterAll(async () => {
    if (page) await off(page, lounge().home)
    await context?.close()
    expect(errors).toEqual([])
  })

  test("팀 모드 켜기 on lounge: three areas with their owners", async () => {
    await open(page, lounge().seed)
    // A conversation outside a team has no 팀 룸 tab.
    await panel(page)
    await expect(page.locator("#own-tab-team")).toHaveCount(0)
    await page.getByTestId("session-menu").first().click()
    await page.getByTestId("session-menu-team-enable").click()
    await enableTeam(page)
    ids.team = await teamOf(page, lounge().home)
    await expect.poll(async () => ((await view(page)).team as { readonly main?: unknown } | null)?.main).toBeTruthy()
    ids.main = ((await view(page)).team as { readonly main: { readonly sessionID: string } }).main.sessionID
    await expect.poll(() => current(page), { timeout: 120_000 }).toBe(ids.main)
    await expect(page.getByTestId("area-row")).toHaveCount(3, { timeout: 120_000 })
    await settled(page)
    await expect
      .poll(async () => (await areas(page)).filter((item) => item.owner.sessionID).length, { timeout: 120_000 })
      .toBe(3)
    for (const item of await areas(page)) ids.owners[item.name] = item.owner.sessionID!
    // A backend kept for another run (`OWN_WEB_TEAM_E2E_REUSE`) gives the areas back with their alias.
    for (const item of await areas(page))
      if (item.owner.alias) await rpc(page, "own.team", "area.edit", { teamID: ids.team, areaID: item.id, alias: "" })
  })

  test("별칭 바꾸기… writes the alias; a taken name is refused in the form; the row and the owner's pill show it", async () => {
    await open(page, ids.main)
    await row(page, "화면").click({ button: "right" })
    const menu = page.getByTestId("area-menu")
    await expect(menu.getByTestId("area-menu-alias-now")).toHaveText("팀 메인과 화면에서 부를 짧은 이름")
    await menu.getByTestId("area-menu-alias").click()
    const form = page.getByTestId("area-alias")
    await form.getByTestId("area-alias-text").fill("서버")
    await expect(form.getByTestId("area-alias-left")).toHaveText("팀의 다른 영역이나 동료가 이미 쓰는 이름이에요")
    await expect(form.getByTestId("area-alias-save")).toBeDisabled()
    await form.getByTestId("area-alias-text").fill(`  ${ALIAS} `)
    await expect(form.getByTestId("area-alias-left")).toHaveText("10자 남음")
    await form.getByTestId("area-alias-save").click()
    await expect(page.getByTestId("toasts")).toContainText(`'화면' 영역의 별칭을 '${ALIAS}'로 바꿨어요`)
    await expect.poll(async () => (await areas(page)).find((item) => item.name === "화면")?.owner.alias).toBe(ALIAS)
    await expect(row(page, "화면").getByTestId("area-alias")).toHaveText(`${ALIAS} · `)
    await expect(row(page, "서버").getByTestId("area-alias")).toHaveCount(0)
    await open(page, ids.owners["화면"]!)
    await expect(page.getByTestId("team-pill")).toHaveAttribute("aria-label", `영역: ${ALIAS} · 화면 · 담당`)
  })

  test("팀 룸 on the team main: a character per area with its label; the busy owner types; a label opens its owner", async () => {
    await open(page, ids.main)
    await send(page, "[dispatch ui [slow 90000] 화면 손보기]")
    await expect.poll(() => working(page), { timeout: 90_000 }).toContain(ids.owners["화면"])
    // 메인 멈춤 on 문서: its owner dozes.
    const docs = (await areas(page)).find((item) => item.name === "문서")!
    await rpc(page, "own.team", "area.pause", { teamID: ids.team, areaID: docs.id, on: true })
    await panel(page)
    await page.locator("#own-tab-team").click()
    const room = page.getByTestId("team-room")
    await expect(room).toHaveAttribute("data-mode", "3d")
    await expect(room).toHaveAttribute("data-characters", "3", { timeout: 30_000 })
    await expect(room).toHaveAttribute("data-run", "running")
    const seats = room.getByTestId("team-room-seat")
    await expect(seats).toHaveCount(3)
    const ui = seats.filter({ has: page.getByTestId("team-room-alias") })
    await expect(ui.getByTestId("team-room-alias")).toHaveText(ALIAS)
    await expect(ui.getByTestId("team-room-name")).toHaveText("화면")
    await expect(ui).toHaveAttribute("data-state", "working", { timeout: 30_000 })
    // The registry's order (area ids).
    await expect(seats.getByTestId("team-room-name")).toHaveText(["서버", "문서", "화면"])
    const dozing = seats.filter({ hasText: "문서" })
    await expect(dozing).toHaveAttribute("data-state", "sleeping")
    await expect(dozing.getByTestId("team-room-mark")).toHaveText("z")
    await frames(room, true)
    await fills(page)
    await placed(page)
    await page.screenshot({ path: path.join(SHOTS, "room-wide.png") })
    await room.screenshot({ path: path.join(SHOTS, "room-wide-panel.png") })
    await rpc(page, "own.team", "area.pause", { teamID: ids.team, areaID: docs.id, on: false })
    await expect(dozing).toHaveAttribute("data-state", "idle")
    await seats.filter({ hasText: "서버" }).click()
    await expect.poll(() => current(page)).toBe(ids.owners["서버"])
  })

  test("a click on the character opens its owner conversation", async () => {
    await open(page, ids.main)
    await panel(page)
    await page.locator("#own-tab-team").click()
    const room = page.getByTestId("team-room")
    await expect(room).toHaveAttribute("data-characters", "3", { timeout: 30_000 })
    const label = (await room.getByTestId("team-room-seat").filter({ hasText: "문서" }).boundingBox())!
    // The character's head is under its label.
    await page.mouse.click(label.x + label.width / 2, label.y + label.height + 40)
    await expect.poll(() => current(page)).toBe(ids.owners["문서"])
  })

  test("the scene stops while another tab shows or the window has no focus, and runs again after", async () => {
    await open(page, ids.main)
    await panel(page)
    await page.locator("#own-tab-team").click()
    const room = page.getByTestId("team-room")
    await expect(room).toHaveAttribute("data-run", "running", { timeout: 30_000 })
    await frames(room, true)
    await page.locator("#own-tab-accounts").click()
    await expect(room).toHaveAttribute("data-run", "paused")
    await frames(room, false)
    await page.locator("#own-tab-team").click()
    await expect(room).toHaveAttribute("data-run", "running")
    await frames(room, true)
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    await expect(room).toHaveAttribute("data-run", "paused")
    await frames(room, false)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(room).toHaveAttribute("data-run", "running")
    await frames(room, true)
  })

  test("a narrow window: the room and its labels fit the panel", async () => {
    await page.setViewportSize({ width: 1024, height: 760 })
    try {
      await open(page, ids.main)
      await panel(page)
      await page.locator("#own-tab-team").click()
      const room = page.getByTestId("team-room")
      await expect(room).toHaveAttribute("data-characters", "3", { timeout: 30_000 })
      await fills(page)
      await placed(page)
      await noSideScroll(page)
      await room.screenshot({ path: path.join(SHOTS, "room-narrow-panel.png") })
      await page.screenshot({ path: path.join(SHOTS, "room-narrow.png") })
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 })
    }
  })

  test("a 390 px phone: the room fits; labels are inside the screen", async ({ browser }) => {
    await another(browser, {}, async (device) => {
      await open(device, ids.main)
      await device.getByTestId("panel-toggle").click()
      await device.locator("#own-tab-team").click()
      const room = device.getByTestId("team-room")
      await expect(room).toHaveAttribute("data-characters", "3", { timeout: 30_000 })
      await fills(device)
      await placed(device)
      for (const box of await boxes(device)) {
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(390)
      }
      await noSideScroll(device)
      await device.screenshot({ path: path.join(SHOTS, "room-phone.png") })
    })
  })

  test("reduced motion: one still frame per change, no loop", async ({ browser }) => {
    await another(browser, { reducedMotion: "reduce", viewport: { width: 1440, height: 900 } }, async (still) => {
      await open(still, ids.main)
      await panel(still)
      await still.locator("#own-tab-team").click()
      const room = still.getByTestId("team-room")
      await expect(room).toHaveAttribute("data-run", "still", { timeout: 30_000 })
      await expect(room).toHaveAttribute("data-characters", "3")
      await frames(room, false)
    })
  })

  test("without WebGL the same labels show as a list, and a row opens its owner", async ({ browser }) => {
    await another(browser, { viewport: { width: 1440, height: 900 }, init: "no-webgl" }, async (flat) => {
      await open(flat, ids.main)
      await panel(flat)
      await flat.locator("#own-tab-team").click()
      const room = flat.getByTestId("team-room")
      await expect(room).toHaveAttribute("data-mode", "flat", { timeout: 30_000 })
      const list = room.getByTestId("team-room-list")
      await expect(list.getByTestId("team-room-seat")).toHaveCount(3)
      await expect(list.getByTestId("team-room-seat").last()).toContainText(`${ALIAS} · 화면`)
      await expect(room).not.toContainText(PLACEHOLDER)
      await room.screenshot({ path: path.join(SHOTS, "room-list.png") })
      await list.getByTestId("team-room-seat").filter({ hasText: "문서" }).click()
      await expect.poll(() => current(flat)).toBe(ids.owners["문서"])
    })
  })
})

async function open(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
  await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)).toBeVisible({
    timeout: 60_000,
  })
}

/** Opens the work panel when it is closed. */
async function panel(page: Page) {
  const app = page.getByTestId("app")
  if ((await app.getAttribute("data-panel")) !== "open") await page.getByTestId("panel-toggle").click()
  await expect(app).toHaveAttribute("data-panel", "open")
}

function current(page: Page) {
  return new URL(page.url()).pathname.split("/").at(-1)!
}

function row(page: Page, name: string) {
  return page.getByTestId("area-row").filter({
    has: page.getByTestId("area-label").filter({ hasText: new RegExp(`^${name} · `) }),
  })
}

/** The frame counter moves (`true`) or holds (`false`) over 700 ms. */
async function frames(room: Locator, moving: boolean) {
  const before = Number(await room.getAttribute("data-frames"))
  await room.page().waitForTimeout(700)
  const after = Number(await room.getAttribute("data-frames"))
  if (moving) expect(after).toBeGreaterThan(before)
  if (!moving) expect(after).toBe(before)
}

/** Every label of the room and its badge are inside the canvas, and none holds a placeholder. */
async function placed(page: Page) {
  const room = (await page.getByTestId("team-room-canvas").boundingBox())!
  const marks = page.getByTestId("team-room-mark")
  // A badge can go between the count and its box (an owner's status moved on: `?` answered, `!` cleared); a badge
  // that is no longer drawn has no box to check (RL34-T, the release tier's load).
  const badges = await Promise.all(
    Array.from({ length: await marks.count() }, (_, index) => marks.nth(index).boundingBox()),
  )
  for (const box of [...(await boxes(page)), ...badges.filter((item) => item !== null)]) {
    expect(box.x).toBeGreaterThanOrEqual(room.x - 1)
    expect(box.x + box.width).toBeLessThanOrEqual(room.x + room.width + 1)
    expect(box.y).toBeGreaterThanOrEqual(room.y - 1)
    expect(box.y + box.height).toBeLessThanOrEqual(room.y + room.height + 1)
  }
  for (const text of await page.getByTestId("team-room-seat").allInnerTexts()) expect(text).not.toMatch(PLACEHOLDER)
}

/**
 * What the room draws fills its canvas: the box of every pixel that differs from the canvas's corner (the floor, the
 * seats and the labels over them) spans at least 80 % of the limiting side and at most the 88 % the framing aims for,
 * with a little slack for antialiasing. Measured from a screenshot of the canvas's area, decoded in the page.
 */
async function fills(page: Page) {
  const canvas = page.getByTestId("team-room-canvas")
  const measure = async () => {
    const shot = (await canvas.screenshot()).toString("base64")
    return page.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
      const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
      const surface = new OffscreenCanvas(image.width, image.height)
      const context = surface.getContext("2d")!
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, image.width, image.height).data
      const box = { left: image.width, right: -1, top: image.height, bottom: -1 }
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const at = (y * image.width + x) * 4
          const diff =
            Math.abs(pixels[at]! - pixels[0]!) +
            Math.abs(pixels[at + 1]! - pixels[1]!) +
            Math.abs(pixels[at + 2]! - pixels[2]!)
          if (diff <= 40) continue
          box.left = Math.min(box.left, x)
          box.right = Math.max(box.right, x)
          box.top = Math.min(box.top, y)
          box.bottom = Math.max(box.bottom, y)
        }
      const width = (box.right - box.left + 1) / image.width
      const height = (box.bottom - box.top + 1) / image.height
      return { width, height, fill: Math.max(width, height) }
    }, shot)
  }
  await expect.poll(async () => (await measure()).fill, { timeout: 15_000 }).toBeGreaterThanOrEqual(0.8)
  const drawn = await measure()
  expect(drawn.fill).toBeLessThanOrEqual(0.92)
  return drawn
}

async function boxes(page: Page) {
  const seats = page.getByTestId("team-room-seat")
  const count = await seats.count()
  return Promise.all(Array.from({ length: count }, async (_, index) => (await seats.nth(index).boundingBox())!))
}

async function noSideScroll(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0)
}

/**
 * Another window on the PC page: a 390 px touch phone by default; `reducedMotion` and `viewport` change it, `no-webgl`
 * makes every WebGL context fail as on a device without it.
 */
async function another(
  browser: Browser,
  options: {
    readonly reducedMotion?: "reduce"
    readonly viewport?: { readonly width: number; readonly height: number }
    readonly init?: "no-webgl"
  },
  run: (page: Page) => Promise<void>,
) {
  const mobile = options.viewport === undefined
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 390, height: 844 },
    ...(mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
    locale: "ko-KR",
  })
  if (options.init === "no-webgl")
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null
        // SAFETY (test): the original takes the same arguments.
        return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest)
      } as typeof original
    })
  const other = await context.newPage()
  const failures: string[] = []
  other.on("pageerror", (error) => failures.push(error.message))
  try {
    await run(other)
    expect(failures).toEqual([])
  } finally {
    await context.close()
  }
}

/** The conversations that run now. */
async function working(page: Page) {
  const body = (await (await page.request.get("/api/session/active")).json()) as { readonly data?: object }
  return Object.keys(body.data ?? {})
}

/** Types into the real composer and sends; waits until the service took the message. */
async function send(page: Page, text: string) {
  const box = page.locator("#own-composer-input")
  await box.click()
  await box.fill(text)
  const prompted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && /\/api\/session\/[^/]+\/prompt$/.test(new URL(response.url()).pathname),
    { timeout: 90_000 },
  )
  await box.press("Control+Enter")
  expect((await prompted).ok()).toBe(true)
  await expect(box).toHaveValue("")
}

async function rpc(page: Page, id: string, method: string, input: unknown) {
  const response = await page.request.post(
    `/api/rpc/${id}/${method}?location%5Bdirectory%5D=${encodeURIComponent(state().control)}`,
    { data: { input } },
  )
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok()) throw new Error(`${id} ${method}: ${response.status()} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

function view(page: Page) {
  return rpc(page, "own.team", "team.get", { directory: lounge().home })
}

async function areas(page: Page) {
  return (await view(page)).areas as ReadonlyArray<AreaInfo>
}

async function settled(page: Page) {
  await expect.poll(async () => (await view(page)).op ?? null, { timeout: 120_000 }).toBeNull()
}

async function teamsOn(page: Page, home: string) {
  const output = await rpc(page, "own.team", "team.list", {})
  return (output.teams as ReadonlyArray<{ readonly id: string; readonly state: string; readonly home: string }>)
    .filter((item) => item.state === "on" && same(item.home, home))
    .map((item) => item.id)
}

async function teamOf(page: Page, home: string) {
  await expect.poll(async () => (await teamsOn(page, home)).length, { timeout: 60_000 }).toBe(1)
  return (await teamsOn(page, home))[0]!
}

/** Turns off every team still on in `home`'s project, answering a waiting confirm 두기 first. */
async function off(page: Page, home: string) {
  const pending = await rpc(page, "own.team", "team.get", { directory: home }).then(
    (output) => (output.pending ?? []) as ReadonlyArray<Readonly<Record<string, string>>>,
    () => [],
  )
  for (const confirm of pending)
    await rpc(page, "own.team", "op.confirm", {
      opID: confirm.opID,
      stepID: confirm.stepID,
      choice: "skip",
      nonce: confirm.nonce,
    }).catch(() => undefined)
  for (const teamID of await teamsOn(page, home).catch(() => [])) {
    await expect
      .poll(async () => (await rpc(page, "own.team", "team.get", { directory: home })).op ?? null, { timeout: 60_000 })
      .toBeNull()
      .catch(() => undefined)
    await rpc(page, "own.team", "disable", { teamID }).catch(() => undefined)
  }
  await expect.poll(async () => (await teamsOn(page, home)).length, { timeout: 60_000 }).toBe(0)
}

function same(a: string, b: string) {
  const normal = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
  return normal(a) === normal(b)
}
