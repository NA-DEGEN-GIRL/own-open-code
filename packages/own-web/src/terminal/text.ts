// `출력 복사` / `출력을 텍스트로 보기(마지막 500줄)` (03 §11 터미널): the canvas is invisible to screen readers, so
// the last lines of the active buffer are offered as plain text. Wrapped rows are joined back into one line. Reads
// from the end, so the cost is the lines shown, not the 10k-row scrollback.
export const TEXT_LINES = 500

interface BufferLike {
  readonly length: number
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined
}

export function bufferText(buffer: BufferLike, lines = TEXT_LINES) {
  const out: string[] = []
  const pending = { text: "" }
  for (let y = buffer.length - 1; y >= 0 && out.length < lines; y--) {
    const line = buffer.getLine(y)
    if (!line) continue
    pending.text = line.translateToString(true) + pending.text
    // A wrapped row continues the row above it: keep collecting until the row that starts the logical line.
    if (line.isWrapped) continue
    if (out.length || pending.text) out.push(pending.text)
    pending.text = ""
  }
  return out.reverse().join("\n")
}
