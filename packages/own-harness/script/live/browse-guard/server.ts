// Live-test guard for 내 브라우저 사용 (browse.ts): the browser is the user's real profile, so every browse call of a
// test conversation stays on the tabs the test opens and on the page it serves.
//
// - `browse mcp` gets the user's own Browse folders back: the e2e server's HOME, USERPROFILE and XDG folders are the
//   run's own, and Browse reads its relay token and port from `$XDG_DATA_HOME/browse` and `$XDG_STATE_HOME/browse`
//   (else under HOME), so under them it would start a second, unpaired relay. The run passes the user's home (its own
//   USERPROFILE, never read from a file), and only this one child's environment carries it. Updates stay off for a
//   relay it would start.
// - Calls are refused unless they keep to the test: a new tab only at the test origin, with `allowedOrigins` exactly
//   that origin and the test's group; no tab listing or relay status (both show tabs the user lent); no Browse
//   settings, handoffs, recordings, network capture, uploads or page JavaScript. Tighten only: a refusal of own's
//   approval mode stays as it is.
import fs from "node:fs"
import { Plugin } from "@opencode/plugin"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"

const PAGE = new Set([
  "snapshot",
  "click",
  "fill",
  "type",
  "press",
  "select",
  "hover",
  "scroll",
  "wait_for",
  "screenshot",
])

export default Plugin.define({
  id: "own.live.browse-guard",
  setup: async (ctx) => {
    const origin = String(ctx.options.origin)
    const group = String(ctx.options.group)
    const marker = String(ctx.options.marker)
    // From the run (its own USERPROFILE): in this server `os.userInfo().homedir` is the run's fake profile too.
    const home = String(ctx.options.home)
    const fold = (editor: MCPEditor) => {
      const current = editor.get("browse")
      // The run checks this Location's line before any model call: whether the last pass reached the server.
      fs.writeFileSync(
        `${marker}-${Bun.hash(ctx.location.directory)}.json`,
        JSON.stringify({ directory: ctx.location.directory, applied: current?.type === "local" }),
      )
      if (current === undefined || current.type !== "local") return
      editor.update("browse", (config) => {
        if (config.type !== "local") return
        config.environment = {
          ...config.environment,
          HOME: home,
          USERPROFILE: home,
          // Empty: Browse then takes its folders under HOME, as the relay the user started does. Naming the same
          // folders through these variables made the relay refuse the token (401) on 2026-11-19.
          XDG_CONFIG_HOME: "",
          XDG_DATA_HOME: "",
          XDG_STATE_HOME: "",
          XDG_CACHE_HOME: "",
          OPENCODE_BROWSER_AUTO_UPDATE: "off",
        }
      })
    }
    // After own.accounts' fold: plugins set up in no fixed order, so the transform is registered again on each
    // `plugin.updated` of this Location (after every plugin's setup), as own-harness' Gate does for agents.
    const state = { registration: await ctx.mcp.transform(fold) }
    void (async () => {
      for await (const event of ctx.event.subscribe()) {
        if (event.type !== "plugin.updated" || event.location?.directory !== ctx.location.directory) continue
        const previous = state.registration
        state.registration = await ctx.mcp.transform(fold)
        await previous.dispose()
        await ctx.mcp.reload()
      }
    })().catch(() => {})
    await ctx.permission.hook("evaluate", (event) => {
      if (!event.action.startsWith("browse_") || event.effect === "deny") return
      const refusal = refuse(event.action.slice("browse_".length), event.metadata?.input, origin, group)
      if (refusal === undefined) return
      event.effect = "deny"
      event.message = `Live test guard: ${refusal}`
    })
  },
})

function refuse(tool: string, input: unknown, origin: string, group: string) {
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  if (PAGE.has(tool)) return args.tab === undefined ? "pass the `tab` you opened." : undefined
  if (tool === "navigate") return args.tab === undefined ? opening(args, origin, group) : staying(args, origin)
  if (tool !== "tabs") return `\`${tool}\` is not used in this test.`
  if (args.action === "new") return opening(args, origin, group)
  if (args.action === "close")
    return args.group === group || args.tab !== undefined || Array.isArray(args.tabs)
      ? undefined
      : `close your tabs by \`tab\` or with group \`${group}\`.`
  return "listing tabs is not used in this test; use the tab ids you opened."
}

function opening(args: Record<string, unknown>, origin: string, group: string) {
  const allowed = args.allowedOrigins
  if (typeof args.url !== "string" || !inside(args.url, origin)) return `open only ${origin}/.`
  if (!Array.isArray(allowed) || allowed.length !== 1 || allowed[0] !== origin)
    return `open the tab with allowedOrigins ["${origin}"].`
  if (args.group !== group) return `open the tab with group "${group}".`
  return undefined
}

function staying(args: Record<string, unknown>, origin: string) {
  if (args.url === undefined) return undefined
  return typeof args.url === "string" && inside(args.url, origin) ? undefined : `stay on ${origin}/.`
}

function inside(url: string, origin: string) {
  return URL.canParse(url) && new URL(url).origin === origin
}
