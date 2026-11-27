// 설정 > 일반 `기본 대화 폴더` (03 §5.1) and `폴더 열기 시작 위치` (03 §18.3): the rows' words, a catalog of its own so
// they load with the settings page, not in the first chunk. Same rules as the projects catalog (`own.project.*`).
import { catalogText, useCatalogText } from "./text"

export const folderSettingsKo = {
  "own.project.folderSetting.title": "기본 대화 폴더",
  "own.project.folderSetting.note":
    "폴더를 고르지 않고 시작한 대화가 이 폴더에서 일해요. 이 PC의 서비스에 저장돼서 휴대폰과 다른 PC에서 시작한 대화도 같은 폴더를 써요.",
  "own.project.folderSetting.default": "기본값",
  "own.project.folderSetting.notYet": "아직 없어요. 폴더 없이 첫 대화를 시작할 때 만들어요.",
  "own.project.folderSetting.change": "바꾸기…",
  "own.project.folderSetting.reset": "기본값으로",
  "own.project.folderSetting.path": "폴더 경로",
  "own.project.folderSetting.save": "저장",
  "own.project.folderSetting.cancel": "취소",
  "own.project.folderSetting.saved": "기본 대화 폴더를 바꿨어요. 다음 대화부터 이 폴더에서 일해요.",
  "own.project.folderSetting.resetDone": "기본 대화 폴더를 기본값으로 되돌렸어요.",
  "own.project.folderSetting.readOnly": "이 기기에서는 바꿀 수 없어요. PC의 앱 창에서 바꿔 주세요.",
  "own.project.folderSetting.unavailable":
    "이 서비스는 기본 대화 폴더를 아직 몰라요. 서비스를 새 버전으로 다시 시작하세요.",
  "own.project.folderSetting.failed": "바꾸지 못했어요. 다시 해 보세요.",
  "own.project.folderSetting.problem.relative": "절대 경로를 입력하세요 (예: D:\\work\\chats).",
  "own.project.folderSetting.problem.root": "드라이브 전체는 고를 수 없어요. 그 아래의 폴더를 고르세요.",
  "own.project.folderSetting.problem.home": "홈 폴더 전체나 그 위의 폴더는 고를 수 없어요. 그 아래의 폴더를 고르세요.",
  "own.project.folderSetting.problem.app": "이 앱이 쓰는 폴더예요. 다른 폴더를 고르세요.",
  "own.project.folderSetting.problem.not_folder": "같은 이름의 파일이 있어요. 다른 경로를 고르세요.",
  "own.project.folderSetting.problem.create_failed": "이 폴더를 만들지 못했어요. 드라이브와 권한을 확인하세요.",
  "own.project.folderSetting.problem.not_writable": "이 폴더에 파일을 쓸 수 없어요. 다른 폴더를 고르세요.",
  "own.project.folderSetting.hostTitle": "새 대화 폴더",
  "own.project.folderSetting.hostNote":
    "폴더를 고르지 않고 이 호스트에서 시작한 대화가 이 폴더에서 일해요. 호스트의 서비스에 저장돼서 휴대폰과 다른 창에서도 같아요. `~/…`처럼 홈 폴더 기준으로 적어도 돼요.",
  "own.project.folderSetting.hostUnavailable":
    "이 호스트의 서비스는 기본 대화 폴더를 아직 몰라요. 호스트를 업데이트하세요.",
  "own.project.folderSetting.hostOffline": "호스트에 연결하면 보고 바꿀 수 있어요.",
  "own.project.folderSetting.hostProblem.relative": "절대 경로나 `~/…`를 입력하세요 (예: ~/own-chats).",
  "own.project.startSetting.title": "폴더 열기 시작 위치",
  "own.project.startSetting.note":
    "폴더 열기 창이 처음 보여 줄 곳이에요. 데스크톱의 폴더 선택 창과 앱 안의 폴더 열기 창이 같이 써요.",
  "own.project.startSetting.recent": "마지막으로 연 폴더의 상위 폴더",
  "own.project.startSetting.custom": "직접 지정",
  "own.project.startSetting.now": "지금은 이 폴더에서 열려요: {path}",
  "own.project.startSetting.home": "아직 연 폴더가 없어서 홈 폴더에서 열려요: {path}",
  "own.project.startSetting.saved": "폴더 열기 시작 위치를 바꿨어요.",
  "own.project.startSetting.resetDone": "폴더 열기 시작 위치를 기본값으로 되돌렸어요.",
  "own.project.startSetting.problem.relative": "절대 경로를 입력하세요 (예: D:\\projects).",
  "own.project.startSetting.problem.missing": "그 폴더가 없어요. 경로를 확인하세요.",
  "own.project.startSetting.problem.not_folder": "폴더가 아니에요. 다른 경로를 고르세요.",
} as const satisfies Record<string, string>

export type FolderSettingsKey = keyof typeof folderSettingsKo

export const folderSettingsEn: Partial<Record<FolderSettingsKey, string>> = {
  "own.project.folderSetting.title": "Default conversation folder",
  "own.project.folderSetting.note":
    "Conversations started without choosing a folder work here. It is kept on this PC's service, so conversations started on a phone or another PC use it too.",
  "own.project.folderSetting.default": "Default",
  "own.project.folderSetting.notYet":
    "Not created yet. It is created when the first conversation without a folder starts.",
  "own.project.folderSetting.change": "Change…",
  "own.project.folderSetting.reset": "Use default",
  "own.project.folderSetting.path": "Folder path",
  "own.project.folderSetting.save": "Save",
  "own.project.folderSetting.cancel": "Cancel",
  "own.project.folderSetting.saved": "Default conversation folder changed. The next conversations work there.",
  "own.project.folderSetting.resetDone": "Default conversation folder is back to the default.",
  "own.project.folderSetting.readOnly": "This device cannot change it. Change it in the app window on the PC.",
  "own.project.folderSetting.unavailable":
    "This service does not know the default conversation folder yet. Restart the service on the new version.",
  "own.project.folderSetting.failed": "Could not change it. Try again.",
  "own.project.folderSetting.problem.relative": "Type an absolute path (for example D:\\work\\chats).",
  "own.project.folderSetting.problem.root": "A whole drive cannot be chosen. Choose a folder inside it.",
  "own.project.folderSetting.problem.home":
    "Your whole home folder or a folder above it cannot be chosen. Choose a folder inside it.",
  "own.project.folderSetting.problem.app": "This app uses this folder. Choose another folder.",
  "own.project.folderSetting.problem.not_folder": "A file has this name. Choose another path.",
  "own.project.folderSetting.problem.create_failed": "Could not create this folder. Check the drive and permissions.",
  "own.project.folderSetting.problem.not_writable": "Files cannot be written in this folder. Choose another folder.",
  "own.project.folderSetting.hostTitle": "New conversation folder",
  "own.project.folderSetting.hostNote":
    "Conversations started on this host without choosing a folder work in this folder. The host's service keeps it, so phones and other windows agree. You can write it from the home folder, like `~/…`.",
  "own.project.folderSetting.hostUnavailable":
    "This host's service does not know a default conversation folder yet. Update the host.",
  "own.project.folderSetting.hostOffline": "Connect the host to see and change it.",
  "own.project.folderSetting.hostProblem.relative": "Type an absolute path or `~/…` (for example ~/own-chats).",
  "own.project.startSetting.title": "Folder picker starts in",
  "own.project.startSetting.note":
    "Where the open-folder window starts: the desktop's folder dialog and the in-app picker use it.",
  "own.project.startSetting.recent": "Parent of the last opened folder",
  "own.project.startSetting.custom": "Choose",
  "own.project.startSetting.now": "It opens here now: {path}",
  "own.project.startSetting.home": "No folder was opened yet, so it opens in your home folder: {path}",
  "own.project.startSetting.saved": "Folder picker start changed.",
  "own.project.startSetting.resetDone": "Folder picker start is back to the default.",
  "own.project.startSetting.problem.relative": "Type an absolute path (for example D:\\projects).",
  "own.project.startSetting.problem.missing": "That folder does not exist. Check the path.",
  "own.project.startSetting.problem.not_folder": "That is not a folder. Choose another path.",
}

export const folderSettingsText = catalogText(folderSettingsKo, folderSettingsEn)

export function useFolderSettingsText() {
  return useCatalogText(folderSettingsText)
}
