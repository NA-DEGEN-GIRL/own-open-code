// A speed's mark (02 §4.8, the user's 2026-10-18 report): a bolt for Fast, the same bolt with speed lines for
// Ultrafast (one mark, not two emoji bolts), Standard none. The composer's button and menu, the switcher's 속도 strip
// and the cost dialog put it in front of the speed's name; the name stays text, so screen readers read only that.
import { Show } from "solid-js"
import type { Speed } from "@own/protocol/speed"
import { InlineIcon } from "@/shell/icons"
import "./speed-mark.css"

export function SpeedMark(props: { readonly choice: Speed.Choice }) {
  return (
    <Show when={props.choice !== "standard"}>
      <span class="own-speed-mark" data-speed-mark={props.choice} aria-hidden="true">
        <InlineIcon name={props.choice === "ultrafast" ? "boltFast" : "bolt"} />
      </span>
    </Show>
  )
}
