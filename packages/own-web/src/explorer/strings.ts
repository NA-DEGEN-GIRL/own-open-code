// Strings of `탐색기에서 열기` / `탐색기에서 보기` (03 §19.5, 05 §7.10) and of the SSH file explorer program setting
// (04 §17.10). A lazy module like the files and remote strings: nothing here is in the first chunk.
import { featureText } from "@/queue/text"

export const explorerKo = {
  "own.explorer.open": "탐색기에서 열기",
  "own.explorer.reveal": "탐색기에서 보기",
  "own.explorer.openSettings": "설정 열기",
  "own.explorer.fail.outside": "앱에서 열어 둔 폴더 밖이라 열지 않았어요: {path}",
  "own.explorer.fail.missing": "폴더나 파일을 찾지 못했어요: {path}",
  "own.explorer.fail.service":
    "이 PC의 서비스가 답하지 않아서, 열어 둔 폴더 안인지 확인하지 못했어요. 잠시 뒤에 다시 해 보세요.",
  "own.explorer.fail.unconfigured":
    "SSH 호스트의 폴더를 열 프로그램을 아직 고르지 않았어요. 설정에서 프로그램을 고르면 그 프로그램으로 열어요.",
  "own.explorer.fail.program": "프로그램을 찾지 못했어요: {detail}. 설정에서 다시 골라 주세요.",
  "own.explorer.fail.blocked":
    "Windows가 프로그램 실행을 막았어요 ({detail}). 서명되지 않은 프로그램은 스마트 앱 컨트롤이 막을 수 있어요. 이 앱은 그 보호를 건너뛰지 않아요.",
  "own.explorer.fail.failed": "열지 못했어요: {detail}",
  "own.explorer.fail.host":
    "이 호스트의 SSH 대상({detail})은 프로그램에 넘길 수 없어요. ssh config 별칭으로 추가한 호스트는 넘길 수 있어요.",
  "own.explorer.fail.path": "이 경로는 프로그램에 넘길 수 없어요: {detail}",
  "own.explorer.fail.template": "실행 인자가 잘못돼서 프로그램을 시작하지 않았어요. 설정에서 고쳐 주세요.",
  "own.explorer.fail.unavailable":
    "데스크톱 앱이 이 화면보다 오래돼서 아직 쓸 수 없어요. 새 설치 파일로 다시 설치해 주세요.",
  "own.explorer.fail.noHost": "이 호스트의 정보를 아직 읽지 못했어요. 잠시 뒤에 다시 해 보세요.",
  "own.explorer.settings.title": "SSH 파일 탐색기",
  "own.explorer.settings.about":
    "SSH 호스트에서 하는 대화의 `탐색기에서 열기`와 `탐색기에서 보기`는 여기서 고른 Windows 프로그램을 그 폴더나 파일 위치로 실행해요. 이 PC의 폴더는 Windows 탐색기로 열어요.",
  "own.explorer.settings.program": "프로그램",
  "own.explorer.settings.none": "고르지 않았어요",
  "own.explorer.settings.pick": "프로그램 고르기…",
  "own.explorer.settings.clear": "지우기",
  "own.explorer.settings.template": "실행 인자",
  "own.explorer.settings.reset": "기본값으로",
  "own.explorer.settings.help":
    "`{host}`는 호스트를 추가할 때 고른 ssh config 별칭이나 직접 입력한 `user@host`로, `{path}`는 호스트의 폴더나 파일 경로(`/`로 시작)로 바뀌어요. 이름에 공백이나 따옴표가 있어도 자리 하나는 인자 하나로만 전달돼요.",
  "own.explorer.settings.portHelp":
    "포트나 점프 호스트 옵션과 함께 직접 입력한 호스트는 `user@host`만 전달돼요. 기본 포트가 아니면 ssh config 별칭으로 호스트를 추가하세요.",
  "own.explorer.settings.badTemplate":
    "실행 인자에는 `{path}`가 있어야 하고, 쓸 수 있는 자리는 `{host}`와 `{path}`뿐이에요. 고치기 전 값을 그대로 뒀어요.",
  "own.explorer.settings.failed": "설정을 바꾸지 못했어요: {detail}",
} as const satisfies Record<string, string>

export type ExplorerKey = keyof typeof explorerKo

export const explorerEn: Partial<Record<ExplorerKey, string>> = {
  "own.explorer.open": "Open in Explorer",
  "own.explorer.reveal": "Reveal in Explorer",
  "own.explorer.openSettings": "Open settings",
  "own.explorer.fail.outside": "Not opened: outside the folders this app has open: {path}",
  "own.explorer.fail.missing": "Folder or file not found: {path}",
  "own.explorer.fail.service":
    "This PC's service did not answer, so the folder could not be checked. Try again in a moment.",
  "own.explorer.fail.unconfigured":
    "No program is chosen for folders on SSH hosts yet. Choose one in settings and it opens them.",
  "own.explorer.fail.program": "Program not found: {detail}. Choose it again in settings.",
  "own.explorer.fail.blocked":
    "Windows refused to start the program ({detail}). Smart App Control can block unsigned programs. This app does not work around it.",
  "own.explorer.fail.failed": "Could not open: {detail}",
  "own.explorer.fail.host":
    "This host's SSH target ({detail}) cannot be passed to the program. A host added by its ssh config alias can.",
  "own.explorer.fail.path": "This path cannot be passed to the program: {detail}",
  "own.explorer.fail.template": "The arguments are not usable, so the program was not started. Fix them in settings.",
  "own.explorer.fail.unavailable": "The desktop app is older than this screen. Install the new version to use this.",
  "own.explorer.fail.noHost": "This host's details are not loaded yet. Try again in a moment.",
  "own.explorer.settings.title": "SSH file explorer",
  "own.explorer.settings.about":
    "`Open in Explorer` and `Reveal in Explorer` in conversations on an SSH host start the Windows program chosen here at that folder or file. Folders of this PC open in Windows Explorer.",
  "own.explorer.settings.program": "Program",
  "own.explorer.settings.none": "Not chosen",
  "own.explorer.settings.pick": "Choose program…",
  "own.explorer.settings.clear": "Clear",
  "own.explorer.settings.template": "Arguments",
  "own.explorer.settings.reset": "Use default",
  "own.explorer.settings.help":
    "`{host}` becomes the ssh config alias picked when the host was added, or the `user@host` typed then; `{path}` becomes the folder or file path on the host (it starts with `/`). Each one is passed as exactly one argument, whatever spaces or quotes a name holds.",
  "own.explorer.settings.portHelp":
    "A host typed with a port or jump-host options passes only `user@host`. For a non-default port, add the host by an ssh config alias.",
  "own.explorer.settings.badTemplate":
    "The arguments need `{path}`, and only `{host}` and `{path}` are known. The previous value was kept.",
  "own.explorer.settings.failed": "Could not change the setting: {detail}",
}

export const explorerText = featureText(explorerKo, explorerEn)
