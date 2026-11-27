// The sidebar's three zones and server sections (03 §4.3, 04 §17.2, 08 §4.1) on real servers: the bottom never moves,
// this PC, SSH hosts and other PCs lay out by the same rules, sections and projects move by mouse, touch and keyboard,
// projects pin, and what was arranged is there after a restart, per device (sections) or per service (projects). An
// older service keeps it in the browser. Serial: the tests share the two services' project lists.
import { expect, test, type Locator, type Page } from "@playwright/test"
import { centre, open, project, projects, resetLists, section, servers, shot, state, touch, url } from "./support"

test.describe.configure({ mode: "serial" })
test.beforeEach(({ page }) => resetLists(page))

const LOCAL = [
  "폴더 없는 대화",
  "own-open-code",
  "demo-game",
  "결제 웹훅",
  "notes-app",
  "긴 이름을 가진 프로젝트 폴더 아주 길게",
  "filler",
]
const HOST = ["test001", "example-game", "api-server"]

const toggle = (page: Page, key: string) => section(page, key).getByTestId("server-toggle")
const head = (page: Page, key: string) => section(page, key).locator('[data-reorder="server"]')
const top = async (target: Locator) => (await target.boundingBox())!.y
const announced = (page: Page) => page.getByTestId("sidebar-announce")

/** Drags with the mouse in steps, so the moves are seen; stops before letting go. */
async function drag(page: Page, from: Locator, to: () => Promise<{ readonly x: number; readonly y: number }>) {
  await from.scrollIntoViewIfNeeded()
  const start = await centre(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x, start.y + 8, { steps: 3 })
  // The list folded: the target is where it is now.
  const end = await to()
  await page.mouse.move(end.x, end.y, { steps: 8 })
}

/** Does it and waits until the service has the list (a reload right after would cut the request off). */
async function saved(page: Page, change: () => Promise<unknown>) {
  const answer = page.waitForResponse((response) => response.url().includes("/projectList.set") && response.ok())
  await change()
  await answer
}

const above = (target: Locator) => async () => {
  const box = (await target.boundingBox())!
  return { x: box.x + 40, y: box.y + 3 }
}
const below = (target: Locator) => async () => {
  const box = (await target.boundingBox())!
  return { x: box.x + 40, y: box.y + box.height - 3 }
}

test("the bottom never moves: all folded, a long list, an empty one", async ({ page }) => {
  await open(page)
  const fixed = [
    page.getByTestId("remote-add"),
    page.getByTestId("remote-pc-add"),
    page.getByTestId("sidebar-settings"),
  ]
  const places = () => Promise.all(fixed.map((target) => top(target)))
  const before = await places()
  const window = page.viewportSize()!.height
  expect(before[2]!).toBeGreaterThan(window - 60)

  await toggle(page, "local").click()
  expect(await places()).toEqual(before)
  await toggle(page, "h-ubuntu").click()
  expect(await places()).toEqual(before)
  await expect(page.getByTestId("session-row").first()).toBeHidden()
  // Folded, the sections are just their headers, one under the other.
  expect((await top(head(page, "h-ubuntu"))) - (await top(head(page, "local")))).toBe(
    (await head(page, "local").boundingBox())!.height,
  )
  await page.setViewportSize({ width: 1440, height: 560 })
  expect(await top(fixed[2]!)).toBeGreaterThan(560 - 60)
  await page.setViewportSize({ width: 1440, height: 900 })

  // A long list scrolls between the zones.
  await toggle(page, "local").click()
  const filler = project(page, "local", "filler")
  await filler.scrollIntoViewIfNeeded()
  await page.getByTestId("sidebar-scroll").evaluate((element) => element.scrollTo(0, element.scrollHeight))
  expect(await places()).toEqual(before)
  // Folding is remembered.
  await page.reload()
  await expect(page.getByTestId("sidebar-announce")).toBeAttached()
  await expect(toggle(page, "h-ubuntu")).toHaveAttribute("aria-expanded", "false")
  await expect(toggle(page, "local")).toHaveAttribute("aria-expanded", "true")
})

test("the top stays too, with search and 새 대화", async ({ page }) => {
  await open(page)
  const at = await top(page.getByTestId("sidebar-new-session"))
  await page.getByTestId("sidebar-scroll").evaluate((element) => element.scrollTo(0, 400))
  expect(await top(page.getByTestId("sidebar-new-session"))).toBe(at)
  // The header of the section being read stays over its list.
  const scroll = (await page.getByTestId("sidebar-scroll").boundingBox())!
  expect(await top(head(page, "local"))).toBe(scroll.y)
  // Folding it there keeps it there; the next section comes up under it.
  await toggle(page, "local").click()
  expect(await top(head(page, "local"))).toBe(scroll.y)
  expect(await top(head(page, "h-ubuntu"))).toBe(scroll.y + (await head(page, "local").boundingBox())!.height)
})

test("this PC, hosts and other PCs lay out by the same rules", async ({ page }) => {
  await open(page, "hosts=ubuntu,nas,work&pcs")
  expect(await servers(page)).toEqual(["local", "h-ubuntu", "h-nas", "h-work", "pc:home", "pc:office"])
  const inside = async (key: string, testid: string) => {
    const header = (await head(page, key).boundingBox())!
    const box = (await section(page, key).getByTestId(testid).first().boundingBox())!
    return { x: box.x, fromRight: header.x + header.width - box.x - box.width, under: box.y - header.y - header.height }
  }
  // 폴더 열기… is the first row of both, at the same place.
  expect(await inside("h-ubuntu", "host-open-folder-row")).toEqual(await inside("local", "sidebar-open-folder"))
  // …and what brings a host back is there while it is away.
  expect((await inside("h-nas", "host-fix")).x).toBe((await inside("local", "sidebar-open-folder")).x)
  await expect(section(page, "h-nas").getByTestId("host-fix")).toHaveText("다시 연결")
  await expect(section(page, "h-work").getByTestId("host-fix")).toHaveText("업데이트…")
  for (const [key, menu] of [
    ["local", "server-menu"],
    ["h-ubuntu", "host-menu"],
    ["h-nas", "host-menu"],
    ["pc:home", "remote-pc-menu"],
  ] as const)
    expect((await inside(key, menu)).fromRight).toBe((await inside("local", "server-menu")).fromRight)
  expect(await inside("h-ubuntu", "server-new-session")).toEqual(await inside("local", "server-new-session"))
  const projectX = async (key: string) => (await section(page, key).getByTestId("project-row").first().boundingBox())!.x
  expect(await projectX("h-ubuntu")).toBe(await projectX("local"))
  const heights = await Promise.all(
    ["local", "h-ubuntu", "h-nas", "pc:home"].map(async (key) => (await head(page, key).boundingBox())!.height),
  )
  expect(new Set(heights).size).toBe(1)
  // Words only while a server is not simply connected.
  await expect(section(page, "h-ubuntu").getByTestId("host-status")).toHaveCount(0)
  await expect(section(page, "h-nas").getByTestId("host-status")).toHaveText("연결 끊김")
  await expect(section(page, "pc:office").getByTestId("remote-pc-state")).toHaveText("연결할 수 없음")
  // A host's list takes its own height: the next header follows right after it.
  const nas = (await section(page, "h-nas").boundingBox())!
  expect((await head(page, "h-work").boundingBox())!.y).toBeCloseTo(nas.y + nas.height, 0)
  // Another PC opens its window.
  await section(page, "pc:home").getByTestId("remote-pc-open").click()
  expect(
    await page.evaluate(() => (window as unknown as { __sections: { opened: string[] } }).__sections.opened),
  ).toEqual(["home"])
})

test("one server: no header, 폴더 열기… first, the bottom in place", async ({ page }) => {
  await open(page, "remote=1")
  await expect(page.getByTestId("server-group-local")).toHaveCount(0)
  await expect(page.getByTestId("sidebar-open-folder")).toBeVisible()
  await expect(page.getByTestId("remote-pc-add")).toHaveCount(0)
  expect(await top(page.getByTestId("sidebar-settings"))).toBeGreaterThan(page.viewportSize()!.height - 60)
  await shot(page.getByTestId("sidebar"), "lone")
})

test("새 대화, + and Ctrl+O act on the server on screen", async ({ page }) => {
  await open(page)
  const route = () =>
    page.evaluate(() => {
      const value = (window as unknown as { __sections: { router: { route(): unknown } } }).__sections.router.route()
      return value as { name: string; serverKey?: string }
    })
  await section(page, "h-ubuntu").getByTestId("server-new-session").click()
  await expect.poll(route).toMatchObject({ name: "home", serverKey: "h-ubuntu" })
  await section(page, "local").getByTestId("server-new-session").click()
  await expect.poll(async () => (await route()).serverKey ?? "local").toBe("local")
  // A conversation of the host is open: Alt+N is the host's, and so are the folders.
  await section(page, "h-ubuntu").getByTestId("session-row").first().click()
  await expect.poll(route).toMatchObject({ name: "session", serverKey: "h-ubuntu" })
  await expect(section(page, "h-ubuntu").locator("kbd")).toHaveText("Ctrl+O")
  await expect(section(page, "local").getByTestId("sidebar-open-folder").locator("kbd")).toHaveCount(0)
  await page.keyboard.press("Control+o")
  await expect(page.getByTestId("remote-picker")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("remote-picker")).toHaveCount(0)
  await page.getByTestId("sidebar-new-session").focus()
  await page.keyboard.press("Alt+n")
  await expect.poll(route).toMatchObject({ name: "home", serverKey: "h-ubuntu" })
  // …and this PC's again from one of its conversations.
  await section(page, "local").getByTestId("session-row").first().click()
  await page.keyboard.press("Alt+n")
  await expect.poll(async () => (await route()).serverKey ?? "local").toBe("local")
})

test("the search finds conversations of every server, opens folded sections and says which have none", async ({
  page,
}) => {
  await open(page)
  await toggle(page, "h-ubuntu").click()
  await page.getByTestId("sidebar-search").fill("빌드 스크립트")
  await expect(section(page, "h-ubuntu").getByTestId("session-row")).toHaveCount(1)
  await expect(section(page, "local").getByTestId("sidebar-search-empty")).toBeVisible()
  await page.getByTestId("sidebar-search").press("Enter")
  await expect(section(page, "h-ubuntu").getByTestId("session-row").first()).toHaveAttribute("aria-current", "page")
  await page.getByTestId("sidebar-search").press("Escape")
  await expect(toggle(page, "h-ubuntu")).toHaveAttribute("aria-expanded", "false")
})

test("Alt+↑/↓ walks the sections as one list", async ({ page }) => {
  await open(page)
  await toggle(page, "local").click()
  await section(page, "h-ubuntu").getByTestId("session-row").first().click()
  await page.keyboard.press("Alt+ArrowDown")
  await expect(section(page, "h-ubuntu").getByTestId("session-row").nth(1)).toHaveAttribute("aria-current", "page")
})

test("sections move by mouse, stay after a reload, and reset", async ({ page }) => {
  await open(page)
  await drag(page, head(page, "h-ubuntu").locator(".font-semibold"), above(head(page, "local")))
  // Every section shows as its header, with a line where it lands.
  await expect(page.getByTestId("drag-line")).toBeVisible()
  await expect(section(page, "local").getByTestId("local-group")).toBeHidden()
  await shot(page.getByTestId("sidebar"), "drag-section")
  await page.mouse.up()
  expect(await servers(page)).toEqual(["h-ubuntu", "local", "pc:home", "pc:office"])
  await expect(announced(page)).toHaveText("build-host: 4개 중 1번째로 옮겼어요")
  // The drag did not fold anything.
  await expect(toggle(page, "h-ubuntu")).toHaveAttribute("aria-expanded", "true")
  await page.reload()
  await expect(page.getByTestId("sidebar-announce")).toBeAttached()
  await expect.poll(() => servers(page)).toEqual(["h-ubuntu", "local", "pc:home", "pc:office"])
  await section(page, "local").getByTestId("server-menu").click()
  await page.getByTestId("server-menu-reset").click()
  expect(await servers(page)).toEqual(["local", "h-ubuntu", "pc:home", "pc:office"])
})

test("a drag that Escape ends, or that goes nowhere, changes nothing", async ({ page }) => {
  await open(page)
  await drag(page, head(page, "h-ubuntu").locator(".font-semibold"), above(head(page, "local")))
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("drag-line")).toHaveCount(0)
  await page.mouse.up()
  expect(await servers(page)).toEqual(["local", "h-ubuntu", "pc:home", "pc:office"])
  await expect(announced(page)).toHaveText("옮기기를 취소했어요")
  // A press that hardly moves is a click.
  const at = await centre(toggle(page, "local"))
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 2, at.y + 2)
  await page.mouse.up()
  await expect(toggle(page, "local")).toHaveAttribute("aria-expanded", "false")
})

test("projects move by mouse within their server only; the service keeps the order", async ({ page, browser }) => {
  await open(page)
  expect(await projects(page, "local")).toEqual(LOCAL)
  await drag(
    page,
    project(page, "local", "notes-app").locator("span.truncate"),
    above(project(page, "local", "own-open-code")),
  )
  // Its server's projects fold to their headers; the other server does not.
  await expect(section(page, "local").getByTestId("session-row")).toHaveCount(0)
  expect(await section(page, "h-ubuntu").getByTestId("session-row").count()).toBeGreaterThan(0)
  await shot(page.getByTestId("sidebar"), "drag-project")
  await page.mouse.up()
  const moved = ["폴더 없는 대화", "notes-app", "own-open-code", "demo-game", "결제 웹훅", LOCAL[5]!, "filler"]
  expect(await projects(page, "local")).toEqual(moved)
  await expect(announced(page)).toContainText("7개 중 2번째로 옮겼어요")

  // Over another server it lands at the end of its own.
  await drag(
    page,
    project(page, "local", "own-open-code").locator("span.truncate"),
    below(project(page, "h-ubuntu", "test001")),
  )
  await page.mouse.up()
  expect((await projects(page, "local")).at(-1)).toBe("own-open-code")
  expect(await projects(page, "h-ubuntu")).toEqual(HOST)

  // Another browser of the same service (a phone) sees the same order, live.
  const phone = await browser.newContext({ locale: "ko-KR" })
  const other = await phone.newPage()
  await open(other)
  expect(await projects(other, "local")).toEqual(await projects(page, "local"))
  await project(page, "local", "filler").getByTestId("project-menu").click()
  await page.getByTestId("project-menu-up").click()
  await expect.poll(() => projects(other, "local")).toEqual(await projects(page, "local"))
  await phone.close()

  // 기본 순서로 되돌리기.
  await project(page, "local", "filler").getByTestId("project-menu").click()
  await page.getByTestId("project-menu-reset").click()
  expect(await projects(page, "local")).toEqual(LOCAL)
  await expect(project(page, "local", "filler")).toBeFocused()
})

test("projects and sections move by menu and by keys, and keep focus", async ({ page }) => {
  await open(page)
  await project(page, "h-ubuntu", "api-server").getByTestId("project-menu").click()
  await expect(page.getByTestId("project-menu-down")).toHaveCount(0)
  await page.getByTestId("project-menu-up").click()
  expect(await projects(page, "h-ubuntu")).toEqual(["test001", "api-server", "example-game"])
  await expect(project(page, "h-ubuntu", "api-server")).toBeFocused()
  await expect(announced(page)).toHaveText("api-server: 3개 중 2번째로 옮겼어요")
  await saved(page, () => page.keyboard.press("Control+Shift+ArrowUp"))
  expect(await projects(page, "h-ubuntu")).toEqual(["api-server", "test001", "example-game"])
  await expect(project(page, "h-ubuntu", "api-server")).toBeFocused()
  // At the end there is nowhere to go.
  await page.keyboard.press("Control+Shift+ArrowUp")
  expect(await projects(page, "h-ubuntu")).toEqual(["api-server", "test001", "example-game"])

  await toggle(page, "h-ubuntu").focus()
  await page.keyboard.press("Control+Shift+ArrowUp")
  expect(await servers(page)).toEqual(["h-ubuntu", "local", "pc:home", "pc:office"])
  await expect(toggle(page, "h-ubuntu")).toBeFocused()
  await section(page, "pc:home").getByTestId("remote-pc-menu").click()
  await page.getByTestId("server-menu-up").click()
  expect(await servers(page)).toEqual(["h-ubuntu", "pc:home", "local", "pc:office"])
  // The host's own service has its order: it is there after a reload.
  await page.reload()
  await expect.poll(() => projects(page, "h-ubuntu")).toEqual(["api-server", "test001", "example-game"])
})

test("pinned projects come first, in their own order; a drag stays among them", async ({ page }) => {
  await open(page)
  const pin = async (name: string) => {
    await project(page, "local", name).getByTestId("project-menu").click()
    await expect(page.getByTestId("project-menu-pin")).toHaveText("고정")
    await page.getByTestId("project-menu-pin").click()
  }
  await pin("결제 웹훅")
  await pin("notes-app")
  expect((await projects(page, "local")).slice(0, 3)).toEqual(["결제 웹훅", "notes-app", "폴더 없는 대화"])
  await expect(project(page, "local", "notes-app").getByTestId("project-pinned")).toBeVisible()
  await expect(announced(page)).toContainText("notes-app 고정됨")
  await shot(page.getByTestId("sidebar"), "pinned")
  // Below the others it still lands among the pinned ones.
  await drag(
    page,
    project(page, "local", "결제 웹훅").locator("span.truncate"),
    below(project(page, "local", "demo-game")),
  )
  await saved(page, () => page.mouse.up())
  expect((await projects(page, "local")).slice(0, 3)).toEqual(["notes-app", "결제 웹훅", "폴더 없는 대화"])
  await page.reload()
  await expect
    .poll(async () => (await projects(page, "local")).slice(0, 3))
    .toEqual(["notes-app", "결제 웹훅", "폴더 없는 대화"])
  await expect(page.getByTestId("sidebar-announce")).toBeAttached()
  await project(page, "local", "notes-app").getByTestId("project-menu").click()
  await expect(page.getByTestId("project-menu-pin")).toHaveText("고정 해제")
  await page.getByTestId("project-menu-pin").click()
  expect((await projects(page, "local"))[0]).toBe("결제 웹훅")
})

test("an older service: the order stays in this browser, and goes to the service once it can keep it", async ({
  page,
}) => {
  await page.request.get(`${state.front}/__e2e/old?on=1`)
  try {
    await open(page)
    await project(page, "h-ubuntu", "api-server").getByTestId("project-menu").click()
    await page.getByTestId("project-menu-up").click()
    expect(await projects(page, "h-ubuntu")).toEqual(["test001", "api-server", "example-game"])
    await page.reload()
    await expect.poll(() => projects(page, "h-ubuntu")).toEqual(["test001", "api-server", "example-game"])
    await expect(page.getByTestId("toast")).toHaveCount(0)
  } finally {
    await page.request.get(`${state.front}/__e2e/old?on=0`)
  }
  await page.reload()
  await expect.poll(() => projects(page, "h-ubuntu")).toEqual(["test001", "api-server", "example-game"])
  // The service has it now: a browser that never saw it lists it so.
  const fresh = await page.context().browser()!.newContext({ locale: "ko-KR" })
  const other = await fresh.newPage()
  await other.goto(url())
  await expect
    .poll(() => projects(other, "h-ubuntu"), { timeout: 60_000 })
    .toEqual(["test001", "api-server", "example-game"])
  await fresh.close()
})

test("a service that refuses keeps the list as it was and says so", async ({ page }) => {
  await open(page)
  await page.route("**/projectList.set*", (route) => route.fulfill({ status: 500, body: "{}" }))
  await project(page, "local", "demo-game").getByTestId("project-menu").click()
  await page.getByTestId("project-menu-up").click()
  await expect(page.getByTestId("toast")).toContainText("목록 순서를 저장하지 못했어요")
  await expect.poll(() => projects(page, "local")).toEqual(LOCAL)
})

test("a disconnected host's projects are not moved; its section is", async ({ page }) => {
  await open(page, "hosts=ubuntu,nas")
  await project(page, "h-nas", "photos").getByTestId("project-menu").click()
  await expect(page.getByTestId("project-menu-pin")).toHaveCount(0)
  await page.keyboard.press("Escape")
  await section(page, "h-nas").getByTestId("host-menu").click()
  await page.getByTestId("server-menu-up").click()
  expect(await servers(page)).toEqual(["local", "h-nas", "h-ubuntu"])
})

test("a right click on a header opens its menu", async ({ page }) => {
  await open(page)
  await project(page, "local", "notes-app").click({ button: "right" })
  await expect(page.getByTestId("project-menu-up")).toBeVisible()
  await page.keyboard.press("Escape")
  await toggle(page, "h-ubuntu").click({ button: "right" })
  await expect(page.getByTestId("host-open-folder")).toBeVisible()
})

test("hundreds of projects: the list is windowed, scrolls and drags without long stalls", async ({ page }) => {
  // 320 more projects with one conversation each, in the first page of the local list.
  await page.route(
    (target) => target.origin === state.dev && target.pathname === "/api/session",
    async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      const response = await route.fetch()
      const body = (await response.json()) as { data: Record<string, unknown>[]; cursor?: unknown }
      const sample = body.data[0]
      if (!sample || !new URL(route.request().url()).searchParams.get("limit")) return route.fulfill({ response })
      const more = Array.from({ length: 320 }, (_, at) => ({
        ...sample,
        id: `ses_many${String(at).padStart(20, "0")}`,
        title: `많은 프로젝트 ${at}`,
        projectID: `prj_many_${at}`,
        location: { directory: `D:\many\p${at}` },
        time: { created: 1, updated: 1_000_000 - at },
      }))
      await route.fulfill({ response, json: { ...body, data: [...body.data, ...more], cursor: {} } })
    },
  )
  await open(page, "hosts=ubuntu")
  const list = page.getByTestId("session-list")
  await expect(list).toHaveAttribute("data-virtual", "true")
  expect(await list.getByTestId("project-row").count()).toBeLessThan(80)
  await page.evaluate(() => {
    const tasks: number[] = []
    Object.assign(window, { __tasks: tasks })
    new PerformanceObserver((entries) => entries.getEntries().forEach((entry) => tasks.push(entry.duration))).observe({
      type: "longtask",
    })
  })
  const tasks = () =>
    page.evaluate(() => {
      const list = (window as unknown as { __tasks: number[] }).__tasks
      return list.splice(0).map(Math.round)
    })
  await page.getByTestId("sidebar-scroll").evaluate(async (element) => {
    for (let top = 0; top < element.scrollHeight; top += 300) {
      element.scrollTop = top
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    element.scrollTop = 0
  })
  const scrolling = await tasks()
  const row = project(page, "local", "demo-game")
  await drag(page, row.locator("span.truncate"), below(project(page, "local", "notes-app")))
  const lifting = await tasks()
  const at = (await page.getByTestId("sidebar-scroll").boundingBox())!
  for (let step = 0; step < 40; step++) await page.mouse.move(at.x + 60, at.y + 100 + (step % 20) * 20)
  const dragging = await tasks()
  await page.keyboard.press("Escape")
  await page.mouse.up()
  console.log(`hundreds of projects, long tasks: ${JSON.stringify({ scrolling, lifting, dragging })}`)
  expect(Math.max(0, ...scrolling)).toBeLessThan(150)
  // Folding 327 projects to their headers happens once, at the start.
  expect(Math.max(0, ...lifting)).toBeLessThan(600)
  expect(Math.max(0, ...dragging)).toBeLessThan(150)
})

test("English", async ({ page }) => {
  await open(page, "hosts=ubuntu,nas&pcs&en")
  await expect(page.getByTestId("remote-add").getByText("Add remote host")).toBeVisible()
  await expect(page.getByTestId("remote-pc-add").getByText("Add other PC")).toBeVisible()
  await project(page, "h-ubuntu", "api-server").getByTestId("project-menu").click()
  await expect(page.getByTestId("project-menu-up")).toHaveText("Move up")
  await page.getByTestId("project-menu-up").click()
  await expect(announced(page)).toHaveText("api-server moved to 2 of 3")
  await shot(page.getByTestId("sidebar"), "english")
})

test.describe("touch", () => {
  test.use({ viewport: { width: 384, height: 742 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })

  test("a long press drags a project and a section; the list does not scroll under it", async ({ page }) => {
    await open(page)
    const from = await centre(project(page, "local", "demo-game").locator("span.truncate"))
    const client = touch(page, from, [
      [0, 0, 550],
      [0, 6, 60],
      [0, 10, 60],
      ...Array.from({ length: 10 }, () => [0, 12, 30] as const),
      [0, 0, 100],
    ])
    await expect(page.getByTestId("drag-line")).toBeVisible()
    await shot(page, "touch-drag")
    await client
    const list = await projects(page, "local")
    expect(list).not.toEqual(LOCAL)
    expect(list.indexOf("demo-game")).toBeGreaterThan(2)
    // The tap that ended it did not fold the project.
    await expect(project(page, "local", "demo-game")).toHaveAttribute("aria-expanded", "true")

    await toggle(page, "local").tap()
    await head(page, "h-ubuntu").scrollIntoViewIfNeeded()
    await touch(page, await centre(head(page, "h-ubuntu").locator(".font-semibold")), [
      [0, 0, 550],
      [0, -10, 60],
      ...Array.from({ length: 6 }, () => [0, -10, 30] as const),
    ])
    expect((await servers(page)).slice(0, 2)).toEqual(["h-ubuntu", "local"])
  })

  test("a long press in place opens the header's menu; a scroll and a tap stay what they are", async ({ page }) => {
    await open(page)
    await touch(page, await centre(project(page, "local", "demo-game").locator("span.truncate")), [[0, 0, 600]])
    await expect(page.getByTestId("project-menu-pin")).toBeVisible()
    await expect(page.getByTestId("drag-line")).toHaveCount(0)
    await page.keyboard.press("Escape")

    // A quick vertical move on a header scrolls.
    const scroller = page.getByTestId("sidebar-scroll")
    const at = await centre(project(page, "local", "결제 웹훅").locator("span.truncate"))
    await touch(
      page,
      at,
      Array.from({ length: 12 }, () => [0, -14, 12] as const),
    )
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(40)
    expect(await projects(page, "local")).toEqual(LOCAL)
    await scroller.evaluate((element) => element.scrollTo(0, 0))

    await project(page, "local", "own-open-code").locator("span.truncate").tap()
    await expect(project(page, "local", "own-open-code")).toHaveAttribute("aria-expanded", "false")
  })

  test.describe("in the drawer", () => {
    test.use({ viewport: { width: 704, height: 851 } })

    test("a swipe from a header still closes it, and a drag that wanders sideways does not", async ({ page }) => {
      await open(page)
      const app = page.getByTestId("app")
      await page.getByTestId("sidebar-toggle").first().tap()
      await expect(app).toHaveAttribute("data-sidebar", "open")
      await page.waitForTimeout(300)
      await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute("data-swipe"))).toBe(true)
      const name = project(page, "local", "own-open-code").locator("span.truncate")
      await touch(page, await centre(name), [
        [0, 0, 550],
        [-30, 0, 40],
        [-60, 0, 40],
        [-40, 0, 40],
      ])
      await page.waitForTimeout(400)
      await expect(app).toHaveAttribute("data-sidebar", "open")
      expect(await projects(page, "local")).toEqual(LOCAL)
      await touch(
        page,
        await centre(name),
        Array.from({ length: 10 }, () => [-18, 0, 10] as const),
      )
      await expect(app).toHaveAttribute("data-sidebar", "closed")
    })
  })
})
