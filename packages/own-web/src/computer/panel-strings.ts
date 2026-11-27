// Computer use strings of the lazy chunks (01 §10.2, 03 §5.7 실험, §4.4): the per-session dialog, 설정 > 실험 and the
// plugins row. The first chunk's few keys are in `strings.ts`.
import { catalogText, useCatalogText } from "@/projects/text"

export const panelKo = {
  "own.computer.toggle": "이 대화에서 컴퓨터 사용",
  "own.computer.on": "켜짐",
  "own.computer.off": "꺼짐",
  "own.computer.what":
    "에이전트가 이 PC의 화면을 캡처하고 실제 마우스와 키보드를 움직여요. 조작하는 동안에는 마우스와 키보드를 쓰지 마세요.",
  "own.computer.stopHint": "멈추기: Ctrl+Alt+Shift+Q, 또는 머리줄의 [멈추기]나 설정 > 컴퓨터 사용의 [모두 멈추기].",
  "own.computer.deniedApps":
    "터미널과 터미널이 있는 IDE, 실행 대화상자, 시작 메뉴와 검색, 이 앱(브라우저로 연 것 포함), 비밀번호 관리자, 보안·관리자 권한 창과 비밀번호 칸에는 켜도 입력하지 않아요. 이 창들도 화면에 보이면 스크린숏에는 찍혀요. 파일 탐색기 주소 표시줄처럼 명령을 실행할 수 있는 다른 곳은 막지 않아요. 하위 에이전트는 기본으로 쓸 수 없어요.",
  "own.computer.privacy": "스크린숏은 모델 회사에 보내지고 대화 기록에 남아요.",
  "own.computer.cache": "켜거나 끌 때 이 대화의 다음 요청에 도구 목록 문구가 한 번 더해져요. 앞부분 캐시는 유지돼요.",
  "own.computer.confirm": "이 대화에서 에이전트가 이 PC를 조작하도록 허용할까요?",
  "own.computer.turnOn": "켜기",
  "own.computer.cancel": "취소",
  "own.computer.checking": "확인하는 중…",
  "own.computer.failed": "바꾸지 못했어요. 다시 시도하세요.",
  "own.computer.blocked.custom":
    "이 대화는 사용자 지정 권한 규칙을 써요. 승인 모드(읽기 전용·묻기·전체 허용)를 먼저 고르면 바꿀 수 있어요.",
  "own.computer.blocked.unsupported":
    "서비스의 계정 플러그인이 이 설정을 몰라요. 서비스를 새 버전으로 다시 시작하세요.",
  "own.computer.blocked.scope": "이 연결에서는 대화 권한을 바꿀 수 없어요.",
  "own.computer.blocked.unavailable": "서비스가 응답하지 않아요. 잠시 뒤 다시 여세요.",
  "own.computer.blocked.vision":
    "이 대화의 모델은 그림을 볼 수 없어서 컴퓨터 사용을 켤 수 없어요. 에이전트가 화면을 보지 못하고 조작하게 되기 때문이에요. 그림을 볼 수 있는 모델로 바꾸면 켤 수 있어요.",
  "own.computer.noVisionOn":
    "지금 모델은 그림을 볼 수 없어서 컴퓨터 사용이 동작하지 않아요. 그림을 볼 수 있는 모델로 바꾸거나 컴퓨터 사용을 끄세요.",
  "own.computer.stoppedNote": "지금은 모두 멈춘 상태예요. 설정 > 컴퓨터 사용에서 다시 허용해야 동작해요.",
  "own.computer.openSettings": "상태와 기록 보기",
  "own.computer.intro":
    "에이전트가 Windows 화면을 보고 마우스와 키보드로 앱을 조작하는 도구예요. 대화마다 따로 켜요(대화 머리줄 ⋯ > 이 대화에서 컴퓨터 사용).",
  "own.computer.available": "사용 가능",
  "own.computer.unavailable": "사용할 수 없음",
  "own.computer.loading": "불러오는 중…",
  "own.computer.missing":
    "컴퓨터 사용 플러그인이 응답하지 않아요. opencode.jsonc의 plugins에 own-computer-use가 있는지 확인하고 서비스를 다시 시작하세요.",
  "own.computer.reason.unmanaged": "이 앱의 런처로 시작한 서비스에서만 동작해요.",
  "own.computer.reason.skew": "플러그인이 앱 버전과 맞지 않아요. 서비스를 다시 시작하세요.",
  "own.computer.reason.unsupported": "Windows에서만 동작해요.",
  "own.computer.reason.invalid_options":
    "플러그인 설정(options)이 올바르지 않아요. opencode.jsonc의 own-computer-use 항목을 확인하세요.",
  "own.computer.stopAll": "모두 멈추기",
  "own.computer.stopAllNote":
    "진행 중인 동작을 끊고 눌린 키와 버튼을 놓아요. 다시 허용할 때까지 어떤 대화도 PC를 조작하지 않아요. 단축키 Ctrl+Alt+Shift+Q도 같아요.",
  "own.computer.stopped": "멈춤",
  "own.computer.stoppedBy": "멈춤 · {reason} · {at}",
  "own.computer.killReason.user_chord": "Ctrl+Alt+Shift+Q",
  "own.computer.killReason.rpc": "멈추기 버튼",
  "own.computer.killReason.helper_exit": "도우미 프로그램이 예기치 않게 끝남",
  "own.computer.reset": "다시 허용",
  "own.computer.resetNote": "다시 허용해도 대화마다 켠 설정은 그대로예요.",
  "own.computer.version": "버전",
  "own.computer.driver": "드라이버",
  "own.computer.driver.windows": "Windows 내장 드라이버",
  "own.computer.driver.helper": "Windows helper(own-cu-helper.exe)",
  "own.computer.driver.fake": "가짜 데스크톱(시험용)",
  "own.computer.helper": "도우미 프로그램",
  "own.computer.helperRunning": "실행 중 · {version} · 프로토콜 {protocol}",
  "own.computer.helperIdle": "쉬는 중(첫 동작 때 시작)",
  "own.computer.helperRestart": "도우미 다시 시작",
  "own.computer.helperRestarted": "도우미 프로그램을 멈췄어요. 다음 동작 때 새로 시작해요.",
  "own.computer.killChord": "멈춤 키",
  "own.computer.killChordOk": "Ctrl+Alt+Shift+Q 등록됨",
  "own.computer.killChordMissing":
    "Ctrl+Alt+Shift+Q를 등록하지 못했어요(다른 프로그램이 쓰는 중). 그동안 입력 동작은 모두 거부되고, 멈추려면 [모두 멈추기]를 써요. 그 프로그램을 끄면 다음 동작부터 다시 돼요.",
  "own.computer.approval": "앱 승인",
  "own.computer.approval.session": "대화를 켜면 거부 목록 밖의 앱은 모두 허용",
  "own.computer.approval.question": "앱마다 처음 조작할 때 묻기(실험)",
  "own.computer.allowApps": "허용 앱",
  "own.computer.allowAll": "거부 목록 밖의 모든 앱",
  "own.computer.denyApps": "추가 거부 앱",
  "own.computer.terminals": "터미널·터미널 있는 IDE",
  "own.computer.subagents": "하위 에이전트",
  "own.computer.allowed": "허용",
  "own.computer.denied": "거부",
  "own.computer.none": "없음",
  "own.computer.lease": "지금 조작하는 대화",
  "own.computer.grants": "대화별로 허용한 앱",
  "own.computer.revoke": "취소",
  "own.computer.audit": "최근 동작",
  "own.computer.auditNote": "입력한 글자, 창 제목, 스크린숏은 기록하지 않아요(글자 수와 창 제목 해시만).",
  "own.computer.auditEmpty": "기록이 없어요.",
  "own.computer.refresh": "새로 고침",
  "own.computer.col.time": "시각",
  "own.computer.col.session": "대화",
  "own.computer.col.tool": "동작",
  "own.computer.col.app": "앱",
  "own.computer.col.result": "결과",
  "own.computer.outcome.ok": "성공",
  "own.computer.outcome.denied": "거부",
  "own.computer.outcome.error": "오류",
  "own.computer.actionFailed": "요청을 처리하지 못했어요: {message}",
  "own.computer.manage": "설정 > 컴퓨터 사용에서 관리",
} as const satisfies Record<string, string>

export type PanelKey = keyof typeof panelKo

export const panelEn: Partial<Record<PanelKey, string>> = {
  "own.computer.toggle": "Computer use in this session",
  "own.computer.on": "On",
  "own.computer.off": "Off",
  "own.computer.what":
    "The agent captures this PC's screen and moves the real mouse and keyboard. Keep your hands off them while it works.",
  "own.computer.stopHint": "To stop: Ctrl+Alt+Shift+Q, [Stop] in the header, or [Stop all] in Settings > Computer use.",
  "own.computer.deniedApps":
    "Terminals and IDEs with a terminal, the Run dialog, Start and its search, this app (also in a browser), password managers, security and administrator windows and password fields get no input. They still show up in screenshots while they are on screen. Other places that can run commands, such as the File Explorer address bar, are not blocked. Subagents cannot use it by default.",
  "own.computer.privacy": "Screenshots are sent to the model company and stay in the conversation history.",
  "own.computer.cache":
    "Turning it on or off adds one tool-list note to this session's next request. The cached prefix is kept.",
  "own.computer.confirm": "Let the agent operate this PC in this session?",
  "own.computer.turnOn": "Turn on",
  "own.computer.cancel": "Cancel",
  "own.computer.checking": "Checking…",
  "own.computer.failed": "Could not change it. Try again.",
  "own.computer.blocked.custom":
    "This session uses custom permission rules. Pick an approval mode (read-only, ask, full) first to change it.",
  "own.computer.blocked.unsupported":
    "The service's accounts plugin does not know this setting. Restart the service on the new version.",
  "own.computer.blocked.scope": "This connection may not change session permissions.",
  "own.computer.blocked.unavailable": "The service does not answer. Open this again in a moment.",
  "own.computer.blocked.vision":
    "This session's model cannot see images, so computer use cannot be turned on: the agent would act without seeing the screen. Switch to a model that can see images to turn it on.",
  "own.computer.noVisionOn":
    "The current model cannot see images, so computer use does nothing. Switch to a model that can see images, or turn computer use off.",
  "own.computer.stoppedNote": "Everything is stopped right now. Allow it again in Settings > Computer use.",
  "own.computer.openSettings": "Status and history",
  "own.computer.intro":
    "Lets the agent look at the Windows screen and operate apps with the mouse and keyboard. Turn it on per session (session header ⋯ > Computer use in this session).",
  "own.computer.available": "Available",
  "own.computer.unavailable": "Unavailable",
  "own.computer.loading": "Loading…",
  "own.computer.missing":
    "The computer use plugin does not answer. Check that own-computer-use is in the plugins of opencode.jsonc and restart the service.",
  "own.computer.reason.unmanaged": "Works only in a service started by this app's launcher.",
  "own.computer.reason.skew": "The plugin does not match the app version. Restart the service.",
  "own.computer.reason.unsupported": "Works on Windows only.",
  "own.computer.reason.invalid_options":
    "The plugin options are invalid. Check the own-computer-use entry in opencode.jsonc.",
  "own.computer.stopAll": "Stop all",
  "own.computer.stopAllNote":
    "Cuts the running action and releases held keys and buttons. No session operates the PC until you allow it again. Same as Ctrl+Alt+Shift+Q.",
  "own.computer.stopped": "Stopped",
  "own.computer.stoppedBy": "Stopped · {reason} · {at}",
  "own.computer.killReason.rpc": "Stop button",
  "own.computer.killReason.helper_exit": "the helper program ended unexpectedly",
  "own.computer.reset": "Allow again",
  "own.computer.resetNote": "Allowing again keeps each session's own setting.",
  "own.computer.version": "Version",
  "own.computer.driver": "Driver",
  "own.computer.driver.windows": "Windows built-in driver",
  "own.computer.driver.helper": "Windows helper (own-cu-helper.exe)",
  "own.computer.driver.fake": "Fake desktop (tests)",
  "own.computer.helperRunning": "Running · {version} · protocol {protocol}",
  "own.computer.helperIdle": "Idle (starts on the first action)",
  "own.computer.helperRestart": "Restart the helper",
  "own.computer.helperRestarted": "Stopped the helper program. The next action starts a new one.",
  "own.computer.killChord": "Stop chord",
  "own.computer.killChordOk": "Ctrl+Alt+Shift+Q registered",
  "own.computer.killChordMissing":
    "Could not register Ctrl+Alt+Shift+Q (another program uses it). Every input action is refused meanwhile; use [Stop all] to stop. Input works again from the next action once that program lets go of it.",
  "own.computer.approval": "App approval",
  "own.computer.approval.session": "Enabling a session allows every app outside the deny list",
  "own.computer.approval.question": "Ask on the first action in each app (experimental)",
  "own.computer.allowApps": "Allowed apps",
  "own.computer.allowAll": "Every app outside the deny list",
  "own.computer.denyApps": "Extra denied apps",
  "own.computer.terminals": "Terminals and IDEs with a terminal",
  "own.computer.subagents": "Subagents",
  "own.computer.allowed": "Allowed",
  "own.computer.denied": "Denied",
  "own.computer.none": "None",
  "own.computer.lease": "Session operating now",
  "own.computer.grants": "Apps allowed per session",
  "own.computer.revoke": "Revoke",
  "own.computer.audit": "Recent actions",
  "own.computer.auditNote":
    "Typed text, window titles and screenshots are never logged (only text lengths and title hashes).",
  "own.computer.auditEmpty": "No entries.",
  "own.computer.refresh": "Refresh",
  "own.computer.col.time": "Time",
  "own.computer.col.session": "Session",
  "own.computer.col.tool": "Action",
  "own.computer.col.app": "App",
  "own.computer.col.result": "Result",
  "own.computer.outcome.ok": "OK",
  "own.computer.outcome.denied": "Denied",
  "own.computer.outcome.error": "Error",
  "own.computer.actionFailed": "The request failed: {message}",
  "own.computer.manage": "Manage in Settings > Computer use",
  "own.computer.helper": "Helper program",
}

export const panelText = catalogText(panelKo, panelEn)

export function usePanelText() {
  return useCatalogText(panelText)
}
