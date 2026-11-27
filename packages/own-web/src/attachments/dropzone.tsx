// Drop area (03 §18.10 "입력창과 대화 영역 전체가 drop 영역"): listeners on a target element (the main column that
// holds the transcript and the composer) and an overlay drawn over it while files are dragged in. Only OS file drags
// react (`dataTransfer.types` has "Files"); text and in-app drags keep the browser's behavior. The target's rect is
// read once when a drag enters (R7: no layout reads per dragover).
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { Attachments } from "./store"
import { useAttachmentsText } from "./strings"
import "./attachments.css"

export interface AttachmentDropzoneProps {
  readonly attachments: Attachments
  readonly target: () => HTMLElement | undefined
  /** False while a child session is shown (its composer is disabled). */
  readonly enabled?: () => boolean
}

export function AttachmentDropzone(props: AttachmentDropzoneProps) {
  const text = useAttachmentsText()
  const [rect, setRect] = createSignal<DOMRect>()
  createEffect(() => {
    const element = props.target()
    if (!element) return
    let depth = 0
    const files = (event: DragEvent) =>
      (props.enabled?.() ?? true) && !!event.dataTransfer && [...event.dataTransfer.types].includes("Files")
    const enter = (event: DragEvent) => {
      if (!files(event)) return
      event.preventDefault()
      if (depth++ === 0) setRect(element.getBoundingClientRect())
    }
    const over = (event: DragEvent) => {
      if (!files(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    const leave = (event: DragEvent) => {
      if (!files(event)) return
      if (--depth <= 0) reset()
    }
    const drop = (event: DragEvent) => {
      if (!files(event)) return
      event.preventDefault()
      reset()
      props.attachments.drop(event.dataTransfer)
    }
    const reset = () => {
      depth = 0
      setRect(undefined)
    }
    const escape = (event: KeyboardEvent) => event.key === "Escape" && reset()
    element.addEventListener("dragenter", enter)
    element.addEventListener("dragover", over)
    element.addEventListener("dragleave", leave)
    element.addEventListener("drop", drop)
    window.addEventListener("dragend", reset)
    window.addEventListener("keydown", escape)
    onCleanup(() => {
      element.removeEventListener("dragenter", enter)
      element.removeEventListener("dragover", over)
      element.removeEventListener("dragleave", leave)
      element.removeEventListener("drop", drop)
      window.removeEventListener("dragend", reset)
      window.removeEventListener("keydown", escape)
    })
  })
  return (
    <Show when={rect()}>
      {(box) => (
        <Portal>
          <div
            class="own-at-drop"
            data-testid="attachment-dropzone"
            style={{
              left: `${box().left}px`,
              top: `${box().top}px`,
              width: `${box().width}px`,
              height: `${box().height}px`,
            }}
          >
            <span>{text("own.attachments.drop")}</span>
          </div>
        </Portal>
      )}
    </Show>
  )
}
