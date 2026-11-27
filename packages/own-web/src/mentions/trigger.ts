// Which suggestion list the text before the caret asks for (03 §12 rule 9: decided on `input`, also while composing;
// only the list outside the textarea changes then). Same rules as upstream `suggestions/machine.ts`
// (`(?:^|\s)@([^\s@]*)$` before the caret, `^/(\S*)$`), written as bounded scans so a long draft costs nothing per
// keystroke (PF2): the work is proportional to the current word, never to the text.
import type { Trigger } from "./types"

/** Words longer than this are not treated as a query (pasted blobs, base64). */
const MAX_TOKEN = 512

export function detectTrigger(
  value: string,
  caret: number,
  /** Commands whose arguments get a list or a hint (`/agent`, `/skills`, server commands with `[…]`). */
  hasArguments: (name: string) => boolean = () => false,
): Trigger | undefined {
  return mentionAt(value, caret) ?? slashAt(value, caret, hasArguments)
}

function mentionAt(value: string, caret: number): Trigger | undefined {
  const floor = Math.max(0, caret - MAX_TOKEN)
  for (let index = caret - 1; index >= floor; index--) {
    const char = value.charCodeAt(index)
    if (isSpace(char)) return undefined
    if (char !== AT) continue
    if (index > 0 && !isSpace(value.charCodeAt(index - 1))) return undefined
    return { kind: "mention", query: value.slice(index + 1, caret), start: index, end: wordEnd(value, caret) }
  }
  return undefined
}

function slashAt(value: string, caret: number, hasArguments: (name: string) => boolean): Trigger | undefined {
  if (value.charCodeAt(0) !== SLASH || caret < 1) return undefined
  const limit = Math.min(value.length, MAX_TOKEN)
  let space = -1
  for (let index = 1; index < limit; index++) {
    if (!isSpace(value.charCodeAt(index))) continue
    space = index
    break
  }
  if (space === -1 && value.length > MAX_TOKEN) return undefined
  if (space === -1 || caret <= space)
    return { kind: "command", query: value.slice(1, caret), start: 0, end: space === -1 ? value.length : space }
  const name = value.slice(1, space)
  if (!name || value.charCodeAt(space) === NEWLINE || !hasArguments(name)) return undefined
  const args = value.slice(space + 1, caret)
  if (args.includes("\n") || args.length > MAX_TOKEN) return undefined
  return { kind: "argument", command: name, query: args.trimStart(), start: 0, end: lineEnd(value, caret) }
}

function wordEnd(value: string, from: number) {
  const limit = Math.min(value.length, from + MAX_TOKEN)
  for (let index = from; index < limit; index++) if (isSpace(value.charCodeAt(index))) return index
  return limit
}

function lineEnd(value: string, from: number) {
  const index = value.indexOf("\n", from)
  return index === -1 ? value.length : index
}

const AT = 64
const SLASH = 47
const NEWLINE = 10

function isSpace(char: number) {
  // space, tab, newline, carriage return, form feed, NBSP, ideographic space
  return char === 32 || char === 9 || char === 10 || char === 13 || char === 12 || char === 160 || char === 12288
}
