export * as CreatorHooks from "./hooks.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Match } from "./match.js"
import type { CreatorState } from "./state.js"

/**
 * Retry policy and compaction prompt additions (17 §5.4, §5.5). own.creator is listed after own-harness, so its hooks
 * run after the harness's: the compaction prompt is the one own-harness set (core P-025), and a retry decision is the
 * one core and own-accounts made.
 */

type Ctx = Pick<Context, "session" | "location">

/** Joins the additions after own's compaction prompt. */
export const COMPACTION_HEADING = "Additional instructions for this summary (from the user's extensions):"

export const register = (ctx: Ctx, state: CreatorState.State) =>
  Effect.gen(function* () {
    yield* ctx.session.hook("retry", (event) =>
      Effect.gen(function* () {
        // Only backoff retries: an immediate retry is own's (an account switch, a refreshed login, a host's grace).
        if (!event.decision.retry || event.decision.delay <= 0) return
        const items = Match.items(state.list, "retry")
        if (items.length === 0) return
        const facts = yield* Match.facts(ctx, event.sessionID, event.agent)
        if (facts === undefined) return
        const matching = items.filter((entry) => Match.when(entry.item.when, facts)).map((entry) => entry.item)
        const attempts = Math.min(
          ...matching.flatMap((item) => (item.maxRetries === undefined ? [] : [item.maxRetries])),
        )
        // Core numbers the attempt a retry would make: the first retry is attempt 2 (model-retry.ts).
        if (Number.isFinite(attempts) && event.attempt - 1 > attempts) {
          event.decision = { retry: false }
          return
        }
        const cap = Math.min(
          ...matching.flatMap((item) => (item.maxDelaySeconds === undefined ? [] : [item.maxDelaySeconds * 1000])),
        )
        if (Number.isFinite(cap) && event.decision.delay > cap) event.decision = { retry: true, delay: cap }
      }),
    )
    yield* ctx.session.hook("compaction", (event) =>
      Effect.gen(function* () {
        // Without own's prompt (no own-harness) there is nothing to add to: core's own prompt is not a hook's.
        if (event.prompt === undefined || event.result !== undefined) return
        const items = Match.items(state.list, "compaction.prompt")
        if (items.length === 0) return
        const facts = yield* Match.facts(ctx, event.sessionID, event.agent)
        if (facts === undefined) return
        const texts = items.filter((entry) => Match.when(entry.item.when, facts)).map((entry) => entry.item.text)
        if (texts.length === 0) return
        event.prompt = `${event.prompt}\n\n${COMPACTION_HEADING}\n${texts.join("\n\n")}`
      }),
    )
  })
