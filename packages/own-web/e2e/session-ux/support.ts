// Shared helpers of the session-UX suite: the backend state, the two harness pages, typed calls into `window.__ux`,
// and the fake provider's recorded model requests.
import fs from "node:fs"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

export interface UxState {
  readonly dev: string
  readonly inspect: string
  readonly control: string
  readonly workspace: string
  readonly model: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  readonly seeded: readonly { readonly id: string; readonly title: string; readonly updated: number }[]
}

export function uxState(): UxState {
  const tmp = process.env.OWN_WEB_SESSION_UX_TMP!
  return JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as UxState
}

export const shots = () => {
  const dir = process.env.OWN_WEB_SESSION_UX_SHOTS ?? path.join(process.env.OWN_WEB_SESSION_UX_TMP!, "shots")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function pageErrors(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

export async function openHarness(page: Page) {
  const errors = pageErrors(page)
  await page.goto("/e2e/session-ux/harness.html")
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ux?: { ready(): boolean } }).__ux?.ready() ?? false))
    .toBe(true)
  return errors
}

type Api = Record<string, (...args: never[]) => unknown>

/** Calls `window.__ux[name](...args)` in the page and returns its (awaited) result. */
export function ux<T = unknown>(page: Page, name: string, ...args: unknown[]) {
  return page.evaluate(
    async ([method, params]) => {
      const target = (window as unknown as { __ux: Api }).__ux
      const fn = target[method] as (...values: unknown[]) => unknown
      return (await fn(...params)) as unknown
    },
    [name, args] as const,
  ) as Promise<T>
}

export async function createSession(page: Page, title: string) {
  const state = uxState()
  const id = await ux<string>(page, "create", {
    title,
    providerID: state.account.providerID,
    model: state.model,
    directory: state.workspace,
  })
  await expect(page.getByTestId("ux-title")).toHaveText(title)
  return id
}

/** One finished turn: prompt, then wait until the session is idle again. */
export async function turn(page: Page, text: string, id?: string) {
  await ux(page, "prompt", text, ...(id ? [id] : []))
  await ux(page, "wait", ...(id ? [id] : []))
}

export interface ModelRequest {
  readonly seq: number
  readonly instructions: unknown
  readonly input: readonly unknown[]
}

export async function modelRequests(page: Page): Promise<ModelRequest[]> {
  const response = await page.request.get(`${uxState().inspect}/requests`)
  return (await response.json()) as ModelRequest[]
}
