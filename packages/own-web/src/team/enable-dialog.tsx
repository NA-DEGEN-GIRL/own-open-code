// 팀 모드 켜기… (06 §9.2, 2026-10-16), in the team chunk: one small dialog for every enable entry point (session menu,
// palette, project menu, the project row's [팀], the worktree group header). It says what turning on does, takes an
// optional goal (`무엇을 하려고 하나요? (선택)`) and runs enable.ts `useRunEnable`: the goal is the judge's `hint` and,
// once the op ends, a discussion draft in the team main's composer (`own.team.enable.draft`), never sent. The review
// dropped the design's "talk it over first" checkbox: the main's role decides per request, and '알아서 해' skips it.
// 영역 폴더 (06 §4.12, 2026-10-27): `프로젝트 안` (the default, `<main folder>/.worktrees`) or `프로젝트 옆 폴더`
// (`<name>-team` beside it), sent as `enable{areaRoot}`; a team turned on again keeps the place it has.
// Ctrl+Enter / ⌘+Enter in the goal submits; Escape closes. A goal longer than the hint's limit (2026-11-14) is not cut
// in the field: the judge reads its first 2,000 characters and the whole text goes to the draft, as the note says.
import type { OwnTeam } from "@own/protocol/rpc-team"
import { createSignal, createUniqueId, For, Show } from "solid-js"
import { baseName } from "@/projects/path"
import { TeamDialog } from "./confirm"
import { useRunEnable, type EnableRequest } from "./enable"
import { useTeamText } from "./strings"
import "./team.css"

/** The protocol's limit of `enable{hint}`. */
const HINT_MAX = 2_000

const FIELD =
  "w-full rounded-md border border-own-border-input bg-own-bg px-2 py-1 text-[13px] text-own-text outline-offset-[-1px]"

export default function EnableDialog(props: { readonly request: EnableRequest; readonly onClose: () => void }) {
  const text = useTeamText()
  const run = useRunEnable()
  const id = createUniqueId()
  const [goal, setGoal] = createSignal("")
  const [root, setRoot] = createSignal<OwnTeam.AreaRoot>("inside")
  const roots = [
    { value: "inside", label: "own.team.enable.dialog.root.inside", hint: "own.team.enable.dialog.root.insideHint" },
    { value: "beside", label: "own.team.enable.dialog.root.beside", hint: "own.team.enable.dialog.root.besideHint" },
  ] as const

  function submit() {
    const wanted = goal().trim()
    props.onClose()
    void run({
      ...props.request,
      areaRoot: root(),
      ...(wanted
        ? { hint: wanted.slice(0, HINT_MAX).trim(), draft: text("own.team.enable.draft", { goal: wanted }) }
        : {}),
    })
  }

  return (
    <TeamDialog
      id={id}
      testid="team-enable"
      role="dialog"
      busy={() => false}
      onClose={props.onClose}
      title={text("own.team.enable.dialog.title")}
      actions={
        <>
          <button type="button" class="own-team-btn" onClick={() => props.onClose()}>
            {text("own.team.action.cancel")}
          </button>
          <button type="button" class="own-team-btn" data-primary data-testid="team-enable-submit" onClick={submit}>
            {text("own.team.enable.dialog.submit")}
          </button>
        </>
      }
    >
      <p class="own-team-dialog-body">{text("own.team.enable.dialog.lead")}</p>
      <Show when={props.request.sessionID}>
        <p class="own-team-dialog-body text-own-muted">{text("own.team.enable.hint")}</p>
      </Show>
      <label class="flex flex-col gap-1 text-[12.5px] text-own-muted">
        {text("own.team.enable.dialog.goal")}
        <textarea
          class={FIELD}
          rows={3}
          placeholder={text("own.team.enable.dialog.placeholder")}
          value={goal()}
          data-autofocus
          data-testid="team-enable-goal"
          onInput={(event) => setGoal(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return
            event.preventDefault()
            submit()
          }}
        />
      </label>
      <Show when={goal().trim()}>
        <p class="own-team-dialog-body text-[12px] text-own-muted" data-testid="team-enable-note">
          {text("own.team.enable.dialog.note")}
        </p>
      </Show>
      <Show when={goal().trim().length > HINT_MAX}>
        <p class="own-team-dialog-body text-[12px] text-own-muted" data-testid="team-enable-long">
          {text("own.team.enable.dialog.long")}
        </p>
      </Show>
      <fieldset class="m-0 flex flex-col gap-1 border-0 p-0" data-testid="team-enable-root">
        <legend class="mb-1 p-0 text-[12.5px] text-own-muted">{text("own.team.enable.dialog.root")}</legend>
        <For each={roots}>
          {(item) => (
            <label class="flex items-start gap-2 text-[13px]">
              <input
                type="radio"
                name={`${id}-root`}
                checked={root() === item.value}
                data-testid={`team-enable-root-${item.value}`}
                onChange={() => setRoot(item.value)}
              />
              <span class="flex flex-col">
                <span>{text(item.label)}</span>
                <span class="text-[11.5px] text-own-muted">
                  {text(item.hint, { name: baseName(props.request.directory) })}
                </span>
              </span>
            </label>
          )}
        </For>
        <span class="text-[11.5px] text-own-muted">{text("own.team.enable.dialog.root.note")}</span>
      </fieldset>
    </TeamDialog>
  )
}
