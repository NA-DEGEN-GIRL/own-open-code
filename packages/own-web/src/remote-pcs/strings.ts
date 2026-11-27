// 원격 PC strings of the first chunk (08 §4.1): the sidebar sections. ko + en, `own.remotePc.*`, same rules as the shared
// catalogs (`t()`, `{name}` params, Korean particles). The dialogs' strings are in dialog-strings.ts (lazy).
import { catalogText, useCatalogText } from "@/projects/text"

export const remotePcKo = {
  "own.remotePc.group": "다른 PC",
  "own.remotePc.add": "다른 PC 추가",
  "own.remotePc.menu": "{name} 메뉴",
  "own.remotePc.open": "{name} 열기",
  "own.remotePc.state.checking": "확인 중…",
  "own.remotePc.state.connected": "연결됨",
  "own.remotePc.state.unreachable": "연결할 수 없음",
  "own.remotePc.state.reauth": "다시 연결 필요",
  "own.remotePc.action.open": "열기",
  "own.remotePc.action.reconnect": "다시 연결…",
  "own.remotePc.action.remove": "목록에서 빼기…",
} as const

export type RemotePcKey = keyof typeof remotePcKo

export const remotePcEn: Partial<Record<RemotePcKey, string>> = {
  "own.remotePc.group": "Other PCs",
  "own.remotePc.add": "Add other PC",
  "own.remotePc.menu": "{name} menu",
  "own.remotePc.open": "Open {name}",
  "own.remotePc.state.checking": "Checking…",
  "own.remotePc.state.connected": "Connected",
  "own.remotePc.state.unreachable": "Unreachable",
  "own.remotePc.state.reauth": "Reconnect needed",
  "own.remotePc.action.open": "Open",
  "own.remotePc.action.reconnect": "Reconnect…",
  "own.remotePc.action.remove": "Remove from the list…",
}

export const remotePcText = catalogText(remotePcKo, remotePcEn)

export function useRemotePcText() {
  return useCatalogText(remotePcText)
}
