// `탐색기에서 열기` harness for Playwright (dev server only): the real App on the web host plus what the desktop app
// adds for it, as stand-ins that only write down what they were asked. No Explorer window and no program ever starts.
//   - `host.explorer` (05 §7.10): `reveal` and `launch` are kept in `__explorer.calls`; `pickProgram` stands in for
//     the desktop app's file dialog and "picks" PROGRAM; a template is kept only when it has `{path}` and no other
//     placeholder than `{host}`, as in the desktop app (own-desktop src/shared/explorer.ts `templateProblem`).
//   - `capabilities.openInApp` with recording `files.openPath` / `revealPath`, like e2e/files/harness.tsx.
// Query switches:
//   - `?program`: a program is already chosen.
//   - `?fail=<reason>[&detail=…]`: every reveal and launch fails that way (`blocked`, `outside`, `missing`, …).
//   - `?route=<path>`: the route to open first (`/srv/<host>/s/<id>` for an SSH conversation).
// `__explorer.router` is the memory router.
import "@/styles/index.css"
import { render } from "solid-js/web"
import { App } from "@/app"
import { createDataLayer } from "@/data"
import type { OwnHost } from "@/host"
import type { ExplorerFailure, ExplorerProgram, ExplorerResult, HostExplorer } from "@/host/types"
import { createWebHost } from "@/host/web"
import { createMemoryRouter } from "@/routing/router"

const DEFAULT_TEMPLATE = "--open {host} {path}"
const usable = (template: string) =>
  template.includes("{path}") &&
  [...template.matchAll(/\{([A-Za-z]+)\}/g)].every((match) => /^(host|path)$/.test(match[1]!))

const PROGRAM = "D:\\tools\\ssh-explorer.exe"

const params = new URLSearchParams(location.search)
const web = createWebHost()
const calls: unknown[][] = []
const state: { program: ExplorerProgram } = {
  program: params.has("program") ? { program: PROGRAM, template: DEFAULT_TEMPLATE } : { template: DEFAULT_TEMPLATE },
}
const fail = params.get("fail") as ExplorerFailure | null
const failure = (): ExplorerResult | undefined =>
  fail ? { ok: false, reason: fail, ...(params.has("detail") ? { detail: params.get("detail")! } : {}) } : undefined

const explorer: HostExplorer = {
  async reveal(path) {
    calls.push(["reveal", path])
    return failure() ?? { ok: true }
  },
  async launch(input) {
    calls.push(["launch", input.host, input.path])
    if (!state.program.program) return { ok: false, reason: "unconfigured" }
    return failure() ?? { ok: true }
  },
  program: async () => state.program,
  async pickProgram() {
    calls.push(["pick"])
    state.program = { program: PROGRAM, template: state.program.template }
    return state.program
  },
  async setTemplate(template) {
    calls.push(["template", template])
    if (usable(template.trim())) state.program = { ...state.program, template: template.trim() }
    return state.program
  },
  async clearProgram() {
    calls.push(["clear"])
    state.program = { template: state.program.template }
    return state.program
  },
}

const record =
  (method: string) =>
  async (...args: unknown[]) =>
    void calls.push([method, ...args])
const host: OwnHost = {
  ...web,
  capabilities: { ...web.capabilities, openInApp: true },
  files: { openPath: record("openPath"), revealPath: record("revealPath") },
  explorer,
}
const router = createMemoryRouter(`own.web.explorer.harness.${Date.now()}`)
const route = params.get("route")
if (route) router.navigate(route)
const data = createDataLayer({ host })

Object.assign(window, { __explorer: { calls, router, state } })

render(() => <App host={host} router={router} data={data} />, document.getElementById("root")!)
