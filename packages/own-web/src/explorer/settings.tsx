// 설정 > SSH 원격 호스트 `SSH 파일 탐색기` (04 §17.10, 05 §7.10): the Windows program `탐색기에서 열기` /
// `탐색기에서 보기` start for a conversation on an SSH host, and its argument template. Only in the desktop app
// (`host.explorer`); the desktop app keeps the setting (this PC's, not a host's) and picks the program with its own
// file dialog, so this page never names a file to start. The template is saved on Enter or when the field loses
// focus; an unusable one is not kept and the field goes back to the kept value.
import { createResource, createSignal, Show } from "solid-js"
import { useHost } from "@/host"
import type { ExplorerProgram } from "@/host/types"
import { showToast } from "@/switcher/toast"
import { explorerText } from "./strings"

export const DEFAULT_TEMPLATE = "--open {host} {path}"

export function ExplorerSettings() {
  const host = useHost()
  return <Show when={host.explorer}>{(explorer) => <Program explorer={explorer()} />}</Show>
}

function Program(props: { readonly explorer: NonNullable<ReturnType<typeof useHost>["explorer"]> }) {
  const text = explorerText.use()
  const [program, actions] = createResource(() => props.explorer.program())
  const [draft, setDraft] = createSignal<string>()
  const template = () => draft() ?? program.latest?.template ?? ""
  const failed = (error: unknown) =>
    void showToast({
      message: text("own.explorer.settings.failed", { detail: error instanceof Error ? error.message : String(error) }),
      tone: "danger",
    })
  const keep = (next: ExplorerProgram) => {
    actions.mutate(next)
    setDraft(undefined)
    return next
  }
  const saveTemplate = (value: string) => {
    const wanted = value.trim()
    if (program.loading || program.error || wanted === program.latest?.template) return setDraft(undefined)
    void props.explorer
      .setTemplate(wanted)
      .then(keep)
      .then((kept) => {
        if (kept.template !== wanted) showToast({ message: text("own.explorer.settings.badTemplate"), tone: "danger" })
      }, failed)
  }
  return (
    <section
      class="flex flex-col gap-2 rounded-[var(--own-radius-card)] border border-own-border px-4 py-3"
      data-testid="explorer-settings"
    >
      <h2 class="m-0 text-[13.5px] font-semibold">{text("own.explorer.settings.title")}</h2>
      <p class="m-0 text-own-muted">{text("own.explorer.settings.about")}</p>
      <Show
        when={!program.error}
        fallback={
          <p class="m-0" role="alert" data-testid="explorer-settings-unavailable">
            {text("own.explorer.fail.unavailable")}
          </p>
        }
      >
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="w-36 flex-none text-own-muted">{text("own.explorer.settings.program")}</span>
          <span class="min-w-0 flex-1 break-all" data-testid="explorer-settings-program">
            <bdi>{program.latest?.program ?? text("own.explorer.settings.none")}</bdi>
          </span>
          <button
            type="button"
            class="own-btn own-target"
            data-size="sm"
            data-testid="explorer-settings-pick"
            disabled={program.loading}
            onClick={() => void props.explorer.pickProgram().then(keep, failed)}
          >
            {text("own.explorer.settings.pick")}
          </button>
          <Show when={program.latest?.program}>
            <button
              type="button"
              class="own-btn own-target"
              data-size="sm"
              data-testid="explorer-settings-clear"
              onClick={() => void props.explorer.clearProgram().then(keep, failed)}
            >
              {text("own.explorer.settings.clear")}
            </button>
          </Show>
        </div>
        <label class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="w-36 flex-none text-own-muted">{text("own.explorer.settings.template")}</span>
          <input
            type="text"
            class="own-input h-8 min-w-0 flex-1 font-mono"
            spellcheck={false}
            autocomplete="off"
            maxLength={1024}
            placeholder={DEFAULT_TEMPLATE}
            value={template()}
            disabled={program.loading}
            data-testid="explorer-settings-template"
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.code !== "Enter" && event.code !== "NumpadEnter") return
              if (event.isComposing) return
              saveTemplate(event.currentTarget.value)
            }}
            onBlur={(event) => saveTemplate(event.currentTarget.value)}
          />
          <Show when={program.latest && program.latest.template !== DEFAULT_TEMPLATE}>
            <button
              type="button"
              class="own-btn own-target"
              data-size="sm"
              data-testid="explorer-settings-reset"
              onClick={() => saveTemplate(DEFAULT_TEMPLATE)}
            >
              {text("own.explorer.settings.reset")}
            </button>
          </Show>
        </label>
        <p class="m-0 text-own-muted" data-testid="explorer-settings-help">
          {text("own.explorer.settings.help")} {text("own.explorer.settings.portHelp")}
        </p>
      </Show>
    </section>
  )
}
