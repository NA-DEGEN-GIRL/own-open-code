// What a shot flow gets: pages set up for the demo world, the shooter, and the world's controls.
import { context, type Browser, type Page } from "./browser"
import { patchedClaude } from "./claude"
import type { Mapping } from "./privacy"
import type { Saved, ShotOptions, Shooter } from "./shoot"

export interface PageOptions {
  readonly scheme?: "dark" | "light"
  readonly phone?: boolean
  /** Opened after the page is created (default `/`); `false`: nothing is opened. */
  readonly path?: string | false
  readonly storage?: Readonly<Record<string, string>>
  /** Keep the browser-window-only notes (19장). */
  readonly browserNotes?: boolean
  /** Keep the page open for the group's next shots (a story that goes on across shots). */
  readonly keep?: boolean
}

export interface Ctx<State> {
  readonly state: State
  /** A new browser context and page at `path`, with the app loaded. */
  page(options?: PageOptions): Promise<Page>
  /** A page with the session `id` open and its composer ready. */
  session(id: string, options?: PageOptions): Promise<Page>
  shoot(page: Page, id: string, options?: ShotOptions): Promise<Saved>
  /** Saves a PNG taken another way (a native window capture) as the shot `id`. */
  save(id: string, png: Buffer): Promise<Saved>
  /** POST `<device>/manual/<action>` (the demo backend's controls). */
  control(action: string, body?: unknown): Promise<Record<string, unknown>>
  /** An own RPC through the demo backend (`{status, output, type, message}`). */
  rpc(id: string, method: string, input?: unknown, directory?: string): Promise<RpcResult>
  readonly log: (line: string) => void
}

export interface RpcResult {
  readonly status: number
  readonly output?: unknown
  readonly type?: string
  readonly message?: string
}

export interface Shot<State> {
  readonly id: string
  run(ctx: Ctx<State>): Promise<void>
}

export interface Endpoints {
  readonly dev: string
  readonly device?: string
}

export function makeCtx<State extends Endpoints>(input: {
  readonly browser: Browser
  readonly state: State
  readonly pairs: ReadonlyArray<Mapping>
  readonly shooter: Shooter
  readonly saved: Saved[]
  /** Pages kept for the group's later shots; the caller closes them when the group ends. */
  readonly kept: Page[]
  readonly log: (line: string) => void
}): Ctx<State> & { dispose(): Promise<void> } {
  const pages: Page[] = []
  const page = async (options: PageOptions = {}) => {
    const created = await context(input.browser, {
      pairs: input.pairs,
      ...(options.scheme ? { scheme: options.scheme } : {}),
      ...(options.phone ? { phone: true } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.browserNotes ? { browserNotes: true } : {}),
      baseURL: options.phone && input.state.device ? input.state.device : input.state.dev,
    })
    // The main world's Claude accounts as after the local patch (lib/claude.ts).
    if ((input.state as { claudePatched?: boolean }).claudePatched) await patchedClaude(created)
    const opened = await created.newPage()
    if (options.keep) input.kept.push(opened)
    if (!options.keep) pages.push(opened)
    opened.on("pageerror", (error) => input.log(`  page error: ${error.message.slice(0, 200)}`))
    if (options.path === false) return opened
    await opened.goto(options.path ?? "/")
    await opened.getByTestId("app").first().waitFor({ timeout: 60_000 }).catch(() => undefined)
    // Connected to the service (the first load after a boot compiles own-web and takes a while).
    await opened
      .locator('[data-testid="server-status"][data-status="connected"]')
      .first()
      .waitFor({ timeout: 120_000 })
      .catch(() => undefined)
    return opened
  }
  const post = async (action: string, body: unknown) => {
    if (!input.state.device) throw new Error("this world has no controls")
    const response = await fetch(`${input.state.device}/manual/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    })
    return (await response.json()) as Record<string, unknown>
  }
  return {
    state: input.state,
    page,
    async session(id, options = {}) {
      const opened = await page({ ...options, path: `/srv/local/s/${id}` })
      await opened.getByTestId("composer").first().waitFor({ timeout: 60_000 })
      await opened.locator(`[data-testid="transcript-body"][data-session-id="${id}"]`).waitFor({ timeout: 60_000 })
      await opened.getByTestId("session-row").first().waitFor({ timeout: 60_000 }).catch(() => undefined)
      await opened.waitForTimeout(1200)
      return opened
    },
    async shoot(target, id, options) {
      const saved = await input.shooter.shoot(target, id, options)
      input.saved.push(saved)
      input.log(`  ✓ ${id} ${saved.width}×${saved.height} ${(saved.bytes / 1024).toFixed(0)} KB`)
      return saved
    },
    async save(id, png) {
      const saved = await input.shooter.save(id, png)
      input.saved.push(saved)
      input.log(`  ✓ ${id} ${saved.width}×${saved.height} ${(saved.bytes / 1024).toFixed(0)} KB (window capture)`)
      return saved
    },
    control: post,
    rpc: async (id, method, rpcInput, directory) =>
      (await post("rpc", { id, method, input: rpcInput ?? {}, directory })) as unknown as RpcResult,
    log: input.log,
    async dispose() {
      await Promise.all(pages.splice(0).map((opened) => opened.context().close().catch(() => undefined)))
    },
  }
}
