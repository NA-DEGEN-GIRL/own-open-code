// 설정 > 업데이트 strings (05 §20, UPD 2026-11-04), in the page's and the composer notice's lazy chunks (PF5). Same
// rules as src/queue/text.ts.
import { featureText } from "@/queue/text"

export const toolUpdatesKo = {
  "own.upd.lead":
    "own이 이 PC에서 쓰는 외부 도구예요. own 업데이트와 따로 설치하고 업데이트해요. own은 버전만 읽고, 업데이트는 누를 때만 공식 명령으로 실행해요.",
  "own.upd.check": "새 버전 확인",
  "own.upd.checkNote":
    "하루에 한 번 npm 레지스트리와 GitHub 릴리스에서 최신 버전 번호만 읽어요. 로그인 정보는 보내지 않아요.",
  "own.upd.on": "켬",
  "own.upd.off": "끔",
  "own.upd.refresh": "지금 확인",
  "own.upd.checkedAt": "마지막 확인: {time} 전",
  "own.upd.neverChecked": "아직 확인하지 않았어요",
  "own.upd.checkOff": "새 버전 확인을 꺼 둬서 최신 버전은 보이지 않아요",
  "own.upd.failed": "최신 버전을 읽지 못한 도구: {names}",
  "own.upd.loading": "버전을 읽는 중…",
  "own.upd.loadFailed": "버전을 읽지 못했어요: {error}",
  "own.upd.localOnly": "외부 도구 업데이트는 이 PC의 창에서만 볼 수 있어요",
  "own.upd.installed": "설치됨 {version}",
  "own.upd.installedUnknown": "설치됨 (버전을 읽지 못함)",
  "own.upd.latest": "최신 {version}",
  "own.upd.latestUnknown": "최신 버전 모름",
  "own.upd.path": "위치 {path}",
  "own.upd.status.current": "최신",
  "own.upd.status.recommended": "업데이트 권장",
  "own.upd.status.required": "필요",
  "own.upd.status.missing": "설치 안 됨",
  "own.upd.status.unknown": "확인 필요",
  "own.upd.why.claude_verbatim":
    "{minimum}보다 오래된 Claude Code는 Claude Agent 대화가 막혀요(입력을 Claude 명령으로 읽을 수 있어서요).",
  "own.upd.why.claude_context":
    "{version}보다 오래돼서 모델의 문맥 크기를 물을 수 없어요. 작게 잡은 값으로 대화해요.",
  "own.upd.why.claude_sdk":
    "own의 Claude Agent가 맞춰 만든 Claude Code {version}보다 오래됐어요. 대화는 되지만 일부 기능이 빠지거나 다르게 동작할 수 있어요.",
  "own.upd.why.git_team": "Git {version}보다 오래돼서 팀 모드를 켤 수 없어요.",
  "own.upd.why.git_sparse":
    "Git {version}보다 오래돼서 팀 모드가 큰 파일까지 모두 받는 작업 폴더를 만들어요.",
  "own.upd.why.lfs_security":
    "git-lfs {version}에서 고친 보안 문제(CVE 4건)가 남아 있어요. 다른 사람이 만든 저장소에서 팀 모드를 쓸 때 영향이 있어요.",
  "own.upd.why.rg_pinned": "own이 시험한 ripgrep {version}보다 오래됐어요. PATH의 것이 먼저 쓰여요.",
  "own.upd.why.newer": "새 버전이 나왔어요: {latest}",
  "own.upd.why.not_installed": "이 PC에서 찾지 못했어요. own은 설치하지 않아요.",
  "own.upd.why.unreadable": "버전을 읽지 못했어요. 실행이 막혔는지 확인해 주세요.",
  "own.upd.why.own_copy": "PATH에 없어서 own이 받아 둔 ripgrep {version} 사본을 써요. own 업데이트를 따라가요.",
  "own.upd.reviewed": "own이 읽기 도구를 하나씩 확인한 판은 {version}이에요. 다른 판은 도구 표시로 읽기·쓰기를 나눠요.",
  "own.upd.update": "업데이트",
  "own.upd.manual.elevation":
    "모든 사용자용으로 설치돼 있어 관리자 권한이 필요해요. own은 관리자 권한으로 실행하지 않아요. 직접 실행해 주세요.",
  "own.upd.manual.bundled": "Git for Windows에 들어 있는 git-lfs예요. Git을 업데이트하면 같이 바뀌어요.",
  "own.upd.manual.interactive": "업데이트 프로그램이 콘솔에서 물어봐요. 터미널에서 직접 실행해 주세요.",
  "own.upd.manual.no_updater": "스스로 업데이트하는 명령이 없어요. 공식 페이지에서 새 판을 받아 주세요.",
  "own.upd.manual.script": "명령 스크립트(.cmd)로 설치돼 있어요. 터미널에서 직접 실행해 주세요.",
  "own.upd.manual.not_installed": "설치는 공식 페이지를 따라 직접 해 주세요.",
  "own.upd.command": "직접 실행할 명령",
  "own.upd.source": "공식 안내",
  "own.upd.copy": "복사",
  "own.upd.copied": "복사했어요",
  "own.upd.servers": "로컬 모델 서버",
  "own.upd.serversNote": "버전만 보여 드려요. 업데이트는 각 프로그램에서 해 주세요.",
  "own.upd.serverVersion": "버전 {version}",
  "own.upd.serverUnknown": "버전을 알려 주지 않아요",
  "own.upd.hosts": "SSH 호스트",
  "own.upd.hostsNote":
    "own이 호스트에 올린 것(own 원격 번들과 git-lfs {lfs})은 own의 호스트 업데이트로만 바뀌어요. 다른 명령은 실행하지 않아요.",
  "own.upd.hostsNone": "연결한 SSH 호스트가 없어요",
  "own.upd.hostVersion": "호스트의 own {remote} · 이 PC {local}",
  "own.upd.hostNotInstalled": "아직 설치하지 않았어요",
  "own.upd.hostCurrent": "이 PC와 같은 판",
  "own.upd.hostSkew": "판이 달라서 이 호스트의 대화가 멈춰 있어요",
  "own.upd.hostUpdate": "호스트 업데이트",
  "own.upd.confirm.title": "{name} 업데이트",
  "own.upd.confirm.lead": "아래 명령을 이 PC에서 실행해요. 관리자 권한은 쓰지 않아요.",
  "own.upd.confirm.versions": "{installed} → {latest}",
  "own.upd.confirm.run": "실행",
  "own.upd.confirm.cancel": "취소",
  "own.upd.confirm.close": "닫기",
  "own.upd.job.running": "실행 중 · {elapsed}",
  "own.upd.job.downloading": "내려받는 중 · {size} · {elapsed}",
  "own.upd.job.checking": "실행이 끝났어요. 버전을 다시 읽는 중…",
  "own.upd.job.note":
    "큰 업데이트는 몇 분 걸릴 수 있어요. 이 창을 닫아도 업데이트는 계속돼요. 설정 > 업데이트에서 다시 열면 이어서 보여요.",
  "own.upd.job.slow":
    "{minutes}분이 넘었어요. 내려받은 크기가 계속 늘고 있으면 조금 더 기다려 주세요. {limit}분이 지나도 끝나지 않으면 own이 멈춰요.",
  "own.upd.job.slowNoSize":
    "{minutes}분이 넘었어요. 출력이 오래 그대로면 네트워크를 확인해 주세요. {limit}분이 지나도 끝나지 않으면 own이 멈춰요.",
  "own.upd.job.timedOut": "{limit}분이 지나도 끝나지 않아 own이 멈췄어요. 출력을 확인하고 터미널에서 직접 실행해 보세요.",
  "own.upd.job.attached": "이미 실행 중인 업데이트예요. 이어서 보여 드려요:",
  "own.upd.job.took": "걸린 시간 {elapsed}",
  "own.upd.job.tookSize": "걸린 시간 {elapsed} · 내려받은 크기 {size}",
  "own.upd.time.s": "{s}초",
  "own.upd.time.ms": "{m}분 {s}초",
  "own.upd.time.hm": "{h}시간 {m}분",
  "own.upd.progress": "진행 보기",
  "own.upd.job.done": "끝났어요. 지금 버전: {after}",
  "own.upd.job.same": "끝났어요. 버전은 그대로예요({after})",
  "own.upd.job.failed": "실패했어요(종료 코드 {code}). 출력을 확인하고 직접 실행해 보세요.",
  "own.upd.job.blocked":
    "Windows가 실행을 막았어요(스마트 앱 컨트롤이나 백신). own은 이를 우회하지 않아요. 공식 안내대로 직접 업데이트해 주세요.",
  "own.upd.job.output": "출력",
  "own.upd.error.busy": "다른 업데이트가 실행 중이에요",
  "own.upd.error.manual": "own이 실행하지 않는 업데이트예요. 안내대로 직접 해 주세요.",
  "own.upd.error.expired": "확인 시간이 지났어요. 다시 눌러 주세요.",
  "own.upd.error.other": "업데이트를 시작하지 못했어요: {error}",
  "own.upd.error.status": "진행 상황을 읽지 못했어요: {error}",
  "own.upd.error.lost":
    "own 서비스가 다시 시작돼서 진행 상황을 잃었어요. 잠시 뒤 설정 > 업데이트에서 지금 확인을 눌러 버전을 확인해 주세요.",
  "own.upd.notice": "Claude Code {installed}: {why}",
  "own.upd.notice.dismiss": "닫기",
} as const satisfies Record<string, string>

export type ToolUpdatesKey = keyof typeof toolUpdatesKo

export const toolUpdatesEn: Partial<Record<ToolUpdatesKey, string>> = {
  "own.upd.lead":
    "Programs own runs on this PC. You install and update them apart from own. own reads their versions and runs an official update command only when you click.",
  "own.upd.check": "Check for new versions",
  "own.upd.checkNote":
    "Once a day, reads only the newest version numbers from the npm registry and GitHub releases. No login is sent.",
  "own.upd.on": "On",
  "own.upd.off": "Off",
  "own.upd.refresh": "Check now",
  "own.upd.checkedAt": "Last checked: {time}",
  "own.upd.neverChecked": "Not checked yet",
  "own.upd.checkOff": "Checking is off, so the newest versions are not shown",
  "own.upd.failed": "Could not read the newest version of: {names}",
  "own.upd.loading": "Reading versions…",
  "own.upd.loadFailed": "Could not read the versions: {error}",
  "own.upd.localOnly": "Tool updates are shown only in this PC's windows",
  "own.upd.installed": "Installed {version}",
  "own.upd.installedUnknown": "Installed (version unreadable)",
  "own.upd.latest": "Newest {version}",
  "own.upd.latestUnknown": "Newest unknown",
  "own.upd.path": "At {path}",
  "own.upd.status.current": "Up to date",
  "own.upd.status.recommended": "Update recommended",
  "own.upd.status.required": "Required",
  "own.upd.status.missing": "Not installed",
  "own.upd.status.unknown": "Check needed",
  "own.upd.why.claude_verbatim":
    "Claude Agent conversations refuse Claude Code older than {minimum} (it may read your text as Claude commands).",
  "own.upd.why.claude_context":
    "Older than {version}: the models' context sizes cannot be asked, so conservative ones are used.",
  "own.upd.why.claude_sdk":
    "Older than Claude Code {version}, the one own's Claude Agent is built for. Conversations run, but some features may be missing or behave differently.",
  "own.upd.why.git_team": "Older than Git {version}: team mode cannot be turned on.",
  "own.upd.why.git_sparse": "Older than Git {version}: team mode makes full worktrees with every large file.",
  "own.upd.why.lfs_security":
    "Misses the security fixes of git-lfs {version} (4 CVEs), which matter when team mode works in repositories others made.",
  "own.upd.why.rg_pinned": "Older than ripgrep {version}, the one own tested. The one on PATH is used first.",
  "own.upd.why.newer": "Version {latest} is out.",
  "own.upd.why.not_installed": "Not found on this PC. own does not install it.",
  "own.upd.why.unreadable": "Its version could not be read. Check whether it is blocked.",
  "own.upd.why.own_copy": "Not on PATH, so own uses its own ripgrep {version}. It follows own's updates.",
  "own.upd.reviewed":
    "own reviewed the read tools of version {version} one by one. Other versions are split into reads and writes by their tool hints.",
  "own.upd.update": "Update",
  "own.upd.manual.elevation":
    "Installed for all users, so it needs administrator rights. own never runs anything as administrator. Run it yourself.",
  "own.upd.manual.bundled": "The git-lfs inside Git for Windows. It changes when Git is updated.",
  "own.upd.manual.interactive": "The updater asks questions in a console. Run it in a terminal yourself.",
  "own.upd.manual.no_updater": "It has no update command. Get the new version from the official page.",
  "own.upd.manual.script": "Installed as a command script (.cmd). Run it in a terminal yourself.",
  "own.upd.manual.not_installed": "Install it yourself from the official page.",
  "own.upd.command": "Command to run yourself",
  "own.upd.source": "Official page",
  "own.upd.copy": "Copy",
  "own.upd.copied": "Copied",
  "own.upd.servers": "Local model servers",
  "own.upd.serversNote": "Versions only. Update them in each program.",
  "own.upd.serverVersion": "Version {version}",
  "own.upd.serverUnknown": "Does not report a version",
  "own.upd.hosts": "SSH hosts",
  "own.upd.hostsNote":
    "What own put on a host (own's remote bundle and git-lfs {lfs}) changes only with own's host update. No other command runs there.",
  "own.upd.hostsNone": "No SSH hosts",
  "own.upd.hostVersion": "own {remote} on the host · {local} on this PC",
  "own.upd.hostNotInstalled": "Not installed yet",
  "own.upd.hostCurrent": "Same version as this PC",
  "own.upd.hostSkew": "Versions differ, so this host's conversations are paused",
  "own.upd.hostUpdate": "Update host",
  "own.upd.confirm.title": "Update {name}",
  "own.upd.confirm.lead": "Runs this command on this PC. No administrator rights are used.",
  "own.upd.confirm.run": "Run",
  "own.upd.confirm.cancel": "Cancel",
  "own.upd.confirm.close": "Close",
  "own.upd.job.running": "Running · {elapsed}",
  "own.upd.job.downloading": "Downloading · {size} · {elapsed}",
  "own.upd.job.checking": "The command ended. Reading the version again…",
  "own.upd.job.note":
    "A large update can take several minutes. Closing this window does not stop it; open it again from Settings > Updates to follow it.",
  "own.upd.job.slow":
    "Over {minutes} minutes. If the downloaded size still grows, give it a little longer. own stops it after {limit} minutes.",
  "own.upd.job.slowNoSize":
    "Over {minutes} minutes. If the output has not changed for long, check the network. own stops it after {limit} minutes.",
  "own.upd.job.timedOut": "Still running after {limit} minutes, so own stopped it. Check the output and try running it in a terminal.",
  "own.upd.job.attached": "An update is already running. Following it:",
  "own.upd.job.took": "Took {elapsed}",
  "own.upd.job.tookSize": "Took {elapsed} · downloaded {size}",
  "own.upd.time.s": "{s}s",
  "own.upd.time.ms": "{m}m {s}s",
  "own.upd.time.hm": "{h}h {m}m",
  "own.upd.progress": "Show progress",
  "own.upd.job.done": "Done. Now {after}",
  "own.upd.job.same": "Done. The version is still {after}",
  "own.upd.job.failed": "Failed (exit code {code}). Check the output and try running it yourself.",
  "own.upd.job.blocked":
    "Windows blocked it (Smart App Control or an antivirus). own never works around that. Update it yourself as the official page says.",
  "own.upd.job.output": "Output",
  "own.upd.error.busy": "Another update is running",
  "own.upd.error.manual": "own does not run this update. Follow the steps yourself.",
  "own.upd.error.expired": "The confirmation expired. Click again.",
  "own.upd.error.other": "Could not start the update: {error}",
  "own.upd.error.status": "Could not read the progress: {error}",
  "own.upd.error.lost":
    "The own service restarted, so the progress is gone. In a moment, use Check now in Settings > Updates to see the version.",
  "own.upd.notice.dismiss": "Dismiss",
}

export const toolUpdatesText = featureText(toolUpdatesKo, toolUpdatesEn)
export const useToolUpdatesText = toolUpdatesText.use
export type ToolUpdatesText = ReturnType<typeof useToolUpdatesText>

/** Product names; not translated. */
export const TOOL_NAMES = {
  "claude-code": "Claude Code",
  git: "Git",
  "git-lfs": "git-lfs",
  gh: "GitHub CLI (gh)",
  ripgrep: "ripgrep",
  "github-mcp-server": "github-mcp-server",
} as const
