// Opens the built manual (own/docs/manual/own-open-code-manual.html) the way a reader does, from a file:// URL in the
// installed Microsoft Edge, and checks what build-html.ts cannot see from the text alone (PLAN.md §9.4):
//
//   bun own/scripts/manual/check-html.ts                       check the page
//   bun own/scripts/manual/check-html.ts --shots <folder>      also keep PNGs of what was checked (not for the repo)
//   bun own/scripts/manual/check-html.ts --file <page.html>    check another build
//
// No network at all (offline browser context, and any request that is not file: or data: fails the check), the first
// theme for a dark and a light system and the theme button (remembered after a reload), no sideways scrolling at 1440
// and 375 px wide, every picture decodes, the narrow-screen contents drawer, search (results, jump, highlighted words),
// the picture zoom, the contents following the reading place, keyboard shortcuts, and the print layout.
import { mkdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { launch, REPO, type Browser, type Page } from "./lib/browser"

const args = parseArgs({ options: { shots: { type: "string" }, file: { type: "string" } } }).values
const FILE = path.resolve(args.file ?? path.join(REPO, "own/docs/manual/own-open-code-manual.html"))
const URL = pathToFileURL(FILE).href
const SHOTS = args.shots ? path.resolve(args.shots) : undefined
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail })
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const browser = await launch()
await darkDesktop(browser)
await lightDesktop(browser)
await phone(browser)
await printLayout(browser)
await browser.close()

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${(Bun.file(FILE).size / 1024 / 1024).toFixed(1)} MB page)`)
if (failed.length > 0) process.exit(1)

/** A browser context with no network: offline, and anything but file:/data: is recorded and refused. */
async function open(browser: Browser, options: { scheme: "dark" | "light"; width: number; height: number; phone?: boolean }) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.phone ? 2 : 1,
    isMobile: options.phone ?? false,
    hasTouch: options.phone ?? false,
    colorScheme: options.scheme,
    locale: "ko-KR",
    offline: true,
  })
  const outside: string[] = []
  await context.route("**/*", (route) => {
    const url = route.request().url()
    if (url.startsWith("file:") || url.startsWith("data:")) return route.continue()
    outside.push(url)
    return route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const problems: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (!url.startsWith("file:") && !url.startsWith("data:")) outside.push(url)
  })
  page.on("pageerror", (error) => problems.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text())
  })
  await page.goto(URL, { waitUntil: "load" })
  return { context, page, outside, problems }
}

async function darkDesktop(browser: Browser) {
  const { context, page, outside, problems } = await open(browser, { scheme: "dark", width: 1440, height: 900 })
  check("dark system → dark theme", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark")
  check("1440 px: no sideways scroll", await noSidewaysScroll(page))
  const pictures = await page.evaluate(async () => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>("main img"))
    // Lazy pictures off screen never load on their own; the page does the same before printing.
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))
    const decoded = await Promise.all(
      images.map((image) => {
        image.loading = "eager"
        return Promise.race([image.decode().then(() => true, () => false), timeout])
      }),
    )
    return { total: images.length, broken: decoded.filter((ok) => !ok).length }
  })
  check("every picture decodes", pictures.total > 0 && pictures.broken === 0, `${pictures.total} pictures, ${pictures.broken} broken`)
  const toc = await page.evaluate(() => ({
    visible: getComputedStyle(document.getElementById("toc")!).visibility === "visible",
    chapters: document.querySelectorAll("#toc .toc-ch").length,
    sections: document.querySelectorAll("main section.chapter").length,
  }))
  check("contents sidebar lists every chapter", toc.visible && toc.chapters === toc.sections, `${toc.chapters} chapters`)
  await shot(page, "dark-cover")

  // Scroll-spy: reading a chapter marks it (and opens its sections) in the contents.
  await page.evaluate(() => document.getElementById("ch17")!.scrollIntoView({ block: "start", behavior: "instant" }))
  await page.waitForFunction(() => document.querySelector("#toc a.active")?.getAttribute("href")?.startsWith("#ch17"))
  const spy = await page.evaluate(() => ({
    active: document.querySelector("#toc a.active")?.getAttribute("href"),
    open: document.querySelector("#toc a.active")?.closest(".toc-ch")?.classList.contains("open"),
  }))
  check("contents follow the reading place", spy.active === "#ch17" && spy.open === true, `active ${spy.active}`)
  await page.evaluate(() => document.getElementById("ch17-4")!.scrollIntoView({ block: "start", behavior: "instant" }))
  await page.waitForFunction(() => document.querySelector("#toc a.active")?.getAttribute("href") === "#ch17-4")
  check("contents follow into sections", true, "#ch17-4")
  await shot(page, "dark-ch17")

  // Search: `/` focuses the box, results appear, Enter jumps to the best match and highlights it.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }))
  await page.keyboard.press("/")
  check("`/` focuses search", await page.evaluate(() => document.activeElement?.id === "search"))
  await page.keyboard.type("압축 후 전환")
  await page.waitForSelector("#search-results:not([hidden]) .sr-item")
  const found = await page.evaluate(() => ({
    count: document.querySelectorAll("#search-results .sr-item").length,
    first: document.querySelector<HTMLAnchorElement>("#search-results .sr-item")?.dataset.id,
  }))
  check("search finds 압축 후 전환", found.count > 0 && found.first?.startsWith("ch11") === true, `${found.count} results, first ${found.first}`)
  await shot(page, "dark-search")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.querySelectorAll("mark.hit").length > 0)
  const jump = await page.evaluate(() => {
    const mark = document.querySelector("mark.hit.current") ?? document.querySelector("mark.hit")
    const box = mark?.getBoundingClientRect()
    return {
      hash: location.hash,
      marks: document.querySelectorAll("mark.hit").length,
      visible: box !== undefined && box.top >= 0 && box.bottom <= innerHeight,
      closed: document.getElementById("search-results")!.hidden,
    }
  })
  check(
    "search jumps and highlights",
    jump.hash.startsWith("#ch11") && jump.marks > 0 && jump.visible && jump.closed,
    `${jump.hash}, ${jump.marks} highlights`,
  )
  await shot(page, "dark-search-jump")
  await page.locator("#search").focus()
  await page.keyboard.press("Control+A")
  await page.keyboard.type("없는낱말xyz")
  await page.waitForFunction(() => document.querySelector("#search-results .sr-count")?.textContent?.includes("맞는 곳이 없어요"))
  check("search says when nothing matches", (await page.locator("#search-results .sr-item").count()) === 0)
  await page.keyboard.press("Control+A")
  await page.keyboard.type("Ctrl+Alt+Shift+Q")
  await page.waitForFunction(() => document.querySelector("#search-results .sr-title")?.textContent !== undefined)
  const keyHit = await page.locator("#search-results .sr-item").first().getAttribute("data-id")
  await page.keyboard.press("Enter")
  await page.waitForFunction(() => document.querySelectorAll("mark.hit").length > 0)
  const keyHash = await page.evaluate(() => location.hash)
  check("search across key caps (Ctrl+Alt+Shift+Q) jumps and highlights", keyHash === `#${keyHit}`, keyHash)
  await page.keyboard.press("Escape")
  check("Esc on the page clears the highlights", await page.evaluate(() => document.querySelectorAll("mark.hit").length === 0))
  await page.locator("#search").focus()
  await page.waitForSelector("#search-results:not([hidden])")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  const cleared = await page.evaluate(() => ({
    value: (document.getElementById("search") as HTMLInputElement).value,
    closed: document.getElementById("search-results")!.hidden,
  }))
  check("Esc in the box closes the results, then clears it", cleared.value === "" && cleared.closed)
  await page.keyboard.press("Control+K")
  check("Ctrl+K focuses search", await page.evaluate(() => document.activeElement?.id === "search"))
  await page.keyboard.press("Escape")

  // Zoom: a picture opens fitted, a click on it shows its full size, Esc closes and returns focus.
  const figure = page.locator("#ch11 ~ figure.shot .zoom").first()
  await figure.scrollIntoViewIfNeeded()
  await figure.click()
  await page.waitForSelector("#lightbox:not([hidden])")
  const fitted = await page.evaluate(() => {
    const image = document.getElementById("lightbox-img") as HTMLImageElement
    const box = image.getBoundingClientRect()
    return { fits: box.width <= innerWidth && box.height <= innerHeight, loaded: image.complete && image.naturalWidth > 0 }
  })
  check("picture zoom opens fitted to the screen", fitted.fits && fitted.loaded)
  await shot(page, "dark-zoom")
  await page.locator("#lightbox-img").click()
  check("click shows full size", await page.evaluate(() => document.getElementById("lightbox")!.classList.contains("actual")))
  await page.keyboard.press("Escape")
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById("lightbox")!.hidden,
    focus: document.activeElement?.classList.contains("zoom"),
    scroll: !document.body.classList.contains("no-scroll"),
  }))
  check("Esc closes the zoom and returns focus", closed.hidden && closed.focus === true && closed.scroll)

  check("no network requests (dark, 1440)", outside.length === 0, outside.slice(0, 3).join(", "))
  check("no script errors (dark, 1440)", problems.length === 0, problems.slice(0, 3).join(" | "))
  await context.close()
}

async function lightDesktop(browser: Browser) {
  const { context, page, outside, problems } = await open(browser, { scheme: "light", width: 1440, height: 900 })
  check("light system → light theme", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light")
  const colors = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check("light theme paints a light page", colors === "rgb(255, 255, 255)", colors)
  await page.evaluate(() => document.getElementById("ch05")!.scrollIntoView({ block: "start", behavior: "instant" }))
  await shot(page, "light-ch05")
  await page.locator("#theme-btn").click()
  check("theme button switches to dark", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark")
  await page.reload({ waitUntil: "load" })
  check("chosen theme is remembered after a reload", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark")
  await page.locator("#theme-btn").click()
  check("and switches back to light", (await page.evaluate(() => document.documentElement.dataset.theme)) === "light")
  check("no network requests (light, 1440)", outside.length === 0, outside.slice(0, 3).join(", "))
  check("no script errors (light, 1440)", problems.length === 0, problems.slice(0, 3).join(" | "))
  await context.close()
}

async function phone(browser: Browser) {
  for (const scheme of ["dark", "light"] as const) {
    const { context, page, outside, problems } = await open(browser, { scheme, width: 375, height: 812, phone: true })
    check(`375 px ${scheme}: no sideways scroll on the cover`, await noSidewaysScroll(page))
    const hidden = await page.evaluate(() => getComputedStyle(document.getElementById("toc")!).visibility)
    check(`375 px ${scheme}: contents start hidden`, hidden === "hidden")
    await shot(page, `phone-${scheme}-cover`)
    await page.locator("#menu-btn").click()
    await page.waitForFunction(() => getComputedStyle(document.getElementById("toc")!).visibility === "visible")
    await page.waitForTimeout(250)
    await shot(page, `phone-${scheme}-drawer`)
    await page.locator('#toc a[href="#ch14"]').click()
    await page.waitForFunction(() => !document.body.classList.contains("toc-open"))
    await page.waitForTimeout(400)
    const landed = await page.evaluate(() => {
      const box = document.getElementById("ch14")!.getBoundingClientRect()
      return box.top >= 0 && box.top < 200
    })
    check(`375 px ${scheme}: drawer link goes to the chapter and closes`, landed)
    await shot(page, `phone-${scheme}-ch14`)
    // Every chapter: nothing may push the page sideways (wide tables and code scroll inside their own box).
    const wide = await page.evaluate(async () => {
      const offenders: string[] = []
      for (const heading of Array.from(document.querySelectorAll<HTMLElement>("main section.chapter > h1"))) {
        heading.scrollIntoView({ block: "start", behavior: "instant" })
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (document.documentElement.scrollWidth > innerWidth) offenders.push(heading.id)
      }
      return offenders
    })
    check(`375 px ${scheme}: no chapter scrolls sideways`, wide.length === 0, wide.join(", "))
    await page.locator("#search").fill("비상 정지")
    await page.waitForSelector("#search-results:not([hidden]) .sr-item")
    const panel = await page.evaluate(() => {
      const box = document.getElementById("search-results")!.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth
    })
    check(`375 px ${scheme}: search results fit the screen`, panel)
    await shot(page, `phone-${scheme}-search`)
    const first = await page.locator("#search-results .sr-item").first().getAttribute("data-id")
    await page.locator("#search-results .sr-item").first().click()
    await page.waitForFunction(() => document.querySelectorAll("mark.hit").length > 0)
    const hash = await page.evaluate(() => location.hash)
    check(`375 px ${scheme}: search result opens its section`, hash === `#${first}` && hash.startsWith("#ch18"), hash)
    await page.locator("figure.shot .zoom").first().scrollIntoViewIfNeeded()
    await page.locator("figure.shot .zoom").first().click()
    await page.waitForSelector("#lightbox:not([hidden])")
    const zoomed = await page.evaluate(() => {
      const box = document.getElementById("lightbox-img")!.getBoundingClientRect()
      return box.width > 0 && box.right <= innerWidth + 1
    })
    check(`375 px ${scheme}: picture zoom fits`, zoomed)
    await shot(page, `phone-${scheme}-zoom`)
    await page.locator("#lightbox-close").click()
    check(`no network requests (375 px ${scheme})`, outside.length === 0, outside.slice(0, 3).join(", "))
    check(`no script errors (375 px ${scheme})`, problems.length === 0, problems.slice(0, 3).join(" | "))
    await context.close()
  }
}

async function printLayout(browser: Browser) {
  const { context, page } = await open(browser, { scheme: "dark", width: 1100, height: 1400 })
  await page.emulateMedia({ media: "print" })
  const printed = await page.evaluate(() => ({
    topbar: getComputedStyle(document.querySelector(".topbar")!).display,
    toc: getComputedStyle(document.getElementById("toc")!).display,
    background: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
    breaks: getComputedStyle(document.querySelector("section.chapter")!).breakBefore,
  }))
  check(
    "print: no chrome, light colors, a page per chapter",
    printed.topbar === "none" &&
      printed.toc === "none" &&
      printed.background === "rgb(255, 255, 255)" &&
      printed.text === "rgb(17, 17, 17)" &&
      printed.breaks === "page",
    JSON.stringify(printed),
  )
  await shot(page, "print")
  await context.close()
}

async function noSidewaysScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}
