// The manual viewer (03 §4.3.1): a modal `<dialog>` over the whole window with the manual page in a same-origin frame,
// a title bar and `닫기` (Esc too). The page keeps its own table of contents, search and theme. An anchor the page
// lacks (a change a newer service names, 10.13) opens the chapter it belongs to rather than the page's top. Lazy chunk.
import { onMount } from "solid-js"
import { useDiscoverText } from "@/discover/strings"
import { Icon } from "@/shell/icons"

export default function ManualViewer(props: {
  readonly href: string
  /** The anchor to fall back on, `""` for the top. */
  readonly chapter: string
  readonly onClose: () => void
}) {
  const text = useDiscoverText()
  let dialog!: HTMLDialogElement
  onMount(() => dialog.showModal())
  return (
    <dialog
      ref={dialog}
      class="m-0 h-dvh max-h-none w-dvw max-w-none border-0 bg-own-bg p-0 text-own-text"
      aria-label={text("own.discover.manual.title")}
      data-testid="manual-viewer"
      onClose={() => props.onClose()}
    >
      <div class="flex h-full flex-col">
        {/* Height and padding in shell.css: utilities would beat its desktop-band rule (`[data-wco] .own-manual-bar`). */}
        <div class="own-manual-bar flex flex-none items-center gap-2 border-b border-own-border">
          <p class="m-0 flex-1 truncate text-[13px] font-semibold">{text("own.discover.manual.title")}</p>
          <button
            type="button"
            class="own-icon-button own-target"
            aria-label={text("own.discover.manual.close")}
            title={text("own.discover.manual.close")}
            data-testid="manual-close"
            onClick={() => dialog.close()}
          >
            <Icon name="x" />
          </button>
        </div>
        <iframe
          src={props.href}
          title={text("own.discover.manual.title")}
          class="min-h-0 w-full flex-1 border-0 bg-own-bg"
          data-testid="manual-frame"
          onLoad={(event) => {
            const page = event.currentTarget.contentWindow
            const anchor = decodeURIComponent(page?.location.hash.slice(1) ?? "")
            if (page && anchor !== "" && page.document.getElementById(anchor) === null)
              page.location.hash = props.chapter
          }}
        />
      </div>
    </dialog>
  )
}
