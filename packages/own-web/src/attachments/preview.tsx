// Attachment preview (03 §18.10 "누르면 미리보기"), a lazy chunk: the image at full size, or the file's name, type,
// size and how it will be sent (inline / this PC's path / uploaded server path). Esc and the scrim close it; focus
// goes to the close button and returns to the chip afterwards.
// Deviation: 03 names session-ui `./attachment-card` and `./file-media`; those are reachable only through
// src/adapter (transcript owner) and need the session-ui providers, so this small own dialog is used until the adapter
// exports them.
import { onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "@/i18n"
import { kindKey } from "./chips"
import { formatSize } from "./model"
import type { Chip } from "./store"
import { useAttachmentsText } from "./strings"

export default function AttachmentPreview(props: { readonly chip: Chip; readonly onClose: () => void }) {
  const i18n = useI18n()
  const text = useAttachmentsText()
  let close: HTMLButtonElement | undefined
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  onMount(() => close?.focus())
  onCleanup(() => returnTo?.focus())
  const route = () =>
    props.chip.route === "inline"
      ? text("own.attachments.route.inline")
      : props.chip.route === "path"
        ? text("own.attachments.route.path")
        : text("own.attachments.route.upload")
  const path = () => (props.chip.ready?.kind === "path" ? props.chip.ready.path : undefined)
  return (
    <Portal>
      <div class="own-at-scrim" onClick={() => props.onClose()} />
      <div
        class="own-at-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={text("own.attachments.preview", { name: props.chip.name })}
        data-testid="attachment-preview"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.stopPropagation()
          props.onClose()
        }}
      >
        <div class="own-at-dialog-head">
          <b class="own-at-dialog-title" title={props.chip.name}>
            {props.chip.name}
          </b>
          <button
            ref={close}
            type="button"
            class="own-at-x"
            aria-label={text("own.attachments.close")}
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>
        <Show when={props.chip.thumb}>
          {(src) => <img class="own-at-dialog-image" src={src()} alt={props.chip.name} decoding="async" />}
        </Show>
        <dl class="own-at-dialog-facts">
          <dt>{text(kindKey(props.chip))}</dt>
          <dd>
            {props.chip.mime}
            {props.chip.size ? ` · ${formatSize(props.chip.size)}` : ""}
          </dd>
          <dt>{text("own.attachments.path")}</dt>
          <dd class="own-at-dialog-path">{path() ?? route()}</dd>
        </dl>
        <p class="own-at-note">{route()}</p>
        <Show when={props.chip.imageFallback}>
          <p class="own-at-note" data-tone="warn">
            {i18n.t("own.attach.noImageModel")}
          </p>
        </Show>
      </div>
    </Portal>
  )
}
