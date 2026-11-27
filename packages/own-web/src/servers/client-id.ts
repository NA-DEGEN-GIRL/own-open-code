// Owner id of interactive SSH attempts (04 §6.3): one per tab or window, kept in that tab's `sessionStorage` so a
// reload (F5) keeps owning its prompt, while another tab or window gets its own and sees "다른 창에서 인증 중".
// Not a secret: it only matches prompts to the window that asked.

const KEY = "own.web.remote.clientId"

export function remoteClientId(storage: Pick<Storage, "getItem" | "setItem"> | undefined = sessionStore()): string {
  try {
    const saved = storage?.getItem(KEY)
    if (saved && /^c-[a-z0-9-]{8,64}$/.test(saved)) return saved
  } catch {}
  const created = `c-${randomId()}`
  try {
    storage?.setItem(KEY, created)
  } catch {}
  return created
}

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function sessionStore() {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage
  } catch {
    return undefined
  }
}
