// OWN-PATCH(P-035) begin
// A context reset waits in the inbox while a turn runs; clients that opt into `experimental-media-uri` list the inbox
// through the media response, which must carry the reset item as the plain list does.
import { Database as Sqlite } from "bun:sqlite"
import path from "node:path"
import { expect, setDefaultTimeout } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
// A whole server boots and is released: about 5.0 s on this PC, right at bun's 5 s default.
setDefaultTimeout(30_000)

const client = (handler: (request: Request) => Promise<Response>, capabilities?: string) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    ...(capabilities === undefined ? {} : { headers: { "X-OpenCode-Capabilities": capabilities } }),
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

it.live("lists a waiting context reset to clients that opt into media refs", () =>
  Effect.gen(function* () {
    // Acquired first so it is removed after the server below is released; Windows can't delete an open db.
    const dir = (yield* tmpdirScoped("opencode-reset-media-")).path
    yield* Effect.gen(function* () {
      const database = path.join(dir, "opencode.db")
      const handler = yield* ServerFetch.make({
        app: { version: "test" },
        database: { path: database },
        config: { project: false, content: JSON.stringify({ experimental: { media_blob: true } }) },
        models: { fetch: false },
        fs: { filewatcher: false },
      })
      const plain = client(handler)
      const opted = client(handler, "Experimental-Media-URI")
      yield* Effect.promise(async () => {
        const session = await plain.session.create({ title: "Reset wire" })
        // The row a reset admitted while a turn runs leaves (core `admitReset`); no turn runs here to deliver it.
        const db = new Sqlite(database)
        db.run(
          "INSERT INTO session_inbox (id, session_id, type, payload, delivery, enqueued_seq, time_created) VALUES (?, ?, 'reset', '{}', 'queue', 1, 1)",
          ["msg_reset_waiting", session.id],
        )
        db.close()
        expect(await plain.session.inbox.list({ sessionID: session.id })).toMatchObject([
          { id: "msg_reset_waiting", type: "reset" },
        ])
        expect(await opted.session.inbox.list({ sessionID: session.id })).toMatchObject([
          { id: "msg_reset_waiting", type: "reset" },
        ])
      })
    }).pipe(Effect.scoped)
  }),
)
// OWN-PATCH(P-035) end
