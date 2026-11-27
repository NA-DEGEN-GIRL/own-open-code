// 설정 > 음성 입력 (02 §3.9, 03 §5.7.4), lazy with the settings page. On/off, the recognition service, the language,
// the voice-only keys (one password field per service: the key goes into the request body once and leaves the form
// state at once; the page only ever gets back whether a key is set and its last four characters), the push-to-talk
// shortcut (rebound on 설정 > 단축키) and the minutes per month. Keys are `local`: a phone or another PC's window sees
// whether they are set but cannot enter one.
import { createSignal, For, onMount, Show, type JSX } from "solid-js"
import type { Voice } from "@own/protocol/voice"
import { errorMessage, errorType } from "@/accounts/errors"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { chordLabel } from "@/keyboard"
import { createStatus, Notice, Segmented, StatusLine, TextField } from "@/limits/kit"
import { effectiveKeymap } from "@/palette/keymap-store"
import { RouteLink } from "@/routing/router"
import { loadVoice, setVoiceView, voiceReady, voiceUnsupported, voiceView } from "./store"
import { useVoiceSettingsText, type VoiceSettingsKey } from "./settings-strings"
import "./voice.css"

const PROVIDER_LABEL: Record<Voice.Provider, VoiceSettingsKey> = {
  openai: "own.voice.set.openai",
  deepgram: "own.voice.set.deepgram",
}
const KEY_LABEL: Record<Voice.Provider, VoiceSettingsKey> = {
  openai: "own.voice.set.keyOpenai",
  deepgram: "own.voice.set.keyDeepgram",
}
const PROVIDERS = ["openai", "deepgram"] as const
const LANGUAGES = ["auto", "ko", "en"] as const

export default function VoiceSettings() {
  const data = useData()
  const i18n = useI18n()
  const text = useVoiceSettingsText()
  const rpc = data.local().own.rpc
  const status = createStatus()
  onMount(() => void loadVoice(rpc, { force: true }))
  const writable = () => rpc.allowed("voice.set")

  const set = async (input: Voice.SetInput) => {
    status.clear()
    await rpc
      .call("voice.set", input)
      .then((view) => {
        setVoiceView(view)
        status.ok(i18n.t("own.set.saved"))
      })
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }

  const keys = () => effectiveKeymap()["voice.dictate"].chords.map((chord) => chordLabel(chord))

  return (
    <Show
      when={voiceView()}
      fallback={
        <p class="own-placeholder px-0">
          {voiceUnsupported() ? text("own.voice.set.unsupported") : i18n.t("own.shell.loading")}
        </p>
      }
    >
      {(view) => (
        <div class="flex flex-col" data-testid="settings-voice">
          <p class="m-0 mb-1 text-[13px] leading-5 text-own-muted">{text("own.voice.set.intro")}</p>
          <Show when={view().vault === "unavailable"}>
            <Notice tone="warn" testid="voice-vault">
              {text("own.voice.set.vaultUnavailable")}
            </Notice>
          </Show>
          <section class="own-psec !mt-2">
            <Row title={text("own.voice.set.enabled")} note={text("own.voice.set.enabledNote")}>
              <Segmented
                label={text("own.voice.set.enabled")}
                value={view().enabled ? "on" : "off"}
                options={[
                  { value: "on", label: text("own.voice.set.on"), disabled: !writable() },
                  { value: "off", label: text("own.voice.set.off"), disabled: !writable() },
                ]}
                onChange={(value) => void set({ enabled: value === "on" })}
                testid="voice-enabled"
              />
            </Row>
            <Row title={text("own.voice.set.provider")}>
              <Segmented
                label={text("own.voice.set.provider")}
                value={view().provider}
                options={PROVIDERS.map((provider) => ({
                  value: provider,
                  label: text(PROVIDER_LABEL[provider]),
                  disabled: !writable(),
                }))}
                onChange={(provider) => void set({ provider })}
                testid="voice-provider"
              />
            </Row>
            <Row title={text("own.voice.set.language")}>
              <Segmented
                label={text("own.voice.set.language")}
                value={view().language}
                options={LANGUAGES.map((language) => ({
                  value: language,
                  label: text(`own.voice.set.${language}`),
                  disabled: !writable(),
                }))}
                onChange={(language) => void set({ language })}
                testid="voice-language"
              />
            </Row>
            <Show when={view().enabled}>
              <p
                class="m-0 mt-2 text-[12px]"
                data-testid="voice-ready"
                classList={{ "text-own-warn": !voiceReady(view(), rpc) }}
              >
                {text(voiceReady(view(), rpc) ? "own.voice.set.ready" : "own.voice.set.notReady")}
              </p>
            </Show>
          </section>

          <section class="own-psec">
            <div class="own-psec-head">
              <h2>{text("own.voice.set.keys")}</h2>
            </div>
            <p class="m-0 mb-2 text-[12.5px] leading-[18px] text-own-muted">{text("own.voice.set.keysNote")}</p>
            <Show when={!rpc.allowed("voice.key.set")}>
              <p class="m-0 mb-2 text-[12.5px] text-own-muted" data-testid="voice-key-local">
                {text("own.voice.set.keyLocal")}
              </p>
            </Show>
            <For each={PROVIDERS}>
              {(provider) => (
                <KeyRow
                  provider={provider}
                  state={view().keys.find((key) => key.provider === provider)}
                  editable={rpc.allowed("voice.key.set")}
                />
              )}
            </For>
          </section>

          <section class="own-psec">
            <Row title={text("own.voice.set.shortcut")} note={text("own.voice.set.shortcutNote")}>
              <span class="flex flex-wrap items-center gap-2 text-[13px]">
                <kbd class="own-vc-kbd" data-testid="voice-shortcut">
                  {keys().join(", ") || text("own.voice.set.shortcutNone")}
                </kbd>
                <RouteLink to={{ name: "settings", section: "shortcuts" }} class="own-link text-[12.5px]">
                  {text("own.voice.set.shortcutChange")}
                </RouteLink>
              </span>
            </Row>
          </section>

          <section class="own-psec">
            <div class="own-psec-head">
              <h2>{text("own.voice.set.usage")}</h2>
            </div>
            <Show
              when={view().usage.length}
              fallback={<p class="m-0 text-[13px] text-own-muted">{text("own.voice.set.usageNone")}</p>}
            >
              <ul class="m-0 list-none p-0 text-[13px] leading-6" data-testid="voice-usage">
                <For each={view().usage.slice(0, 6)}>
                  {(row) => (
                    <li>
                      {text("own.voice.set.usageRow", {
                        month: row.month,
                        service: row.provider === "openai" ? "OpenAI" : "Deepgram",
                        minutes: minutes(row.seconds),
                        count: row.requests,
                      })}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <p class="m-0 mt-2 text-[12px] text-own-muted">
              {text("own.voice.set.limits", {
                seconds: view().limits.maxSeconds,
                size: `${Math.round(view().limits.maxAudioBytes / 1024 / 1024)} MB`,
              })}
            </p>
          </section>
          <StatusLine status={status} testid="voice-status" />
        </div>
      )}
    </Show>
  )
}

/** Minutes with one decimal (`0.4`, `12.5`). */
export function minutes(seconds: number) {
  return (Math.round((seconds / 60) * 10) / 10).toString()
}

/**
 * One service's key: whether it is set (with its hint), a password field to set or replace it, and remove with an
 * inline confirmation. The typed key leaves the field before the request goes out and is never shown again.
 */
function KeyRow(props: {
  readonly provider: Voice.Provider
  readonly state: Voice.KeyState | undefined
  readonly editable: boolean
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useVoiceSettingsText()
  const rpc = data.local().own.rpc
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const status = createStatus()
  const name = () => text(KEY_LABEL[props.provider])

  const send = async (value: string | null) => {
    if (busy()) return
    setBusy(true)
    status.clear()
    // The secret goes into the request body only; the field is emptied before the call returns.
    setKey("")
    await rpc
      .call("voice.key.set", { provider: props.provider, key: value })
      .then((view) => {
        setVoiceView(view)
        status.ok(text(value === null ? "own.voice.set.keyRemoved" : "own.voice.set.keyStored"))
      })
      .catch((error: unknown) =>
        status.error(
          errorType(error) === "voice_key_invalid" ? text("own.voice.set.keyInvalid") : errorMessage(i18n, error),
        ),
      )
    setConfirming(false)
    setBusy(false)
  }
  const save = () => {
    const value = key().trim()
    if (value) void send(value)
  }

  return (
    <div class="border-b border-own-border py-2.5" data-testid={`voice-key-${props.provider}`}>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <b class="text-[13.5px] font-semibold">{name()}</b>
        <span class="text-[12.5px] text-own-muted" data-testid={`voice-key-state-${props.provider}`}>
          {props.state?.configured
            ? text("own.voice.set.keySaved", { hint: props.state.keyHint ?? "" })
            : text("own.voice.set.keyNone")}
        </span>
        <Show when={props.editable && props.state?.configured && !confirming()}>
          <button type="button" class="own-btn" data-size="sm" onClick={() => setConfirming(true)}>
            {text("own.voice.set.keyRemove")}
          </button>
        </Show>
      </div>
      <Show when={confirming()}>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]" role="alertdialog">
          <span>{text("own.voice.set.keyRemoveConfirm", { name: name() })}</span>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="danger"
            disabled={busy()}
            onClick={() => void send(null)}
          >
            {text("own.voice.set.keyRemove")}
          </button>
          <button type="button" class="own-btn" data-size="sm" onClick={() => setConfirming(false)}>
            {i18n.t("own.kit.cancel")}
          </button>
        </div>
      </Show>
      <Show when={props.editable}>
        <form
          class="mt-2 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div class="min-w-0 flex-1">
            <TextField
              label={props.state?.configured ? text("own.voice.set.keyReplace") : name()}
              type="password"
              value={key()}
              onValue={setKey}
              onEnter={save}
              autocomplete="off"
              spellcheck={false}
              class="own-mono"
              testid={`voice-key-input-${props.provider}`}
            />
          </div>
          <button
            type="submit"
            class="own-btn"
            data-size="sm"
            data-variant="primary"
            disabled={busy() || !key().trim()}
            data-testid={`voice-key-save-${props.provider}`}
          >
            {text("own.voice.set.keySave")}
          </button>
        </form>
      </Show>
      <StatusLine status={status} testid={`voice-key-status-${props.provider}`} />
    </div>
  )
}

function Row(props: { readonly title: string; readonly note?: string; readonly children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-own-border py-2.5">
      <div class="min-w-[220px] flex-1">
        <b class="block text-[13.5px] font-semibold">{props.title}</b>
        <Show when={props.note}>
          <span class="text-[12px] text-own-muted">{props.note}</span>
        </Show>
      </div>
      {props.children}
    </div>
  )
}
