// Strings of 설정 > 플러그인 (the plugin list, trust and the Claude subscription plugin's rows) that no other screen
// uses, lazy with the settings screen so they stay out of the first chunk (PF5, merge round 9).
import { featureText } from "@/queue/text"

export const settingsPluginsKo = {
  "own.acct.claudeIntegrity": "무결성",
  "own.acct.claudePackage": "패키지",
  "own.plugins.approve": "승인",
  "own.plugins.approveWarn":
    "이 플러그인은 서비스 안에서 실행되며, 이 앱이 보내는 인증 헤더를 볼 수 있어요. 믿을 수 있는 저장소일 때만 승인하세요.",
  "own.plugins.changed": "변경됨 — 다시 승인 필요",
  "own.plugins.hashMismatch": "확인한 뒤 파일이 바뀌어 승인하지 않았어요. 새 해시를 확인하고 다시 승인하세요.",
  "own.plugins.project": "프로젝트 플러그인",
  "own.plugins.projectBlocked": "차단됨 — 승인되지 않은 플러그인 {n}개",
  "own.plugins.revoke": "승인 취소",
  "own.set.alwaysOn": "항상 켜짐 · 끌 수 없음",
  "own.set.approveSelected": "선택한 {n}개 승인",
  "own.set.approveTitle": "프로젝트 플러그인 {n}개 승인",
  "own.set.approved": "승인됨",
  "own.set.claudeAccounts": "Claude 계정 관리",
  "own.set.claudeLoaded": "앱에 포함 · {version} · 동작 중",
  "own.set.claudeMissing": "이 빌드에 없음",
  "own.set.claudeNotLoaded": "앱에 포함 · {version} · 불러와지지 않음",
  "own.set.computerUseNote": "에이전트가 화면을 보고 마우스와 키보드로 앱을 조작하는 도구예요. 대화마다 따로 켜요.",
  "own.set.integrityOk": "앱의 기록과 일치",
  "own.set.noProjectPlugins": "승인이 필요한 프로젝트 플러그인이 없어요",
  "own.set.noProjects": "열린 프로젝트가 없어요",
  "own.set.orderOk": "정상",
  "own.set.pluginAccounts": "계정 관리 · own.accounts",
  "own.set.pluginActive": "동작 중",
  "own.set.pluginID": "플러그인",
  "own.set.pluginInactive": "상태 확인 중",
  "own.set.pluginOrder": "순서",
  "own.set.pluginPinned":
    "앱에 고정 버전이 들어 있고 늘 켜져 있어요. 새 버전은 이 앱의 업데이트로만 들어와요(@latest는 쓰지 않아요).",
  "own.set.pluginSource": "출처",
  "own.set.pluginState": "상태",
  "own.set.pluginTelemetry": "텔레메트리 · own.telemetry",
  "own.set.plugins.lead": "앱에 든 기본 기능, Claude 구독 플러그인, 프로젝트가 가져온 플러그인을 확인하고 승인해요.",
  "own.set.pluginsBuiltin": "기본 플러그인",
  "own.set.pluginsThirdParty": "서드파티 · Claude 구독",
  "own.set.unapproved": "미승인",
} as const satisfies Record<string, string>

export type SettingsPluginsKey = keyof typeof settingsPluginsKo

export const settingsPluginsEn: Partial<Record<SettingsPluginsKey, string>> = {
  "own.acct.claudeIntegrity": "Integrity",
  "own.acct.claudePackage": "Package",
  "own.set.alwaysOn": "Always on · cannot be turned off",
  "own.set.approveSelected": "Approve {n} selected",
  "own.set.approveTitle": "Approve {n} project plugins",
  "own.set.approved": "Approved",
  "own.set.claudeAccounts": "Manage Claude accounts",
  "own.set.claudeLoaded": "Built in · {version} · active",
  "own.set.claudeMissing": "Not in this build",
  "own.set.claudeNotLoaded": "Built in · {version} · not loaded",
  "own.set.computerUseNote":
    "Lets the agent look at the screen and operate apps with the mouse and keyboard. Turned on per session.",
  "own.set.integrityOk": "Matches the app's record",
  "own.set.noProjectPlugins": "No project plugin needs approval",
  "own.set.noProjects": "No open projects",
  "own.set.orderOk": "OK",
  "own.set.pluginAccounts": "Account management · own.accounts",
  "own.set.pluginActive": "Running",
  "own.set.pluginID": "Plugin",
  "own.set.pluginInactive": "Checking",
  "own.set.pluginOrder": "Order",
  "own.set.pluginPinned":
    "The app carries a pinned version that is always on. New versions arrive only with app updates (never @latest).",
  "own.set.pluginSource": "Source",
  "own.set.pluginState": "Status",
  "own.set.pluginTelemetry": "Telemetry · own.telemetry",
  "own.set.plugins.lead":
    "Check and approve the app's built-in features, the Claude subscription plugin and plugins a project brings.",
  "own.set.pluginsBuiltin": "Built-in plugins",
  "own.set.pluginsThirdParty": "Third-party · Claude subscription",
  "own.set.unapproved": "Not approved",
  "own.plugins.approve": "Approve",
  "own.plugins.approveWarn":
    "This plugin runs inside the service and can see the credentials this app sends. Approve it only for a repository you trust.",
  "own.plugins.changed": "Changed: approve it again",
  "own.plugins.hashMismatch":
    "The file changed after the check, so it was not approved. Check the new hash and approve again.",
  "own.plugins.project": "Project plugins",
  "own.plugins.projectBlocked": "Blocked: plugins not approved ({n})",
  "own.plugins.revoke": "Withdraw approval",
}

export const settingsPluginsText = featureText(settingsPluginsKo, settingsPluginsEn)
export const useSettingsPluginsText = settingsPluginsText.use
