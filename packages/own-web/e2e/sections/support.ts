import fs from "node:fs"
import path from "node:path"
import { expect, type Locator, type Page } from "@playwright/test"

interface State {
  readonly dev: string
  readonly front: string
  readonly hostToken: string
  readonly hostControl: string
  readonly local: { readonly sessions: Record<string, string>; readonly control: string }
  readonly host: { readonly sessions: Record<string, string> }
}

export const state: State = JSON.parse(
  fs.readFileSync(path.join(process.env.OWN_WEB_SECTIONS_E2E_TMP!, "backend.json"), "utf8"),
)

const SHOTS = process.env.OWN_WEB_SECTIONS_SHOTS!

export async function shot(target: Page | Locator, name: string) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

export function url(switches = "hosts=ubuntu&pcs") {
  const query = new URLSearchParams({
    front: state.front,
    token: state.hostToken,
    control: state.hostControl,
    ...Object.fromEntries(new URLSearchParams(switches)),
  })
  return `/e2e/sections/harness.html?${query}`
}

/** Opens the harness with the lists and the lazy reordering there. */
export async function open(page: Page, switches?: string) {
  await page.goto(url(switches))
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
  await expect(section(page, "local").getByTestId("session-row").first()).toBeAttached({ timeout: 60_000 })
  if (!switches || /hosts=[^&]*ubuntu/.test(switches))
    await expect(section(page, "h-ubuntu").getByTestId("session-row").first()).toBeAttached({ timeout: 60_000 })
  await expect(page.getByTestId("sidebar-announce")).toBeAttached()
}

export const section = (page: Page, key: string) => page.locator(`[data-testid="server-section"][data-server="${key}"]`)

/** Section keys in the order shown. */
export const servers = (page: Page) =>
  page.getByTestId("server-section").evaluateAll((list) => list.map((item) => (item as HTMLElement).dataset.server!))

export const project = (page: Page, key: string, name: string) =>
  section(page, key)
    .getByTestId("project-row")
    .filter({ has: page.getByText(name, { exact: true }) })

/** Project names of a section in the order shown. */
export const projects = (page: Page, key: string) =>
  section(page, key)
    .getByTestId("project-row")
    .evaluateAll((list) => list.map((item) => item.querySelector("span.truncate")!.textContent!))

/** This service's and the host's lists as at the start. */
export async function resetLists(page: Page) {
  for (const base of [
    { url: state.dev, headers: {} as Record<string, string>, control: state.local.control },
    {
      url: state.front,
      headers: { authorization: `Basic ${btoa(`opencode:${state.hostToken}`)}` },
      control: state.hostControl,
    },
  ])
    await page.request.post(`${base.url}/api/rpc/own.accounts/projectList.set`, {
      params: { "location[directory]": base.control },
      headers: base.headers,
      data: { input: { pinned: [], order: null } },
    })
}

/** A touch at (x, y) through DevTools, as a finger: the steps are moves `[dx, dy, waitMs]` from where it is. */
export async function touch(
  page: Page,
  from: { readonly x: number; readonly y: number },
  steps: readonly (readonly [dx: number, dy: number, wait: number])[],
  finish: "touchEnd" | "touchCancel" = "touchEnd",
) {
  const client = await page.context().newCDPSession(page)
  const at = { ...from }
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] })
  for (const [dx, dy, wait] of steps) {
    at.x += dx
    at.y += dy
    if (dx || dy) await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...at }] })
    if (wait) await page.waitForTimeout(wait)
  }
  await client.send("Input.dispatchTouchEvent", { type: finish, touchPoints: [] })
  await client.detach()
}

export async function centre(target: Locator) {
  const box = (await target.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
