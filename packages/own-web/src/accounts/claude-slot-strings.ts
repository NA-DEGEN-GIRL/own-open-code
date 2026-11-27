// Strings of the accounts page's Claude subscription slot card (account 1: its connection, warnings, risk notice and
// rows) that no other screen uses, lazy with the accounts page so they stay out of the first chunk (PF5, merge round 9).
import { featureText } from "@/queue/text"

export const claudeSlotKo = {
  "own.acct.claudeAckStale": "고지문이나 플러그인 버전이 이 앱이 아는 것과 달라요. 앱을 업데이트한 뒤 다시 시도하세요.",
  "own.acct.claudeConn.env": "환경 변수",
  "own.acct.claudeConn.key": "API 키",
  "own.acct.claudeConn.none": "연결 없음",
  "own.acct.claudeConn.oauth": "구독(claude-code)",
  "own.acct.claudeDone": "Claude 구독 슬롯을 연결했어요. 이 슬롯에는 어디서나 비공식 배지가 붙어요.",
  "own.acct.claudeImportFailed": "구독을 가져오지 못했어요. Claude Code 로그인 상태를 확인하세요 (claude auth login).",
  "own.acct.claudeReimported": "구독을 다시 가져왔어요.",
  "own.acct.connect": "연결…",
  "own.acct.recolorTitle": "색 바꾸기: {account}",
  "own.acct.reimport": "구독 다시 가져오기",
  "own.acct.restartManual": "이 창에서는 서비스를 다시 시작할 수 없어요. PowerShell에서 아래 명령을 실행하세요.",
  "own.acct.useApiKey": "API 키로 추가하기",
  "own.banner.slotChanged": "Claude 구독 슬롯이 환경 변수 API 키로 바뀌었어요 — 요금이 API로 청구돼요.",
  "own.claude.accountMayHaveChanged":
    "Claude 구독 슬롯의 계정 정보가 바뀌었을 수 있어요. Claude Code 로그인 상태를 확인하세요.",
  "own.claude.accounts.summary": "Claude 구독 계정: {n}개",
  "own.claude.builtIn.absent": "이 앱 설치에 Claude 구독 플러그인이 없어요. 앱을 다시 설치하세요.",
  "own.claude.builtIn.missing": "앱에 든 Claude 구독 플러그인이 불러와지지 않았어요. 서비스를 다시 시작하세요.",
  "own.claude.builtIn.note":
    "이 플러그인은 앱에 들어 있고 늘 켜져 있어요. 따로 동의를 받지 않으며, Claude 계정을 연결하기 전에는 아무 요청도 보내지 않아요.",
  "own.claude.import": "Claude Code 구독 가져오기",
  "own.claude.importedAsOf": "{label} (가져올 때 기준)",
  "own.claude.needLogin": "Claude Code에 로그인되어 있어야 해요 (claude auth login).",
  "own.claude.remote.help":
    "켠 호스트에서 이 PC의 모든 Claude 구독 계정으로 작업할 수 있어요. 요청은 이 PC를 거쳐 나가고, 로그인 토큰은 호스트로 가지 않아요. 이 PC가 켜져 있어야 해요.",
  "own.claude.remote.others":
    "Claude Agent 계정과 로컬 모델은 따로 켜지 않아요. 호스트의 계정 범위에 들어 있으면 이 PC를 거쳐 써요(설정 > SSH 원격 호스트).",
  "own.claude.remote.notice.continue": "동의하고 켜기",
  "own.claude.remote.notice.title": "원격 호스트에서 Claude 구독 쓰기",
  "own.claude.remote.title": "SSH 원격 호스트에서 쓰기",
  "own.kit.dismiss": "확인",
  "own.kit.next": "다음",
} as const satisfies Record<string, string>

export type ClaudeSlotKey = keyof typeof claudeSlotKo

export const claudeSlotEn: Partial<Record<ClaudeSlotKey, string>> = {
  "own.acct.claudeAckStale":
    "The notice or plugin version differs from what this app knows. Update the app and try again.",
  "own.acct.claudeConn.env": "Environment variable",
  "own.acct.claudeConn.key": "API key",
  "own.acct.claudeConn.none": "Not connected",
  "own.acct.claudeConn.oauth": "Subscription (claude-code)",
  "own.acct.claudeDone": "The Claude subscription slot is connected. It always carries the Unofficial badge.",
  "own.acct.claudeImportFailed": "Could not import the subscription. Check the Claude Code login (claude auth login).",
  "own.acct.claudeReimported": "Imported the subscription again.",
  "own.acct.connect": "Connect…",
  "own.acct.recolorTitle": "Color: {account}",
  "own.acct.reimport": "Import the subscription again",
  "own.acct.restartManual": "This window cannot restart the service. Run the command below in PowerShell.",
  "own.acct.useApiKey": "Add an API key instead",
  "own.claude.builtIn.absent": "This app install has no Claude subscription plugin. Reinstall the app.",
  "own.claude.builtIn.missing":
    "The Claude subscription plugin that ships with the app is not loaded. Restart the service.",
  "own.claude.builtIn.note":
    "This plugin ships with the app and is always on. It asks no separate consent and sends nothing until a Claude account is connected.",
  "own.claude.remote.help":
    "Hosts you switch on can work with every Claude subscription account of this PC. Their requests go out through this PC, and the sign-in tokens never reach the host. This PC has to stay on.",
  "own.claude.remote.others":
    "Claude Agent accounts and local models need no switch: inside a host's account scope they go through this PC (Settings > SSH remote hosts).",
  "own.claude.remote.notice.continue": "Accept and switch on",
  "own.claude.remote.notice.title": "Use the Claude subscription on remote hosts",
  "own.claude.remote.title": "Use on SSH remote hosts",
  "own.kit.dismiss": "OK",
  "own.kit.next": "Next",
  "own.banner.slotChanged":
    "The Claude subscription slot now uses an API key from the environment, so usage is billed to the API.",
  "own.claude.accountMayHaveChanged":
    "The account of the Claude subscription slot may have changed. Check the Claude Code sign-in.",
  "own.claude.accounts.summary": "Claude subscription accounts: {n}",
  "own.claude.import": "Import Claude Code subscription",
  "own.claude.importedAsOf": "{label} (as imported)",
  "own.claude.needLogin": "Claude Code has to be signed in (claude auth login).",
}

export const claudeSlotText = featureText(claudeSlotKo, claudeSlotEn)
export const useClaudeSlotText = claudeSlotText.use
