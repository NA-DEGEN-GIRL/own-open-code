// The device viewer's hidden text field → what the page on the PC is typed (05 §8.10.3). A phone keyboard reports no
// keys (every key is 229, "composing"); it only changes the field. So the field's text is compared with what the page
// was last told and the difference goes through `RemoteBrowser.typed`: backspaces for what went away, `text` for what
// was committed, `compose` for the syllable an IME is still building (한글 조합: the page shows it underlined).
//
// The field is never empty: it rests on `REST`, a few line breaks. A soft keyboard deletes only what it finds before
// the cursor, so on an empty field Backspace would change nothing and never reach the page; and a line break ends a
// word for every keyboard, so its word in progress (suggestions, a composing region) cannot reach back into the rest
// text. The field goes back to `REST` whenever nothing is composing and it grew long or the rest text was eaten into.
//
// Real keys (a hardware keyboard, the soft keyboard's Enter): Enter and the other named keys go as `key`, never into
// the field; Ctrl/⌘+A, Z and Y go as chords. Backspace and the space bar are left to the field, like any typing: a
// soft keyboard's Backspace arrives as a key event *and* as a change of the field, and only the change is counted.
//
// The clipboard is this device's, never the PC's (05 §8.10: a device must not read or write the PC's clipboard; the
// desktop shell drops those chords too). Ctrl/⌘+V is left to the field: the browser pastes the device's own clipboard
// into it and the pasted text reaches the page as `text` through the same comparison, its line breaks kept as text
// (a pasted address or note must not press Enter in a form). Ctrl/⌘+C and X do nothing: there is no selection of the
// page on this side to copy.
import { RemoteBrowser } from "@own/protocol/remote-browser"

export const REST = "\n\n\n\n"
/** Typed text the field may hold beyond `REST` before it is reset. */
const KEEP = 32
const CHORDS = new Set(["a", "z", "y"])
/** Chords that would copy from the page: swallowed, sent nowhere. */
const COPIES = new Set(["c", "x"])
const FIELD_KEYS = new Set(["Backspace", " "])

export interface KeyPress {
  readonly key: string
  readonly keyCode: number
  readonly isComposing: boolean
  readonly shiftKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
}

export function createTyping(input: { readonly send: (events: RemoteBrowser.InputEvent[]) => void }) {
  /** The field's text without the composing segment, as the page was last told. */
  let text = REST
  /** The composing segment the page shows now. */
  let composed = ""
  let composing = false
  let segment = ""
  return {
    /** The field got the focus, or the page it types into changed: start from the rest text. */
    reset() {
      text = REST
      composed = ""
      composing = false
      segment = ""
      return REST
    },
    compositionStart() {
      composing = true
      segment = ""
    },
    compositionUpdate(data: string) {
      composing = true
      segment = data
    },
    compositionEnd() {
      composing = false
      segment = ""
    },
    /**
     * The field's text after an `input` or `compositionend`. Answers the text the field must be set to when it is
     * time to go back to the rest text, else `undefined`. `pasted`: the change is a paste (the field's `paste`
     * event came before it), whose line breaks are text.
     */
    changed(value: string, pasted = false) {
      const part = composing && segment !== "" && value.endsWith(segment) ? segment : ""
      const after = part === "" ? value : value.slice(0, value.length - part.length)
      const typed = RemoteBrowser.typed({ before: text, after, composed, composing: part })
      const events = pasted ? typed : typed.flatMap(lines)
      text = after
      composed = part
      if (events.length) input.send(events)
      if (part !== "" || (after.startsWith(REST) && after.length <= REST.length + KEEP)) return undefined
      text = REST
      return REST
    },
    /** A key event of the field. `true`: it was sent as a key, so the field must not take it (`preventDefault`). */
    key(event: KeyPress) {
      if (event.isComposing || event.keyCode === 229) return false
      const flags = {
        ...(event.shiftKey ? { shift: true } : {}),
        ...(event.ctrlKey ? { ctrl: true } : {}),
        ...(event.altKey ? { alt: true } : {}),
        ...(event.metaKey ? { meta: true } : {}),
      }
      const letter = event.key.toLowerCase()
      const chord = (event.ctrlKey || event.metaKey) && !event.altKey
      if (chord && COPIES.has(letter)) return true
      if (chord && CHORDS.has(letter)) {
        input.send([{ k: "key", key: letter, ...flags }])
        return true
      }
      if (FIELD_KEYS.has(event.key) || !(RemoteBrowser.KEYS as ReadonlyArray<string>).includes(event.key)) return false
      input.send([{ k: "key", key: event.key, ...flags }])
      return true
    },
  }
}

/** A typed line break that reached the field anyway is the Enter key, not text. */
function lines(event: RemoteBrowser.InputEvent): RemoteBrowser.InputEvent[] {
  if (event.k !== "text" || !event.text.includes("\n")) return [event]
  return event.text.split("\n").flatMap((part, index): RemoteBrowser.InputEvent[] => [
    ...(index > 0 ? [{ k: "key", key: "Enter" } as const] : []),
    ...(part === "" ? [] : [{ k: "text", text: part } as const]),
  ])
}
