// The installed Microsoft Edge through Playwright (from packages/own-web's devDependencies: Bun's isolated install
// resolves it only there), set up like the manual's screenshots need it (PLAN.md §5.1): Korean locale, reduced
// motion, a fixed color scheme, the on-screen path rewrite, and a check before every shot.
import { createRequire } from "node:module"
import path from "node:path"
import type {
  Browser,
  BrowserContext,
  BrowserType,
  Locator,
  Page,
} from "../../../../packages/own-web/node_modules/@playwright/test/index.js"
import { checkScript, forbidden, initScript, type Mapping } from "./privacy"

export type { Browser, BrowserContext, Locator, Page }

export const REPO = path.resolve(import.meta.dir, "../../../..")
const playwright = createRequire(path.join(REPO, "packages/own-web/package.json"))("@playwright/test") as {
  readonly chromium: BrowserType
}

export function launch() {
  return playwright.chromium.launch({ channel: "msedge", headless: true })
}

export interface ContextOptions {
  readonly pairs: ReadonlyArray<Mapping>
  readonly scheme?: "dark" | "light"
  readonly phone?: boolean
  readonly baseURL?: string
  /** Extra localStorage entries set before the page's scripts run. */
  readonly storage?: Readonly<Record<string, string>>
  /**
   * Keep the notes that only a browser window shows (`브라우저 도구는 데스크톱 앱에서…`): hidden by default, so the
   * shots look like the desktop app, which runs the same screens without them.
   */
  readonly browserNotes?: boolean
}

/** A context at 1440×900 (or a 390×844 phone), device scale 2, with the privacy rewrite and the color scheme. */
export async function context(browser: Browser, options: ContextOptions) {
  const scheme = options.scheme ?? "dark"
  const created = await browser.newContext({
    viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // A phone browser (the pairing screens name the device by its browser and system).
    ...(options.phone
      ? {
          isMobile: true,
          hasTouch: true,
          userAgent:
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
        }
      : {}),
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    colorScheme: scheme,
    reducedMotion: "reduce",
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  })
  await created.addInitScript(initScript(options.pairs))
  const storage = { "opencode-color-scheme": scheme, ...options.storage }
  await created.addInitScript(
    `(() => { try { for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v) } catch {} })()`,
  )
  if (!options.browserNotes)
    await created.addInitScript(`(() => {
  const add = () => {
    const style = document.createElement("style");
    style.textContent = "[data-testid=browser-tool-notice]{display:none!important}";
    document.head.append(style);
  };
  if (document.head) add(); else document.addEventListener("DOMContentLoaded", add, { once: true });
})()`)
  return created
}

/** Problems the privacy check finds on the page now (empty: safe to shoot). */
export async function privacyProblems(page: Page): Promise<string[]> {
  return page.evaluate(checkScript(forbidden()))
}

/** Waits for running animations and transitions to end, then for two frames. */
export async function settle(page: Page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
