// Strings of the device viewer (05 §8.10), loaded with its lazy chunk. Sentences the desktop pane already has (the
// address field, the agent's actions, `이 대화는 브라우저 도구 없이 시작했어요`) come from ../strings.ts.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const remoteKo = {
  "own.remoteBrowser.title": "브라우저",
  "own.remoteBrowser.close": "브라우저 닫기",
  "own.remoteBrowser.menu": "보기 설정",
  "own.remoteBrowser.phone": "휴대폰 크기로 보기",
  "own.remoteBrowser.saver": "데이터 절약",
  "own.remoteBrowser.on": "✓ {label}",
  "own.remoteBrowser.tabs": "탭 {n}개",
  "own.remoteBrowser.tabsTitle": "탭",
  "own.remoteBrowser.tabsClose": "탭 목록 닫기",
  "own.remoteBrowser.keyboard": "키보드",
  "own.remoteBrowser.fit": "화면에 맞추기",
  "own.remoteBrowser.frame": "PC의 브라우저 화면",
  "own.remoteBrowser.noPermission":
    "이 기기에서는 브라우저를 볼 수 없어요. PC의 설정 > 휴대폰·다른 PC에서 이 기기의 ‘브라우저’를 켜 주세요.",
  "own.remoteBrowser.noPermissionPc":
    "이 기기에서는 브라우저를 볼 수 없어요. {pc}의 설정 > 휴대폰·다른 PC에서 이 기기의 ‘브라우저’를 켜 주세요.",
  "own.remoteBrowser.recheck": "다시 확인",
  "own.remoteBrowser.noSession": "브라우저는 대화마다 따로 있어요. 대화를 열면 여기서 볼 수 있어요.",
  "own.remoteBrowser.enableOnPc": "PC의 데스크톱 앱에서 켜 주세요.",
  "own.remoteBrowser.absent": "PC의 데스크톱 앱이 꺼져 있어요. PC에서 Own OpenCode를 열어 두면 여기서 볼 수 있어요.",
  "own.remoteBrowser.detached": "이 대화의 브라우저가 PC에서 열려 있지 않아요.",
  "own.remoteBrowser.emptyHint": "주소 칸에 주소나 검색어를 넣으면 새 탭으로 열려요.",
  "own.remoteBrowser.emptyWatch": "보기 전용이라 여기서 탭을 열 수 없어요.",
  "own.remoteBrowser.busy": "보는 화면이 너무 많아요. 다른 화면을 닫고 다시 열어 주세요.",
  "own.remoteBrowser.reconnecting": "다시 연결하는 중…",
  "own.remoteBrowser.watchOnly": "보기 전용이에요",
  "own.remoteBrowser.agentBlocked": "직접 조작하려면 ‘멈추고 직접 조작’을 누르세요",
  "own.remoteBrowser.failed.read_only": "보기 전용이라 조작할 수 없어요.",
  "own.remoteBrowser.failed.no_host": "PC의 브라우저에 닿지 않았어요.",
  "own.remoteBrowser.failed.timeout": "PC가 응답하지 않았어요.",
  "own.remoteBrowser.download": "파일을 받았어요. PC의 데스크톱 앱에서 저장할 수 있어요.",
  "own.remoteBrowser.fileChooser": "파일 선택은 PC에서 해 주세요.",
  "own.remoteBrowser.dialog.alert": "페이지의 알림",
  "own.remoteBrowser.dialog.confirm": "페이지의 확인",
  "own.remoteBrowser.dialog.prompt": "페이지의 입력 요청",
  "own.remoteBrowser.dialog.beforeunload": "이 페이지를 떠날까요?",
  "own.remoteBrowser.dialog.beforeunloadNote": "저장하지 않은 내용이 사라질 수 있어요.",
  "own.remoteBrowser.dialog.field": "입력",
  "own.remoteBrowser.dialog.ok": "확인",
  "own.remoteBrowser.dialog.cancel": "취소",
  "own.remoteBrowser.dialog.watch": "페이지가 대화상자를 열었어요. 보기 전용이라 여기서 답할 수 없어요.",
  "own.remoteBrowser.dialog.agent": "페이지가 대화상자를 열었어요. 에이전트가 조작 중이에요.",
}

export type RemoteKey = keyof typeof remoteKo

export const remoteEn: Record<RemoteKey, string> = {
  "own.remoteBrowser.title": "Browser",
  "own.remoteBrowser.close": "Close the browser",
  "own.remoteBrowser.menu": "View options",
  "own.remoteBrowser.phone": "Show at phone size",
  "own.remoteBrowser.saver": "Data saver",
  "own.remoteBrowser.on": "✓ {label}",
  "own.remoteBrowser.tabs": "{n} tabs",
  "own.remoteBrowser.tabsTitle": "Tabs",
  "own.remoteBrowser.tabsClose": "Close the tab list",
  "own.remoteBrowser.keyboard": "Keyboard",
  "own.remoteBrowser.fit": "Fit to screen",
  "own.remoteBrowser.frame": "The browser on the PC",
  "own.remoteBrowser.noPermission":
    "This device may not see the browser. On the PC, turn ‘Browser’ on for this device in Settings > Phones and other PCs.",
  "own.remoteBrowser.noPermissionPc":
    "This device may not see the browser. On {pc}, turn ‘Browser’ on for this device in Settings > Phones and other PCs.",
  "own.remoteBrowser.recheck": "Check again",
  "own.remoteBrowser.noSession": "Each conversation has its own browser. Open a conversation to see it here.",
  "own.remoteBrowser.enableOnPc": "Turn it on in the desktop app on the PC.",
  "own.remoteBrowser.absent":
    "The desktop app is not running on the PC. Keep Own OpenCode open on the PC to see the browser here.",
  "own.remoteBrowser.detached": "This conversation's browser is not open on the PC.",
  "own.remoteBrowser.emptyHint": "Enter an address or search words in the address field to open a new tab.",
  "own.remoteBrowser.emptyWatch": "This device only watches, so it cannot open a tab here.",
  "own.remoteBrowser.busy": "Too many views are open. Close another one and open this again.",
  "own.remoteBrowser.reconnecting": "Reconnecting…",
  "own.remoteBrowser.watchOnly": "View only",
  "own.remoteBrowser.agentBlocked": "To take control, press ‘Stop and take over’",
  "own.remoteBrowser.failed.read_only": "This device only watches.",
  "own.remoteBrowser.failed.no_host": "The browser on the PC could not be reached.",
  "own.remoteBrowser.failed.timeout": "The PC did not answer.",
  "own.remoteBrowser.download": "A file was downloaded. Save it from the desktop app on the PC.",
  "own.remoteBrowser.fileChooser": "Choose files on the PC.",
  "own.remoteBrowser.dialog.alert": "Message from the page",
  "own.remoteBrowser.dialog.confirm": "The page asks",
  "own.remoteBrowser.dialog.prompt": "The page asks for text",
  "own.remoteBrowser.dialog.beforeunload": "Leave this page?",
  "own.remoteBrowser.dialog.beforeunloadNote": "Changes that were not saved may be lost.",
  "own.remoteBrowser.dialog.field": "Text",
  "own.remoteBrowser.dialog.ok": "OK",
  "own.remoteBrowser.dialog.cancel": "Cancel",
  "own.remoteBrowser.dialog.watch": "The page opened a dialog. This device only watches and cannot answer it.",
  "own.remoteBrowser.dialog.agent": "The page opened a dialog. The agent is operating the page.",
}

const catalogs: Record<Locale, Record<RemoteKey, string>> = { ko: remoteKo, en: remoteEn }

export function remoteText(locale: Locale, key: RemoteKey, params?: I18nParams) {
  const template = catalogs[locale][key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

export function useRemoteText() {
  const i18n = useI18n()
  return (key: RemoteKey, params?: I18nParams) => remoteText(i18n.locale(), key, params)
}
