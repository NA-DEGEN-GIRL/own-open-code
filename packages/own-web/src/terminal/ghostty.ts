// ghostty-web runtime (03 §18.6 "ghostty-web(wasm)은 lazy 청크", 20.2 R5): loaded on the first terminal only and
// shared by every terminal after that. The wasm comes from a same-origin asset URL: ghostty-web's default loader
// fetches a `data:` URL, which the production CSP (`connect-src 'self' …`, 01 §6.1) blocks; compiling it needs only
// `'wasm-unsafe-eval'`, which the CSP allows.
import type { FitAddon, Ghostty, Terminal } from "ghostty-web"
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url"

export interface GhosttyRuntime {
  readonly Terminal: typeof Terminal
  readonly FitAddon: typeof FitAddon
  readonly ghostty: Ghostty
}

let shared: Promise<GhosttyRuntime> | undefined

/** One wasm instance for the page (its own chunk); a failed load is retried by the next terminal. */
export function loadGhostty() {
  shared ??= load().catch((error: unknown) => {
    shared = undefined
    throw error
  })
  return shared
}

async function load(): Promise<GhosttyRuntime> {
  const { FitAddon, Ghostty, Terminal } = await import("ghostty-web")
  return { Terminal, FitAddon, ghostty: await Ghostty.load(wasmUrl) }
}

/**
 * ghostty-web draws in a rAF loop for as long as a terminal is open. Hidden tabs stop it (03 §4.7 "숨긴 탭은 렌더링
 * 작업(rAF, 관찰자)을 멈춘다", PF8) through the loop methods it does not export; without them the terminal simply
 * keeps drawing.
 */
export function pauseRender(term: Terminal) {
  renderLoop(term).cancelRenderLoop?.()
}

export function resumeRender(term: Terminal) {
  renderLoop(term).startRenderLoop?.()
}

/** The loop methods ghostty-web keeps off its public types; either may be missing in another version. */
function renderLoop(term: Terminal) {
  return term as unknown as { cancelRenderLoop?: () => void; startRenderLoop?: () => void }
}
