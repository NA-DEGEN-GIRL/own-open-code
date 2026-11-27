// Claude Code's own login on a Claude card (02 §8.7 CS, 2026-10-22): any account on a login Claude Code uses
// (`claude.shared`: `%USERPROFILE%\.claude`, the account source's folder, or a junction or link to one) is read only,
// stops at every token expiry until Claude Code refreshed it (an idle Claude Code does on its next request, so the
// remedy is one request there, never waiting), and `own 전용 로그인으로 바꾸기` moves it to a login of its own (the real
// fix). On the lazy accounts page, so none of it is in the first chunk (PF5).
import { featureText } from "@/queue/text"

export const claudeSharedKo = {
  "own.claude.shared.note":
    "Claude Code가 쉬고 있으면 몇 시간마다 멈춰요 · own 전용 로그인으로 바꾸면 own이 직접 갱신해요",
  "own.claude.shared.stale":
    "{account}(은)는 Claude Code와 같은 로그인을 쓰는데, 그 로그인이 만료돼 멈췄어요. Claude Code에서 요청을 한 번 보내면 Claude Code가 새로 고쳐서 다시 돼요. 멈추지 않게 하려면 own 전용 로그인으로 바꾸세요. Claude Code도 로그아웃됐다면 Claude Code에서 /login을 하세요.",
  "own.claude.shared.move": "own 전용 로그인으로 바꾸기",
  "own.claude.shared.moveTitle": "own 전용 로그인으로 바꾸기: {account}",
  "own.claude.shared.moveBody":
    "{account}(은)는 Claude Code의 로그인({folder})을 함께 써서 이 앱이 새로 고치지 않아요. 이 앱 전용 폴더에 같은 Claude 계정으로 따로 로그인하면 이 앱이 새로 고쳐요. 이름, 색, 대화, 기록은 그대로예요. Claude Code의 로그인은 건드리지 않아요.",
  "own.claude.shared.moved": "own 전용 로그인으로 바꿨어요: {label}",
  "own.claude.shared.mismatch":
    "다른 Claude 계정으로 로그인했어요 · 같은 계정으로 다시 로그인하거나 계정을 새로 추가하세요",
  "own.claude.shared.addNew": "새 계정으로 추가",
} as const satisfies Record<string, string>

export type ClaudeSharedKey = keyof typeof claudeSharedKo

export const claudeSharedEn: Partial<Record<ClaudeSharedKey, string>> = {
  "own.claude.shared.note":
    "Stops every few hours while Claude Code is idle · an own sign-in is refreshed by this app itself",
  "own.claude.shared.stale":
    "{account} shares Claude Code's sign-in, which expired, so it stopped. Send one request in Claude Code and Claude Code refreshes it. To stop depending on it, switch to an own sign-in. If Claude Code was signed out too, run /login in Claude Code.",
  "own.claude.shared.move": "Switch to an own sign-in",
  "own.claude.shared.moveTitle": "Switch to an own sign-in: {account}",
  "own.claude.shared.moveBody":
    "{account} shares Claude Code's sign-in ({folder}), so this app never refreshes it. Sign in with the same Claude account into a folder of this app's own and this app refreshes it. Name, color, conversations and history stay; Claude Code's sign-in is left alone.",
  "own.claude.shared.moved": "Switched to an own sign-in: {label}",
  "own.claude.shared.mismatch":
    "You signed in with another Claude account · sign in again with the same account, or add it as a new account",
  "own.claude.shared.addNew": "Add as a new account",
}

export const claudeSharedText = featureText(claudeSharedKo, claudeSharedEn)
export const useClaudeSharedText = claudeSharedText.use
