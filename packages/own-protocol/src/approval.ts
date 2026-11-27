export * as Approval from "./approval.js"

import { Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"

/**
 * Per-session approval mode (v0.4, 02 §9.2 `session.approval.*`, 03 §18.8). own-accounts is the only writer of the
 * session rules it manages: it builds the rule bundle (protected-path deny rules included, so own-web never knows
 * those paths, 03 P10), reads the session's rules, replaces only its own bundle and writes the parent and its
 * unfinished children at once. The bundle never uses a wildcard action and never `resource: "*"` (tools stay listed,
 * so the cached prefix does not change, 02 §4.3 D10).
 */

/** Modes a client can set. */
export const SetMode = Schema.Literals(["read-only", "ask", "full"]).annotate({ identifier: "Own.Approval.SetMode" })
export type SetMode = typeof SetMode.Type

/** `custom`: the session has no own bundle, or someone changed it. */
export const Mode = Schema.Literals(["read-only", "ask", "full", "custom"]).annotate({
  identifier: "Own.Approval.Mode",
})
export type Mode = typeof Mode.Type

/**
 * The session's browser tools (03 §18.15, 05 §8.7 plan D, 01 §10.1). `off`: its rules drop them (the last rule whose
 * action matches `browser` is a `"*"` deny, e.g. the `{browser, *, deny}` a window without a browser pane writes when
 * it creates the session); `on`: they are listed. `session.approval.set{browserTool}` is the per-session switch
 * (rule 3): `on` removes exactly that creation deny, `off` puts it after every other rule that matches `browser`.
 * Rules someone else wrote are never removed, so `on` can still report `off` (the answer is the state after).
 */
export const BrowserTool = Schema.Literals(["on", "off"]).annotate({ identifier: "Own.Approval.BrowserTool" })
export type BrowserTool = typeof BrowserTool.Type

/**
 * The session's computer-use tools (own.computer-use, 01 §10.2). Every agent carries an agent-wide
 * `{computer, *, deny}` that keeps them out of the catalog; `on` is the session rule `{computer, *, allow}` placed
 * after every other rule that matches `computer` (before the own bundle), which lists the tools and is the consent the
 * plugin re-checks on every call. `off` removes that rule. Only an exact allow as the last matching rule reads as `on`.
 */
export const ComputerUse = Schema.Literals(["on", "off"]).annotate({ identifier: "Own.Approval.ComputerUse" })
export type ComputerUse = typeof ComputerUse.Type

/**
 * The session's 내 브라우저 사용 tools (`OwnBrowse`, decisions BRW). Every agent carries the agent-wide
 * `{browse_*, *, deny}`; `on` is the session rule `{browse_*, *, allow}` before the own bundle, `off` removes it.
 * Only that exact allow as the last rule whose action is `browse_*` reads as `on`.
 */
export const Browse = Schema.Literals(["on", "off"]).annotate({ identifier: "Own.Approval.Browse" })
export type Browse = typeof Browse.Type

/** `session.approval.get` result. `rules` are the session's `permissions` as they are. */
export interface State extends Schema.Schema.Type<typeof State> {}
export const State = Schema.Struct({
  mode: Mode,
  rules: Permission.Ruleset,
  children: Schema.Struct({ open: NonNegativeInt }),
  /** v0.5: read from `rules` (absent from older services). */
  browserTool: optional(BrowserTool),
  /** Computer use (01 §10.2), read from `rules` (absent from older services). */
  computerUse: optional(ComputerUse),
  /** 내 브라우저 사용 (BRW), read from `rules` (absent from older services). */
  browse: optional(Browse),
}).annotate({ identifier: "Own.Approval.State" })

/** `session.approval.set` result: the sessions whose rules were written (the parent first). */
export interface SetResult extends Schema.Schema.Type<typeof SetResult> {}
export const SetResult = Schema.Struct({
  mode: SetMode,
  patched: Schema.Array(SessionID),
  /** v0.5: the parent's browser tools after the write; present when the call set `browserTool`. */
  browserTool: optional(BrowserTool),
  /** The parent's computer use after the write; present when the call set `computerUse`. */
  computerUse: optional(ComputerUse),
  /** The parent's 내 브라우저 사용 after the write; present when the call set `browse`. */
  browse: optional(Browse),
}).annotate({
  identifier: "Own.Approval.SetResult",
})

/**
 * The server's web search service (03 §18.2): core's `websearch` key in own's global config
 * `%OPENCODE_CONFIG_DIR%\opencode.jsonc`, which core reads before the first-use answer it keeps in its server-wide KV
 * (`packages/core/src/websearch.ts` `selection`, `config/plugin/websearch.ts`). It is not a session rule, so no
 * approval mode covers it: without a choice the first `websearch` call of any session and model asks with the
 * `websearch.provider` form, and once answered it is not asked again. Choosing here is the same one-time choice made
 * before any session needs it; it also turns web search back on after `웹 검색 끄기`.
 * - `any`: core's `random` (one of the listed services, the next one when it is rate limited).
 * - `service`: one service by its id (`GET /api/websearch/provider`).
 * - `off`: no web search; core drops the `websearch` tool from every session.
 * - `multi` (MS, 2026-10-19): own's service `own-multi` (`{provider:"own-multi"}` in the config) asks several services
 *   at once and merges their results. Which ones is own's stored selection (`WebSearchState.multi`); `websearch.set`
 *   may carry `services` to store a new one, `websearch.get` never does.
 */
/** own-accounts' multi-service web search (`여러 서비스 함께`, MS): the config names it as `{provider:"own-multi"}`. */
export const WEB_SEARCH_MULTI = "own-multi"

export const WebSearchChoice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("any") }),
  Schema.Struct({ type: Schema.Literal("service"), id: Schema.String.check(Schema.isMinLength(1)) }),
  Schema.Struct({ type: Schema.Literal("off") }),
  Schema.Struct({
    type: Schema.Literal("multi"),
    services: optional(
      Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
    ),
  }),
]).annotate({ identifier: "Own.Approval.WebSearchChoice" })
export type WebSearchChoice = typeof WebSearchChoice.Type

/**
 * How a listed search service reaches its upstream with the user's own key (03 §18.2, 2026-10-19): `key` = a key
 * stored for its integration (core's credential), `env` = an environment variable the integration reads
 * (`EXA_API_KEY` …). A keyless service (Exa, Parallel …) with neither searches on its free tier.
 */
export const WebSearchKey = Schema.Literals(["key", "env"]).annotate({ identifier: "Own.Approval.WebSearchKey" })
export type WebSearchKey = typeof WebSearchKey.Type

/**
 * The services `여러 서비스 함께` asks (MS, 2026-10-19), in the order shown: the stored selection (`custom`), else own's
 * default for the services listed now (ChatGPT while listed and core's keyless services without a key; paid ones never).
 */
export interface WebSearchMulti extends Schema.Schema.Type<typeof WebSearchMulti> {}
export const WebSearchMulti = Schema.Struct({
  services: Schema.Array(Schema.String),
  custom: Schema.Boolean,
}).annotate({ identifier: "Own.Approval.WebSearchMulti" })

/**
 * `websearch.get`/`websearch.set` result. `choice` is absent when the config file names none: then own's default
 * applies (the ChatGPT service `own-chatgpt` while a ChatGPT account is there, 02 §9.2), else the answer given to the
 * first-use form (core's KV, which own cannot read), or the form asks on the next first use. `keys`: the services with
 * a key in use, by service id; absent when the integrations could not be read. `multi`: what `여러 서비스 함께` asks,
 * whether or not it is the choice; absent when the services could not be listed.
 */
export interface WebSearchState extends Schema.Schema.Type<typeof WebSearchState> {}
export const WebSearchState = Schema.Struct({
  choice: optional(WebSearchChoice),
  keys: optional(Schema.Record(Schema.String, WebSearchKey)),
  multi: optional(WebSearchMulti),
}).annotate({ identifier: "Own.Approval.WebSearchState" })

/** `default` (2026-10-19, 설정 > 웹 검색 `기본으로`) removes the config key, so own's default applies again. */
export const WebSearchSetChoice = Schema.Union([WebSearchChoice, Schema.Struct({ type: Schema.Literal("default") })])
export type WebSearchSetChoice = typeof WebSearchSetChoice.Type

export const WebSearchSetInput = Schema.Struct({ choice: WebSearchSetChoice }).annotate({
  identifier: "Own.Approval.WebSearchSetInput",
})
