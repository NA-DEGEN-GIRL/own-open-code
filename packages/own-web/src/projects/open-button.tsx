// `폴더 열기…` of one server (03 §4.3, §18.3): the first row of every server section, so it is at the same place on
// this PC and on an SSH host. In the first chunk, so no kit: the spinner is a bordered ring. While the window's folder
// flow of this PC runs (native dialog, loading the chosen folder) the row is disabled and says `여는 중…` from the press
// on, whichever entry point started it; a host's folders open in their own picker at once.
import { Show } from "solid-js"
import { LOCAL, type ServerKey } from "@/data"
import { useHost } from "@/host"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP } from "@/keyboard"
import { preloadProjectPicker } from "./layer"
import { openProject, projectOpenerBusy } from "./opener"
import { useProjectsText } from "./strings"

/** The look of a section's first row (also the host's `다시 연결` and the like). */
export const SECTION_ROW =
  "own-target mx-2 flex h-[30px] w-[calc(100%-16px)] items-center gap-[5px] rounded-md pr-2 pl-[5px] text-left text-[12.5px] text-own-muted hover:bg-own-hover hover:text-own-text disabled:cursor-progress disabled:hover:bg-transparent"

export function OpenFolderButton(props: {
  readonly serverKey: ServerKey
  /** Ctrl+O opens this server's folders now: it says so. */
  readonly keys: boolean
}) {
  const i18n = useI18n()
  const text = useProjectsText()
  const host = useHost()
  const local = props.serverKey === LOCAL
  const busy = () => local && !!projectOpenerBusy()
  // Without the native dialog the own picker opens: fetch its chunk while the pointer is on the way.
  const preload = () => {
    if (local && !host.capabilities.nativeDirectoryPicker) void preloadProjectPicker()
  }
  return (
    <button
      type="button"
      class={SECTION_ROW}
      data-testid={local ? "sidebar-open-folder" : "host-open-folder-row"}
      disabled={busy()}
      aria-busy={busy()}
      onPointerEnter={preload}
      onFocus={preload}
      onClick={() => openProject(props.serverKey)}
    >
      <Show
        when={busy()}
        fallback={
          <svg viewBox="0 0 24 24" aria-hidden="true" class="size-3.5 flex-none fill-none stroke-current stroke-[1.7]">
            <path d="M3.5 6.5h6l2 2h9v10h-17z" />
          </svg>
        }
      >
        <span
          aria-hidden="true"
          class="size-3.5 flex-none animate-spin rounded-full border-2 border-own-border border-t-[var(--own-accent-text)] motion-reduce:animate-none"
          data-testid="sidebar-open-folder-spinner"
        />
      </Show>
      <span class="min-w-0 truncate">{busy() ? text("own.project.opening") : i18n.t("own.folder.open")}</span>
      <Show when={props.keys}>
        <kbd class="ml-auto font-sans text-[11px] text-own-faint">
          {chordLabel(DEFAULT_KEYMAP["folder.open"].chords[0])}
        </kbd>
      </Show>
    </button>
  )
}
