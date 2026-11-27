// Files tab strings (03 §19.4 파일 트리·파일 탭·빠른 열기·뷰어, §19.5 에디터에서 열기·탐색기에서 보기). Kept in the files
// folder like the review and sidebar strings, so this lazy module does not add to the shared first-chunk catalogs;
// keys use the `own.files.*` namespace and can move verbatim into src/i18n/ko.ts / en.ts. `own.panel.files` (03 §14)
// stays in the shared catalog.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const filesKo = {
  "own.files.noSession": "대화를 열면 그 대화 폴더의 파일을 볼 수 있어요.",
  "own.files.tree": "파일 트리",
  "own.files.treeShow": "트리 보기",
  "own.files.treeHide": "트리 숨기기",
  "own.files.treeLoading": "폴더를 읽는 중…",
  "own.files.treeEmpty": "빈 폴더예요",
  "own.files.treeError": "폴더를 읽지 못했어요: {message}",
  "own.files.retry": "다시 시도",
  "own.files.refresh": "새로 고침",
  "own.files.quickOpen": "파일 빠른 열기",
  "own.files.quickOpenPlaceholder": "파일 이름으로 찾기 (예: router.ts:40)",
  "own.files.quickOpenResults": "찾은 파일",
  "own.files.quickOpenIndexing": "파일 색인을 만드는 중…",
  "own.files.quickOpenSearching": "찾는 중…",
  "own.files.quickOpenEmpty": "맞는 파일이 없어요",
  "own.files.quickOpenStart": "열린 파일과 최근 파일이 여기에 보여요. 파일 이름을 입력하세요.",
  "own.files.quickOpenLate": "방금 만든 파일은 10초쯤 뒤에 검색돼요",
  "own.files.quickOpenError": "파일을 찾지 못했어요: {message}",
  "own.files.badge.open": "열림",
  "own.files.badge.recent": "최근",
  "own.files.badge.changed": "변경",
  "own.files.tabs": "열린 파일",
  "own.files.close": "{name} 닫기",
  "own.files.empty": "트리에서 파일을 고르거나 Ctrl+P로 여세요.",
  "own.files.loading": "파일을 읽는 중…",
  "own.files.notFound": "파일이 없어요: {path}",
  "own.files.outside": "프로젝트 폴더 밖의 파일이라 여기서 미리 볼 수 없어요: {path}",
  "own.files.error": "파일을 읽지 못했어요: {message}",
  "own.files.binary": "미리 볼 수 없는 파일이에요 ({size})",
  "own.files.binaryUnknown": "미리 볼 수 없는 파일이에요",
  "own.files.tooLarge": "파일이 커서({size}) 자동으로 열지 않았어요.",
  "own.files.showAnyway": "그래도 보기",
  "own.files.markdownTooLarge": "문서가 커서 원본으로 보여 줘요.",
  "own.files.viewMode": "보기 방식",
  "own.files.preview": "미리보기",
  "own.files.source": "원본",
  "own.files.fit": "창에 맞추기",
  "own.files.actual": "원래 크기",
  "own.files.mediaError": "이 형식은 여기서 재생하거나 표시할 수 없어요.",
  "own.files.pdfBlocked": "이 창에서는 PDF를 표시할 수 없어요.",
  "own.files.more": "파일 동작",
  "own.files.openInEditor": "에디터에서 열기",
  "own.files.reveal": "탐색기에서 보기",
  "own.files.openFolder": "탐색기에서 열기",
  "own.files.copyPath": "경로 복사",
  "own.files.copied": "경로를 복사했어요",
  "own.files.revealInTree": "트리에서 보기",
  "own.files.openFailed": "열지 못했어요: {message}",
  "own.files.line": "{line}번째 줄",
} as const satisfies Record<string, string>

export type FilesKey = keyof typeof filesKo

export const filesEn: Partial<Record<FilesKey, string>> = {
  "own.files.noSession": "Open a session to browse the files of its folder.",
  "own.files.tree": "File tree",
  "own.files.treeShow": "Show tree",
  "own.files.treeHide": "Hide tree",
  "own.files.treeLoading": "Reading the folder…",
  "own.files.treeEmpty": "This folder is empty",
  "own.files.treeError": "Could not read the folder: {message}",
  "own.files.retry": "Try again",
  "own.files.refresh": "Refresh",
  "own.files.quickOpen": "Quick open file",
  "own.files.quickOpenPlaceholder": "Search files by name (e.g. router.ts:40)",
  "own.files.quickOpenResults": "Matching files",
  "own.files.quickOpenIndexing": "Building the file index…",
  "own.files.quickOpenSearching": "Searching…",
  "own.files.quickOpenEmpty": "No matching files",
  "own.files.quickOpenStart": "Open and recent files show here. Type a file name.",
  "own.files.quickOpenLate": "Files created just now show up in about 10 seconds",
  "own.files.quickOpenError": "Could not search files: {message}",
  "own.files.badge.open": "Open",
  "own.files.badge.recent": "Recent",
  "own.files.badge.changed": "Changed",
  "own.files.tabs": "Open files",
  "own.files.close": "Close {name}",
  "own.files.empty": "Pick a file in the tree or press Ctrl+P.",
  "own.files.loading": "Reading the file…",
  "own.files.notFound": "File not found: {path}",
  "own.files.outside": "This file is outside the project folder and cannot be previewed here: {path}",
  "own.files.error": "Could not read the file: {message}",
  "own.files.binary": "This file cannot be previewed ({size})",
  "own.files.binaryUnknown": "This file cannot be previewed",
  "own.files.tooLarge": "This file is large ({size}) and was not opened automatically.",
  "own.files.showAnyway": "Show anyway",
  "own.files.markdownTooLarge": "This document is large: showing its source.",
  "own.files.viewMode": "View",
  "own.files.preview": "Preview",
  "own.files.source": "Source",
  "own.files.fit": "Fit to pane",
  "own.files.actual": "Actual size",
  "own.files.mediaError": "This format cannot be shown here.",
  "own.files.pdfBlocked": "PDFs cannot be shown in this window.",
  "own.files.more": "File actions",
  "own.files.openInEditor": "Open in editor",
  "own.files.reveal": "Reveal in Explorer",
  "own.files.openFolder": "Open in Explorer",
  "own.files.copyPath": "Copy path",
  "own.files.copied": "Path copied",
  "own.files.revealInTree": "Show in tree",
  "own.files.openFailed": "Could not open: {message}",
  "own.files.line": "Line {line}",
}

const catalogs: Record<Locale, Partial<Record<FilesKey, string>>> = { ko: filesKo, en: filesEn }

/** Same rules as `translate` in src/i18n: current locale, Korean fallback, `{name}` params, Korean particles. */
export function filesText(locale: Locale, key: FilesKey, params?: I18nParams) {
  const template = catalogs[locale][key] ?? filesKo[key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

/** `t` for files keys in the current locale (reactive: reads the locale signal). */
export function useFilesText() {
  const i18n = useI18n()
  return (key: FilesKey, params?: I18nParams) => filesText(i18n.locale(), key, params)
}

/** File sizes in the locale (`2.1 KB`, `12 MB`), like upstream artifact-view's formatBytes. */
export function formatBytes(locale: Locale, bytes: number) {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const
  const index = Math.min(units.length - 1, bytes > 0 ? Math.floor(Math.log10(bytes) / 3) : 0)
  const value = bytes / 1000 ** index
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[index],
    unitDisplay: index === 0 ? "long" : "short",
    maximumFractionDigits: value >= 100 || index === 0 ? 0 : 1,
  }).format(value)
}
