// Chat view strings (03 §4.5 "대화 보기", §5.7 설정 > 일반) and the footer's speed words. Kept next to the module; the
// keys can move verbatim into src/i18n/ko.ts / en.ts (section "chat-view").
import { featureText } from "@/queue/text"

export const chatViewKo = {
  "own.chatView.title": "대화 보기",
  "own.chatView.button": "대화 보기: 보일 정보 고르기",
  "own.chatView.note": "대화 주변에 보일 정보를 골라요. 화면에만 적용되며 모델에 보내는 내용은 바뀌지 않아요.",
  "own.chatView.scope": "이 기기(브라우저)에만 저장돼요.",
  "own.chatView.chatOnly": "대화만 보기",
  "own.chatView.chatOnlyOff": "대화만 보기 끄기",
  "own.chatView.reset": "기본으로",
  "own.chatView.hiddenCount": "정보 {n}개 숨김",
  "own.chatView.meta.usage": "사용량 줄(토큰·비용)",
  "own.chatView.meta.speed": "속도(t/s·첫 토큰)",
  "own.chatView.meta.model": "모델·계정",
  "own.chatView.meta.time": "걸린 시간",
  "own.chatView.meta.clock": "날짜·시각",
  "own.chatView.meta.thinking": "생각 과정",
  "own.chatView.meta.tools": "도구 호출·셸·편집 카드",
  "own.chatView.meta.subagents": "하위 에이전트",
  "own.chatView.meta.markers": "전환·압축 표시",
  "own.chatView.meta.changes": "변경 요약",
  // UC 2026-10-18 `날짜·시각`: a message's date and time (format.ts `formatClock`), the seconds in its tooltip.
  "own.clock.sent": "보낸 시각: {at}",
  "own.clock.span": "시작: {start} · 끝: {end}",
  "own.clock.started": "시작: {start}",
  "own.clock.column": "시각",
  "own.speed.value": "{value} t/s",
  "own.speed.approx": "≈{value} t/s",
  "own.speed.firstToken": "첫 토큰 {value}",
  "own.speed.seconds": "{n}초",
  "own.speed.column": "속도",
  "own.speed.decodeHint":
    "출력 속도: 첫 출력부터 응답 끝까지 나온 출력·추론 토큰 수예요. 첫 토큰을 기다린 시간과 도구 실행 시간은 뺐어요.",
  "own.speed.requestHint":
    "≈ 요청 시작부터 응답 끝까지로 잰 속도예요. 첫 토큰을 기다린 시간(프롬프트 처리)이 들어가 실제 생성 속도보다 낮게 보여요. 도구 실행 시간은 뺐어요.",
} as const satisfies Record<string, string>

export type ChatViewKey = keyof typeof chatViewKo

export const chatViewEn: Partial<Record<ChatViewKey, string>> = {
  "own.chatView.title": "Chat view",
  "own.chatView.button": "Chat view: choose what to show",
  "own.chatView.note": "Choose what shows around the conversation. Display only: what the model receives is unchanged.",
  "own.chatView.scope": "Saved on this device (browser) only.",
  "own.chatView.chatOnly": "Conversation only",
  "own.chatView.chatOnlyOff": "Turn off conversation only",
  "own.chatView.reset": "Default",
  "own.chatView.hiddenCount": "{n} hidden",
  "own.chatView.meta.usage": "Usage line (tokens, cost)",
  "own.chatView.meta.speed": "Speed (t/s, first token)",
  "own.chatView.meta.model": "Model and account",
  "own.chatView.meta.time": "Durations",
  "own.chatView.meta.clock": "Date and time",
  "own.chatView.meta.thinking": "Thinking",
  "own.chatView.meta.tools": "Tool calls, shell and edit cards",
  "own.chatView.meta.subagents": "Subagents",
  "own.chatView.meta.markers": "Switch and compaction markers",
  "own.chatView.meta.changes": "Change summary",
  "own.clock.sent": "Sent: {at}",
  "own.clock.span": "Started: {start} · finished: {end}",
  "own.clock.started": "Started: {start}",
  "own.clock.column": "Time",
  "own.speed.firstToken": "first token {value}",
  "own.speed.seconds": "{n}s",
  "own.speed.column": "Speed",
  "own.speed.decodeHint":
    "Output speed: output and reasoning tokens from the first output to the end of the response. Waiting for the first token and tool runs are left out.",
  "own.speed.requestHint":
    "≈ Measured from the request start to the end of the response, so the wait for the first token (prompt processing) is included and it reads lower than the generation speed. Tool runs are left out.",
}

export const chatViewText = featureText(chatViewKo, chatViewEn)
export const useChatViewText = chatViewText.use
