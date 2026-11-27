// One line above a Claude Agent conversation's composer (05 §20.5, UPD): when this PC's Claude Code is older than
// what the Claude Agent route needs or works best with, it says so with the reason and `업데이트`, which opens the
// same confirm card as 설정 > 업데이트. A newer release alone says nothing here. `닫기` hides it for this window's run.
// Its own lazy chunk: only a Claude Agent conversation loads it; the versions are read once per window.
import { createResource, createSignal, Show } from "solid-js"
import type { ToolUpdates } from "@own/protocol"
import type { ServerRuntime } from "@/data"
import { UpdateDialog } from "./confirm"
import { useToolUpdatesText, type ToolUpdatesKey } from "./strings"

/** The reasons worth a line in a conversation: the route refuses or works worse with this Claude Code. */
const ROUTE_REASONS: ReadonlyArray<ToolUpdates.Why> = ["claude_verbatim", "claude_context", "claude_sdk"]

const shared = {
  view: undefined as Promise<ToolUpdates.View | undefined> | undefined,
}
const [dismissed, setDismissed] = createSignal(false)

function readOnce(runtime: ServerRuntime, again = false) {
  if (!shared.view || again)
    shared.view = runtime.rpc.call("tools.view", {}).then(
      (view) => view,
      () => undefined,
    )
  return shared.view
}

export default function ClaudeCodeNotice(props: { readonly runtime: ServerRuntime }) {
  const text = useToolUpdatesText()
  const [view, { mutate }] = createResource(() => readOnce(props.runtime))
  const [open, setOpen] = createSignal(false)
  const item = () => {
    const found = view()?.items.find((entry) => entry.id === "claude-code")
    return found && found.why && ROUTE_REASONS.includes(found.why) && found.installed ? found : undefined
  }
  return (
    <Show when={!dismissed() && item()}>
      {(found) => (
        <div class="own-sw-chip-line" role="status" data-testid="claude-code-update-notice" data-why={found().why}>
          <span class="min-w-0 flex-1">
            {text("own.upd.notice", {
              installed: found().installed!,
              why: text(`own.upd.why.${found().why!}` as ToolUpdatesKey, {
                version: found().threshold ?? "",
                minimum: found().minimum ?? "",
              }),
            })}
          </span>
          <Show when={found().update.type === "run"}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="claude-code-update-open"
              onClick={() => setOpen(true)}
            >
              {text("own.upd.update")}
            </button>
          </Show>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="claude-code-update-dismiss"
            onClick={() => setDismissed(true)}
          >
            {text("own.upd.notice.dismiss")}
          </button>
          <Show when={open()}>
            <UpdateDialog
              runtime={props.runtime}
              component="claude-code"
              onClose={() => setOpen(false)}
              onEnded={() => void readOnce(props.runtime, true).then(mutate)}
            />
          </Show>
        </div>
      )}
    </Show>
  )
}
