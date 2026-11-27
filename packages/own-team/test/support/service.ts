// A fake own service for self-HTTP tests (06 §2.6, §11.2): a Bun server on 127.0.0.1 (never another interface, so no
// firewall prompt) that checks the Basic credential, records every request and answers from the routes a test gives.
// The password is a fake test value.

import { ServiceTarget } from "@own/runtime"

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly authorization: string | null
  readonly body: unknown
}

export type Route = (request: Recorded) => Response | Promise<Response>

export interface FakeService {
  readonly url: string
  readonly password: string
  readonly requests: Recorded[]
  /** `"<METHOD> <path>"` → handler; unknown routes answer 404 `{_tag: "NotFound"}`. */
  readonly routes: Map<string, Route>
  /** The `service` plugin option for this server. */
  readonly option: { readonly url: string; readonly password: string }
  readonly source: ServiceTarget.Source
  stop(): Promise<void>
}

export const PASSWORD = "fake-service-password-for-tests"

export function start(input: { readonly password?: string } = {}): FakeService {
  const password = input.password ?? PASSWORD
  const requests: Recorded[] = []
  const routes = new Map<string, Route>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        authorization: request.headers.get("authorization"),
        body: text ? JSON.parse(text) : undefined,
      }
      requests.push(recorded)
      if (recorded.authorization !== ServiceTarget.basic(password))
        return Response.json({ _tag: "Unauthorized", message: "unauthorized" }, { status: 401 })
      const route = routes.get(`${recorded.method} ${recorded.path}`)
      if (!route) return Response.json({ _tag: "NotFound", message: `no route ${recorded.path}` }, { status: 404 })
      return route(recorded)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const option = { url, password }
  return {
    url,
    password,
    requests,
    routes,
    option,
    source: ServiceTarget.fixed(option),
    stop: async () => {
      await server.stop(true)
    },
  }
}

/** A session as the service returns it (the fields `SessionHttp.SessionView` reads). */
export function session(input: {
  readonly id: string
  readonly directory: string
  readonly parentID?: string
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
  readonly metadata?: Readonly<Record<string, unknown>>
}) {
  return {
    id: input.id,
    projectID: "prj_test",
    location: { directory: input.directory },
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: {},
    ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}
