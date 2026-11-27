// Shared parts of own-creator's end-to-end tests: a source server with own-harness and own-creator on a fake DeepSeek
// chat model with a prefix cache, and helpers for creator sessions, turns and the own.creator RPC.
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import {
  deepseekProvider,
  opencodeConfig,
  REPO_ROOT,
  startFakeOpenAIChat,
  startOpencodeServer,
  type FakeOpenAIChat,
  type OpencodeServer,
  type RecordedRequest,
} from "../../../own-accounts/test/e2e-kit"

export const MODEL = { providerID: "fake-ds", id: "deepseek-v4-pro" }
export const BOOT_TIMEOUT = 560_000
export const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
export const ASK = [
  { action: "edit", resource: "**", effect: "ask" },
  { action: "shell", resource: "**", effect: "ask" },
]
export const READONLY = [
  { action: "edit", resource: "**", effect: "deny" },
  { action: "shell", resource: "**", effect: "ask" },
]

export interface Rig {
  readonly fake: FakeOpenAIChat
  readonly server: OpencodeServer
  readonly home: string
}

/** Boots the server. `own-harness` first, then own-creator last, as the release lists them. */
export async function boot(
  options: {
    readonly harness?: boolean
    /** Extra variables for the server (`OPENCODE_DISABLE_FILEWATCHER: undefined` lets config edits reload plugins). */
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Extra own.creator options (`registry`). */
    readonly creator?: Readonly<Record<string, unknown>>
  } = {},
): Promise<Rig> {
  const fake = startFakeOpenAIChat({ models: [MODEL.id], cache: { minTokens: 0, blockTokens: 16 } })
  const state: { home?: string } = {}
  const server = await startOpencodeServer({
    startupTimeoutMs: 540_000,
    env: { OWN_OPEN_CODE: "1", ...options.env },
    config: (paths) => {
      state.home = paths.ownHome
      fs.mkdirSync(paths.workspace, { recursive: true })
      Bun.spawnSync(["git", "init", "-q"], { cwd: paths.workspace })
      return opencodeConfig({
        providers: {
          "fake-ds": deepseekProvider(fake, {
            apiKey: "fake-key-ds",
            models: { [MODEL.id]: { name: "DeepSeek V4 Pro", limit: { context: 1_000_000, output: 32_000 } } },
          }),
        },
        plugins: [
          ...(options.harness === false
            ? []
            : [{ package: path.join(REPO_ROOT, "packages/own-harness"), options: {} }]),
          { package: path.join(REPO_ROOT, "packages/own-creator"), options: { home: paths.ownHome, ...options.creator } },
        ],
        model: `${MODEL.providerID}/${MODEL.id}`,
      })
    },
  })
  await server.waitForModels([MODEL])
  await waitForRpc(server, server.paths.workspace)
  return { fake, server, home: state.home! }
}

export async function rpc(server: OpencodeServer, method: string, input: unknown, directory = server.paths.workspace) {
  const response = await server.request("POST", `/api/rpc/own.creator/${method}`, {
    body: { input },
    query: { "location[directory]": directory },
    directory,
  })
  const body = (await response.json()) as { output?: Record<string, unknown> }
  if (!response.ok) throw new Error(`own.creator ${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output ?? {}
}

async function waitForRpc(server: OpencodeServer, directory: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const ready = await rpc(server, "list", {}, directory).then(
      () => true,
      () => false,
    )
    if (ready) return
    await Bun.sleep(200)
  }
  throw new Error("own.creator never answered")
}

/** A session of `harness` (default `opencode`) for `agent`, with explicit rules and a title (no title request). */
export async function session(
  server: OpencodeServer,
  input: {
    readonly agent?: string
    readonly permissions?: ReadonlyArray<Record<string, string>>
    readonly harness?: OwnHarness.HarnessID
    readonly directory?: string
    readonly title?: string
  } = {},
) {
  const created = (await server.call("POST", "/api/session", {
    body: {
      title: input.title ?? "creator e2e",
      model: MODEL,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      location: { directory: input.directory ?? server.paths.workspace },
      metadata: { [OwnHarness.META_KEY]: OwnHarness.value(input.harness ?? "opencode") },
      permissions: input.permissions ?? FULL,
    },
    directory: input.directory,
  })) as { data: { id: string } }
  return created.data.id
}

export type Reply =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool-call"; readonly name: string; readonly input: unknown }
  | { readonly type: "error"; readonly status: number; readonly body: string }

/**
 * One prompt: the fake answers with `replies` in order (then "ok"). Returns the requests the turn sent and the
 * permission requests it raised, each answered with `answer` (default `once`).
 */
export async function turn(
  rig: Rig,
  sessionID: string,
  text: string,
  replies: ReadonlyArray<Reply>,
  answer: Record<string, unknown> = { decision: "once" },
) {
  const asked: Array<{ action: string; resources: ReadonlyArray<string>; metadata?: unknown }> = []
  const state = { done: false }
  const answering = (async () => {
    while (!state.done) {
      const body = (await rig.server.call("GET", `/api/session/${sessionID}/permission`).catch(() => ({}))) as {
        data?: Array<Record<string, unknown>>
      }
      await Promise.all(
        (body.data ?? []).map((request) => {
          asked.push({
            action: String(request.action),
            resources: request.resources as ReadonlyArray<string>,
            metadata: request.metadata,
          })
          return rig.server.call("POST", `/api/session/${sessionID}/permission/${String(request.id)}/reply`, {
            body: answer,
          })
        }),
      )
      await Bun.sleep(100)
    }
  })()
  // A turn a declined approval ended early leaves its later replies queued; start each turn from an empty queue.
  rig.fake.reset()
  const before = rig.fake.requests.length
  rig.fake.enqueue(...(replies as Parameters<FakeOpenAIChat["enqueue"]>))
  await rig.server.prompt(sessionID, text)
  await rig.server.waitIdle(sessionID).finally(() => {
    state.done = true
  })
  await answering
  const requests = rig.fake.requests.slice(before).filter((request) => request.method === "POST")
  return { requests, asked }
}

export type Chat = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string; description: string } }>
}

export function body(request: RecordedRequest) {
  return request.json as Chat
}

export function toolNames(request: RecordedRequest) {
  return (body(request).tools ?? []).map((tool) => tool.function.name)
}

/** Every text of a request, for "does it say this anywhere". */
export function allText(request: RecordedRequest) {
  return request.body
}

/** The tool result texts of a request. */
export function toolResults(request: RecordedRequest) {
  return body(request)
    .messages.filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
}
