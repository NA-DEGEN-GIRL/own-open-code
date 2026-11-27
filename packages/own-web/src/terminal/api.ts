// PTY API for one location (03 §18.6 "데이터·API"): `GET/POST /api/pty`, `PUT /api/pty/:id` (size), `DELETE`,
// `POST /api/pty/:id/connect-token` → `GET /api/pty/:id/connect` (WebSocket, ticket auth). Calls go through the
// server runtime's client (only src/data may load @opencode/client code); the socket URL is built like upstream
// `createPtyClient` (packages/client/src/solid/pty.ts), which lives in that package's runtime.
// Desktop uses the same path: tickets are minted by the page's authenticated request and the WebSocket carries only
// the single-use ticket (01 §6.1), never a password or a token in the URL.
import type { ConfigShellOption, OpenCodeClient, Pty } from "@opencode/client"

export type PtyInfo = Pty
export type ShellOption = ConfigShellOption

/** Header value the server requires before it mints a ticket (forces a CORS preflight). */
const TICKET_HEADER = "1"

/**
 * Added to every terminal's environment. PowerShell 7.6 dies at start (Environment.FailFast, exit -2146232797,
 * `totalWidth ('-23') must be a non-negative value`) when it has an update to announce inside a ConPTY, at any width:
 * with a newer release out, every new pwsh tab closed at once. Its exit code also broke `GET /api/pty` until core
 * recorded such codes unsigned (P-033), so no terminal of that folder could open. The variable only turns that
 * notice off.
 */
const TERMINAL_ENV = { POWERSHELL_UPDATECHECK: "Off" } as const

export interface PtyApi {
  readonly directory: string
  list(): Promise<PtyInfo[]>
  create(input: { readonly command?: string; readonly title?: string }): Promise<PtyInfo>
  get(ptyID: string): Promise<PtyInfo>
  resize(ptyID: string, size: { readonly cols: number; readonly rows: number }): Promise<void>
  remove(ptyID: string): Promise<void>
  /** Mints a ticket and opens the WebSocket; `cursor` resumes after output already shown. */
  connect(ptyID: string, cursor: number | undefined): Promise<WebSocket>
  shells(): Promise<ShellOption[]>
}

export function createPtyApi(input: {
  readonly client: () => OpenCodeClient
  readonly baseUrl: () => string
  readonly directory: string
  readonly openSocket?: (url: URL) => WebSocket
}): PtyApi {
  const location = { directory: input.directory }
  return {
    directory: input.directory,
    list: () =>
      input
        .client()
        .pty.list({ location })
        .then((result) => result.data),
    create: (options) =>
      input
        .client()
        .pty.create({ location, command: options.command, title: options.title, env: TERMINAL_ENV })
        .then((result) => result.data),
    get: (ptyID) =>
      input
        .client()
        .pty.get({ ptyID, location })
        .then((result) => result.data),
    resize: (ptyID, size) =>
      input
        .client()
        .pty.update({ ptyID, location, size: { cols: size.cols, rows: size.rows } })
        .then(() => undefined),
    remove: (ptyID) => input.client().pty.remove({ ptyID, location }),
    async connect(ptyID, cursor) {
      const token = await input.client().pty.connect.token({ ptyID, location, "x-opencode-ticket": TICKET_HEADER })
      const url = connectUrl({
        baseUrl: input.baseUrl(),
        ptyID,
        directory: input.directory,
        cursor,
        ticket: token.data.ticket,
      })
      const socket = input.openSocket?.(url) ?? new WebSocket(url)
      socket.binaryType = "arraybuffer"
      return socket
    },
    shells: () => input.client().config.shells(),
  }
}

/** Same URL as upstream `createPtyClient.connect`: joined under a path prefix (gateway `/srv/<key>`), ws(s) scheme. */
export function connectUrl(input: {
  readonly baseUrl: string
  readonly ptyID: string
  readonly directory: string
  readonly cursor: number | undefined
  readonly ticket: string
}) {
  const base = new URL(input.baseUrl)
  if (!base.pathname.endsWith("/")) base.pathname += "/"
  const url = new URL(`api/pty/${encodeURIComponent(input.ptyID)}/connect`, base)
  url.searchParams.set("location[directory]", input.directory)
  if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor))
  url.searchParams.set("ticket", input.ticket)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

/** `pty.get` answered 404: the PTY was removed (or the service restarted and lost it). */
export function isNotFound(error: unknown) {
  return error instanceof Error && error.name === "PtyNotFoundError"
}

/** Control frame: a 0x00 byte and UTF-8 JSON `{cursor}` sent once after replay (core/pty/protocol.ts). */
export function controlCursor(data: ArrayBuffer, decoder: TextDecoder) {
  const bytes = new Uint8Array(data)
  if (bytes[0] !== 0) return undefined
  const parsed: unknown = JSON.parse(decoder.decode(bytes.subarray(1)))
  if (!parsed || typeof parsed !== "object" || !("cursor" in parsed)) return undefined
  const cursor = parsed.cursor
  return typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined
}
