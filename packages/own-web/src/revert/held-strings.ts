// The revert dialog's and bar's words for a boundary far up a long transcript (03 §18.7), whose view does not hold
// every turn after it (transcript/held.ts): the count is a lower bound. Lazy, with the dialog and the bar.
import { featureText } from "@/queue/text"

export const revertHeldKo = {
  "own.revertOps.bodyMore": "이 메시지와 그 뒤의 턴 {n}개 이상을 되감아요.",
  "own.revertOps.stagedMore": "복원 대기: 이 메시지 뒤 턴 {turns}개 이상과 파일 변경 {files}개를 되돌렸어요",
} as const satisfies Record<string, string>

export const revertHeldText = featureText(revertHeldKo, {
  "own.revertOps.bodyMore": "Rewinds this message and at least {n} turns after it.",
  "own.revertOps.stagedMore": "Restore pending: rewound at least {turns} turns after this message and {files} file changes",
})
