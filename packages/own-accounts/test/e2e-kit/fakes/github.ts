// A fake GitHub for the GitHub connection's tests (16, GH): `GET /user` (and `/api/v3/user`, a GitHub Enterprise
// site's address), the device flow (`POST /login/device/code`, `/login/oauth/access_token`), GitHub's MCP server
// (`POST /mcp`, Streamable HTTP JSON answers with a session id; `x-mcp-readonly` hides and refuses the write tools;
// `DELETE /mcp` closes a session, recorded), git's smart HTTP login check (`GET /<owner>/<repo>.git/info/refs`, Basic
// auth, an empty repository's advertisement) and Git LFS's batch API (`POST /<owner>/<repo>.git/info/lfs/objects/
// batch`, Basic auth) with its object storage: an upload of an object not stored yet gets an `upload` action, a
// download of a stored one a `download` action, both at `/_lfs/<oid>` here with a short credential derived for that
// object (`RemoteAuth …`, never the token). With `repos` (a folder of bare `<owner>/<repo>.git`), git's smart HTTP is
// real for those repositories (`git http-backend`: fetch and push, its `REMOTE_USER` the login); others keep the empty
// advertisement. `echo` makes the git and LFS answers hand the request's login back (an
// LFS action's `Authorization`, a response header, a 302 `Location`, a 401 body), as a misbehaving server would, for
// the relay's checks (16 §8, GH-45). Every token is fake; the fake records logins and hashes, never a token.
import fs from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"
import { hashSecret } from "./shared"

const decodeBatch = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export interface FakeGitHubAccount {
  readonly login: string
  readonly name?: string
  /** `X-OAuth-Scopes` (a classic token); left out for a fine-grained one. */
  readonly scopes?: string
  /** `GitHub-Authentication-Token-Expiration`. */
  readonly expiration?: string
}

export interface McpCall {
  readonly login: string
  readonly method: string
  readonly tool?: string
  readonly args?: unknown
  readonly readOnly: boolean
  readonly toolsets: string
  readonly session?: string
}

export interface GitLogin {
  readonly login: string | undefined
  readonly username: string
  /** `hashSecret` of the password git sent. */
  readonly password: string
  readonly path: string
  /** `git-upload-pack` (a fetch), `git-receive-pack` (a push) or `lfs-<operation>` (Git LFS's batch). */
  readonly service: string
}

/** Where the fake hands a git or LFS request's login back (`echo`). */
export type Echo = "actions" | "header" | "location" | "body401"

/** A request to the LFS object storage (`/_lfs/<oid>`). */
export interface StorageCall {
  readonly method: string
  readonly oid: string
  /** Whether it carried the credential the batch derived for that object. */
  readonly derived: boolean
}

export interface DeviceScript {
  readonly clientID: string
  readonly userCode: string
  /** Polls answered `authorization_pending` before the token. */
  readonly pending: number
  readonly token: string
  readonly refresh?: string
  readonly expiresIn?: number
}

export const TOOLS = [
  { name: "get_me", description: "Who you are on GitHub", read: true },
  { name: "get_file_contents", description: "A file of a repository", read: true },
  { name: "list_pull_requests", description: "Pull requests of a repository", read: true },
  { name: "create_pull_request", description: "Opens a pull request", read: false },
  { name: "add_issue_comment", description: "Comments on an issue", read: false },
] as const

export interface FakeTool {
  readonly name: string
  readonly description: string
  /** The `readOnlyHint` the server gives. */
  readonly read: boolean
}

export function startFakeGitHub(options: {
  readonly accounts: Readonly<Record<string, FakeGitHubAccount>>
  /** More tools than {@link TOOLS}, e.g. one whose read-only mark is wrong. */
  readonly tools?: ReadonlyArray<FakeTool>
  /** A fixed port (an `ssh -R` of the same number makes the LFS actions' storage reachable from a host). */
  readonly port?: number
  /** A folder of bare repositories (`<owner>/<repo>.git`) served by `git http-backend`. */
  readonly repos?: string
}) {
  const accounts = new Map(Object.entries(options.accounts))
  const tools: ReadonlyArray<FakeTool> = [...TOOLS, ...(options.tools ?? [])]
  const userCalls: Array<{ readonly login: string | undefined; readonly path: string }> = []
  const mcp: McpCall[] = []
  const git: GitLogin[] = []
  /** MCP sessions closed (`DELETE /mcp`), by session id. */
  const closed: string[] = []
  /** Tokens whose MCP requests are answered 403 (a token that may not reach this toolset), though `/user` takes them. */
  const forbidden = new Set<string>()
  const devices = new Map<string, DeviceScript & { polls: number }>()
  const refreshes: Array<{ readonly clientID: string; readonly refresh: string }> = []
  const refreshAnswers = new Map<
    string,
    { readonly token: string; readonly refresh?: string; readonly expiresIn?: number }
  >()
  let sessions = 0
  /** Where answers hand the login back now. */
  const echo = new Set<Echo>()
  /** Stored LFS objects by oid. */
  const objects = new Map<string, ArrayBuffer>()
  const storage: StorageCall[] = []
  /** Each LFS batch body as it arrived. */
  const batches: string[] = []

  const bearer = (request: Request) => /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url)
      if (request.method === "GET" && (url.pathname === "/user" || url.pathname.endsWith("/user"))) {
        const token = bearer(request)
        const account = token === undefined ? undefined : accounts.get(token)
        userCalls.push({ login: account?.login, path: url.pathname })
        if (!account) return Response.json({ message: "Bad credentials" }, { status: 401 })
        return Response.json(
          { login: account.login, ...(account.name ? { name: account.name } : {}) },
          {
            headers: {
              ...(account.scopes === undefined ? {} : { "x-oauth-scopes": account.scopes }),
              ...(account.expiration === undefined
                ? {}
                : { "github-authentication-token-expiration": account.expiration }),
            },
          },
        )
      }
      if (request.method === "POST" && url.pathname === "/login/device/code") {
        const form = new URLSearchParams(await request.text())
        const script = [...devices.values()].find((item) => item.clientID === form.get("client_id"))
        if (!script) return Response.json({ error: "unauthorized_client" }, { status: 400 })
        return Response.json({
          device_code: `dev-${script.userCode}`,
          user_code: script.userCode,
          verification_uri: `${base()}/login/device`,
          expires_in: 900,
          interval: 1,
        })
      }
      if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
        const form = new URLSearchParams(await request.text())
        if (form.get("grant_type") === "refresh_token") {
          const refresh = form.get("refresh_token") ?? ""
          refreshes.push({ clientID: form.get("client_id") ?? "", refresh: hashSecret(refresh) })
          const next = refreshAnswers.get(refresh)
          if (!next) return Response.json({ error: "bad_refresh_token" })
          return Response.json({
            access_token: next.token,
            ...(next.refresh ? { refresh_token: next.refresh } : {}),
            ...(next.expiresIn ? { expires_in: next.expiresIn } : {}),
          })
        }
        const code = form.get("device_code") ?? ""
        const script = devices.get(code.replace(/^dev-/, ""))
        if (!script || script.clientID !== form.get("client_id"))
          return Response.json({ error: "incorrect_device_code" })
        if (script.polls < script.pending) {
          script.polls += 1
          return Response.json({ error: "authorization_pending" })
        }
        return Response.json({
          access_token: script.token,
          token_type: "bearer",
          ...(script.refresh ? { refresh_token: script.refresh } : {}),
          ...(script.expiresIn ? { expires_in: script.expiresIn } : {}),
        })
      }
      if (url.pathname === "/mcp" && request.method === "DELETE") {
        closed.push(request.headers.get("mcp-session-id") ?? "")
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/mcp" && request.method === "POST") return mcpAnswer(request)
      const refs = /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/.exec(url.pathname)
      if (refs && request.method === "GET") return gitAnswer(request, url)
      const pack = /^\/[^/]+\/[^/]+\.git\/(git-upload-pack|git-receive-pack)$/.exec(url.pathname)
      // Without a repository of `repos` a pack request is not found and not recorded, as before `repos` existed.
      if (pack && request.method === "POST" && served(url)) {
        const account = basicLogin(request, url, pack[1]!)
        if (!account) return unauthorized()
        return backend(request, url, account.login) ?? new Response("not found", { status: 404 })
      }
      if (/^\/[^/]+\/[^/]+\.git\/info\/lfs\/objects\/batch$/.test(url.pathname) && request.method === "POST")
        return lfsAnswer(request, url)
      const stored = /^\/_lfs\/([0-9a-f]{64})$/.exec(url.pathname)
      if (stored && (request.method === "PUT" || request.method === "GET")) return storageAnswer(request, stored[1]!)
      return new Response("not found", { status: 404 })
    },
  })

  function base(): string {
    return `http://127.0.0.1:${server.port}`
  }

  async function mcpAnswer(request: Request) {
    const token = bearer(request)
    const account = token === undefined ? undefined : accounts.get(token)
    if (!account) return Response.json({ message: "Bad credentials" }, { status: 401 })
    if (forbidden.has(token!)) return Response.json({ message: "Resource not accessible" }, { status: 403 })
    const frame = (await request.json()) as { id?: number; method: string; params?: Record<string, unknown> }
    const readOnly = request.headers.get("x-mcp-readonly") === "true"
    const toolsets = request.headers.get("x-mcp-toolsets") ?? ""
    const session = request.headers.get("mcp-session-id") ?? undefined
    const tool = frame.method === "tools/call" ? String(frame.params?.name) : undefined
    mcp.push({
      login: account.login,
      method: frame.method,
      ...(tool === undefined ? {} : { tool, args: frame.params?.arguments }),
      readOnly,
      toolsets,
      ...(session === undefined ? {} : { session }),
    })
    if (frame.id === undefined) return new Response(null, { status: 202 })
    if (frame.method === "initialize") {
      sessions += 1
      return Response.json(
        {
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-github-mcp-server", version: "2.0.3" },
          },
        },
        { headers: { "mcp-session-id": `fake-session-${sessions}` } },
      )
    }
    if (frame.method === "tools/list")
      return Response.json({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          tools: tools.filter((item) => item.read || !readOnly).map((item) => ({
            name: item.name,
            description: item.description,
            inputSchema: {
              type: "object",
              properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } },
            },
            annotations: { readOnlyHint: item.read },
          })),
        },
      })
    if (frame.method === "tools/call") {
      const known = tools.find((item) => item.name === tool)
      if (!known || (!known.read && readOnly))
        return Response.json({
          jsonrpc: "2.0",
          id: frame.id,
          result: { content: [{ type: "text", text: `tool ${tool} is not available` }], isError: true },
        })
      return Response.json({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ tool, as: account.login, args: frame.params?.arguments }) }],
        },
      })
    }
    return Response.json({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "unknown method" } })
  }

  /** The account of a request's Basic login, recorded; `undefined` without a login it knows (answer 401). */
  function basicLogin(request: Request, url: URL, service: string) {
    const login = basicOf(request)
    if (!login) return undefined
    const account = accounts.get(login.password)
    git.push({
      login: account?.login,
      username: login.username,
      password: hashSecret(login.password),
      path: url.pathname,
      service,
    })
    return account
  }

  function basicOf(request: Request) {
    const basic = /^Basic\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
    if (!basic) return undefined
    const decoded = Buffer.from(basic, "base64").toString("utf8")
    const at = decoded.indexOf(":")
    return { username: decoded.slice(0, at), password: decoded.slice(at + 1) }
  }

  const unauthorized = () =>
    new Response("auth needed", { status: 401, headers: { "www-authenticate": 'Basic realm="fake GitHub"' } })

  /** The request's login handed back where `echo` says (a 401 body, a redirect), or `undefined` to answer as usual. */
  function echoed(request: Request, url: URL) {
    const login = basicOf(request)
    if (echo.has("body401"))
      return new Response(`refused: ${request.headers.get("authorization") ?? ""}\n`, { status: 401 })
    if (echo.has("location") && login)
      return new Response(null, {
        status: 302,
        headers: { location: `https://${login.username}:${login.password}@github.example${url.pathname}${url.search}` },
      })
    return undefined
  }

  /** An answer's headers, with the request's login in one when `echo` has `header`. */
  function echoHeaders(request: Request, headers: Record<string, string>) {
    return echo.has("header") ? { ...headers, "x-fake-echo": request.headers.get("authorization") ?? "" } : headers
  }

  function gitAnswer(request: Request, url: URL) {
    const service = url.searchParams.get("service") ?? "git-upload-pack"
    const account = basicLogin(request, url, service)
    if (!account) return unauthorized()
    const handed = echoed(request, url)
    if (handed) return handed
    const served = backend(request, url, account.login)
    if (served) return served
    // An empty repository's smart HTTP advertisement: the service line, a flush, then no refs.
    const line = `# service=${service}\n`
    const body = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000` + "0000"
    return new Response(body, {
      headers: echoHeaders(request, { "content-type": `application/x-${service}-advertisement` }),
    })
  }

  /**
   * `git http-backend` for a repository under `repos` (the CGI of git's own smart HTTP), or `undefined` when there is
   * none. The body is read whole first (`CONTENT_LENGTH`); `http.receivepack` follows `REMOTE_USER`, the login.
   */
  function backend(request: Request, url: URL, login: string) {
    if (!served(url)) return undefined
    return (async () => {
      const body = request.method === "POST" ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array()
      const child = Bun.spawn(["git", "http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: options.repos,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers.get("content-type") ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          REMOTE_USER: login,
          REMOTE_ADDR: "127.0.0.1",
          ...(request.headers.get("git-protocol") ? { GIT_PROTOCOL: request.headers.get("git-protocol")! } : {}),
          ...(request.headers.get("content-encoding")
            ? { HTTP_CONTENT_ENCODING: request.headers.get("content-encoding")! }
            : {}),
        },
        stdin: body,
        stdout: "pipe",
        stderr: "ignore",
      })
      const output = Buffer.from(await new Response(child.stdout).arrayBuffer())
      await child.exited
      const end = output.indexOf("\r\n\r\n")
      const head = output.subarray(0, end < 0 ? 0 : end).toString("latin1").split("\r\n").filter(Boolean)
      const headers = new Headers()
      const status = head.reduce((current, line) => {
        const colon = line.indexOf(":")
        const name = line.slice(0, colon).trim()
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") return Number.parseInt(value, 10)
        headers.append(name, value)
        return current
      }, 200)
      return new Response(output.subarray(end < 0 ? 0 : end + 4), { status, headers })
    })()
  }

  /** Whether a repository of `repos` answers this git URL. */
  function served(url: URL) {
    if (!options.repos) return false
    const relative = url.pathname.replace(/\/(info\/refs|git-upload-pack|git-receive-pack)$/, "")
    return fs.existsSync(path.join(options.repos, relative))
  }

  async function lfsAnswer(request: Request, url: URL) {
    const text = await request.text()
    batches.push(text)
    const batch = (Option.getOrUndefined(decodeBatch(text)) ?? {}) as {
      operation?: string
      objects?: Array<{ oid?: string; size?: number }>
    }
    const login = basicOf(request)
    if (!basicLogin(request, url, `lfs-${batch.operation ?? "unknown"}`) || !login) return unauthorized()
    const handed = echoed(request, url)
    if (handed) return handed
    const answer = (batch.objects ?? []).map((object) => {
      const oid = object.oid ?? ""
      const header = {
        Authorization: echo.has("actions")
          ? (request.headers.get("authorization") ?? "")
          : `RemoteAuth ${derived(login.password, oid)}`,
      }
      const action = { href: `${base()}/_lfs/${oid}`, header, expires_in: 3600 }
      if (batch.operation === "upload")
        return objects.has(oid)
          ? { ...object, authenticated: true }
          : { ...object, authenticated: true, actions: { upload: action } }
      return objects.has(oid)
        ? { ...object, authenticated: true, actions: { download: action } }
        : { ...object, error: { code: 404, message: "Object does not exist" } }
    })
    return Response.json(
      { transfer: "basic", objects: answer },
      { headers: echoHeaders(request, { "content-type": "application/vnd.git-lfs+json" }) },
    )
  }

  /** The object storage: only the credential the batch derived for that object opens it. */
  async function storageAnswer(request: Request, oid: string) {
    const presented = /^RemoteAuth\s+(.+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
    const known = presented !== undefined && [...accounts.keys()].some((token) => derived(token, oid) === presented)
    storage.push({ method: request.method, oid, derived: known })
    if (!known) return new Response("no", { status: 403 })
    if (request.method === "PUT") {
      objects.set(oid, await request.arrayBuffer())
      return new Response(null, { status: 200 })
    }
    const bytes = objects.get(oid)
    return bytes ? new Response(bytes) : new Response("missing", { status: 404 })
  }

  /** A storage credential for one object, derived from the token as a storage service's short one is: never it. */
  function derived(token: string, oid: string) {
    return hashSecret(`${token}|${oid}`).replace(/^sha256:/, "lfs-")
  }

  return {
    url: base(),
    endpoints: { github: base(), githubApi: base(), githubMcp: `${base()}/mcp` },
    userCalls,
    mcp,
    git,
    /** Where answers hand the login back now (GH-45's misbehaving server); empty: never. */
    echo,
    storage,
    batches,
    closed,
    forbidden,
    refreshes,
    addAccount: (token: string, account: FakeGitHubAccount) => void accounts.set(token, account),
    removeAccount: (token: string) => void accounts.delete(token),
    device: (script: DeviceScript) => void devices.set(script.userCode, { ...script, polls: 0 }),
    refreshTo: (
      refresh: string,
      next: { readonly token: string; readonly refresh?: string; readonly expiresIn?: number },
    ) => void refreshAnswers.set(refresh, next),
    stop: () => server.stop(true),
  }
}

export type FakeGitHub = ReturnType<typeof startFakeGitHub>
