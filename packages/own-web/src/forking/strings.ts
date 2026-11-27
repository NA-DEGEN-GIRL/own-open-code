// Fork and manual compaction strings (03 §19.12), `own.fork.*` and `own.compaction.*`, ready to move into ko.ts/en.ts
// (sections "fork", "compaction"). `지금 압축` (`own.ctx.compactNow`), the cache note (`own.ctx.cacheNote`) and the
// staged-revert warning (`own.compact.impactRevert`) are 03 §14 keys from the shared catalog.
import { featureText } from "@/history/text"

export const forkKo = {
  "own.fork.whole": "포크",
  "own.fork.fromMessage": "이 메시지에서 포크…",
  "own.fork.here": "여기서 포크",
  "own.fork.title": "메시지에서 포크",
  "own.fork.body":
    "고른 메시지 앞까지의 대화를 새 대화로 복제해요. 고른 메시지는 새 대화의 입력창에 들어가니 고쳐서 보내세요.",
  "own.fork.bodyWhole": "지금까지의 대화 전체를 새 대화로 복제해요.",
  "own.fork.cacheNote":
    "포크는 원 대화의 캐시 키를 물려받아요. 같은 계정·모델로 이어 가면 고른 지점까지의 앞부분을 캐시에서 읽어 싸요(추정).",
  "own.fork.cacheNow": "지금 {state}",
  "own.fork.otherAccount": "포크한 대화만 다른 계정으로 돌리면 원 대화의 캐시는 그대로 남아요(곁가지 포크).",
  "own.fork.running": "실행 중인 턴의 끝나지 않은 부분은 복제되지 않아요.",
  "own.fork.search": "메시지 검색",
  "own.fork.empty": "포크할 메시지가 없어요",
  "own.fork.noMatch": "일치하는 메시지가 없어요",
  "own.fork.loadMore": "이전 메시지 더 불러오기",
  "own.fork.loading": "불러오는 중…",
  "own.fork.pending": "대기 중",
  "own.fork.pendingNote": "아직 대기열에 있는 메시지에서는 포크할 수 없어요",
  "own.fork.attachments": "첨부 {n}",
  "own.fork.copyAll": "전체 복제",
  "own.fork.confirm": "여기서 포크",
  "own.fork.cancel": "취소",
  "own.fork.back": "목록으로",
  "own.fork.working": "포크하는 중…",
  "own.fork.done": "포크했어요 · 원 대화는 그대로예요",
  "own.fork.failed": "포크하지 못했어요: {reason}",
  "own.fork.keys": "↑↓ 고르기 · Enter 포크 · Esc 닫기",
  "own.compaction.running": "압축 중…",
  "own.compaction.requesting": "압축을 요청하는 중…",
  "own.compaction.queued": "압축 대기 중 · 다음 단계 전에 시작해요",
  "own.compaction.reason.manual": "수동",
  "own.compaction.reason.auto": "자동",
  "own.compaction.failed": "압축하지 못했어요",
  "own.compaction.requestFailed": "압축을 요청하지 못했어요",
  "own.compaction.retry": "다시 시도",
  "own.compaction.dismiss": "닫기",
  "own.compaction.anyway": "그대로 압축",
} as const satisfies Record<string, string>

export type ForkKey = keyof typeof forkKo

export const forkEn: Partial<Record<ForkKey, string>> = {
  "own.fork.whole": "Fork",
  "own.fork.fromMessage": "Fork from a message…",
  "own.fork.here": "Fork from here",
  "own.fork.title": "Fork from a message",
  "own.fork.body":
    "Copies the conversation before the chosen message into a new session. The chosen message goes into the new session's composer so you can edit and send it.",
  "own.fork.bodyWhole": "Copies the whole conversation into a new session.",
  "own.fork.cacheNote":
    "A fork inherits the original session's cache key. On the same account and model the prefix up to that point is read from the cache (estimate).",
  "own.fork.cacheNow": "Now {state}",
  "own.fork.otherAccount": "Switching only the fork to another account keeps the original session's cache (side fork).",
  "own.fork.running": "The unfinished part of the running turn is not copied.",
  "own.fork.search": "Search messages",
  "own.fork.empty": "No messages to fork from",
  "own.fork.noMatch": "No matching messages",
  "own.fork.loadMore": "Load earlier messages",
  "own.fork.loading": "Loading…",
  "own.fork.pending": "Queued",
  "own.fork.pendingNote": "A message still in the queue cannot be forked from",
  "own.fork.attachments": "{n} attachments",
  "own.fork.copyAll": "Copy all",
  "own.fork.confirm": "Fork from here",
  "own.fork.cancel": "Cancel",
  "own.fork.back": "Back to the list",
  "own.fork.working": "Forking…",
  "own.fork.done": "Forked · the original session is unchanged",
  "own.fork.failed": "Could not fork: {reason}",
  "own.fork.keys": "↑↓ choose · Enter fork · Esc close",
  "own.compaction.running": "Compacting…",
  "own.compaction.requesting": "Requesting compaction…",
  "own.compaction.queued": "Compaction waiting · starts before the next step",
  "own.compaction.reason.manual": "manual",
  "own.compaction.reason.auto": "auto",
  "own.compaction.failed": "Compaction failed",
  "own.compaction.requestFailed": "Could not request compaction",
  "own.compaction.retry": "Retry",
  "own.compaction.dismiss": "Dismiss",
  "own.compaction.anyway": "Compact anyway",
}

const catalog = featureText(forkKo, forkEn)
export const forkText = catalog.text
export const useForkText = catalog.use
