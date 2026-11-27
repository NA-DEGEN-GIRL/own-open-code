// Substitutes packages/session-ui/src/components/markdown-worker.ts @ 698800f59c (MIT). See own/ledger/vendored.yaml
// own: swapped in at build time by vite/plugins.ts `substitute` (FORK.md §7 kind "substitute"); changes are marked
// "own:". Upstream's client and state machine run unchanged on upstream's worker. own adds `projectMarkdownTail`, the
// incremental `tail` projection (src/markdown/tail.ts), on a worker of its own (src/markdown/worker.ts): since v2.2.6
// the machine owns its worker's lifecycle and every response, so a second request type cannot share it.
import type { Projection } from "../../../../session-ui/src/components/markdown-stream"
import {
  INITIAL_MARKDOWN_WORKER_STATE,
  transitionMarkdownWorker,
  type MarkdownWorkerEffect,
  type MarkdownWorkerEvent,
  type WorkerRejectReason,
} from "../../../../session-ui/src/components/markdown-worker-machine"
import type {
  MarkdownHTML,
  MarkdownWorkerRequest,
  MarkdownWorkerResponse,
  MarkdownWorkerState,
} from "../../../../session-ui/src/components/markdown-worker-protocol"
// own: the tail projection's worker, messages and per-key queue.
import type { TailDelta } from "../../markdown/tail"
import { createWorkerTransport } from "../../markdown/transport"
import type { TailRequest, TailResponse } from "../../markdown/worker"

export class MarkdownWorkerDisposedError extends Error {}

// Made once: disposal rejects from inside a Solid cleanup, and a new error there would record that stack and keep the
// whole disposing batch alive for as long as the rejected promise is reachable.
export const markdownWorkerDisposed = new MarkdownWorkerDisposedError()

export class MarkdownWorkerSupersededError extends Error {}

// Made once: streaming supersedes a queued snapshot on almost every delta, and each new error would capture a stack.
export const markdownWorkerSuperseded = new MarkdownWorkerSupersededError()

export class MarkdownWorkerUnavailableError extends Error {}

type Settle<T> = { readonly resolve: (value: T) => void; readonly reject: (error: Error) => void }

type Resolver =
  | (Settle<MarkdownHTML> & { readonly kind: "parse" })
  | (Settle<Projection> & { readonly kind: "project" })
  | (Settle<MarkdownWorkerState> & { readonly kind: "highlight" })

/** The part of a `Worker` the client uses. */
export type MarkdownWorkerPort = {
  onmessage: ((event: MessageEvent<MarkdownWorkerResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(message: MarkdownWorkerRequest): void
  terminate(): void
}

type Run = { readonly worker: MarkdownWorkerPort; watchdog: ReturnType<typeof setTimeout> | undefined }

/** Runs the markdown worker machine: spawns workers, posts requests and settles each caller's promise. */
export function createMarkdownWorkerClient(spawn: () => MarkdownWorkerPort) {
  let state = INITIAL_MARKDOWN_WORKER_STATE
  const queue: MarkdownWorkerEvent[] = []
  const resolvers = new Map<number, Resolver>()
  const runs = new Map<number, Run>()

  const dispatch = (event: MarkdownWorkerEvent) => {
    queue.push(event)

    // An effect can dispatch while effects run (a worker that fails to construct); the outer loop drains it next.
    if (queue.length > 1) return

    while (queue.length > 0) {
      try {
        const next = transitionMarkdownWorker(state, queue[0]!)
        state = next.state
        next.effects.forEach(run)
      } catch (error) {
        console.error("Markdown worker transition failed", error)
      } finally {
        queue.shift()
      }
    }
  }

  // Every request takes the next id in every state, so its resolver is in place before any effect can settle it.
  const request = (event: MarkdownWorkerEvent, resolver: Resolver) => {
    resolvers.set(state.issued + 1, resolver)
    dispatch(event)
  }

  const run = (effect: MarkdownWorkerEffect) => {
    try {
      perform(effect)
    } catch (error) {
      console.error("Markdown worker effect failed", error)
    }
  }

  const perform = (effect: MarkdownWorkerEffect) => {
    if (effect.type === "spawn-worker") return start(effect.attempt)

    if (effect.type === "close-worker") {
      const current = runs.get(effect.attempt)

      if (!current) return
      runs.delete(effect.attempt)
      clearTimeout(current.watchdog)
      current.worker.onmessage = null
      current.worker.onerror = null
      current.worker.onmessageerror = null
      current.worker.terminate()

      return
    }

    if (effect.type === "post") return runs.get(effect.attempt)?.worker.postMessage(effect.message)

    if (effect.type === "arm-watchdog") {
      const current = runs.get(effect.attempt)

      if (!current) return
      clearTimeout(current.watchdog)
      current.watchdog = setTimeout(() => dispatch({ type: "watchdog.fired", attempt: effect.attempt }), effect.delay)

      return
    }

    if (effect.type === "schedule-retry") {
      setTimeout(() => dispatch({ type: "retry.ready", attempt: effect.attempt }), effect.delay)

      return
    }

    if (effect.type === "reject") {
      const error = rejection(effect.reason)

      return effect.ids.forEach((id) => {
        const resolver = resolvers.get(id)
        resolvers.delete(id)
        resolver?.reject(error)
      })
    }

    const resolver = resolvers.get(effect.id)
    resolvers.delete(effect.id)

    if (effect.type === "resolve-parse" && resolver?.kind === "parse") return resolver.resolve(effect.html)

    if (effect.type === "resolve-project" && resolver?.kind === "project") return resolver.resolve(effect.projection)

    if (effect.type === "resolve-highlight" && resolver?.kind === "highlight") return resolver.resolve(effect.value)
  }

  const start = (attempt: number) => {
    let worker: MarkdownWorkerPort

    try {
      worker = spawn()
    } catch (error) {
      dispatch({
        type: "worker.spawn-failed",
        attempt,
        message: error instanceof Error ? error.message : String(error),
      })

      return
    }

    runs.set(attempt, { worker, watchdog: undefined })
    worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) =>
      dispatch({ type: "worker.message", attempt, response: event.data })
    worker.onerror = (event) =>
      dispatch({ type: "worker.crashed", attempt, message: event.message || "Markdown highlighting worker failed" })
    worker.onmessageerror = () =>
      dispatch({ type: "worker.crashed", attempt, message: "Markdown worker response failed" })
  }

  // Callers that cancel by id need no AbortController, listener or promise per parse.
  const startParse = (text: string, settle: Settle<MarkdownHTML>) => {
    const id = state.issued + 1
    request({ type: "parse.requested", text }, { kind: "parse", resolve: settle.resolve, reject: settle.reject })

    return id
  }

  const abortParse = (id: number) => dispatch({ type: "parse.aborted", id })

  return {
    startParse,

    abortParse,

    parseMarkdown(text: string, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(markdownWorkerDisposed)

      return new Promise<MarkdownHTML>((resolve, reject) => {
        if (!signal) {
          startParse(text, { resolve, reject })

          return
        }

        const abort = () => abortParse(id)
        signal.addEventListener("abort", abort, { once: true })

        const id = startParse(text, {
          resolve: (html) => {
            signal.removeEventListener("abort", abort)
            resolve(html)
          },
          reject: (error) => {
            signal.removeEventListener("abort", abort)
            reject(error)
          },
        })
      })
    },

    projectMarkdown(key: string, text: string, live: boolean) {
      return new Promise<Projection>((resolve, reject) =>
        request({ type: "project.requested", key, text, live }, { kind: "project", resolve, reject }),
      )
    },

    disposeMarkdownProjection(key: string) {
      dispatch({ type: "project.disposed", key })
    },

    highlightStreamingCode(key: string, text: string, language: string, complete = false) {
      return new Promise<MarkdownWorkerState>((resolve, reject) =>
        request({ type: "highlight.requested", key, text, language, complete }, { kind: "highlight", resolve, reject }),
      )
    },

    disposeStreamingCode(key: string) {
      dispatch({ type: "highlight.disposed", key })
    },
  }
}

function rejection(reason: WorkerRejectReason) {
  if (reason.kind === "disposed") return markdownWorkerDisposed

  if (reason.kind === "superseded") return markdownWorkerSuperseded

  if (reason.kind === "unavailable") return new MarkdownWorkerUnavailableError(reason.message)

  return new Error(reason.message)
}

// own: upstream's worker, by path from here.
const client = createMarkdownWorkerClient(
  () =>
    new Worker(new URL("../../../../session-ui/src/components/markdown.worker.ts", import.meta.url), {
      type: "module",
    }),
)

export const parseMarkdown = client.parseMarkdown

export const startParseMarkdown = client.startParse

export const abortParseMarkdown = client.abortParse

export const projectMarkdown = client.projectMarkdown

// own: a disposed projection drops its tail projection too.
export const disposeMarkdownProjection = (key: string) => {
  client.disposeMarkdownProjection(key)
  disposeMarkdownTail(key)
}

export const highlightStreamingCode = client.highlightStreamingCode

export const disposeStreamingCode = client.disposeStreamingCode

// own: the tail projection (src/markdown/tail.ts) on own's worker. One request per key at a time and the newest one
// queued; the worker keeps the blocks of every key it answered, so a superseded request that never reached it costs
// nothing. A worker that fails rejects what waits on it and the next request starts a new one, whose first answer for
// a key starts again at block 0.
type TailPending = {
  readonly key: string
  readonly resolve: (delta: TailDelta) => void
  readonly reject: (error: Error) => void
}

const tails = new Map<number, TailPending>()
let tailWorker: Worker | undefined
let nextTailID = 0

const tailTransport = createWorkerTransport<TailRequest>({
  post: (request) => startTailWorker().postMessage(request),
  supersede: (request) => {
    const result = tails.get(request.id)

    if (!result) return
    tails.delete(request.id)
    result.reject(markdownWorkerSuperseded)
  },
})

function startTailWorker() {
  if (tailWorker) return tailWorker
  const worker = new Worker(new URL("../../markdown/worker.ts", import.meta.url), { type: "module" })
  worker.onmessage = (event: MessageEvent<TailResponse>) => {
    const result = tails.get(event.data.id)
    tails.delete(event.data.id)

    if (event.data.type === "tail") result?.resolve(event.data.delta)
    else result?.reject(new Error(event.data.message))
    tailTransport.complete(event.data.key, event.data.id)
  }
  const fail = (message: string) => {
    worker.terminate()
    if (tailWorker === worker) tailWorker = undefined
    tailTransport.reset()
    const error = new MarkdownWorkerUnavailableError(message)
    tails.forEach((request) => request.reject(error))
    tails.clear()
  }
  worker.onerror = (event) => fail(event.message || "Markdown tail worker failed")
  worker.onmessageerror = () => fail("Markdown tail worker response failed")
  tailWorker = worker

  return worker
}

/** own: the blocks of `text` from the first one that changed since this key's last answered request. */
export function projectMarkdownTail(key: string, text: string, live: boolean) {
  const id = ++nextTailID

  return new Promise<TailDelta>((resolve, reject) => {
    tails.set(id, { key, resolve, reject })
    tailTransport.send({ type: "tail", id, key, text, live })
  })
}

function disposeMarkdownTail(key: string) {
  tailTransport.dispose(key)
  tails.forEach((request, id) => {
    if (request.key !== key) return
    tails.delete(id)
    request.reject(markdownWorkerDisposed)
  })
  tailWorker?.postMessage({ type: "dispose", key })
}
