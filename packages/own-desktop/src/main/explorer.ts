// `탐색기에서 열기` / `탐색기에서 보기` in main (05 §7.10), behind the `explorer` plugin Ipc (src/explorer/main.ts).
// Only a click in own-web reaches it: the Ipc answers the renderer's top frame alone, and no route of the service, no
// tool and no agent can ask for it.
//  - reveal: a path of this PC. Main asks the service which folders are open (every project's folder and worktree
//    folders) and refuses anything outside them, then opens a folder in Explorer or shows a file selected in its
//    folder. It never opens a file: a file is only ever shown.
//  - launch: a path on an SSH host. Main starts the program the user chose in 설정 with arguments from the template
//    (src/shared/explorer.ts), as an argument list, never through a shell, detached and without waiting.
// Electron and the service stay behind `ExplorerDeps`, so test/explorer.test.ts runs all of it with stand-ins and
// never opens a window on the PC it runs on.
import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import path from "node:path"
import {
  expandTemplate,
  insideRoots,
  programFile,
  storedProgram,
  templateProblem,
  type ExplorerProgram,
  type ExplorerResult,
} from "../shared/explorer"

export const EXPLORER_KEY = "ownExplorerProgram"

export type Launched = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }

export interface ExplorerDeps {
  /** Folders the service has open; `undefined` when it did not answer. */
  readonly roots: () => Promise<readonly string[] | undefined>
  readonly kind: (target: string) => Promise<"directory" | "file" | undefined>
  /** Opens a folder in Explorer; the failure text, or "" when it opened. */
  readonly openFolder: (folder: string) => Promise<string>
  /** Opens the file's folder with the file selected. */
  readonly showItem: (file: string) => void
  readonly launch: (program: string, args: readonly string[]) => Promise<Launched>
  /** The native file dialog for the program; `undefined` when the user cancelled. */
  readonly pick: (window: number, current: string | undefined) => Promise<string | undefined>
  readonly read: () => unknown
  readonly write: (value: ExplorerProgram) => void
  readonly log: (message: string, data: Record<string, unknown>) => void
}

export function createExplorer(deps: ExplorerDeps) {
  const program = () => storedProgram(deps.read())
  const keep = (next: ExplorerProgram) => {
    deps.write(next)
    return next
  }
  return {
    program,
    async reveal(target: string): Promise<ExplorerResult> {
      const roots = await deps.roots()
      if (!roots) return { ok: false, reason: "service" }
      if (!insideRoots(roots, target)) {
        deps.log("explorer reveal refused: outside the open folders", { target })
        return { ok: false, reason: "outside" }
      }
      const resolved = path.resolve(target)
      const kind = await deps.kind(resolved)
      if (!kind) return { ok: false, reason: "missing" }
      if (kind === "file") {
        deps.showItem(resolved)
        return { ok: true }
      }
      // Checked to be a folder right above: opening a folder shows it, where opening a file would run it.
      const failure = await deps.openFolder(resolved)
      return failure ? { ok: false, reason: "failed", detail: failure } : { ok: true }
    },
    async launch(input: { readonly host: string; readonly path: string }): Promise<ExplorerResult> {
      const config = program()
      if (!config.program) return { ok: false, reason: "unconfigured" }
      const expanded = expandTemplate(config.template, input)
      if (!expanded.ok) {
        deps.log("explorer launch refused", { reason: expanded.reason })
        return expanded
      }
      if ((await deps.kind(config.program)) !== "file") return { ok: false, reason: "program", detail: config.program }
      const launched = await deps.launch(config.program, expanded.args)
      if (launched.ok) return { ok: true }
      deps.log("explorer launch failed", { program: config.program, code: launched.code, message: launched.message })
      return { ok: false, reason: launchFailure(launched.code), detail: `${launched.code}: ${launched.message}` }
    },
    /** The program comes from the native dialog alone: the page never names a file to start. */
    async pick(window: number): Promise<ExplorerProgram> {
      const current = program()
      const picked = await deps.pick(window, current.program)
      if (!picked || !programFile(picked)) return current
      return keep({ program: picked, template: current.template })
    },
    setTemplate(template: string): ExplorerProgram {
      const current = program()
      const text = template.trim()
      if (templateProblem(text)) return current
      return keep({ ...current, template: text })
    },
    clear(): ExplorerProgram {
      return keep({ template: program().template })
    },
  }
}

export type Explorer = ReturnType<typeof createExplorer>

/**
 * ENOENT: the file went away after the check. UNKNOWN is what Windows answers when Smart App Control (or another
 * policy) refuses an unsigned program; EACCES and EPERM are permission refusals. The app reports it and never retries
 * another way.
 */
export function launchFailure(code: string): "program" | "blocked" | "failed" {
  if (code === "ENOENT") return "program"
  if (code === "UNKNOWN" || code === "EACCES" || code === "EPERM") return "blocked"
  return "failed"
}

/**
 * Starts `program` with `args` as its argument list: no shell, its own process group, no pipes, not waited for. The
 * answer comes with the `spawn` or `error` event, so a refused start is known and a running program is left alone.
 * `hidden` is for the tests' console stand-in; the user's program shows its window.
 */
export function launchDetached(program: string, args: readonly string[], hidden = false): Promise<Launched> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], {
      cwd: path.dirname(program),
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: hidden,
    })
    child.once("error", (error: NodeJS.ErrnoException) =>
      resolve({ ok: false, code: error.code ?? "UNKNOWN", message: error.message }),
    )
    child.once("spawn", () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

export async function pathKind(target: string): Promise<"directory" | "file" | undefined> {
  const info = await stat(target).catch(() => undefined)
  if (!info) return undefined
  return info.isDirectory() ? "directory" : "file"
}

/**
 * The folders this PC's service has open: every project's folder and every folder of its worktree table (the folders
 * conversations run in, managed worktrees included). Two read-only routes of the public API; nothing is created.
 * `undefined` when the service is not there or did not answer in time.
 */
export async function serviceRoots(
  endpoint: { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined,
  request: typeof fetch = fetch,
): Promise<string[] | undefined> {
  if (!endpoint) return undefined
  const read = (route: string) =>
    request(new URL(route, endpoint.url), { headers: endpoint.headers, signal: AbortSignal.timeout(ROOTS_TIMEOUT_MS) })
      .then((response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
      .catch(() => undefined)
  const projects = await read("/api/project")
  if (!Array.isArray(projects)) return undefined
  const worktrees = await Promise.all(
    projects.map((project) => read(`/api/worktree?projectID=${encodeURIComponent(text(project, "id") ?? "")}`)),
  )
  return [
    ...projects.map((project) => text(project, "canonical")),
    ...worktrees.flatMap((list) => (Array.isArray(list) ? list.map((item) => text(item, "directory")) : [])),
  ].filter((value) => value !== undefined)
}

const ROOTS_TIMEOUT_MS = 3_000

function text(value: unknown, key: string) {
  const member = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined
  return typeof member === "string" && member ? member : undefined
}
