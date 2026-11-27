export * as GitHubCredential from "./credential.js"

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { Option, Schema } from "effect"
import { GitHubCaller } from "./caller.js"

/**
 * git's logins through own (16 §6): git and gh processes that own and its agents start get, in their environment,
 * git's credential helper for the account's site (`credential.<site>.helper`, through `GIT_CONFIG_COUNT`, so no git
 * config file changes) and a ticket. When git needs a login it runs the helper, which hands git's request with the
 * ticket to own's listener on 127.0.0.1, and own answers with the token of the account the ticket's folder (and
 * conversation) uses now. The token never sits in an environment variable, a file or a command line.
 *
 * A ticket is signed with a key of this process and lives as long as the command it was made for (GH-19): until the
 * caller's signal ends it (the command exited) or its time is up. Its time counts from its first use, so a command the
 * user approves late, or one moved to the background, still logs in (GH-27); nothing outlives {@link MAX_TICKET_MS}
 * from the ticket's making. Every request names its repository (`credential.<site>.useHttpPath`), and only git's own
 * HTTP transport and git-lfs of this service's git may ask (`GitHubCaller`, Windows only); the answer's owner decides
 * per repository and logs every answer.
 *
 * The listener is one per process (every Location's plugin instance shares it, through `globalThis`) and stops when
 * the last instance that answers goes.
 */

/** What a ticket names: the folder the process started in and, when known, its root conversation. */
export interface Place {
  readonly directory: string
  readonly root?: string
}

/** git's request (`git credential` fields), where it comes from and who asks. */
export interface Ask extends Place {
  readonly protocol: string
  readonly host: string
  readonly path?: string
  /** Who asks (`GitHubCaller`): never trusted off Windows or when the caller cannot be read. */
  readonly caller: GitHubCaller.Verdict
}

export interface Login {
  readonly username: string
  readonly password: string
}

export type Answer = (ask: Ask) => Promise<Login | undefined>

/** How long a ticket lives at most from its making, whatever its command does. */
export const MAX_TICKET_MS = 6 * 60 * 60_000

/**
 * How long an SSH host's stub waits, at a ticket's first use, for the command it was made for to be named
 * ({@link started}): the shell's `shell.created` event comes through the event stream and may come after the command's
 * first git request (GH-48).
 */
export const HOLDER_WAIT_MS = 10_000

/** For an account that allows no writes: push URLs of its site are rewritten to this name, which git cannot reach. */
export const READ_ONLY_SCHEME = "github-account-is-read-only"

/**
 * The push URL a read-only account's site becomes: git's remote-helper form (`<transport>::<address>`). git looks for
 * `git-remote-github-account-is-read-only` and stops at once with the name in its message; git-lfs stops before any
 * network (`missing protocol`). A `<name>://` URL instead made git-lfs read the name as an SSH host and run ssh a dozen
 * times (about 25 s, GH-36).
 */
export const READ_ONLY_PUSH_URL = `${READ_ONLY_SCHEME}::`

interface Shared {
  readonly key: Buffer
  readonly answers: Answer[]
  /** Live tickets by id. */
  readonly tickets: Map<string, Ticket>
  server?: ReturnType<typeof Bun.serve>
  base?: string
  images?: ReadonlyArray<string>
}

/**
 * A ticket's clock: made at `issued`, first used at `first`, good for `ms` from its first use. `holder`: on an SSH host's
 * relay stub, the command process it belongs to (`<pid>:<start time>`, GH-48): named when the command starts
 * (`start`, {@link started}), or else the first one to use it.
 */
interface Ticket {
  readonly issued: number
  readonly ms: number
  first?: number
  holder?: string
  readonly start?: PromiseWithResolvers<void>
}

const KEY = Symbol.for("own-open-code.github-credential")

function shared(): Shared {
  // One listener per process, like the runtime singleton (01 §4).
  const holder = globalThis as unknown as Record<symbol, Shared | undefined>
  const existing = holder[KEY]
  if (existing) return existing
  const created: Shared = { key: randomBytes(32), answers: [], tickets: new Map() }
  holder[KEY] = created
  return created
}

/** Makes `answer` the one the listener asks (the newest answers); the result takes it back and stops the listener. */
export function provide(answer: Answer) {
  const state = shared()
  state.answers.push(answer)
  return () => {
    const index = state.answers.lastIndexOf(answer)
    if (index >= 0) state.answers.splice(index, 1)
    if (state.answers.length > 0 || !state.server) return
    void state.server.stop(true)
    state.server = undefined
    state.base = undefined
  }
}

/**
 * The helper git runs (`!` = a shell command, run by git's own shell, Git for Windows' too): for `get` it posts
 * git's request to the ticket's address with curl and prints the answer; `store` and `erase` are read and ignored.
 * curl prints nothing when own does not answer, and git goes on as without a login.
 */
export const HELPER =
  '!f() { test "$1" = get || { cat >/dev/null; exit 0; }; curl -fsS --noproxy "*" --max-time 15 --data-binary @- "$OWN_GITHUB_CREDENTIAL"; }; f'

/** How long a ticket lives from its first use and what ends it earlier. */
export interface Lifetime {
  readonly ms: number
  /** The command exited: the ticket ends now. */
  readonly signal?: AbortSignal
  /**
   * The command's process is named once it is spawned ({@link started}); only that process may use the ticket, and no
   * one before it is named (GH-48).
   */
  readonly bound?: boolean
}

/**
 * The variables that send git's logins for `site` to own, added after `env`'s own `GIT_CONFIG_*` entries: an empty
 * helper first, which clears the helpers the user's git config names for that site (Git Credential Manager would
 * otherwise answer first with whatever login it has), then own's, then `useHttpPath` (each request names its
 * repository). For an account that allows no writes, pushes to the site go to {@link READ_ONLY_PUSH_URL} instead.
 */
export async function environment(
  env: Readonly<Record<string, string | undefined>>,
  site: string,
  place: Place,
  options: { readonly lifetime: Lifetime; readonly readOnly: boolean },
): Promise<Record<string, string>> {
  const url = await ticketURL(place, options.lifetime)
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10)
  const start = Number.isInteger(count) && count > 0 ? count : 0
  const origin = new URL(site).origin
  const entries: Array<readonly [string, string]> = [
    [`credential.${origin}.helper`, ""],
    [`credential.${origin}.helper`, HELPER],
    [`credential.${origin}.useHttpPath`, "true"],
    ...(options.readOnly ? [[`url.${READ_ONLY_PUSH_URL}.pushInsteadOf`, `${origin}/`] as const] : []),
  ]
  return {
    GIT_CONFIG_COUNT: String(start + entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${start + index}`, key],
        [`GIT_CONFIG_VALUE_${start + index}`, value],
      ]),
    ),
    OWN_GITHUB_CREDENTIAL: url,
  }
}

/** The listener's address with a new ticket for `place`, started on first use. */
export async function ticketURL(place: Place, lifetime: Lifetime) {
  const state = shared()
  const base = state.base ?? listen(state)
  return `${base}/git/${issue(state, place, lifetime)}`
}

/**
 * A new ticket for `place` without this PC's listener: an SSH host's git relay stub checks it (16 §8, GH-37), with the
 * same key, clock and end as this PC's.
 */
export function issueTicket(place: Place, lifetime: Lifetime) {
  return issue(shared(), place, lifetime)
}

/** The place of a live ticket (its first use starts its clock), or `undefined` for a forged, ended or missing one. */
export function redeem(value: string | null | undefined): Place | undefined {
  if (!value || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return undefined
  const state = shared()
  const place = verify(state.key, value)
  if (!place || !live(state, place.id)) return undefined
  return place.root === undefined ? { directory: place.directory } : { directory: place.directory, root: place.root }
}

/**
 * Names the process of the command a {@link Lifetime.bound} ticket was made for (`<pid>:<start time>`, GH-48), as soon
 * as it is spawned; `undefined` when it could not be read (the ticket then works for no one).
 */
export function started(value: string, holder: string | undefined) {
  const item = find(shared(), value)
  if (!item?.start) return
  if (holder !== undefined) item.holder ??= holder
  item.start.resolve()
}

/**
 * Whether a live ticket may be used by the command process `holder` names (`<pid>:<start time>`, GH-48). A ticket bound
 * at its command's start waits up to `waitMs` for that command to be named and then works for it alone: a process that
 * read the ticket out of the command's environment and started itself again with it (`exec`, which rewrites
 * `/proc/<pid>/environ`) is not that command, even when it asks first. Any other ticket is kept by the first holder.
 */
export async function bind(value: string, holder: string, waitMs = HOLDER_WAIT_MS) {
  const item = find(shared(), value)
  if (!item) return false
  if (item.start) {
    await settle(value, waitMs)
    return item.holder === holder
  }
  item.holder ??= holder
  return item.holder === holder
}

/** Waits up to `waitMs` for the command of a ticket bound at its start to be named ({@link started}). */
export async function settle(value: string, waitMs = HOLDER_WAIT_MS) {
  const start = find(shared(), value)?.start
  if (!start) return
  const waited = Promise.withResolvers<void>()
  const timer = setTimeout(waited.resolve, waitMs)
  await Promise.race([start.promise, waited.promise])
  clearTimeout(timer)
}

/**
 * Whether `holder` (`<pid>:<start time>`) is the command process this service named at its start for a live ticket
 * ({@link started}). An SSH host's caller check takes it for this service's own (`GitHubProc.Judge.commands`): a shell
 * command under core's process daemon has no other tie to the service (MR18).
 */
export function named(holder: string) {
  const now = Date.now()
  return [...shared().tickets.values()].some((item) => item.start && item.holder === holder && alive(item, now))
}

function find(state: Shared, value: string) {
  const place = verify(state.key, value)
  return place === undefined ? undefined : state.tickets.get(place.id)
}

/**
 * The variables that send git's requests for `site` through an SSH host's git relay stub (16 §8, GH-37), added after
 * `env`'s own `GIT_CONFIG_*` entries: `url.<stub>/<site host>/.insteadOf=<site>/` (git and git-lfs talk to the stub,
 * which relays to this PC, which adds the login: no token on the host), the ticket as an extra header for the stub only
 * (`http.<stub>/.extraHeader`), an empty credential helper for the stub (nothing of the user's answers there), and for
 * an account that allows no writes the same {@link READ_ONLY_PUSH_URL} as this PC's.
 */
export function relayEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  site: string,
  stub: string,
  ticket: string,
  options: { readonly readOnly: boolean },
): Record<string, string> {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10)
  const start = Number.isInteger(count) && count > 0 ? count : 0
  const origin = new URL(site)
  const base = `${stub.replace(/\/+$/, "")}/`
  const entries: Array<readonly [string, string]> = [
    [`url.${base}${origin.host}/.insteadOf`, `${origin.origin}/`],
    [`http.${base}.extraHeader`, `X-Own-GitHub-Ticket: ${ticket}`],
    [`credential.${base}.helper`, ""],
    ...(options.readOnly ? [[`url.${READ_ONLY_PUSH_URL}.pushInsteadOf`, `${origin.origin}/`] as const] : []),
  ]
  return {
    GIT_CONFIG_COUNT: String(start + entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${start + index}`, key],
        [`GIT_CONFIG_VALUE_${start + index}`, value],
      ]),
    ),
  }
}

function issue(state: Shared, place: Place, lifetime: Lifetime) {
  const now = Date.now()
  for (const [id, item] of state.tickets) if (!alive(item, now)) state.tickets.delete(id)
  const id = randomBytes(12).toString("base64url")
  state.tickets.set(id, {
    issued: now,
    ms: Math.min(Math.max(lifetime.ms, 0), MAX_TICKET_MS),
    ...(lifetime.bound ? { start: Promise.withResolvers<void>() } : {}),
  })
  const end = () => state.tickets.delete(id)
  if (lifetime.signal?.aborted) end()
  lifetime.signal?.addEventListener("abort", end, { once: true })
  return ticket(state.key, id, place)
}

function listen(state: Shared) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => handle(state, request, server.requestIP(request)?.port, server.port),
  })
  state.server = server
  state.base = `http://127.0.0.1:${server.port}`
  return state.base
}

async function handle(state: Shared, request: Request, clientPort: number | undefined, serverPort: number | undefined) {
  const url = new URL(request.url)
  const match = /^\/git\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(url.pathname)
  // A browser page cannot use it: no form or fetch from a page carries no Origin.
  if (request.method !== "POST" || !match || request.headers.get("origin")) return new Response("", { status: 404 })
  const place = verify(state.key, match[1]!)
  if (!place || !live(state, place.id)) return new Response("", { status: 403 })
  const fields = parseFields(await request.text().catch(() => ""))
  const protocol = fields.get("protocol")
  const host = fields.get("host")
  if (!protocol || !host) return new Response("", { status: 400 })
  state.images ??= GitHubCaller.images()
  // Read while the caller still waits on this connection, so its end of it is in the TCP table. Without the client's
  // address the caller is unknown, and not trusted (GH-34). A git program not on the list reads it again when a listed
  // program is gone (Git updated, GU-10).
  const caller = GitHubCaller.judge(clientPort, serverPort, state.images, () => (state.images = GitHubCaller.images()))
  const answer = state.answers.at(-1)
  const login = answer
    ? await answer({
        directory: place.directory,
        ...(place.root === undefined ? {} : { root: place.root }),
        protocol,
        host,
        ...(fields.get("path") === undefined ? {} : { path: fields.get("path") }),
        caller,
      }).catch(() => undefined)
    : undefined
  if (!login) return new Response("", { status: 404 })
  return new Response(`protocol=${protocol}\nhost=${host}\nusername=${login.username}\npassword=${login.password}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  })
}

/** Whether ticket `id` is live now; its first use starts its clock. */
function live(state: Shared, id: string) {
  const item = state.tickets.get(id)
  if (item === undefined) return false
  const now = Date.now()
  if (!alive(item, now)) {
    state.tickets.delete(id)
    return false
  }
  item.first ??= now
  return true
}

function alive(item: Ticket, now: number) {
  return now - item.issued < MAX_TICKET_MS && (item.first === undefined || now - item.first < item.ms)
}

/** `git credential` input: `key=value` lines up to an empty line. */
export function parseFields(text: string) {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line === "") break
    const at = line.indexOf("=")
    if (at <= 0) continue
    fields.set(line.slice(0, at), line.slice(at + 1))
  }
  return fields
}

export function ticket(key: Buffer, id: string, place: Place) {
  const payload = Buffer.from(
    JSON.stringify(place.root ? [id, place.directory, place.root] : [id, place.directory]),
  ).toString("base64url")
  return `${payload}.${sign(key, payload)}`
}

export function verify(key: Buffer, value: string): (Place & { readonly id: string }) | undefined {
  const [payload, signature] = value.split(".")
  if (!payload || !signature) return undefined
  const expected = Buffer.from(sign(key, payload))
  const given = Buffer.from(signature)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined
  const decoded = Option.getOrUndefined(decodePayload(Buffer.from(payload, "base64url").toString("utf8")))
  if (!decoded) return undefined
  return decoded[2] === undefined
    ? { id: decoded[0], directory: decoded[1] }
    : { id: decoded[0], directory: decoded[1], root: decoded[2] }
}

const decodePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Tuple([Schema.String, Schema.String]),
      Schema.Tuple([Schema.String, Schema.String, Schema.String]),
    ]),
  ),
)

function sign(key: Buffer, payload: string) {
  return createHmac("sha256", key).update(payload).digest("base64url")
}
