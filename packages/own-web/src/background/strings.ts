// Background job strings (03 §19.7, §9 "백그라운드 작업 끝남") of the first chunk: the dock row, the tool-card button
// and the finish toast. The list and the output viewer keep theirs in view-strings.ts (lazy with them). Kept in this
// folder so the module does not edit the shared catalogs; keys use the `own.background.*` namespace and can move
// verbatim into src/i18n/ko.ts / en.ts (append-only section "background"). Same `t()` rules through `featureText`.
import { featureText } from "@/queue/text"

export const backgroundKo = {
  "own.background.row": "백그라운드 {n}",
  "own.background.rowLabel": "백그라운드 작업 {n}개",
  "own.background.list": "백그라운드 작업",
  "own.background.show": "목록 보기",
  "own.background.hide": "목록 접기",
  "own.background.kind.shell": "셸",
  "own.background.output": "출력 보기",
  "own.background.send": "백그라운드로",
  "own.background.sendTitle": "실행 중인 셸·하위 에이전트를 백그라운드로 보내요 ({key})",
  "own.background.sendFailed": "백그라운드로 보내지 못했어요: {reason}",
  "own.background.running": "실행 중: {label}",
  "own.background.more": "{n}개 더",
  "own.background.done.shell": "{label} — 끝났어요 (exit {code})",
  "own.background.done.shellNoCode": "{label} — 끝났어요",
  "own.background.done.killed": "{label} — 종료됨",
  "own.background.done.timeout": "{label} — 시간 초과로 멈췄어요",
  "own.background.done.subagent": "{label} — 하위 에이전트가 끝났어요",
  "own.background.done.subagentFailed": "{label} — 하위 에이전트가 실패했어요",
  "own.background.done.openChild": "열기",
  // Session header running menu (03 §4.4, upstream 3a861ff8b0, b9db2f6915).
  "own.background.running.working": "작업 중 {n}",
  "own.background.running.running": "실행 중 {n}",
  "own.background.running.moreWorking": "그 밖에 작업 중 {n}",
  "own.background.running.moreRunning": "그 밖에 실행 중 {n}",
  "own.background.running.menu": "실행 중인 하위 에이전트와 셸",
  "own.background.running.subagent": "하위 에이전트",
  "own.background.running.here": "보고 있음",
  "own.background.running.stopSubagent": "하위 에이전트 중단",
  "own.background.running.stopShell": "셸 명령 종료",
  "own.background.running.stopFailed": "멈추지 못했어요: {reason}",
} as const satisfies Record<string, string>

export type BackgroundKey = keyof typeof backgroundKo

export const backgroundEn: Partial<Record<BackgroundKey, string>> = {
  "own.background.row": "Background {n}",
  "own.background.rowLabel": "{n} background jobs",
  "own.background.list": "Background jobs",
  "own.background.show": "Show list",
  "own.background.hide": "Hide list",
  "own.background.kind.shell": "Shell",
  "own.background.output": "View output",
  "own.background.send": "To background",
  "own.background.sendTitle": "Move the running shell or subagent to the background ({key})",
  "own.background.sendFailed": "Could not move it to the background: {reason}",
  "own.background.running": "Running: {label}",
  "own.background.more": "{n} more",
  "own.background.done.shell": "{label} — finished (exit {code})",
  "own.background.done.shellNoCode": "{label} — finished",
  "own.background.done.killed": "{label} — stopped",
  "own.background.done.timeout": "{label} — timed out",
  "own.background.done.subagent": "{label} — subagent finished",
  "own.background.done.subagentFailed": "{label} — subagent failed",
  "own.background.done.openChild": "Open",
  "own.background.running.working": "{n} working",
  "own.background.running.running": "{n} running",
  "own.background.running.moreWorking": "+{n} working",
  "own.background.running.moreRunning": "+{n} running",
  "own.background.running.menu": "Running subagents and shells",
  "own.background.running.subagent": "Subagent",
  "own.background.running.here": "Viewing",
  "own.background.running.stopSubagent": "Interrupt subagent",
  "own.background.running.stopShell": "Kill shell command",
  "own.background.running.stopFailed": "Could not stop it: {reason}",
}

export const backgroundText = featureText(backgroundKo, backgroundEn)
export const useBackgroundText = backgroundText.use
