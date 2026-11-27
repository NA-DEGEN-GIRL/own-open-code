// One chat pane's session view (03 §4.1.1, §4.5–4.6): what the shell showed once per window before split panes.
// Mounted once per chat pane and kept while the pane lives, so its composer, drafts and IME state survive route,
// tier and mode changes (hidden, not unmounted, in tabs mode). Each pane has its own transcript, composer and switcher;
// shortcuts and "the composer" lookups follow the focused pane (pane-context.tsx).
import { Show } from "solid-js"
import { Composer } from "@/composer"
import type { ServerKey } from "@/data"
import { DiscoverHints } from "@/discover/hints"
import { RevertBarSlot } from "@/revert"
import { RemoteSessionOverlay } from "@/servers"
import { SubagentStrip } from "@/subagent"
import { Switcher } from "@/switcher"
import { Transcript } from "@/transcript"
import { SessionBanners } from "./session-banners"

export function SessionPane(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
  readonly visible: () => boolean
}) {
  return (
    <section
      class="own-session"
      data-testid="session-view"
      // The new-conversation screen (03 §4.3.1, P2-14): shell.css centres its line, hints and composer as one column.
      data-home={props.sessionID() ? undefined : ""}
      style={{ position: "relative" }}
    >
      {/* 04 §17.7: a remote session whose host is not live keeps its route and gets an overlay. */}
      <RemoteSessionOverlay serverKey={props.serverKey} />
      <SessionBanners serverKey={props.serverKey} sessionID={props.sessionID} />
      <Transcript serverKey={props.serverKey} sessionID={props.sessionID} visible={props.visible} />
      {/* 03 §4.3.1: on the new-session screen, where team mode, worktrees, settings and the manual are. */}
      <Show when={!props.sessionID()}>
        <DiscoverHints serverKey={props.serverKey} />
      </Show>
      {/* 4.5 "대화 맨 아래": the restore bar (18.7), then the subagents that run or wait on the user (18.11). */}
      <div class="own-session-foot">
        <RevertBarSlot serverKey={props.serverKey} sessionID={props.sessionID} />
        <SubagentStrip serverKey={props.serverKey} sessionID={props.sessionID} />
      </div>
      <Composer serverKey={props.serverKey} sessionID={props.sessionID} />
      <Switcher serverKey={props.serverKey} sessionID={props.sessionID} />
    </section>
  )
}
