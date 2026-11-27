// Role templates of team mode (06 §9.4, 2026-10-26), in the team chunk: 영역 만들기's role, an area's 역할 바꾸기…, and
// a peer's 동료 추가… / 역할 바꾸기… offer them as chips. A click puts the template's text into the field, where it can
// be edited before it is saved; every text is at most 200 characters (an area's role keeps 200, V12).
import { For } from "solid-js"
import type { TeamKey } from "./strings"

/** The chip's name and the text it puts in, in the order the chips show. */
export const ROLE_TEMPLATES: ReadonlyArray<readonly [TeamKey, TeamKey]> = [
  ["own.team.template.feature", "own.team.template.feature.text"],
  ["own.team.template.assets", "own.team.template.assets.text"],
  ["own.team.template.simulation", "own.team.template.simulation.text"],
  ["own.team.template.reviewer", "own.team.template.reviewer.text"],
]

const CHIP =
  "rounded-full border border-own-border bg-transparent px-2 py-0.5 text-[12px] text-own-muted hover:bg-own-hover hover:text-own-text"

export function RoleTemplates(props: {
  readonly text: (key: TeamKey) => string
  readonly onPick: (role: string) => void
}) {
  return (
    <span
      class="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={props.text("own.team.createArea.templates")}
      data-testid="team-role-templates"
    >
      <span class="text-[11.5px] text-own-muted">{props.text("own.team.createArea.templates")}</span>
      <For each={ROLE_TEMPLATES}>
        {([label, role]) => (
          <button
            type="button"
            class={CHIP}
            data-testid="team-role-template"
            onClick={() => props.onPick(props.text(role))}
          >
            {props.text(label)}
          </button>
        )}
      </For>
    </span>
  )
}
