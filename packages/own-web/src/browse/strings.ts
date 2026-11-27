// 내 브라우저 사용 (BRW): the settings page's and the conversation dialog's words. A catalog of its own, so the page and
// the dialog load them with their chunks; the `⋯` item's label is in menu-strings.ts (the first chunk).
import { catalogText, useCatalogText } from "@/projects/text"

export const browseKo = {
  "own.browse.lead":
    "켜면 에이전트가 내 브라우저(Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium)의 탭을 열고 읽고 눌러요. 내 로그인과 확장 프로그램을 그대로 써요. OpenCode가 만든 Browse(MIT)를 써요.",
  "own.browse.toggle": "내 브라우저 사용 켜기",
  "own.browse.default": "기본은 꺼져 있어요. 켜도 대화마다 따로 켜야 그 대화에서만 써요.",
  "own.browse.on": "켰어요. 대화의 ⋯ > 이 대화에서 내 브라우저 사용에서 대화마다 켜 주세요.",
  "own.browse.off": "껐어요. 다음 요청부터 어느 대화에도 도구가 없어요.",
  "own.browse.readOnly": "이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
  "own.browse.unsupported": "이 서비스는 이 기능을 아직 몰라요. 서비스를 새 버전으로 다시 시작해 주세요.",
  "own.browse.remote": "SSH 원격 호스트의 대화에서는 쓸 수 없어요. 이 PC의 대화에서만 써요.",
  "own.browse.install": "설치",
  "own.browse.install.lead": "앱이 대신 설치하지 않아요. 아래 두 가지를 직접 설치하면 이 페이지가 찾아요.",
  "own.browse.install.extension": "1. 브라우저 확장: Chrome 웹 스토어에서 Browse를 추가해요.",
  "own.browse.install.extensionLink": "Chrome 웹 스토어 열기",
  "own.browse.install.program":
    "2. browse 프로그램: 안내 페이지의 설치 명령(PowerShell은 irm … | iex)으로 설치해요. 설치가 끝나면 확장과 짝을 맞춰요(browse pair).",
  "own.browse.install.programLink": "설치 안내 열기",
  "own.browse.install.agents":
    "설치 명령이 다른 에이전트 설정에 browse를 넣겠냐고 물으면 이 앱은 고르지 않아도 돼요. 이 앱은 여기서 켜면 돼요.",
  "own.browse.program": "browse 프로그램",
  "own.browse.found.install": "찾았어요: {path}",
  "own.browse.found.path": "PATH에서 찾았어요: {path}",
  "own.browse.found.setting": "적은 경로를 써요: {path}",
  "own.browse.missing": "아직 못 찾았어요. 설치하거나 아래에 경로를 적어 주세요.",
  "own.browse.missingSetting": "적은 경로에 프로그램이 없어요. 경로를 확인해 주세요.",
  "own.browse.path": "프로그램 경로 (비우면 자동으로 찾아요)",
  "own.browse.pathPlaceholder": "C:\\Users\\<이름>\\.local\\bin\\browse.exe",
  "own.browse.pathSave": "저장",
  "own.browse.pathSaved": "저장했어요.",
  "own.browse.recheck": "다시 찾기",
  "own.browse.active": "지금 이 PC의 대화에 쓸 수 있어요.",
  "own.browse.inactive": "켜져 있지만 프로그램을 못 찾아서 아직 쓸 수 없어요.",
  "own.browse.modes": "승인 모드에 따라",
  "own.browse.modes.full": "전체 허용: 묻지 않고 탭을 열고 누르고 입력해요.",
  "own.browse.modes.ask":
    "묻기: 보기(페이지 읽기, 스크린숏, 탭 목록)는 바로 하고, 열기·누르기·입력·페이지 스크립트는 먼저 물어요.",
  "own.browse.modes.readOnly": "읽기 전용: 보기만 하고 브라우저를 움직이는 일은 모두 거절해요.",
  "own.browse.safety": "알아 둘 것",
  "own.browse.safety.tabs":
    "에이전트는 자기가 연 탭과 내가 빌려준 탭(도구 모음 단추)만 써요. 연 탭은 뒤에서 묶음으로 열려요.",
  "own.browse.safety.handoff":
    "로그인, 2단계 인증, 결제는 에이전트가 넘겨줘요. 내가 하고 Continue를 누르면 이어서 해요.",
  "own.browse.safety.injection":
    "웹 페이지의 글이 에이전트를 속일 수 있어요. 중요한 계정이 열린 브라우저라면 묻기로 써 주세요.",
  "own.browse.safety.profile":
    "확장을 설치한 브라우저 프로필을 그대로 써요. 따로 쓰고 싶으면 새 프로필을 만들어 그 프로필에만 확장을 설치해요.",
  "own.browse.safety.remote": "다른 기기와 SSH 원격 호스트에서는 켤 수 없어요. 이 PC의 앱 창에서만 켜요.",
  "own.browse.dialog.title": "이 대화에서 내 브라우저 사용",
  "own.browse.dialog.lead": "켜면 이 대화의 에이전트가 내 브라우저의 탭을 써요. 대화 모드: {mode}.",
  "own.browse.dialog.mode.full": "전체 허용 (묻지 않아요)",
  "own.browse.dialog.mode.ask": "묻기 (움직이기 전에 물어요)",
  "own.browse.dialog.mode.read-only": "읽기 전용 (보기만 해요)",
  "own.browse.dialog.switch": "이 대화에서 쓰기",
  "own.browse.dialog.confirm": "에이전트가 내 로그인으로 사이트를 열고 누를 수 있어요. 이 대화에서 켤까요?",
  "own.browse.dialog.turnOn": "켜기",
  "own.browse.dialog.cancel": "닫기",
  "own.browse.dialog.custom": "이 대화의 승인 규칙을 직접 바꿔서 여기서 켤 수 없어요. 승인 모드를 먼저 골라 주세요.",
  "own.browse.dialog.scope": "이 기기에서는 켤 수 없어요. PC의 앱 창에서 켜 주세요.",
  "own.browse.dialog.unavailable": "서비스에 연결하지 못했어요. 잠시 뒤 다시 열어 주세요.",
  "own.browse.dialog.settingOff": "설정 > 내 브라우저 사용이 꺼져 있어요. 먼저 켜 주세요.",
  "own.browse.dialog.openSettings": "설정 열기",
  "own.browse.dialog.done.on": "이 대화에서 켰어요. 다음 요청부터 도구가 보여요.",
  "own.browse.dialog.done.off": "이 대화에서 껐어요.",
  "own.browse.dialog.failed": "바꾸지 못했어요. 다시 해 주세요.",
} as const satisfies Record<string, string>

export type BrowseKey = keyof typeof browseKo

export const browseEn: Record<BrowseKey, string> = {
  "own.browse.lead":
    "When on, the agent opens, reads and clicks tabs in your own browser (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium), with your logins and extensions. It uses OpenCode's Browse (MIT).",
  "own.browse.toggle": "Turn on My browser",
  "own.browse.default":
    "Off by default. Even when on, you turn it on per conversation, and only that conversation uses it.",
  "own.browse.on": "On. Turn it on per conversation in ⋯ > Use my browser in this conversation.",
  "own.browse.off": "Off. From the next request no conversation has the tools.",
  "own.browse.readOnly": "This device cannot change it. Change it in the app window on the PC.",
  "own.browse.unsupported": "This service does not know this feature yet. Restart it on the new version.",
  "own.browse.remote": "Not available in conversations on SSH hosts. Only in this PC's conversations.",
  "own.browse.install": "Install",
  "own.browse.install.lead":
    "The app does not install anything for you. Install these two yourself, and this page finds them.",
  "own.browse.install.extension": "1. The browser extension: add Browse from the Chrome Web Store.",
  "own.browse.install.extensionLink": "Open the Chrome Web Store",
  "own.browse.install.program":
    "2. The browse program: install it with the command on the install page (PowerShell: irm … | iex). Then pair it with the extension (browse pair).",
  "own.browse.install.programLink": "Open the install page",
  "own.browse.install.agents":
    "When the installer asks which agents to set up, you need not pick one for this app. Turn it on here.",
  "own.browse.program": "The browse program",
  "own.browse.found.install": "Found: {path}",
  "own.browse.found.path": "Found on PATH: {path}",
  "own.browse.found.setting": "Using the path you gave: {path}",
  "own.browse.missing": "Not found yet. Install it or enter its path below.",
  "own.browse.missingSetting": "There is no program at the path you gave. Check the path.",
  "own.browse.path": "Program path (leave empty to find it)",
  "own.browse.pathPlaceholder": "C:\\Users\\<name>\\.local\\bin\\browse.exe",
  "own.browse.pathSave": "Save",
  "own.browse.pathSaved": "Saved.",
  "own.browse.recheck": "Look again",
  "own.browse.active": "This PC's conversations can use it now.",
  "own.browse.inactive": "On, but the program was not found, so it cannot be used yet.",
  "own.browse.modes": "By approval mode",
  "own.browse.modes.full": "Allow all: opens tabs, clicks and types without asking.",
  "own.browse.modes.ask":
    "Ask: looks (reads pages, screenshots, the tab list) right away, and asks before opening, clicking, typing or running page scripts.",
  "own.browse.modes.readOnly": "Read only: only looks, and refuses anything that moves the browser.",
  "own.browse.safety": "Good to know",
  "own.browse.safety.tabs":
    "The agent uses only the tabs it opened and the tabs you lend it (the toolbar button). Its tabs open in the background, grouped.",
  "own.browse.safety.handoff":
    "The agent hands logins, two-step checks and payments to you. Do them, click Continue, and it goes on.",
  "own.browse.safety.injection":
    "Text on a web page can mislead the agent. With important accounts open in that browser, use Ask.",
  "own.browse.safety.profile":
    "It uses the browser profile you installed the extension in. To keep it apart, make a new profile and install the extension there only.",
  "own.browse.safety.remote": "Other devices and SSH hosts cannot turn it on. Only the app window on this PC.",
  "own.browse.dialog.title": "Use my browser in this conversation",
  "own.browse.dialog.lead": "When on, this conversation's agent uses tabs in your browser. Mode: {mode}.",
  "own.browse.dialog.mode.full": "Allow all (never asks)",
  "own.browse.dialog.mode.ask": "Ask (asks before it acts)",
  "own.browse.dialog.mode.read-only": "Read only (only looks)",
  "own.browse.dialog.switch": "Use in this conversation",
  "own.browse.dialog.confirm": "The agent can open and click sites with your logins. Turn it on in this conversation?",
  "own.browse.dialog.turnOn": "Turn on",
  "own.browse.dialog.cancel": "Close",
  "own.browse.dialog.custom":
    "This conversation's approval rules were changed by hand, so it cannot be turned on here. Pick an approval mode first.",
  "own.browse.dialog.scope": "This device cannot turn it on. Turn it on in the app window on the PC.",
  "own.browse.dialog.unavailable": "Could not reach the service. Open this again in a moment.",
  "own.browse.dialog.settingOff": "Settings > My browser is off. Turn it on first.",
  "own.browse.dialog.openSettings": "Open settings",
  "own.browse.dialog.done.on": "On in this conversation. The tools appear from the next request.",
  "own.browse.dialog.done.off": "Off in this conversation.",
  "own.browse.dialog.failed": "Could not change it. Try again.",
}

export const browseText = catalogText(browseKo, browseEn)

export function useBrowseText() {
  return useCatalogText(browseText)
}
