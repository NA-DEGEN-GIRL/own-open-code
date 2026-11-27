// Shared helpers of the worktree + background suite: the backend state, the harness page, typed calls into
// `window.__wt`.
import fs from "node:fs"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

export interface WtState {
  readonly dev: string
  readonly control: string
  /** The Git project root (server-normalized). */
  readonly gitProject: string
  readonly projectID: string
  readonly seedSession: string
  readonly model: string
  readonly providerID: string
  readonly commands: { readonly long: string; readonly quick: string }
  /** The other account's model the `[preset-reject]` directive writes (`backend.ts` `REJECTED_MODEL`). */
  readonly rejectedModel: string
}

export function wtState(): WtState {
  const tmp = process.env.OWN_WEB_WTBG_TMP!
  return JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as WtState
}

export const shots = () => {
  const dir = process.env.OWN_WEB_WTBG_SHOTS ?? path.join(process.env.OWN_WEB_WTBG_TMP!, "shots")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function openHarness(page: Page, query = "") {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto(`/e2e/worktree-bg/harness.html${query}`)
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __wt?: { ready(): boolean } }).__wt?.ready() ?? false))
    .toBe(true)
  const state = wtState()
  await wt(page, "setup", {
    directory: state.gitProject,
    projectID: state.projectID,
    providerID: state.providerID,
    model: state.model,
  })
  return errors
}

type Api = Record<string, (...args: never[]) => unknown>

/** Calls `window.__wt[name](...args)` in the page and returns its (awaited) result. */
export function wt<T = unknown>(page: Page, name: string, ...args: unknown[]) {
  return page.evaluate(
    async ([method, params]) => {
      const target = (window as unknown as { __wt: Api }).__wt
      const fn = target[method] as (...values: unknown[]) => unknown
      return (await fn(...params)) as unknown
    },
    [name, args] as const,
  ) as Promise<T>
}

/** Waits until the session is idle (the fake answered and the turn ended). */
export async function idle(page: Page, sessionID?: string) {
  await expect
    .poll(() => wt<string>(page, "status", ...(sessionID ? [sessionID] : [])), { timeout: 60_000 })
    .toBe("idle")
}

/** Server paths compare case- and separator-insensitively on Windows. */
export const norm = (value: string | undefined) => (value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
