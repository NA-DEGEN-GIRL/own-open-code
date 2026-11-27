// The main demo world's Claude accounts as the bundled claude-auth (patched at build time, 02 §8.2, §8.7) shows them.
// The demo's plugin is a fake of the bundle that already answers `patched` and holds own's listed accounts; this
// route sets those two fields for a demo backend whose fake does not (nothing else in the answers changes).
import type { BrowserContext } from "./browser"

export async function patchedClaude(context: BrowserContext) {
  await context.route(/\/api\/rpc\/own\.accounts\/(plugin\.claudeAuth\.status|accounts\.)/, async (route) => {
    const response = await route.fetch()
    const body = await response.json().catch(() => undefined)
    if (body === undefined) return route.fulfill({ response })
    const status = route.request().url().includes("plugin.claudeAuth.status")
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk)
      if (!value || typeof value !== "object") return value
      const next = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, walk(item)]),
      ) as Record<string, unknown>
      if (status && "patch" in next) next.patch = { ...(next.patch as object | null), state: "patched", loaded: true }
      if (next.kind === "claude-sub" && next.status === "needs_reauth") next.status = "ready"
      return next
    }
    return route.fulfill({ response, json: walk(body) })
  })
}
