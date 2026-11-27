export * as Gate from "./gate.js"

import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Exit, Scope, Semaphore, Stream } from "effect"

/**
 * Which sessions list the harness's own tools. Every tool of a harness carries this permission action
 * (`options.permission`), every agent gets {@link DENY} so no catalog lists them, and a session that runs the harness
 * gets {@link ALLOW} in its own rules (written with the binding, inherited by children). Sessions of other harnesses
 * therefore send exactly the tools they sent before own.harness: the plugin's tools never enter their snapshot, so
 * own-accounts' toolset fingerprint and the prompt cache stay as they were. The tools ask their real permissions
 * (`shell`, `edit`) when they run (P-019); this action only lists them.
 */
export const ACTION = "own_harness_codex"

export const DENY: Permission.Rule = { action: ACTION, resource: "*", effect: "deny" }
export const ALLOW: Permission.Rule = { action: ACTION, resource: "*", effect: "allow" }

/** The `pi` harness's tools (src/pi/tools.ts), gated the same way under their own action. */
export const PI_ACTION = "own_harness_pi"
export const PI_DENY: Permission.Rule = { action: PI_ACTION, resource: "*", effect: "deny" }
export const PI_ALLOW: Permission.Rule = { action: PI_ACTION, resource: "*", effect: "allow" }

/** The `dsh` harness's tools (src/dsh/tools.ts), gated the same way under their own action. */
export const DSH_ACTION = "own_harness_dsh"
export const DSH_DENY: Permission.Rule = { action: DSH_ACTION, resource: "*", effect: "deny" }
export const DSH_ALLOW: Permission.Rule = { action: DSH_ACTION, resource: "*", effect: "allow" }

/**
 * own-omo's tools (packages/own-omo, 15): omo's bridged tools and its `todowrite`, gated the same way under their own
 * action. own-omo registers them; this plugin only writes the rules, so without own-omo the rules gate nothing.
 */
export const OMO_ACTION = "own_harness_omo"
export const OMO_DENY: Permission.Rule = { action: OMO_ACTION, resource: "*", effect: "deny" }
export const OMO_ALLOW: Permission.Rule = { action: OMO_ACTION, resource: "*", effect: "allow" }

/** Each harness's allow rule; `opencode` and `claude-code` have no tools of their own. */
const ALLOWS: Readonly<Record<OwnHarness.HarnessID, Permission.Rule | undefined>> = {
  opencode: undefined,
  codex: ALLOW,
  pi: PI_ALLOW,
  dsh: DSH_ALLOW,
  omo: OMO_ALLOW,
  "claude-code": undefined,
}

/** Each harness's gate action, for the tools its sessions list (prompts.ts). */
export const ACTIONS: Readonly<Record<OwnHarness.CustomHarnessID, string>> = {
  codex: ACTION,
  pi: PI_ACTION,
  dsh: DSH_ACTION,
}

/** The session rules with `harness`'s allow rule at the end and no other harness's. */
export function rules(current: ReadonlyArray<Permission.Rule> | undefined, harness: OwnHarness.HarnessID) {
  const others = (current ?? []).filter(
    (rule) =>
      ![ALLOW, PI_ALLOW, DSH_ALLOW, OMO_ALLOW].some(
        (gate) => rule.action === gate.action && rule.resource === gate.resource && rule.effect === gate.effect,
      ),
  )
  const allow = ALLOWS[harness]
  return allow === undefined ? others : [...others, { ...allow }]
}

/**
 * Whether `current` lists `harness`'s tools: its allow rule is there and no other harness's (where {@link rules} puts
 * the allow does not matter, so another plugin's bundle after it is fine).
 */
export function holds(current: ReadonlyArray<Permission.Rule> | undefined, harness: OwnHarness.HarnessID) {
  const allow = ALLOWS[harness]
  const gates = (current ?? []).filter((rule) =>
    [ALLOW, PI_ALLOW, DSH_ALLOW, OMO_ALLOW].some((gate) => same(rule, gate)),
  )
  if (allow === undefined) return gates.length === 0
  return gates.length > 0 && gates.every((rule) => same(rule, allow))
}

function same(a: Permission.Rule, b: Permission.Rule) {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

/**
 * Registers {@link DENY}, {@link PI_DENY}, {@link DSH_DENY} and {@link OMO_DENY} on every agent, again after every `plugin.updated` of this Location so it
 * follows the config agents core applies after the configured plugins (the pattern of own-computer-use
 * `src/agents.ts`, surface `builtin-plugin-placement`). One registration is live at a time.
 */
export const register = (ctx: Pick<Context, "agent" | "event" | "location">) =>
  Effect.gen(function* () {
    const plugin = yield* Effect.scope
    const lock = yield* Semaphore.make(1)
    const current: { scope?: Scope.Closeable } = {}
    const move = lock.withPermits(1)(
      Effect.gen(function* () {
        const previous = current.scope
        const next = yield* Scope.fork(plugin)
        yield* ctx.agent.transform(deny).pipe(Scope.provide(next))
        current.scope = next
        if (previous !== undefined) yield* Scope.close(previous, Exit.void)
      }),
    )
    // Subscribed before the setup registration, so this Location's first `plugin.updated` cannot slip in between.
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "plugin.updated" && event.location?.directory === ctx.location.directory),
      Stream.runForEach(() => move),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* move
  })

function deny(editor: AgentEditor) {
  editor.list().forEach((agent) =>
    editor.update(agent.id, (info) => {
      info.permissions.push({ ...DENY }, { ...PI_DENY }, { ...DSH_DENY }, { ...OMO_DENY })
    }),
  )
}
