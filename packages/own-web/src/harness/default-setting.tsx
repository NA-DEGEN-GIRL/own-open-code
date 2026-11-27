// Settings > 일반 `새 대화의 에이전트 방식` and `지시문` (10 §3.8, §3.9): the service's default for new top-level
// conversations, own.harness `defaults.set` on this PC's service (scope `local`; a phone or another PC sees it
// read-only). Every creator follows it: this window, a phone, another PC, team mains, owners and peers. own's revised
// prompt is the plugin's default (H-D7, amended 2026-10-17); the original, and on services from 2026-10-18 on the
// user's 내 지시문 (§3.11, written in 설정 > 에이전트 방식), can be chosen here. Each row sends the other
// row's shown value too; the service stores only values that differ from its plugin options, so changing the harness
// does not pin the prompt (own-harness defaults.ts). An older service without `defaults.set` keeps its plugin options
// and says so. The row's logic is harness/default-state.ts.
import { onMount, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { Segmented } from "@/limits/kit"
import { Setting } from "@/settings/sections"
import { showToast } from "@/switcher/toast"
import { harnessDefaultState } from "./default-state"
import { omoDescription } from "./index"

export function HarnessDefaultSetting() {
  const data = useData()
  const i18n = useI18n()
  const state = harnessDefaultState({
    runtime: () => data.local(),
    t: i18n.t,
    toast: showToast,
    omoDescription: () => omoDescription(i18n.locale()),
  })
  onMount(() => void state.load())

  return (
    <Show when={state.list()}>
      {(current) => (
        <>
          <Setting
            title={i18n.t("own.harness.default.title")}
            note={[state.description(), state.note()].filter((line) => line !== undefined).join(" ")}
          >
            <Segmented
              label={i18n.t("own.harness.default.title")}
              value={current().default}
              options={state.harnesses().map((id) => ({
                value: id,
                label: i18n.t(`own.harness.name.${id}`),
                disabled: !state.allowed() || state.busy(),
              }))}
              onChange={(harness) => void state.save({ harness, prompt: current().defaultPrompt })}
              testid="settings-harness-default"
            />
          </Setting>
          <Show when={state.promptShown()}>
            <Setting title={i18n.t("own.harness.default.prompt")} note={state.promptNote()}>
              <Segmented
                label={i18n.t("own.harness.default.prompt")}
                value={current().defaultPrompt}
                options={state.prompts().map((id) => ({
                  value: id,
                  label: i18n.t(`own.harness.prompt.name.${id}`),
                  disabled: !state.allowed() || state.busy(),
                }))}
                onChange={(prompt) => void state.save({ harness: current().default, prompt })}
                testid="settings-harness-prompt"
              />
            </Setting>
          </Show>
        </>
      )}
    </Show>
  )
}
