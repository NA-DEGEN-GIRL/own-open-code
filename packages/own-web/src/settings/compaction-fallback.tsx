// Settings > 자동 압축 > 압축 실패 시 대체 모델 (own/docs/11 §3): which models write the checkpoint, in order, when a
// session's own model fails to compact (an error or a refusal). Automatic until the user chooses; the account that
// failed is always skipped and only the first three are tried; when all fail, code makes the checkpoint without a
// model. Read and written through own.harness `compaction.get/set` of this PC's server. A service without own.harness
// (or one from before this setting) says so in a muted line instead of an error; another failure offers `다시 시도`.
import type { Account } from "@own/protocol"
import type { OwnHarness } from "@own/protocol/rpc-harness"
import { createSignal, For, onMount, Show } from "solid-js"
import { errorMessage, errorType } from "@/accounts/errors"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { createStatus, Segmented, StatusLine } from "@/limits/kit"
import { useCompactionText } from "./compaction-strings"

type Mode = "automatic" | "chosen"

export function CompactionFallbackSection(props: { readonly accounts: readonly Account.View[] }) {
  const i18n = useI18n()
  const text = useCompactionText()
  const harness = useData().local().harness
  const [view, setView] = createSignal<OwnHarness.CompactionFallback>()
  /** The list being edited; undefined while showing what is saved. */
  const [draft, setDraft] = createSignal<readonly OwnHarness.FallbackModel[]>()
  const status = createStatus()
  /** Why nothing could be read: this service cannot set them, or the read failed (with `다시 시도`). */
  const [problem, setProblem] = createSignal<"unavailable" | "failed">()
  const editable = () => harness.allowed("compaction.set")

  const load = () =>
    harness.call("compaction.get", {}).then(
      (next) => {
        setView(next)
        setProblem(undefined)
        status.clear()
      },
      (error: unknown) => {
        const type = errorType(error)
        if (type === "rpc.unavailable" || type === "rpc.method_not_found") return setProblem("unavailable")
        setProblem("failed")
        status.error(errorMessage(i18n, error))
      },
    )
  onMount(() => void load())

  const choices = () =>
    props.accounts.flatMap((account) =>
      (account.compaction?.effective ?? []).map((item) => ({
        providerID: account.providerID as string,
        modelID: item.modelID as string,
        label: `${account.label} · ${item.modelID}`,
      })),
    )
  const key = (model: OwnHarness.FallbackModel) => `${model.providerID}/${model.modelID}`
  const label = (model: OwnHarness.FallbackModel) =>
    choices().find((choice) => key(choice) === key(model))?.label ?? `${model.providerID} · ${model.modelID}`
  const mode = (): Mode => (draft() !== undefined || view()?.automatic === false ? "chosen" : "automatic")
  const list = () => draft() ?? view()?.models ?? []
  const addable = () => choices().filter((choice) => !list().some((model) => key(model) === key(choice)))

  const save = (models: readonly OwnHarness.FallbackModel[] | null) =>
    harness
      .call("compaction.set", { models: models === null ? null : [...models] })
      .then((next) => {
        setView(next)
        setDraft(undefined)
        status.ok(text(next.automatic ? "own.compact.fallback.savedAuto" : "own.compact.fallback.saved"))
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  const pick = (next: Mode) => {
    if (next === "automatic") return void save(null)
    setDraft(list())
  }
  const move = (index: number, delta: number) => {
    const current = [...list()]
    const [item] = current.splice(index, 1)
    current.splice(index + delta, 0, item!)
    setDraft(current)
  }

  return (
    <section class="own-psec" data-testid="compaction-fallback-settings">
      <div class="own-psec-head flex-wrap">
        <h2>{text("own.compact.fallback.title")}</h2>
        <div class="ml-auto" hidden={problem() !== undefined}>
          <Segmented<Mode>
            label={text("own.compact.fallback.title")}
            value={mode()}
            options={[
              { value: "automatic", label: text("own.compact.fallback.automatic"), disabled: !editable() },
              { value: "chosen", label: text("own.compact.fallback.chosen"), disabled: !editable() },
            ]}
            onChange={pick}
            testid="compaction-fallback-mode"
          />
        </div>
      </div>
      <p class="m-0 mb-2 text-[12.5px] leading-[18px] text-own-muted">{text("own.compact.fallback.note")}</p>
      <Show when={problem() === "unavailable"}>
        <p class="m-0 text-[12.5px] leading-[18px] text-own-muted" data-testid="compaction-fallback-unavailable">
          {text("own.compact.fallback.unavailable")}
        </p>
      </Show>
      <ol
        class="m-0 flex list-none flex-col p-0"
        hidden={problem() !== undefined}
        data-testid="compaction-fallback-list"
      >
        <For each={list()} fallback={<li class="own-placeholder px-0">{text("own.compact.fallback.empty")}</li>}>
          {(model, index) => (
            <li class="flex items-center gap-2 border-b border-own-border py-1.5 text-[13px]">
              <span class="w-5 text-own-muted">{index() + 1}</span>
              <span class="flex-1">{label(model)}</span>
              <Show when={draft() !== undefined}>
                <button
                  type="button"
                  class="own-icon-button h-6 w-6"
                  aria-label={text("own.compact.fallback.up")}
                  disabled={index() === 0}
                  onClick={() => move(index(), -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="own-icon-button h-6 w-6"
                  aria-label={text("own.compact.fallback.down")}
                  disabled={index() === list().length - 1}
                  onClick={() => move(index(), 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="own-icon-button h-6 w-6"
                  aria-label={text("own.compact.fallback.remove")}
                  onClick={() => setDraft(list().filter((_, at) => at !== index()))}
                >
                  ✕
                </button>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={draft() === undefined && mode() === "chosen" && editable()}>
        <div class="mt-2.5">
          <button type="button" class="own-btn" data-size="sm" onClick={() => setDraft(list())}>
            {text("own.compact.fallback.edit")}
          </button>
        </div>
      </Show>
      <Show when={draft() !== undefined}>
        <div class="mt-2.5 flex flex-wrap items-center gap-2">
          <select
            class="own-input max-w-[320px]"
            value=""
            aria-label={text("own.compact.fallback.add")}
            data-testid="compaction-fallback-add"
            onChange={(event) => {
              const choice = addable().find((item) => key(item) === event.currentTarget.value)
              if (choice) setDraft([...list(), { providerID: choice.providerID, modelID: choice.modelID }])
              event.currentTarget.value = ""
            }}
          >
            <option value="">{text("own.compact.fallback.add")}</option>
            <For each={addable()}>{(choice) => <option value={key(choice)}>{choice.label}</option>}</For>
          </select>
          <button type="button" class="own-btn" data-size="sm" onClick={() => setDraft(undefined)}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            data-testid="compaction-fallback-save"
            onClick={() => void save(list())}
          >
            {i18n.t("own.kit.save")}
          </button>
        </div>
      </Show>
      <StatusLine status={status} testid="compaction-fallback-status" />
      <Show when={problem() === "failed"}>
        <div class="mt-2">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="compaction-fallback-retry"
            onClick={() => void load()}
          >
            {text("own.compact.fallback.retry")}
          </button>
        </div>
      </Show>
    </section>
  )
}
