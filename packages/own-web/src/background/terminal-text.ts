// Terminal-like text for the output viewer (03 §19.7 "터미널처럼"), lazy with it: escape sequences out, progress-bar
// lines collapsed, a bounded tail kept.
// CSI (colors, cursor moves), OSC (titles, links; BEL or ST terminated) and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/**
 * Terminal output as plain text: escape sequences removed, CRLF → LF, and a line rewritten with a bare CR (progress
 * bars) keeps only its last state, as a terminal would show it.
 */
export function terminalText(raw: string) {
  const text = raw.replace(ANSI, "").replace(/\r\n/g, "\n")
  if (!text.includes("\r")) return text
  return text
    .split("\n")
    .map((line) => {
      const at = line.lastIndexOf("\r", line.length - 2)
      return (at < 0 ? line : line.slice(at + 1)).replace(/\r$/, "")
    })
    .join("\n")
}

/** Keeps the last `limit` characters, starting at a line boundary when one is near. */
export function tail(text: string, limit: number) {
  if (text.length <= limit) return { text, cut: false }
  const start = text.length - limit
  const newline = text.indexOf("\n", start)
  return { text: text.slice(newline >= 0 && newline - start < 512 ? newline + 1 : start), cut: true }
}
