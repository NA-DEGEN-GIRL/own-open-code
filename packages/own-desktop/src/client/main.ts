// The remote-client page (원격 PC 전용 빌드, own/reports/win-arm64-2026-11-06.md): what a client-only shell shows
// instead of own-web, since it has no local service and no installed web. It lists the paired PCs and pairs new ones
// through the shell's existing `window.own.remotePcs` (the same main service own-web's 원격 PC dialog uses, 08 §4.1);
// each PC opens in its own pinned window that shows that PC's own-web, so this page never talks to a service itself.
// No upstream IPC and no new IPC: the rpcHash contract stays as it is. data-testid names are what
// own/scripts/test/win-arm64-device.ts drives over CDP on the device.
import type { OwnRemotePc, OwnShellApi } from "../preload/own-api"
import { COLOR_SCHEME_KEY, fallbackScheme } from "../fallback/scheme"
import { errorText, expiryText, sasText, STATE_TEXT } from "./strings"

applyScheme()

function applyScheme() {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(COLOR_SCHEME_KEY)
  } catch {
    // Blocked storage: the default (dark).
  }
  const light = matchMedia("(prefers-color-scheme: light)")
  const apply = () => (document.documentElement.dataset.scheme = fallbackScheme(stored, light.matches))
  apply()
  if (stored === "system") light.addEventListener("change", apply)
}

const own = (window as { own?: OwnShellApi }).own
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const list = byId<HTMLUListElement>("pcs")
const empty = byId<HTMLParagraphElement>("empty")
const linkInput = byId<HTMLTextAreaElement>("link")
const connect = byId<HTMLButtonElement>("connect")
const cancel = byId<HTMLButtonElement>("cancel")
const openAdded = byId<HTMLButtonElement>("open-added")
const status = byId<HTMLParagraphElement>("status")
let pairingId: string | undefined
let added: string | undefined

const say = (text: string, tone: "info" | "error" = "info") => {
  status.textContent = text
  status.dataset.tone = tone
}

const remote = own?.remotePcs
if (own) byId("shell").textContent = `${own.shell.version}`
if (!remote) {
  say("이 앱 셸에는 원격 PC 기능이 없어요. 최신 설치 파일로 다시 설치하세요.", "error")
  connect.disabled = true
} else {
  void remote.list().then(render, (error: unknown) => say(`목록을 읽지 못했어요: ${String(error)}`, "error"))
  remote.onChange(render)
  connect.addEventListener("click", () => void pair())
  linkInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void pair()
    }
  })
  cancel.addEventListener("click", () => {
    if (pairingId) void remote.cancelPairing(pairingId)
  })
  openAdded.addEventListener("click", () => {
    if (added) void remote.open(added)
  })
}

async function pair() {
  if (!remote || pairingId) return
  const link = linkInput.value.trim()
  if (!link) return say("연결할 PC에서 만든 ownpc:// 링크를 붙여 넣으세요.", "error")
  added = undefined
  openAdded.hidden = true
  connect.disabled = true
  say("PC에 연결하는 중…")
  const started = await remote.pair(link).catch((error: unknown) => ({
    ok: false as const,
    error: "failed" as const,
    detail: String(error),
  }))
  if (!started.ok) {
    connect.disabled = false
    return say(errorText(started.error, started.detail), "error")
  }
  pairingId = started.pairingId
  cancel.hidden = false
  byId("sas").textContent = started.sas
  say(sasText(started.sas, started.name))
  const result = await remote.waitPairing(started.pairingId).catch((error: unknown) => ({
    ok: false as const,
    error: "failed" as const,
    detail: String(error),
  }))
  pairingId = undefined
  cancel.hidden = true
  connect.disabled = false
  byId("sas").textContent = ""
  if (!result.ok) return say(errorText(result.error, result.detail), "error")
  linkInput.value = ""
  added = result.pcKey
  openAdded.hidden = false
  say(`${result.name}(을)를 추가했어요.`)
}

function render(pcs: readonly OwnRemotePc[]) {
  empty.hidden = pcs.length > 0
  list.replaceChildren(...pcs.map(row))
}

function row(pc: OwnRemotePc) {
  const item = document.createElement("li")
  item.dataset.testid = `pc-${pc.pcKey}`
  item.dataset.state = pc.state
  const name = document.createElement("strong")
  name.textContent = pc.name
  const detail = document.createElement("span")
  detail.className = "detail"
  detail.textContent = [STATE_TEXT[pc.state], expiryText(pc.expiresAt), pc.open ? "창 열림" : ""]
    .filter(Boolean)
    .join(" · ")
  const open = button(pc.state === "reauth" ? "열기 (다시 연결)" : "열기", `open-${pc.pcKey}`, () => {
    void remote?.open(pc.pcKey)
  })
  let armed = false
  const remove = button("목록에서 빼기", `remove-${pc.pcKey}`, () => {
    // Two presses: the first arms, like a confirmation without a modal.
    if (!armed) {
      armed = true
      remove.textContent = "정말 빼기"
      return
    }
    remove.disabled = true
    void remote?.remove(pc.pcKey).then((removed) => removed || say(`${pc.name}(을)를 빼지 못했어요.`, "error"))
  })
  const actions = document.createElement("div")
  actions.className = "row-actions"
  actions.append(open, remove)
  const text = document.createElement("div")
  text.append(name, detail)
  item.append(text, actions)
  return item
}

function button(label: string, testid: string, click: () => void) {
  const element = document.createElement("button")
  element.type = "button"
  element.textContent = label
  element.dataset.testid = testid
  element.addEventListener("click", click)
  return element
}
