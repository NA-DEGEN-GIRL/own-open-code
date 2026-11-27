// Shared helpers of the composer-plus specs: backend state, sessions through the Vite proxy (it adds the server
// password), opening the harness on a session, the server's messages, and a real Chromium IME composition over CDP.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, type APIRequestContext, type Page } from "@playwright/test"
import type { Route } from "@/routing/routes"

export interface ComposerPlusState {
  readonly dev: string
  readonly control: string
  readonly workspace: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  readonly model: string
  readonly failMark: string
}

export function backend(): ComposerPlusState {
  const tmp = process.env.OWN_WEB_COMPOSER_PLUS_TMP ?? path.join(os.tmpdir(), "own-web-composer-plus")
  return JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as ComposerPlusState
}

/** A session in the workspace with the fake model; each prompt of `turns` runs to the end. */
export async function newSession(request: APIRequestContext, title: string, turns: readonly string[] = []) {
  const state = backend()
  const created = await request.post("/api/session", {
    data: {
      title,
      model: { providerID: state.account.providerID, id: state.model },
      location: { directory: state.workspace },
    },
  })
  expect(created.ok()).toBe(true)
  const body = (await created.json()) as { id?: string; data?: { id: string } }
  const id = body.data?.id ?? body.id ?? ""
  for (const text of turns) {
    expect((await request.post(`/api/session/${id}/prompt`, { data: { text } })).ok()).toBe(true)
    await request.post(`/api/experimental/session/${id}/wait`)
  }
  return id
}

export async function openHarness(page: Page, route: Route) {
  await page.goto("/e2e/composer-plus/harness.html")
  await page.waitForFunction(() => window.__composerPlus?.ready() === true)
  await page.evaluate((next) => window.__composerPlus!.navigate(next), route)
  const textarea = page.locator("#own-composer-input")
  await textarea.focus()
  return textarea
}

export const sessionRoute = (sessionID: string): Route => ({ name: "session", serverKey: "local", sessionID })

export interface ServerMessage {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly command?: string
  readonly skills?: readonly { readonly id: string }[]
  readonly status?: string
  readonly shell?: { readonly command?: string }
}

/** Oldest first (the API answers newest first). */
export async function messages(request: APIRequestContext, sessionID: string): Promise<ServerMessage[]> {
  const response = await request.get(`/api/session/${sessionID}/message`, { params: { order: "desc", limit: 200 } })
  if (!response.ok()) return []
  return ((await response.json()) as { data: ServerMessage[] }).data.toReversed()
}

export async function sessionInfo(request: APIRequestContext, sessionID: string) {
  const response = await request.get(`/api/session/${sessionID}`)
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { data?: Record<string, unknown> } & Record<string, unknown>
  return (body.data ?? body) as {
    id: string
    parentID?: string
    fork?: { sessionID: string }
    metadata?: Record<string, unknown>
  }
}

/** Starts a Korean composition through CDP `Input.imeSetComposition` (the Windows IME in Edge, 03 §12). */
export async function compose(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page)
  for (let end = 1; end <= text.length; end++)
    await cdp.send("Input.imeSetComposition", { text: text.slice(0, end), selectionStart: end, selectionEnd: end })
  return {
    /** A key while composing (keyCode 229, the IME keeps it). */
    async key(key: string, code = key) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key,
        code,
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
      })
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: 229 })
    },
    /** Enter while composing, then the commit (order A2: no second keydown). */
    async enterCommit() {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
      })
      await cdp.send("Input.insertText", { text })
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      })
    },
    async commit() {
      await cdp.send("Input.insertText", { text })
    },
    detach: () => cdp.detach(),
  }
}

/** A small PNG pasted into the textarea the way a screenshot paste arrives (a file on the clipboard). */
export async function pasteImage(page: Page, name = "screenshot.png") {
  await page.evaluate((fileName) => {
    const bytes = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (char) => char.charCodeAt(0),
    )
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], fileName, { type: "image/png" }))
    const textarea = document.getElementById("own-composer-input")!
    textarea.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, name)
}
