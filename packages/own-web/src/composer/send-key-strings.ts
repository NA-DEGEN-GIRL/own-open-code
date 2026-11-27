// `보내는 키` strings (03 §4.6, §5.7 설정 > 일반, §10): the composer's send-key menu, the settings row, the palette
// command and the toast. Kept next to the module; the keys can move verbatim into src/i18n/ko.ts / en.ts.
import { featureText } from "@/queue/text"

export const sendKeyKo = {
  "own.sendKey.title": "보내는 키",
  "own.sendKey.enter": "Enter로 보내기",
  "own.sendKey.modEnter": "{mod}+Enter로 보내기",
  "own.sendKey.detail": "{newline} 줄바꿈 · 실행 중 {other} {delivery}",
  "own.sendKey.button": "보내는 키 바꾸기 (지금: {current})",
  "own.sendKey.settingNote": "대화 입력창에만 적용돼요. {newline}는 줄바꿈이에요.",
  "own.sendKey.changed": "{send}로 보내요. {newline}는 줄바꿈이에요.",
  "own.sendKey.placeholder": "메시지를 입력하세요. {send}로 보내요 · / 명령, @ 파일",
  "own.sendKey.placeholderShell": "셸 명령 — {send}로 실행 · 에이전트를 깨우지 않아요",
  "own.sendKey.palette": "보내는 키 바꾸기",
  "own.sendKey.paletteDetail": "지금 {current} → {next}",
} as const satisfies Record<string, string>

export type SendKeyKey = keyof typeof sendKeyKo

export const sendKeyEn: Partial<Record<SendKeyKey, string>> = {
  "own.sendKey.title": "Send key",
  "own.sendKey.enter": "Send with Enter",
  "own.sendKey.modEnter": "Send with {mod}+Enter",
  "own.sendKey.detail": "{newline} new line · while running {other} {delivery}",
  "own.sendKey.button": "Change the send key (now: {current})",
  "own.sendKey.settingNote": "Only the conversation composer. {newline} adds a new line.",
  "own.sendKey.changed": "{send} sends. {newline} adds a new line.",
  "own.sendKey.placeholder": "Type a message. {send} sends · / commands, @ files",
  "own.sendKey.placeholderShell": "Shell command — {send} runs it · does not wake the agent",
  "own.sendKey.palette": "Change the send key",
  "own.sendKey.paletteDetail": "now {current} → {next}",
}

export const sendKeyText = featureText(sendKeyKo, sendKeyEn)
export const useSendKeyText = sendKeyText.use
