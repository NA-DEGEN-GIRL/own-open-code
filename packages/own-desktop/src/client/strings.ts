// The remote-client page's words (원격 PC 전용 빌드, own/reports/win-arm64-2026-11-06.md), apart from main.ts so tests
// need no DOM. Korean only, like the shell's other own pages; the error texts follow own-web's 원격 PC dialog
// (packages/own-web/src/remote-pcs/dialog-strings.ts), since the same codes come from the same main service.
import type { OwnRemotePc, OwnRemotePcError } from "../preload/own-api"

export const ERROR_TEXT: Readonly<Record<OwnRemotePcError, string>> = {
  invalid_link: "다른 PC 연결 링크가 아니에요. ownpc://pair로 시작하는 링크 전체를 붙여 넣으세요.",
  expired: "링크가 만료되었거나 이미 쓰였어요. PC에서 새 링크를 만드세요.",
  rejected: "PC에서 거부했어요. PC에 보인 확인 번호가 여기와 다르면 링크가 바뀌었을 수 있으니 새 링크로 다시 하세요.",
  cancelled: "PC에서 연결 요청을 취소했어요.",
  rate_limited: "시도가 너무 많아요. 잠시 뒤에 다시 하세요.",
  unreachable: "PC에 연결할 수 없어요. PC가 켜져 있고 Tailscale 또는 포트 전달(DDNS)이 설정되어 있는지 확인하세요.",
  pin_mismatch:
    "PC의 인증서가 링크와 달라요. 연결을 중단했어요. 중간에서 가로채는 공격일 수 있으니 PC에서 새 링크를 만드세요.",
  key_changed:
    "이 PC는 이미 다른 키로 추가되어 있어 아무것도 바꾸지 않았어요. 링크가 위조되었을 수 있어요. PC의 키를 정말 바꿨다면 목록에서 먼저 뺀 뒤 다시 추가하세요.",
  aborted: "연결을 취소했어요.",
  failed: "연결하지 못했어요",
}

/** The error line; only `failed` shows its (non-secret) detail, as own-web does. */
export function errorText(error: OwnRemotePcError, detail?: string) {
  if (error === "failed") return detail ? `${ERROR_TEXT.failed} (${detail}).` : `${ERROR_TEXT.failed}.`
  return ERROR_TEXT[error] ?? `${ERROR_TEXT.failed}.`
}

export const STATE_TEXT: Readonly<Record<OwnRemotePc["state"], string>> = {
  checking: "확인 중",
  connected: "연결됨",
  unreachable: "연결할 수 없음",
  reauth: "다시 연결 필요",
}

export function sasText(sas: string, name: string) {
  return `확인 번호 ${sas} · ${name}에서 이 번호가 보이면 [허용]을 누르세요`
}

/** Device credential expiry as a local date (`2026. 11. 13.`); empty for a missing value. */
export function expiryText(expiresAt: number, locale = "ko-KR") {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return ""
  return `${new Date(expiresAt).toLocaleDateString(locale)}까지`
}
