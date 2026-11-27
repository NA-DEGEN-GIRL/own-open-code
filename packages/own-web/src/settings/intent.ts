// What a palette command opens a settings page for (SM 2026-10-24): `MCP 서버 추가…` and `다른 도구의 MCP 서버
// 가져오기…` open 설정 > MCP 서버 with the form or the import dialog, `스킬 가져오기…` opens 설정 > 스킬 at its import
// part, `SSH 호스트에 MCP 서버 설치…` opens 설정 > MCP 서버 at its host section (MH). The page takes the request once (also when it is already on screen); nothing is kept across a reload.
import { createSignal } from "solid-js"

export type SettingsIntent = "mcp.add" | "mcp.import" | "mcp.hosts" | "skills.import"

const [pending, setPending] = createSignal<SettingsIntent>()

export function requestSettingsIntent(intent: SettingsIntent) {
  setPending(intent)
}

/** The waiting request when it is one of `intents`, taken so it runs once; reactive (call it in an effect). */
export function takeSettingsIntent<I extends SettingsIntent>(intents: ReadonlyArray<I>): I | undefined {
  const intent = pending()
  if (intent === undefined || !(intents as ReadonlyArray<SettingsIntent>).includes(intent)) return undefined
  setPending(undefined)
  // SAFETY: `intent` is one of `intents` (checked above).
  return intent as I
}
