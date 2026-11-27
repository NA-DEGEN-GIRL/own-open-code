// Base branch field of a new worktree (03 §19.3 "base 브랜치"), shared by the selector popover and the move dialog
// (both lazy). `vcs.branch.list` at the project root with a server-side search (debounced, latest answer wins); the
// root's current branch comes first. The search box follows 03 §12: uncontrolled, Enter during composition only
// commits, the next Enter picks the first match (`commitOnly`, like the switcher search).
import { createEffect, createSignal, createUniqueId, For, on, onCleanup, Show, untrack } from "solid-js"
import type { ServerRuntime } from "@/data"
import { createImeEnter } from "@/ime/ime-enter"
import { listBranches } from "./api"
import { baseOptions } from "./model"
import { useWorktreePanelText } from "./panel-strings"

const SEARCH_DELAY = 150

export function BaseField(props: {
  readonly runtime: ServerRuntime
  readonly root: string
  /** `undefined`: the root's current branch (or HEAD when detached). */
  readonly value: string | undefined
  readonly onChange: (base: string | undefined) => void
}) {
  const text = useWorktreePanelText()
  const id = createUniqueId()
  const [search, setSearch] = createSignal("")
  const [branches, setBranches] = createSignal<readonly string[]>([])
  const current = () => props.runtime.data.location.vcs.info({ directory: props.root })?.branch.current
  const options = () => baseOptions(branches(), current(), search())
  const selected = () => props.value ?? current()

  createEffect(() => {
    if (props.runtime.connection.status() !== "connected") return
    untrack(() => void props.runtime.data.location.vcs.sync({ directory: props.root }).catch(() => undefined))
  })

  let seq = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))
  // Again when the root's branch becomes known: a Location that was just loaded answers an empty list until its VCS
  // provider has run, and `vcs.branch.updated` (createData) then fills in the current branch.
  createEffect(
    on([search, current] as const, ([query]) => {
      clearTimeout(timer)
      const run = () => {
        const mine = ++seq
        void listBranches(props.runtime, props.root, query.trim())
          .then((list) => mine === seq && setBranches(list))
          .catch(() => mine === seq && setBranches([]))
      }
      if (!query) return run()
      timer = setTimeout(run, SEARCH_DELAY)
    }),
  )

  const ime = createImeEnter({
    commitOnly: true,
    onEnter: () => {
      const first = options()[0]
      if (first) props.onChange(first === current() ? undefined : first)
    },
  })

  return (
    <fieldset class="own-wt-field" data-testid="worktree-base">
      <legend class="own-wt-legend">{text("own.worktree.base")}</legend>
      <input
        type="search"
        class="own-wt-input"
        placeholder={text("own.worktree.baseSearch")}
        aria-label={text("own.worktree.baseSearch")}
        aria-controls={id}
        autocomplete="off"
        spellcheck={false}
        data-testid="worktree-base-search"
        onInput={(event) => {
          ime.input()
          setSearch(event.currentTarget.value)
        }}
        onKeyDown={(event) => ime.keydown(event)}
        onKeyUp={(event) => ime.keyup(event)}
        onCompositionStart={() => ime.compositionstart()}
        onCompositionEnd={() => ime.compositionend()}
      />
      <div id={id} class="own-wt-branches" role="radiogroup" aria-label={text("own.worktree.base")}>
        <Show when={options().length} fallback={<p class="own-wt-empty">{text("own.worktree.baseNone")}</p>}>
          <For each={options()}>
            {(name) => (
              <label class="own-wt-branch" data-testid="worktree-base-option">
                <input
                  type="radio"
                  name={`${id}-base`}
                  value={name}
                  checked={selected() === name}
                  onChange={() => props.onChange(name === current() ? undefined : name)}
                />
                <span class="own-wt-branch-name">
                  {name === current() ? text("own.worktree.baseDefault", { branch: name }) : name}
                </span>
              </label>
            )}
          </For>
        </Show>
      </div>
    </fieldset>
  )
}
