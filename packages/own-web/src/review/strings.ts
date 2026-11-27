// Review tab strings (03 §18.5, §11 diff labels). Kept in the review folder so this module does not edit the shared
// catalogs while other modules append to them; the keys use the `own.review.*` namespace and can move verbatim into
// src/i18n/ko.ts / en.ts (append-only section "review"). Keys 03 §14 already defines (`own.review.mode.*`,
// `own.review.split`, `own.review.unified`, `own.review.noVcs`, `own.panel.review`) come from the shared catalog.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const reviewKo = {
  "own.review.modeLabel": "리뷰 범위",
  "own.review.mode.reverted": "복원으로 되돌린 파일",
  "own.review.base": "base: {name}",
  "own.review.baseLabel": "비교할 base 브랜치",
  "own.review.basePick": "base를 고르세요",
  "own.review.baseUnknown": "base",
  "own.review.baseLoading": "브랜치 목록을 읽는 중…",
  "own.review.view": "diff 보기",
  "own.review.splitNarrow": "폭이 560px보다 좁아 한 줄로 보여 줘요",
  "own.review.refresh": "새로 고침",
  "own.review.files": "변경 파일 {count}",
  "own.review.lines": "추가된 줄 {added}, 삭제된 줄 {deleted}",
  "own.review.list": "변경 파일 목록",
  "own.review.listHide": "목록 접기",
  "own.review.listShow": "목록 펼치기",
  "own.review.status.added": "추가됨",
  "own.review.status.modified": "수정됨",
  "own.review.status.deleted": "삭제됨",
  "own.review.loading": "변경을 읽는 중…",
  "own.review.empty.working": "커밋 안 된 변경이 없어요",
  "own.review.empty.branch": "{base} 이후 바뀐 파일이 없어요",
  "own.review.empty.lastTurn": "마지막 턴이 바꾼 파일이 없어요",
  "own.review.empty.session": "이 대화가 바꾼 파일이 없어요",
  "own.review.empty.reverted": "되돌린 파일이 없어요",
  "own.review.error": "변경을 읽지 못했어요: {message}",
  "own.review.retry": "다시 시도",
  "own.review.noSession": "대화를 열면 그 대화의 변경을 볼 수 있어요.",
  "own.review.running": "턴이 실행 중이에요. 작업 사본과 비교해요.",
  "own.review.trimmed": "큰 파일이라 변경 주변 {context}줄만 보여 줘요.",
  "own.review.preparing": "diff를 준비하는 중…",
  "own.review.capped": "diff가 너무 커서 서버가 내용을 생략했어요.",
  "own.review.tooLarge": "바뀐 줄이 {count}개라 자동으로 그리지 않았어요.",
  "own.review.renderAnyway": "그래도 보기",
  "own.review.badge": "변경 파일 {count}개",
  "own.review.footer": "변경 {count}개 · 리뷰 →",
  "own.review.comment.more": "코멘트 메뉴",
  "own.review.comment.edit": "고치기",
  "own.review.comment.delete": "지우기",
  "own.review.comment.save": "저장",
  "own.review.comments": "다음 메시지에 붙일 코멘트 {count}개",
  "own.review.comment.open": "리뷰에서 {file} {lines}줄 코멘트 보기: {comment}",
  "own.review.comment.remove": "{file} {lines}줄 코멘트 빼기",
  "own.review.comment.hint":
    "줄을 고르면 코멘트를 달 수 있어요. 코멘트는 다음 메시지에 붙어요 · {key}로 고른 줄을 입력창에 추가",
  "own.review.selection.none": "리뷰에서 줄을 먼저 고르세요",
  "own.review.selection.removed": "지운 줄은 파일 문맥으로 넣을 수 없어요. 코멘트를 남기세요",
  "own.review.selection.added": "{file} {lines}줄을 입력창에 넣었어요",
  "own.review.fileActions": "{file} 파일 동작",
  "own.review.openInFiles": "파일 탭에서 열기",
  // 18.5 Git 초기화 (upstream 41516c78c8): a project folder without a repository, PC windows only.
  "own.review.gitInit": "Git 저장소 만들기",
  "own.review.gitInitRunning": "Git 저장소를 만드는 중…",
  "own.review.gitInitTitle":
    "이 프로젝트 폴더에서 git init을 실행해요. 그 뒤로 커밋 안 된 변경과 브랜치 비교를 볼 수 있어요",
  "own.review.gitInitDone": "Git 저장소를 만들었어요",
  "own.review.gitInitFailed": "Git 저장소를 만들지 못했어요: {reason}",
} as const satisfies Record<string, string>

export type ReviewKey = keyof typeof reviewKo

export const reviewEn: Partial<Record<ReviewKey, string>> = {
  "own.review.modeLabel": "Review scope",
  "own.review.mode.reverted": "Files put back by restore",
  "own.review.base": "base: {name}",
  "own.review.baseLabel": "Base branch to compare with",
  "own.review.basePick": "Choose a base",
  "own.review.baseUnknown": "base",
  "own.review.baseLoading": "Loading branches…",
  "own.review.view": "Diff view",
  "own.review.splitNarrow": "Narrower than 560 px: showing the unified view",
  "own.review.refresh": "Refresh",
  "own.review.files": "{count} changed files",
  "own.review.lines": "{added} lines added, {deleted} lines removed",
  "own.review.list": "Changed files",
  "own.review.listHide": "Hide list",
  "own.review.listShow": "Show list",
  "own.review.status.added": "Added",
  "own.review.status.modified": "Modified",
  "own.review.status.deleted": "Deleted",
  "own.review.loading": "Loading changes…",
  "own.review.empty.working": "No uncommitted changes",
  "own.review.empty.branch": "No changes since {base}",
  "own.review.empty.lastTurn": "The last turn changed no files",
  "own.review.empty.session": "This session changed no files",
  "own.review.empty.reverted": "No files were put back",
  "own.review.error": "Could not load the changes: {message}",
  "own.review.retry": "Try again",
  "own.review.noSession": "Open a session to review its changes.",
  "own.review.running": "A turn is running: comparing with the working copy.",
  "own.review.trimmed": "Large file: showing {context} lines around each change.",
  "own.review.preparing": "Preparing the diff…",
  "own.review.capped": "The server left this diff out because it is too large.",
  "own.review.tooLarge": "{count} changed lines: not drawn automatically.",
  "own.review.renderAnyway": "Show anyway",
  "own.review.badge": "{count} changed files",
  "own.review.footer": "{count} changes · Review →",
  "own.review.comment.more": "Comment options",
  "own.review.comment.edit": "Edit",
  "own.review.comment.delete": "Delete",
  "own.review.comment.save": "Save",
  "own.review.comments": "{count} comments for the next message",
  "own.review.comment.open": "Show the comment on {file} lines {lines} in Review: {comment}",
  "own.review.comment.remove": "Remove the comment on {file} lines {lines}",
  "own.review.comment.hint":
    "Select lines to comment on them. Comments go with the next message · {key} adds the selected lines to the composer",
  "own.review.selection.none": "Select lines in Review first",
  "own.review.selection.removed": "Removed lines cannot be added as file context. Leave a comment instead",
  "own.review.selection.added": "Added {file} lines {lines} to the composer",
  "own.review.fileActions": "Actions for {file}",
  "own.review.openInFiles": "Open in Files",
  "own.review.gitInit": "Create a Git repository",
  "own.review.gitInitRunning": "Creating the Git repository…",
  "own.review.gitInitTitle":
    "Runs git init in this project folder. Afterwards uncommitted changes and branch comparisons can be shown",
  "own.review.gitInitDone": "Created the Git repository",
  "own.review.gitInitFailed": "Could not create the Git repository: {reason}",
}

const catalogs: Record<Locale, Partial<Record<ReviewKey, string>>> = { ko: reviewKo, en: reviewEn }

/** Same rules as `translate` in src/i18n: current locale, Korean fallback, `{name}` params, Korean particles. */
export function reviewText(locale: Locale, key: ReviewKey, params?: I18nParams) {
  const template = catalogs[locale][key] ?? reviewKo[key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

/** `t` for review keys in the current locale (reactive: reads the locale signal). */
export function useReviewText() {
  const i18n = useI18n()
  return (key: ReviewKey, params?: I18nParams) => reviewText(i18n.locale(), key, params)
}
