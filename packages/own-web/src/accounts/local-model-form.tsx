// 02 §3.3a `로컬 모델` add form (its own lazy chunk): server preset (Ollama, LM Studio, llama.cpp, vLLM) or an address,
// the API format, an optional key, `서버에서 불러오기` (`accounts.local.detect`: the server's models with their windows,
// image input, tools and reasoning), then per chosen model the window, output cap, image input, tools and reasoning
// effort. Adds a `compat` account marked local through `accounts.add.key` (the key, if any, only in that request body).
import type { Account, OwnAccounts } from "@own/protocol"
import { createSignal, For, Index, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { parseTokens, tokens } from "@/limits/format"
import { ColorPicker, Segmented, Spinner, TextField, createStatus, StatusLine } from "@/limits/kit"
import { CapabilitySettings } from "./compat-capabilities"
import { useCompatText } from "./compat-strings"
import { errorMessage } from "./errors"
import {
  AUTO,
  FORMATS,
  PRESETS,
  draftOf,
  factsText,
  presetURL,
  settingOf,
  validURL,
  type Preset,
  type ReasoningDraft,
} from "./local-model"
import { useLocalText } from "./local-strings"
import { COLORS, defaultLabel, nextColor, outputLimitOf } from "./model"
import { ReasoningSetting } from "./reasoning-setting"

interface Row {
  id: string
  context: string
  outputLimit: string
  image: Account.CompatSetting
  tools: Account.CompatSetting
  reasoning: ReasoningDraft
  /** What `서버에서 불러오기` read of the model; absent for a model typed by hand. */
  detected?: OwnAccounts.LocalDetectedModel
}

const EMPTY: Row = { id: "", context: "", outputLimit: "", image: "auto", tools: "auto", reasoning: AUTO }

export function LocalModelForm(props: {
  readonly onBack: () => void
  readonly onDone: (account: { readonly id: string; readonly providerID: string }, notes: readonly string[]) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useLocalText()
  const compatText = useCompatText()
  const own = data.local().own
  const existing = () =>
    own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account?.kind === "compat" && account.compat?.local ? [account.label] : []
    })
  const [label, setLabel] = createSignal(defaultLabel(text("own.local.title"), existing()))
  const [preset, setPreset] = createSignal<Preset | undefined>("ollama")
  const [baseURL, setBaseURL] = createSignal(presetURL(11434))
  const [format, setFormat] = createSignal<Account.LocalFormat>("ollama")
  const [key, setKey] = createSignal("")
  const [color, setColor] = createSignal<Account.Color>(
    nextColor(own.state.accountOrder.map((id) => own.state.accounts[id]?.color)),
  )
  const [rows, setRows] = createStore<Row[]>([])
  const [found, setFound] = createSignal<OwnAccounts.LocalDetectResult | undefined>(undefined)
  const [detecting, setDetecting] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const detectStatus = createStatus()

  const pickPreset = (id: Preset) => {
    const chosen = PRESETS.find((item) => item.id === id)
    if (!chosen) return
    setPreset(id)
    setBaseURL(presetURL(chosen.port))
    setFormat(chosen.format)
  }

  const problem = () => {
    if (!validURL(baseURL())) return text("own.local.baseUrlNeeded")
    if (rows.length === 0 || rows.some((row) => !row.id.trim() || !(parseTokens(row.context) ?? 0)))
      return text("own.local.modelsNeeded")
    if (rows.some((row) => !outputLimitOf(row.outputLimit).ok)) return compatText("own.compat.outputLimitInvalid")
    if (rows.some((row) => settingOf(row.reasoning) === undefined)) return text("own.local.reasoning.levelsHint")
    return undefined
  }
  const ready = () => !!label().trim() && !problem()

  const detect = async () => {
    if (detecting() || !validURL(baseURL())) return
    setDetecting(true)
    detectStatus.clear()
    const secret = key().trim()
    await own.rpc
      .call("accounts.local.detect", {
        baseURL: baseURL().trim(),
        format: format(),
        ...(secret ? { key: secret } : {}),
      })
      .then((result) => {
        setFound(result)
        if (!result.ok)
          return detectStatus.error(
            result.status === undefined
              ? text("own.local.detectFailedNoStatus")
              : text("own.local.detectFailed", { status: result.status }),
          )
        if (result.models.length === 0) return detectStatus.error(text("own.local.detectedNone"))
        detectStatus.ok(
          text("own.local.detected", {
            family: compatText(`own.compat.family.${result.family ?? "other"}`),
            count: result.models.length,
          }),
        )
        // One model only: take it right away.
        if (result.models.length === 1 && rows.length === 0) toggle(result.models[0]!)
      })
      .catch((error: unknown) => detectStatus.error(errorMessage(i18n, error)))
    setDetecting(false)
  }

  const chosen = (id: string) => rows.some((row) => row.id === id)
  const toggle = (model: OwnAccounts.LocalDetectedModel) => {
    if (chosen(model.id)) return setRows((current) => current.filter((row) => row.id !== model.id))
    setRows(rows.length, {
      ...EMPTY,
      id: model.id,
      context: model.context ? String(model.context) : "",
      outputLimit: model.output ? String(model.output) : "",
      reasoning: draftOf(undefined, model.reasoning),
      detected: model,
    })
  }

  const submit = async () => {
    if (!ready() || busy()) return
    setBusy(true)
    status.clear()
    const secret = key().trim()
    // The key goes into the request body only and leaves the form state right away (16.3).
    setKey("")
    const input: OwnAccounts.AddKeyInput = {
      kind: "compat",
      label: label().trim(),
      ...(secret ? { key: secret } : {}),
      color: color(),
      options: {
        baseURL: baseURL().trim(),
        local: { format: format() },
        models: rows.map((row) => {
          const outputLimit = outputLimitOf(row.outputLimit)
          const reasoning = settingOf(row.reasoning)
          return {
            id: row.id.trim(),
            contextLimit: parseTokens(row.context),
            ...(outputLimit.ok && outputLimit.value !== undefined ? { outputLimit: outputLimit.value } : {}),
            ...(row.image === "auto" ? {} : { image: row.image }),
            ...(row.tools === "auto" ? {} : { tools: row.tools }),
            ...(reasoning === undefined || reasoning === "auto" ? {} : { reasoning }),
          }
        }),
      },
    }
    await own.rpc
      .call("accounts.add.key", input)
      .then((result) => props.onDone(result.account, [text("own.local.added")]))
      .catch((error: unknown) => status.error(errorMessage(i18n, error, (id) => own.state.accounts[id]?.label)))
    setBusy(false)
  }

  return (
    <form
      class="flex flex-col gap-3"
      data-testid="local-model-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <TextField label={i18n.t("own.acct.name")} value={label()} onValue={setLabel} testid="local-label" />
      <div class="flex flex-col gap-1">
        <span class="own-field-label text-[12.5px] text-own-muted">{text("own.local.server")}</span>
        <div class="flex flex-wrap gap-1.5" data-testid="local-presets">
          <For each={PRESETS}>
            {(item) => (
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                aria-pressed={preset() === item.id}
                data-preset={item.id}
                onClick={() => pickPreset(item.id)}
              >
                {text(`own.local.preset.${item.id}`)} :{item.port}
              </button>
            )}
          </For>
        </div>
      </div>
      <TextField
        label={text("own.local.baseURL")}
        value={baseURL()}
        onValue={(value) => {
          setBaseURL(value)
          setPreset(undefined)
        }}
        placeholder="http://127.0.0.1:11434/v1"
        class="own-mono"
        testid="local-base-url"
      />
      <div class="flex flex-col gap-1">
        <span class="own-field-label text-[12.5px] text-own-muted">{text("own.local.format")}</span>
        <Segmented
          label={text("own.local.format")}
          value={format()}
          options={FORMATS.map((value) => ({ value, label: text(`own.local.format.${value}`) }))}
          onChange={setFormat}
          testid="local-format"
        />
        <span class="text-[11.5px] text-own-faint">{text("own.local.formatHint")}</span>
      </div>
      <TextField
        label={text("own.local.key")}
        type="password"
        value={key()}
        onValue={setKey}
        hint={text("own.local.keyHint")}
        autocomplete="off"
        spellcheck={false}
        class="own-mono"
        testid="local-key"
      />
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="own-btn"
          disabled={detecting() || !validURL(baseURL())}
          data-testid="local-detect"
          onClick={() => void detect()}
        >
          <Show when={detecting()}>
            <Spinner />
          </Show>
          {text(detecting() ? "own.local.detecting" : "own.local.detect")}
        </button>
        <StatusLine status={detectStatus} testid="local-detect-status" />
      </div>
      <Show when={found()?.ok && found()!.models.length > 0}>
        <ul class="m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto p-0" data-testid="local-found">
          <For each={found()!.models}>
            {(model) => (
              <li>
                <label class="flex cursor-pointer items-start gap-2 text-[12.5px]" data-model={model.id}>
                  <input
                    type="checkbox"
                    checked={chosen(model.id)}
                    aria-label={text("own.local.pick", { model: model.id })}
                    onChange={() => toggle(model)}
                  />
                  <span class="flex min-w-0 flex-col">
                    <span class="own-mono break-all">{model.id}</span>
                    <span class="text-own-faint">{factsText(text, model, tokens)}</span>
                  </span>
                </label>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={rows.length > 0}>
        <p class="m-0 text-[12.5px] font-semibold text-own-muted">{text("own.local.models")}</p>
      </Show>
      <Index each={rows}>
        {(row, index) => (
          <fieldset
            class="m-0 grid grid-cols-1 gap-2 rounded-lg border border-own-border p-2.5 tablet:grid-cols-[1.4fr_1fr]"
            data-testid="local-model-row"
          >
            <legend class="sr-only">{row().id}</legend>
            <TextField
              label={text("own.local.modelID")}
              value={row().id}
              onValue={(value) => setRows(index, "id", value)}
              class="own-mono"
              testid="local-model-id"
            />
            <TextField
              label={text("own.local.context")}
              value={row().context}
              onValue={(value) => setRows(index, "context", value)}
              inputMode="numeric"
              placeholder="128,000"
              testid="local-model-context"
            />
            <div class="tablet:col-span-2">
              <TextField
                label={compatText("own.compat.outputLimit")}
                value={row().outputLimit}
                onValue={(value) => setRows(index, "outputLimit", value)}
                inputMode="numeric"
                placeholder={compatText("own.compat.outputLimitPlaceholder")}
                hint={compatText("own.compat.outputLimitHint")}
                error={outputLimitOf(row().outputLimit).ok ? undefined : compatText("own.compat.outputLimitInvalid")}
                testid="local-model-output"
              />
            </div>
            <div class="tablet:col-span-2">
              <CapabilitySettings
                model={row().id}
                image={row().image}
                tools={row().tools}
                onImage={(value) => setRows(index, "image", value)}
                onTools={(value) => setRows(index, "tools", value)}
                {...(row().detected
                  ? { detected: { image: row().detected?.image, tools: row().detected?.tools } }
                  : {})}
              />
            </div>
            <div class="tablet:col-span-2">
              <ReasoningSetting
                model={row().id}
                format={format()}
                draft={row().reasoning}
                onChange={(draft) => setRows(index, "reasoning", draft)}
                {...(row().detected ? { detected: { value: row().detected?.reasoning } } : {})}
              />
            </div>
            <div class="tablet:col-span-2">
              <button
                type="button"
                class="own-link"
                onClick={() => setRows((current) => current.filter((_, position) => position !== index))}
              >
                {text("own.local.removeModel")}
              </button>
            </div>
          </fieldset>
        )}
      </Index>
      <div>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-testid="local-add-model"
          onClick={() => setRows(rows.length, { ...EMPTY })}
        >
          {text("own.local.addModel")}
        </button>
      </div>
      <p class="m-0 text-[11.5px] text-own-faint">{text("own.local.reasoning.hint")}</p>
      <div class="own-field">
        <span class="own-field-label">{i18n.t("own.acct.color")}</span>
        <ColorPicker value={color()} colors={COLORS} onChange={setColor} />
      </div>
      <Show when={problem() && rows.length > 0}>
        <p class="m-0 text-[12.5px] text-own-warn">{problem()}</p>
      </Show>
      <StatusLine status={status} testid="local-status" />
      <div class="flex justify-end gap-2">
        <button type="button" class="own-btn" onClick={() => props.onBack()}>
          {i18n.t("own.acct.back")}
        </button>
        <button
          type="submit"
          class="own-btn"
          data-variant="primary"
          disabled={!ready() || busy()}
          data-testid="local-submit"
        >
          <Show when={busy()}>
            <Spinner />
          </Show>
          {text(busy() ? "own.local.adding" : "own.local.add")}
        </button>
      </div>
    </form>
  )
}
