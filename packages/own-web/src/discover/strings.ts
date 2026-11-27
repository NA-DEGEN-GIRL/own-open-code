// Strings of the entry points that make team mode, worktrees and settings easy to find (03 §4.3.1): the project row's
// `팀` and `⑂` buttons, the not-Git notes, the header and footer settings buttons, the first-run hints and their palette
// commands. First chunk and small. Kept in this folder so the module does not edit the shared catalogs; the keys use
// the `own.discover.*` namespace and can move verbatim into src/i18n/ko.ts / en.ts (append-only section "discover").
import { featureText } from "@/queue/text"

export const discoverKo = {
  "own.discover.team": "팀",
  "own.discover.team.view": "팀 보기",
  "own.discover.team.enableHint": "팀 모드 켜기…",
  "own.discover.team.menu": "{project}의 팀 모드",
  "own.discover.team.enable": "팀 모드 켜기…",
  "own.discover.worktree": "작업 폴더",
  "own.discover.worktree.menu": "{project}의 작업 폴더",
  "own.discover.worktree.about": "같은 프로젝트를 따로 꺼내 둔 폴더예요. 대화끼리 서로의 파일을 건드리지 않아요.",
  "own.discover.worktree.openIn": "⑂ {name}에서 새 대화",
  "own.discover.worktree.none": "아직 작업 폴더가 없어요",
  "own.discover.notGit.team":
    "팀 모드는 Git 저장소인 프로젝트에서만 켤 수 있어요. 이 폴더를 Git 저장소로 만들면 쓸 수 있어요.",
  "own.discover.notGit.worktree":
    "작업 폴더는 Git 저장소인 프로젝트에서만 만들 수 있어요. 이 폴더를 Git 저장소로 만들면 쓸 수 있어요.",
  "own.discover.notGit.both": "팀 모드와 작업 폴더는 Git 저장소인 프로젝트에서만 쓸 수 있어요.",
  "own.discover.notGit.palette.team": "팀 모드 켜기 (Git 저장소에서만)",
  "own.discover.notGit.palette.worktree": "새 작업 폴더에서 새 대화 (Git 저장소에서만)",
  "own.discover.gitInit.action": "Git 저장소로 만들기…",
  "own.discover.gitInit.palette": "Git 저장소로 만들기… (팀 모드·작업 폴더 쓰기)",
  "own.discover.defaultFolder.team":
    "기본 대화 폴더는 폴더 없는 대화가 함께 쓰는 곳이라 Git 저장소로 만들지 않아요. 팀 모드는 프로젝트 폴더를 열어 거기서 켜세요.",
  "own.discover.defaultFolder.worktree":
    "기본 대화 폴더는 폴더 없는 대화가 함께 쓰는 곳이라 Git 저장소로 만들지 않아요. 작업 폴더는 프로젝트 폴더를 열어 거기서 만드세요.",
  "own.discover.defaultFolder.both":
    "기본 대화 폴더는 폴더 없는 대화가 함께 쓰는 곳이라 Git 저장소로 만들지 않아요. 팀 모드와 작업 폴더는 프로젝트 폴더를 열어 거기서 쓰세요.",
  "own.discover.defaultFolder.open": "프로젝트 폴더 열기…",
  "own.discover.settings": "설정",
  "own.discover.settings.open": "설정 열기 ({keys})",
  "own.discover.hints.title": "알아 두면 좋은 것",
  "own.discover.hints.team":
    "팀 모드: Git 프로젝트 줄의 [팀] 단추나 ⋯ › 팀 모드 켜기. 팀 메인이 일을 영역으로 나눠 맡겨요.",
  "own.discover.hints.worktree": "작업 폴더: 프로젝트 줄의 [⑂] 단추나 새 대화 입력창의 ⑂ 작업 위치 단추에서 만들어요.",
  "own.discover.hints.settings": "설정: 왼쪽 아래 [설정]이나 머리줄의 톱니바퀴, 단축키 {keys}. 모든 명령: {palette}",
  "own.discover.hints.settingsTouch": "설정: 머리줄의 톱니바퀴나 대화 목록 아래의 [설정]",
  "own.discover.hints.notGit": "{project}(은)는 Git 저장소가 아니라서 팀 모드와 작업 폴더를 쓸 수 없어요.",
  "own.discover.hints.defaultFolder":
    "기본 대화 폴더는 폴더 없는 대화가 함께 쓰는 곳이라 팀 모드와 작업 폴더가 없어요. 프로젝트 폴더를 열어 거기서 쓰세요.",
  "own.discover.hints.close": "안내 닫기",
  "own.discover.hints.reopen": "처음 안내 다시 보기",
  "own.discover.hints.manual": "설명서: 머리줄의 [?] 단추나 설정 목록의 설명서. 인터넷 없이 열려요.",
  "own.discover.hints.teamChapter": "설명서 17장",
  "own.discover.manual": "설명서",
  "own.discover.manual.open": "설명서 열기",
  "own.discover.manual.title": "Own OpenCode 설명서",
  "own.discover.manual.close": "설명서 닫기",
  "own.discover.manual.chapter": "설명서: {chapter}",
  "own.discover.manual.settings": "설정 화면",
  "own.discover.manual.layout": "분할 화면",
  "own.discover.manual.desktop": "확대·축소",
  "own.discover.manual.presets": "프리셋",
  "own.discover.manual.policy": "자동 전환",
  "own.discover.manual.compaction": "자동 압축",
  "own.discover.manual.output": "출력 상한",
  "own.discover.manual.approval": "승인 모드",
  "own.discover.manual.shell": "터미널",
  "own.discover.manual.experimental": "컴퓨터 사용",
  "own.discover.manual.devices": "휴대폰·다른 PC",
  "own.discover.manual.remote": "SSH 원격",
  "own.discover.manual.server": "설치·서비스",
  "own.discover.manual.plugins": "프로젝트 플러그인",
  "own.discover.manual.import": "다른 도구의 대화",
  "own.discover.manual.harness": "에이전트 방식",
  "own.discover.manual.prompts": "지시문 보기·고치기",
  "own.discover.manual.skills": "스킬",
  "own.discover.manual.mcp": "MCP 서버",
  "own.discover.manual.github": "GitHub 연결",
  "own.discover.manual.updates": "외부 도구 업데이트",
  "own.discover.manual.creator": "확장 만들기",
  "own.discover.manual.websearch": "웹 검색",
  "own.discover.manual.image": "이미지 만들기",
  "own.discover.manual.voice": "음성 입력",
  "own.discover.manual.team": "팀 모드",
  "own.discover.manual.shortcuts": "단축키",
} as const satisfies Record<string, string>

export type DiscoverKey = keyof typeof discoverKo

export const discoverEn: Partial<Record<DiscoverKey, string>> = {
  "own.discover.team": "Team",
  "own.discover.team.view": "Show team",
  "own.discover.team.enableHint": "Turn on team mode…",
  "own.discover.team.menu": "Team mode of {project}",
  "own.discover.team.enable": "Turn on team mode…",
  "own.discover.worktree": "Work folders",
  "own.discover.worktree.menu": "Work folders of {project}",
  "own.discover.worktree.about":
    "A separate copy of the same project, so conversations do not touch each other's files.",
  "own.discover.worktree.openIn": "New conversation in ⑂ {name}",
  "own.discover.worktree.none": "No work folders yet",
  "own.discover.notGit.team":
    "Team mode needs a project that is a Git repository. Make this folder a Git repository to use it.",
  "own.discover.notGit.worktree":
    "Work folders need a project that is a Git repository. Make this folder a Git repository to use them.",
  "own.discover.notGit.both": "Team mode and work folders need a project that is a Git repository.",
  "own.discover.notGit.palette.team": "Turn on team mode (Git repositories only)",
  "own.discover.notGit.palette.worktree": "New conversation in a new work folder (Git repositories only)",
  "own.discover.gitInit.action": "Make it a Git repository…",
  "own.discover.gitInit.palette": "Make it a Git repository… (for team mode and work folders)",
  "own.discover.defaultFolder.team":
    "Every conversation without a folder shares the default conversation folder, so it is not made a Git repository. Open a project folder to turn on team mode there.",
  "own.discover.defaultFolder.worktree":
    "Every conversation without a folder shares the default conversation folder, so it is not made a Git repository. Open a project folder to make work folders there.",
  "own.discover.defaultFolder.both":
    "Every conversation without a folder shares the default conversation folder, so it is not made a Git repository. Open a project folder to use team mode and work folders there.",
  "own.discover.defaultFolder.open": "Open a project folder…",
  "own.discover.settings": "Settings",
  "own.discover.settings.open": "Open settings ({keys})",
  "own.discover.hints.title": "Good to know",
  "own.discover.hints.team":
    "Team mode: the [Team] button on a Git project's row, or ⋯ › Turn on team mode. The team main splits the work into areas.",
  "own.discover.hints.worktree":
    "Work folders: the [⑂] button on a project's row, or the ⑂ work location button in the new-conversation composer.",
  "own.discover.hints.settings":
    "Settings: [Settings] at the bottom left or the gear in the header, shortcut {keys}. Every command: {palette}",
  "own.discover.hints.settingsTouch": "Settings: the gear in the header, or [Settings] under the conversation list",
  "own.discover.hints.notGit": "{project} is not a Git repository, so team mode and work folders are not available.",
  "own.discover.hints.defaultFolder":
    "Conversations without a folder share the default conversation folder, so team mode and work folders are not available there. Open a project folder to use them.",
  "own.discover.hints.close": "Close tips",
  "own.discover.hints.reopen": "Show the getting-started tips again",
  "own.discover.hints.manual":
    "Manual: the [?] button in the header or Manual in the settings list. It opens without internet.",
  "own.discover.hints.teamChapter": "Manual chapter 17",
  "own.discover.manual": "Manual",
  "own.discover.manual.open": "Open the manual",
  "own.discover.manual.title": "Own OpenCode manual",
  "own.discover.manual.close": "Close the manual",
  "own.discover.manual.chapter": "Manual: {chapter}",
  "own.discover.manual.settings": "The settings screen",
  "own.discover.manual.layout": "Split view",
  "own.discover.manual.desktop": "Zoom",
  "own.discover.manual.presets": "Presets",
  "own.discover.manual.policy": "Auto switching",
  "own.discover.manual.compaction": "Auto compaction",
  "own.discover.manual.output": "Output limit",
  "own.discover.manual.approval": "Approval modes",
  "own.discover.manual.shell": "Terminal",
  "own.discover.manual.experimental": "Computer use",
  "own.discover.manual.devices": "Phone & other PCs",
  "own.discover.manual.remote": "SSH remote",
  "own.discover.manual.server": "Install & service",
  "own.discover.manual.plugins": "Project plugins",
  "own.discover.manual.import": "Conversations from other tools",
  "own.discover.manual.harness": "Agent style",
  "own.discover.manual.prompts": "Viewing and editing instructions",
  "own.discover.manual.skills": "Skills",
  "own.discover.manual.mcp": "MCP servers",
  "own.discover.manual.github": "GitHub connection",
  "own.discover.manual.updates": "Tool updates",
  "own.discover.manual.creator": "Making extensions",
  "own.discover.manual.websearch": "Web search",
  "own.discover.manual.image": "Image generation",
  "own.discover.manual.voice": "Voice input",
  "own.discover.manual.team": "Team mode",
  "own.discover.manual.shortcuts": "Shortcuts",
}

export const discoverText = featureText(discoverKo, discoverEn)
export const useDiscoverText = discoverText.use
