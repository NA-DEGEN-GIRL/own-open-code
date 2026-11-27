// Shell mode surfaces (03 §4.6, §19.9): the running-command chip above the text (from the durable shell events, so it
// also shows commands another window started) and the one-line hint under the box while the box is in shell mode.
import { Show } from "solid-js"
import type { ServerRuntime } from "@/data"
import type { ShellMode } from "./controller"
import { shellRuns } from "./run"
import { useShellModeText } from "./strings"
import "./shellmode.css"

/** `⌘ 셸 실행 중 · bun test 외 1개` while a `!` command of the session runs. Nothing (no DOM) otherwise. */
export function ShellRunChip(props: { readonly runtime: ServerRuntime; readonly sessionID: string }) {
  const text = useShellModeText()
  const runs = () => shellRuns(props.runtime).list(props.sessionID)
  return (
    <Show when={runs()[0]}>
      {(first) => (
        <div class="own-sm-chip" role="status" data-testid="shell-running">
          <span class="own-sm-spin" aria-hidden="true" />
          <span class="own-sm-label">{text("own.shellmode.running")}</span>
          <code class="own-sm-command" title={first().command}>
            {first().command}
          </code>
          <Show when={runs().length > 1}>
            <span class="own-sm-more">{text("own.shellmode.runningMore", { n: runs().length - 1 })}</span>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** Under the box while it is in shell mode: what a shell send does and how to leave. */
export function ShellModeHint(props: { readonly shell: ShellMode }) {
  const text = useShellModeText()
  return (
    <Show when={props.shell.visual()}>
      <p class="own-sm-hint" data-testid="shell-hint">
        {text("own.shellmode.hint")}
      </p>
    </Show>
  )
}
