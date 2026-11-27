// Queue/steer panel strings (03 §18.9). 03 §14 keys (`own.queue.title|steer|queue|sendNow|edit|afterSwitch`,
// `own.composer.heldRow`) come from the shared catalog; these are the rest, `own.queuePanel.*`, ready to move into
// ko.ts/en.ts (section "queue").
import { featureText } from "./text"

export const queueKo = {
  "own.queuePanel.handle": "끌거나 ↑/↓로 순서 바꾸기",
  "own.queuePanel.steerTurn": "이번 턴에 끼워 넣음",
  "own.queuePanel.parked": "멈춰 있음 · 지금 보내기로 시작",
  "own.queuePanel.compaction": "문맥 압축 대기",
  "own.queuePanel.move": "프로젝트 이동 대기",
  "own.queuePanel.reset": "문맥 비우기 · 이 턴이 끝나면",
  "own.queuePanel.attachments": "첨부 {n}",
  "own.queuePanel.defaultSteer": "실행 중 {key}: 끼워 넣기",
  "own.queuePanel.defaultQueue": "실행 중 {key}: 대기열",
  "own.queuePanel.changed": "대기열이 바뀌어 순서를 다시 정하지 못했어요",
  "own.queuePanel.reorderBlocked": "압축·이동 항목이 대기 중이라 순서를 바꿀 수 없어요",
  "own.queuePanel.revertBlocked":
    "복원 대기 중에는 순서를 바꾸거나 다시 넣을 수 없어요(다시 넣으면 복원이 확정돼요)",
  "own.queuePanel.moved": "{n}번째로 옮겼어요",
  "own.queuePanel.cancelHeld": "보류한 메시지 빼기",
  // Main requests of team mode (06 §5.2, §9.6; the same words as `own.team.sent.*`)
  "own.queuePanel.source.main": "메인이 보냄",
  "own.queuePanel.source.team": "팀이 보냄",
  // Area messages (06 §5.8; the same words as `own.team.sent.area`, `own.team.sent.peer`)
  "own.queuePanel.source.area": "'{area}' 담당이 보냄",
  "own.queuePanel.source.peer": "'{area}' 동료 {label}(이)가 보냄",
} as const satisfies Record<string, string>

export type QueueKey = keyof typeof queueKo

export const queueEn: Partial<Record<QueueKey, string>> = {
  "own.queuePanel.handle": "Drag or use ↑/↓ to reorder",
  "own.queuePanel.steerTurn": "Steers into this turn",
  "own.queuePanel.parked": "Paused · send now to start",
  "own.queuePanel.compaction": "Context compaction waiting",
  "own.queuePanel.move": "Project move waiting",
  "own.queuePanel.reset": "Reset context · when this turn ends",
  "own.queuePanel.attachments": "{n} attachments",
  "own.queuePanel.defaultSteer": "{key} while running: steer",
  "own.queuePanel.defaultQueue": "{key} while running: queue",
  "own.queuePanel.changed": "The queue changed; reorder again",
  "own.queuePanel.reorderBlocked": "A compaction or move is queued; the order cannot change now",
  "own.queuePanel.revertBlocked": "A revert is staged; queued messages cannot be re-added (that would commit it)",
  "own.queuePanel.moved": "Moved to position {n}",
  "own.queuePanel.cancelHeld": "Remove held message",
  "own.queuePanel.source.main": "Sent by the main",
  "own.queuePanel.source.team": "Sent by the team",
  "own.queuePanel.source.area": "Sent by the owner of '{area}'",
  "own.queuePanel.source.peer": "Sent by peer {label} of '{area}'",
}

export const queueText = featureText(queueKo, queueEn)
export const useQueueText = queueText.use
