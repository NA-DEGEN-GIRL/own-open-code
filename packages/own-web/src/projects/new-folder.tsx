// `새 폴더` of the folder pickers (03 §18.3, 04 §17.4): one folder made inside the folder on screen by the server's own
// service (own.accounts `folderPicker.create`), then the picker opens it. Korean names are fine; the service refuses a
// name that is not one folder name and an existing one, which the line then offers to open instead. Lazy with the
// pickers; shown only where `canCreate` (the service has it and the connection has the `prompt` scope).
import { createSignal, createUniqueId, Show } from "solid-js"
import type { ServerRuntime } from "@/data"
import { createImeEnter } from "@/ime/ime-enter"
import { CreateFailure, createFailureText, createFolder } from "./listing"
import { usePickerText } from "./picker-strings"

export function NewFolder(props: {
  readonly runtime: Pick<ServerRuntime, "rpc">
  /** The folder on screen; nothing to make in before the first listing. */
  readonly parent: () => string | undefined
  /** The new folder (absolute, as the service made it). */
  readonly onMade: (path: string) => void
  /** `그 폴더 열기` after `exists`: the folder that has the name already. */
  readonly onOpen: (path: string) => void
  readonly testid: string
}) {
  const text = usePickerText()
  const id = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<{ readonly message: string; readonly existing?: string }>()
  let input: HTMLInputElement | undefined

  async function make() {
    const parent = props.parent()
    const name = input?.value.trim() ?? ""
    if (!parent || !name || busy()) return
    setBusy(true)
    setProblem(undefined)
    const made = await createFolder(props.runtime, parent, name).catch((error: unknown) => {
      setProblem({
        message: createFailureText(text, error),
        existing: error instanceof CreateFailure && error.reason === "exists" ? error.path : undefined,
      })
      return undefined
    })
    setBusy(false)
    if (!made) return
    setOpen(false)
    props.onMade(made)
  }

  const ime = createImeEnter({ onEnter: () => void make() })

  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          class="own-btn own-target"
          data-size="sm"
          disabled={!props.parent()}
          data-testid={props.testid}
          onClick={() => {
            setProblem(undefined)
            setOpen(true)
            requestAnimationFrame(() => input?.focus())
          }}
        >
          ＋ {text("own.picker.newFolder")}
        </button>
      }
    >
      <div class="flex w-full flex-col gap-1.5" data-testid={`${props.testid}-form`}>
        <div class="flex flex-wrap items-center gap-2">
          <label class="own-sr-only" for={id}>
            {text("own.picker.newFolder.label")}
          </label>
          <input
            ref={input}
            id={id}
            type="text"
            class="own-input h-8 min-w-[12ch] flex-1"
            placeholder={text("own.picker.newFolder.label")}
            autocomplete="off"
            spellcheck={false}
            enterkeyhint="done"
            maxlength={255}
            disabled={busy()}
            data-testid={`${props.testid}-name`}
            onKeyDown={(event) => {
              ime.keydown(event)
              if (event.code === "Escape") {
                event.stopPropagation()
                setOpen(false)
              }
            }}
            onKeyUp={(event) => ime.keyup(event)}
            onCompositionStart={() => ime.compositionstart()}
            onCompositionEnd={() => ime.compositionend()}
            onInput={() => {
              ime.input()
              setProblem(undefined)
            }}
          />
          <button
            type="button"
            class="own-btn own-target"
            data-size="sm"
            data-variant="primary"
            disabled={busy()}
            data-testid={`${props.testid}-make`}
            onClick={() => void make()}
          >
            {busy() ? text("own.picker.newFolder.making") : text("own.picker.newFolder.make")}
          </button>
          <button
            type="button"
            class="own-btn own-target"
            data-size="sm"
            disabled={busy()}
            onClick={() => setOpen(false)}
          >
            {text("own.picker.newFolder.cancel")}
          </button>
        </div>
        <Show when={problem()}>
          {(current) => (
            <p
              class="m-0 flex flex-wrap items-center gap-2 text-[12.5px] text-own-danger"
              role="alert"
              data-testid={`${props.testid}-error`}
            >
              {current().message}
              <Show when={current().existing}>
                {(existing) => (
                  <button
                    type="button"
                    class="own-btn own-target"
                    data-size="sm"
                    data-testid={`${props.testid}-open-existing`}
                    onClick={() => {
                      setOpen(false)
                      props.onOpen(existing())
                    }}
                  >
                    {text("own.picker.create.openExisting")}
                  </button>
                )}
              </Show>
            </p>
          )}
        </Show>
      </div>
    </Show>
  )
}
