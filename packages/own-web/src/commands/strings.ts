// Slash command strings (03 §18.13). Kept in this folder so the module does not edit the shared catalogs; the keys
// use the `own.command.*` namespace and can move verbatim into src/i18n/ko.ts / en.ts (append-only section
// "commands"). Label decision (18.7): the revert verb is `복원`; `되돌리기` stays reserved for `switch.undo`.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const commandKo = {
  "own.command.group.server": "서버 명령",
  "own.command.group.client": "클라이언트 명령",
  "own.command.badge.mcp": "MCP",
  "own.command.badge.custom": "사용자",
  "own.command.hint": "인자: {hint}",
  "own.command.new": "새 대화",
  "own.command.compact": "지금 압축 — 대화를 요약해 문맥을 줄여요",
  "own.command.fork": "이 지점에서 포크 — 새 대화에서 이어 가요",
  "own.command.undo": "마지막 턴 복원(파일 포함)",
  "own.command.redo": "복원 취소",
  "own.command.export": "대화 내보내기(JSON)",
  "own.command.model": "모델 @ 계정 전환기",
  "own.command.agent": "에이전트 바꾸기",
  "own.command.skills": "스킬 목록 — 고르면 칩으로 넣어요",
  "own.command.terminal": "터미널 열기",
  "own.command.review": "리뷰 탭 열기",
  "own.command.reviewServer": "변경 리뷰 — 커밋하지 않은 변경이 기본, 뒤에 commit·branch·pr",
  "own.command.init": "AGENTS.md 안내 설정",
  "own.command.goal": "목표 — 이룰 때까지 이어서 일해요 · 뒤에 pause·resume·clear",
  "own.command.goalCodex": "Codex 목표 — Codex 방식으로 이룰 때까지 이어서 일해요 · 뒤에 pause·resume·clear",
  "own.command.group.agents": "에이전트",
  "own.command.agentNote": "에이전트마다 도구 권한이 달라 다음 요청에서 캐시를 새로 쓸 수 있어요",
  "own.command.agentCurrent": "지금",
  "own.command.group.skills": "스킬",
  "own.command.needsSession": "대화를 연 뒤에 쓸 수 있는 명령이에요",
  "own.command.failed": "/{name}(을)를 실행하지 못했어요",
  "own.command.sent": "/{name}(을)를 보냈어요",
  "own.command.compactRequested": "압축을 요청했어요",
  "own.command.compactRevert": "복원 대기 중 — 압축하면 복원이 확정돼요",
  "own.command.compactAnyway": "그래도 압축",
  "own.command.forked": "포크한 대화로 옮겼어요",
  "own.command.exported": "내보냈어요: {file}",
  "own.command.undone": "마지막 턴을 복원했어요 · 다음 요청은 캐시를 처음부터 다시 쓸 수 있어요",
  "own.command.undoRunning": "실행 중이에요 — 중단하고 마지막 턴을 복원할까요?",
  "own.command.undoInterrupt": "중단하고 복원",
  "own.command.nothingToUndo": "복원할 턴이 없어요",
  "own.command.redone": "복원을 취소했어요",
  "own.command.noRevert": "복원 대기 중인 턴이 없어요",
  "own.command.agentSwitched": "에이전트를 {agent}(으)로 바꿨어요",
  "own.command.agentUnknown": "에이전트 {agent}(을)를 찾지 못했어요",
  "own.command.agentSame": "이미 {agent} 에이전트예요",
} as const satisfies Record<string, string>

export type CommandKey = keyof typeof commandKo

export const commandEn: Partial<Record<CommandKey, string>> = {
  "own.command.group.server": "Server commands",
  "own.command.group.client": "App commands",
  "own.command.badge.mcp": "MCP",
  "own.command.badge.custom": "Custom",
  "own.command.hint": "Arguments: {hint}",
  "own.command.new": "New session",
  "own.command.compact": "Compact now — summarize the conversation to shrink the context",
  "own.command.fork": "Fork here — continue in a new session",
  "own.command.undo": "Restore the last turn (with files)",
  "own.command.redo": "Cancel the restore",
  "own.command.export": "Export the session (JSON)",
  "own.command.model": "Model @ account switcher",
  "own.command.agent": "Change the agent",
  "own.command.skills": "Skills — pick one to add it as a chip",
  "own.command.terminal": "Open the terminal",
  "own.command.review": "Open the review tab",
  "own.command.reviewServer": "Review changes — uncommitted by default, or commit·branch·pr",
  "own.command.init": "Guided AGENTS.md setup",
  "own.command.goal": "Goal — keep working until it is met · then pause, resume or clear",
  "own.command.goalCodex": "Codex goal — keep working the Codex way until it is met · then pause, resume or clear",
  "own.command.group.agents": "Agents",
  "own.command.agentNote": "Agents differ in tool permissions, so the next request may rewrite the cache",
  "own.command.agentCurrent": "Current",
  "own.command.group.skills": "Skills",
  "own.command.needsSession": "Open a session to use this command",
  "own.command.failed": "Could not run /{name}",
  "own.command.sent": "Sent /{name}",
  "own.command.compactRequested": "Compaction requested",
  "own.command.compactRevert": "A restore is staged — compacting confirms it",
  "own.command.compactAnyway": "Compact anyway",
  "own.command.forked": "Moved to the forked session",
  "own.command.exported": "Exported: {file}",
  "own.command.undone": "Restored the last turn · the next request may rewrite the cache from the start",
  "own.command.undoRunning": "A turn is running — stop it and restore the last turn?",
  "own.command.undoInterrupt": "Stop and restore",
  "own.command.nothingToUndo": "No turn to restore",
  "own.command.redone": "Cancelled the restore",
  "own.command.noRevert": "No restore is staged",
  "own.command.agentSwitched": "Agent changed to {agent}",
  "own.command.agentUnknown": "No agent named {agent}",
  "own.command.agentSame": "Already on {agent}",
}

const catalogs: Record<Locale, Partial<Record<CommandKey, string>>> = { ko: commandKo, en: commandEn }

export function commandText(locale: Locale, key: CommandKey, params?: I18nParams) {
  const template = catalogs[locale][key] ?? commandKo[key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

export type CommandText = (key: CommandKey, params?: I18nParams) => string

export function useCommandText(): CommandText {
  const i18n = useI18n()
  return (key, params) => commandText(i18n.locale(), key, params)
}
