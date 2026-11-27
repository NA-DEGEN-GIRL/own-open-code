// The MCP module's first-chunk strings (03 §4.3): the server status popover's name. Everything the lazy list, dialog,
// server panel and settings page say is in `./list-strings` and `./manage-strings` (PF5, SM 2026-10-24).
import { catalogText, useCatalogText } from "@/projects/text"

export const mcpKo = {
  "own.server.title": "서버 상태",
} as const satisfies Record<string, string>

export type McpKey = keyof typeof mcpKo

export const mcpEn: Partial<Record<McpKey, string>> = {
  "own.server.title": "Server status",
}

export const mcpText = catalogText(mcpKo, mcpEn)

export function useMcpText() {
  return useCatalogText(mcpText)
}
