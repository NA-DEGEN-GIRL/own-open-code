// A Claude card's refresh line (02 §8.7, CR 2026-10-26): for an account the bundled plugin refreshes itself (never one
// on Claude Code's own login), what its last refresh came to (`claude.refresh`): the token endpoint refused it for good
// (`다시 로그인`), it failed for now (the next request tries again), or the access token expired and nothing was tried
// yet (the first request refreshes it: not an error). On the lazy accounts page, so none of it is in the first chunk
// (PF5).
import type { Account } from "@own/protocol"
import { featureText } from "@/queue/text"

export const claudeRefreshKo = {
  "own.claude.refresh.failed": "로그인을 새로 고치지 못했어요({reason}) · 다시 로그인하세요.",
  "own.claude.refresh.retrying": "로그인 새로 고침이 잠시 막혔어요({reason}) · 다음 요청에서 다시 해요",
  "own.claude.refresh.due": "로그인 토큰이 만료됐어요 · 다음 요청에서 새로 고쳐요",
  "own.claude.refresh.network": "연결 실패",
  "own.claude.refresh.timeout": "시간 초과",
  "own.claude.refresh.noRefreshToken": "새로 고침 토큰 없음",
  "own.claude.refresh.unparsable": "응답을 읽지 못함",
} as const satisfies Record<string, string>

export type ClaudeRefreshKey = keyof typeof claudeRefreshKo

export const claudeRefreshEn: Partial<Record<ClaudeRefreshKey, string>> = {
  "own.claude.refresh.failed": "Could not refresh the sign-in ({reason}) · sign in again.",
  "own.claude.refresh.retrying": "Refreshing the sign-in is blocked for now ({reason}) · the next request tries again",
  "own.claude.refresh.due": "The sign-in token expired · the next request refreshes it",
  "own.claude.refresh.network": "no connection",
  "own.claude.refresh.timeout": "timed out",
  "own.claude.refresh.noRefreshToken": "no refresh token",
  "own.claude.refresh.unparsable": "unreadable answer",
}

export const claudeRefreshText = featureText(claudeRefreshKo, claudeRefreshEn)
export const useClaudeRefreshText = claudeRefreshText.use

/** What the token endpoint answered: `HTTP 429 rate_limit_error`, or why there was no answer it could use. */
export function claudeRefreshReason(refresh: Account.ClaudeRefresh, text: (key: ClaudeRefreshKey) => string) {
  if (refresh.status !== undefined)
    return refresh.error ? `HTTP ${refresh.status} ${refresh.error}` : `HTTP ${refresh.status}`
  if (refresh.reason === "timeout") return text("own.claude.refresh.timeout")
  if (refresh.reason === "no_refresh_token") return text("own.claude.refresh.noRefreshToken")
  if (refresh.reason === "unparsable") return text("own.claude.refresh.unparsable")
  return text("own.claude.refresh.network")
}
