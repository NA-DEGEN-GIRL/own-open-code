// 설정 > 음성 입력 strings (03 §5.7.3), in the settings page's lazy chunk. Same rules as strings.ts.
import { featureText } from "@/queue/text"

export const voiceSettingsKo = {
  "own.voice.set.intro":
    "말한 내용을 글자로 바꿔 입력창이나 노트의 커서 위치에 넣어요. 바로 보내지 않아요. 녹음은 저장하지 않고 인식 서비스에만 보내요.",
  "own.voice.set.enabled": "음성 입력 사용",
  "own.voice.set.enabledNote":
    "켜면 입력창과 노트에 마이크 버튼이 생겨요. 인식할 때마다 아래 서비스의 유료 API 시간을 써요.",
  "own.voice.set.on": "켬",
  "own.voice.set.off": "끔",
  "own.voice.set.provider": "인식 서비스",
  "own.voice.set.openai": "OpenAI (gpt-transcribe)",
  "own.voice.set.deepgram": "Deepgram (Nova-3)",
  "own.voice.set.language": "언어",
  "own.voice.set.auto": "자동",
  "own.voice.set.ko": "한국어",
  "own.voice.set.en": "English",
  "own.voice.set.keys": "음성 입력 전용 키",
  "own.voice.set.keysNote":
    "모델 계정의 키와 따로 둬요. 여기 넣은 키는 음성 입력에만 쓰고, 계정 키나 ChatGPT 구독으로 음성 입력을 하지 않아요. 키는 이 PC의 키 저장소에만 암호화해 저장되고 화면에 다시 보이지 않아요.",
  "own.voice.set.keyOpenai": "OpenAI API 키",
  "own.voice.set.keyDeepgram": "Deepgram API 키",
  "own.voice.set.keySaved": "저장됨 {hint}",
  "own.voice.set.keyNone": "없음",
  "own.voice.set.keySave": "저장",
  "own.voice.set.keyReplace": "바꾸기",
  "own.voice.set.keyRemove": "지우기",
  "own.voice.set.keyRemoveConfirm": "{name}(을)를 지울까요? 이 서비스로는 음성 입력을 할 수 없게 돼요.",
  "own.voice.set.keyLocal": "키는 이 PC의 창에서만 넣고 바꿀 수 있어요",
  "own.voice.set.keyInvalid": "키 모양이 아니에요 (공백이나 제어 문자가 있음)",
  "own.voice.set.keyStored": "키를 저장했어요",
  "own.voice.set.keyRemoved": "키를 지웠어요",
  "own.voice.set.vaultUnavailable": "키 저장소가 응답하지 않아요",
  "own.voice.set.shortcut": "단축키",
  "own.voice.set.shortcutNote":
    "누르고 있는 동안 녹음하고 떼면 받아써요. 짧게 누르면 켜고, 한 번 더 누르면 끝내요.",
  "own.voice.set.shortcutChange": "설정 > 단축키에서 바꾸기",
  "own.voice.set.shortcutNone": "지정 안 됨",
  "own.voice.set.usage": "사용량",
  "own.voice.set.usageRow": "{month} · {service}: {minutes}분 ({count}번)",
  "own.voice.set.usageNone": "아직 쓰지 않았어요",
  "own.voice.set.limits": "한 번에 최대 {seconds}초, {size}까지 녹음해요.",
  "own.voice.set.notReady": "선택한 서비스의 키가 없어 마이크 버튼이 보이지 않아요",
  "own.voice.set.ready": "준비됨: 입력창과 노트에 마이크 버튼이 보여요",
  "own.voice.set.unsupported": "이 서비스 버전은 음성 입력을 지원하지 않아요",
} as const satisfies Record<string, string>

export type VoiceSettingsKey = keyof typeof voiceSettingsKo

export const voiceSettingsEn: Partial<Record<VoiceSettingsKey, string>> = {
  "own.voice.set.intro":
    "Turns speech into text at the cursor of the composer or a note. Nothing is sent by itself. Recordings are not stored; they go to the recognition service only.",
  "own.voice.set.enabled": "Use voice input",
  "own.voice.set.enabledNote":
    "Shows a microphone button in the composer and the notes. Each recognition uses paid API minutes of the service below.",
  "own.voice.set.on": "On",
  "own.voice.set.off": "Off",
  "own.voice.set.provider": "Recognition service",
  "own.voice.set.language": "Language",
  "own.voice.set.auto": "Automatic",
  "own.voice.set.ko": "한국어",
  "own.voice.set.en": "English",
  "own.voice.set.keys": "Voice-only keys",
  "own.voice.set.keysNote":
    "Kept apart from the model accounts' keys. A key here is used for voice input only, and voice input never uses an account's key or a ChatGPT subscription. Keys are stored encrypted only in this PC's key store and never shown again.",
  "own.voice.set.keyOpenai": "OpenAI API key",
  "own.voice.set.keyDeepgram": "Deepgram API key",
  "own.voice.set.keySaved": "Saved {hint}",
  "own.voice.set.keyNone": "None",
  "own.voice.set.keySave": "Save",
  "own.voice.set.keyReplace": "Replace",
  "own.voice.set.keyRemove": "Remove",
  "own.voice.set.keyRemoveConfirm": "Remove the {name}? Transcription with this service stops working.",
  "own.voice.set.keyLocal": "Keys can be entered and changed only in this PC's windows",
  "own.voice.set.keyInvalid": "That is not a key (it holds spaces or control characters)",
  "own.voice.set.keyStored": "Key saved",
  "own.voice.set.keyRemoved": "Key removed",
  "own.voice.set.vaultUnavailable": "The key store does not answer",
  "own.voice.set.shortcut": "Shortcut",
  "own.voice.set.shortcutNote": "Hold to record, release to transcribe. A short press starts; press again to finish.",
  "own.voice.set.shortcutChange": "Change in Settings > Shortcuts",
  "own.voice.set.shortcutNone": "Not assigned",
  "own.voice.set.usage": "Usage",
  "own.voice.set.usageRow": "{month} · {service}: {minutes} min ({count} times)",
  "own.voice.set.usageNone": "Not used yet",
  "own.voice.set.limits": "Each recording is at most {seconds} s and {size}.",
  "own.voice.set.notReady": "The selected service has no key, so the microphone button is hidden",
  "own.voice.set.ready": "Ready: the composer and the notes show the microphone button",
  "own.voice.set.unsupported": "This service version does not support voice input",
}

export const voiceSettingsText = featureText(voiceSettingsKo, voiceSettingsEn)
export const useVoiceSettingsText = voiceSettingsText.use
