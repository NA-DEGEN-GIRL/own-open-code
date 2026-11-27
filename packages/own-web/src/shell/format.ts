import type { I18n } from "@/i18n"

/** Sidebar-style relative time: 방금 / 3분 / 2시간 / 5일 (03 §4.3 session row). */
export function relativeTime(i18n: I18n, now: number, then: number) {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return i18n.t("own.time.now")
  if (minutes < 60) return i18n.t("own.time.minutes", { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18n.t("own.time.hours", { n: hours })
  return i18n.t("own.time.days", { n: Math.floor(hours / 24) })
}
