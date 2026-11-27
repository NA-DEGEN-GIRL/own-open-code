// The only periodic UI timer (03 §20.2 R9, PF8): one minute tick for relative times and limit countdowns. It stops
// while the page is hidden and catches up once when it becomes visible again.
import { createRoot, createSignal } from "solid-js"

const MINUTE = 60_000

function createMinuteClock() {
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(tick, MINUTE - (Date.now() % MINUTE))
  }
  const tick = () => {
    setNow(Date.now())
    if (document.visibilityState === "visible") schedule()
  }
  if (typeof document === "object") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return clearTimeout(timer)
      tick()
    })
    schedule()
  }
  return now
}

/** Epoch ms, refreshed on minute boundaries while visible. */
export const minuteNow = createRoot(() => createMinuteClock())
