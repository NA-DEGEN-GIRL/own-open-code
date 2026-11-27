// Revert strings (03 §18.7, 18.13). 03 §14 keys (`own.revert.action|withFiles|staged|commit|clear|switchInRange|
// queueDropped`) come from the shared catalog; these are the rest, `own.revertOps.*`, ready to move into ko.ts/en.ts
// (section "revert"). Label rule (18.7): the verb is `복원`; `되돌리기` belongs to `switch.undo` only and appears in no
// key here (the one exception is the catalog's own `own.revert.withFiles`, which 03 §14 defines verbatim).
import { featureText } from "@/queue/text"

export const revertKo = {
  "own.revertOps.body": "이 메시지와 그 뒤의 턴 {n}개를 되감아요.",
  "own.revertOps.bodyLast": "이 메시지와 그 답을 되감아요.",
  "own.revertOps.confirm": "복원",
  "own.revertOps.confirmStop": "중단하고 복원",
  "own.revertOps.cancel": "취소",
  "own.revertOps.running": "실행 중인 턴을 먼저 중단해요.",
  "own.revertOps.queue": "대기 중인 메시지 {n}개는 취소돼요(되감은 대화를 기준으로 쓴 메시지라서).",
  "own.revertOps.coldPoint":
    "복원을 확정한 뒤 첫 요청은 캐시를 다시 쌓는 지점이에요 · 다시 쓰는 입력 최대 약 {tokens} (추정)",
  "own.revertOps.coldPointPlain": "복원을 확정한 뒤 첫 요청은 캐시를 다시 쌓는 지점이에요.",
  "own.revertOps.cacheNow": "지금 캐시: {state}",
  "own.revertOps.commitHint": "입력창의 메시지를 그대로 고쳐 보내면 복원이 확정돼요.",
  "own.revertOps.view": "변경 보기",
  "own.revertOps.hide": "변경 접기",
  "own.revertOps.filesTitle": "되돌린 파일 {n}개",
  "own.revertOps.noFiles": "파일 변경은 되돌리지 않았어요",
  "own.revertOps.status.added": "추가",
  "own.revertOps.status.modified": "수정",
  "own.revertOps.status.deleted": "삭제",
  "own.revertOps.working": "복원하는 중…",
  "own.revertOps.committed": "복원을 확정했어요",
  "own.revertOps.cleared": "복원을 취소했어요",
  "own.revertOps.failed": "복원하지 못했어요: {reason}",
  "own.revertOps.busy": "실행 중이라 복원할 수 없어요. 중단한 뒤 다시 시도하세요.",
  "own.revertOps.pending": "아직 대기열에 있는 메시지라 복원 지점이 될 수 없어요. 대기열에서 편집하거나 취소하세요.",
  "own.revertOps.undo": "마지막 턴 복원(파일 포함)",
  "own.revertOps.nothingToUndo": "복원할 턴이 없어요",
  "own.revertOps.nothingToRedo": "복원 대기가 없어요",
  "own.revertOps.bar": "복원 대기 띠",
} as const satisfies Record<string, string>

export type RevertKey = keyof typeof revertKo

export const revertEn: Partial<Record<RevertKey, string>> = {
  "own.revertOps.body": "Rewinds this message and the {n} turns after it.",
  "own.revertOps.bodyLast": "Rewinds this message and its answer.",
  "own.revertOps.confirm": "Restore",
  "own.revertOps.confirmStop": "Stop and restore",
  "own.revertOps.cancel": "Cancel",
  "own.revertOps.running": "The running turn is stopped first.",
  "own.revertOps.queue": "{n} queued messages are cancelled (they were written against the rewound conversation).",
  "own.revertOps.coldPoint":
    "After you commit, the first request rebuilds the cache · up to about {tokens} input rewritten (estimate)",
  "own.revertOps.coldPointPlain": "After you commit, the first request rebuilds the cache.",
  "own.revertOps.cacheNow": "Cache now: {state}",
  "own.revertOps.commitHint": "Edit and send the message in the composer to commit the restore.",
  "own.revertOps.view": "View changes",
  "own.revertOps.hide": "Hide changes",
  "own.revertOps.filesTitle": "{n} files restored",
  "own.revertOps.noFiles": "File changes were kept",
  "own.revertOps.status.added": "added",
  "own.revertOps.status.modified": "modified",
  "own.revertOps.status.deleted": "deleted",
  "own.revertOps.working": "Restoring…",
  "own.revertOps.committed": "Restore committed",
  "own.revertOps.cleared": "Restore cancelled",
  "own.revertOps.failed": "Could not restore: {reason}",
  "own.revertOps.busy": "The session is running. Stop it and try again.",
  "own.revertOps.pending":
    "This message is still queued, so it cannot be a restore point. Edit or cancel it in the queue.",
  "own.revertOps.undo": "Restore the last turn (with files)",
  "own.revertOps.nothingToUndo": "No turn to restore",
  "own.revertOps.nothingToRedo": "No staged restore",
  "own.revertOps.bar": "Staged restore",
}

export const revertText = featureText(revertKo, revertEn)
export const useRevertText = revertText.use
