// A turn on an SSH host that own stopped before any model saw it (04 §8.6 step 5, §8.11.8, §8.14; SLM 2026-11-22): the
// host's fail-closed sink, or a refusal of this PC's relay, answered it. Their bodies name a fixed code and a Korean line
// (`{"error":{"type":"own_broker_unavailable"|"own_local_relay"|"own_egress","code","message"}}`); an older host's sink
// answered only `{"error":"own_broker_unavailable"}`. The transcript shows the line as the error card's text (never the
// raw JSON) and, under it, what the user can do: another model, this PC's SSH host settings or accounts, or
// sending `계속` once the cause is gone. A lazy chunk: loaded only for such a turn.
import { Option, Schema } from "effect"
import { For, Show, type Accessor, type JSX } from "solid-js"
import type { TimelineRow } from "@/adapter/session-ui"
import { featureText } from "@/queue/text"
import { continueTurn } from "@/queue/continue-action"
import { useRouter } from "@/routing/router"
import { openSwitcher } from "@/switcher/control"
import type { ServerRuntime } from "@/data"

const ko = {
  "own.failClosed.legacy":
    "SSH 서버의 own 서비스가 이 요청을 보내지 않았어요(PC에서 자격 증명을 받지 못했어요). 이 PC의 로컬 모델이라면 이 SSH 서버에서 바로 쓸 수 없어요. 설정 > SSH 원격 호스트에서 호스트를 업데이트하면 이 PC를 거쳐 쓸 수 있어요.",
  "own.failClosed.switch": "다른 모델로 바꾸기",
  "own.failClosed.hosts": "SSH 원격 호스트 설정",
  "own.failClosed.accounts": "계정 화면 열기",
  "own.failClosed.retry": "다시 보내기",
} as const

const en: Partial<Record<keyof typeof ko, string>> = {
  "own.failClosed.legacy":
    "The SSH server's own service did not send this request (it got no credential from the PC). A local model of this PC cannot be used on this SSH server directly; update the host in Settings > SSH remote hosts to use it through this PC.",
  "own.failClosed.switch": "Switch to another model",
  "own.failClosed.hosts": "SSH remote host settings",
  "own.failClosed.accounts": "Open accounts",
  "own.failClosed.retry": "Send again",
}

export const failClosedText = featureText(ko, en)

type Action = "switch" | "hosts" | "accounts" | "retry"

/** The codes after which sending again may work (the PC or the link comes back, a limit passes). */
const RETRY = new Set([
  "unavailable",
  "mac",
  "busy",
  "rate_limited",
  "refused_rate_limited",
  "upstream_unreachable",
  "claude_enabled",
])
/** The codes the host's settings on this PC fix (the link, the account scope, the project settings). */
const HOSTS = new Set([
  "legacy",
  "unavailable",
  "blocked",
  "host_scope",
  "refused_account_not_remote",
  "claude_host_scope",
  "claude_conflict",
])
/** The codes this PC's accounts screen fixes (a login, a key, the Claude card's host switch). */
const ACCOUNTS = new Set([
  "refused_needs_reauth",
  "refused_vault_unavailable",
  "refused_source_stale",
  "needs_key",
  "bad_request",
  "not_found",
  "claude_off",
  "claude_consent",
  "claude_not_ready",
  "claude_billing",
  "needs_reauth",
  "not_ready",
  "off",
  "consent",
  "billing",
])

export interface FailClosed {
  /** The fixed code, `legacy` for an older host's bare sink answer. */
  readonly code: string
  /** The card's text: the answer's Korean line, or the legacy line. */
  readonly text: string | undefined
  readonly actions: ReadonlyArray<Action>
}

/** What a fail-closed answer says, or `undefined` for any other body. Pure, for the tests. */
export function failClosed(body: string | undefined): FailClosed | undefined {
  const json = parse(body)
  if (!json) return undefined
  const error = json.error
  if (error === "own_broker_unavailable") return { code: "legacy", text: undefined, actions: actionsOf("legacy") }
  if (typeof error !== "object" || error === null) return undefined
  const item = error as Record<string, unknown>
  if (item.type !== "own_broker_unavailable" && item.type !== "own_local_relay" && item.type !== "own_egress")
    return undefined
  const code = typeof item.code === "string" ? item.code : typeof item.message === "string" ? item.message : "blocked"
  const text = typeof item.message === "string" && item.message !== code ? item.message : undefined
  return { code, text, actions: actionsOf(code) }
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function parse(body: string | undefined): Record<string, unknown> | undefined {
  const value = body ? Option.getOrUndefined(decodeJson(body)) : undefined
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function actionsOf(code: string): ReadonlyArray<Action> {
  return [
    ...(RETRY.has(code) ? (["retry"] as const) : []),
    "switch" as const,
    ...(HOSTS.has(code) ? (["hosts"] as const) : []),
    ...(ACCOUNTS.has(code) ? (["accounts"] as const) : []),
  ]
}

/**
 * The error card with the answer's line instead of the raw body (`Row` is the transcript's row renderer, given the
 * row with that text), and the actions under it.
 */
export default function FailClosedRow(props: {
  readonly row: Accessor<TimelineRow.TimelineRow>
  readonly Row: (props: { row: Accessor<TimelineRow.TimelineRow>; onSizeChange?: () => void }) => JSX.Element
  readonly body: string
  readonly sessionID: string
  readonly runtime: Pick<ServerRuntime, "data">
  readonly onSizeChange?: () => void
}) {
  const text = failClosedText.use()
  const router = useRouter()
  const info = () => failClosed(props.body)
  const row = () => {
    const current = props.row()
    const shown = info()?.code === "legacy" ? text("own.failClosed.legacy") : info()?.text
    return shown && current._tag === "Error" ? { ...current, text: shown } : current
  }
  const run = (action: Action) => {
    if (action === "switch") return openSwitcher()
    if (action === "hosts") return router.navigate({ name: "settings", section: "remote" })
    if (action === "accounts") return router.navigate({ name: "accounts" })
    void continueTurn(props.runtime, props.sessionID).catch((error: unknown) =>
      console.warn("[own-web] send again failed", error),
    )
  }
  return (
    <>
      <props.Row row={row} onSizeChange={props.onSizeChange} />
      <Show when={info()}>
        {(value) => (
          <div class="own-turn-continue" data-testid="fail-closed" data-code={value().code}>
            <For each={value().actions}>
              {(action) => (
                <button
                  type="button"
                  class="own-marker-toggle"
                  data-action={action}
                  onClick={() => run(action)}
                >
                  {text(`own.failClosed.${action}`)}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </>
  )
}
