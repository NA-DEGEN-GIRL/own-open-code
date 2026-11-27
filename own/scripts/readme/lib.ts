// What a README picture's flow gets: pages in the picture's language and size, and the shooter (own/scripts/manual/lib).
import { settle, type Browser, type BrowserContext, type Locator, type Page } from "../manual/lib/browser"
import { patchedClaude } from "../manual/lib/claude"
import { initScript, type Mapping } from "../manual/lib/privacy"
import type { Saved, Shooter, ShotOptions } from "../manual/lib/shoot"

export type Lang = "en" | "ko"

/**
 * Pages are drawn at four times the size a picture is saved at and halved twice: crisp, smoothed text on a PC that draws
 * it unsmoothed (a Windows session without font smoothing, 2026-11-26), and the same everywhere else.
 */
export const HALVINGS = 2
export const OVERSAMPLE = 2 ** HALVINGS

export interface Endpoints {
  readonly dev: string
  readonly device?: string
}

export interface PageOptions {
  readonly path?: string
  readonly scheme?: "dark" | "light"
  readonly width?: number
  readonly height?: number
  /** Device pixels per CSS pixel (default 1.5: 1290 CSS pixels become a 1935 px picture; under 1280 the work panel is a drawer). */
  readonly scale?: number
  /** The phone stand-in (a paired phone) on a touch screen of this size. */
  readonly phone?: boolean
}

export interface Ctx<State> {
  readonly state: State
  readonly lang: Lang
  readonly browser: Browser
  readonly pairs: ReadonlyArray<Mapping>
  /** The text of this picture's language. */
  say(korean: string, english: string): string
  page(options?: PageOptions): Promise<Page>
  session(id: string, options?: PageOptions): Promise<Page>
  shoot(page: Page, id: string, options?: ShotOptions): Promise<Saved>
  save(id: string, png: Buffer): Promise<Saved>
  /** POST `<device>/manual/<action>`: an own RPC through the demo backend. */
  rpc(id: string, method: string, input?: unknown, directory?: string): Promise<Record<string, unknown>>
  /** The demo server's own API through own-web's dev proxy. */
  api(method: string, route: string, body?: unknown): Promise<Record<string, unknown>>
}

export interface Shot<State> {
  readonly id: string
  run(ctx: Ctx<State>): Promise<void>
}

/**
 * Hides the note only a browser window shows (the desktop app runs the same screens without it). `system-ui` is Segoe UI
 * on an English Windows and Malgun Gothic, with `₩` for a backslash, on a Korean one (`.worktrees₩core`, 2026-11-26).
 * Both languages take Latin from Segoe UI; Korean takes Hangul from Noto Sans KR, or Malgun Gothic where it is missing.
 */
export function styleOf(lang: Lang) {
  const notice = "[data-testid=browser-tool-notice]{display:none!important}"
  const sans = lang === "en" ? `"Segoe UI",sans-serif` : `"Segoe UI","Noto Sans KR","Malgun Gothic",sans-serif`
  return `${notice} :root{--own-font-sans:${sans}!important}`
}

export const tid = (page: Page | Locator, id: string) => page.getByTestId(id)

/** Opens the work panel on a tab, or closes it. */
export async function panel(page: Page, tab: "accounts" | "review" | "files" | undefined) {
  const open = await tid(page, "panel")
    .isVisible()
    .catch(() => false)
  if (open !== (tab !== undefined)) await tid(page, "panel-toggle").first().click()
  if (tab !== undefined) await page.locator(`#own-tab-${tab}`).click()
  await page.waitForTimeout(600)
}

/** Types and sends in the open conversation (Ctrl+Enter, the default sending key). */
export async function send(page: Page, text: string) {
  const box = page.locator("#own-composer-input")
  await box.click()
  await box.fill(text)
  await box.press("Control+Enter")
}

/** Closes the toasts on screen. */
export async function dismissToasts(page: Page) {
  for (const close of await tid(page, "toast")
    .getByRole("button", { name: /닫기|Close|Dismiss|×/ })
    .all())
    await close.click().catch(() => undefined)
  await page.waitForTimeout(300)
}

/**
 * The demo's ChatGPT accounts come from the test kit's old-app profiles (the only fake ChatGPT login it has): without the
 * `Linked` mark of that import they look like accounts added in the app.
 */
async function plainAccounts(context: BrowserContext) {
  await context.route(/\/api\/rpc\/own\.accounts\/accounts\./, async (route) => {
    const response = await route.fetch()
    const body: unknown = await response.json().catch(() => undefined)
    if (body === undefined) return route.fulfill({ response })
    const strip = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(strip)
      if (!value || typeof value !== "object") return value
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, item]) => key !== "source" || (item as { mode?: string } | null)?.mode !== "linked")
          .map(([key, item]) => [key, strip(item)]),
      )
    }
    return route.fulfill({ response, json: strip(body) })
  })
}

/** Korean texts left on an English picture are printed: the app has no English for them (nothing is drawn over). */
async function koreanTexts(page: Page, id: string) {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.checkVisibility())
      .filter((element) =>
        [...element.childNodes].some((node) => node.nodeType === 3 && /[가-힣]/.test(node.nodeValue ?? "")),
      )
      .map((element) => (element.textContent ?? "").trim().slice(0, 50)),
  )
  if (found.length > 0) console.log(`    ${id}: Korean on screen: ${[...new Set(found)].join(" | ")}`)
}

export function makeCtx<State extends Endpoints>(input: {
  readonly browser: Browser
  readonly lang: Lang
  readonly state: State
  readonly pairs: ReadonlyArray<Mapping>
  readonly shooter: Shooter
  readonly saved: Saved[]
}): Ctx<State> & { dispose(): Promise<void> } {
  const pages: Page[] = []
  const page = async (options: PageOptions = {}) => {
    const scheme = options.scheme ?? "dark"
    const context = await input.browser.newContext({
      viewport: { width: options.width ?? 1290, height: options.height ?? 800 },
      deviceScaleFactor: (options.scale ?? 1.5) * OVERSAMPLE,
      ...(options.phone
        ? {
            isMobile: true,
            hasTouch: true,
            userAgent:
              "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
          }
        : {}),
      locale: input.lang === "ko" ? "ko-KR" : "en-US",
      timezoneId: "Asia/Seoul",
      colorScheme: scheme,
      reducedMotion: "reduce",
      baseURL: options.phone && input.state.device ? input.state.device : input.state.dev,
    })
    await context.addInitScript(initScript(input.pairs))
    const storage = { "opencode-color-scheme": scheme, "own.web.locale": input.lang }
    await context.addInitScript(
      `(() => { try { for (const [k, v] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(k, v) } catch {} })()`,
    )
    await context.addInitScript(`(() => {
  const add = () => {
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(styleOf(input.lang))};
    document.head.append(style);
  };
  if (document.head) add(); else document.addEventListener("DOMContentLoaded", add, { once: true });
})()`)
    if ((input.state as { claudePatched?: boolean }).claudePatched) await patchedClaude(context)
    await plainAccounts(context)
    const opened = await context.newPage()
    pages.push(opened)
    await opened.goto(options.path ?? "/")
    await opened
      .locator('[data-testid="server-status"][data-status="connected"]')
      .first()
      .waitFor({ timeout: options.phone ? 20_000 : 120_000 })
      .catch(() => undefined)
    await opened.waitForTimeout(1500)
    return opened
  }
  const record = (saved: Saved) => {
    input.saved.push(saved)
    console.log(`  ✓ ${input.lang}/${saved.id} ${saved.width}×${saved.height} ${(saved.bytes / 1024).toFixed(0)} KB`)
    return saved
  }
  return {
    state: input.state,
    lang: input.lang,
    browser: input.browser,
    pairs: input.pairs,
    say: (korean, english) => (input.lang === "ko" ? korean : english),
    page,
    async session(id, options = {}) {
      const opened = await page({ ...options, path: `/srv/local/s/${id}` })
      await tid(opened, "composer").first().waitFor({ timeout: 60_000 })
      await opened.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
      await opened.waitForTimeout(1500)
      await dismissToasts(opened)
      return opened
    },
    async shoot(target, id, options = {}) {
      await settle(target)
      if (input.lang === "en") await koreanTexts(target, id)
      return record(await input.shooter.shoot(target, id, { scale: "device", ...options }))
    },
    save: async (id, png) => record(await input.shooter.save(id, png)),
    async rpc(id, method, rpcInput, directory) {
      const response = await fetch(`${input.state.device}/manual/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, method, input: rpcInput ?? {}, directory }),
      })
      const result = (await response.json()) as { status: number; output?: Record<string, unknown>; message?: string }
      if (result.status !== 200) throw new Error(`${id} ${method}: ${result.status} ${result.message}`)
      return result.output ?? {}
    },
    async api(method, route, body) {
      const response = await fetch(new URL(route, input.state.dev), {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`${method} ${route}: ${response.status}`)
      const text = await response.text()
      return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
    },
    async dispose() {
      // OWN_README_DEBUG=<folder>: what the pages showed at the end (a picture that failed).
      const debug = process.env.OWN_README_DEBUG
      if (debug)
        await Promise.all(
          pages.map((opened, index) =>
            opened
              .screenshot({ path: `${debug}/page-${Date.now()}-${index}.png`, scale: "css" })
              .catch(() => undefined),
          ),
        )
      await Promise.all(
        pages.splice(0).map((opened) =>
          opened
            .context()
            .close()
            .catch(() => undefined),
        ),
      )
    },
  }
}
