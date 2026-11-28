// The switcher's Claude account choice for a new conversation (02 §8.7 "the account chosen last", 04 §8.11.18), loaded
// with the popover's lazy chunk. RS (2026-11-28): on an SSH host the switcher sent `plugin.claudeAuth.default.set` to
// the host, which answers `remote_managed` (the Claude logins and their default are this PC's), and the popover jumped
// to the accounts page without a word. The default is chosen on this PC and reaches the host with the mirror; a
// refusal now says why.
import type { OwnRpc } from "@/data/rpc"
import { OwnRpcError } from "@/data/rpc"
import { featureText } from "@/queue/text"
import { showToast } from "./toast"

export const claudeChoiceKo = {
  "own.switcher.claudeChoiceFailed": "Claude 계정 {account}(으)로 바꾸지 못했어요: {reason}",
  "own.switcher.claudeChoice.account_not_found": "이 계정이 목록에 없어요. 계정 화면에서 확인하세요",
  "own.switcher.claudeChoice.claude_account_unavailable":
    "Claude 구독 플러그인이 계정 하나만 써요. 계정 화면에서 확인하세요",
  "own.switcher.claudeChoice.network": "서비스에 연결하지 못했어요. 잠시 뒤 다시 해 보세요",
} as const

export const claudeChoiceEn: Partial<Record<keyof typeof claudeChoiceKo, string>> = {
  "own.switcher.claudeChoiceFailed": "Could not switch to the Claude account {account}: {reason}",
  "own.switcher.claudeChoice.account_not_found": "This account is not listed. Check it on the accounts page",
  "own.switcher.claudeChoice.claude_account_unavailable":
    "The Claude subscription plugin runs one account. Check it on the accounts page",
  "own.switcher.claudeChoice.network": "Could not reach the service. Try again in a moment",
}

export const claudeChoiceText = featureText(claudeChoiceKo, claudeChoiceEn)

/**
 * Where the default of `kind` is chosen: a Claude subscription account's on this PC (`local`), even for a host
 * conversation (the host only mirrors it); a Claude Agent account's on the server of the conversation (a host keeps its
 * own Claude Agent default, 02 §8.10.13).
 */
export function defaultRpc(input: {
  readonly kind: string
  readonly host: boolean
  readonly server: OwnRpc
  readonly local: OwnRpc
}) {
  return input.kind === "claude-sub" && input.host ? input.local : input.server
}

/** A refusal's words: the reason the service gave, in the user's words where known. */
export function refusalReason(error: unknown, locale: "ko" | "en") {
  const type = error instanceof OwnRpcError ? error.type : "network"
  const key = `own.switcher.claudeChoice.${type}` as keyof typeof claudeChoiceKo
  return key in claudeChoiceKo ? claudeChoiceText.text(locale, key) : type
}

/** The refusal of a Claude account choice, in a toast: the account and why (RS). */
export function announceRefusal(input: {
  readonly locale: "ko" | "en"
  readonly account: string
  readonly error: unknown
}) {
  showToast({
    message: claudeChoiceText.text(input.locale, "own.switcher.claudeChoiceFailed", {
      account: input.account,
      reason: refusalReason(input.error, input.locale),
    }),
    tone: "danger",
  })
}
