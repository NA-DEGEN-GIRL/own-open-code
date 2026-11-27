// The terminal's small eager surface (the rest of src/terminal is a lazy chunk, 20.2 R5). The shell imports only this
// file: it asks for a new terminal (`Ctrl+Alt+T`, palette, `/terminal`) before the chunk may have loaded, and reads the
// running-PTY count for the tab badge (4.7 "터미널: 실행 중 PTY 수"). No other imports, so nothing here grows the
// first bundle.
import { createSignal } from "solid-js"

const [running, setRunning] = createSignal(0)
const [newRequests, setNewRequests] = createSignal(0)

/** Running PTYs of the terminals shown now (the current location); 0 until the terminal chunk has loaded. */
export const terminalRunning = running

/**
 * Opens a new terminal in the current location once the terminal UI is mounted (immediately when it already is).
 * The caller opens the `터미널` tab or the bottom dock first.
 */
export function requestNewTerminal() {
  setNewRequests((count) => count + 1)
}

/** @internal src/terminal: the running count of the visible location. */
export const setTerminalRunning = setRunning

/** @internal src/terminal: pending new-terminal requests, and taking them. */
export const pendingNewTerminals = newRequests
export function takeNewTerminalRequests() {
  const count = newRequests()
  if (count) setNewRequests(0)
  return count
}
