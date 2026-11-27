// 결정 적기 (06 §6.6, §9.2), lazy in the team chunk (the project menu opens it with
// `lazy(() => import("@/team/decide"))`). A title and what was decided and why go to `decisions.add{teamID, title,
// body}`, which writes the next numbered record in the team records folder; the toast says its number. When
// 결정 기록을 프로젝트에 남기기 is on (`policy.commitDecisions`) the dialog says that the main also keeps a copy in the
// project. Below the form, the team's records so far, newest first (`decisions.list`). Focus starts on the title;
// Enter there moves to the details, Ctrl+Enter (⌘+Enter) in the details saves, Escape closes. Writing needs the
// `prompt` scope, which a gateway device may hold.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createSignal, createUniqueId, For, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { TextField } from "@/limits/kit"
import { showToast } from "@/switcher/toast"
import { TeamDialog } from "./confirm"
import { errorText, type TeamText } from "./model"
import { useTeamText } from "./strings"
import "./team.css"

/** `decisions.add` takes a title of 1–200 characters and at most 65,536 characters of details (06 §2.7). */
export const TITLE_LIMIT = 200
export const BODY_LIMIT = 65_536

/** The record to write, trimmed; `undefined` while the title is empty or a part is too long. */
export function decisionDraft(title: string, body: string) {
  const name = title.trim()
  const text = body.trim()
  if (!name || name.length > TITLE_LIMIT || text.length > BODY_LIMIT) return undefined
  return { title: name, body: text }
}

/** The team's records as the dialog lists them, newest first: `4. 결제 화면은 서버에서 그린다` and who wrote it. */
export function decisionRows(text: TeamText, items: readonly OwnTeam.DecisionRecord[]) {
  return items
    .toSorted((a, b) => b.number - a.number)
    .map((item) => ({
      number: item.number,
      title: text("own.team.decide.item", { n: item.number, title: item.title }),
      source: text(item.source === "main" ? "own.team.decide.source.main" : "own.team.decide.source.user"),
    }))
}

export default function DecideDialog(props: {
  readonly serverKey: ServerKey
  readonly teamID: OwnTeam.TeamID
  readonly onClose: () => void
}) {
  const data = useData()
  const text = useTeamText()
  const id = createUniqueId()
  const runtime = () => data.get(props.serverKey)
  const [title, setTitle] = createSignal("")
  const [body, setBody] = createSignal("")
  const [working, setWorking] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  // Read once without suspending, so the form shows at once; the list follows when it comes.
  const [records, setRecords] = createSignal<readonly OwnTeam.DecisionRecord[]>()
  void runtime()
    ?.team.rpc.call("decisions.list", { teamID: props.teamID })
    .then(
      (output) => setRecords(output.items),
      () => undefined,
    )
  const rows = () => {
    const items = records()
    return items ? decisionRows(text, items) : undefined
  }
  const draft = () => decisionDraft(title(), body())
  const allowed = () => runtime()?.team.rpc.allowed("decisions.add") === true
  const copied = () => runtime()?.team.team(props.teamID)?.team.policy.commitDecisions === true
  let details: HTMLTextAreaElement | undefined

  async function save() {
    const current = runtime()
    const value = draft()
    if (!current || !value || working()) return
    setWorking(true)
    setFailure(undefined)
    const number = await current.team.rpc.call("decisions.add", { teamID: props.teamID, ...value }).then(
      (output) => output.number,
      (error: unknown) => {
        setFailure(text("own.team.decide.failed", { reason: errorText(text, error) }))
        return undefined
      },
    )
    setWorking(false)
    if (number === undefined) return
    props.onClose()
    showToast({ message: text("own.team.decide.done", { n: number }) })
  }

  return (
    <TeamDialog
      id={id}
      testid="team-decide"
      role="dialog"
      busy={working}
      onClose={props.onClose}
      title={text("own.team.decide.title")}
      actions={
        <>
          <button type="button" class="own-team-btn" disabled={working()} onClick={() => props.onClose()}>
            {text("own.team.action.cancel")}
          </button>
          <button
            type="button"
            class="own-team-btn"
            data-primary
            data-testid="team-decide-save"
            disabled={working() || !draft() || !allowed()}
            onClick={() => void save()}
          >
            {text("own.team.decide.save")}
          </button>
        </>
      }
    >
      <p class="own-team-dialog-body own-team-muted">{text("own.team.decide.hint")}</p>
      <TextField
        label={text("own.team.decide.name")}
        value={title()}
        onValue={setTitle}
        onEnter={() => details?.focus()}
        maxLength={TITLE_LIMIT}
        data-autofocus
        testid="team-decide-title"
      />
      <label class="own-field">
        <span class="own-field-label">{text("own.team.decide.body")}</span>
        <textarea
          ref={details}
          class="own-input h-auto min-h-[120px] resize-y py-1.5"
          maxLength={BODY_LIMIT}
          data-testid="team-decide-body"
          onInput={(event) => setBody(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return
            event.preventDefault()
            void save()
          }}
        />
      </label>
      <ul class="own-team-notes">
        <Show when={copied()}>
          <li data-testid="team-decide-copy">{text("own.team.decide.copy")}</li>
        </Show>
        <Show when={!allowed()}>
          <li data-tone="warn" role="status">
            {text("own.team.error.scopeDenied")}
          </li>
        </Show>
        <Show when={failure()}>
          {(message) => (
            <li data-tone="danger" role="alert">
              {message()}
            </li>
          )}
        </Show>
      </ul>
      <Show when={rows()}>
        {(list) => (
          <section aria-labelledby={`${id}-list`} data-testid="team-decide-list">
            <p id={`${id}-list`} class="own-team-dialog-label">
              {text("own.team.decide.list")}
            </p>
            <Show
              when={list().length > 0}
              fallback={<p class="own-team-dialog-body own-team-muted">{text("own.team.decide.empty")}</p>}
            >
              <ul class="own-team-details max-h-[160px] overflow-y-auto">
                <For each={list()}>
                  {(row) => (
                    <li>
                      {row.title} · {row.source}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </Show>
    </TeamDialog>
  )
}
