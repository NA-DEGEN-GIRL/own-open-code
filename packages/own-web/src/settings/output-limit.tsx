// 설정 > 출력 상한 (03 §5.7.4, 02 §4.9, OL 2026-10-19), lazy with its section. Two choices on this PC's service
// (`policy.outputLimit` through `policy.get`/`policy.set`), so every window, device and SSH host agrees: `이 값을 넘기지
// 않기` with the number (default 256,000, core's own) and `출력 상한 보내지 않기`. A choice saves at once with the number
// on screen; the number saves with `저장` or Enter and is kept while `보내지 않기` is chosen. `기본으로` clears the setting.
// The page reads the service again when it opens, since another window may have changed it. A connection without
// `policy.set` shows it read-only. The logic is output-limit-model.ts.
import { OutputLimit } from "@own/protocol/output-limit"
import { createSignal, For, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { errorMessage, errorType } from "@/accounts/errors"
import { grouped } from "@/limits/format"
import { createStatus, StatusLine, Tag } from "@/limits/kit"
import { loadPolicy, policyState, updatePolicy } from "@/limits/shared"
import { isDefault, NUMBERS, parseLimit, patchOf, shown, stored } from "./output-limit-model"
import { useOutputLimitText, type OutputLimitKey } from "./output-limit-strings"

const OMIT_NOTES: readonly OutputLimitKey[] = [
  "own.output.omitClaude",
  "own.output.omitDeepSeek",
  "own.output.omitOthers",
]
const NOTES: readonly OutputLimitKey[] = [
  "own.output.never",
  "own.output.compaction",
  "own.output.cache",
  "own.output.shared",
]

export default function OutputLimitSettings() {
  const data = useData()
  const i18n = useI18n()
  const text = useOutputLimitText()
  const own = data.local().own
  void loadPolicy(own, true)
  const status = createStatus()
  const [draft, setDraft] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const writable = () => own.rpc.allowed("policy.set")
  const current = () => shown(policyState()?.policy)
  const typed = () => draft() ?? grouped(current().maxTokens)
  const parsed = () => parseLimit(typed())
  const locked = () => !writable() || busy()

  const save = async (setting: OutputLimit.Setting) => {
    status.clear()
    setBusy(true)
    const patch = patchOf(setting)
    await own.rpc
      .call("policy.set", { patch })
      .then((output) => {
        updatePolicy(own, output.policy)
        if (!stored(patch, output.policy)) return status.error(text("own.output.unknown"))
        setDraft(undefined)
        status.ok(text(isDefault(setting) ? "own.output.resetDone" : "own.output.saved", NUMBERS))
      })
      .catch((error: unknown) =>
        status.error(
          errorType(error) === "setting_out_of_range" ? text("own.output.range", NUMBERS) : errorMessage(i18n, error),
        ),
      )
      .finally(() => setBusy(false))
  }
  const choose = (mode: OutputLimit.Mode) => void save({ mode, maxTokens: parsed() ?? current().maxTokens })
  const saveNumber = () => {
    const maxTokens = parsed()
    if (maxTokens === undefined) return status.error(text("own.output.range", NUMBERS))
    void save({ mode: "cap", maxTokens })
  }
  const invalid = () => draft() !== undefined && parsed() === undefined

  return (
    <Show when={policyState()} fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
      <div class="flex flex-col gap-3" data-testid="settings-output-limit">
        <p class="m-0 text-[13px] leading-5 text-own-muted" data-testid="output-limit-lead">
          {text("own.output.lead")}
        </p>
        <Show when={!writable()}>
          <p class="m-0 text-[12px] text-own-muted">{text("own.output.readOnly")}</p>
        </Show>
        <fieldset class="m-0 flex flex-col gap-3 border-0 p-0" disabled={locked()} data-mode={current().mode}>
          <legend class="own-sr-only">{text("own.output.choice")}</legend>
          <div class="flex flex-col gap-1.5">
            <label class="flex items-center gap-2 text-[13.5px] font-semibold">
              <input
                type="radio"
                name="own-output-limit"
                checked={current().mode === "cap"}
                onChange={() => choose("cap")}
                data-testid="output-limit-cap"
              />
              <span data-testid="output-limit-cap-label">{text("own.output.cap")}</span>
              <Show when={isDefault(current())}>
                <Tag tone="plain" testid="output-limit-default">
                  {text("own.output.default")}
                </Tag>
              </Show>
            </label>
            <div class="flex flex-wrap items-center gap-2 pl-6">
              <label class="flex items-center gap-2 text-[13px]">
                <span aria-hidden="true">{text("own.output.max")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autocomplete="off"
                  spellcheck={false}
                  class="own-input w-[132px] text-right tabular-nums"
                  aria-label={text("own.output.field")}
                  aria-invalid={invalid() ? true : undefined}
                  aria-describedby="own-output-limit-note"
                  value={typed()}
                  disabled={current().mode !== "cap"}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.isComposing) saveNumber()
                  }}
                  data-testid="output-limit-input"
                />
                <span aria-hidden="true">{text("own.output.unit")}</span>
              </label>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-variant="primary"
                disabled={current().mode !== "cap" || draft() === undefined}
                onClick={saveNumber}
                data-testid="output-limit-save"
              >
                {text("own.output.save")}
              </button>
            </div>
            <span id="own-output-limit-note" class="pl-6 text-[12px] leading-[18px] text-own-muted">
              {invalid() ? text("own.output.range", NUMBERS) : text("own.output.capNote")}
            </span>
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="flex items-center gap-2 text-[13.5px] font-semibold">
              <input
                type="radio"
                name="own-output-limit"
                checked={current().mode === "omit"}
                onChange={() => choose("omit")}
                data-testid="output-limit-omit"
              />
              <span data-testid="output-limit-omit-label">{text("own.output.omit")}</span>
            </label>
            <span class="pl-6 text-[12px] leading-[18px] text-own-muted">{text("own.output.omitNote")}</span>
            <ul class="m-0 flex list-disc flex-col gap-0.5 pl-10 text-[12px] leading-[18px] text-own-muted">
              <For each={OMIT_NOTES}>{(key) => <li>{text(key, NUMBERS)}</li>}</For>
            </ul>
          </div>
        </fieldset>
        <div class="flex flex-col gap-1 border-t border-own-border pt-3 text-[12px] leading-[18px] text-own-muted">
          <For each={NOTES}>{(key) => <p class="m-0">{text(key)}</p>}</For>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="own-btn"
            disabled={locked() || isDefault(current())}
            onClick={() => void save(OutputLimit.DEFAULT)}
            data-testid="output-limit-reset"
          >
            {text("own.output.reset")}
          </button>
          <StatusLine status={status} testid="output-limit-status" />
        </div>
      </div>
    </Show>
  )
}
