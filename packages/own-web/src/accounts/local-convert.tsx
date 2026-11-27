// 02 §3.3a: `로컬 모델로 바꾸기` of a compat account, `API 형식 바꾸기…` of a local model and its way back to `기타
// OpenAI 호환` (`accounts.update{local}`). The key, models and settings stay; the format re-registers the models.
import type { Account } from "@own/protocol"
import { createSignal, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, Segmented, createStatus, StatusLine } from "@/limits/kit"
import { errorMessage } from "./errors"
import { FORMATS } from "./local-model"
import { useLocalText } from "./local-strings"

export default function LocalConvertDialog(props: { readonly account: Account.View; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = useLocalText()
  const own = data.local().own
  const status = createStatus()
  const current = () => props.account.compat?.local
  const [format, setFormat] = createSignal<Account.LocalFormat>(
    current()?.format ?? (props.account.compat?.server?.family === "ollama" ? "ollama" : "chat"),
  )
  const [busy, setBusy] = createSignal(false)
  const keyless = () => current() !== undefined && !props.account.identity?.keyHint

  const save = async (local: Account.Local | null, done: string) => {
    if (busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.update", { accountID: props.account.id, local })
      .then(() => {
        status.ok(done)
        props.onClose()
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }

  return (
    <Dialog
      open
      title={text(current() ? "own.local.formatTitle" : "own.local.convertTitle", { account: props.account.label })}
      onClose={props.onClose}
      testid="local-convert-dialog"
      footer={
        <>
          <Show when={current() && !keyless()}>
            <button
              type="button"
              class="own-btn mr-auto"
              disabled={busy()}
              data-testid="local-revert"
              onClick={() => void save(null, text("own.local.reverted"))}
            >
              {text("own.local.revert")}
            </button>
          </Show>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {text("own.local.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            disabled={busy() || format() === current()?.format}
            data-testid="local-convert-save"
            onClick={() =>
              void save({ format: format() }, text(current() ? "own.local.formatSaved" : "own.local.converted"))
            }
          >
            {text("own.local.convertSave")}
          </button>
        </>
      }
    >
      <div class="flex flex-col gap-3 text-[13px]">
        <Show when={!current()}>
          <p class="m-0 text-own-muted">{text("own.local.convertHint")}</p>
        </Show>
        <div class="flex flex-col gap-1">
          <span class="own-field-label text-[12.5px] text-own-muted">{text("own.local.format")}</span>
          <Segmented
            label={text("own.local.format")}
            value={format()}
            options={FORMATS.map((value) => ({ value, label: text(`own.local.format.${value}`) }))}
            onChange={setFormat}
            testid="local-convert-format"
          />
          <span class="text-[11.5px] text-own-faint">{text("own.local.formatHint")}</span>
        </div>
        <p class="m-0 text-[12px] text-own-faint">{text("own.local.cacheNote")}</p>
        <Show when={keyless()}>
          <p class="m-0 text-[12px] text-own-faint">{text("own.local.revertKeyless")}</p>
        </Show>
        <StatusLine status={status} testid="local-convert-status" />
      </div>
    </Dialog>
  )
}
