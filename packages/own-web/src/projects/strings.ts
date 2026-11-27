// Project open strings (03 §18.3). Kept in this folder so the module does not edit the shared catalogs; keys use the
// `own.project.*` namespace and can move verbatim into src/i18n/ko.ts / en.ts (append-only section "projects").
// Keys that 03 §14 already defines (`own.folder.*`) come from the shared catalog through `useI18n().t`.
import { catalogText, useCatalogText } from "./text"

export const projectsKo = {
  "own.project.title": "폴더 열기",
  "own.project.pathHint": "절대 경로를 입력하거나 붙여 넣고 Enter",
  "own.project.go": "이동",
  "own.project.up": "상위 폴더",
  "own.project.recent": "최근 폴더",
  "own.project.roots": "드라이브",
  "own.project.crumbs": "현재 위치",
  "own.project.list": "하위 폴더",
  "own.project.count": "폴더 {n}개",
  "own.project.loading": "폴더를 읽는 중…",
  "own.project.empty": "하위 폴더가 없어요",
  "own.project.noMatch": '"{query}"(와)과 맞는 폴더가 없어요',
  "own.project.failed": "이 경로를 읽지 못했어요. 경로가 있고 폴더인지 확인하세요.",
  "own.project.noControl": "서버의 폴더 목록을 아직 볼 수 없어요. 절대 경로를 입력하세요.",
  "own.project.relative": "절대 경로를 입력하세요 (예: D:\\work\\app)",
  "own.project.choose": "이 폴더 선택",
  "own.project.cancel": "취소",
  "own.project.confirmTitle": "이 폴더에서 시작할까요?",
  "own.project.checking": "확인하는 중…",
  "own.project.git": "Git 저장소 · {branch}",
  "own.project.gitNoBranch": "Git 저장소",
  "own.project.noGit": "Git 저장소가 아니에요. 리뷰에서는 마지막 턴의 변경만 볼 수 있어요.",
  "own.project.trustBlocked":
    "승인되지 않은 프로젝트 플러그인 {n}개가 있어요. 승인하기 전에는 이 폴더의 대화에 계정 인증을 보내지 않아요.",
  "own.project.trustReview": "플러그인 확인…",
  "own.project.tooBroad.root": "드라이브 전체는 프로젝트로 열 수 없어요. 그 아래의 프로젝트 폴더를 고르세요.",
  "own.project.tooBroad.home": "홈 폴더 전체는 프로젝트로 열 수 없어요. 그 아래의 프로젝트 폴더를 고르세요.",
  "own.project.tooBroad.control": "이 앱이 관리용으로 쓰는 폴더예요. 프로젝트 폴더를 고르세요.",
  "own.project.back": "다른 폴더 고르기",
  "own.project.resolveFailed": "이 폴더를 열지 못했어요.",
  // The folder flow is running (native dialog or loading the chosen folder): entry points show this instead.
  "own.project.opening": "여는 중…",
  "own.project.dialogFailed": "폴더 선택 창을 열지 못했어요. 다시 시도하세요.",
  "own.project.select": "프로젝트",
  "own.project.selectNone": "프로젝트 고르기",
  "own.project.selectEmpty": "최근 프로젝트가 없어요",
  // 03 §8 세션 폴더 없음: the same picker chooses where a session whose folder is gone continues.
  "own.project.move.title": "대화 폴더 고르기",
  "own.project.move.confirmTitle": "이 폴더로 대화를 옮길까요?",
  "own.project.move.start": "이 폴더로 옮기기",
  // 03 §5.1 기본 대화 폴더: a conversation started without choosing a project works in the server's default folder.
  "own.project.defaultFolder": "기본 대화 폴더",
  "own.project.noFolder": "폴더 없이 대화",
  "own.project.noFolderNote": "기본 대화 폴더에서 대화해요",
  "own.project.defaultFolderGroup": "폴더 없는 대화",
  "own.project.defaultFolder.create_failed":
    "기본 대화 폴더를 만들지 못했어요: {path}. 설정 > 일반 > 기본 대화 폴더에서 다른 폴더를 고르세요.",
  "own.project.defaultFolder.not_writable":
    "기본 대화 폴더에 파일을 쓸 수 없어요: {path}. 설정 > 일반 > 기본 대화 폴더에서 다른 폴더를 고르세요.",
  "own.project.defaultFolder.not_folder":
    "기본 대화 폴더 자리에 같은 이름의 파일이 있어요: {path}. 설정 > 일반 > 기본 대화 폴더에서 다른 폴더를 고르세요.",
  "own.project.defaultFolder.failed": "기본 대화 폴더를 준비하지 못했어요. 다시 보내 보세요.",
} as const satisfies Record<string, string>

export type ProjectsKey = keyof typeof projectsKo

export const projectsEn: Partial<Record<ProjectsKey, string>> = {
  "own.project.title": "Open folder",
  "own.project.pathHint": "Type or paste an absolute path, then press Enter",
  "own.project.go": "Go",
  "own.project.up": "Parent folder",
  "own.project.recent": "Recent",
  "own.project.roots": "Drives",
  "own.project.crumbs": "Current location",
  "own.project.list": "Subfolders",
  "own.project.count": "{n} folders",
  "own.project.loading": "Reading folder…",
  "own.project.empty": "No subfolders",
  "own.project.noMatch": 'No folder matches "{query}"',
  "own.project.failed": "Could not read this path. Check that it exists and is a folder.",
  "own.project.noControl": "The server's folder list is not available yet. Type an absolute path.",
  "own.project.relative": "Type an absolute path (for example D:\\work\\app)",
  "own.project.choose": "Choose this folder",
  "own.project.cancel": "Cancel",
  "own.project.confirmTitle": "Start in this folder?",
  "own.project.checking": "Checking…",
  "own.project.git": "Git repository · {branch}",
  "own.project.gitNoBranch": "Git repository",
  "own.project.noGit": "Not a Git repository. Review shows only the last turn's changes.",
  "own.project.trustBlocked":
    "{n} project plugins are not approved. Sessions in this folder get no account credentials until you approve them.",
  "own.project.trustReview": "Review plugins…",
  "own.project.tooBroad.root": "A whole drive cannot be a project. Choose a project folder inside it.",
  "own.project.tooBroad.home": "Your whole home folder cannot be a project. Choose a project folder inside it.",
  "own.project.tooBroad.control": "This app uses this folder internally. Choose a project folder.",
  "own.project.back": "Choose another folder",
  "own.project.resolveFailed": "Could not open this folder.",
  "own.project.opening": "Opening…",
  "own.project.dialogFailed": "Could not open the folder dialog. Try again.",
  "own.project.select": "Project",
  "own.project.selectNone": "Choose a project",
  "own.project.selectEmpty": "No recent projects",
  "own.project.move.title": "Choose the session's folder",
  "own.project.move.confirmTitle": "Move the session to this folder?",
  "own.project.move.start": "Move here",
  "own.project.defaultFolder": "Default conversation folder",
  "own.project.noFolder": "Chat without a folder",
  "own.project.noFolderNote": "Works in the default conversation folder",
  "own.project.defaultFolderGroup": "Conversations without a folder",
  "own.project.defaultFolder.create_failed":
    "Could not create the default conversation folder: {path}. Choose another folder in Settings > General > Default conversation folder.",
  "own.project.defaultFolder.not_writable":
    "Cannot write files in the default conversation folder: {path}. Choose another folder in Settings > General > Default conversation folder.",
  "own.project.defaultFolder.not_folder":
    "A file is in the way of the default conversation folder: {path}. Choose another folder in Settings > General > Default conversation folder.",
  "own.project.defaultFolder.failed": "Could not prepare the default conversation folder. Try sending again.",
}

export const projectsText = catalogText(projectsKo, projectsEn)

export function useProjectsText() {
  return useCatalogText(projectsText)
}
