// OWN-PATCH(P-055) begin
// own: message pages without tool results' inline file bytes for clients that ask.
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

const user: SessionMessageInfo = {
  id: "msg_omit_user",
  type: "user",
  text: "See attached",
  files: [{ data: png, mime: "image/png", source: { type: "inline" }, name: "pasted.png" }],
  time: { created: 100 },
}

const assistant: SessionMessageInfo = {
  id: "msg_omit_assistant",
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "test" },
  content: [
    { type: "text", text: "Took a screenshot." },
    {
      type: "tool",
      id: "call_screenshot",
      name: "screenshot",
      executed: true,
      state: {
        status: "completed",
        input: {},
        content: [
          { type: "text", text: "1440x900" },
          { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "screen.png" },
          { type: "file", uri: "file:///workspace/screen.png", mime: "image/png" },
        ],
      },
      time: { created: 110, ran: 111, completed: 112 },
    },
  ],
  finish: "stop",
  time: { created: 110, completed: 120 },
}

const client = (
  handler: (request: Request) => Promise<Response>,
  ask?: { readonly header?: string; readonly query?: string },
) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    ...(ask?.header === undefined ? {} : { headers: { "X-OpenCode-Capabilities": ask.header } }),
    fetch: Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (ask?.query !== undefined) url.searchParams.set("own-capabilities", ask.query)
        return handler(new Request(url, init))
      },
      { preconnect: fetch.preconnect },
    ),
  })

it.live("message pages leave out tool results' inline file bytes only for clients that ask", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-omit-tool-files-")).path
    yield* Effect.gen(function* () {
      const database = path.join(dir, "opencode.db")
      const handler = yield* ServerFetch.make({
        app: { version: "test" },
        database: { path: database },
        config: { directory: dir, project: false, content: "{}" },
        models: { fetch: false },
        fs: { filewatcher: false },
      })
      const plain = client(handler)
      const opted = client(handler, { header: "experimental-media-uri, Own-Omit-Tool-File-Data" })
      // own-web asks in the query: a custom header would preflight every cross-origin page.
      const queried = client(handler, { query: "own-omit-tool-file-data" })
      const sessionID = Session.ID.create()

      yield* Effect.promise(async () => {
        const template = await plain.session.create({ title: "Omit tool files" })
        await plain.experimental.session.import({ info: { ...template, id: sessionID }, messages: [user, assistant] })

        expect((await plain.message.list({ sessionID, order: "asc" })).data).toEqual([user, assistant])
        const page = await opted.message.list({ sessionID, order: "asc" })
        expect((await queried.message.list({ sessionID, order: "asc" })).data).toEqual(page.data)
        expect(page.data).toEqual([
          user,
          {
            ...assistant,
            content: [
              { type: "text", text: "Took a screenshot." },
              {
                type: "tool",
                id: "call_screenshot",
                name: "screenshot",
                executed: true,
                time: { created: 110, ran: 111, completed: 112 },
                state: {
                  status: "completed",
                  input: {},
                  content: [
                    { type: "text", text: "1440x900" },
                    { type: "file", uri: "data:image/png;base64,", mime: "image/png", name: "screen.png" },
                    { type: "file", uri: "file:///workspace/screen.png", mime: "image/png" },
                  ],
                },
              },
            ],
          },
        ])
        // Cursors still page: the message the client then needs is read whole on its own.
        expect(page.cursor.next).toBeDefined()
        expect(await opted.session.message.get({ sessionID, messageID: "msg_omit_assistant" })).toEqual(assistant)
      })
    }).pipe(Effect.scoped)
  }),
  // Starting the server from source takes 5-7 s on a loaded machine (bun's default is 5 s).
  30_000,
)
// OWN-PATCH(P-055) end
