// The titles own.team gives the conversations it starts (own-team sessions/main.ts `TITLE`, sessions/owner.ts) are
// Korean and stored with the conversation. An English screen shows them in English; what is stored, a title the user
// gave and what a rename starts from stay as they are.
import type { Locale } from "@/i18n"

/** `title` as the screen shows it for a conversation of this team role. */
export function teamTitle(title: string | undefined, role: string | undefined, locale: Locale) {
  if (locale !== "en" || !title) return title
  if (role === "main" && title === "팀 메인") return "Team main"
  if (role === "owner") return title.replace(/ · 담당$/, " · Owner")
  return title
}
