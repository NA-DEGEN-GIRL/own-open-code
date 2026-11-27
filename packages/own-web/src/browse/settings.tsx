// 설정 > 내 브라우저 사용 (실험) (BRW; lazy, `/settings/browse`). One switch and the `browse` program's path on this PC's
// service (`browse.set`, `local`: the program runs on this PC), what the service found (`browse.status`, a path; it
// never runs the program or touches a browser), the two things the user installs (the Chrome Web Store extension and
// the program, from OpenCode's pages; the app installs neither), what each approval mode lets the agent do and the
// safety notes. Another device and an SSH host's page read the state and cannot change it. The per-conversation switch
// is in the conversation's `⋯` (dialog.tsx).
import { createResource, createSignal, Show } from "solid-js"
import type { OwnBrowse } from "@own/protocol"
import { errorMessage } from "@/accounts/errors"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { createStatus, StatusLine } from "@/limits/kit"
import { useBrowseText } from "./strings"
import { refreshBrowseStatus, rememberBrowseStatus } from "./state"

/** The links the page opens (`OwnBrowse.STORE_URL`, `PRODUCT_URL`; kept here so the page needs no value import). */
export const STORE_URL = "https://chromewebstore.google.com/detail/mfnicocicmmlkpjnaffgihfjhdgjkdjg"
export const PRODUCT_URL = "https://opencode.ai/product/browse"

export default function BrowseSettings() {
  const data = useData()
  const i18n = useI18n()
  const text = useBrowseText()
  const rpc = data.local().rpc
  const status = createStatus()
  const writable = () => rpc.allowed("browse.set")
  const [view, { mutate, refetch }] = createResource(() => refreshBrowseStatus(rpc))
  const [path, setPath] = createSignal<string>()

  const save = (patch: OwnBrowse.Setting, done: string) => {
    status.clear()
    void rpc
      .call("browse.set", patch)
      .then((next) => {
        mutate(next)
        rememberBrowseStatus(next)
        status.ok(done)
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }
  const found = (current: OwnBrowse.Status) => {
    if (current.command === undefined) return text(current.given ? "own.browse.missingSetting" : "own.browse.missing")
    if (current.source === "setting") return text("own.browse.found.setting", { path: current.command })
    if (current.source === "path") return text("own.browse.found.path", { path: current.command })
    return text("own.browse.found.install", { path: current.command })
  }

  return (
    <div class="flex flex-col" data-testid="settings-browse">
      <Show
        when={view.state !== "pending" || view()}
        fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}
      >
        <Show when={view()} fallback={<p class="own-placeholder px-0">{text("own.browse.unsupported")}</p>}>
          {(current) => (
            <>
              <section class="own-psec !mt-2 flex flex-col gap-2">
                <p class="m-0 text-[12.5px] text-own-muted">{text("own.browse.lead")}</p>
                <label class="flex items-center gap-2 text-[13.5px] font-semibold">
                  <input
                    type="checkbox"
                    checked={current().enabled}
                    disabled={!writable()}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked
                      save({ enabled }, text(enabled ? "own.browse.on" : "own.browse.off"))
                    }}
                    data-testid="browse-toggle"
                  />
                  <span>{text("own.browse.toggle")}</span>
                </label>
                <Show when={!writable()}>
                  <p class="m-0 text-[12px] text-own-muted">{text("own.browse.readOnly")}</p>
                </Show>
                <Show when={current().enabled}>
                  <p class="m-0 text-[12px]" data-testid="browse-active">
                    {text(current().active ? "own.browse.active" : "own.browse.inactive")}
                  </p>
                </Show>
                <p class="m-0 text-[12px] leading-[18px] text-own-muted">{text("own.browse.default")}</p>
                <StatusLine status={status} />
              </section>

              <section class="own-psec flex flex-col gap-2">
                <div class="own-psec-head">
                  <h2>{text("own.browse.program")}</h2>
                </div>
                <p class="m-0 text-[12.5px] break-all" data-testid="browse-found">
                  {found(current())}
                </p>
                <Show when={writable()}>
                  <label class="flex flex-col gap-1 text-[12.5px]">
                    <span>{text("own.browse.path")}</span>
                    <input
                      class="own-input"
                      value={path() ?? current().command ?? ""}
                      placeholder={text("own.browse.pathPlaceholder")}
                      spellcheck={false}
                      onInput={(event) => setPath(event.currentTarget.value)}
                      data-testid="browse-path"
                    />
                  </label>
                  <div class="flex flex-wrap gap-2">
                    <button
                      type="button"
                      class="own-btn"
                      disabled={path() === undefined}
                      onClick={() => save({ command: path() ?? "" }, text("own.browse.pathSaved"))}
                      data-testid="browse-path-save"
                    >
                      {text("own.browse.pathSave")}
                    </button>
                    <button type="button" class="own-btn" onClick={() => void refetch()} data-testid="browse-recheck">
                      {text("own.browse.recheck")}
                    </button>
                  </div>
                </Show>
              </section>

              <section class="own-psec flex flex-col gap-2">
                <div class="own-psec-head">
                  <h2>{text("own.browse.install")}</h2>
                </div>
                <div class="flex flex-col gap-1.5 text-[12.5px] leading-[18px]">
                  <p class="m-0 text-own-muted">{text("own.browse.install.lead")}</p>
                  <p class="m-0">
                    {text("own.browse.install.extension")}{" "}
                    <a href={STORE_URL} target="_blank" rel="noreferrer noopener" class="own-link">
                      {text("own.browse.install.extensionLink")} ↗
                    </a>
                  </p>
                  <p class="m-0">
                    {text("own.browse.install.program")}{" "}
                    <a href={PRODUCT_URL} target="_blank" rel="noreferrer noopener" class="own-link">
                      {text("own.browse.install.programLink")} ↗
                    </a>
                  </p>
                  <p class="m-0 text-own-muted">{text("own.browse.install.agents")}</p>
                </div>
              </section>

              <section class="own-psec flex flex-col gap-2">
                <div class="own-psec-head">
                  <h2>{text("own.browse.modes")}</h2>
                </div>
                <ul
                  class="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-[18px]"
                  data-testid="browse-modes"
                >
                  <li>{text("own.browse.modes.full")}</li>
                  <li>{text("own.browse.modes.ask")}</li>
                  <li>{text("own.browse.modes.readOnly")}</li>
                </ul>
              </section>

              <section class="own-psec flex flex-col gap-2">
                <div class="own-psec-head">
                  <h2>{text("own.browse.safety")}</h2>
                </div>
                <ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] leading-[18px] text-own-muted">
                  <li>{text("own.browse.safety.tabs")}</li>
                  <li>{text("own.browse.safety.handoff")}</li>
                  <li>{text("own.browse.safety.injection")}</li>
                  <li>{text("own.browse.safety.profile")}</li>
                  <li>{text("own.browse.safety.remote")}</li>
                  <li>{text("own.browse.remote")}</li>
                </ul>
              </section>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}
