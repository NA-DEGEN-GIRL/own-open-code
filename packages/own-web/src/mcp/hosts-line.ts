// The per-server host line of 설정 > MCP 서버 (`SSH 호스트: build-host 설치됨 · lab 설치 가능`, MH 2026-11-26) and the
// host the page's host section opens on. The lazy host section (./hosts.tsx) fills the line once it has read the
// hosts; the page's rows read it by the server's key (`own:<id>`, `file:<name>`). Tab memory only.
import { createRoot, createSignal } from "solid-js"
import type { RowState } from "./hosts-model"

export interface HostLineItem {
  readonly hostId: string
  readonly host: string
  readonly state: RowState
}

const state = createRoot(() => {
  const [lines, setLines] = createSignal<ReadonlyMap<string, ReadonlyArray<HostLineItem>>>(new Map())
  const [target, setTarget] = createSignal<string>()
  return { lines, setLines, target, setTarget }
})

export const hostLines = state.lines
export const setHostLines = state.setLines

/** The host the section should show when it opens (a host's settings page, the palette, a host conversation). */
export const mcpHostTarget = state.target
export const setMcpHostTarget = state.setTarget
