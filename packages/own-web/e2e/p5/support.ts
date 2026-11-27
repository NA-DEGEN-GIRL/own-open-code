// Shared helpers of the P5 acceptance walkthrough: the backend state, API calls through the Vite proxy (server-side
// auth, the dev path of 03 §16.2), screenshots, sending from the real composer and waiting for turns.
import fs from "node:fs"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

export interface P5State {
  readonly dev: string
  readonly control: string
  readonly workspace: string
  readonly folders: { readonly plain: string; readonly hash: string }
  readonly mcp: string
  readonly model: string
  readonly accounts: Record<"alpha" | "bravo", { id: string; providerID: string; label: string }>
  readonly session: string
}

const tmp = process.env.OWN_WEB_P5_TMP!
export const shots = process.env.OWN_WEB_P5_SHOTS!
fs.mkdirSync(shots, { recursive: true })
export const state = JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as P5State

export const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shots, `${name}.png`) })

export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: string
}

export async function api<T>(page: Page, method: "GET" | "POST" | "DELETE", url: string, body?: unknown) {
  // A folder's Location that just booted loads own's plugins in the background (upstream v2.4.0 #63814): its RPC
  // answers `rpc.unavailable` until they registered, so that call is asked again for up to 60 s.
  const deadline = Date.now() + 60_000
  const response = await (async function send(): Promise<Awaited<ReturnType<typeof page.request.fetch>>> {
    const answer = await page.request.fetch(url, { method, data: body })
    if (answer.ok() || Date.now() > deadline || !(await answer.text()).includes('"rpc.unavailable"')) return answer
    await new Promise((resolve) => setTimeout(resolve, 250))
    return send()
  })()
  if (!response.ok()) throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export async function rpc<T>(page: Page, method: string, input: unknown, directory = state.workspace) {
  const body = await api<{ output: T }>(
    page,
    "POST",
    `/api/rpc/own.accounts/${method}?location%5Bdirectory%5D=${encodeURIComponent(directory)}`,
    { input },
  )
  return body.output
}

export async function sessionInfo(page: Page, sessionID: string) {
  return (
    await api<{ data: { id: string; parentID?: string; permissions?: Rule[]; location: { directory: string } } }>(
      page,
      "GET",
      `/api/session/${sessionID}`,
    )
  ).data
}

export async function messages(page: Page, sessionID: string) {
  return (
    await api<{ data: { id: string; type: string; text?: string; files?: { name?: string; uri: string }[] }[] }>(
      page,
      "GET",
      `/api/session/${sessionID}/message?limit=50`,
    )
  ).data
}

export async function pendingPermissions(page: Page, sessionID: string) {
  return (await api<{ data: { id: string; action: string }[] }>(page, "GET", `/api/session/${sessionID}/permission`))
    .data
}

/** The session on screen (`/srv/local/s/<id>`). */
export function currentSession(page: Page) {
  return new URL(page.url()).pathname.split("/").at(-1)!
}

/** Opens a session by URL and waits until the app is connected. */
export async function openSession(page: Page, sessionID: string) {
  await page.goto(`/srv/local/s/${sessionID}`)
  await ready(page)
}

export async function ready(page: Page) {
  await expect(page.getByTestId("server-status")).toHaveAttribute("data-status", "connected")
}

export const composer = (page: Page) => page.locator("#own-composer-input")

/**
 * Types a message into the real composer (no `@`/`/` at the start) and sends it with Ctrl+Enter, the default
 * `보내는 키` (03 §4.6); `modifier`: Alt+Enter, the other delivery while a turn runs.
 */
export async function send(page: Page, text: string, modifier = false) {
  const box = composer(page)
  await box.click()
  await box.fill(text)
  await box.press(modifier ? "Alt+Enter" : "Control+Enter")
  await expect(box).toHaveValue("")
}

/** The turn of the session on screen has ended (the stop button is gone). */
export async function idle(page: Page, timeout = 60_000) {
  await expect(page.getByTestId("composer-stop")).toBeHidden({ timeout })
}

/** Page errors: nothing in the walkthrough may throw. */
export function watchErrors(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  return errors
}
