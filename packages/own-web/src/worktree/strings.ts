// Worktree strings of the first chunk (03 §19.3, §5.1 "작업 위치", §4.3 `⑂` groups, §5.6 작업 위치): the selector
// button, the new-session toasts, and the labels other modules show (`⑂ {name}`, 작업 위치, the session `⋯` entry).
// The popover and the dialogs keep theirs in panel-strings.ts (lazy with them). Kept in this folder so the module does
// not edit the shared catalogs; keys use the `own.worktree.*` namespace and can move verbatim into src/i18n/ko.ts /
// en.ts (append-only section "worktree"). Same `t()` rules through `featureText`.
import { featureText } from "@/queue/text"

export const worktreeKo = {
  "own.worktree.place": "작업 위치",
  "own.worktree.buttonLabel": "작업 위치: {place}",
  "own.worktree.local": "프로젝트 폴더",
  // A project with a team on: its own checkout is where the team main works (06 §9.1).
  "own.worktree.home": "메인 폴더",
  "own.worktree.new": "새 작업 폴더",
  "own.worktree.newFrom": "새 작업 폴더 · {base}",
  "own.worktree.loading": "작업 폴더를 읽는 중…",
  "own.worktree.creating": "작업 폴더 만드는 중…",
  "own.worktree.creatingScript": "작업 폴더를 만들고 시작 스크립트를 실행하는 중…",
  "own.worktree.created": "작업 폴더 {name}(을)를 만들었어요",
  "own.worktree.createFailed": "작업 폴더를 만들지 못했어요: {reason}",
  "own.worktree.group": "⑂ {name}",
  "own.worktree.groupTitle": "작업 폴더 {name} · {path}",
  "own.worktree.where.local": "프로젝트 폴더",
  "own.worktree.where.worktree": "작업 폴더 {name}",
  "own.worktree.move.action": "다른 작업 폴더로 옮기기…",
  // 세션 폴더 없음 (03 §8, upstream 4fb800734d): a session whose folder is gone (404 LocationNotFoundError).
  "own.worktree.missing.title": "이 대화의 폴더가 없어요",
  "own.worktree.missing.body": "폴더를 지웠거나 옮긴 것 같아요. 다른 폴더를 고르면 이 대화를 그곳에서 이어 가요.",
  "own.worktree.missing.bodyWorktree":
    "폴더를 지웠거나 옮긴 것 같아요. 작업 위치를 고르면 이 대화를 그곳에서 이어 가요.",
  "own.worktree.missing.readOnly": "다른 폴더로 옮기는 일은 PC에서 할 수 있어요.",
  "own.worktree.missing.choose": "다른 폴더 고르기…",
  "own.worktree.missing.worktree": "작업 위치 고르기…",
  "own.worktree.missing.moving": "대화를 옮기는 중…",
  "own.worktree.missing.moved": "대화를 {name}(으)로 옮겼어요",
  "own.worktree.missing.moveFailed": "대화를 옮기지 못했어요: {reason}",
  "own.worktree.missing.send": "이 대화의 폴더가 없어 보내지 못했어요. 다른 폴더를 고르세요",
  "own.worktree.missing.sendWorktree": "이 대화의 폴더가 없어 보내지 못했어요. 작업 위치를 고르세요",
  "own.worktree.missing.sendReadOnly":
    "이 대화의 폴더가 없어 보내지 못했어요. 다른 폴더로 옮기는 일은 PC에서 할 수 있어요",
} as const satisfies Record<string, string>

export type WorktreeKey = keyof typeof worktreeKo

export const worktreeEn: Partial<Record<WorktreeKey, string>> = {
  "own.worktree.place": "Work location",
  "own.worktree.buttonLabel": "Work location: {place}",
  "own.worktree.local": "Project folder",
  "own.worktree.home": "Main folder",
  "own.worktree.new": "New worktree",
  "own.worktree.newFrom": "New worktree · {base}",
  "own.worktree.loading": "Reading worktrees…",
  "own.worktree.creating": "Creating worktree…",
  "own.worktree.creatingScript": "Creating the worktree and running the startup script…",
  "own.worktree.created": "Created worktree {name}",
  "own.worktree.createFailed": "Could not create the worktree: {reason}",
  "own.worktree.group": "⑂ {name}",
  "own.worktree.groupTitle": "Worktree {name} · {path}",
  "own.worktree.where.local": "Project folder",
  "own.worktree.where.worktree": "Worktree {name}",
  "own.worktree.move.action": "Move to another worktree…",
  "own.worktree.missing.title": "This session's folder is missing",
  "own.worktree.missing.body": "The folder was deleted or moved. Choose another folder to continue this session there.",
  "own.worktree.missing.bodyWorktree":
    "The folder was deleted or moved. Choose a work location to continue this session there.",
  "own.worktree.missing.readOnly": "Moving it to another folder can be done on the PC.",
  "own.worktree.missing.choose": "Choose another folder…",
  "own.worktree.missing.worktree": "Choose a work location…",
  "own.worktree.missing.moving": "Moving the session…",
  "own.worktree.missing.moved": "Moved the session to {name}",
  "own.worktree.missing.moveFailed": "Could not move the session: {reason}",
  "own.worktree.missing.send": "This session's folder is missing, so nothing was sent. Choose another folder",
  "own.worktree.missing.sendWorktree": "This session's folder is missing, so nothing was sent. Choose a work location",
  "own.worktree.missing.sendReadOnly":
    "This session's folder is missing, so nothing was sent. It can be moved to another folder on the PC",
}

export const worktreeText = featureText(worktreeKo, worktreeEn)
export const useWorktreeText = worktreeText.use
