// 02 §4.7.7 (CC-14, CC-16): tells own-accounts that the user is looking at a conversation, so idle compaction leaves
// alone a conversation someone is reading. While the page is visible and was touched since about the last report, the
// shown session is reported once a minute (`session.presence`, a read). The client keeps no window of its own: with
// `policy.awayDetect` on, the service waits `hiddenMinutes` after the last report, so a conversation counts as away
// `hiddenMinutes` after the window was hidden or last touched (up to a minute more). The composer loads this lazily, so
// it stays out of the first chunk (PF5).
import type { OwnRpc } from "@/data/rpc"

const HEARTBEAT_MS = 60_000
const INPUTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const

export function trackPresence(input: {
  readonly rpc: () => OwnRpc | undefined
  readonly sessionID: () => string | undefined
}) {
  let touched = Date.now()
  const touch = () => {
    touched = Date.now()
  }
  const report = () => {
    const rpc = input.rpc()
    const sessionID = input.sessionID()
    if (!rpc?.allowed("session.presence") || !sessionID) return
    if (document.visibilityState !== "visible" || Date.now() - touched > HEARTBEAT_MS) return
    // An older service without the method, or a dropped connection: the next minute tries again.
    void rpc.call("session.presence", { sessionID }).catch(() => undefined)
  }
  const visibility = () => {
    if (document.visibilityState !== "visible") return
    touch()
    report()
  }
  for (const name of INPUTS) window.addEventListener(name, touch, { passive: true, capture: true })
  document.addEventListener("visibilitychange", visibility)
  const timer = setInterval(report, HEARTBEAT_MS)
  report()
  return () => {
    clearInterval(timer)
    document.removeEventListener("visibilitychange", visibility)
    for (const name of INPUTS) window.removeEventListener(name, touch, { capture: true })
  }
}
