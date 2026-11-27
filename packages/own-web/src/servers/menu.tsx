// Small `⋯` menu of the first chunk (host group headers, 04 §17.2). Same behavior as the lazy kit's Menu (popover API:
// top layer, light dismiss, Esc; arrow keys; the first item gets focus), without pulling that kit into the first chunk.
// A `note` is a line of muted text between items (an explanation, a loading or empty state); arrow keys skip it. The
// button is `⋯` unless the caller gives its own content and class (the project row's `팀` and `⑂`, 03 §4.3.1).
import { createSignal, createUniqueId, For, Show, type JSX } from "solid-js"

export type MenuItem =
  | { readonly label: string; readonly onSelect: () => void; readonly tone?: "danger"; readonly testid?: string }
  | { readonly note: string; readonly testid?: string }
  | "separator"

export function HostMenu(props: {
  readonly label: string
  readonly items: () => readonly MenuItem[]
  readonly testid?: string
  /** Runs each time the menu opens, before its items are read (e.g. to load what an item depends on). */
  readonly onOpen?: () => void
  /** The button's content instead of `⋯`. */
  readonly trigger?: JSX.Element
  /** The button's class instead of the icon button's. */
  readonly class?: string
  /** The button's tooltip. */
  readonly title?: string
  /** The button's `data-state` (a dimmed entry: `not-git`). */
  readonly state?: string
}) {
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  const buttons = () => [...popover.querySelectorAll<HTMLButtonElement>("[role=menuitem]")]
  const place = () => {
    const rect = button.getBoundingClientRect()
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    popover.style.left = `${Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))}px`
    popover.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code === "Escape") return event.stopPropagation()
    const list = buttons()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.code === "ArrowDown"
        ? (index + 1) % list.length
        : event.code === "ArrowUp"
          ? (index - 1 + list.length) % list.length
          : -1
    if (next < 0) return
    event.preventDefault()
    list[next]?.focus()
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        class={props.class ?? "own-icon-button own-target size-7 flex-none"}
        aria-label={props.label}
        title={props.title}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={id}
        popovertarget={id}
        data-testid={props.testid}
        data-state={props.state}
      >
        {props.trigger ?? (
          <span aria-hidden="true" class="own-ico own-ico-more" />
        )}
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="menu"
        aria-label={props.label}
        class="m-0 min-w-[200px] rounded-lg border border-own-border bg-own-bg p-1 text-[13px] text-own-text shadow-lg"
        style={{ position: "fixed", inset: "auto" }}
        onToggle={(event) => {
          const opened = event.newState === "open"
          if (opened) props.onOpen?.()
          setOpen(opened)
          if (!opened) return
          place()
          buttons()[0]?.focus()
        }}
        onKeyDown={onKeyDown}
      >
        <Show when={open()}>
          <For each={props.items()}>
            {(item) =>
              item === "separator" ? (
                <hr class="my-1 border-0 border-t border-own-border" />
              ) : "note" in item ? (
                <p
                  role="none"
                  class="m-0 max-w-[300px] px-2.5 py-1.5 text-[12px] leading-[1.45] text-own-muted"
                  data-testid={item.testid}
                >
                  {item.note}
                </p>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  class="flex w-full items-center rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-inherit hover:bg-own-hover focus-visible:bg-own-hover"
                  classList={{ "text-own-danger": item.tone === "danger" }}
                  data-testid={item.testid}
                  onClick={() => {
                    popover.hidePopover()
                    button.focus()
                    item.onSelect()
                  }}
                >
                  {item.label}
                </button>
              )
            }
          </For>
        </Show>
      </div>
    </>
  )
}
