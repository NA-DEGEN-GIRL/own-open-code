// Mention strings (03 §18.12, §4.6). Kept in this folder so the module does not edit the shared catalogs while other
// modules append to them; the keys use the `own.mention.*` namespace and can move verbatim into src/i18n/ko.ts /
// en.ts (append-only section "mentions"). Same lookup rules as `translate` in src/i18n.
import { applyJosa, useI18n, type I18nParams, type Locale } from "@/i18n"

export const mentionKo = {
  "own.mention.group.files": "파일",
  "own.mention.group.agents": "에이전트",
  "own.mention.group.skills": "스킬",
  "own.mention.group.references": "참고 자료",
  "own.mention.group.resources": "MCP 리소스",
  "own.mention.recent": "최근 변경",
  "own.mention.folder": "폴더",
  "own.mention.loading": "찾는 중…",
  "own.mention.empty": "일치하는 항목이 없어요",
  "own.mention.failed": "파일 목록을 가져오지 못했어요",
  "own.mention.rangeHint": "#L10-40을 붙이면 줄 범위만 넣어요",
  "own.mention.list": "제안",
  "own.mention.chips": "멘션",
  "own.mention.remove": "멘션 빼기: {label}",
  "own.mention.kind.file": "파일",
  "own.mention.kind.reference": "참고 자료",
  "own.mention.kind.agent": "에이전트",
  "own.mention.kind.skill": "스킬",
  "own.mention.kind.resource": "MCP 리소스",
  "own.mention.lines": "{start}–{end}줄",
  "own.mention.line": "{start}줄",
} as const satisfies Record<string, string>

export type MentionKey = keyof typeof mentionKo

export const mentionEn: Partial<Record<MentionKey, string>> = {
  "own.mention.group.files": "Files",
  "own.mention.group.agents": "Agents",
  "own.mention.group.skills": "Skills",
  "own.mention.group.references": "References",
  "own.mention.group.resources": "MCP resources",
  "own.mention.recent": "Changed",
  "own.mention.folder": "Folder",
  "own.mention.loading": "Searching…",
  "own.mention.empty": "No matches",
  "own.mention.failed": "Could not load files",
  "own.mention.rangeHint": "Add #L10-40 to attach only those lines",
  "own.mention.list": "Suggestions",
  "own.mention.chips": "Mentions",
  "own.mention.remove": "Remove mention: {label}",
  "own.mention.kind.file": "File",
  "own.mention.kind.reference": "Reference",
  "own.mention.kind.agent": "Agent",
  "own.mention.kind.skill": "Skill",
  "own.mention.kind.resource": "MCP resource",
  "own.mention.lines": "lines {start}–{end}",
  "own.mention.line": "line {start}",
}

const catalogs: Record<Locale, Partial<Record<MentionKey, string>>> = { ko: mentionKo, en: mentionEn }

export function mentionText(locale: Locale, key: MentionKey, params?: I18nParams) {
  const template = catalogs[locale][key] ?? mentionKo[key]
  const filled = params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = params[name]
        return value === undefined ? match : String(value)
      })
    : template
  return locale === "ko" ? applyJosa(filled) : filled
}

export type MentionText = (key: MentionKey, params?: I18nParams) => string

export function useMentionText(): MentionText {
  const i18n = useI18n()
  return (key, params) => mentionText(i18n.locale(), key, params)
}
