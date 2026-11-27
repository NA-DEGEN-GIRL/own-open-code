// `bun run dev:service` (packages/own-web): the development service from dev/service.ts plus the Vite dev server
// with the `/api` proxy (server-side Basic auth, 03 §16.2), and optionally `vite preview` of `dist/`.
//
//   bun dev/serve.ts [--port 5173] [--preview] [--no-vite] [--logs] [--delay <ms per streamed chunk>]
//
// Prints the URLs and writes a state file (no secrets) to `<tmp>/own-web-dev/state.json` for scripts such as the
// Playwright walkthrough (e2e/integration). Vite dev starts through e2e/vite-dev.ts: a dependency cache per port, every
// module transformed before the URLs are printed (about 12 s), and a port that answers 503 until the state file is
// written. Stops on Ctrl+C, SIGTERM or a `stop` line on stdin. Fake credentials only; the temp root is removed on exit,
// and a dead previous run's root is removed on the next start.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { preview } from "vite"
import { startViteDev } from "../e2e/vite-dev"
import { startDevService } from "./service"

const args = parseArgs({
  options: {
    port: { type: "string", default: process.env.OWN_WEB_DEV_PORT ?? "5173" },
    preview: { type: "boolean", default: false },
    "no-vite": { type: "boolean", default: false },
    logs: { type: "boolean", default: false },
    delay: { type: "string" },
  },
}).values
const PACKAGE = path.resolve(import.meta.dirname, "..")
export const STATE_FILE = path.join(os.tmpdir(), "own-web-dev", "state.json")

const stale = (await Bun.file(STATE_FILE)
  .json()
  .catch(() => undefined)) as { root?: string; pid?: number } | undefined
if (stale?.root?.includes("own-web-dev-") && stale.pid && !alive(stale.pid))
  await fs.rm(stale.root, { recursive: true, force: true }).catch(() => undefined)

const started = performance.now()
const service = await startDevService({
  printLogs: args.logs,
  chunkDelayMs: args.delay === undefined ? undefined : Number(args.delay),
})
Object.assign(process.env, {
  OWN_WEB_API_URL: service.server.url,
  OWN_WEB_API_PASSWORD: service.password,
  OWN_WEB_CONTROL_DIR: service.control,
})
const port = Number(args.port)
const dev = args["no-vite"] ? undefined : await startViteDev({ port })
const previewServer = args.preview
  ? await preview({
      configFile: path.join(PACKAGE, "vite.config.ts"),
      root: PACKAGE,
      preview: { port: port + 1, strictPort: true, host: "127.0.0.1" },
      logLevel: "warn",
    })
  : undefined

const state = {
  pid: process.pid,
  root: service.root,
  web: dev ? `http://127.0.0.1:${port}` : null,
  preview: previewServer ? `http://127.0.0.1:${port + 1}` : null,
  server: service.server.url,
  control: service.control,
  workspace: service.workspace,
  secondProject: service.secondProject,
  legacyRoot: service.legacyRoot,
  model: service.model,
  accounts: service.accounts,
  legacy: service.legacy,
  sessions: service.sessions,
}
await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
await Bun.write(STATE_FILE, JSON.stringify(state, null, 2))
dev?.ready()
console.log(
  [
    `own-web dev service ready in ${Math.round(performance.now() - started)} ms`,
    state.web && `  web      ${state.web}   (Vite dev, /api proxied with server-side Basic auth)`,
    state.preview && `  preview  ${state.preview}   (dist/, production bundle)`,
    `  server   ${state.server}   (password stays in this process)`,
    `  accounts ${Object.values(service.accounts)
      .map((account) => account.label)
      .join(", ")}; old-app profiles (fake) ${service.legacy.map((profile) => profile.alias).join(", ")}`,
    `  state    ${STATE_FILE}`,
  ]
    .filter(Boolean)
    .join("\n"),
)
console.log(`OWN_WEB_DEV_READY ${JSON.stringify({ web: state.web, preview: state.preview })}`)

// Vite exits the process on SIGTERM and on stdin EOF (a background shell has no stdin), skipping the cleanup below.
process.stdin.removeAllListeners("end")
process.removeAllListeners("SIGTERM")

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await Promise.allSettled([dev?.close(), previewServer?.close()])
  await service.stop()
  await fs.rm(STATE_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  if (chunk.trim() === "stop") void stop()
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
