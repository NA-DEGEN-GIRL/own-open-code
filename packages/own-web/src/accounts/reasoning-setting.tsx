// 02 §3.3a: one model's `추론 강도`, 자동 / 끔 / 단계 / 켬·끔 (and 생각 예산 for an Anthropic-format server), with the levels
// to send for `단계`, what the server reported and the request field the choice fills. Used by the local model add form
// and the `모델 기능` dialog of every compat account.
import type { Account } from "@own/protocol"
import { Show } from "solid-js"
import { Segmented, TextField } from "@/limits/kit"
import { detectedText, modesOf, sendsText, type ReasoningDraft } from "./local-model"
import { useLocalText } from "./local-strings"

export function ReasoningSetting(props: {
  readonly model: string
  readonly format: Account.LocalFormat
  readonly draft: ReasoningDraft
  readonly onChange: (draft: ReasoningDraft) => void
  /** What the server reported; shown under the setting when given (`null` = no reasoning, `undefined` key = unknown). */
  readonly detected?: { readonly value: Account.Reasoning | null | undefined }
}) {
  const text = useLocalText()
  const options = () => modesOf(props.format).map((value) => ({ value, label: text(`own.local.reasoning.${value}`) }))
  return (
    <div class="flex flex-col gap-1" data-testid="local-reasoning" data-model={props.model}>
      <span class="own-field-label text-[12.5px] text-own-muted">{text("own.local.reasoning")}</span>
      <Segmented
        label={`${props.model} · ${text("own.local.reasoning")}`}
        value={props.draft.mode}
        options={options()}
        onChange={(mode) => props.onChange({ ...props.draft, mode })}
        testid="local-reasoning-mode"
      />
      <Show when={props.draft.mode === "effort"}>
        <TextField
          label={text("own.local.reasoning.levels")}
          value={props.draft.levels}
          onValue={(levels) => props.onChange({ ...props.draft, levels })}
          hint={text("own.local.reasoning.levelsHint")}
          class="own-mono"
          testid="local-reasoning-levels"
        />
      </Show>
      <Show when={props.detected}>
        {(detected) => (
          <span class="text-[11.5px] text-own-faint" data-testid="local-reasoning-detected">
            {detectedText(text, detected().value)}
          </span>
        )}
      </Show>
      <Show when={sendsText(text, props.format, props.draft.mode)}>
        {(sends) => <span class="text-[11.5px] text-own-faint">{sends()}</span>}
      </Show>
    </div>
  )
}
