export * as Alert from "./alert.js"

import { Schema } from "effect"

/**
 * Alert codes (02 §7.7, plus `compaction_failed` from 02 §5.9(b), `codex_source_stale` for linked imports, the
 * v0.3/v0.4 additions of 02 §9.5, the step-outcome codes of P2-16, the capture code of P0-3a and the prefix code of
 * P0-2b), the six remote codes of 04 §16.5 and the two of 04 §8.11, the preset codes of 07 §8.1 and the
 * catalog-change codes of 07 T2 (Codex metadata 4.5, pinned-template diff 4.4, a running session's gone main 4.3).
 */
export const Code = Schema.Literals([
  "flap",
  "prefix_drift",
  "low_hit",
  "return_miss",
  "estimator_drift",
  "native_trap",
  "image_trim_soon",
  "claude_slot_billing",
  "secret_in_overlay",
  "auth_swap_broken",
  "identity_format_changed",
  "template_cost_missing",
  "default_model_own_slot",
  "claude_extra_usage",
  "untrusted_plugin",
  "unpinned_session",
  "guard_skew",
  "compaction_failed",
  /** A linked codex-multi-provider token expired or was rejected and the source has not refreshed it. */
  "codex_source_stale",
  /** Core's auto-compaction threshold for a slot differs from the one own-accounts resolved (02 §4.7). */
  "compaction_threshold_mismatch",
  /** The tool set of a session changed mid-conversation, so the cached prefix breaks (02 §4.3 D10). */
  "toolset_changed",
  /** A `generate` request's usage could not be read from its response stream (02 §7.5). */
  "generate_usage_missing",
  /**
   * Info, session (P2-16): a step on an own slot ended with finish `length`, so the answer hit the output limit and the
   * turn may have stopped mid-answer. Primary steps only, never compaction or generate (`providerID`, `modelID`,
   * `finish`).
   */
  "output_truncated",
  /**
   * Info, session (P2-16): a step on an own slot ended with finish `stop` and no visible output (`TokenUsage.output` is
   * 0; reasoning does not count), so the turn ended without an answer and without an error. Primary steps only
   * (`providerID`, `modelID`, `finish`).
   */
  "empty_completion",
  /**
   * Global (P0-3a, 02 §7.8): a wire evidence capture window (`diagnostics.capture.*`) ended with nothing recorded.
   * Warning when own-slot steps ran in the window (the hooks saw none of their traffic, like the 2.0.18-own.1 blocked
   * plugins), info when nothing ran (`captureID`, `steps`).
   */
  "capture_empty",
  /**
   * Info, session (P0-2b, 02 §7.8): while a capture window records it, an own-slot primary request rewrote blocks its
   * slot's previous request sent and nothing own knows of explains it (`providerID`, `modelID`, `agent`, `at`, `lcp`,
   * `previous`). Compaction, revert, model, agent, strip, image trim, instruction and tool-set changes do not raise it.
   */
  "prefix_diverged",
  /** Info: Codex models registered with their catalog window because no Codex window is known (07 §6.2 #4). */
  "codex_window_unverified",
  /**
   * Session (07 §5.4, was 02 §5.11 v0.4): a subagent's configured model named an own subscription slot and the call
   * ran on the role's target instead (`requested`, `used`).
   */
  "subagent_model_overridden",
  /** Info, session (07 §5.4): the subagent gate declined a call (`requested`, `reason`); the LLM was told why. */
  "subagent_rejected",
  /** Warning, global (07 §5.4): a hidden agent's configured model named an own subscription slot and was removed. */
  "internal_agent_model_removed",
  /**
   * Warning, global (07 §4.3): a pinned target or a lighter pair names a model that is gone; the role runs like the
   * main until fixed. One per model event, however many presets use it.
   */
  "preset_needs_repair",
  /**
   * Warning, global (07 §5.4): `presets.json` named a same-company subscription target (a hand edit); that target was
   * dropped from the loaded preset (`presetID`, `role`).
   */
  "preset_entry_dropped",
  /** Warning, global (07 §4.3): a group's new-session default model is gone; new sessions use the group rule. */
  "group_default_model_missing",
  /**
   * Info, global (07 §6.2 #8): a local model's running window is below what a request needs, or unknown, so it is not
   * suggested; once per model.
   */
  "local_window_unverified",
  /**
   * Info, global (07 §4.5): the Codex metadata says a model keeps the cache on an effort change
   * (`supports_reasoning_effort_updates`) while own's mirror of the upstream rule says it does not, or the other way
   * round; recorded as a ledger candidate. The cost dialog keeps the upstream behaviour. Once per model.
   */
  "effort_update_drift",
  /**
   * Info, global (07 §4.4): a pinned template's fixed fields (name, family, variants, settings …) changed upstream;
   * the account card offers `템플릿 갱신 있음`, applied by `accounts.update{refreshCatalog}`. Once per change.
   */
  "template_update_available",
  /**
   * Warning, session (07 §4.3): the session's main model is gone, so the next prompt waits for the user's 02 switch
   * (`session.preset.get` `main.missing: "model"` with a suggestion). Nothing switches by itself.
   */
  "session_model_unavailable",
  /**
   * Warning, session (07 §4.3): the main's reasoning level is gone from its model; the next prompt waits for the
   * user's variant switch to the level refitted by 07 §2.3 (`main.missing: "variant"`).
   */
  "session_variant_unavailable",
  /**
   * Info, global (07 §4.5): the Codex model metadata could not be fetched; the last snapshot, else the Codex CLI's
   * cache on this PC, else each consumer's no-metadata rule is used.
   */
  "codex_meta_unavailable",
  /**
   * Info, session (02 §4.8): the provider refused a speed tier (not entitled, rejected, Anthropic's fast rate limit),
   * so the request was sent again at once without it and the session falls back (Ultrafast → Fast → Standard) until
   * the account's model list is read again or the cooldown ends (`providerID`, `modelID`, `tier`, `reason`). Never
   * switches the account.
   */
  "speed_fallback",
  /**
   * Info, session (02 §4.8): a response named another tier than the one sent (OpenAI `service_tier: "default"`,
   * Anthropic `usage.speed: "standard"`): served and billed at Standard; the ledger line records it
   * (`providerID`, `modelID`, `requested`, `served`).
   */
  "speed_downgraded",
  /**
   * Info, session (02 §8.8, user decision C-D3 2026-10-10): a Claude account ran out, so the conversation's tree moved
   * to another Claude account of this PC and the request went again at once (`accountID` = the new one). The toast:
   * `Claude 한도 소진 — {from}에서 {to}로 바꿨습니다 (캐시 새로 쌓임)`.
   */
  "claude_account_switched",
  /**
   * Warning, session (02 §8.7): a conversation bound to another Claude account was refused because the installed
   * claude-auth runs one account only (not patched, or the service has not restarted since); nothing was signed.
   */
  "claude_account_refused",
  /**
   * Warning, session = the tree's root (02 §8.9, CW 2026-10-19): the first request this service sent on a Claude
   * account (`accountID`), once per account (KV `claude:firstRequest:<accountID>`). Since 2026-04-04 subscription use
   * outside Claude Code may be billed as extra usage; the composer shows a non-blocking notice with `계속` and `취소`.
   */
  "claude_first_request",
  /**
   * Error, session (02 §3.2c): Sign in with ChatGPT refused a request as `subscription_sharing_unsupported_capability`
   * and nothing sends it again (`providerID`, `modelID`, `param`). Retrying the same history fails the same way, so the
   * turn ends; the account is never switched.
   */
  "sharing_unsupported_input",
  /** Session, remote (04 §8.7): the credential broker stayed unreachable past the fail-closed grace; the turn ended. */
  "broker_unavailable",
  /** Global, local (04 §10.3): a remote spool overflowed and dropped observations (a gap in the usage totals). */
  "remote_spool_overflow",
  /** Global, local (04 §10.5): observations a host pushed failed validation and were dropped. */
  "remote_observation_rejected",
  /** Global, local (04 §5.7): a host runs another build; its broker session is in drain mode or refused (skew). */
  "remote_skew",
  /** Global, local (04 §6.1): an alias now reaches another machine; the host is paused. */
  "remote_host_identity_changed",
  /** Global, local (04 §10.5): a host's clock differs from this PC's by more than 2 minutes. */
  "remote_clock_skew",
  /**
   * Warning, session, remote (04 §8.11.8): this PC's egress relay refused the turn's Claude subscription request
   * (`off`, `host_scope`, `consent`, `not_ready`, `billing`, `needs_reauth`, `too_large`, `bad_request`); once per
   * session and code.
   */
  "claude_remote_refused",
  /**
   * Warning, session, remote (04 §8.11.5): this host has its own Claude login (an `anthropic` connection) or a
   * claude-auth plugin, so the Location does not use the PC's Claude subscription slot.
   */
  "claude_remote_conflict",
]).annotate({ identifier: "Own.Alert.Code" })
export type Code = typeof Code.Type

/** `info` = advice, `warning` = 경고, `error` = 오류, `danger` = 위험 (e.g. `claude_extra_usage`). */
export const Severity = Schema.Literals(["info", "warning", "error", "danger"]).annotate({
  identifier: "Own.Alert.Severity",
})
export type Severity = typeof Severity.Type
