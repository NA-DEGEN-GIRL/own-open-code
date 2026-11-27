// Live check of a `로컬 모델` account (own/docs/02 §3.3a) on the user's own local model server: a source-booted server
// with own-accounts and own-harness, a recording proxy in front of the local server (no key: the server takes none),
// and these steps, each timed:
//   1. `accounts.local.detect`: the models and what the server says of them (window, reasoning levels);
//   2. the account added without a key; the levels the server names register as effort variants;
//   3. one short question at the lowest and the highest level: the request's `reasoning_effort` and the reasoning
//      tokens the server reports for it;
//   4. a sub-agent on the local model (parent and child local): the child's requests carry tools, stream, and inherit the
//      parent's level;
//   5. cancellation: a long sub-agent task interrupted from the parent; the child stops and its stream closes.
//
//   bun script/live/local.ts [--out <dir>]     OWN_LIVE_LOCAL_URL (default http://localhost:64644/v1), OWN_LIVE_LOCAL_MODEL
//
// Nothing here holds a credential, and nothing but the local server is called. Run from a path without '#'.
import fs from "node:fs"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { REPO_ROOT, opencodeConfig, startOpencodeServer, type OpencodeServer } from "../../../own-accounts/test/e2e-kit"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", "own-live-local"))
const TARGET = new URL(process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1")
const MODEL = process.env.OWN_LIVE_LOCAL_MODEL ?? "local-flash-model-q4-0001"
const QUESTION = "In one short sentence: is 2^31 - 1 a prime number? Answer yes or no and why."

type Json = Record<string, unknown>

interface Seen {
  readonly at: number
  readonly path: string
  readonly model?: string
  readonly effort?: unknown
  readonly thinking?: unknown
  readonly tools: number
  readonly stream: boolean
  readonly authorization: boolean
  status?: number
  reasoningTokens?: number
  completionTokens?: number
  seconds?: number
  closedEarly?: boolean
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const seen: Seen[] = []
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : undefined
      const json = body ? (JSON.parse(body) as Json) : undefined
      const entry: Seen = {
        at: Date.now(),
        path: url.pathname,
        ...(typeof json?.model === "string" ? { model: json.model } : {}),
        ...(json && "reasoning_effort" in json ? { effort: json.reasoning_effort } : {}),
        ...(json && "chat_template_kwargs" in json ? { thinking: json.chat_template_kwargs } : {}),
        tools: Array.isArray(json?.tools) ? json.tools.length : 0,
        stream: json?.stream === true,
        authorization: request.headers.has("authorization"),
      }
      seen.push(entry)
      const headers = new Headers(request.headers)
      headers.delete("host")
      const upstream = await fetch(new URL(url.pathname + url.search, TARGET.origin), {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: request.signal,
      })
      entry.status = upstream.status
      if (!upstream.body) return new Response(null, { status: upstream.status, headers: upstream.headers })
      const [client, mine] = upstream.body.tee()
      void readUsage(mine, entry)
      return new Response(client, { status: upstream.status, headers: upstream.headers })
    },
  })
  const baseURL = `http://127.0.0.1:${proxy.port}${TARGET.pathname.replace(/\/+$/, "")}`
  const server = await startOpencodeServer({
    startupTimeoutMs: 480_000,
    projectConfig: true,
    keepTemp: true,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: { home: paths.ownHome, buildId: `live-local-${process.pid}`, vault: "memory" },
          },
          { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
        ],
      }),
  })
  const control = path.join(server.paths.ownHome, "control")
  fs.mkdirSync(control, { recursive: true })
  const rpc = async (method: OwnAccounts.MethodName, input: unknown = {}) => {
    const directory = OwnAccounts.MethodLocation[method] === "session" ? server.paths.workspace : control
    const response = await server.request("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, {
      body: { input },
      query: { "location[directory]": directory },
      directory,
    })
    const output = ((await response.json()) as { output?: Json }).output ?? {}
    if (response.status !== 200) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(output)}`)
    return output
  }
  const report: Json = { model: MODEL, server: TARGET.origin }
  try {
    // 1. What the server says.
    const detectStarted = Date.now()
    const found = await rpc("accounts.local.detect", { baseURL, format: "chat" })
    const mine = (found.models as Json[]).find((model) => model.id === MODEL)
    report.detect = {
      ms: Date.now() - detectStarted,
      family: found.family,
      count: (found.models as Json[]).length,
      model: mine,
    }
    console.log("detect", JSON.stringify(report.detect))
    if (!mine) throw new Error(`${MODEL} is not served`)
    // 2. Added without a key.
    const added = await rpc("accounts.add.key", {
      kind: "compat",
      label: "Live local",
      options: {
        baseURL,
        local: { format: "chat" },
        models: [{ id: MODEL, contextLimit: Number(mine.context ?? 131_072), outputLimit: 32_000 }],
      },
    })
    const providerID = String((added.account as Json).providerID)
    await server.waitForModels([{ providerID, id: MODEL }], 120_000)
    const levels = await waitFor(async () => {
      const listed = (await server.models()).find((model) => model.providerID === providerID && model.id === MODEL)
      const variants = Array.isArray(listed?.variants) ? listed.variants.map((item) => String((item as Json).id)) : []
      return variants.length ? variants : undefined
    }, 60_000)
    report.levels = levels
    console.log("levels", levels.join(","))
    const card = ((await rpc("accounts.list")).accounts as Json[]).find((item) => item.providerID === providerID)
    report.card = { billing: card?.billing, status: card?.status, local: (card?.compat as Json | undefined)?.local }

    // 3. Lowest and highest level.
    const ask = async (variant: string) => {
      const before = seen.length
      const session = await server.createSession({ model: { providerID, id: MODEL, variant } as never })
      const started = Date.now()
      await server.prompt(session.id, QUESTION)
      await server.waitIdle(session.id)
      const requests = seen.slice(before).filter((item) => item.path.endsWith("/chat/completions"))
      const reply = lastText(await server.messages(session.id))
      return { variant, seconds: (Date.now() - started) / 1000, requests: requests.map(slim), reply }
    }
    const low = await ask(levels[0]!)
    const high = await ask(levels.at(-1)!)
    report.effort = { low, high }
    console.log("effort", JSON.stringify(report.effort))

    // 4. A sub-agent on the local model.
    fs.writeFileSync(
      path.join(server.paths.workspace, "notes.txt"),
      "first line\nthe second line is 7f3a\nthird line\n",
    )
    const delegateBefore = seen.length
    const parent = await server.createSession({ model: { providerID, id: MODEL, variant: "high" } as never })
    const delegateStarted = Date.now()
    await server.prompt(
      parent.id,
      "Use a sub-agent (your agent or sub-agent tool) to read `notes.txt` in this folder and report its second line. " +
        "Do not read the file yourself. Reply with the second line the sub-agent found.",
    )
    await settle(server, parent.id)
    const children = await childIDs(server, parent.id)
    const childModels = await Promise.all(
      children.map(async (id) => {
        const info = (await server.call("GET", `/api/session/${id}`)) as { data: Json }
        return info.data.model
      }),
    )
    fs.writeFileSync(
      path.join(OUT, "subagent-messages.json"),
      JSON.stringify(
        {
          parent: await server.messages(parent.id),
          children: await Promise.all(children.map((id) => server.messages(id))),
        },
        null,
        2,
      ),
    )
    const delegated = seen.slice(delegateBefore).filter((item) => item.path.endsWith("/chat/completions"))
    report.subagent = {
      seconds: (Date.now() - delegateStarted) / 1000,
      children: children.length,
      childModels,
      requests: delegated.map(slim),
      reply: lastText(await server.messages(parent.id)),
    }
    console.log("subagent", JSON.stringify(report.subagent))

    // 5. Cancellation of a running sub-agent.
    const cancelBefore = seen.length
    const long = await server.createSession({ model: { providerID, id: MODEL, variant: levels[0]! } as never })
    await server.prompt(
      long.id,
      "Use a sub-agent (your agent or sub-agent tool) and have it write the numbers from 1 to 3000, one per line, in " +
        "its reply, without tools. Wait for it.",
    )
    const child = await waitFor(async () => (await childIDs(server, long.id))[0], 180_000)
    // Let the child's stream run a little, then interrupt the parent.
    await waitFor(async () => (seen.length > cancelBefore + 1 ? true : undefined), 60_000)
    await Bun.sleep(4_000)
    const interruptedAt = Date.now()
    await server.request("POST", `/api/session/${long.id}/interrupt`, { body: {} })
    await server.request("POST", `/api/session/${child}/interrupt`, { body: {} })
    await server.waitIdle(child)
    await server.waitIdle(long.id)
    await Bun.sleep(2_000)
    const cancelled = seen.slice(cancelBefore).filter((item) => item.path.endsWith("/chat/completions"))
    report.cancel = {
      idleAfterMs: Date.now() - interruptedAt,
      requests: cancelled.map(slim),
      lateRequests: cancelled.filter((item) => item.at > interruptedAt + 1_000).length,
    }
    console.log("cancel", JSON.stringify(report.cancel))
  } finally {
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(OUT, "requests.json"), JSON.stringify(seen, null, 2))
    fs.writeFileSync(path.join(OUT, "server.log"), server.logs())
    await server.stop()
    proxy.stop(true)
  }
}

function slim(item: Seen) {
  return {
    effort: item.effort,
    tools: item.tools,
    stream: item.stream,
    authorization: item.authorization,
    status: item.status,
    reasoningTokens: item.reasoningTokens,
    completionTokens: item.completionTokens,
    seconds: item.seconds,
    closedEarly: item.closedEarly,
  }
}

/** The usage of a streamed or plain answer, read from the proxy's copy; a client abort marks the stream closed early. */
async function readUsage(stream: ReadableStream<Uint8Array>, entry: Seen) {
  const started = Date.now()
  const text = await new Response(stream).text().catch(() => {
    entry.closedEarly = true
    return ""
  })
  // A stream the client closed before the server's end mark (the request `signal` also fires after a finished one).
  if (entry.stream && !text.includes("[DONE]")) entry.closedEarly = true
  entry.seconds = (Date.now() - started) / 1000
  const reasoning = [...text.matchAll(/"reasoning_tokens":\s*(\d+)/g)].at(-1)?.[1]
  const completion = [...text.matchAll(/"completion_tokens":\s*(\d+)/g)].at(-1)?.[1]
  if (reasoning !== undefined) entry.reasoningTokens = Number(reasoning)
  if (completion !== undefined) entry.completionTokens = Number(completion)
}

function created(message: Record<string, unknown>) {
  return Number((message.time as { created?: number } | undefined)?.created ?? 0)
}

function lastText(messages: ReadonlyArray<Record<string, unknown>>) {
  const assistant = messages
    .filter((message) => message.type === "assistant")
    .toSorted((a, b) => created(b) - created(a))[0]
  const parts = Array.isArray(assistant?.content) ? (assistant.content as Json[]) : []
  return parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.text))
    .join("")
    .slice(0, 400)
}

async function settle(server: OpencodeServer, sessionID: string) {
  let count = -1
  for (let round = 0; round < 20; round++) {
    await server.waitIdle(sessionID)
    for (const child of await childIDs(server, sessionID)) await server.waitIdle(child)
    await Bun.sleep(4_000)
    await server.waitIdle(sessionID)
    const now = (await server.messages(sessionID)).length
    if (now === count) return
    count = now
  }
}

async function childIDs(server: OpencodeServer, sessionID: string) {
  const listed = (await server.call("GET", "/api/session", { query: { parentID: sessionID, limit: "50" } })) as {
    data: Array<{ id: string }>
  }
  return listed.data.map((session) => session.id)
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(500)
  }
  throw new Error(`timed out after ${ms} ms`)
}

await main()
