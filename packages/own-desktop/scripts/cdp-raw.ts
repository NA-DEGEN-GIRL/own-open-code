// A bare Chrome DevTools Protocol client over one WebSocket, for the steps a Playwright connection would distort:
// Playwright enables focus emulation on every page it attaches to (document.hasFocus() is then always true), so
// "is the window focused / hidden" checks (G-D4 notifications, PF8 hidden window) run with Playwright disconnected
// and only this client attached. It enables nothing on its own.
export interface RawCdp {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>
  on(method: string, listener: (params: Record<string, unknown>) => void): void
  once(method: string): Promise<Record<string, unknown>>
  /** Runtime.evaluate with awaitPromise and returnByValue; throws on an exception in the page. */
  evaluate<T = unknown>(expression: string): Promise<T>
  close(): void
}

export async function rawCdp(url: string): Promise<RawCdp> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error(`CDP socket failed: ${url}`)), { once: true })
  })
  let next = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>()
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data)) as {
      id?: number
      result?: unknown
      error?: { message: string }
      method?: string
      params?: Record<string, unknown>
    }
    if (data.id !== undefined) {
      const waiter = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) waiter?.reject(new Error(data.error.message))
      else waiter?.resolve(data.result)
      return
    }
    if (data.method) for (const listener of listeners.get(data.method) ?? []) listener(data.params ?? {})
  })
  // A shell that quit or crashed answers nothing more: what waits fails now instead of never (a run would hang).
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`CDP socket closed: ${url}`))
    pending.clear()
  })
  const client: RawCdp = {
    send(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP socket closed: ${url}`))
      const id = next++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (value: unknown) => void, reject }))
    },
    on(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener])
    },
    once(method) {
      return new Promise((resolve) => {
        const listener = (params: Record<string, unknown>) => {
          listeners.set(
            method,
            (listeners.get(method) ?? []).filter((item) => item !== listener),
          )
          resolve(params)
        }
        client.on(method, listener)
      })
    },
    async evaluate<T>(expression: string) {
      const result = await client.send<{
        result: { value?: unknown }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    },
    close() {
      socket.close()
    },
  }
  return client
}

/** The shell renderer's page target (oc://renderer or a dev URL with window.own) and the browser target. */
export async function cdpTargets(base: string) {
  const list = (await fetch(`${base}/json/list`).then((response) => response.json())) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  const version = (await fetch(`${base}/json/version`).then((response) => response.json())) as {
    webSocketDebuggerUrl: string
  }
  const page = list.find((target) => target.type === "page" && target.url.startsWith("oc://renderer"))
  return { page: page?.webSocketDebuggerUrl, browser: version.webSocketDebuggerUrl }
}
