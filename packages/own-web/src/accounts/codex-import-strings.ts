// Words of accounts/codex-import only, loaded with its lazy chunk (PF5, MR14): moved out of src/i18n.
import { featureText } from "@/queue/text"

export const codexImportKo = {
  "own.codex.found": "이전 앱(codex-multi-provider)에서 ChatGPT 로그인 {n}개를 찾았어요.",
  "own.codex.linkedDesc": "이전 앱이 로그인을 계속 갱신해요. 이 앱은 읽기만 해요.",
  "own.codex.takeoverDesc": "이 PC에 복사해 이 앱이 갱신해요. 이전 앱의 이 프로필은 다시 로그인해야 할 수 있어요.",
  "own.codex.noAlias": "(별칭 없음)",
  "own.codex.problem.unreadable": "파일을 읽을 수 없어요",
  "own.codex.problem.parse_failed": "로그인 파일 형식을 알 수 없어요",
  "own.codex.problem.not_chatgpt": "ChatGPT 로그인이 아니에요(API 키 방식)",
  "own.codex.problem.missing_tokens": "로그인 정보가 비어 있어요",
  "own.codex.problem.token_expired": "토큰이 만료되었어요 — 이전 앱에서 이 프로필을 한 번 열어 갱신하세요",
  "own.codex.problem.account_mismatch": "이미 가져온 계정과 다른 ChatGPT 계정이에요",
  "own.codex.imported": '이미 가져옴 · {mode} → "{account}"',
  "own.codex.duplicate":
    '이미 있는 계정 "{account}"과 같은 ChatGPT 계정이에요. 새 계정을 만들지 않고 그 계정을 이 프로필에 {mode}해요.',
  "own.codex.warn.linked_depends_on_source":
    "이전 앱이 이 로그인을 계속 갱신해야 해요. 이전 앱을 오래 켜지 않으면 이 계정은 멈추고, 이전 앱을 열면 다시 동작해요.",
  "own.codex.warn.takeover_supersedes_source":
    "이 앱이 처음 갱신하면 이전 앱의 이 프로필 로그인은 더 쓸 수 없게 될 수 있어요(다시 로그인 필요).",
  "own.codex.warn.source_token_expired": "지금 토큰이 만료되어 있어요. 연결이면 이전 앱이 갱신할 때까지 쓸 수 없어요.",
  "own.codex.staleHelp":
    "이 계정은 이전 앱(codex-multi-provider)이 갱신하는 로그인을 읽기만 해요. 이전 앱에서 이 프로필을 열면 1분 안에 다시 동작해요.",
  "own.codex.recheck": "다시 확인",
  "own.acct.codexDone": '"{label}" 계정을 {mode}했어요. 실행 중인 대화는 바뀌지 않아요.',
  "own.acct.codexImportable": "가져올 수 있음",
  "own.acct.codexLink": "연결하기",
  "own.acct.codexLinkedRecommended": "연결 (권장)",
  "own.acct.codexMode": "방식",
  "own.acct.codexRefreshed": "{ago} 갱신",
  "own.acct.codexRemaining": "남은 프로필 {n}개",
  "own.acct.codexTakeover": "인수하기",
  "own.acct.codexUnavailable": "이전 앱(codex-multi-provider)을 찾지 못했어요.",
  "own.acct.nextArrow": "다음 →",
  "own.acct.recheckOk": "원본이 갱신되어 다시 동작해요.",
  "own.acct.recheckStill": "아직 갱신되지 않았어요. 이전 앱에서 이 프로필을 여세요.",
  "own.acct.rescan": "다시 찾기",
  "own.acct.skip": "건너뛰기",
}

export const codexImportEn: Partial<Record<keyof typeof codexImportKo, string>> = {
  "own.acct.codexDone": '"{label}" was {mode}ed. Running sessions are not changed.',
  "own.acct.codexImportable": "Can be imported",
  "own.acct.codexLink": "Link",
  "own.acct.codexLinkedRecommended": "Link (recommended)",
  "own.acct.codexMode": "Mode",
  "own.acct.codexRefreshed": "refreshed {ago}",
  "own.acct.codexRemaining": "{n} profiles left",
  "own.acct.codexTakeover": "Take over",
  "own.acct.codexUnavailable": "The old app (codex-multi-provider) was not found.",
  "own.acct.nextArrow": "Next →",
  "own.acct.recheckOk": "The source was refreshed; the account works again.",
  "own.acct.recheckStill": "Not refreshed yet. Open this profile in the old app.",
  "own.acct.rescan": "Scan again",
  "own.acct.skip": "Skip",
  "own.codex.found": "Found ChatGPT sign-ins in the old app (codex-multi-provider): {n}.",
  "own.codex.linkedDesc": "The old app keeps refreshing the sign-in. This app only reads it.",
  "own.codex.takeoverDesc":
    "Copied to this PC and refreshed by this app. This profile of the old app may have to sign in again.",
  "own.codex.noAlias": "(no alias)",
  "own.codex.problem.unreadable": "The file cannot be read",
  "own.codex.problem.parse_failed": "Unknown login file format",
  "own.codex.problem.not_chatgpt": "Not a ChatGPT sign-in (API key)",
  "own.codex.problem.missing_tokens": "The sign-in information is empty",
  "own.codex.problem.token_expired": "The token expired. Open this profile once in the old app to refresh it",
  "own.codex.problem.account_mismatch": "A different ChatGPT account than the one already imported",
  "own.codex.imported": 'Already imported · {mode} → "{account}"',
  "own.codex.duplicate":
    'The same ChatGPT account as the existing "{account}". No new account is made; that account is set to this profile ({mode}).',
  "own.codex.warn.linked_depends_on_source":
    "The old app has to keep refreshing this sign-in. If it stays closed for long this account stops, and opening it brings the account back.",
  "own.codex.warn.takeover_supersedes_source":
    "Once this app refreshes it, this profile's sign-in in the old app may no longer work (sign in there again).",
  "own.codex.warn.source_token_expired":
    "The token is expired now. A linked account cannot be used until the old app refreshes it.",
  "own.codex.staleHelp":
    "This account only reads a sign-in that the old app (codex-multi-provider) refreshes. Open this profile in the old app and it works again within a minute.",
  "own.codex.recheck": "Check again",
}

export const codexImportText = featureText(codexImportKo, codexImportEn)
export const useCodexImportText = codexImportText.use
