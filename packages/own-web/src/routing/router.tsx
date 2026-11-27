// Minimal two-mode router (01 §6.2): path routing on the web, a memory router on desktop because `oc://renderer`
// has no SPA fallback. The memory stack is saved per window key so a restored window reopens where it was.
import { createContext, createSignal, onCleanup, splitProps, useContext, type JSX, type ParentProps } from "solid-js"
import { parseRoute, routePath, type Route } from "./routes"

export interface Router {
  readonly route: () => Route
  readonly path: () => string
  navigate(to: Route | string, options?: { readonly replace?: boolean }): void
  back(): void
  forward(): void
}

export function createPathRouter(): Router {
  const initial = parseRoute(location.pathname)
  if (initial.replace) history.replaceState(history.state, "", initial.replace + location.search)
  const [path, setPath] = createSignal(initial.replace ?? location.pathname)
  const [route, setRoute] = createSignal(initial.route, { equals: sameRoute })
  const sync = () => {
    const parsed = parseRoute(location.pathname)
    if (parsed.replace) history.replaceState(history.state, "", parsed.replace)
    setPath(parsed.replace ?? location.pathname)
    setRoute(parsed.route)
  }
  window.addEventListener("popstate", sync)
  onCleanup(() => window.removeEventListener("popstate", sync))
  return {
    route,
    path,
    navigate(to, options) {
      const target = typeof to === "string" ? parseRoute(to) : { route: to }
      const next = target.replace ?? routePath(target.route)
      if (next === location.pathname) return
      if (options?.replace) history.replaceState(null, "", next)
      else history.pushState(null, "", next)
      setPath(next)
      setRoute(target.route)
    },
    back: () => history.back(),
    forward: () => history.forward(),
  }
}

export function createMemoryRouter(storageKey: string): Router {
  const saved = load(storageKey)
  const [stack, setStack] = createSignal<{ entries: string[]; index: number }>(saved ?? { entries: ["/"], index: 0 })
  const path = () => stack().entries[stack().index] ?? "/"
  const [route, setRoute] = createSignal(parseRoute(path()).route, { equals: sameRoute })
  const commit = (next: { entries: string[]; index: number }) => {
    setStack(next)
    setRoute(parseRoute(next.entries[next.index] ?? "/").route)
    save(storageKey, next)
  }
  return {
    route,
    path,
    navigate(to, options) {
      const target = typeof to === "string" ? parseRoute(to) : { route: to }
      const next = target.replace ?? routePath(target.route)
      const current = stack()
      if (next === path()) return
      if (options?.replace) {
        const entries = current.entries.slice()
        entries[current.index] = next
        return commit({ entries, index: current.index })
      }
      const entries = [...current.entries.slice(0, current.index + 1), next].slice(-100)
      commit({ entries, index: entries.length - 1 })
    },
    back() {
      const current = stack()
      if (current.index > 0) commit({ ...current, index: current.index - 1 })
    },
    forward() {
      const current = stack()
      if (current.index < current.entries.length - 1) commit({ ...current, index: current.index + 1 })
    },
  }
}

function sameRoute(a: Route, b: Route) {
  return routePath(a) === routePath(b)
}

function load(key: string) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (typeof value !== "object" || value === null || !("entries" in value) || !("index" in value)) return undefined
    const entries = Array.isArray(value.entries) ? value.entries.filter((item) => typeof item === "string") : []
    const index = typeof value.index === "number" ? Math.min(value.index, entries.length - 1) : -1
    return entries.length && index >= 0 ? { entries, index } : undefined
  } catch {
    return undefined
  }
}

function save(key: string, value: { entries: string[]; index: number }) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const RouterContext = createContext<Router>()

export function RouterProvider(props: ParentProps<{ value: Router }>) {
  return <RouterContext.Provider value={props.value}>{props.children}</RouterContext.Provider>
}

export function useRouter() {
  const value = useContext(RouterContext)
  if (!value) throw new Error("useRouter() needs <RouterProvider>")
  return value
}

/** An anchor that navigates in place; modified clicks keep the browser behavior (new tab) in path mode. */
export function RouteLink(
  props: ParentProps<{ readonly to: Route } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">>,
) {
  const router = useRouter()
  const [local, rest] = splitProps(props, ["to", "children", "onClick"])
  return (
    <a
      {...rest}
      href={routePath(local.to)}
      onClick={(event) => {
        // The caller's handler first (e.g. Ctrl+click opening a session in a split pane, 03 §4.1.1).
        const handler = local.onClick
        if (typeof handler === "function") handler(event)
        else if (Array.isArray(handler)) handler[0](handler[1], event)
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        router.navigate(local.to)
      }}
    >
      {local.children}
    </a>
  )
}
