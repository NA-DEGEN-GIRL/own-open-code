// Strings of the worktree popover and dialogs (03 §19.3), lazy with them; the first-chunk ones are in strings.ts and
// are included here, so a lazy view needs one hook. Same namespace and rules (`own.worktree.*`, ko + en).
import { featureText } from "@/queue/text"
import { worktreeEn, worktreeKo } from "./strings"

export const worktreePanelKo = {
  "own.worktree.localHint": "프로젝트 폴더에서 바로 작업해요",
  "own.worktree.homeHint": "팀 메인이 일하는 폴더에서 바로 작업해요",
  "own.worktree.newHint": "작업 사본을 새로 만들어 거기서 시작해요 (기본 위치: 프로젝트 안 .worktrees 폴더)",
  "own.worktree.existing": "기존 작업 폴더",
  "own.worktree.existingHint": "이미 만든 작업 폴더에서 시작해요",
  "own.worktree.base": "기준 브랜치",
  "own.worktree.baseSearch": "브랜치 검색",
  "own.worktree.baseDefault": "현재 브랜치 ({branch})",
  "own.worktree.baseHead": "현재 커밋",
  "own.worktree.baseNone": "맞는 브랜치가 없어요",
  "own.worktree.script": "시작 스크립트",
  "own.worktree.scriptHint":
    "이 프로젝트에 새 작업 폴더를 만들 때마다 그 폴더에서 실행해요. 모든 새 작업 폴더에 적용돼요.",
  "own.worktree.scriptPlaceholder": "예: bun install (비워 두면 실행하지 않음)",
  "own.worktree.scriptSave": "저장",
  "own.worktree.scriptSaved": "시작 스크립트를 저장했어요",
  "own.worktree.scriptFailed": "시작 스크립트를 저장하지 못했어요: {reason}",
  "own.worktree.none": "아직 작업 폴더가 없어요",
  "own.worktree.refresh": "목록 새로 고침",
  "own.worktree.refreshing": "찾는 중…",
  "own.worktree.loadFailed": "작업 폴더 목록을 읽지 못했어요: {reason}",
  "own.worktree.cleanup": "정리…",
  "own.worktree.cleanupNamed": "작업 폴더 {name} 정리",
  "own.worktree.sessions": "대화 {n}",
  "own.worktree.move.title": "다른 작업 폴더로 옮기기",
  "own.worktree.move.body": "대화의 작업 폴더를 바꿔요. 대화, 모델 @ 계정, 승인 모드는 그대로예요.",
  "own.worktree.move.current": "지금 위치",
  "own.worktree.move.createNew": "새 작업 폴더를 만들고 옮기기",
  "own.worktree.move.when": "옮기는 시점",
  "own.worktree.move.steer": "현재 단계가 끝나면",
  "own.worktree.move.queue": "현재 턴이 끝나면",
  "own.worktree.move.cache":
    "앞부분 캐시는 그대로 써요. 새 폴더의 지시문(AGENTS.md 등)이 다르면 다음 요청 끝에 변경분이 더해져요.",
  "own.worktree.move.shells": "실행 중인 셸 {n}개는 원래 폴더에서 계속 실행돼요.",
  "own.worktree.move.confirm": "옮기기",
  "own.worktree.move.working": "옮기는 중…",
  "own.worktree.move.cancel": "취소",
  "own.worktree.move.requested": "현재 단계가 끝나면 {name}(으)로 옮겨요",
  "own.worktree.move.requestedTurn": "현재 턴이 끝나면 {name}(으)로 옮겨요",
  "own.worktree.move.done": "{name}(으)로 옮겼어요",
  "own.worktree.move.failed": "옮기지 못했어요: {reason}",
  "own.worktree.move.none": "옮길 수 있는 다른 위치가 없어요. 새 작업 폴더를 만들어 옮길 수 있어요.",
  "own.worktree.remove.title": "작업 폴더 정리",
  "own.worktree.remove.body": "이 작업 폴더와 그 안의 작업 사본을 지워요. 저장소의 브랜치와 커밋은 남아요.",
  "own.worktree.remove.sessions":
    "이 작업 폴더에 대화 {n}개가 있어요. 정리하면 이 대화들은 폴더가 없어 이어서 작업할 수 없어요. 먼저 다른 위치로 옮기세요.",
  "own.worktree.remove.running": "이 작업 폴더에서 실행 중인 대화가 있어요. 끝난 뒤에 정리하세요.",
  "own.worktree.remove.dirty":
    "커밋하지 않은 변경이나 추적하지 않는 파일이 있어요. 강제로 정리하면 그 변경이 사라져요.",
  "own.worktree.remove.command": "실행할 동작: {command}",
  "own.worktree.remove.confirm": "정리",
  "own.worktree.remove.force": "강제로 정리",
  "own.worktree.remove.working": "정리하는 중…",
  "own.worktree.remove.done": "작업 폴더 {name}(을)를 정리했어요",
  "own.worktree.remove.failed": "정리하지 못했어요: {reason}",
  "own.worktree.remove.cancel": "취소",
  "own.worktree.remove.inspecting": "폴더 안을 살피는 중…",
  "own.worktree.remove.inspectFailed": "폴더 안을 살피지 못해 정리할 수 없어요: {reason}",
  "own.worktree.remove.noRoot": "프로젝트 폴더를 알 수 없어요",
  "own.worktree.remove.retry": "다시 살피기",
  "own.worktree.remove.nested":
    "다른 저장소가 들어 있어요(저장하지 않은 작업이 있을 수 있음). 정리하면 그 작업까지 지워지므로 정리할 수 없어요.",
  "own.worktree.remove.nestedWorktree": "작업 폴더",
  "own.worktree.remove.nestedRepository": "저장소",
  "own.worktree.remove.ownLock":
    "팀 모드가 잠근 폴더예요({reason}). 여기서는 정리하지 않아요. 팀 화면에서 영역을 끝내면 팀 모드가 안전하게 정리해요.",
  "own.worktree.remove.locked": "잠긴 작업 폴더예요. 잠금을 풀기 전에는 git이 정리를 거절해요.",
  "own.worktree.remove.lockedReason": "잠긴 작업 폴더예요({reason}). 잠금을 풀기 전에는 git이 정리를 거절해요.",
  "own.worktree.remove.ignored":
    "git이 무시하는 항목 {n}개({size})도 함께 지워져요. 다시 만들 수 없는 파일이 없는지 확인하세요.",
  "own.worktree.remove.ignoredMore": "외 {n}개",
  "own.worktree.remove.partial":
    "폴더가 커서 끝까지 살피지 못했어요. 안에 다른 저장소가 없는지 확인할 수 없어 정리하지 않아요.",
  "own.worktree.remove.changed": "확인한 뒤로 폴더 안이 바뀌었어요. 바뀐 내용을 보고 다시 정리하세요.",
  "own.worktree.remove.confirmIgnored": "무시된 파일 {size}까지 정리",
  "own.worktree.remove.forceIgnored": "무시된 파일 {size}까지 강제로 정리",
} as const satisfies Record<string, string>

export type WorktreePanelKey = keyof typeof worktreePanelKo

export const worktreePanelEn: Partial<Record<WorktreePanelKey, string>> = {
  "own.worktree.localHint": "Work directly in the project folder",
  "own.worktree.homeHint": "Work directly in the folder the team main works in",
  "own.worktree.newHint": "Create a working copy and start there (by default in the project's .worktrees folder)",
  "own.worktree.existing": "Existing worktree",
  "own.worktree.existingHint": "Start in a worktree you already made",
  "own.worktree.base": "Base branch",
  "own.worktree.baseSearch": "Search branches",
  "own.worktree.baseDefault": "Current branch ({branch})",
  "own.worktree.baseHead": "Current commit",
  "own.worktree.baseNone": "No matching branch",
  "own.worktree.script": "Startup script",
  "own.worktree.scriptHint":
    "Runs in the new folder every time a worktree of this project is created. Applies to all new worktrees.",
  "own.worktree.scriptPlaceholder": "e.g. bun install (empty: nothing runs)",
  "own.worktree.scriptSave": "Save",
  "own.worktree.scriptSaved": "Startup script saved",
  "own.worktree.scriptFailed": "Could not save the startup script: {reason}",
  "own.worktree.none": "No worktrees yet",
  "own.worktree.refresh": "Refresh list",
  "own.worktree.refreshing": "Looking…",
  "own.worktree.loadFailed": "Could not read the worktrees: {reason}",
  "own.worktree.cleanup": "Clean up…",
  "own.worktree.cleanupNamed": "Clean up worktree {name}",
  "own.worktree.sessions": "{n} sessions",
  "own.worktree.move.title": "Move to another worktree",
  "own.worktree.move.body":
    "Changes the session's working folder. The conversation, model @ account and approval mode stay.",
  "own.worktree.move.current": "Current",
  "own.worktree.move.createNew": "Create a new worktree and move there",
  "own.worktree.move.when": "When to move",
  "own.worktree.move.steer": "After the current step",
  "own.worktree.move.queue": "After the current turn",
  "own.worktree.move.cache":
    "The cached beginning stays. If the new folder's instructions (AGENTS.md…) differ, the change is appended to the next request.",
  "own.worktree.move.shells": "{n} running shells keep running in the old folder.",
  "own.worktree.move.confirm": "Move",
  "own.worktree.move.working": "Moving…",
  "own.worktree.move.cancel": "Cancel",
  "own.worktree.move.requested": "Moves to {name} after the current step",
  "own.worktree.move.requestedTurn": "Moves to {name} after the current turn",
  "own.worktree.move.done": "Moved to {name}",
  "own.worktree.move.failed": "Could not move: {reason}",
  "own.worktree.move.none": "There is no other location. You can create a new worktree and move there.",
  "own.worktree.remove.title": "Clean up worktree",
  "own.worktree.remove.body":
    "Deletes this work folder and its working copy. Branches and commits stay in the repository.",
  "own.worktree.remove.sessions":
    "{n} sessions are in this worktree. After the cleanup they cannot continue (their folder is gone). Move them first.",
  "own.worktree.remove.running": "A session in this worktree is running. Clean up after it finished.",
  "own.worktree.remove.dirty": "There are uncommitted changes or untracked files. Forcing the cleanup loses them.",
  "own.worktree.remove.command": "Runs: {command}",
  "own.worktree.remove.confirm": "Clean up",
  "own.worktree.remove.force": "Force clean up",
  "own.worktree.remove.working": "Cleaning up…",
  "own.worktree.remove.done": "Cleaned up worktree {name}",
  "own.worktree.remove.failed": "Could not clean up: {reason}",
  "own.worktree.remove.cancel": "Cancel",
  "own.worktree.remove.inspecting": "Looking inside the folder…",
  "own.worktree.remove.inspectFailed": "Could not look inside the folder, so it cannot be cleaned up: {reason}",
  "own.worktree.remove.noRoot": "the project folder is unknown",
  "own.worktree.remove.retry": "Look again",
  "own.worktree.remove.nested":
    "It contains another repository (it may hold unsaved work). Cleaning up would delete that work too, so it cannot be cleaned up.",
  "own.worktree.remove.nestedWorktree": "worktree",
  "own.worktree.remove.nestedRepository": "repository",
  "own.worktree.remove.ownLock":
    "Team mode locked this folder ({reason}). It is not cleaned up here: finish the area in the team view and team mode cleans it up safely.",
  "own.worktree.remove.locked": "This worktree is locked. Git refuses to clean it up until it is unlocked.",
  "own.worktree.remove.lockedReason":
    "This worktree is locked ({reason}). Git refuses to clean it up until it is unlocked.",
  "own.worktree.remove.ignored":
    "{n} items Git ignores ({size}) are deleted too. Check that none of them is irreplaceable.",
  "own.worktree.remove.ignoredMore": "{n} more",
  "own.worktree.remove.partial":
    "The folder is too big to look through completely: another repository inside cannot be ruled out, so it is not cleaned up.",
  "own.worktree.remove.changed": "The folder changed after you confirmed. Check what changed and clean up again.",
  "own.worktree.remove.confirmIgnored": "Clean up with {size} of ignored files",
  "own.worktree.remove.forceIgnored": "Force clean up with {size} of ignored files",
}

export const worktreePanelText = featureText(
  { ...worktreeKo, ...worktreePanelKo },
  { ...worktreeEn, ...worktreePanelEn },
)
export const useWorktreePanelText = worktreePanelText.use
