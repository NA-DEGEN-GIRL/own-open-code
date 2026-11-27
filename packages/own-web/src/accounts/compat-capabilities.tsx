// 02 §3.3: each compat model's image input and tools, 자동 / 켬 / 끔. `CapabilitySettings` is one model's pair of
// switches, used by the add form's model rows and by the account card's `모델 기능…` dialog, which saves through
// `accounts.update{compatCapabilities}`, shows what the server reported and can read it again (`accounts.test`, the
// router reads a compat server again after a passed test).
import type { Account } from "@own/protocol"
import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Segmented, createStatus, StatusLine } from "@/limits/kit"
import { useCompatText } from "./compat-strings"
import { errorMessage } from "./errors"
import { draftOf, settingOf, type ReasoningDraft } from "./local-model"
import { compatSettingsChange } from "./model"
import { ReasoningSetting } from "./reasoning-setting"

const SETTINGS = ["auto", "on", "off"] as const

/** One model's `그림 입력` and `도구`; under each, what the server reported when `detected` is given (the dialog). */
export function CapabilitySettings(props: {
  readonly model: string
  readonly image: Account.CompatSetting
  readonly tools: Account.CompatSetting
  readonly onImage: (value: Account.CompatSetting) => void
  readonly onTools: (value: Account.CompatSetting) => void
  readonly detected?: { readonly image?: boolean; readonly tools?: boolean }
}) {
  const text = useCompatText()
  const options = () => SETTINGS.map((value) => ({ value, label: text(`own.compat.setting.${value}`) }))
  const reported = (field: "image" | "tools") => {
    const value = props.detected?.[field]
    return text(`own.compat.detected.${field}.${value === undefined ? "unknown" : value}`)
  }
  return (
    <div class="flex flex-wrap gap-x-5 gap-y-2" data-testid="compat-capabilities" data-model={props.model}>
      <div class="flex flex-col gap-1">
        <span class="own-field-label text-[12.5px] text-own-muted">{text("own.compat.image")}</span>
        <Segmented
          label={`${props.model} · ${text("own.compat.image")}`}
          value={props.image}
          options={options()}
          onChange={props.onImage}
          testid="compat-image"
        />
        <Show when={props.detected}>
          <span class="text-[11.5px] text-own-faint" data-testid="compat-image-detected">
            {reported("image")}
          </span>
        </Show>
      </div>
      <div class="flex flex-col gap-1">
        <span class="own-field-label text-[12.5px] text-own-muted">{text("own.compat.tools")}</span>
        <Segmented
          label={`${props.model} · ${text("own.compat.tools")}`}
          value={props.tools}
          options={options()}
          onChange={props.onTools}
          testid="compat-tools"
        />
        <Show when={props.detected}>
          <span class="text-[11.5px] text-own-faint" data-testid="compat-tools-detected">
            {reported("tools")}
          </span>
        </Show>
      </div>
    </div>
  )
}

/** The account card's `모델 기능…` (02 §3.3): every model of a compat account, saved together. */
export function CompatCapabilitiesDialog(props: {
  readonly account: Account.View | undefined
  readonly onClose: () => void
}) {
  return <Show when={props.account}>{(account) => <Editor account={account()} onClose={props.onClose} />}</Show>
}

function Editor(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useCompatText()
  const own = data.local().own
  const status = createStatus()
  const [busy, setBusy] = createSignal(false)
  const models = () => props.account.compat?.models ?? []
  const [draft, setDraft] = createStore<Record<string, { image: Account.CompatSetting; tools: Account.CompatSetting }>>(
    Object.fromEntries(
      models().map((model) => [
        model.id,
        { image: model.image?.setting ?? "auto", tools: model.tools?.setting ?? "auto" },
      ]),
    ),
  )
  // 02 §3.3a: each model's reasoning effort, as the form edits it.
  const [reasoning, setReasoning] = createStore<Record<string, ReasoningDraft>>(
    Object.fromEntries(
      models().flatMap((model) =>
        model.reasoning ? [[model.id, draftOf(model.reasoning.setting, model.reasoning.detected)]] : [],
      ),
    ),
  )
  const format = () => props.account.compat?.local?.format ?? "chat"
  // A service older than the capability settings lists no `image`/`tools`: nothing to change there.
  const older = () => models().some((model) => !model.image || !model.tools)
  const invalid = () => Object.values(reasoning).some((item) => settingOf(item) === undefined)
  const changes = () =>
    compatSettingsChange(
      models(),
      Object.fromEntries(
        Object.entries(draft).map(([id, item]) => {
          const next = reasoning[id]
          const setting = next && settingOf(next)
          return [id, { ...item, ...(setting === undefined ? {} : { reasoning: setting }) }]
        }),
      ),
    )

  const save = async () => {
    if (busy() || changes().length === 0) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.update", { accountID: props.account.id, compatCapabilities: changes() })
      .then(() => props.onClose())
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }

  const reread = async () => {
    if (busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.test", { accountID: props.account.id })
      .then((result) =>
        result.ok
          ? status.ok(text("own.compat.rereadDone"))
          : status.error(i18n.t("own.acct.testFailedStatus", { status: result.status ?? "—" })),
      )
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }

  return (
    <Dialog
      open
      title={text("own.compat.editTitle", { account: props.account.label })}
      onClose={props.onClose}
      testid="compat-capabilities-dialog"
      footer={
        <>
          <Show when={own.rpc.allowed("accounts.test")}>
            <button
              type="button"
              class="own-btn mr-auto"
              disabled={busy()}
              data-testid="compat-reread"
              onClick={() => void reread()}
            >
              {text("own.compat.reread")}
            </button>
          </Show>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {text("own.compat.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={busy() || older() || invalid() || changes().length === 0}
            data-testid="compat-capabilities-save"
            onClick={() => void save()}
          >
            {text("own.compat.save")}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-3 text-[13px]">
        <p class="m-0 text-own-muted">{text("own.compat.editLead")}</p>
        <Show when={older()}>
          <Notice tone="warn">{text("own.compat.olderService")}</Notice>
        </Show>
        <For each={models()}>
          {(model) => (
            <div class="flex flex-col gap-2 rounded-lg border border-own-border p-3">
              <span class="own-mono font-semibold">{model.id}</span>
              <CapabilitySettings
                model={model.id}
                image={draft[model.id]?.image ?? "auto"}
                tools={draft[model.id]?.tools ?? "auto"}
                onImage={(value) => setDraft(model.id, "image", value)}
                onTools={(value) => setDraft(model.id, "tools", value)}
                detected={{ image: model.image?.detected, tools: model.tools?.detected }}
              />
              <Show when={model.reasoning && reasoning[model.id]}>
                {(current) => (
                  <ReasoningSetting
                    model={model.id}
                    format={format()}
                    draft={current()}
                    onChange={(next) => setReasoning(model.id, next)}
                    detected={{ value: model.reasoning?.detected }}
                  />
                )}
              </Show>
            </div>
          )}
        </For>
        <p class="m-0 text-[12px] text-own-faint">{text("own.compat.settingsHint")}</p>
        <p class="m-0 text-[12px] text-own-faint">{text("own.compat.noTools")}</p>
        <p class="m-0 text-[12px] text-own-faint">{text("own.compat.noImage")}</p>
        <StatusLine status={status} testid="compat-capabilities-status" />
      </div>
    </Dialog>
  )
}
