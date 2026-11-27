// The browser pane's service clients (overrides/browser-pane.ts, P3 of the 2026-10 UI performance study): one
// @opencode/client effect client per endpoint and credential, so every attachment of a window's sessions shares one
// `/api/event` stream through the client's SharedEvents instead of opening its own. SharedEvents opens the stream with
// the first subscriber, replays `server.connected` to a later one, ends every subscriber when the stream drops (the
// attachments then end and the window registers them again, as before) and opens a fresh stream for the next one, and
// closes it with the last subscriber. Own-web attaches every session a window has shown, so with one stream per
// attachment Electron main held one connection per opened session and decoded every event once per attachment
// (own/reports/ui-perf-many-sessions-2026-10.md cause 3).
import { OpenCode } from "@opencode/client/effect"
import { Effect, type ManagedRuntime } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export type BrowserClient = Effect.Success<ReturnType<typeof OpenCode.make>>

export type BrowserServer = { readonly url: string; readonly headers: Readonly<Record<string, string>> }

export function createBrowserClients(runtime: ManagedRuntime.ManagedRuntime<HttpClient.HttpClient, never>) {
  const clients = new Map<string, Promise<BrowserClient>>()
  return {
    /** The endpoint's client. A new credential (a service restart) makes a new one and forgets the older ones. */
    get(server: BrowserServer) {
      const key = `${server.url}\n${JSON.stringify(server.headers)}`
      const known = clients.get(key)
      if (known) return known
      // The older credentials of this endpoint are dead; their attachments end on their own and keep their client.
      for (const other of clients.keys()) if (other.startsWith(`${server.url}\n`)) clients.delete(other)
      // Made on the pane's runtime, outside any attachment's scope, so an attachment that ends takes nothing of it.
      const made = runtime.runPromise(
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          return yield* OpenCode.make({ baseUrl: server.url }).pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              Object.keys(server.headers).length
                ? HttpClient.mapRequest(http, HttpClientRequest.setHeaders(server.headers))
                : http,
            ),
          )
        }),
      )
      clients.set(key, made)
      made.catch(() => {
        if (clients.get(key) === made) clients.delete(key)
      })
      return made
    },
    clear() {
      clients.clear()
    },
  }
}
