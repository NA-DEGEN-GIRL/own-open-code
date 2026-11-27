// Shared helpers of the P7 acceptance walkthrough: the backend state, API calls through the Vite proxy (server-side
// auth, the dev path of 03 §16.2), screenshots, the real composer, and the scheme switch for light spot-checks.
import fs from "node:fs"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

export interface P7State {
  readonly dev: string
  readonly inspect: string
  readonly root: string
  readonly control: string
  readonly workspace: string
  readonly remote: string
  readonly configDir: string
  readonly model: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  readonly session: string
  readonly commands: { readonly long: string; readonly quick: string }
}

const tmp = process.env.OWN_WEB_P7_TMP!
export const shots = process.env.OWN_WEB_P7_SHOTS!
fs.mkdirSync(shots, { recursive: true })
export const state = JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as P7State

export const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) })

export async function api<T>(page: Page, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) {
  const response = await page.request.fetch(url, { method, data: body })
  if (!response.ok()) throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export interface MessageInfo {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly command?: string
  readonly files?: { name?: string; uri: string }[]
  readonly metadata?: Record<string, unknown>
}

/** Messages of a session, newest first (`GET /api/session/:id/message`). */
export async function messages(page: Page, sessionID: string) {
  const direct = await page.request.get(`/api/session/${sessionID}/message?limit=50`)
  if (direct.ok()) return ((await direct.json()) as { data: MessageInfo[] }).data
  const query = `location%5Bdirectory%5D=${encodeURIComponent((await sessionInfo(page, sessionID)).location.directory)}`
  return (await api<{ data: MessageInfo[] }>(page, "GET", `/api/session/${sessionID}/message?limit=50&${query}`)).data
}

/** The session exists on the server and its last turn ended (`idle` is the newest message). */
export async function answered(page: Page, sessionID: string, timeout = 90_000) {
  await expect.poll(async () => (await messages(page, sessionID).catch(() => []))[0]?.type, { timeout }).toBe("idle")
}

export interface SessionData {
  readonly id: string
  readonly title?: string
  readonly projectID: string
  readonly parentID?: string
  readonly metadata?: Record<string, unknown>
  readonly fork?: { sessionID: string }
  readonly location: { directory: string }
}

/**
 * A session's info. Session reads are location-scoped: a session in another folder (a worktree) is found through the
 * root list, then read at its own location.
 */
export async function sessionInfo(page: Page, sessionID: string): Promise<SessionData> {
  const direct = await page.request.get(`/api/session/${sessionID}`)
  if (direct.ok()) return ((await direct.json()) as { data: SessionData }).data
  const listed = (await api<{ data: SessionData[] }>(page, "GET", "/api/session?limit=100")).data.find(
    (item) => item.id === sessionID,
  )
  if (!listed) throw new Error(`session ${sessionID} not found`)
  const query = `location%5Bdirectory%5D=${encodeURIComponent(listed.location.directory)}`
  return (await api<{ data: SessionData }>(page, "GET", `/api/session/${sessionID}?${query}`)).data
}

/** The session on screen (`/srv/local/s/<id>`). */
export function currentSession(page: Page) {
  return new URL(page.url()).pathname.split("/").at(-1)!
}

/**
 * Before the app loads: new sessions start in `전체 허용` (no permission dock for the scripted shell tools; 18.1 has
 * its own suite) and the color scheme when given (dark is the default, 03 §13).
 */
export async function prepare(page: Page, scheme?: "light" | "dark") {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("own.web.approval.newSession", "full")
      if (value) localStorage.setItem("opencode-color-scheme", value)
    } catch {}
  }, scheme)
}

/** Opens a route and waits until the app is connected. */
export async function openPath(page: Page, route: string) {
  await page.goto(route)
  await ready(page)
}

export async function openSession(page: Page, sessionID: string) {
  await openPath(page, `/srv/local/s/${sessionID}`)
  await expect(page.locator(`[data-testid="transcript-body"][data-session-id="${sessionID}"]`)).toBeVisible()
}

export async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected", { timeout: 60_000 })
}

export const composer = (page: Page) => page.locator("#own-composer-input")

/** Types into the real composer (no `@`/`/`/`!` at the start) and sends with Enter. */
export async function send(page: Page, text: string) {
  const box = composer(page)
  await box.click()
  await box.fill(text)
  await box.press("Control+Enter")
  await expect(box).toHaveValue("")
}

/** The turn of the session on screen has ended (the stop button is gone). */
export async function idle(page: Page, timeout = 60_000) {
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout })
}

/**
 * A new session in the workspace through the real composer (new-session screen → first prompt). `/` starts without a
 * project, in the default conversation folder (03 §5.1), so the workspace is picked from the selector's recent list.
 */
export async function newSession(page: Page, text: string) {
  await openPath(page, "/")
  await page.getByTestId("project-select").click()
  await page.getByTestId("project-select-item").filter({ hasText: state.workspace }).first().click()
  await expect(page).toHaveURL(/\/srv\/local\/p\//)
  await send(page, text)
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/s\/ses_/)
  const id = currentSession(page)
  await answered(page, id)
  return id
}

/** Page errors: nothing in the walkthrough may throw. */
export function watchErrors(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}

/** The scheme the page paints with (`data-color-scheme` on <html>). */
export const scheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-color-scheme"))

/** Sends from the real composer and waits until that turn ended on the server (a new newest `idle`). */
export async function turn(page: Page, sessionID: string, text: string) {
  const before = (await messages(page, sessionID))[0]?.id
  await send(page, text)
  await expect
    .poll(
      async () => {
        const newest = (await messages(page, sessionID))[0]
        return newest?.type === "idle" && newest.id !== before
      },
      { timeout: 90_000 },
    )
    .toBe(true)
}
