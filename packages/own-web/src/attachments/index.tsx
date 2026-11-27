// Attachments module entry (03 §18.10, gap 10). The composer owns the textarea and the send path; this module owns the
// chips, the entry points (＋/Ctrl+U picker, paste, drop over the main column), inline media,
// uploads to the server temp folder, desktop `nativeFilePaths`, previews and size/token notes.
//
// Wiring (integrator, see the report): the composer creates one store with `createAttachments`, renders
// `<AttachmentChips>` above the textarea, `<AttachButton>` in the toolbar, calls
// `attachments.paste(event)` in the textarea's paste handler, `attachments.pick()` for `composer.attach` (Ctrl+U),
// sends `attachments.prepare(text)` (text/files/metadata) with the prompt, waits while `attachments.uploading()`, and
// `attachments.clear()` after a send. The shell mounts `<AttachmentDropzone>` on the main column.
import type { SessionMessageUser } from "@opencode/client"
import { useI18n } from "@/i18n"
import { showToast } from "@/switcher/toast"
import { draftFrom, formatSize, MAX_FILE_BYTES } from "./model"
import type { AttachmentNotice } from "./store"
import { useAttachmentsText } from "./strings"

export { AttachButton, AttachmentChips } from "./chips"
export { AttachmentDropzone } from "./dropzone"
export {
  COMPOSER_RESTORE,
  onComposerRestore,
  requestComposerRestore,
  restoredText,
  storeRestore,
  takeRestore,
  type ComposerRestoreDetail,
} from "./intents"
export {
  draftFrom,
  IMAGE_TOKEN_ESTIMATE,
  MAX_FILE_BYTES,
  modelInput,
  promptParts,
  type ModelInput,
  type PromptParts,
  type ReadyAttachment,
} from "./model"
export { createAttachments, draftOf, type Attachments, type AttachmentNotice, type Chip } from "./store"

/** Toasts for the store's notices (03 §9: bottom right, 5 s). */
export function useAttachmentNotices() {
  const i18n = useI18n()
  const text = useAttachmentsText()
  return (notice: AttachmentNotice) => {
    switch (notice.kind) {
      case "tooLarge":
        return showToast({
          tone: "danger",
          message: i18n.t("own.attach.tooLarge", { size: formatSize(notice.size), limit: formatSize(MAX_FILE_BYTES) }),
        })
      case "failed":
        return showToast({ tone: "danger", message: text("own.attachments.failed", { name: notice.name }) })
      case "readFailed":
        return showToast({ tone: "danger", message: text("own.attachments.readFailed", { name: notice.name }) })
      case "duplicate":
        return showToast({ message: text("own.attachments.duplicate") })
    }
  }
}

/**
 * session-ui `presentation` for a user message (transcript wiring, `createSessionTimelineRowRenderer`): the typed text
 * without the `Attached file:` lines and the path references as attachment cards, as upstream shows them.
 */
export function userPresentation(message: SessionMessageUser) {
  const draft = draftFrom(message)
  const references = draft.attachments.flatMap((item) =>
    item.kind === "path" ? [{ name: item.name, mime: item.mime, path: item.path }] : [],
  )
  if (!references.length && draft.text === message.text) return undefined
  return { displayText: draft.text, references }
}
