// Bridges own-web's locale to the @opencode/ui i18n context that session-ui components read (03 §14: "session-ui
// 영역 문구는 @opencode/ui/i18n/ko를 그대로 쓴다"). Korean falls back to English per key, like upstream's merge.
import { pluralCategory, pluralKey, type UiI18nSource } from "@opencode/ui/context/i18n"
import { dict as en } from "@opencode/ui/i18n/en"
import { dict as ko } from "@opencode/ui/i18n/ko"
import type { Accessor } from "solid-js"
import { translate, type I18nKey } from "@/i18n"

const catalogs: Record<"ko" | "en", Record<string, string | undefined>> = { ko, en }

/**
 * session-ui labels that own wording replaces. 18.7: the message action restores (`복원`); session-ui's Korean says
 * "되돌리기", which own reserves for undoing a switch (`own.switch.undo`), and since upstream v2.2.6 (ae0fde771d) the
 * newest prompt's item says `Undo` (`ui.message.undoMessage`), which is the same revert: both read `이 지점으로 복원`.
 * Labels session-ui's Korean catalog lacks get own wording too (the queued compaction divider, 4.5; a pending steer's
 * label and actions, 18.9; the bubble's menu button), so a Korean screen never falls back to English, and the steer
 * actions use the queue dock's words.
 */
const OWN_LABELS: Readonly<Record<string, I18nKey>> = {
  "ui.message.revertMessage": "own.revert.action",
  "ui.message.undoMessage": "own.revert.action",
  "ui.message.moreActions": "own.transcript.messageMenu",
  "ui.messagePart.compaction.queued": "own.transcript.compactionQueued",
  "ui.message.pending": "own.transcript.steerPending",
  "ui.message.moveToQueue": "own.transcript.steerToQueue",
  "ui.message.deletePending": "own.composer.queueCancel",
}

/**
 * An answer's output speed in its meta line (upstream 5a750e64a2), which session-ui's Korean lacks: own's unit, as in
 * the turn footer (`own.speed.value`, 4.5), in both languages.
 */
const TOKENS_PER_SECOND = "ui.message.tokensPerSecond"

/**
 * The web search card's title (03 §18.2, WM 2026-10-19): the transcript hands session-ui own's whole title for the
 * service as `provider` (transcript/tool-alias.ts: `ChatGPT로 검색`, `Parallel로 검색 (무료)`), so the template is just
 * that value. Without a service session-ui uses `ui.tool.websearch` (`웹 검색`).
 */
const WEB_SEARCH_TITLE = "ui.tool.websearch.provider"

/**
 * A context group's label: session-ui's `{count} {tools} 사용됨` read `1 ChatGPT로 검색 사용됨` once own titles search
 * cards (WM), so own puts the titles first and the count after (`ChatGPT로 검색 · 1번`, `읽기, 여러 서비스로 검색 · 3번`;
 * MS 2026-10-19). session-ui finds the titles in the text and shows the rest after them.
 */
const TOOLS_USED = "ui.messagePart.tools.used"
const toolsUsed = {
  ko: { one: "{{tools}} · {{count}}번", other: "{{tools}} · {{count}}번" },
  en: { one: "{{tools}} · {{count}} call", other: "{{tools}} · {{count}} calls" },
}

export function uiI18nSource(locale: Accessor<"ko" | "en">): UiI18nSource {
  const lookup = (key: string) => {
    if (key === WEB_SEARCH_TITLE) return "{{provider}}"
    if (key === TOKENS_PER_SECOND) return "{{value}} t/s"
    const own = OWN_LABELS[key]
    if (own) return translate(locale(), own)
    return catalogs[locale()][key] ?? en[key] ?? key
  }
  const intl = () => (locale() === "ko" ? "ko-KR" : "en-US")
  const pluralForm: NonNullable<UiI18nSource["pluralForm"]> = (key, category, params) =>
    key === TOOLS_USED
      ? fill(toolsUsed[locale()][category === "one" ? "one" : "other"], params)
      : fill(catalogs[locale()][pluralKey(key, category)] ?? lookup(`${key}.other`), params)
  return {
    locale: intl,
    t: (key, params) => fill(lookup(key), params),
    plural: (key, count, params) => pluralForm(key, pluralCategory(intl(), count), { ...params, count }),
    pluralForm,
  }
}

/** `{{name}}` placeholders, the @opencode/ui template syntax. */
export function fill(template: string, params?: Record<string, string | number | boolean>) {
  if (!params) return template
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, name: string) => {
    const value = params[name]
    return value === undefined ? "" : String(value)
  })
}
