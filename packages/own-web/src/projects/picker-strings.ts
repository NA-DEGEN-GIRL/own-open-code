// The folder pickers' words for listing problems, locked folders and `새 폴더` (03 §18.3, 04 §17.4): a catalog of its
// own so they load with the pickers, not in the first chunk. Same rules as the projects catalog (`own.project.*`).
import { catalogText, useCatalogText } from "./text"

export const pickerKo = {
  "own.picker.list.denied": "이 폴더는 읽을 권한이 없어요 (소유자: {owner}).",
  "own.picker.list.deniedNoOwner": "이 폴더는 읽을 권한이 없어요.",
  "own.picker.list.missing": "이 경로에 폴더가 없어요: {path}",
  "own.picker.list.not_folder": "폴더가 아니에요 (파일이에요): {path}",
  "own.picker.list.relative": "절대 경로를 입력하세요. 지금 보는 폴더 안의 이름만 입력해도 돼요.",
  "own.picker.list.failed": "이 폴더를 읽지 못했어요. 잠시 뒤 다시 해 보세요.",
  "own.picker.locked": "읽을 권한이 없어요 (소유자: {owner})",
  "own.picker.lockedNoOwner": "읽을 권한이 없어요",
  "own.picker.hidden": "프로젝트가 될 수 없는 시스템 폴더 {n}개는 숨겼어요. 경로를 입력하면 열 수 있어요.",
  "own.picker.newFolder": "새 폴더",
  "own.picker.newFolder.label": "새 폴더 이름",
  "own.picker.newFolder.make": "만들기",
  "own.picker.newFolder.cancel": "취소",
  "own.picker.newFolder.making": "만드는 중…",
  "own.picker.create.name": "폴더 이름으로 쓸 수 없어요. `/` 없이 폴더 이름 하나만 입력하세요.",
  "own.picker.create.exists": "같은 이름이 이미 있어요.",
  "own.picker.create.openExisting": "그 폴더 열기",
  "own.picker.create.relative": "지금 보는 폴더가 절대 경로가 아니에요. 다시 열어 보세요.",
  "own.picker.create.missing": "지금 보는 폴더가 없어졌어요. 다시 열어 보세요.",
  "own.picker.create.not_folder": "지금 보는 경로가 폴더가 아니에요. 다시 열어 보세요.",
  "own.picker.create.denied": "이 폴더 안에는 새 폴더를 만들 권한이 없어요.",
  "own.picker.create.failed": "폴더를 만들지 못했어요. 잠시 뒤 다시 해 보세요.",
  "own.picker.create.unsupported": "이 서버의 서비스가 오래돼서 여기서 폴더를 만들 수 없어요. 서버를 업데이트하세요.",
} as const

export type PickerKey = keyof typeof pickerKo

export const pickerEn: Partial<Record<PickerKey, string>> = {
  "own.picker.list.denied": "You have no permission to read this folder (owner: {owner}).",
  "own.picker.list.deniedNoOwner": "You have no permission to read this folder.",
  "own.picker.list.missing": "There is no folder at this path: {path}",
  "own.picker.list.not_folder": "This is not a folder (it is a file): {path}",
  "own.picker.list.relative": "Type an absolute path, or just a name inside the folder shown.",
  "own.picker.list.failed": "Could not read this folder. Try again in a moment.",
  "own.picker.locked": "No permission to read (owner: {owner})",
  "own.picker.lockedNoOwner": "No permission to read",
  "own.picker.hidden": "{n} system folders that are never a project are hidden. Type their path to open one.",
  "own.picker.newFolder": "New folder",
  "own.picker.newFolder.label": "New folder name",
  "own.picker.newFolder.make": "Create",
  "own.picker.newFolder.cancel": "Cancel",
  "own.picker.newFolder.making": "Creating…",
  "own.picker.create.name": "That cannot be a folder name. Type one folder name without `/`.",
  "own.picker.create.exists": "Something with this name is already there.",
  "own.picker.create.openExisting": "Open that folder",
  "own.picker.create.relative": "The folder shown is not an absolute path. Open it again.",
  "own.picker.create.missing": "The folder shown is gone. Open it again.",
  "own.picker.create.not_folder": "The path shown is not a folder. Open it again.",
  "own.picker.create.denied": "You have no permission to make a folder here.",
  "own.picker.create.failed": "Could not make the folder. Try again in a moment.",
  "own.picker.create.unsupported": "This server's service is too old to make folders here. Update the server.",
}

export const pickerText = catalogText(pickerKo, pickerEn)

export function usePickerText() {
  return useCatalogText(pickerText)
}
