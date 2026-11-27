// Recently run palette commands (per browser, newest first). A per-viewer convenience: a failing store only means no
// "최근 사용" group. Sessions are not remembered here (the session group is already newest first).
const KEY = "own.web.palette.recent"
const LIMIT = 12

export function recentCommands(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string").slice(0, LIMIT) : []
  } catch {
    return []
  }
}

export function rememberCommand(id: string) {
  if (id.startsWith("session:") || id.startsWith("session.id:")) return
  const next = [id, ...recentCommands().filter((item) => item !== id)].slice(0, LIMIT)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
}
