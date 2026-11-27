export * as Hooks from "./hooks.js"

import { Provider } from "@opencode/schema/provider"
import { CompactionCache } from "@own/protocol"
import { OutputLimitShape } from "./auth/output-limit.js"
import type { Deps } from "./deps.js"
import { Repeat } from "./guard/repeat.js"
import type { Logger } from "./logger.js"
import type { Modules } from "./modules.js"
import { Gate } from "./presets/gate.js"
import { ReadOnly } from "./presets/readonly.js"
import { Skills } from "./skills.js"
import type { Telemetry } from "./telemetry/telemetry.js"

/** P-034's verdict when it cannot be made: the older request (CC-12). */
const FAILED: CompactionCache.CacheVerdict = { prefix: "older", reason: "error" }

/**
 * Registers the transforms, session hooks and tool hooks once, in setup, unscoped (02 §3.8, §4.1 "등록 방식"): setup
 * registrations keep the configured plugin order `[own.accounts, own.remote, own.team, claude-auth, own.telemetry,
 * own.computer-use, own.import, own.harness]` (06 §2.6, 09 §5.1, 10 H0), and adding accounts later only reloads
 * providers. The one exception is a late `agent.transform` registration that `presets/agents.ts` makes again after
 * each `plugin.updated` of this Location, so it runs after core's config agents (02 §4.1 table, 07 §5.4). Each callback dispatches to module
 * handlers in a fixed order and never lets an error escape: a thrown hook is a defect in core (02 §4.1 "실패 처리").
 *
 * The provider, model and session request hooks act on own slots only: modules filter by `slots.slot(providerID)`
 * themselves and non-own providers (including `anthropic`) pass through untouched. The one exception is the user's
 * output limit on main requests (02 §4.9), a setting for every provider. The tool hooks (the subagent gate
 * and the settling of its reservations, the `opencode_models` filter) and the read-only roles' `permission`
 * `evaluate` hook run whatever the main's provider: a main on a non-own provider may only use that provider
 * (07 §5.4). They fail closed on their own when they cannot decide (only a plain inherit passes, an unknown main lists
 * no models, a session whose agent cannot be read is refused what read-only roles are); the guard below is the last
 * resort. The repeated-call reminder (`Repeat`, P1-1) rides on the tool hooks but acts on own slots only: it learns
 * each (session, agent)'s slot from the primary `model.request`.
 */
export async function register(deps: Deps, modules: Modules.All) {
  const log = deps.log.child("hooks")
  const hook = guard(log)
  const unknown: Telemetry.Verdict = { class: "unknown" }
  const settle = Gate.after(deps)
  const readonly = ReadOnly.create(deps)
  const repeat = Repeat.create({
    own: (providerID) => modules.slots.slot(providerID) !== undefined,
    exclude: () => deps.runtime.policy.cached()?.repeatReminderExclude ?? Repeat.EXCLUDE,
    log: deps.log.child("repeat"),
  })

  // Transforms: slot registration, catalog snapshot, anthropic activation, built-in hiding, the own role agents and
  // hidden agents' models (07 §2.4, §5.4; the presets module adds a later registration of its own, see `Agents`). No
  // I/O inside folds.
  await deps.ctx.provider.transform((editor) =>
    hook.sync("provider.transform", () => modules.slots.transformProviders(editor)),
  )
  // 02 §8.10.2: upstream's `claude-agent` runs only on the Claude Agent account's folder, else it is off.
  await deps.ctx.provider.transform((editor) => hook.sync("provider.transform", () => modules.claudeAgent.fold(editor)))
  await deps.ctx.model.transform((editor) => hook.sync("model.transform", () => modules.slots.transformModels(editor)))
  await deps.ctx.agent.transform((editor) =>
    hook.sync("agent.transform", () => modules.presets.transformAgents(editor)),
  )
  // The built-in `opencode` skill's own section (P0-1): this service's config directory (`Deps.configDir`).
  const skills = { configDir: deps.configDir, log: deps.log.child("skills") }
  await deps.ctx.skill.transform((editor) => hook.sync("skill.transform", () => Skills.transform(editor, skills)))

  // Mutating session hooks (own slots only).
  await deps.ctx.session.hook("model.request", async (event) => {
    hook.sync("model.request:repeat", () => repeat.onModelRequest(event))
    // The D10 and prefix comparisons first (the shaped request is still the latest one) and in their own guard, so a
    // failing alert or ledger write never keeps the credential off the request.
    hook.sync("model.request:settle", () => modules.auth.settle(event))
    await hook.safe("model.request:auth", () => modules.auth.onModelRequest(event), undefined)
    await hook.safe("model.request:telemetry", () => modules.telemetry.onModelRequest(event), undefined)
    // Remote service: an own-slot request that got no credential is sent to the fail-closed sink (04 §8.6 step 5).
    const remote = deps.remote
    if (remote)
      hook.sync("model.request:remote", () =>
        remote.afterModelRequest(event, modules.slots.slot(event.model.providerID) !== undefined),
      )
    // Remote service, Claude subscription slot (04 §8.11.4.4): the PC's egress relay or the sink. An error leaves no
    // route, which is the sink.
    if (remote && event.model.providerID === Provider.ID.anthropic)
      await hook.safe(
        "model.request:claude",
        async () =>
          remote.claudeRoute(event, {
            trust: modules.plugins.trustStatus() === "ok" ? "ok" : await modules.plugins.trustSettled(),
            conflict: modules.plugins.claudeConflict(),
          }),
        undefined,
      )
    // Remote service, a local model of the PC (04 §8.14): the PC's relay or the sink, never the account's address
    // (here, this host itself). An error leaves no route, which is the sink.
    if (remote && remote.local(event.model.providerID) !== undefined)
      await hook.safe(
        "model.request:local",
        async () =>
          remote.localRoute(event, {
            trust: modules.plugins.trustStatus() === "ok" ? "ok" : await modules.plugins.trustSettled(),
          }),
        undefined,
      )
  })
  // Speed first (02 §4.8: an Anthropic request's `speed` and beta, the own `anth` slot and the Claude subscription slot by
  // the exception 02 §8.3 I5a), so a remote service's sink redirect below still sees the final request.
  const remote = deps.remote
  await deps.ctx.session.hook("http.request", async (event) => {
    hook.sync("http.request:telemetry", () => modules.telemetry.onHttpRequest(event))
    await hook.safe("http.request:speed", () => modules.speed.onHttpRequest(event), undefined)
    // 02 §8.7 (G2): the conversation's Claude account, bound in claude-auth before it signs (this PC) or named in the
    // relay's proof (a remote service). Deliberately not guarded: a refusal throws, so the request fails closed
    // instead of being signed with another account.
    const claude = await modules.claude.onHttpRequest(event)
    if (remote) hook.sync("http.request:remote", () => remote.onHttpRequest(event, claude))
  })
  // The user's output limit (every provider, main requests only, 02 §4.9) first, so the deterministic own-slot shaping
  // still removes or fills the limit per kind; then the speed's request option (`serviceTier`, not a prompt byte, 4.8).
  const outputLimit = OutputLimitShape.handler(deps, (providerID) => modules.slots.slot(providerID)?.kind)
  // 02 §8.10 (CAG phase 2): a Claude Agent request names the folder of the account its tree runs on (P-045).
  // Deliberately not guarded: a tree bound to a removed account or a broken transcript link throws, so the request
  // fails closed instead of running on another account's folder.
  await deps.ctx.session.hook("context", async (event) => {
    await modules.claudeAgent.onRequest(event)
    await hook.safe("context:output-limit", () => outputLimit(event), undefined)
    await hook.safe("context", () => modules.auth.onRequestShape(event, "context"), undefined)
    await hook.safe("context:speed", () => modules.speed.onRequestShape(event, "context"), undefined)
  })
  // First, so own-harness's hook (registered later) reads them: the cache verdict on sending the whole history (P-034)
  // and the idle trigger of a compaction own admitted while the user was away (02 §4.7.7), both in the metadata. On
  // P-034's run over the whole history (`kept`), a `full` verdict's check of the kept part may decline it and say why.
  // A verdict that fails is `older`, so an error never sends the whole history (CC-12). An idle compaction that
  // delivered only after its cache cooled or the user came back is cancelled before any request (P-034 `cancel`,
  // CC-16; core reads it on the first run).
  await deps.ctx.session.hook("compaction", async (event) => {
    await modules.claudeAgent.onRequest(event)
    const verdict = await hook.safe("compaction:cache", () => modules.telemetry.prefixVerdict(event), FAILED)
    const idle = await hook.safe("compaction:idle", () => modules.switching.idleCompaction(event.sessionID), undefined)
    event.metadata = {
      ...event.metadata,
      [CompactionCache.CACHE_KEY]: verdict,
      ...(idle === undefined ? {} : { [CompactionCache.TRIGGER_KEY]: "idle" }),
    }
    if (idle?.drop !== undefined) event.cancel = idle.drop
    const kept = event.kept
    const declined =
      kept === undefined || verdict.prefix !== "full"
        ? undefined
        : await hook.safe("compaction:recent", () => modules.telemetry.recentVerdict({ ...event, kept }), "error")
    if (declined !== undefined) {
      event.prefix = undefined
      event.metadata = { ...event.metadata, [CompactionCache.PREFIX_KEY]: { request: "older", reason: declined } }
    }
    await hook.safe("compaction", () => modules.auth.onRequestShape(event, "compaction"), undefined)
    await hook.safe("compaction:speed", () => modules.speed.onRequestShape(event, "compaction"), undefined)
  })
  await deps.ctx.session.hook("generate", async (event) => {
    await modules.claudeAgent.onRequest(event)
    await hook.safe("generate", () => modules.auth.onRequestShape(event, "generate"), undefined)
  })
  await deps.ctx.session.hook("prompt", async (event) => {
    hook.sync("prompt:repeat", () => repeat.onPrompt(event))
    await hook.safe("prompt", () => modules.switching.onPrompt(event), undefined)
  })

  // Tool hooks (every provider): the subagent gate, its reservations settled after the call, and the `opencode_models`
  // filter (07 §5.4, §2.6). Core's own subagent hook (a builtin plugin) runs before these. The repeated-call reminder
  // goes last, on the result the hooks before it left.
  await deps.ctx.tool.hook("execute.before", async (event) => {
    await hook.safe("tool.execute.before", () => modules.presets.onToolBefore(event), undefined)
  })
  await deps.ctx.tool.hook("execute.after", async (event) => {
    await hook.safe("tool.execute.after:gate", () => settle(event), undefined)
    await hook.safe("tool.execute.after", () => modules.presets.onToolAfter(event), undefined)
    hook.sync("tool.execute.after:repeat", () => repeat.after(event))
  })

  // Read-only observation hooks (own slots only; `anthropic` belongs to own-telemetry). The wire evidence capture
  // (P0-3a) rides on them and registers nothing of its own: with no capture window it reads one field and returns.
  // The speed reads a response only after its own request carried a tier (the Claude slot too, 02 §8.3 I5a).
  await deps.ctx.session.hook("http.response", async (event) => {
    // The fail-closed sink's 401 is not a provider answer: no limits, no lastResponse, no auth-swap verdict. Nor is a
    // refusal of the PC's Claude relay (04 §8.11.4.6), which the retry decision reads instead.
    if (deps.remote?.isSink(event.request.url)) return
    if (remote && (await hook.safe("http.response:egress", () => remote.onEgressResponse(event), false))) return
    hook.sync("http.response:capture", () => modules.telemetry.capture.onHttpResponse(event))
    await hook.safe("http.response:telemetry", () => modules.telemetry.onHttpResponse(event), undefined)
    await hook.safe("http.response:auth", () => modules.auth.onHttpResponse(event), undefined)
    await hook.safe("http.response:speed", () => modules.speed.onHttpResponse(event), undefined)
    // 02 §8.9: an account's first Claude request is the first one that was really sent (CR).
    await hook.safe("http.response:claude", () => modules.claude.onHttpResponse(event), undefined)
  })
  await deps.ctx.session.hook("experimental.ws.handshake", async (event) => {
    await hook.safe("ws.handshake", () => modules.auth.onWsHandshake(event), undefined)
    if (remote) hook.sync("ws.handshake:remote", () => remote.onWsHandshake(event))
    hook.sync("ws.handshake:capture", () => modules.telemetry.capture.onWsHandshake(event))
  })
  await deps.ctx.session.hook("experimental.ws.receive", async (event) => {
    hook.sync("ws.receive:capture", () => modules.telemetry.capture.onWsReceive(event))
    await hook.safe("ws.receive:telemetry", () => modules.telemetry.onWsReceive(event), undefined)
    await hook.safe("ws.receive:auth", () => modules.auth.onWsReceive(event), undefined)
    hook.sync("ws.receive:speed", () => modules.speed.onWsReceive(event))
  })
  await deps.ctx.session.hook("retry", async (event) => {
    // Remote service: an attempt that ended in the sink is decided by the fail-closed grace alone (04 §8.7); it is
    // not a provider failure, so it neither counts as an auth failure nor triggers a switch.
    if (remote && (await hook.safe("retry:remote", () => remote.retryBefore(event), false))) return
    const verdict = await hook.safe("retry:telemetry", () => modules.telemetry.onRetry(event), unknown)
    await hook.safe("retry:switching", () => modules.switching.onRetry(event, verdict), undefined)
    // 02 §8.8 (C-D3): a Claude account that ran out moves the tree to another Claude account and retries at once.
    await hook.safe("retry:claude", () => modules.claude.onRetry(event), undefined)
    // A refused speed tier (02 §4.8): marked, and the request goes again at once without it (nothing was produced).
    await hook.safe("retry:speed", () => modules.speed.onRetry(event), undefined)
    // A token-sharing request refused as unsupported that the speed fallback did not send again (02 §3.2c).
    hook.sync("retry:auth", () => modules.auth.onRetry(event))
    if (remote) hook.sync("retry:remote-after", () => remote.retryAfter(event))
    // Last, so the line has the decision core gets.
    hook.sync("retry:capture", () => modules.telemetry.capture.onRetry(event, verdict))
  })

  // Read-only roles (07 §2.4): tighten only (06 §4.9). Registered last: a context without a permission domain keeps
  // every hook above, and the roles keep only their agents' own deny (logged).
  await Promise.resolve()
    .then(() =>
      deps.ctx.permission.hook("evaluate", async (event) => {
        // The protected paths (01 §13, PP): a file tool's read or edit of one is denied, a shell command naming one asks.
        hook.sync("permission.evaluate:protected", () => modules.protection.evaluate(event))
        await hook.safe("permission.evaluate", () => readonly(event), undefined)
        // A web request in a conversation with a former ask or read-only bundle asks as the current one would (MR10-3, MR11).
        await hook.safe("permission.evaluate:web", () => modules.switching.webAsk(event), undefined)
      }),
    )
    .catch((error: unknown) => log.error("readonly_hook_unavailable", { error }))
}

/**
 * The wrappers every hook and transform callback runs in: an error is logged as `hook_failed` and never reaches
 * core. `sync` is for folds (no I/O), `safe` answers `fallback` instead of the failed result.
 */
export function guard(log: Logger.Logger) {
  return {
    sync: (name: string, run: () => void) => {
      try {
        run()
      } catch (error) {
        log.error("hook_failed", { hook: name, error })
      }
    },
    safe: async <A>(name: string, run: () => Promise<A> | A, fallback: A) => {
      try {
        return await run()
      } catch (error) {
        log.error("hook_failed", { hook: name, error })
        return fallback
      }
    },
  }
}
