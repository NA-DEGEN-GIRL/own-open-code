// A text caret that does not blink while its page is streamed to a paired device (05 §8.10.3). A blinking caret
// changes the picture every half second, which is sooner than the page counts as resting (`REST_MS`): a focused field
// then never got its sharp frame, the shell took and threw away a sharp screenshot per blink, and about 12 KB a second
// of quick frames went to the device for nothing (measured 2026-11-20). `caret-animation: manual` keeps the caret
// shown and still. It is a user style sheet of the page's main frame (a caret in a frame of the page still blinks),
// put in again after every navigation, because a new document starts without it, and taken out when the stream ends.
// Nothing runs in the page; a site could read the property from a computed style and nothing else.
import type { WebContents } from "electron"

const STILL = "*{caret-animation:manual!important}"

/** Stops the caret's blinking in `contents` until the returned function is called. */
export function stillCaret(contents: WebContents) {
  const insert = () =>
    contents.isDestroyed()
      ? Promise.resolve(undefined)
      : contents.insertCSS(STILL, { cssOrigin: "user" }).catch(() => undefined)
  const held = { key: insert() }
  // The style of the document that went away needs no removal: it went with it.
  const again = () => {
    held.key = insert()
  }
  contents.on("did-navigate", again)
  return () => {
    contents.off("did-navigate", again)
    void held.key.then((key) => {
      if (key && !contents.isDestroyed()) void contents.removeInsertedCSS(key).catch(() => undefined)
    })
  }
}
