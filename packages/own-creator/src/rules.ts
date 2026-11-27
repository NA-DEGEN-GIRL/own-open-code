export * as Rules from "./rules.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import type { Creator } from "@own/protocol/creator"
import { Effect } from "effect"
import { Match } from "./match.js"
import { Safety } from "./safety.js"
import type { CreatorState } from "./state.js"

/**
 * Tool rules (17 §5.3), merged with own's approval bundles in core's permission `evaluate` hook, the one layer after
 * the agent's, the session's (the bundle) and the saved rules: a `deny` turns any answer but a deny into a deny, an
 * `ask` turns an allow into an ask (so it asks under 전체 허용 too), and an approved `allow` turns core's ask into an
 * allow (never an ask another own hook wrote with its reason). A deny from the bundle or an agent never reaches the
 * hook, so nothing here undoes one. `tool` rules meet every
 * tool call (Code Mode's too) in `execute.before`: a deny refuses the call, an ask asks `tool_rule` for the tool.
 *
 * The hook also keeps the store's files out of the file tools' writes: extensions change only through creator mode's
 * tools and Settings, which validate and hash them.
 */

/** The permission an `ask` tool rule asks (`항상 허용` saves it per tool). */
export const TOOL_RULE = "tool_rule"

/** The permission creator mode's writes ask (tools.ts). */
export const CreatorAsk = { WRITE: "creator" } as const

type Ctx = Pick<Context, "permission" | "tool" | "session" | "location">

export const register = (ctx: Ctx, state: CreatorState.State) =>
  Effect.gen(function* () {
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        if (event.action === "edit" && event.resources.some((resource) => Safety.inside(resource, state.store.root))) {
          event.effect = "deny"
          event.message = "Extensions change only through creator mode's tools or Settings > 확장."
          return
        }
        // Own asks: an agent's `* allow` (core's default) must not answer them. Creator mode's writes always ask
        // (the tool asks only outside 전체 허용); an ask tool rule asks unless the user saved 항상 허용 for that tool.
        // Each carries a reason, so another own hook's extension allow never lifts it (L1/L2, MR15).
        if (event.action === CreatorAsk.WRITE && event.effect === "allow") {
          event.effect = "ask"
          if (event.message === undefined) event.message = "Changing extensions asks first in this conversation."
        }
        if (
          event.action === TOOL_RULE &&
          event.effect === "allow" &&
          !event.resources.every((resource) => (event.saved ?? []).some((saved) => Match.wildcard(saved, resource)))
        ) {
          event.effect = "ask"
          if (event.message === undefined) event.message = "An extension's tool rule asks first for this tool."
        }
        const rules = Match.items(state.list, "tool.rule")
        if (rules.length === 0) return
        const facts = yield* Match.facts(ctx, event.sessionID, event.agent)
        if (facts === undefined) return
        const decided = decide(
          rules.filter((entry) => Match.when(entry.item.when, facts)),
          event.action,
          event.resources,
        )
        if (decided === undefined) return
        if (decided.effect === "deny") {
          event.effect = "deny"
          event.message = message(decided)
          return
        }
        if (decided.effect === "ask" && event.effect === "allow") event.effect = "ask"
        // An approved allow lifts only the ask core's rules gave. An ask another own hook wrote carries its reason
        // (own-team's risky git commands, MR14) and stays, so the hooks tighten in whatever order they run.
        if (decided.effect === "allow" && event.effect === "ask" && event.message === undefined) event.effect = "allow"
      }),
    )
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.gen(function* () {
        const rules = Match.items(state.list, "tool.rule")
        if (rules.length === 0) return
        const facts = yield* Match.facts(ctx, event.sessionID, event.agent)
        if (facts === undefined) return
        const names = event.registered === undefined ? [event.tool] : [event.tool, event.registered]
        const matching = rules
          .filter((entry) => Match.when(entry.item.when, facts))
          .flatMap((entry) =>
            entry.item.rules.flatMap((rule) =>
              rule.tool !== undefined &&
              rule.effect !== "allow" &&
              names.some((name) => Match.wildcard(rule.tool!, name))
                ? [{ rule, id: entry.owner.loaded.entry.id }]
                : [],
            ),
          )
        const deny = matching.find((entry) => entry.rule.effect === "deny")
        if (deny !== undefined) return yield* Effect.fail(new Tool.Error({ message: message(deny) }))
        const ask = matching.find((entry) => entry.rule.effect === "ask")
        if (ask === undefined) return
        yield* ctx.permission.assert({
          sessionID: event.sessionID,
          agent: event.agent,
          action: TOOL_RULE,
          resources: [event.tool],
          save: [event.tool],
          metadata: {
            extension: ask.id,
            tool: event.tool,
            ...(ask.rule.reason === undefined ? {} : { reason: ask.rule.reason }),
          },
          source: { type: "tool", messageID: event.messageID, id: event.id },
        })
      }),
    )
  })

interface Decided {
  readonly effect: "deny" | "ask" | "allow"
  readonly id: string
  readonly rule: Creator.Rule
}

/**
 * The strongest permission rule for `action` on `resources`: deny, then ask, then allow. An allow counts only when the
 * user approved the version that holds it (`loosen`).
 */
export function decide(
  rules: ReadonlyArray<{ readonly item: Creator.ToolRule; readonly owner: Match.Applicable }>,
  action: string,
  resources: ReadonlyArray<string>,
): Decided | undefined {
  const matching = rules.flatMap((entry) =>
    entry.item.rules.flatMap((rule): Decided[] => {
      if (rule.permission === undefined || !Match.wildcard(rule.permission, action)) return []
      const pattern = rule.pattern ?? "*"
      if (
        !resources.some((resource) => Match.wildcard(pattern, resource)) &&
        !(pattern === "*" && resources.length === 0)
      )
        return []
      if (rule.effect === "allow" && !entry.owner.loaded.entry.loosen.includes(entry.owner.loaded.entry.active))
        return []
      return [{ effect: rule.effect, id: entry.owner.loaded.entry.id, rule }]
    }),
  )
  return (
    matching.find((entry) => entry.effect === "deny") ??
    matching.find((entry) => entry.effect === "ask") ??
    matching.find((entry) => entry.effect === "allow")
  )
}

function message(decided: { readonly id: string; readonly rule: Creator.Rule }) {
  return `Blocked by extension '${decided.id}'${decided.rule.reason === undefined ? "" : `: ${decided.rule.reason}`}`
}
