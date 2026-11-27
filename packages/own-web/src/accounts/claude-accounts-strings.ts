// Strings of the Claude subscription accounts on the 계정 page and in the Claude Agent card (02 §8.7, §8.10): only the
// lazy accounts chunk reads them, so they stay out of the first chunk (PF5, side-question round 2026-11-23). Same keys
// as before in src/i18n; Korean is the fallback for a missing English one.
import { featureText } from "@/queue/text"

export const claudeAccountsKo = {
  "own.claude.accounts.add": "Claude 계정 추가",
  "own.claude.accounts.addBody":
    "PC에 열린 창에서 Claude Code 로그인이 시작돼요. 브라우저에서 로그인만 마치세요. 앱은 비밀번호나 토큰을 보지 않아요.",
  "own.claude.accounts.start": "로그인 시작",
  "own.claude.accounts.waiting": "로그인 기다리는 중… (창을 닫으면 취소돼요)",
  "own.claude.accounts.added": "추가했어요: {label}",
  "own.claude.accounts.duplicate": "이미 추가된 계정이에요.",
  "own.claude.accounts.failed": "로그인하지 않고 창이 닫혔어요. 다시 시도하세요.",
  "own.claude.accounts.timeout": "10분 안에 로그인이 끝나지 않아 창을 닫았어요. 다시 시도하세요.",
  "own.claude.accounts.cliMissing":
    "Claude Code가 설치되어 있지 않아요. PowerShell에서 직접 설치한 뒤 다시 누르세요: irm https://claude.ai/install.ps1 | iex (또는 npm install -g @anthropic-ai/claude-code)",
  "own.claude.accounts.pcOnly": "로그인 추가는 이 PC의 창에서만 할 수 있어요.",
  "own.claude.accounts.import": "이 PC의 기존 Claude Code 로그인 가져오기",
  "own.claude.accounts.found": "찾은 로그인: {email} ({folder})",
  "own.claude.accounts.notFound": "이 PC에서 Claude Code 로그인을 찾지 못했어요. 먼저 Claude Code에 로그인하세요.",
  "own.claude.accounts.default": "기본",
  "own.claude.accounts.makeDefault": "새 대화의 기본으로",
  "own.claude.accounts.needsLogin": "이 계정의 로그인이 없거나 만료됐어요 — [다시 로그인]을 누르세요.",
  "own.claude.accounts.remove": "계정 빼기…",
  "own.claude.accounts.removeTitle": "Claude 계정 빼기: {account}",
  "own.claude.accounts.removeSessions": "이 계정을 쓰는 대화 {n}개는 기본 계정으로 옮겨져요(캐시는 새로 쌓여요).",
  "own.claude.accounts.removeNone": "이 계정을 쓰는 대화가 없어요.",
  "own.claude.accounts.removeFolder": "로그인 폴더도 지우기",
  "own.claude.accounts.removeConfirm": "빼기",
  "own.claude.accounts.relogin": "다시 로그인",
  "own.claude.accounts.reloginTitle": "다시 로그인: {account}",
  "own.claude.accounts.reloginBody":
    "PC에 열린 창에서 이 계정의 Claude Code 로그인을 다시 해요. 브라우저에서 로그인만 마치세요. 앱은 비밀번호나 토큰을 보지 않아요.",
  "own.claude.accounts.relogged": "다시 로그인했어요: {label}",
} as const satisfies Record<string, string>

export type ClaudeAccountsKey = keyof typeof claudeAccountsKo

export const claudeAccountsEn: Partial<Record<ClaudeAccountsKey, string>> = {
  "own.claude.accounts.relogin": "Sign in again",
  "own.claude.accounts.reloginTitle": "Sign in again: {account}",
  "own.claude.accounts.reloginBody":
    "A window on this PC runs Claude Code's sign-in for this account again. Finish signing in in the browser; the app never sees a password or a token.",
  "own.claude.accounts.relogged": "Signed in again: {label}",
  "own.claude.accounts.add": "Add Claude account",
  "own.claude.accounts.addBody":
    "A window on this PC starts Claude Code's sign-in. Just finish signing in in the browser; the app never sees a password or a token.",
  "own.claude.accounts.start": "Start sign-in",
  "own.claude.accounts.waiting": "Waiting for the sign-in… (closing the window cancels it)",
  "own.claude.accounts.added": "Added: {label}",
  "own.claude.accounts.duplicate": "This account is already added.",
  "own.claude.accounts.failed": "The window closed without a sign-in. Try again.",
  "own.claude.accounts.timeout": "The sign-in did not finish within 10 minutes, so the window was closed. Try again.",
  "own.claude.accounts.cliMissing":
    "Claude Code is not installed. Install it yourself in PowerShell and press again: irm https://claude.ai/install.ps1 | iex (or npm install -g @anthropic-ai/claude-code)",
  "own.claude.accounts.pcOnly": "Sign-ins can be added only in a window of this PC.",
  "own.claude.accounts.import": "Import this PC's existing Claude Code sign-in",
  "own.claude.accounts.found": "Sign-in found: {email} ({folder})",
  "own.claude.accounts.notFound": "No Claude Code sign-in found on this PC. Sign in to Claude Code first.",
  "own.claude.accounts.default": "Default",
  "own.claude.accounts.makeDefault": "Default for new conversations",
  "own.claude.accounts.needsLogin": "This account's sign-in is missing or expired. Press [Sign in again].",
  "own.claude.accounts.remove": "Remove account…",
  "own.claude.accounts.removeTitle": "Remove Claude account: {account}",
  "own.claude.accounts.removeSessions":
    "Conversations that use this account ({n}) move to the default account (the cache is written again).",
  "own.claude.accounts.removeNone": "No conversation uses this account.",
  "own.claude.accounts.removeFolder": "Delete the sign-in folder too",
  "own.claude.accounts.removeConfirm": "Remove",
}

export const claudeAccountsText = featureText(claudeAccountsKo, claudeAccountsEn)
