export * as CodeModeFetch from "./fetch.js"

import { Extension } from "@opencode/codemode"
import { isRecord } from "@opencode/util/record"
import { Effect, Option } from "effect"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { CodeModeApi } from "./api.js"
import { CodeModeExecution } from "./execution.js"

const TIMEOUT_MS = 30_000

// OWN-PATCH(P-049) begin
type Init = {
  readonly method?: string
  readonly headers: Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

const fetch = (input: string | URL, options?: unknown) =>
  // OWN-PATCH(P-049) end
  Effect.gen(function* () {
    // Rules match the URL as written. The fragment is never sent, and would keep a rule for the exact URL from
    // matching.
    const url = String(input).split("#")[0]
    const parsed = URL.parse(url)
    if (parsed?.protocol === "file:")
      return yield* Effect.fail(new Error("fetch cannot be used for filesystem access."))
    // Rules match the URL, so `https://user@evil.com` would slip past a rule for `https://evil.com/*`.
    if (parsed?.username || parsed?.password)
      return yield* Effect.fail(new TypeError("fetch cannot be used with credentials in the URL."))
    // OWN-PATCH(P-049) begin
    // Read once: the approval shows exactly what is sent.
    const init = normalise(options)
    if (init instanceof TypeError) return yield* Effect.fail(init)
    // OWN-PATCH(P-049) end
    if (parsed?.protocol === "opencode:") return yield* fetchOpencode(url, init)
    const execution = yield* CodeModeExecution.Service
    const permission = yield* Permission.Service
    const source = { type: "tool" as const, messageID: execution.messageID, id: execution.id }
    // The same rules as the webfetch tool, so a URL denied there is denied here.
    yield* permission
      .assert({
        action: "webfetch",
        resources: [url],
        save: ["*"],
        metadata: display([input, init]),
        sessionID: execution.sessionID,
        agent: execution.agent,
        source,
      })
      .pipe(
        // The feedback is the user talking to the model, so it must reach the program as the error's message.
        Effect.catchTag("Permission.CorrectedError", (error) =>
          Effect.fail(new Error(`The user rejected fetching ${url}: ${error.feedback}`)),
        ),
      )
    // Redirects are followed here so each new URL meets the same deny rules as the webfetch tool's hops.
    // OWN-PATCH(P-049) begin
    const check = (next: string, request: Init) =>
      permission.assertNotDenied({
        action: "webfetch",
        resources: [next],
        metadata: { ...display([next, request]), redirectedFrom: url },
        // OWN-PATCH(P-049) end
        sessionID: execution.sessionID,
        agent: execution.agent,
        source,
      })
    const signal = AbortSignal.any([execution.signal, AbortSignal.timeout(TIMEOUT_MS)])
    let target = url
    let request = init
    for (let redirects = 0; ; redirects++) {
      const response = yield* Effect.tryPromise({
        // OWN-PATCH(P-049) begin
        try: () =>
          globalThis.fetch(target, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: "manual",
            signal,
          }),
        // OWN-PATCH(P-049) end
        catch: (error) => error,
      })
      const location = response.headers.get("location")
      if (!redirectStatuses.has(response.status) || location === null)
        return new Extension.StreamingResponse(response, redirects > 0)
      yield* Effect.tryPromise({ try: async () => response.body?.cancel(), catch: (error) => error })
      if (redirects >= MAX_REDIRECTS)
        return yield* Effect.fail(new Error(`Too many redirects (more than ${MAX_REDIRECTS})`))
      const next = new URL(location, target)
      if (next.protocol !== "http:" && next.protocol !== "https:")
        return yield* Effect.fail(new Error(`fetch cannot follow a redirect to ${next.protocol} URLs.`))
      if (next.username || next.password)
        return yield* Effect.fail(new Error("fetch cannot follow a redirect with credentials in the URL."))
      next.hash = ""
      // OWN-PATCH(P-049) begin
      request = redirected(request, response.status, target, next)
      yield* check(next.href, request)
      // OWN-PATCH(P-049) end
      target = next.href
    }
  })

export const MAX_REDIRECTS = 20
const redirectStatuses = new Set([301, 302, 303, 307, 308])

// No permission check and no timeout: the request runs in this process and ends with the execute call.
const fetchOpencode = (url: string, init: Init) =>
  Effect.gen(function* () {
    const execution = yield* CodeModeExecution.Service
    const path = yield* CodeModeApi.path(url, execution.sessionID)
    const api = Option.getOrElse(yield* Effect.serviceOption(CodeModeApi.Service), () => CodeModeApi.unavailable)
    const method = (init.method ?? "GET").toUpperCase()
    const headers = new Headers(init.headers)
    // Without a directory the server would answer for its own default Location, not the session's.
    const location = yield* Effect.serviceOption(Location.Service)
    if (Option.isSome(location) && !headers.has("x-opencode-directory") && !path.includes("location[directory]="))
      headers.set("x-opencode-directory", encodeURIComponent(location.value.directory))
    const response = yield* api.fetch(
      new Request(new URL(path, "http://opencode.local").href, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : init.body,
        signal: execution.signal,
      }),
    )
    return new Extension.StreamingResponse(response, false)
  })

// The request a browser sends after a redirect: 303, and 301/302 after a POST, become a GET without a body, and
// credentials are not sent to another origin.
const redirected = (request: Init, status: number, from: string, to: URL): Init => {
  const method = request.method?.toUpperCase() ?? "GET"
  const toGet = status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST"
  const headers = new Headers(request.headers)
  if (toGet)
    ["content-type", "content-length", "content-encoding", "content-language", "content-location"].forEach((name) =>
      headers.delete(name),
    )
  if (new URL(from).origin !== to.origin)
    ["authorization", "cookie", "proxy-authorization"].forEach((name) => headers.delete(name))
  return {
    method: toGet ? "GET" : request.method,
    headers: Array.from(headers),
    body: toGet ? undefined : request.body,
  }
}

export const extension = Extension.make({ name: "fetch", globals: { fetch: Extension.async(fetch) } })

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>) => {
  const [input, options] = args
  // OWN-PATCH(P-049) begin
  // The approval also names the headers it sends (an `Authorization` stands out) and the body's size, read from the
  // same normalised options fetch sends.
  const init = normalise(options)
  if (init instanceof TypeError) return { method: "GET", url: String(input) }
  const method = init.method ?? "GET"
  const headers = init.headers.map((entry) => entry[0])
  const body =
    typeof init.body === "string" || init.body instanceof URLSearchParams
      ? new TextEncoder().encode(String(init.body)).byteLength
      : init.body?.byteLength
  return {
    method,
    url: String(input),
    ...(headers.length > 0 ? { headers } : {}),
    ...(body === undefined ? {} : { bodyBytes: body }),
  }
  // OWN-PATCH(P-049) end
}

// OWN-PATCH(P-049) begin
// Only method, headers and body reach Bun's fetch: its `proxy`, `unix` and `tls` would send an approved URL elsewhere.
// Each is read once into the one value both the approval and the request use, so neither sees what the other does not
// (a method array Bun turns into a string, a Map of headers the approval could not list). Returns the error to fail with.
const normalise = (options: unknown): Init | TypeError => {
  if (options === undefined) return { headers: [] }
  if (!isRecord(options)) return new TypeError("fetch options must be an object.")
  const unknown = Object.keys(options).filter((key) => !["method", "headers", "body"].includes(key))
  if (unknown.length > 0)
    return new TypeError(
      `fetch does not support the option ${unknown.join(", ")}: only method, headers and body are allowed.`,
    )
  const method = options.method
  if (method !== undefined && typeof method !== "string") return new TypeError("fetch's method must be a string.")
  if (method !== undefined && FORBIDDEN_METHODS.has(method.toUpperCase()))
    return new TypeError(`fetch does not support the method ${method}.`)
  const body = options.body
  if (
    !(body === undefined || typeof body === "string" || body instanceof Uint8Array || body instanceof URLSearchParams)
  )
    return new TypeError("fetch's body must be a string, a Uint8Array or URLSearchParams.")
  const headers = readHeaders(options.headers)
  if (headers instanceof TypeError) return headers
  return {
    method: method?.toUpperCase(),
    headers: headers.filter((entry) => !forbiddenHeader(entry[0], entry[1])),
    body: body instanceof Uint8Array ? new Uint8Array(body) : body,
  }
}

// Objects, Headers, Maps and arrays of pairs, as the Headers constructor takes them.
const readHeaders = (headers: unknown) => {
  try {
    return Array.from(new Headers(headers as ConstructorParameters<typeof Headers>[0]))
  } catch (error) {
    return new TypeError(`fetch's headers are not valid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The Fetch standard's forbidden methods and request headers (fetch.spec.whatwg.org, "forbidden request-header"): a
// browser never lets a page set them, and here they could route an approved URL elsewhere (`Host`, `Proxy-*`) or
// smuggle a second request (`Content-Length`, `Transfer-Encoding`).
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"])
const FORBIDDEN_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
])
const METHOD_OVERRIDES = new Set(["x-http-method", "x-http-method-override", "x-method-override"])

const forbiddenHeader = (name: string, value: string) => {
  const lower = name.toLowerCase()
  if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) return true
  return (
    METHOD_OVERRIDES.has(lower) && value.split(",").some((item) => FORBIDDEN_METHODS.has(item.trim().toUpperCase()))
  )
}
// OWN-PATCH(P-049) end
