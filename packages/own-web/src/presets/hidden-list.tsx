// 설정 > 프리셋 `숨긴 모델` (07 §7.1 숨긴 모델, PF 2026-11-03): every model the user hid from the lists, with its
// provider group and `다시 보이기`. The one place that lists them all; the switcher and the preset editor also show
// theirs behind `숨긴 모델 n개`. Part of the lazy settings page (PF5).
import { Preset } from "@own/protocol/preset"
import { Schema } from "effect"
import { For, Show } from "solid-js"
import { useData } from "@/data"
import { createStatus, StatusLine } from "@/limits/kit"
import { modelLabel } from "@/sidebar/model"
import { hiddenOf } from "./hidden"
import { usePresetFixesText } from "./pf-strings"
import { useTargetText } from "./target-picker"

export function HiddenModels() {
  const data = useData()
  const fixes = usePresetFixesText()
  const names = useTargetText()
  const hidden = hiddenOf(data.local().own)
  const status = createStatus()
  void hidden.refresh().catch(() => undefined)
  const show = (group: string, model: string) => {
    status.clear()
    void hidden
      .show(group, model)
      .catch((error: unknown) =>
        status.error(fixes("own.pf.hiddenFailed", { message: error instanceof Error ? error.message : String(error) })),
      )
  }
  return (
    <section class="own-psec" data-testid="presets-hidden-models">
      <div class="own-psec-head">
        <h2>{fixes("own.pf.hiddenTitle")}</h2>
      </div>
      <p class="m-0 text-[12.5px] text-own-muted">{fixes("own.pf.hiddenBody")}</p>
      <Show when={hidden.list().length} fallback={<p class="own-placeholder px-0">{fixes("own.pf.hiddenNone")}</p>}>
        <For each={hidden.list()}>
          {(item) => (
            <div class="own-pp-row" data-testid="presets-hidden-row" data-group={item.group} data-model={item.model}>
              <span>
                <b class="font-semibold">{modelLabel(item.model, item.model)}</b>{" "}
                <span class="text-own-muted">· {isGroup(item.group) ? names.group(item.group) : item.group}</span>
              </span>
              <Show when={hidden.editable()}>
                <button
                  type="button"
                  class="own-btn ml-auto"
                  data-size="sm"
                  data-testid="presets-hidden-show"
                  onClick={() => show(item.group, item.model)}
                >
                  {fixes("own.pf.unhide")}
                </button>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <StatusLine status={status} testid="presets-hidden-status" />
    </section>
  )
}

const isGroup = Schema.is(Preset.Group)
