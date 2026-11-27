// Git branch/status chip of the session header (03 §19.15, [gap] 30): `⑂ main · ±3` next to the session title; it
// opens the review tab (on `커밋 안 된 변경` when there are uncommitted files). First chunk and light: vcs.get +
// vcs.status of the session's folder (src/review/vcs-status.ts), refreshed by `vcs.branch.updated`, file changes of
// the folder, turn ends and this window's Git actions. Hidden outside a Git repository and until the first answer.
import { Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { openReview } from "@/review/intents"
import { createVcsStatus } from "@/review/vcs-status"
import { useGitText } from "./strings"

export function GitStatusChip(props: {
  readonly serverKey: () => ServerKey
  readonly sessionID: () => string | undefined
}) {
  const data = useData()
  const text = useGitText()
  const directory = () => {
    const sessionID = props.sessionID()
    const runtime = data.get(props.serverKey())
    if (!sessionID || !runtime) return undefined
    return runtime.data.session.get(sessionID)?.location.directory ?? runtime.sessions.directory(sessionID)
  }
  const vcs = createVcsStatus({
    serverKey: props.serverKey,
    directory,
    active: () => props.sessionID() !== undefined,
    running: () => {
      const sessionID = props.sessionID()
      return sessionID ? data.get(props.serverKey())?.data.session.status(sessionID) === "running" : false
    },
  })
  const branch = () => vcs.branch() ?? "HEAD"
  const files = () => vcs.summary()?.files ?? 0
  return (
    <Show when={vcs.git() && props.sessionID()}>
      {(sessionID) => (
        <button
          type="button"
          class="own-chip inline-flex h-6 max-w-[220px] min-w-0 flex-none items-center gap-1 rounded-[var(--own-radius-chip)] border border-own-border px-1.5 text-[12px] leading-[16px] whitespace-nowrap text-own-muted hover:bg-own-hover hover:text-own-text"
          data-testid="git-status-chip"
          data-files={files()}
          aria-label={
            files() > 0
              ? text("own.git.chip.label", { branch: branch(), n: files() })
              : text("own.git.chip.clean", { branch: branch() })
          }
          title={
            files() > 0
              ? text("own.git.chip.label", { branch: branch(), n: files() })
              : text("own.git.chip.clean", { branch: branch() })
          }
          onClick={() =>
            openReview({
              serverKey: props.serverKey(),
              sessionID: sessionID(),
              ...(files() > 0 ? { mode: "working" as const } : {}),
            })
          }
        >
          <span aria-hidden="true">⑂</span>
          <span class="min-w-0 truncate" aria-hidden="true" data-testid="git-status-branch">
            {branch()}
          </span>
          <Show when={files() > 0}>
            <span aria-hidden="true" class="flex-none" data-testid="git-status-count">
              {/* A narrow conversation header hides the branch and this dot (styles/shell.css). */}
              <span class="own-git-sep">· </span>±{files()}
            </span>
          </Show>
        </button>
      )}
    </Show>
  )
}
