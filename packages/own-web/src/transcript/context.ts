// What the transcript reads from one server (a narrow view of `ServerRuntime`, so the perf harness can drive the
// real view with a fixture runtime) and the per-session context its row components share.
import type { SessionMessageAssistant, SessionMessageInfo, SessionStatus } from "@opencode/client/promise"
import { createContext, useContext, type Accessor } from "solid-js"
import type { Projection } from "@/adapter/session-ui"
import type { ServerRuntime } from "@/data"
import type { Catalog } from "./catalog"
import type { LedgerLines } from "./ledger"
import type { MarkerIndex } from "./markers"
import type { SwitchRecords } from "./records"

export type TranscriptRuntime = Pick<ServerRuntime, "key" | "data" | "own" | "connection" | "client" | "rpc"> & {
  readonly sessions: Pick<ServerRuntime["sessions"], "directory" | "state">
}

export interface Disclosure {
  value(key: string): boolean | undefined
  set(key: string, open: boolean): void
}

export interface TranscriptContext {
  readonly runtime: TranscriptRuntime
  readonly sessionID: string
  /** The messages the view holds, oldest first: its own older pages and the store's newest (history.ts). */
  readonly messages: Accessor<readonly SessionMessageInfo[]>
  readonly projection: Projection
  readonly markers: Accessor<MarkerIndex>
  readonly status: Accessor<SessionStatus>
  readonly ledger: LedgerLines
  /** The step before a step in the loaded conversation (a turn's first step on another account found no cache). */
  readonly stepBefore: (messageID: string) => SessionMessageAssistant | undefined
  readonly records: SwitchRecords
  readonly catalog: Catalog
  readonly disclosure: Disclosure
}

const Context = createContext<TranscriptContext>()

export const TranscriptContextProvider = Context.Provider

export function useTranscript() {
  const value = useContext(Context)
  if (!value) throw new Error("useTranscript() needs the session transcript")
  return value
}
