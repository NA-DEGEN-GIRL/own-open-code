import { Plugin } from "@opencode/plugin"
import { Redact, Runtime } from "@own/runtime"
import { Build } from "./build.js"
import { Observe } from "./observe.js"
import { Options } from "./options.js"

/**
 * own-telemetry (01 §3.1, §14; 02 §4.1, §7, §8.8). Configured after claude-auth so its hooks see the final
 * `anthropic` responses; observes only `anthropic`, registers no RPC, and hands everything to the shared runtime
 * (limits store, ledger writer, broadcast), from which own-accounts publishes events. Hooks are registered once,
 * scoped to `anthropic`, and never throw. On an SSH host (04 §8.11.14) it runs fourth, after own-team, for the Claude
 * slot the PC relays: its long-stall cut and extra-usage alert act in the host's sessions.
 */
export default Plugin.define({
  id: Build.PLUGIN_ID,
  setup: async (ctx) => {
    const options = Options.decode(ctx.options)
    const warn = (message: string, fields: Readonly<Record<string, unknown>> = {}) => {
      const line = { ts: Date.now(), level: "warn", scope: Build.PLUGIN_ID, msg: message, ...Redact.record(fields) }
      process.stderr.write(JSON.stringify(line) + "\n")
    }
    // Guard 1 (01 §5.4): an unmanaged or skewed instance observes nothing; own-accounts reports it via `health`.
    if (ctx.app.version !== Build.EXPECTED_APP_VERSION || process.env[Build.ENV_MARKER] !== "1") {
      warn("guard_failed", { appVersion: ctx.app.version })
      return
    }
    // Telemetry never reads a secret, so the vault helper (started lazily) is never spawned by this plugin.
    // Its own leadership group: a telemetry instance must never take own-accounts' leadership (own-runtime `role`).
    const runtime = await Runtime.acquire({
      buildId: options.buildId ?? Build.BUILD_ID,
      home: options.home,
      role: Build.PLUGIN_ID,
    })
    const observe = Observe.create({ runtime, now: Date.now, log: { warn } })
    const safe = (name: string, run: () => Promise<void>) =>
      run().catch((error: unknown) => warn("hook_failed", { hook: name, error }))
    const scope = { providerID: Build.PROVIDER_ID }
    const register = async () => {
      await ctx.session.hook(
        "http.response",
        (event) => safe("http.response", () => observe.onHttpResponse(event)),
        scope,
      )
      await ctx.session.hook("retry", (event) => safe("retry", () => observe.onRetry(event)), scope)
    }
    await register().catch(async (error: unknown) => {
      await runtime.release()
      throw error
    })
    return () => runtime.release()
  },
})
