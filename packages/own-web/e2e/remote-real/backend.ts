// Real-host own-web backend (04 §20.3 RG13 web fallback, RG16): own-web's Vite dev server in front of the real-host
// full stack of own-remote's `test/real-host/stack.ts` (this PC's release service, fake providers, the approved host's
// running own service from the real-host phases). Opt-in: OWN_REAL_HOST=dev-host, after own-remote's phase A.
// Run by Playwright's webServer (`e2e/remote-real/playwright.config.ts`) or by hand (`bun e2e/remote-real/backend.ts`).
import fs from "node:fs"
import path from "node:path"
import { startViteDev } from "../vite-dev"
import * as Env from "../../../own-remote/test/real-host/env"
import * as Stack from "../../../own-remote/test/real-host/stack"
import { DEV_PORT, STATE_FILE } from "./support"

if (!Env.enabled) {
  console.error(`own-web real-host e2e needs OWN_REAL_HOST=${Env.APPROVED} on Windows`)
  process.exit(1)
}

const stack = await Stack.startStack({
  // The answer names the account whose key the request carried (the fake sees only hashed credentials).
  responder: (request) => ({ type: "text", text: `${request.identity ?? "unknown"} 계정으로 온 답 (실제 호스트)` }),
})
const uid = Env.kv((await Env.hostSh("echo UID=$(id -u)")).stdout).get("UID")!
const project = `/tmp/own-${uid}-rh-web`
await Env.hostSh(
  `umask 077; mkdir -p "${project}" && printf '# own-web real host\\n' > "${project}/README.md" && cd "${project}" && git init -q 2>/dev/null; echo ok`,
)
// The PC-only account (the same one the host's sessions of the own-remote phases used, its key given back).
const alpha = await Stack.ensureCompat(stack, "Alpha")
await Stack.ensureCompat(stack, "Bravo")
const password = atob(stack.server.authorization.slice("Basic ".length)).slice("opencode:".length)
Object.assign(process.env, {
  OWN_WEB_API_URL: stack.server.url,
  OWN_WEB_API_PASSWORD: password,
  OWN_WEB_CONTROL_DIR: stack.control,
})
const dev = await startViteDev({ port: DEV_PORT, watch: null, hmr: false })

fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
fs.writeFileSync(
  STATE_FILE,
  JSON.stringify(
    {
      dev: `http://127.0.0.1:${DEV_PORT}`,
      control: stack.control,
      localServer: stack.server.url,
      localPassword: password,
      hostId: stack.hostId,
      alias: Env.ALIAS,
      project,
      account: { id: alpha.id, providerID: alpha.providerID },
      model: Stack.MODEL,
      keys: Object.values(Stack.KEYS),
      evidence: Env.EVIDENCE,
    },
    null,
    2,
  ),
)
dev.ready()
console.log(`OWN_WEB_E2E_REMOTE_REAL_READY ${DEV_PORT}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  Env.evidence("web-sink.txt", stack.sink.lines.join("\n"))
  Env.evidence(
    "web-provider-requests.json",
    stack.chat.requests.map((request) => ({ at: request.at, path: request.path, status: request.status, identity: request.identity })),
  )
  await stack.local("own.remote", "disconnect", { hostId: stack.hostId }).catch(() => undefined)
  await dev.close().catch(() => undefined)
  await stack.stop().catch(() => undefined)
  fs.rmSync(STATE_FILE, { force: true })
  fs.rmSync(STOP_FILE, { force: true })
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
process.stdin.on("end", () => void stop())
process.stdin.resume()
const STOP_FILE = path.join(path.dirname(STATE_FILE), "stop")
fs.rmSync(STOP_FILE, { force: true })
setInterval(() => fs.existsSync(STOP_FILE) && void stop(), 1_000)
