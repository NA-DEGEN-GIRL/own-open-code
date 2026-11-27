// The project a settings page works on (설정 > MCP 서버 and 설정 > 스킬, SM 2026-10-24): MCP servers and skills are
// per Location, so such a page shows one project at a time: the one on screen when settings opened, else the most
// recent one, and a picker over the recent projects. Lazy pages only.
import { createMemo, createSignal, For, Show } from "solid-js"
import type { ServerRuntime } from "@/data"
import { samePath } from "./path"
import { useRecentProjects } from "./recent"

export function createProjectChoice(input: {
  readonly runtime: () => ServerRuntime | undefined
  /** The project to start on (the session or project on screen). */
  readonly directory: () => string | undefined
}) {
  const recent = useRecentProjects(input.runtime, 12)
  const [chosen, setChosen] = createSignal<string>()
  const options = createMemo(() => {
    // The given project and one chosen from elsewhere on the page (설정 > 스킬's exception lines, SG) are options too.
    const extra = [input.directory(), chosen()].filter(
      (directory, index, all): directory is string =>
        directory !== undefined &&
        all.findIndex((other) => other !== undefined && samePath(other, directory)) === index,
    )
    const rows = recent()
    const missing = extra.filter((directory) => !rows.some((row) => samePath(row.directory, directory)))
    return [...missing.map((directory) => ({ directory, name: directory, at: Date.now() })), ...rows]
  })
  const directory = () => chosen() ?? input.directory() ?? recent()[0]?.directory
  return { options, directory, choose: setChosen }
}

export type ProjectChoice = ReturnType<typeof createProjectChoice>

export function ProjectPicker(props: {
  readonly choice: ProjectChoice
  readonly label: string
  readonly testid: string
}) {
  const selected = () => {
    const directory = props.choice.directory()
    return directory === undefined
      ? -1
      : props.choice.options().findIndex((item) => samePath(item.directory, directory))
  }
  return (
    <Show when={props.choice.options().length}>
      <label class="flex flex-wrap items-center gap-2 text-[13px]">
        <span class="text-own-muted">{props.label}</span>
        {/* Options are numbered: a folder path stays out of the DOM's attributes (the manual's privacy check reads them). */}
        <select
          class="own-input h-8 max-w-full min-w-0 flex-1"
          data-testid={props.testid}
          value={String(selected())}
          onChange={(event) => {
            const item = props.choice.options()[Number(event.currentTarget.value)]
            if (item) props.choice.choose(item.directory)
          }}
        >
          <For each={props.choice.options()}>
            {(item, index) => (
              <option value={String(index())} selected={index() === selected()}>
                {item.name} — {item.directory}
              </option>
            )}
          </For>
        </select>
      </label>
    </Show>
  )
}
