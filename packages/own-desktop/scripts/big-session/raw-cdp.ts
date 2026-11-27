// A bare CDP connection to the shell: no domain is enabled unless a caller enables it. Playwright enables the Network
// domain on every page it attaches to, and the renderer's DevTools agent then keeps the bodies of the responses it
// sees (up to its buffer limits) inside the renderer, which hides what the app itself keeps. `--quiet-paging` drives
// the transcript through this connection instead.

type Listener = (payload: never) => void

export type RawSession = Awaited<ReturnType<typeof rawSession>>

export async function rawSession(url: string) {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error(`CDP ${url}: no connection`)), { once: true })
  })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<Listener>>()
  const state = { next: 0 }
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: unknown
    }
    if (message.id === undefined) {
      listeners.get(message.method ?? "")?.forEach((listener) => listener(message.params as never))
      return
    }
    const waiting = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiting?.reject(new Error(message.error.message))
    else waiting?.resolve(message.result)
  })
  socket.addEventListener("close", () => {
    pending.forEach((waiting) => waiting.reject(new Error("CDP connection closed")))
    pending.clear()
  })
  const on = (event: string, listener: Listener) => {
    listeners.set(event, (listeners.get(event) ?? new Set()).add(listener))
  }
  const off = (event: string, listener: Listener) => {
    listeners.get(event)?.delete(listener)
  }
  return {
    send(method: string, params: object = {}) {
      const id = ++state.next
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    on,
    off,
    once(event: string, listener: Listener) {
      const wrapped: Listener = (payload) => {
        off(event, wrapped)
        listener(payload)
      }
      on(event, wrapped)
    },
    async evaluate<T>(expression: string) {
      const result = (await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    },
    close() {
      socket.close()
    },
  }
}

/** The browser target (Tracing, SystemInfo). */
export async function rawBrowser(port: number) {
  const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json())) as {
    webSocketDebuggerUrl: string
  }
  return rawSession(version.webSocketDebuggerUrl)
}

/** The shell's renderer page: the page target with the preload's `window.own`. */
export async function rawRenderer(port: number) {
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())) as {
    type: string
    webSocketDebuggerUrl?: string
  }[]
  for (const target of targets.filter((item) => item.type === "page" && item.webSocketDebuggerUrl)) {
    const session = await rawSession(target.webSocketDebuggerUrl!)
    if (await session.evaluate<boolean>(`typeof window.own === "object"`).catch(() => false)) return session
    session.close()
  }
  throw new Error("no renderer page")
}
