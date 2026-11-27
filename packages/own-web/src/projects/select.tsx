// Project selector of the new-session screen (03 §18.3, §5.1): the folder the next session starts in, `폴더 없이 대화`
// (the server's 기본 대화 폴더, shown as such with its path), recent projects, and `폴더 열기…`. In the first chunk (the new-session
// screen is), so it stays small: no kit, the list is built only while the menu is open, and choosing goes through the
// project route like the sidebar does (the folderless choice through the server's new-conversation route).
import { createSignal, createUniqueId, For, Show } from "solid-js"
import { LOCAL, useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { setNewSessionTarget } from "@/sidebar/target"
import { defaultFolder, isDefaultFolder } from "./default-folder"
import { resolveProject } from "./fs"
import { openProject, projectOpenerBusy } from "./opener"
import { baseName, samePath } from "./path"
import { PathTail } from "./path-tail"
import { useRecentProjects, type RecentProject } from "./recent"
import { useProjectsText } from "./strings"

export function ProjectSelect(props: {
  /** The folder the next session would start in (composer: `newSessionDirectory`). */
  readonly directory: () => string | undefined
  readonly serverKey?: ServerKey
  /** The phone tier, where `/` is the conversation list (4.2): `폴더 없이 대화` names this PC's screen then. */
  readonly phone?: () => boolean
}) {
  const text = useProjectsText()
  const i18n = useI18n()
  const data = useData()
  const router = useRouter()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  let button!: HTMLButtonElement
  let popover!: HTMLDivElement
  const serverKey = () => props.serverKey ?? LOCAL
  const runtime = () => data.get(serverKey())
  /** The next conversation works in the server's default conversation folder (no project chosen). */
  const folderless = () => {
    const current = runtime()
    return !!current && isDefaultFolder(current, props.directory())
  }
  /** This server's default conversation folder; an older service keeps none (no `폴더 없이 대화`). */
  const folder = () => {
    const current = runtime()
    return current ? defaultFolder(current).view()?.path : undefined
  }
  const name = () => {
    if (folderless()) return text("own.project.defaultFolder")
    const directory = props.directory()
    return directory ? baseName(directory) : undefined
  }
  /** The folder the button names beside `기본 대화 폴더` (a project's own path stays in the tooltip). */
  const shown = () => (folderless() ? props.directory() : undefined)

  /** The folderless new-conversation screen of this server (`/` on this PC, by name on the phone's list tier). */
  function chooseNoFolder() {
    close()
    if (folderless()) return
    setNewSessionTarget(undefined)
    const key = serverKey()
    router.navigate(key === LOCAL && !props.phone?.() ? { name: "home" } : { name: "home", serverKey: key })
  }

  const items = () => [...popover.querySelectorAll<HTMLButtonElement>("[role=menuitemradio],[role=menuitem]")]
  function onKeyDown(event: KeyboardEvent) {
    if (event.code === "Escape") return event.stopPropagation()
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.code === "ArrowDown" ? index + 1 : event.code === "ArrowUp" ? index - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    list[(next + list.length) % list.length]?.focus()
  }

  function close() {
    popover.hidePopover()
    button.focus()
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] text-own-muted hover:bg-own-hover hover:text-own-text"
        // With the path the button takes the room its line has left (from the label's width, so it wraps as before).
        classList={{ "max-w-[28ch]": !shown(), "max-w-max min-w-0 flex-[1_1_140px]": !!shown() }}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={id}
        aria-label={`${text("own.project.select")}: ${[name() ?? text("own.project.selectNone"), shown()].filter(Boolean).join(", ")}`}
        title={props.directory()}
        popovertarget={id}
        data-testid="project-select"
        data-folderless={folderless() ? "" : undefined}
      >
        <span aria-hidden="true">▣</span>
        {/* A touch screen's 44 px button has the path under the label. */}
        <span class="flex min-w-0 items-baseline gap-1.5 pointer-coarse:flex-col pointer-coarse:items-stretch pointer-coarse:gap-0 pointer-coarse:text-left pointer-coarse:leading-tight">
          <span class="min-w-0 truncate">{name() ?? text("own.project.selectNone")}</span>
          <Show when={shown()}>{(path) => <PathTail path={path()} class="max-w-[48ch] shrink-[999]" />}</Show>
        </span>
        <span aria-hidden="true" class="text-own-faint">
          ▾
        </span>
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="menu"
        aria-label={text("own.project.select")}
        class="fixed m-0 min-w-[220px] max-w-[min(360px,calc(100vw-16px))] rounded-[10px] border border-own-border bg-own-raised p-1 text-own-text shadow-[var(--own-shadow-float)] [inset:auto]"
        data-testid="project-select-menu"
        onToggle={(event) => {
          const opened = event.newState === "open"
          setOpen(opened)
          if (!opened) return
          const rect = button.getBoundingClientRect()
          popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popover.offsetWidth - 8))}px`
          popover.style.top = `${rect.bottom + popover.offsetHeight + 8 > innerHeight ? Math.max(8, rect.top - popover.offsetHeight - 4) : rect.bottom + 4}px`
          requestAnimationFrame(() => items()[0]?.focus())
        }}
        onKeyDown={onKeyDown}
      >
        <Show when={open()}>
          <Show when={folder()}>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={folderless()}
              class="flex min-h-[30px] w-full flex-col items-start justify-center rounded-md px-2.5 py-1 text-left hover:bg-own-hover focus-visible:bg-own-hover focus-visible:outline-none aria-checked:font-semibold"
              title={folder()}
              data-testid="project-select-no-folder"
              onClick={chooseNoFolder}
            >
              <span class="max-w-full truncate text-[13px]">{text("own.project.noFolder")}</span>
              <span class="max-w-full truncate text-[11px] text-own-faint">{text("own.project.noFolderNote")}</span>
              <PathTail path={folder()!} class="max-w-full font-normal" />
            </button>
            <hr class="mx-1.5 my-1 border-0 border-t border-own-border" />
          </Show>
          <RecentItems
            serverKey={serverKey()}
            current={props.directory()}
            onPicked={close}
            empty={text("own.project.selectEmpty")}
          />
          <hr class="mx-1.5 my-1 border-0 border-t border-own-border" />
          <button
            type="button"
            role="menuitem"
            class="flex min-h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] hover:bg-own-hover focus-visible:bg-own-hover focus-visible:outline-none"
            data-testid="project-select-open"
            disabled={!!projectOpenerBusy()}
            aria-busy={!!projectOpenerBusy()}
            onClick={() => {
              close()
              openProject(serverKey())
            }}
          >
            {projectOpenerBusy() ? text("own.project.opening") : i18n.t("own.folder.open")}
          </button>
        </Show>
      </div>
    </>
  )
}

function RecentItems(props: {
  readonly serverKey: ServerKey
  readonly current?: string
  readonly empty: string
  readonly onPicked: () => void
}) {
  const data = useData()
  const router = useRouter()
  const runtime = () => data.get(props.serverKey)
  const all = useRecentProjects(runtime)
  // The default conversation folder is `폴더 없이 대화` above the list, not a project of its own.
  const recent = () => {
    const current = runtime()
    return all().filter((item) => !current || !isDefaultFolder(current, item.directory))
  }

  async function pick(item: RecentProject) {
    props.onPicked()
    const current = runtime()
    if (!current) return
    const project = item.projectID
      ? { directory: item.directory, projectID: item.projectID }
      : await resolveProject(current.client(), item.directory).catch(() => undefined)
    if (!project) return
    setNewSessionTarget({ serverKey: current.key, ...project, name: item.name })
    router.navigate({ name: "project", serverKey: current.key, projectID: project.projectID })
  }

  return (
    <Show when={recent().length} fallback={<p class="m-0 px-2.5 py-1.5 text-[12.5px] text-own-faint">{props.empty}</p>}>
      <For each={recent()}>
        {(item) => (
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.current !== undefined && samePath(item.directory, props.current)}
            class="flex min-h-[30px] w-full flex-col items-start justify-center rounded-md px-2.5 py-1 text-left hover:bg-own-hover focus-visible:bg-own-hover focus-visible:outline-none aria-checked:font-semibold"
            title={item.directory}
            data-testid="project-select-item"
            onClick={() => void pick(item)}
          >
            <span class="max-w-full truncate text-[13px]">{item.name}</span>
            <span class="max-w-full truncate font-mono text-[11px] text-own-faint">{item.directory}</span>
          </button>
        )}
      </For>
    </Show>
  )
}
