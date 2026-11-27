// Voice input strings of the dictation control (03 §4.6 받아쓰기), in the composer's first chunk; 설정 > 음성 입력 keeps its
// own in settings-strings.ts (lazy, like computer/panel-strings.ts). Kept next to the module like the other feature
// catalogs; the keys can move verbatim into src/i18n/ko.ts / en.ts (section "voice").
import { featureText } from "@/queue/text"

export const voiceKo = {
  "own.voice.button": "음성 입력",
  "own.voice.buttonHint": "음성 입력 ({keys}: 누르고 말하기, 짧게 누르면 켜고 끄기)",
  "own.voice.recording": "듣는 중",
  "own.voice.elapsed": "{time} / {max}",
  "own.voice.level": "소리 크기",
  "own.voice.done": "완료",
  "own.voice.cancel": "취소",
  "own.voice.transcribing": "받아쓰는 중…",
  "own.voice.retry": "다시 시도",
  "own.voice.dismiss": "닫기",
  "own.voice.inserted": "받아쓴 글을 넣었어요",
  "own.voice.waitingIme": "글자 조합이 끝나면 넣어요",
  "own.voice.nothing": "알아들은 말이 없어요",
  "own.voice.problem.denied":
    "마이크 권한이 없어요. 브라우저 주소창의 사이트 설정(데스크톱 앱은 Windows 설정 > 개인 정보 > 마이크, Android 앱은 앱 정보 > 권한)에서 허용한 뒤 다시 시도하세요",
  "own.voice.problem.no_device": "마이크를 찾지 못했어요",
  "own.voice.problem.busy": "다른 프로그램이 마이크를 쓰고 있어요",
  "own.voice.problem.insecure": "마이크는 HTTPS 주소에서만 쓸 수 있어요",
  "own.voice.problem.unsupported": "이 브라우저는 녹음을 지원하지 않아요",
  "own.voice.problem.failed": "녹음하지 못했어요",
  "own.voice.problem.empty": "녹음된 소리가 없어요",
  "own.voice.problem.too_large": "녹음이 너무 커요 (최대 {max})",
  "own.voice.problem.too_long": "녹음이 너무 길어요 (최대 {max})",
  "own.voice.problem.encoding": "녹음 파일을 보낼 수 없어요",
  "own.voice.problem.disabled": "음성 입력이 꺼져 있어요. 설정 > 음성 입력에서 켜세요",
  "own.voice.problem.key_missing": "음성 입력 키가 없어요. PC의 설정 > 음성 입력에서 넣으세요",
  "own.voice.problem.auth": "인식 서비스가 키를 받지 않았어요. 설정 > 음성 입력에서 키를 확인하세요",
  "own.voice.problem.rate_limited": "인식 서비스 요청이 너무 많아요. 잠시 뒤 다시 시도하세요",
  "own.voice.problem.quota": "인식 서비스의 크레딧이나 한도가 다 찼어요",
  "own.voice.problem.rejected": "인식 서비스가 이 녹음을 받지 않았어요",
  "own.voice.problem.network": "인식 서비스에 닿지 못했어요",
  "own.voice.problem.timeout": "인식이 너무 오래 걸려 멈췄어요",
  "own.voice.problem.provider": "인식 서비스에서 오류가 났어요",
  "own.voice.problem.vault": "PC의 키 저장소를 읽지 못했어요",
  "own.voice.problem.scope": "이 기기는 음성 입력을 쓸 수 없어요(메시지 보내기 권한 필요)",
  "own.voice.problem.offline": "PC에 연결되어 있지 않아요",
  "own.voice.problem.remote": "음성 입력은 이 PC에서만 돼요",
} as const satisfies Record<string, string>

export type VoiceKey = keyof typeof voiceKo

export const voiceEn: Partial<Record<VoiceKey, string>> = {
  "own.voice.button": "Voice input",
  "own.voice.buttonHint": "Voice input ({keys}: hold to talk, tap to toggle)",
  "own.voice.recording": "Listening",
  "own.voice.level": "Input level",
  "own.voice.done": "Done",
  "own.voice.cancel": "Cancel",
  "own.voice.transcribing": "Transcribing…",
  "own.voice.retry": "Retry",
  "own.voice.dismiss": "Dismiss",
  "own.voice.inserted": "Inserted the transcript",
  "own.voice.waitingIme": "Inserting once the composition ends",
  "own.voice.nothing": "No speech was recognized",
  "own.voice.problem.denied":
    "No microphone permission. Allow it in the site settings (desktop app: Windows Settings > Privacy > Microphone; Android app: App info > Permissions), then retry",
  "own.voice.problem.no_device": "No microphone found",
  "own.voice.problem.busy": "Another program is using the microphone",
  "own.voice.problem.insecure": "The microphone works on HTTPS addresses only",
  "own.voice.problem.unsupported": "This browser cannot record audio",
  "own.voice.problem.failed": "Could not record",
  "own.voice.problem.empty": "Nothing was recorded",
  "own.voice.problem.too_large": "The recording is too large (max {max})",
  "own.voice.problem.too_long": "The recording is too long (max {max})",
  "own.voice.problem.encoding": "The recording cannot be sent",
  "own.voice.problem.disabled": "Voice input is off. Turn it on in Settings > Voice input",
  "own.voice.problem.key_missing": "No voice input key. Add one in Settings > Voice input on the PC",
  "own.voice.problem.auth": "The recognition service refused the key. Check it in Settings > Voice input",
  "own.voice.problem.rate_limited": "Too many requests to the recognition service. Retry in a moment",
  "own.voice.problem.quota": "The recognition service's credits or quota are used up",
  "own.voice.problem.rejected": "The recognition service refused this recording",
  "own.voice.problem.network": "Could not reach the recognition service",
  "own.voice.problem.timeout": "The recognition took too long and was stopped",
  "own.voice.problem.provider": "The recognition service failed",
  "own.voice.problem.vault": "The PC's key store could not be read",
  "own.voice.problem.scope": "This device may not use voice input (needs the send-messages permission)",
  "own.voice.problem.offline": "Not connected to the PC",
  "own.voice.problem.remote": "Voice input works on this PC only",
}

export const voiceText = featureText(voiceKo, voiceEn)
export const useVoiceText = voiceText.use
