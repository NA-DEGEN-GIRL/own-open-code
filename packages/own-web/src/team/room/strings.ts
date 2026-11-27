// 팀 룸 strings (06 §9.9, 2026-11-27): the work panel's tab that shows each active area's owner at a desk. Kept next
// to the room so its chunk does not load the team catalog; keys can move verbatim into src/i18n/ko.ts / en.ts.
import { featureText } from "@/queue/text"

export const roomKo = {
  "own.team.room.label": "팀 룸: 영역 {n}개",
  "own.team.room.empty": "아직 영역이 없어요. 팀 메인이 영역을 만들면 여기에 담당이 앉아요",
  "own.team.room.loading": "팀을 불러오는 중이에요",
  "own.team.room.flat": "3D 그림을 쓸 수 없어 목록으로 보여요",
  "own.team.room.lost": "그래픽이 잠시 멈췄어요. 목록으로 보여요",
  "own.team.room.retry": "다시 그리기",
  "own.team.room.open": "{label} 담당 대화 열기",
  "own.team.room.noOwner": "{label}: 아직 담당 대화가 없어요",
  "own.team.room.state.working": "일하는 중",
  "own.team.room.state.idle": "쉬는 중",
  "own.team.room.state.sleeping": "조는 중",
  "own.team.room.state.waiting": "사용자를 기다려요",
  "own.team.room.state.error": "문제가 생겼어요",
} as const satisfies Record<string, string>

export type RoomKey = keyof typeof roomKo

export const roomEn: Record<RoomKey, string> = {
  "own.team.room.label": "Team room: {n} areas",
  "own.team.room.empty": "No areas yet. When the team main creates an area, its owner takes a desk here",
  "own.team.room.loading": "Loading the team",
  "own.team.room.flat": "3D drawing is not available, so this is a list",
  "own.team.room.lost": "The graphics stopped for a moment, so this is a list",
  "own.team.room.retry": "Draw again",
  "own.team.room.open": "Open the {label} owner conversation",
  "own.team.room.noOwner": "{label}: no owner conversation yet",
  "own.team.room.state.working": "Working",
  "own.team.room.state.idle": "Resting",
  "own.team.room.state.sleeping": "Dozing",
  "own.team.room.state.waiting": "Waiting for you",
  "own.team.room.state.error": "Something went wrong",
}

export const roomText = featureText(roomKo, roomEn)
