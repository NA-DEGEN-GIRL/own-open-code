// Voice input module entry (02 §3.9, 03 §4.6 받아쓰기, §5.7.4, owner: VOICE). `DictationButton` is the one control the
// composer and both note editors mount; 설정 > 음성 입력 is the lazy `@/voice/settings`. Recording happens in the page,
// recognition on this PC's service (`own.accounts` `voice.transcribe`) with a voice-only key the page never sees.
export { DictationButton, type DictationButtonProps } from "./button"
export { buildHint, projectHint } from "./hint"
