// Vendored from packages/gui-plugins/src/terminal/terminal-key-event.ts @ dae4077a96 (MIT). See own/ledger/vendored.yaml
export function terminalKeyInput(event: KeyboardEvent) {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
  if (event.key.toLowerCase() !== "backspace") return
  return "\x15"
}
