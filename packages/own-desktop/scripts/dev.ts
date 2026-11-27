// `bun run --cwd packages/own-desktop dev` (05 §11.2): the shell against own-web's Vite dev server and a development
// own service, all in one temp root.
//
//   bun scripts/dev.ts [--port 5173] [--cdp 9333] [--no-seed] [--logs] [--delay <ms per streamed chunk>]
//
//  1. development service: own-web's dev service (fake providers, seeded sessions) + its `service-local.json` in a
//     temp XDG_STATE_HOME (dev-service.ts). The dev shell only discovers (05 §5.1): it never starts a service.
//  2. own-web Vite dev server on 127.0.0.1:<port> (own-web's own config; HMR for the renderer).
//  3. `electron-vite dev` here: main and preload build and watch; no renderer server of its own (4.4), so
//     ELECTRON_RENDERER_URL stays own-web's. Env: OWN_DESKTOP_CHANNEL=local, XDG_STATE_HOME=<temp>, OWN_HOME=<dev
//     service home> (controlDir), OPENCODE_DESKTOP_TEST_ROOT=<temp>\desktop (unpackaged userData/session in the temp
//     root), OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT=<cdp> (never the default 9222, 05 §11.2 CDP warning).
// Prints the URLs and writes <tmp>/own-desktop-dev/state.json (no secrets). Ctrl+C, SIGTERM, a `stop` line on stdin
// or closing the shell's window stops everything (the Electron process tree too) and removes the temp root. Fake
// credentials only.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { createServer } from "vite"
import { removeTree } from "../../own-accounts/test/e2e-kit/harness/remove"
import { startRegisteredDevService } from "./dev-service"
import { electronExe } from "./electron-path"

const args = parseArgs({
  options: {
    port: { type: "string", default: process.env.OWN_WEB_DEV_PORT ?? "5173" },
    cdp: { type: "string" },
    "no-seed": { type: "boolean", default: false },
    logs: { type: "boolean", default: false },
    delay: { type: "string" },
  },
}).values

const PACKAGE = path.resolve(import.meta.dir, "..")
const WEB = path.resolve(PACKAGE, "../own-web")
export const STATE_FILE = path.join(os.tmpdir(), "own-desktop-dev", "state.json")

const root = await mkdtemp(path.join(os.tmpdir(), "own-desktop-dev-"))
const stateHome = path.join(root, "state")
const started = performance.now()
const dev = await startRegisteredDevService({
  stateHome,
  channel: "local",
  seed: !args["no-seed"],
  printLogs: args.logs,
  chunkDelayMs: args.delay === undefined ? undefined : Number(args.delay),
})
const port = Number(args.port)
const cdp = Number(args.cdp ?? (await freePort()))
Object.assign(process.env, {
  OWN_WEB_API_URL: dev.service.server.url,
  OWN_WEB_API_PASSWORD: dev.service.password,
  OWN_WEB_CONTROL_DIR: dev.service.control,
})
const vite = await createServer({
  configFile: path.join(WEB, "vite.config.ts"),
  root: WEB,
  server: { port, strictPort: true, host: "127.0.0.1" },
  logLevel: "warn",
})
await vite.listen()
const web = `http://127.0.0.1:${port}`

await mkdir(path.join(root, "desktop"), { recursive: true })
const shell = Bun.spawn([process.execPath, "x", "electron-vite", "dev"], {
  cwd: PACKAGE,
  env: {
    ...process.env,
    OWN_DESKTOP_CHANNEL: "local",
    ELECTRON_EXEC_PATH: electronExe(),
    ELECTRON_RENDERER_URL: web,
    XDG_STATE_HOME: stateHome,
    OWN_HOME: dev.ownHome,
    OPENCODE_DESKTOP_TEST_ROOT: path.join(root, "desktop"),
    OPENCODE_DESKTOP_REMOTE_DEBUGGING_PORT: String(cdp),
  },
  stdout: "inherit",
  stderr: "inherit",
})

const state = {
  pid: process.pid,
  shellPid: shell.pid,
  root,
  web,
  cdp: `http://127.0.0.1:${cdp}`,
  server: dev.service.server.url,
  registration: dev.registration,
  control: dev.service.control,
  sessions: dev.service.sessions.map((session) => ({ id: session.id, title: session.title })),
}
await mkdir(path.dirname(STATE_FILE), { recursive: true })
await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
console.log(
  [
    `own-desktop dev ready in ${Math.round(performance.now() - started)} ms`,
    `  renderer  ${web}`,
    `  service   ${dev.service.server.url} (registration ${dev.registration})`,
    `  CDP       ${state.cdp}`,
    `  state     ${STATE_FILE}`,
  ].join("\n"),
)

let stopping: Promise<void> | undefined
function stop() {
  stopping ??= (async () => {
    killTree(shell.pid)
    await Promise.allSettled([vite.close(), dev.service.stop()])
    await removeTree(root).catch(() => undefined)
    await rm(STATE_FILE, { force: true }).catch(() => undefined)
  })()
  return stopping
}
process.on("SIGINT", () => void stop().then(() => process.exit(0)))
process.on("SIGTERM", () => void stop().then(() => process.exit(0)))
// A `stop` line stops; end of input (a detached run without stdin) does not.
void (async () => {
  for await (const line of console) {
    if (line.trim() !== "stop") continue
    await stop()
    process.exit(0)
  }
})()
const code = await shell.exited
console.log(`own-desktop dev: shell exited (${code})`)
await stop()
process.exit(0)

/** electron-vite leaves Electron running when only it is killed; take the whole tree down. */
function killTree(pid: number) {
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
  else process.kill(pid, "SIGTERM")
}

async function freePort() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const value = server.port
  server.stop(true)
  return value
}
