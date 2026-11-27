// The README's browser pane picture: the desktop shell (unpackaged, every state folder in a temp root, its window off the
// screen) on the manual's main demo world, whose scripted model opens a made-up scoreboard page and clicks on it.
import { createRequire } from "node:module"
import path from "node:path"
import { privacyProblems, REPO, type Browser, type Page } from "../manual/lib/browser"
import { initScript } from "../manual/lib/privacy"
import { start, type World } from "../manual/lib/world"
import { launchShell, type Shell } from "../manual/shots/desktop"
import { mainPaths, type MainState } from "../manual/shots/main"
import { OVERSAMPLE, styleOf, tid, type Ctx, type Lang } from "./lib"

export type PaneState = MainState & Shell

export async function bootReadmePane(lang: Lang, port: number): Promise<World<PaneState>> {
  const main = await start<MainState & { server: { url: string; password: string }; ownHome: string }>(
    `readme-pane-${lang}`,
    {
      script: "e2e/manual/backend.ts",
      env: { OWN_MANUAL_WORLD: "main", OWN_MANUAL_PORT: String(port), OWN_MANUAL_LANG: lang },
      ready: "OWN_MANUAL_READY",
    },
    mainPaths,
  )
  const shell = await launchShell(
    {
      url: main.state.server.url,
      password: main.state.server.password,
      ownHome: main.state.ownHome,
      dev: main.state.dev,
    },
    port + 5,
  ).catch(async (error: unknown) => {
    await main.stop()
    throw error
  })
  return {
    state: { ...main.state, ...shell, pairs: main.pairs },
    pairs: main.pairs,
    stop: async () => {
      await shell.stop()
      await main.stop()
    },
  }
}

const playwright = createRequire(path.join(REPO, "packages/own-web/package.json"))("@playwright/test") as {
  readonly chromium: { connectOverCDP(url: string, options?: { timeout?: number }): Promise<Browser> }
}

/** The shell's main window over CDP (the page with the preload's `window.own`), in the picture's language. */
export async function panePage(state: PaneState, lang: Lang): Promise<Page> {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const browser = await playwright.chromium.connectOverCDP(state.cdp, { timeout: 5_000 }).catch(() => undefined)
    const pages = browser?.contexts().flatMap((context) => context.pages()) ?? []
    const own = await Promise.all(
      pages.map((page) => page.evaluate(() => typeof (window as { own?: unknown }).own === "object").catch(() => false)),
    )
    const page = pages[own.indexOf(true)]
    if (!page) {
      await browser?.close().catch(() => undefined)
      await Bun.sleep(1000)
      continue
    }
    await page.addInitScript(initScript(state.pairs))
    await page.evaluate((locale) => {
      localStorage.setItem("opencode-color-scheme", "dark")
      localStorage.setItem("own.web.locale", locale)
    }, lang)
    await page.reload()
    await page.locator('[data-testid="server-status"][data-status="connected"]').first().waitFor({ timeout: 120_000 })
    await page.addStyleTag({ content: styleOf(lang) })
    await page.waitForTimeout(1500)
    return page
  }
  throw new Error("the shell's window never came up (see manual-desktop-shell.log)")
}

/**
 * Shows the conversation's browser beside it, waits until the agent waits on the page, and takes both surfaces of the
 * window: the shell's page, and the pane's own page (a native view) at its place in it. Each is captured over CDP at the
 * pictures' oversampling, so the text is as smooth as in the others; a capture of the window itself has the screen's.
 */
export async function paneCapture(ctx: Ctx<PaneState>, page: Page, id: string) {
  const toggle = tid(page, "workspace-browser-toggle")
  await toggle.waitFor({ timeout: 60_000 })
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click()
  await tid(page, "browser-agent-action")
    .filter({ hasText: /기다리는 중|Waiting/i })
    .waitFor({ timeout: 120_000 })
  await page.waitForTimeout(2000)
  const problems = await privacyProblems(page)
  if (problems.length > 0) throw new Error(`${id}: personal data on screen: ${problems.join(" / ")}`)
  const site = page
    .context()
    .pages()
    .find((candidate) => candidate.url().includes("/manual/site"))
  if (!site) throw new Error(`${id}: the pane's page is not open`)
  const place = await tid(page, "browser-surface").boundingBox()
  if (!place) throw new Error(`${id}: the browser pane is not shown`)
  const shell = await surface(page)
  const pane = await surface(site)
  const context = await ctx.browser.newContext()
  const blank = await context.newPage()
  const png = await blank.evaluate(
    async (input) => {
      const load = async (data: string) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        return image
      }
      const [shellImage, paneImage] = await Promise.all([load(input.shell), load(input.pane)])
      const canvas = document.createElement("canvas")
      canvas.width = shellImage.naturalWidth
      canvas.height = shellImage.naturalHeight
      const draw = canvas.getContext("2d")!
      draw.drawImage(shellImage, 0, 0)
      const { x, y, width, height } = input.place
      draw.drawImage(paneImage, x * input.scale, y * input.scale, width * input.scale, height * input.scale)
      return canvas.toDataURL("image/png").slice("data:image/png;base64,".length)
    },
    { shell, pane, place, scale: SCALE },
  )
  await context.close()
  await ctx.save(id, Buffer.from(png, "base64"))
}

const SCALE = 1.5 * OVERSAMPLE

/** One page of the shell as it is laid out, drawn at `SCALE` device pixels per CSS pixel (base64 PNG). */
async function surface(page: Page) {
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: SCALE, mobile: false })
  await page.waitForTimeout(800)
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" })
  await cdp.send("Emulation.clearDeviceMetricsOverride")
  await cdp.detach()
  return shot.data
}
