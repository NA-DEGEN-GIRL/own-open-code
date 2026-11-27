// Shared helpers of the composer-ext specs: backend state, opening the harness on a session, reading the server's
// messages through the Vite proxy (it adds the server password), and a real Chromium IME composition over CDP.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect, type APIRequestContext, type Page } from "@playwright/test"
import type { Route } from "@/routing/routes"

export interface ComposerExtState {
  readonly dev: string
  readonly control: string
  readonly workspace: string
  readonly account: { readonly id: string; readonly providerID: string; readonly label: string }
  readonly model: string
  readonly session: string
  readonly bigFiles: number
}

export function backend(): ComposerExtState {
  const tmp = process.env.OWN_WEB_COMPOSER_EXT_TMP ?? path.join(os.tmpdir(), "own-web-composer-ext")
  return JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as ComposerExtState
}

export async function newSession(request: APIRequestContext, title: string, withTurn = false) {
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
  if (withTurn) {
    expect((await request.post(`/api/session/${id}/prompt`, { data: { text: "첫 질문입니다" } })).ok()).toBe(true)
    await request.post(`/api/experimental/session/${id}/wait`)
  }
  return id
}

export async function openHarness(page: Page, route: Route) {
  await page.goto("/e2e/composer-ext/harness.html")
  await page.waitForFunction(() => window.__harness?.ready() === true)
  await page.evaluate((next) => window.__harness!.navigate(next), route)
  const textarea = page.locator("#own-composer-input")
  await textarea.focus()
  return textarea
}

export interface ServerMessage {
  readonly id: string
  readonly type: string
  readonly text?: string
  readonly files?: readonly {
    readonly name?: string
    readonly mime?: string
    readonly source?: { readonly uri?: string }
  }[]
  readonly agents?: readonly { readonly name: string }[]
  readonly skills?: readonly { readonly id: string; readonly text?: string }[]
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
  return (body.data ?? body) as { agent?: string; revert?: { messageID: string }; fork?: unknown }
}

/** Types through CDP `Input.imeSetComposition` like the Windows Korean IME in Edge (03 §12, order A2). */
export async function compose(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page)
  for (let end = 1; end <= text.length; end++)
    await cdp.send("Input.imeSetComposition", { text: text.slice(0, end), selectionStart: end, selectionEnd: end })
  return {
    /** Enter while composing (keyCode 229), then the commit; no second keydown (A2). */
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
    /** An arrow key while composing (229, the IME keeps it). */
    async arrowDown() {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
      })
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "ArrowDown",
        code: "ArrowDown",
        windowsVirtualKeyCode: 40,
      })
    },
    detach: () => cdp.detach(),
  }
}

export const options = (page: Page) => page.getByTestId("suggest-option")
