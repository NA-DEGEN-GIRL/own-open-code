// 팀 지시문 (06 §9.8, 2026-11-14), lazy from settings/team.tsx (`고급` > `팀 지시문`): what the team main, the area
// owners and the peers are told. Tabs 메인 / 담당 / 동료. The first part (`program` and `guard`) is the program's and
// read-only; the second, 일하는 방식, is the role's block: the user's text when one is saved, else the default. The
// block is counted on the text it sends (`\r\n` → `\n`, trimmed, as own.team stores it), so the counter and the
// protocol's 2,000-character check agree; a line that starts like the harness's own markers is refused here before
// the protocol refuses it. 기본으로 되돌리기 asks once and sends `null`.
// Screen copy and model text sit in sibling elements: the screen copy in `settings-team-instructions-ui` (several
// elements share the id), the model text in `settings-team-instructions-base` and `settings-team-instructions-block`,
// so a check of the screen copy never reads the model's text (it names git steps and tools the screens never do).
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { TeamInput } from "@/data"
import { Notice, Segmented } from "@/limits/kit"
import { useTeamText } from "@/team/strings"

/** The roles the page has tabs for, in order. */
export const ROLES = ["main", "owner", "peer"] as const
export type Role = (typeof ROLES)[number]

/**
 * `OwnTeam.INSTRUCTION_BREAKERS` (team-instructions.test.ts holds them equal): line starts the harness's baseline
 * parser reads as its own markers. The definition module evaluates its schemas, so the page keeps its own copy.
 */
export const BREAKERS = ["</context>", "<context key=", "Today's date: "] as const

/** The block as own.team stores it and the page counts and sends it: Windows line breaks once, trimmed. */
export function normalize(text: string) {
  return text.replaceAll("\r\n", "\n").trim()
}

/** Why a block cannot be saved: longer than `limit` characters, or a line starts with a breaker. */
export function blockProblem(text: string, limit: number) {
  const block = normalize(text)
  if (block.length > limit) return "over" as const
  if (block.split("\n").some((line) => BREAKERS.some((start) => line.startsWith(start)))) return "breaker" as const
  return undefined
}

export default function TeamInstructions(props: {
  readonly view: NonNullable<OwnTeam.TeamSettings["instructions"]>
  readonly writable: boolean
  readonly busy: boolean
  readonly onSave: (patch: TeamInput<"settings.set">["patch"]) => Promise<boolean>
  readonly onClose: () => void
}) {
  const text = useTeamText()
  const [role, setRole] = createSignal<Role>("main")
  // Unsaved edits per role; a role without one shows what is stored.
  const [drafts, setDrafts] = createStore<Partial<Record<Role, string>>>({})
  const [asking, setAsking] = createSignal(false)
  const current = () => props.view[role()]
  const stored = () => current().custom ?? current().standard
  const value = () => drafts[role()] ?? stored()
  const count = () => normalize(value()).length
  const problem = () => blockProblem(value(), props.view.limit)
  const changed = () => normalize(value()) !== normalize(stored())
  const choose = (next: Role) => {
    setAsking(false)
    setRole(next)
  }
  async function save() {
    const at = role()
    if (await props.onSave({ instructions: { [at]: normalize(value()) } })) setDrafts(at, undefined)
  }
  async function reset() {
    const at = role()
    setAsking(false)
    if (await props.onSave({ instructions: { [at]: null } })) setDrafts(at, undefined)
  }
  return (
    <div class="flex flex-col gap-2 py-3" data-testid="settings-team-instructions">
      <div class="flex flex-col gap-2" data-testid="settings-team-instructions-ui">
        <span class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="settings-team-instructions-back"
            onClick={() => props.onClose()}
          >
            {text("own.team.instructions.back")}
          </button>
          <b class="text-[13.5px] font-semibold">{text("own.team.settings.instructions")}</b>
        </span>
        <Segmented
          label={text("own.team.settings.instructions")}
          value={role()}
          options={ROLES.map((item) => ({ value: item, label: text(`own.team.instructions.tab.${item}`) }))}
          onChange={choose}
          testid="settings-team-instructions-tabs"
        />
        <b class="text-[13px] font-semibold">{text("own.team.instructions.base")}</b>
        <span class="text-[12px] text-own-muted">
          {text("own.team.instructions.baseNote")}
          <Show when={role() !== "main"}> {text("own.team.instructions.baseArea")}</Show>
        </span>
      </div>
      <pre
        class="m-0 max-h-[40vh] overflow-y-auto rounded-md border border-own-border bg-own-subtle p-2 font-mono text-[12px] leading-[18px] break-words whitespace-pre-wrap"
        data-testid="settings-team-instructions-base"
      >
        {`${current().program}\n\n${current().guard}`}
      </pre>
      <div class="flex flex-wrap items-center gap-2" data-testid="settings-team-instructions-ui">
        <b class="text-[13px] font-semibold">{text("own.team.instructions.block")}</b>
        <span
          class="rounded-full border border-own-border px-1.5 text-[11.5px] text-own-muted"
          data-testid="settings-team-instructions-badge"
        >
          {text(
            current().custom === undefined
              ? "own.team.settings.instructions.standard"
              : "own.team.settings.instructions.custom",
          )}
        </span>
      </div>
      <textarea
        class="min-h-[160px] w-full rounded-md border border-own-border-input bg-own-bg px-2 py-1 font-mono text-[12.5px] text-own-text outline-offset-[-1px]"
        value={value()}
        readOnly={!props.writable}
        aria-label={text("own.team.instructions.block")}
        data-testid="settings-team-instructions-block"
        onInput={(event) => setDrafts(role(), event.currentTarget.value)}
      />
      <div class="flex flex-col gap-1.5" data-testid="settings-team-instructions-ui">
        <span
          class="self-end text-[11.5px]"
          classList={{ "text-own-muted": problem() !== "over", "text-own-danger": problem() === "over" }}
          data-testid="settings-team-instructions-count"
        >
          {text("own.team.instructions.count", {
            n: count().toLocaleString("en-US"),
            max: props.view.limit.toLocaleString("en-US"),
          })}
        </span>
        <Show when={problem()}>
          {(why) => (
            <p class="m-0 text-[12.5px] text-own-danger" role="alert" data-testid="settings-team-instructions-error">
              {why() === "over"
                ? text("own.team.instructions.over", {
                    max: props.view.limit.toLocaleString("en-US"),
                    n: (count() - props.view.limit).toLocaleString("en-US"),
                  })
                : text("own.team.instructions.breaker")}
            </p>
          )}
        </Show>
        <Show when={props.writable}>
          <Show
            when={asking()}
            fallback={
              <span class="flex flex-wrap justify-end gap-1.5">
                <Show when={current().custom !== undefined}>
                  <button
                    type="button"
                    class="own-btn"
                    disabled={props.busy}
                    data-testid="settings-team-instructions-reset"
                    onClick={() => setAsking(true)}
                  >
                    {text("own.team.instructions.reset")}
                  </button>
                </Show>
                <button
                  type="button"
                  class="own-btn"
                  data-variant="primary"
                  disabled={props.busy || !changed() || problem() !== undefined}
                  data-testid="settings-team-instructions-save"
                  onClick={() => void save()}
                >
                  {text("own.team.instructions.save")}
                </button>
              </span>
            }
          >
            <Notice tone="warn" testid="settings-team-instructions-reset-ask">
              <span class="flex flex-wrap items-center gap-2">
                <span class="min-w-0 flex-1">{text("own.team.instructions.resetAsk")}</span>
                <button type="button" class="own-btn" data-size="sm" onClick={() => setAsking(false)}>
                  {text("own.team.action.cancel")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  disabled={props.busy}
                  data-testid="settings-team-instructions-reset-do"
                  onClick={() => void reset()}
                >
                  {text("own.team.instructions.resetDo")}
                </button>
              </span>
            </Notice>
          </Show>
        </Show>
      </div>
    </div>
  )
}
