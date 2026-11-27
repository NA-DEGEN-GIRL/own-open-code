// 내 브라우저 사용 (BRW): the conversation `⋯` item's label, the only words of the feature in the first chunk (the rest
// is in strings.ts, which the settings page and the dialog load with their chunks).
import { catalogText, useCatalogText } from "@/projects/text"

export const browseMenuKo = { "own.browse.menu": "이 대화에서 내 브라우저 사용…" } as const

export const browseMenuText = catalogText(browseMenuKo, { "own.browse.menu": "Use my browser in this conversation…" })

export function useBrowseMenuText() {
  return useCatalogText(browseMenuText)
}
