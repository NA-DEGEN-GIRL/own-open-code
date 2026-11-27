// AttachmentChips (03 §4.6, §15.3, 18.10): thumbnail (images), name, size, upload progress %, `✕`; pressing a chip
// opens the preview (lazy chunk). Under the chips: the image token note for inline images, the "sent as a path"
// note when the model cannot read images, and why sending waits while an upload runs.
import { createSignal, For, lazy, Show, Suspense } from "solid-js"
import { useI18n } from "@/i18n"
import { chordLabel, DEFAULT_KEYMAP } from "@/keyboard"
import { formatSize, IMAGE_TOKEN_ESTIMATE } from "./model"
import type { Attachments, Chip } from "./store"
import { useAttachmentsText, type AttachmentsKey } from "./strings"
import "./attachments.css"

const Preview = lazy(() => import("./preview"))

export function AttachmentChips(props: { readonly attachments: Attachments }) {
  const i18n = useI18n()
  const text = useAttachmentsText()
  const [previewing, setPreviewing] = createSignal<Chip>()
  const chips = () => props.attachments.list()
  return (
    <Show when={chips().length > 0}>
      <div class="own-at" data-testid="attachment-chips">
        <ul class="own-at-list" aria-label={text("own.attachments.list", { n: chips().length })}>
          <For each={chips()}>
            {(chip) => (
              <li class="own-at-chip" data-state={chip.state} data-route={chip.route} data-testid="attachment-chip">
                <button
                  type="button"
                  class="own-at-open"
                  title={chip.name}
                  aria-label={text("own.attachments.preview", { name: chip.name })}
                  onClick={() => setPreviewing(chip)}
                >
                  <Show when={chip.thumb} fallback={<span class="own-at-kind">{kindBadge(chip)}</span>}>
                    {(thumb) => <img class="own-at-thumb" src={thumb()} alt="" loading="lazy" decoding="async" />}
                  </Show>
                  <span class="own-at-name">{chip.name}</span>
                  <Show
                    when={chip.state === "uploading"}
                    fallback={<span class="own-at-size">{chip.size ? formatSize(chip.size) : ""}</span>}
                  >
                    <span class="own-at-size" data-testid="attachment-progress">
                      {i18n.t("own.attach.uploading", { percent: percent(chip) })}
                    </span>
                  </Show>
                </button>
                <button
                  type="button"
                  class="own-at-x"
                  aria-label={text("own.attachments.remove", { name: chip.name })}
                  onClick={() => props.attachments.remove(chip.id)}
                >
                  ×
                </button>
                <Show when={chip.state === "uploading"}>
                  <span class="own-at-bar" aria-hidden="true" style={{ width: `${percent(chip)}%` }} />
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.attachments.inlineImages() > 0}>
          <p class="own-at-note" data-testid="attachment-image-cost">
            {i18n.t("own.attach.imageCost", { tokens: i18n.number(IMAGE_TOKEN_ESTIMATE) })}
          </p>
        </Show>
        <Show when={props.attachments.imageFallback()}>
          <p class="own-at-note" data-tone="warn" data-testid="attachment-no-image">
            {i18n.t("own.attach.noImageModel")}
          </p>
        </Show>
        <Show when={props.attachments.uploading()}>
          <p class="own-at-note" role="status">
            {text("own.attachments.waiting")}
          </p>
        </Show>
      </div>
      <Show when={previewing()}>
        {(chip) => (
          <Suspense>
            <Preview chip={chip()} onClose={() => setPreviewing(undefined)} />
          </Suspense>
        )}
      </Show>
    </Show>
  )
}

/** `＋` in the composer toolbar (and Ctrl+U through `attachments.pick`). */
export function AttachButton(props: { readonly attachments: Attachments; readonly disabled?: boolean }) {
  const text = useAttachmentsText()
  const keys = () => DEFAULT_KEYMAP["composer.attach"].chords.map((chord) => chordLabel(chord)).join(", ")
  return (
    <button
      type="button"
      class="own-at-add"
      data-testid="attach-button"
      disabled={props.disabled}
      title={text("own.attachments.addHint", { keys: keys() })}
      aria-label={text("own.attachments.add")}
      onClick={() => props.attachments.pick()}
    >
      <span aria-hidden="true" class="own-ico own-ico-plus" />
    </button>
  )
}

function percent(chip: Chip) {
  return chip.size === 0 ? 100 : Math.min(100, Math.floor((chip.loaded / chip.size) * 100))
}

/** A short type label instead of an icon: extension for files, `PDF`, `TXT`. */
function kindBadge(chip: Chip) {
  if (chip.mime === "application/pdf") return "PDF"
  const dot = chip.name.lastIndexOf(".")
  const extension = dot > 0 ? chip.name.slice(dot + 1, dot + 5).toUpperCase() : ""
  return extension || (chip.mime === "text/plain" ? "TXT" : "FILE")
}

export function kindKey(chip: Pick<Chip, "mime">): AttachmentsKey {
  if (chip.mime.startsWith("image/")) return "own.attachments.kind.image"
  if (chip.mime === "application/pdf") return "own.attachments.kind.pdf"
  if (chip.mime === "text/plain") return "own.attachments.kind.text"
  return "own.attachments.kind.file"
}
