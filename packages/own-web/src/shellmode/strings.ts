// Shell mode strings (03 §4.6, §19.9), `own.shellmode.*`, ready to move into ko.ts/en.ts (section "shellmode"). The
// placeholders (`own.sendKey.placeholderShell` with the send key, `own.composer.placeholderShell` on touch screens) and
// the toolbar tag (`own.composer.shellMode`) are 03 §14 keys.
import { featureText } from "@/history/text"

export const shellModeKo = {
  "own.shellmode.running": "셸 실행 중",
  "own.shellmode.runningMore": "외 {n}개",
  "own.shellmode.hint": "결과는 대화에 기록되고 에이전트는 다음 메시지를 보낼 때 봐요 · Esc로 나가기",
  "own.shellmode.failed": "셸 명령을 실행하지 못했어요",
  "own.shellmode.unavailable": "이 연결에서는 셸 명령을 실행할 수 없어요",
  "own.shellmode.enter": "셸 모드",
} as const satisfies Record<string, string>

export type ShellModeKey = keyof typeof shellModeKo

export const shellModeEn: Partial<Record<ShellModeKey, string>> = {
  "own.shellmode.running": "Running",
  "own.shellmode.runningMore": "+{n} more",
  "own.shellmode.hint":
    "The output is recorded in the conversation; the agent sees it with your next message · Esc to leave",
  "own.shellmode.failed": "Could not run the shell command",
  "own.shellmode.unavailable": "Shell commands are not available on this connection",
  "own.shellmode.enter": "Shell mode",
}

const catalog = featureText(shellModeKo, shellModeEn)
export const shellModeText = catalog.text
export const useShellModeText = catalog.use
