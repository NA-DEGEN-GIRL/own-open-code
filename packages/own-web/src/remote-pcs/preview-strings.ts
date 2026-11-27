// 모바일 미리보기 strings (08 §4.3), with 설정 > 기기 (lazy). ko + en, `own.preview.*`, same rules as strings.ts. Error
// keys are the shell's pairing codes plus `no_link`; only `failed` shows its non-secret detail.
import { catalogText, useCatalogText } from "@/projects/text"

export const previewKo = {
  "own.preview.title": "모바일 미리보기",
  "own.preview.note":
    "Android 앱이 받는 이 PC의 화면을 이 PC의 창에서 봐요(휴대폰 크기, 터치, 앱 표시). 앱 연결 리스너를 이 PC 안에서만 쓰고, 다른 기기처럼 확인 번호를 보고 [허용]해야 연결돼요.",
  "own.preview.loading": "확인 중…",
  "own.preview.off.gateway": "게이트웨이를 먼저 켜세요.",
  "own.preview.off.app": "앱 연결을 먼저 켜세요.",
  "own.preview.none": "아직 미리보기 기기가 없어요.",
  "own.preview.scopes": "권한: 읽기, 메시지 보내기, 전환(Android 앱 기본값, 터미널 없음). 바꾸려면 기기 목록의 권한 바꾸기를 쓰세요.",
  "own.preview.expires": "만료",
  "own.preview.expires.days": "{days}일",
  "own.preview.create": "미리보기 기기 만들기",
  "own.preview.recreate": "다시 만들기",
  "own.preview.open": "열기",
  "own.preview.remove": "지우기",
  "own.preview.cancel": "취소",
  "own.preview.starting": "미리보기 기기를 만드는 중…",
  "own.preview.waiting": "확인 번호 {sas} · 이 창에 뜬 기기 연결 요청에서 같은 번호를 확인하고 [허용]을 누르세요.",
  "own.preview.done": "미리보기 기기를 만들었어요. [열기]로 창을 열어요.",
  "own.preview.deviceName": "모바일 미리보기 (이 PC)",
  "own.preview.state.checking": "확인 중…",
  "own.preview.state.connected": "연결됨",
  "own.preview.state.unreachable": "연결할 수 없음",
  "own.preview.state.reauth": "다시 만들기 필요",
  "own.preview.open.window": "창 열림",
  "own.preview.expiresAt": "{date}에 만료",
  "own.preview.stale.reauth": "미리보기 기기의 연결이 끊겼거나 만료됐어요. 다시 만드세요.",
  "own.preview.stale.mismatch": "이 PC의 앱 연결 인증서가 미리보기 기기를 만들 때와 달라요. 다시 만드세요.",
  "own.preview.removeTitle": "미리보기 기기를 지울까요?",
  "own.preview.removeBody":
    "이 PC의 원격 접속이 미리보기 기기의 연결을 끊고, 미리보기 창과 저장된 로그인을 지워요. 원격 접속이 꺼져 있으면 기기 목록에서 직접 연결을 끊으세요.",
  "own.preview.removeConfirm": "지우기",
  "own.preview.error.invalid_link": "미리보기 링크가 이 PC의 앱 연결을 가리키지 않아요.",
  "own.preview.error.no_link": "앱 연결 리스너가 꺼져 있어 미리보기 링크를 만들 수 없어요.",
  "own.preview.error.expired": "연결 요청이 만료되었어요. 다시 만드세요.",
  "own.preview.error.rejected": "이 PC에서 거부했어요.",
  "own.preview.error.cancelled": "이 PC에서 연결 요청을 취소했어요.",
  "own.preview.error.rate_limited": "시도가 너무 많아요. 잠시 뒤에 다시 하세요.",
  "own.preview.error.unreachable": "이 PC의 앱 연결 리스너에 닿지 않아요. 앱 연결이 켜져 있는지 확인하세요.",
  "own.preview.error.pin_mismatch": "앱 연결의 인증서가 링크와 달라요. 연결을 중단했어요.",
  "own.preview.error.key_changed": "미리보기 기기가 다른 키로 남아 있어요. 지운 뒤 다시 만드세요.",
  "own.preview.error.aborted": "만들기를 취소했어요.",
  "own.preview.error.failed": "미리보기 기기를 만들지 못했어요 ({detail}).",
} as const

export type PreviewKey = keyof typeof previewKo

export const previewEn: Partial<Record<PreviewKey, string>> = {
  "own.preview.title": "Mobile preview",
  "own.preview.note":
    "See this PC's screen as the Android app gets it (phone size, touch, app mode) in a window on this PC. It uses the app listener on this PC only, and like any device it connects only after you compare the number and press [Allow].",
  "own.preview.loading": "Checking…",
  "own.preview.off.gateway": "Turn the gateway on first.",
  "own.preview.off.app": "Turn app connections on first.",
  "own.preview.none": "No preview device yet.",
  "own.preview.scopes":
    "Permissions: read, send messages, switch (the Android app default, no terminal). Change them with Change permissions in the device list.",
  "own.preview.expires": "Expires",
  "own.preview.expires.days": "{days} days",
  "own.preview.create": "Create preview device",
  "own.preview.recreate": "Create again",
  "own.preview.open": "Open",
  "own.preview.remove": "Remove",
  "own.preview.cancel": "Cancel",
  "own.preview.starting": "Creating the preview device…",
  "own.preview.waiting": "Confirmation number {sas} · check the same number in the device request on this window and press [Allow].",
  "own.preview.done": "Preview device created. Press [Open] for its window.",
  "own.preview.deviceName": "Mobile preview (this PC)",
  "own.preview.state.checking": "Checking…",
  "own.preview.state.connected": "Connected",
  "own.preview.state.unreachable": "Unreachable",
  "own.preview.state.reauth": "Needs recreating",
  "own.preview.open.window": "Window open",
  "own.preview.expiresAt": "Expires {date}",
  "own.preview.stale.reauth": "The preview device was disconnected or expired. Create it again.",
  "own.preview.stale.mismatch": "This PC's app connection certificate changed since the preview device was made. Create it again.",
  "own.preview.removeTitle": "Remove the preview device?",
  "own.preview.removeBody":
    "This PC's remote access disconnects the preview device, and its window and stored login are removed. If remote access is off, disconnect it in the device list yourself.",
  "own.preview.removeConfirm": "Remove",
  "own.preview.error.invalid_link": "The preview link does not point at this PC's app connection.",
  "own.preview.error.no_link": "App connections are not listening, so no preview link can be made.",
  "own.preview.error.expired": "The request expired. Create it again.",
  "own.preview.error.rejected": "Denied on this PC.",
  "own.preview.error.cancelled": "The request was cancelled on this PC.",
  "own.preview.error.rate_limited": "Too many attempts. Try again in a moment.",
  "own.preview.error.unreachable": "The app listener on this PC does not answer. Check that app connections are on.",
  "own.preview.error.pin_mismatch": "The app connection's certificate differs from the link. Stopped.",
  "own.preview.error.key_changed": "A preview device with another key is still stored. Remove it, then create it again.",
  "own.preview.error.aborted": "Cancelled.",
  "own.preview.error.failed": "Could not create the preview device ({detail}).",
}

export const previewText = catalogText(previewKo, previewEn)

export function usePreviewText() {
  return useCatalogText(previewText)
}
