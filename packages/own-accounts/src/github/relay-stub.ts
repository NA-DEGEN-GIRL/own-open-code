export * as GitHubRelayStub from "./relay-stub.js"

import { Broker } from "@own/protocol"
import type { Logger } from "../logger.js"
import { GitHubCaller } from "./caller.js"
import { GitHubCredential } from "./credential.js"
import { GitHubProc } from "./proc.js"
import { GitHubResolve } from "./resolve.js"

/**
 * An SSH host's end of the git relay (16 §8, GH-37): a loopback HTTP listener of the remote service that git and git-lfs
 * reach instead of GitHub (`url.<stub>/<site host>/.insteadOf=<site>/`, `GitHubCredential.relayEnvironment`). A request
 * goes on only when it carries a live ticket of this service (`x-own-github-ticket`, from `http.<stub>.extraHeader`)
 * and the process at the other end of its connection is this service's own git transport or git-lfs ({@link judge}:
 * Windows' `GitHubCaller`, Linux's `GitHubProc`). On Linux the ticket also belongs to the command the caller runs under
 * (GH-48): that command's process (the service's own child, or a shell core's process daemon started) holds exactly this
 * ticket, and it is the process the ticket
 * was made for, named when the command started (`GitHubCredential.started` and `bind`, by its id and start time; a
 * ticket without a named start is kept by its first user). It then goes to the PC's egress relay through
 * the tunnel, signed with
 * the arm's key (`x-own-github`) over its method, path and place (the ticket's folder, its main checkout read here, its
 * conversation); the PC picks the account, refuses a read-only account's push and adds the login. Request and answer
 * stream. Nothing here holds a token, and the ticket never leaves this host.
 */

/** Where callers can be told apart: Windows (the TCP table) and Linux (`/proc`). Elsewhere git gets no relay. */
export const CHECKED = process.platform === "win32" || process.platform === "linux"

export interface Stub {
  readonly url: string
  close(): Promise<void>
}

export interface Input {
  /** The next `x-own-github` proof, or none before a normal-mode session with an egress forward. */
  readonly proof: (input: { readonly method: string; readonly path: string; readonly place: string }) => string | undefined
  /** The local end of the egress forward (`EgressStub`), when the current arm names one. */
  readonly egress: () => string | undefined
  readonly log: Logger.Logger
  /** Tests: another caller check. */
  readonly judge?: (clientPort: number | undefined, serverPort: number | undefined) => GitHubProc.Verdict
  /** Tests: another `/proc` for the command's environment. */
  readonly proc?: GitHubProc.Proc
  /** Tests: how long a ticket's first use waits for its command to be named (`GitHubCredential.HOLDER_WAIT_MS`). */
  readonly holderWaitMs?: number
}

/** Request headers of git and git-lfs the stub passes on (never an `authorization` of its own). */
const FORWARDED = ["content-type", "accept", "git-protocol", "content-encoding", "user-agent"]

/** Response headers the stub does not pass back. */
const DROPPED = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "upgrade"])

export function start(input: Input): Stub {
  const check = input.judge ?? judge
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    fetch: (request, served) => handle(request, served),
    error: () => refusal(503, "unavailable"),
  })

  async function handle(request: Request, served: { requestIP(request: Request): { port: number } | null; timeout(request: Request, seconds: number): void; port: number | undefined }) {
    const url = new URL(request.url)
    if (!/^\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/./.test(url.pathname)) return refusal(404, "bad_request")
    const ticket = request.headers.get(Broker.GITHUB_TICKET_HEADER)
    const place = GitHubCredential.redeem(ticket)
    if (!ticket || !place) {
      input.log.warn("github_git_relay_refused", { reason: "ticket" })
      return refusal(403, "ticket")
    }
    // A command under core's process daemon is this service's only once it is named (GitHubProc.Judge.commands).
    await GitHubCredential.settle(ticket, input.holderWaitMs)
    // Read while the caller still waits on this connection, so its end of it is in the system's table.
    const caller = check(served.requestIP(request)?.port, served.port)
    if (!caller.trusted) {
      input.log.warn("github_git_relay_refused", { reason: "caller", via: caller.via })
      return refusal(403, "caller")
    }
    // A ticket of another command (read out of its environment) is not this command's (GH-48).
    const command = caller.command
    if (
      command &&
      !(
        GitHubProc.holds(input.proc ?? GitHubProc.system, command.pid, ticket) &&
        (await GitHubCredential.bind(ticket, `${command.pid}:${command.start}`, input.holderWaitMs))
      )
    ) {
      input.log.warn("github_git_relay_refused", { reason: "command", via: caller.via })
      return refusal(403, "ticket")
    }
    const main = await GitHubResolve.mainCheckout(place.directory)
    const placeHeader = Buffer.from(
      JSON.stringify({
        directory: place.directory,
        ...(main === undefined ? {} : { main }),
        ...(place.root === undefined ? {} : { root: place.root }),
      } satisfies Broker.GitHubPlace),
    ).toString("base64url")
    const egress = input.egress()
    const proof = input.proof({ method: request.method, path: `${url.pathname}${url.search}`, place: placeHeader })
    if (!egress || !proof) {
      input.log.warn("github_git_relay_refused", { reason: "unavailable" })
      return refusal(503, "unavailable")
    }
    const headers = new Headers()
    for (const name of FORWARDED) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    headers.set(Broker.GITHUB_HEADER, proof)
    headers.set(Broker.GITHUB_PLACE_HEADER, placeHeader)
    // A clone or a push may stream for long once the checks are done.
    served.timeout(request, 0)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body
    // SAFETY: `duplex` is required by fetch for a streamed body; the DOM `RequestInit` type does not list it.
    const init = { method: request.method, headers, body, redirect: "manual", signal: request.signal, duplex: "half", timeout: false } as RequestInit
    const answer = await fetch(`${egress}/github${url.pathname}${url.search}`, init).catch((error: unknown) => {
      if (!request.signal.aborted) input.log.warn("github_git_relay_failed", { error })
      return undefined
    })
    if (!answer) return refusal(503, "unavailable")
    const out = new Headers()
    answer.headers.forEach((value, name) => {
      if (!DROPPED.has(name.toLowerCase())) out.set(name, value)
    })
    return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: out })
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true)
    },
  }
}

/** A refusal of the stub: the code, nothing of the request. */
function refusal(status: number, code: Broker.GitHubGitError) {
  return new Response(`own: GitHub relay refused (${code})\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", connection: "close", [Broker.GITHUB_ERROR_HEADER]: code },
  })
}

/**
 * This platform's caller check against the exact programs of this service's git (read once; on Windows read again for
 * a git program not on the list once a listed program is gone, an updated Git: `GitHubCaller.verdict`).
 */
export function judge(clientPort: number | undefined, serverPort: number | undefined): GitHubProc.Verdict {
  if (process.platform === "win32") return GitHubCaller.judge(clientPort, serverPort, programs(), () => programs(true))
  if (process.platform === "linux")
    return GitHubProc.judge(clientPort, serverPort, programs(), { commands: GitHubCredential.named })
  return { trusted: false, operation: "push", via: "unchecked" }
}

const IMAGES = Symbol.for("own-open-code.github-relay-images")

function programs(fresh = false): ReadonlyArray<string> {
  const holder = globalThis as unknown as Record<symbol, ReadonlyArray<string> | undefined>
  const known = holder[IMAGES]
  if (known && !fresh) return known
  const found = process.platform === "win32" ? GitHubCaller.images() : GitHubProc.images()
  holder[IMAGES] = found
  return found
}
