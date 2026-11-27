// The wait of a running team op on its card (RH-20, 06 §8.5, §8.9, §9.3), in the lazy team chunk: which step of how
// many, why it waits and since when (a minute timer from the step's `since`), and what the user can do: 취소
// (`op.cancel`), 바로 진행 (`op.force`: the step's fallback now, such as the program's handoff, the request without a
// new conversation, or going on past a command left running), 명령 멈추고 진행 (`op.force{stop-shell}`) and 대화 열기
// (the conversation it waits for). The step's recorded wait (`op.get`) shows at once; `op.progress` keeps it current.
// An op that waits only for the user's confirms offers 취소 too.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { minuteNow } from "@/shell/clock"
import { showToast } from "@/switcher/toast"
import { failed } from "./enable"
import type { OpProgress } from "./store"
import { useTeamWaitText, type TeamWaitKey } from "./wait-strings"

/** The step an op is at: its first pending step, else its first confirm; with its 1-based place. */
export function currentStep(op: Pick<OwnTeam.Op, "steps">) {
  const index = op.steps.findIndex((step) => step.state === "pending" || step.state === "needs_confirm")
  const step = op.steps[index]
  return step ? { step, n: index + 1, m: op.steps.length } : undefined
}

/** Whole minutes since `since` (at least 1). */
export function minutesSince(since: number, now: number) {
  return Math.max(1, Math.floor((now - since) / 60_000))
}

const ACTIONS: ReadonlyArray<{ readonly action: OwnTeam.WaitAction; readonly key: TeamWaitKey }> = [
  { action: "stop-shell", key: "own.team.wait.stopShell" },
  { action: "force", key: "own.team.wait.force" },
  { action: "cancel", key: "own.team.wait.cancel" },
]

export interface WaitView {
  readonly n: number
  readonly m: number
  /** The wait's own text; absent when the op waits only for confirms. */
  readonly text?: string
  readonly minutes?: number
  readonly shells: ReadonlyArray<NonNullable<OwnTeam.StepWait["shells"]>[number]>
  /** The buttons, the one that goes on first; only what the wait offers and this device may call. */
  readonly actions: ReadonlyArray<{ readonly action: OwnTeam.WaitAction; readonly key: TeamWaitKey }>
  /** The conversation it waits for (대화 열기). */
  readonly sessionID?: string
}

/**
 * What the card shows of an op's wait, or `undefined` when its current step does not wait: the newest `op.progress`
 * of the step (`live`) wins over what the op record keeps; a step that ended since shows nothing.
 */
export function waitView(input: {
  readonly op: Pick<OwnTeam.Op, "state" | "steps">
  readonly live?: OpProgress
  readonly allowed: (action: OwnTeam.WaitAction) => boolean
  readonly now: number
}): WaitView | undefined {
  const at = currentStep(input.op)
  if (!at) return undefined
  const progress = input.live?.steps[at.step.id]
  if (progress && progress.state !== "pending" && progress.state !== "needs_confirm") return undefined
  const wait = progress?.wait ?? at.step.wait
  const confirming = input.op.state === "waiting" && at.step.state === "needs_confirm"
  if (!wait && !confirming) return undefined
  const since = wait?.since ?? (confirming ? undefined : at.step.startedAt)
  const offered: ReadonlyArray<OwnTeam.WaitAction> = wait?.actions ?? (confirming ? ["cancel"] : [])
  const session = wait?.sessionIDs?.[0]
  return {
    n: at.n,
    m: at.m,
    ...(wait ? { text: wait.text } : {}),
    ...(since === undefined ? {} : { minutes: minutesSince(since, input.now) }),
    shells: wait?.shells ?? [],
    actions: ACTIONS.filter((item) => offered.includes(item.action) && input.allowed(item.action)),
    ...(session ? { sessionID: session } : {}),
  }
}

export function OpWait(props: {
  readonly serverKey: ServerKey
  readonly op: OwnTeam.Op
  /** After a button ran: the card reads its op again. */
  readonly onChanged: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const text = useTeamWaitText()
  const runtime = () => data.get(props.serverKey)
  const [working, setWorking] = createSignal(false)
  const view = createMemo(() =>
    waitView({
      op: props.op,
      live: runtime()?.team.state.ops[props.op.id],
      allowed: (action) => runtime()?.team.rpc.allowed(action === "cancel" ? "op.cancel" : "op.force") === true,
      now: minuteNow(),
    }),
  )

  function run(action: OwnTeam.WaitAction) {
    const current = runtime()
    if (!current || working()) return
    setWorking(true)
    const call =
      action === "cancel"
        ? current.team.rpc.call("op.cancel", { opID: props.op.id })
        : current.team.rpc.call("op.force", { opID: props.op.id, action })
    const done: Record<OwnTeam.WaitAction, TeamWaitKey> = {
      cancel: "own.team.wait.cancelled",
      force: "own.team.wait.forced",
      "stop-shell": "own.team.wait.stopped",
    }
    void call
      .then(() => {
        showToast({ message: text(done[action]) })
        props.onChanged()
      })
      .catch((error: unknown) => failed(i18n.locale(), error))
      .finally(() => setWorking(false))
  }

  return (
    <Show when={view()}>
      {(shown) => (
        <div class="own-team-wait" data-testid="team-card-wait">
          <p class="own-team-wait-line">
            <span>{text("own.team.wait.step", { n: shown().n, m: shown().m })}</span>
            <span> · </span>
            <span data-testid="team-card-wait-text">{shown().text ?? text("own.team.wait.confirm")}</span>
            <Show when={shown().minutes}>
              {(minutes) => (
                <span data-testid="team-card-wait-since">
                  {" · "}
                  {text("own.team.wait.since", { n: minutes() })}
                </span>
              )}
            </Show>
          </p>
          <Show when={shown().shells.length > 0}>
            <ul class="own-team-wait-shells">
              <For each={shown().shells}>
                {(shell) => (
                  <li>
                    {text(shell.kind === "pty" ? "own.team.wait.pty" : "own.team.wait.shell", {
                      command: shell.command,
                    })}
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <div class="own-team-wait-actions">
            <For each={shown().actions}>
              {(item) => (
                <button
                  type="button"
                  class="own-team-btn"
                  data-testid={`team-card-wait-${item.action}`}
                  {...(item.action === "cancel" ? {} : { "data-primary": "" })}
                  disabled={working()}
                  onClick={() => run(item.action)}
                >
                  {text(item.key)}
                </button>
              )}
            </For>
            <Show when={shown().sessionID}>
              {(sessionID) => (
                <button
                  type="button"
                  class="own-team-btn"
                  data-testid="team-card-wait-open"
                  onClick={() =>
                    router.navigate({ name: "session", serverKey: props.serverKey, sessionID: sessionID() })
                  }
                >
                  {text("own.team.wait.open")}
                </button>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
