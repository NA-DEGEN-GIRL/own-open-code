// Two short live checks of omo (원본) through own-omo (own/docs/15 §3.3, §3.4; decisions OMP) on DeepSeek V4 Pro
// through the live kit's forwarder:
//   reset  a context reset (core P-035) asked for while a turn that leaves todos open runs: nothing is continued into
//          the emptied context (no omo notice and no model request after the reset's marker).
//   error  a request error (one HTTP 400 injected between the server and the forwarder, for the request after the
//          first todowrite) makes omo stop continuing; the user's next message lets omo continue the open todos again
//          (one `omo: 남은 할 일을 이어서 해요` notice; the session is interrupted then, to keep the check short).
//   bun script/live/omo-checks.ts [--out <dir>]      (from packages/own-harness; omo runtime: OWN_OMO_RUNTIME or the
//                                                     source build own/.out/omo)
// Credentials stay in the forwarder process; the server's config holds placeholders. Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { REPO_ROOT, opencodeConfig, startOpencodeServer, type OpencodeServer } from "../../../own-accounts/test/e2e-kit"
import { startForwarder } from "./forwarder.js"

const args = process.argv.slice(2)
const at = args.indexOf("--out")
const OUT = path.resolve(at >= 0 ? args[at + 1]! : path.join(process.env.TEMP ?? "/tmp", "own-live-omo-checks"))
const MODEL = { providerID: "deepseek", id: "deepseek-v4-pro", variant: "high" }
const PERMISSIONS = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
]
const RESET_TASK =
  "RESETCHK: Use todowrite to create exactly three pending todos: 'write r1.txt', 'write r2.txt', 'write r3.txt'. " +
  "Then create r1.txt containing the text r1, mark that todo completed with todowrite, and reply with the single word " +
  "paused. Do not work on the other two todos in this reply."
const ERROR_TASK =
  "ERRCHK: Use todowrite to create exactly three pending todos: 'write e1.txt', 'write e2.txt', 'write e3.txt'. " +
  "Do not work on them yet."
const ERROR_NEXT =
  "ERRCHK: Reply with one short sentence naming the first todo. Do not use any tools and do not work on the todos in " +
  "this reply."

type Message = Record<string, any>

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const forwarder = startForwarder(path.join(OUT, "forwarder.jsonl"))
  // Between the server and the forwarder: one HTTP 400 for the error check's request after its first todowrite.
  const injected: Array<string> = []
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" ? undefined : await request.text()
      const json = body === undefined ? undefined : (JSON.parse(body || "{}") as { messages?: Array<{ role?: string }> })
      if (injected.length === 0 && body?.includes("ERRCHK") && json?.messages?.at(-1)?.role === "tool") {
        injected.push(new Date().toISOString())
        return Response.json({ error: { message: "Injected bad request (live check)", type: "invalid_request_error" } }, { status: 400 })
      }
      const headers = new Headers(request.headers)
      headers.delete("host")
      headers.delete("content-length")
      return fetch(`${forwarder.url}${url.pathname}${url.search}`, { method: request.method, headers, body })
    },
  })
  const server = await startOpencodeServer({
    startupTimeoutMs: 480_000,
    projectConfig: true,
    keepTemp: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) => {
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          deepseek: {
            name: "DeepSeek",
            canonical: "deepseek",
            package: "@opencode/ai/providers/deepseek",
            settings: { baseURL: `http://127.0.0.1:${proxy.port}/deepseek`, apiKey: "forwarded" },
            models: { "deepseek-v4-pro": { name: "deepseek-v4-pro" } },
          },
        },
        model: "deepseek/deepseek-v4-pro",
        plugins: [
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
          { package: path.join(REPO_ROOT, "packages/own-omo"), options: {} },
        ],
      })
    },
  })
  console.log(`server ${server.url} root ${server.paths.root}`)
  try {
    for (let attempt = 1; !(await server.waitForModels([MODEL], 60_000).then(() => true, () => false)); attempt++)
      if (attempt === 10) throw new Error("models never listed")
    const reset = await resetCheck(server)
    const error = await errorCheck(server, injected)
    const requests = fs
      .readFileSync(path.join(OUT, "forwarder.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.includes('"deepseek"') || line.includes("/deepseek"))
    const summary = { reset, error, deepseekRequests: requests.length }
    fs.writeFileSync(path.join(OUT, "omo-checks.json"), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    fs.writeFileSync(path.join(OUT, "server.log"), server.logs())
    const omoLog = path.join(server.paths.localAppData, "own-open-code", "thirdparty", "omo", "logs", "omo.log")
    if (fs.existsSync(omoLog)) fs.copyFileSync(omoLog, path.join(OUT, "omo.log"))
    await server.stop()
    proxy.stop(true)
    await forwarder.stop()
  }
}

async function create(server: OpencodeServer, title: string) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title,
      model: MODEL,
      location: { directory: server.paths.workspace },
      permissions: PERMISSIONS,
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value("omo") },
    },
  })) as { data: { id: string } }
  return created.data.id
}

const messages = async (server: OpencodeServer, sessionID: string) => (await server.messages(sessionID)) as ReadonlyArray<Message>
const created = (message: Message) => Number(message.time?.created ?? 0)
const notices = (list: ReadonlyArray<Message>) =>
  list.filter((message) => message.type === "synthetic" && message.metadata?.source === "own.omo")
const forwarded = () =>
  fs
    .readFileSync(path.join(OUT, "forwarder.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(200)
  }
}

async function idle(server: OpencodeServer, sessionID: string): Promise<void> {
  const timedOut = await server.waitIdle(sessionID).then(
    () => false,
    (error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") return true
      throw error
    },
  )
  if (timedOut) return idle(server, sessionID)
}

async function resetCheck(server: OpencodeServer) {
  const sessionID = await create(server, "live omo reset")
  await server.prompt(sessionID, RESET_TASK)
  // The reset is asked for while the turn runs, once its todos exist.
  await until(
    async () => ((await messages(server, sessionID)).some((message) => message.type === "assistant" && JSON.stringify(message.content).includes("todowrite")) ? true : undefined),
    180_000,
    "the first todowrite",
  )
  const asked = Date.now()
  await server.call("POST", `/api/session/${sessionID}/reset`, { body: {} })
  await idle(server, sessionID)
  const marker = (await messages(server, sessionID)).find((message) => message.type === "compaction" && message.reason === "reset")
  if (marker === undefined) throw new Error("no reset marker")
  await Bun.sleep(15_000)
  const after = (await messages(server, sessionID)).filter((message) => created(message) > created(marker))
  const todos = (await messages(server, sessionID))
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content as Array<Message>).filter((part) => part.type === "tool" && String(part.name).includes("todowrite")))
    .at(-1)?.state?.input?.todos as Array<{ status: string }> | undefined
  return {
    sessionID,
    resetAskedWhileRunning: true,
    resetAskedAt: new Date(asked).toISOString(),
    markerAt: new Date(created(marker)).toISOString(),
    todosOpenAtReset: (todos ?? []).filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length,
    noticesAfterReset: notices(after).length,
    messagesAfterReset: after.map((message) => message.type),
    requestsAfterReset: forwarded().filter((entry) => Date.parse(String(entry.at ?? entry.time ?? 0)) > created(marker)).length,
  }
}

async function errorCheck(server: OpencodeServer, injected: ReadonlyArray<string>) {
  const sessionID = await create(server, "live omo error")
  await server.prompt(sessionID, ERROR_TASK)
  await idle(server, sessionID)
  await Bun.sleep(8_000)
  const afterError = notices(await messages(server, sessionID)).length
  const sent = Date.now()
  await server.prompt(sessionID, ERROR_NEXT)
  const notice = await until(
    async () => notices(await messages(server, sessionID)).find((message) => created(message) >= sent),
    120_000,
    "omo's continuation after the next message",
  ).catch(() => undefined)
  // One continuation is the check; the rest of the todos is not needed.
  if (notice !== undefined) await server.call("POST", `/api/session/${sessionID}/interrupt`, { query: {} }).catch(() => undefined)
  await idle(server, sessionID)
  return {
    sessionID,
    injected400: injected.length,
    noticesAfterError: afterError,
    continuedAfterNextMessage: notice !== undefined,
    notice: notice === undefined ? undefined : { description: notice.description, text: String(notice.text).slice(0, 160) },
  }
}

await main()
