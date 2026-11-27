// Terminal strings (03 §18.6, §11 터미널, §4.7.3). The four keys 03 §14 already defines (`own.terminal.new`,
// `own.terminal.reconnecting`, `own.terminal.exited`, `own.terminal.copyOutput`) and `own.panel.terminal` come from the
// shared catalog through `useI18n().t`. The keys below are new; they stay in this folder while other modules append to
// the shared catalogs and can move verbatim into src/i18n/ko.ts / en.ts (append-only section "terminal").
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const terminalKo = {
  "own.terminal.tabs": "터미널 탭",
  "own.terminal.label": "{shell} · {folder}",
  "own.terminal.labelNumbered": "{shell} · {folder} ({n})",
  "own.terminal.close": "터미널 닫기",
  "own.terminal.restart": "다시 시작",
  "own.terminal.viewText": "출력을 텍스트로 보기",
  "own.terminal.textTitle": "터미널 출력 (마지막 {n}줄)",
  "own.terminal.textClose": "텍스트 보기 닫기",
  "own.terminal.textEmpty": "아직 출력이 없어요",
  "own.terminal.copied": "출력을 복사했어요",
  "own.terminal.copyFailed": "복사하지 못했어요",
  "own.terminal.shellMenu": "셸 선택",
  "own.terminal.shellDefault": "기본 셸",
  "own.terminal.shellLoading": "셸 목록을 불러오는 중…",
  "own.terminal.shellNone": "찾은 셸이 없어요",
  "own.terminal.loading": "터미널을 여는 중…",
  "own.terminal.noLocation": "대화나 프로젝트를 열면 그 폴더에서 터미널을 쓸 수 있어요.",
  "own.terminal.empty": "열린 터미널이 없어요.",
  "own.terminal.createFailed": "터미널을 만들지 못했어요: {message}",
  "own.terminal.connectFailed": "터미널에 연결하지 못했어요. 다시 시작하면 새 셸을 열어요.",
  "own.terminal.removed": "서버에서 이 터미널이 사라졌어요.",
  "own.terminal.exitedUnknown": "종료됨",
  "own.terminal.screenLabel": "터미널 {name}",
  "own.terminal.screenNote": "화면 읽기 프로그램은 터미널 화면을 읽지 못해요. ‘출력을 텍스트로 보기’를 쓰세요.",
  "own.terminal.running": "실행 중인 터미널 {n}개",
  "own.terminal.dock": "터미널 (대화 아래)",
  "own.terminal.dockResize": "터미널 높이 조절",
  "own.terminal.dockCollapse": "터미널 접기",
} as const satisfies Record<string, string>

export type TerminalKey = keyof typeof terminalKo

export const terminalEn: Partial<Record<TerminalKey, string>> = {
  "own.terminal.tabs": "Terminal tabs",
  "own.terminal.close": "Close terminal",
  "own.terminal.restart": "Restart",
  "own.terminal.viewText": "View output as text",
  "own.terminal.textTitle": "Terminal output (last {n} lines)",
  "own.terminal.textClose": "Close text view",
  "own.terminal.textEmpty": "No output yet",
  "own.terminal.copied": "Output copied",
  "own.terminal.copyFailed": "Could not copy",
  "own.terminal.shellMenu": "Choose shell",
  "own.terminal.shellDefault": "Default shell",
  "own.terminal.shellLoading": "Loading shells…",
  "own.terminal.shellNone": "No shells found",
  "own.terminal.loading": "Opening the terminal…",
  "own.terminal.noLocation": "Open a session or a project to use a terminal in its folder.",
  "own.terminal.empty": "No open terminals.",
  "own.terminal.createFailed": "Could not create the terminal: {message}",
  "own.terminal.connectFailed": "Could not connect to the terminal. Restart opens a new shell.",
  "own.terminal.removed": "This terminal is gone from the server.",
  "own.terminal.exitedUnknown": "Exited",
  "own.terminal.screenLabel": "Terminal {name}",
  "own.terminal.screenNote": "Screen readers cannot read the terminal canvas. Use “View output as text”.",
  "own.terminal.running": "{n} running terminals",
  "own.terminal.dock": "Terminal (below the conversation)",
  "own.terminal.dockResize": "Resize the terminal",
  "own.terminal.dockCollapse": "Collapse the terminal",
}

const catalogs: Record<Locale, Partial<Record<TerminalKey, string>>> = { ko: terminalKo, en: terminalEn }

/** Same rules as `translate` in src/i18n: current locale, Korean fallback, `{name}` params, Korean particles. */
export function terminalText(locale: Locale, key: TerminalKey, params?: I18nParams) {
  const template = catalogs[locale][key] ?? terminalKo[key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

export type TerminalText = (key: TerminalKey, params?: I18nParams) => string

export function useTerminalText(): TerminalText {
  const i18n = useI18n()
  return (key, params) => terminalText(i18n.locale(), key, params)
}
