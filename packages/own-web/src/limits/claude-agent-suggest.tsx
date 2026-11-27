// A switch suggestion under a Claude Agent conversation's account row of the 계정·한도 tab (02 §8.10, CAG-D3): when a
// plan window of the account the conversation runs on nears its limit (85 % or more) or reached it, it names the other
// Claude Agent account with the most room (its five hours, or its week when it has none, then its week) and offers
// to move there. The button only opens the switcher on that account, which moves the conversation's tree by hand
// (`claudeAgent.session.set`); nothing moves on its own. Its own lazy chunk: only a Claude Agent conversation's row
// loads it.
import type { Account, Limit } from "@own/protocol"
import { LimitRank } from "@own/protocol/limit-rank"
import { Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useClaudeAgentText } from "@/accounts/claude-agent-strings"
import { openSwitcher } from "./intents"

/** A plan window this full (or worse) suggests another account. */
export const NEAR_PERCENT = 85

export default function AgentSuggestion(props: {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly accountID: string
}) {
  const data = useData()
  const text = useClaudeAgentText()
  const own = data.local().own
  const pick = () =>
    suggest(
      props.accountID,
      own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : [])),
      (id) => own.state.quota[id],
    )
  const percent = (value: number | undefined) =>
    value === undefined ? text("own.claudeAgent.unknown") : `${Math.round(value)}%`
  return (
    <Show when={pick()}>
      {(found) => (
        <div class="mt-1 mb-1.5 flex flex-col gap-1 text-[12px]" data-testid="claude-agent-suggest">
          <span>
            {text(found().full ? "own.claudeAgent.suggestFull" : "own.claudeAgent.suggest", {
              window: found().window.label,
              percent: percent(found().window.usedPercent),
              account: found().other.label,
              other: percent(found().room),
            })}
          </span>
          <span class="text-own-muted">{text("own.claudeAgent.suggestNote")}</span>
          <div>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-testid="claude-agent-suggest-move"
              onClick={() =>
                openSwitcher({ serverKey: props.serverKey, sessionID: props.sessionID, accountID: found().other.id })
              }
            >
              {text("own.claudeAgent.suggestMove", { account: found().other.label })}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

/**
 * The suggestion for a conversation on `accountID`: its fullest plan window when it is at {@link NEAR_PERCENT} or
 * exhausted, and the other ready Claude Agent account with the lowest five-hour use (an account without a five-hour
 * window: its weekly use, 02 §7.1.2; then weekly), none exhausted.
 * `undefined` when nothing is near, or no other account can take it.
 */
export function suggest(
  accountID: string,
  accounts: ReadonlyArray<Account.View>,
  windows: (accountID: string) => ReadonlyArray<Limit.Window> | undefined,
) {
  const plan = (id: string) => (windows(id) ?? []).filter((window) => window.kind === "rolling_quota")
  const window = plan(accountID)
    .filter((item) => item.status === "exhausted" || (item.usedPercent ?? 0) >= NEAR_PERCENT)
    .toSorted((a, b) => rank(b) - rank(a))[0]
  if (!window) return undefined
  const used = (id: string, name: string) => plan(id).find((item) => item.id === name)?.usedPercent
  // The five hours, or the week of an account without a five-hour window (02 §7.1.2).
  const first = (id: string) => LimitRank.claudeFirst(plan(id))?.usedPercent
  const others = accounts
    .filter((item) => item.kind === "claude-agent" && item.id !== accountID && item.status === "ready")
    .filter((item) => !plan(item.id).some((other) => other.status === "exhausted"))
    .toSorted(
      (a, b) =>
        (first(a.id) ?? 101) - (first(b.id) ?? 101) ||
        (used(a.id, "claude.7d") ?? 101) - (used(b.id, "claude.7d") ?? 101),
    )
  const other = others[0]
  if (!other) return undefined
  return { window, full: window.status === "exhausted", other, room: first(other.id) }
}

function rank(window: Limit.Window) {
  return window.status === "exhausted" ? 1_000 : (window.usedPercent ?? 0)
}
