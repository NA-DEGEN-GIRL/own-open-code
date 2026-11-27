// 내 브라우저 사용 (BRW): the per-conversation switch's writer (the dialog's chunk only). The write is own.accounts
// `session.approval.set{sessionID, mode:<current mode>, browse}` (session rules are written only by the router,
// 03 §16.3): `on` puts `{browse_*, *, allow}` before the own bundle; the agent-wide `{browse_*, *, deny}` keeps the
// tools out of every other conversation. Turning it on needs `local` (a PC window; `browse.set` has the same scope, so
// `allowed("browse.set")` tells), turning it off `admin`. `mode` is required, so a `custom` conversation cannot be
// switched here (like computer use, src/computer/switch.ts).
import type { Approval } from "@own/protocol"
import type { OwnRpc } from "@/data/rpc"

/**
 * Why the switch cannot be used for this conversation:
 * - `custom`: its rules are not an own bundle, and `session.approval.set` needs a mode;
 * - `unsupported`: the service predates 내 브라우저 사용 (`session.approval.get` has no `browse`);
 * - `scope`: this connection may not turn it on (no `local`) or may not write at all;
 * - `unavailable`: not connected, or the router did not answer.
 */
export type BrowseBlock = "custom" | "unsupported" | "scope" | "unavailable"

export type BrowseCheck =
  | { readonly ok: true; readonly mode: Approval.SetMode; readonly use: Approval.Browse }
  | { readonly ok: false; readonly reason: BrowseBlock }

export class BrowseSwitchError extends Error {
  override readonly name = "BrowseSwitchError"
  constructor(readonly reason: BrowseBlock) {
    super(`My browser cannot be switched here: ${reason}`)
  }
}

/** The parts of a server runtime (src/data `ServerRuntime`) the switch uses. */
export interface BrowseRuntime {
  readonly rpc: Pick<OwnRpc, "call" | "allowed">
  readonly connection: { status(): string }
  readonly data: {
    readonly session: { invalidate(sessionID: string): void; sync(sessionID: string): Promise<unknown> }
  }
}

export function verdict(state: Approval.State | undefined): BrowseCheck {
  if (!state) return { ok: false, reason: "unavailable" }
  if (state.browse === undefined) return { ok: false, reason: "unsupported" }
  if (state.mode === "custom") return { ok: false, reason: "custom" }
  return { ok: true, mode: state.mode, use: state.browse }
}

export function createBrowseSwitch(runtime: BrowseRuntime) {
  const read = (sessionID: string) => runtime.rpc.call("session.approval.get", { sessionID })
  const may = (use: Approval.Browse) =>
    runtime.rpc.allowed("session.approval.set") && (use === "off" || runtime.rpc.allowed("browse.set"))
  return {
    /** Whether this connection may turn it on here (it may always try to read). */
    canTurnOn: () => may("on"),
    async check(sessionID: string): Promise<BrowseCheck> {
      if (runtime.connection.status() !== "connected") return { ok: false, reason: "unavailable" }
      return verdict(await read(sessionID).catch(() => undefined))
    },
    /** Writes the switch for the conversation (and its unfinished children); resolves with the state after it. */
    async set(sessionID: string, use: Approval.Browse): Promise<Approval.Browse> {
      if (!may(use)) throw new BrowseSwitchError("scope")
      // The mode is read right before the write: `set` rewrites the bundle with it, so it must be the current one.
      const answer = verdict(await read(sessionID))
      if (!answer.ok) throw new BrowseSwitchError(answer.reason)
      const after =
        answer.use === use
          ? use
          : (await runtime.rpc.call("session.approval.set", { sessionID, mode: answer.mode, browse: use })).browse
      if (!after) throw new BrowseSwitchError("unsupported")
      // The router's PATCH arrives as `session.permissions`; reading the session again covers a missed event.
      runtime.data.session.invalidate(sessionID)
      void runtime.data.session.sync(sessionID).catch(() => undefined)
      return after
    },
  }
}
