// Shared helpers of the timeline-ops suite: the backend state, the harness page, and typed calls into `window.__ops`.
import fs from "node:fs"
import path from "node:path"
import { expect, type Page } from "@playwright/test"

export interface OpsState {
  readonly dev: string
  readonly control: string
  readonly workspace: string
  /** A git repository (snapshots, so file revert works). */
  readonly gitProject: string
  readonly model: string
  readonly accounts: Record<
    "alpha" | "bravo",
    { readonly id: string; readonly providerID: string; readonly label: string }
  >
}

export function opsState(): OpsState {
  const tmp = process.env.OWN_WEB_OPS_TMP!
  return JSON.parse(fs.readFileSync(path.join(tmp, "backend.json"), "utf8")) as OpsState
}

export const shots = () => {
  const dir = path.join(process.env.OWN_WEB_OPS_TMP!, "shots")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function openHarness(page: Page) {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/e2e/timeline-ops/harness.html")
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ops?: { ready(): boolean } }).__ops?.ready() ?? false))
    .toBe(true)
  return errors
}

type Ops = Record<string, (...args: never[]) => unknown>

/** Calls `window.__ops[name](...args)` in the page and returns its (awaited) result. */
export function ops<T = unknown>(page: Page, name: string, ...args: unknown[]) {
  return page.evaluate(
    async ([method, params]) => {
      const target = (window as unknown as { __ops: Ops }).__ops
      const fn = target[method] as (...values: unknown[]) => unknown
      return (await fn(...params)) as unknown
    },
    [name, args] as const,
  ) as Promise<T>
}

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

export async function createSession(
  page: Page,
  title: string,
  options: { readonly permissions?: Rule[]; readonly account?: "alpha" | "bravo"; readonly directory?: string } = {},
) {
  const state = opsState()
  const id = await ops<string>(page, "create", {
    title,
    providerID: state.accounts[options.account ?? "alpha"].providerID,
    model: state.model,
    directory: options.directory ?? state.workspace,
    permissions: options.permissions ?? [],
  })
  await expect(page.getByTestId("ops-header")).toContainText(title)
  return id
}

/** Waits until the session is idle (the fake answered and the turn ended). */
export async function idle(page: Page, sessionID?: string) {
  await expect
    .poll(() => ops<string>(page, "status", ...(sessionID ? [sessionID] : [])), { timeout: 30_000 })
    .toBe("idle")
}
