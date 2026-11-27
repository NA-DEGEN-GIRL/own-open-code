// 설정 > 셸·터미널 strings (03 §19.8). Kept here until the integrator appends them to src/i18n (section "shellcfg");
// same `t()` rules. The cache sentence is 03 §19.8's own wording (`셸 도구 설명이 바뀌어 다음 요청에서 캐시를 새로 쓸
// 수 있습니다`); the page adds exactly what changes (19 "확인 단계에서 무엇이 바뀌는지 적는다", P3).
import { catalogText, useCatalogText } from "@/projects/text"

export const shellKo = {
  "own.shellcfg.title": "기본 셸",
  "own.shellcfg.intro":
    "에이전트의 셸 도구와 새로 여는 터미널이 같은 셸을 써요. 서버의 전역 설정 파일(opencode.jsonc의 shell)에 저장돼요.",
  "own.shellcfg.server": "서버",
  "own.shellcfg.thisPc": "이 PC",
  "own.shellcfg.project": "기준 프로젝트: {path}",
  "own.shellcfg.auto": "자동 (서버 기본값)",
  "own.shellcfg.autoWindows":
    "서버에 SHELL 환경 변수가 없으면 pwsh → Windows PowerShell → Git Bash → cmd 순서로 먼저 찾은 셸",
  "own.shellcfg.autoUnix": "서버의 SHELL 환경 변수가 가리키는 셸",
  "own.shellcfg.kind.pwsh": "PowerShell 7 (pwsh)",
  "own.shellcfg.kind.powershell": "Windows PowerShell",
  "own.shellcfg.kind.gitbash": "Git Bash",
  "own.shellcfg.kind.bash": "bash",
  "own.shellcfg.kind.cmd": "명령 프롬프트 (cmd)",
  "own.shellcfg.current": "현재",
  "own.shellcfg.notForAgent": "에이전트 셸 도구는 이 셸을 쓰지 않고 기본 셸로 돌아가요(터미널에만 적용).",
  "own.shellcfg.unlisted": "지금 설정: {value} (이 서버에서 찾지 못한 셸이에요)",
  "own.shellcfg.loading": "셸 목록을 불러오는 중…",
  "own.shellcfg.none": "찾은 셸이 없어요",
  "own.shellcfg.loadFailed": "셸 목록을 불러오지 못했어요.",
  "own.shellcfg.retry": "다시 시도",
  "own.shellcfg.notConnected": "서버에 연결되면 셸 목록을 보여 줘요.",
  "own.shellcfg.confirmTitle": "{name}(으)로 바꿀까요?",
  "own.shellcfg.confirmAuto": "자동(서버 기본값)으로 바꿀까요?",
  "own.shellcfg.confirm.agent": "에이전트의 셸 도구가 다음 요청부터 {name}(으)로 명령을 실행해요.",
  "own.shellcfg.confirm.terminal": "새로 여는 터미널이 {name}(으)로 열려요. 이미 열린 터미널은 그대로예요.",
  "own.shellcfg.confirm.cache": "셸 도구 설명이 바뀌어 다음 요청에서 캐시를 새로 쓸 수 있어요.",
  "own.shellcfg.confirm.cacheChanges":
    "셸 도구 설명의 “using {from}”(이)가 “using {to}”(으)로 바뀌어요. 대화마다 다음 요청 한 번은 캐시를 처음부터 다시 써요.",
  "own.shellcfg.confirm.cacheSame": "셸 도구 설명에 들어가는 셸 이름({name})이 같아 캐시에는 영향이 없어요.",
  "own.shellcfg.confirm.write": "서버의 전역 설정 파일에 shell 값을 써요.",
  "own.shellcfg.confirm.remove": "서버의 전역 설정 파일에서 shell 값을 지워요.",
  "own.shellcfg.apply": "적용",
  "own.shellcfg.cancel": "취소",
  "own.shellcfg.applying": "적용하는 중…",
  "own.shellcfg.applied": "적용했어요. 다음 요청부터 {name}(을)를 써요.",
  "own.shellcfg.failed": "셸을 바꾸지 못했어요: {reason}",
  "own.shellcfg.overridden":
    "이 프로젝트의 설정 파일({path})이 셸을 {name}(으)로 정하고 있어, 이 프로젝트에서는 전역 설정이 적용되지 않아요.",
  "own.shellcfg.readOnly": "이 기기에서는 셸 설정을 바꿀 수 없어요. PC에서 바꾸세요.",
  "own.shellcfg.terminalTitle": "터미널",
  "own.shellcfg.terminalNote":
    "터미널 탭의 ▾에서 새 터미널마다 다른 셸을 고를 수 있어요. 여기 설정은 그 기본값이에요.",
  "own.shellcfg.terminalLater": "터미널 글꼴·스크롤백 설정은 아직 없어요.",
} as const satisfies Record<string, string>

export type ShellSettingsKey = keyof typeof shellKo

export const shellEn: Partial<Record<ShellSettingsKey, string>> = {
  "own.shellcfg.title": "Default shell",
  "own.shellcfg.intro":
    "The agent's shell tool and new terminals use the same shell. It is saved in the server's global config (shell in opencode.jsonc).",
  "own.shellcfg.server": "Server",
  "own.shellcfg.thisPc": "This PC",
  "own.shellcfg.project": "Project used: {path}",
  "own.shellcfg.auto": "Automatic (server default)",
  "own.shellcfg.autoWindows":
    "Without a SHELL variable on the server, the first found of pwsh → Windows PowerShell → Git Bash → cmd",
  "own.shellcfg.autoUnix": "The shell in the server's SHELL environment variable",
  "own.shellcfg.kind.pwsh": "PowerShell 7 (pwsh)",
  "own.shellcfg.kind.powershell": "Windows PowerShell",
  "own.shellcfg.kind.gitbash": "Git Bash",
  "own.shellcfg.kind.bash": "bash",
  "own.shellcfg.kind.cmd": "Command Prompt (cmd)",
  "own.shellcfg.current": "Current",
  "own.shellcfg.notForAgent":
    "The agent's shell tool does not use this shell and falls back to the default (terminals only).",
  "own.shellcfg.unlisted": "Now set to {value} (not found on this server)",
  "own.shellcfg.loading": "Loading shells…",
  "own.shellcfg.none": "No shells found",
  "own.shellcfg.loadFailed": "Could not load the shells.",
  "own.shellcfg.retry": "Retry",
  "own.shellcfg.notConnected": "The shells show once the server is connected.",
  "own.shellcfg.confirmTitle": "Switch to {name}?",
  "own.shellcfg.confirmAuto": "Switch to automatic (server default)?",
  "own.shellcfg.confirm.agent": "The agent's shell tool runs commands with {name} from the next request.",
  "own.shellcfg.confirm.terminal": "New terminals open with {name}. Open terminals keep their shell.",
  "own.shellcfg.confirm.cache": "The shell tool's description changes, so the next request may write the cache again.",
  "own.shellcfg.confirm.cacheChanges":
    "The shell tool's description changes from “using {from}” to “using {to}”. The next request of each session writes its cache from the start.",
  "own.shellcfg.confirm.cacheSame":
    "The shell name in the tool's description ({name}) stays, so the cache is not affected.",
  "own.shellcfg.confirm.write": "Writes the shell value into the server's global config.",
  "own.shellcfg.confirm.remove": "Removes the shell value from the server's global config.",
  "own.shellcfg.apply": "Apply",
  "own.shellcfg.cancel": "Cancel",
  "own.shellcfg.applying": "Applying…",
  "own.shellcfg.applied": "Done. The next request uses {name}.",
  "own.shellcfg.failed": "Could not change the shell: {reason}",
  "own.shellcfg.overridden":
    "This project's config ({path}) sets the shell to {name}, so the global setting does not apply in this project.",
  "own.shellcfg.readOnly": "This device cannot change the shell. Change it on the PC.",
  "own.shellcfg.terminalTitle": "Terminal",
  "own.shellcfg.terminalNote":
    "Each new terminal can use another shell from the ▾ in the terminal tab; this setting is its default.",
  "own.shellcfg.terminalLater": "Terminal font and scrollback settings are not available yet.",
}

export const shellText = catalogText(shellKo, shellEn)

export function useShellText() {
  return useCatalogText(shellText)
}
