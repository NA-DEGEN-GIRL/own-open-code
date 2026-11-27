// `Codex 최신 모델 자동 확인` (07 §4.5, CA 2026-10-19) on screen: the row of 설정 > 프리셋's ChatGPT tab (on/off, one line
// on what it does, the version the lists are asked as and when own last checked, the models own left out) and the
// ChatGPT account card's note when its list had models own does not know yet. Both show this PC's service
// (`data.local()`); the store is accounts/codex-models.ts.
import { Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { createStatus, Notice, Segmented, StatusLine } from "@/limits/kit"
import { minuteNow } from "@/shell/clock"
import { borrowedNote, codexModels, newerNote, unknownNote, versionLine } from "./codex-models"
import { useCodexModelsText } from "./codex-models-strings"

/** 설정 > 프리셋, ChatGPT tab: `Codex 최신 모델 자동 확인 [켬 | 끔]`. */
export function CodexModelsSetting() {
  const runtime = useData().local()
  const i18n = useI18n()
  const text = useCodexModelsText()
  const store = codexModels(runtime)
  const status = createStatus()
  void store.load()
  const save = async (on: boolean) => {
    status.clear()
    await store.set(on).then(
      () => status.ok(text(on ? "own.codexModels.savedOn" : "own.codexModels.savedOff")),
      () => status.error(text("own.codexModels.failed")),
    )
  }
  return (
    <div class="own-pp-row" data-testid="presets-codex-models">
      <div class="own-pp-main">
        <b class="block font-semibold">{text("own.codexModels.title")}</b>
        <span class="block text-[12px] text-own-muted">{text("own.codexModels.note")}</span>
        <Show when={store.view()}>
          {(view) => (
            <>
              <span class="block text-[12px] text-own-muted" data-testid="presets-codex-models-version">
                {versionLine(text, i18n, view(), minuteNow())}
              </span>
              <Show when={newerNote(text, view())}>
                {(note) => (
                  <span class="block text-[12px] text-own-muted" data-testid="presets-codex-models-newer">
                    {note()}
                  </span>
                )}
              </Show>
              <Show when={unknownNote(text, view())}>
                {(note) => (
                  <span class="block text-[12px] text-own-warn" data-testid="presets-codex-models-unknown">
                    {note()}
                  </span>
                )}
              </Show>
              <Show when={borrowedNote(text, view())}>
                {(note) => (
                  <span class="block text-[12px] text-own-muted" data-testid="presets-codex-models-borrowed">
                    {note()}
                  </span>
                )}
              </Show>
            </>
          )}
        </Show>
        <Show when={store.unsupported()}>
          <span class="block text-[12px] text-own-muted">{text("own.codexModels.unavailable")}</span>
        </Show>
        <Show when={store.view() && !store.editable()}>
          <div class="mt-1">
            <Notice>{text("own.codexModels.readOnly")}</Notice>
          </div>
        </Show>
        <StatusLine status={status} testid="presets-codex-models-status" />
      </div>
      <Show when={store.view()}>
        {(view) => (
          <Segmented
            label={text("own.codexModels.title")}
            value={view().autoVersion ? "on" : "off"}
            options={(["on", "off"] as const).map((value) => ({
              value,
              label: text(value === "on" ? "own.codexModels.on" : "own.codexModels.off"),
              disabled: !store.editable(),
            }))}
            onChange={(value) => void save(value === "on")}
            testid="presets-codex-models-choice"
          />
        )}
      </Show>
    </div>
  )
}

/**
 * A ChatGPT account card's `⚠ own이 아직 못 돌리는 Codex 모델은 빠졌어요: … · own 업데이트가 필요해요` (each model with the
 * field and value own cannot run yet; an older service's count), and the models running with borrowed instructions.
 */
export function CodexUnknownNote(props: { readonly accountID: string }) {
  const runtime = useData().local()
  const text = useCodexModelsText()
  const store = codexModels(runtime)
  return (
    <>
      <Show when={unknownNote(text, store.view(), props.accountID)}>
        {(note) => (
          <span class="text-own-warn" data-testid="codex-unknown-models">
            ⚠ {note()}
          </span>
        )}
      </Show>
      <Show when={borrowedNote(text, store.view())}>
        {(note) => (
          <span class="text-own-muted" data-testid="codex-borrowed-models">
            {note()}
          </span>
        )}
      </Show>
    </>
  )
}
