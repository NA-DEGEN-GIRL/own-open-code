// 원격 PC dialog strings (08 §3.5, §4.1), lazy with the dialogs. ko + en, `own.remotePc.*`, same rules as strings.ts.
// Error keys are main's codes (`own:remote-pcs.pair`); only `failed` shows its non-secret detail.
import { catalogText, useCatalogText } from "@/projects/text"

export const remotePcDialogKo = {
  // add
  "own.remotePc.addTitle": "다른 PC 추가",
  "own.remotePc.reconnectTitle": "{name} 다시 연결",
  "own.remotePc.link": "연결 링크",
  "own.remotePc.linkHint":
    "연결할 PC의 설정 > 휴대폰·다른 PC > 새 기기 연결에서 만든 ownpc:// 링크를 붙여 넣으세요. 링크는 5분 동안 한 번만 쓸 수 있어요.",
  "own.remotePc.connect": "연결",
  "own.remotePc.cancel": "취소",
  "own.remotePc.close": "닫기",
  "own.remotePc.starting": "PC에 연결하는 중…",
  "own.remotePc.sas": "확인 번호 {sas} · {name}에서 이 번호가 보이면 [허용]을 누르세요",
  "own.remotePc.waiting": "PC의 허용을 기다리는 중…",
  "own.remotePc.done": "{name}(을)를 추가했어요.",
  "own.remotePc.doneOpen": "열기",
  // errors
  "own.remotePc.error.invalid_link": "다른 PC 연결 링크가 아니에요. ownpc://pair로 시작하는 링크 전체를 붙여 넣으세요.",
  "own.remotePc.error.expired": "링크가 만료되었거나 이미 쓰였어요. PC에서 새 링크를 만드세요.",
  "own.remotePc.error.rejected":
    "PC에서 거부했어요. PC에 보인 확인 번호가 여기와 다르면 링크가 바뀌었을 수 있으니 새 링크로 다시 하세요.",
  "own.remotePc.error.cancelled": "PC에서 연결 요청을 취소했어요.",
  "own.remotePc.error.rate_limited": "시도가 너무 많아요. 잠시 뒤에 다시 하세요.",
  "own.remotePc.error.unreachable":
    "PC에 연결할 수 없어요. PC가 켜져 있고 Tailscale 또는 포트 전달(DDNS)이 설정되어 있는지 확인하세요.",
  "own.remotePc.error.pin_mismatch":
    "PC의 인증서가 링크와 달라요. 연결을 중단했어요. 중간에서 가로채는 공격일 수 있으니 PC에서 새 링크를 만드세요.",
  "own.remotePc.error.key_changed":
    "이 PC는 이미 다른 키로 추가되어 있어 아무것도 바꾸지 않았어요. 링크가 위조되었을 수 있어요. PC의 키를 정말 바꿨다면 다른 PC 목록에서 먼저 뺀 뒤 다시 추가하세요.",
  "own.remotePc.error.aborted": "연결을 취소했어요.",
  "own.remotePc.error.failed": "연결하지 못했어요 ({detail}).",
  // remove
  "own.remotePc.removeTitle": "{name}(을)를 목록에서 뺄까요?",
  "own.remotePc.removeBody":
    "{name}에 이 기기의 연결을 끊어 달라고 요청한 뒤, 이 PC에서 {name} 창을 닫고 저장된 로그인과 연결 정보를 지워요. {name}에 닿지 않으면 {name}의 설정 > 휴대폰·다른 PC에서 이 기기의 연결을 직접 끊으세요.",
  "own.remotePc.removeConfirm": "목록에서 빼기",
} as const

export type RemotePcDialogKey = keyof typeof remotePcDialogKo

export const remotePcDialogEn: Partial<Record<RemotePcDialogKey, string>> = {
  "own.remotePc.addTitle": "Add other PC",
  "own.remotePc.reconnectTitle": "Reconnect {name}",
  "own.remotePc.link": "Connection link",
  "own.remotePc.linkHint":
    "Paste the ownpc:// link from Settings > Phone & other PCs > Connect new device on the other PC. A link works once, for 5 minutes.",
  "own.remotePc.connect": "Connect",
  "own.remotePc.cancel": "Cancel",
  "own.remotePc.close": "Close",
  "own.remotePc.starting": "Connecting to the PC…",
  "own.remotePc.sas": "Confirmation number {sas} · press [Allow] on {name} if it shows this number",
  "own.remotePc.waiting": "Waiting for the PC to allow…",
  "own.remotePc.done": "Added {name}.",
  "own.remotePc.doneOpen": "Open",
  "own.remotePc.error.invalid_link": "Not an other-PC link. Paste the whole link starting with ownpc://pair.",
  "own.remotePc.error.expired": "The link expired or was already used. Make a new link on the PC.",
  "own.remotePc.error.rejected":
    "The PC refused. If it showed another confirmation number, the link may have been altered: try a new link.",
  "own.remotePc.error.cancelled": "The PC cancelled the request.",
  "own.remotePc.error.rate_limited": "Too many attempts. Try again in a moment.",
  "own.remotePc.error.unreachable":
    "Cannot reach the PC. Check that it is on and that Tailscale or port forwarding (DDNS) is set up.",
  "own.remotePc.error.pin_mismatch":
    "The PC's certificate does not match the link, so the connection was stopped. It may be intercepted: make a new link on the PC.",
  "own.remotePc.error.key_changed":
    "This PC is already added under a different key, so nothing was changed. The link may be forged. If the PC's key really changed, remove it from the other PC list first, then add it again.",
  "own.remotePc.error.aborted": "Cancelled.",
  "own.remotePc.error.failed": "Could not connect ({detail}).",
  "own.remotePc.removeTitle": "Remove {name} from the list?",
  "own.remotePc.removeBody":
    "Asks {name} to disconnect this device, then closes its window and deletes its stored sign-in and connection details on this PC. If {name} cannot be reached, disconnect this device in its Settings > Phone & other PCs.",
  "own.remotePc.removeConfirm": "Remove from the list",
}

export const remotePcDialogText = catalogText(remotePcDialogKo, remotePcDialogEn)

export function useRemotePcDialogText() {
  return useCatalogText(remotePcDialogText)
}
