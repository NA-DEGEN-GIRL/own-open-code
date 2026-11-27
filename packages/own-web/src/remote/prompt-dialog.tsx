// askpass prompts (04 §14.2, §17.6), shown only in the tab that owns the attempt (others see "다른 창에서 인증 중").
// - password / passphrase: a secret field, paste allowed; the value goes into the `respond` body and the field is
//   cleared right away (never kept in state, storage or logs).
// - other (keyboard-interactive, OTP): a secret field with a show toggle.
// - hostKey: the raw ssh question and the fingerprint, unmasked and large, the key type, and only `신뢰하고 연결` /
//   `취소` (default focus). No text field: the only accepted answer is "trust", which own-remote turns into `yes`.
// - confirm (agent key use, FIDO touch): the raw text and `허용` / `취소` (default focus), also "trust".
import { createSignal, onMount, Show } from "solid-js"
import { createImeEnter } from "@/ime/ime-enter"
import { Dialog, Notice } from "@/limits/kit"
import type { PromptData, RemoteStore } from "@/servers"
import { useRemoteText } from "./strings"

export function PromptDialog(props: { readonly store: RemoteStore; readonly prompt: PromptData }) {
  const text = useRemoteText()
  const [error, setError] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [visible, setVisible] = createSignal(false)
  const hostName = () => props.store.state.hosts[props.prompt.hostId]?.name ?? props.prompt.hostId
  const trustKind = () => props.prompt.kind === "hostKey" || props.prompt.kind === "confirm"
  let field: HTMLInputElement | undefined
  let cancelButton: HTMLButtonElement | undefined

  async function answer(value: string | null) {
    if (busy()) return
    setBusy(true)
    setError(false)
    try {
      await props.store.respond(props.prompt.hostId, props.prompt.promptId, value)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  function submit() {
    if (!field) return
    const value = field.value
    field.value = ""
    void answer(value)
  }

  const ime = createImeEnter({ onEnter: submit })

  onMount(() => {
    // 04 §14.2: the host key and confirm prompts open with the focus on 취소.
    requestAnimationFrame(() => (trustKind() ? cancelButton : field)?.focus())
  })

  const title = () => {
    switch (props.prompt.kind) {
      case "hostKey":
        return text("own.remote.hostKey.title")
      case "confirm":
        return text("own.remote.prompt.title.confirm", { host: hostName() })
      case "passphrase":
        return text("own.remote.prompt.title.passphrase", { host: hostName() })
      case "password":
        return text("own.remote.prompt.title.password", { host: hostName() })
      case "other":
        return text("own.remote.prompt.title.other", { host: hostName() })
    }
  }

  return (
    <Dialog
      open
      title={title()}
      onClose={() => void answer(null)}
      testid="remote-prompt"
      footer={
        <div class="flex w-full items-center justify-end gap-2">
          <button
            ref={cancelButton}
            type="button"
            class="own-btn own-target"
            data-testid="prompt-cancel"
            disabled={busy()}
            onClick={() => void answer(null)}
          >
            {text("own.remote.prompt.cancel")}
          </button>
          <Show
            when={trustKind()}
            fallback={
              <button
                type="button"
                class="own-btn own-target"
                data-variant="primary"
                data-testid="prompt-submit"
                disabled={busy()}
                onClick={submit}
              >
                {text("own.remote.prompt.submit")}
              </button>
            }
          >
            <button
              type="button"
              class="own-btn own-target"
              data-variant="primary"
              data-testid="prompt-trust"
              disabled={busy()}
              onClick={() => void answer("trust")}
            >
              {props.prompt.kind === "hostKey" ? text("own.remote.hostKey.trust") : text("own.remote.prompt.allow")}
            </button>
          </Show>
        </div>
      }
    >
      <div class="flex flex-col gap-3" data-kind={props.prompt.kind}>
        <div class="flex flex-col gap-1">
          <span class="text-[12px] text-own-faint">{text("own.remote.prompt.raw")}</span>
          <pre
            class="own-mono m-0 max-h-[180px] overflow-auto rounded-lg bg-own-subtle px-3 py-2 text-[12.5px] whitespace-pre-wrap break-all"
            data-testid="prompt-raw"
          >
            {props.prompt.text}
          </pre>
        </div>
        <Show when={props.prompt.kind === "hostKey"}>
          <Show when={props.prompt.fingerprint}>
            {(fingerprint) => (
              <>
                <p
                  class="own-mono m-0 rounded-lg border border-own-border px-3 py-2 text-[16px] font-semibold break-all"
                  data-testid="prompt-fingerprint"
                >
                  {fingerprint()}
                </p>
                <p class="m-0 text-[13px]">{text("own.remote.hostKey.check", { fingerprint: fingerprint() })}</p>
              </>
            )}
          </Show>
          <Show when={props.prompt.keyType}>
            {(type) => (
              <p class="m-0 text-[12.5px] text-own-muted" data-testid="prompt-key-type">
                {text("own.remote.prompt.keyType", { type: type() })}
              </p>
            )}
          </Show>
        </Show>
        <Show when={!trustKind()}>
          <label class="flex flex-col gap-1">
            <span class="text-[12.5px] text-own-muted">{text("own.remote.prompt.field")}</span>
            <div class="flex items-center gap-2">
              <input
                ref={field}
                type={visible() ? "text" : "password"}
                class="own-input h-9 min-w-0 flex-1"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                data-testid="prompt-input"
                onKeyDown={(event) => void ime.keydown(event)}
                onKeyUp={(event) => ime.keyup(event)}
                onCompositionStart={() => ime.compositionstart()}
                onCompositionEnd={() => ime.compositionend()}
                onInput={() => ime.input()}
              />
              <Show when={props.prompt.kind === "other"}>
                <label class="flex items-center gap-1 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={visible()}
                    data-testid="prompt-show"
                    onChange={(event) => setVisible(event.currentTarget.checked)}
                  />
                  {text("own.remote.prompt.show")}
                </label>
              </Show>
            </div>
          </label>
        </Show>
        <Show when={error()}>
          <Notice tone="danger" testid="prompt-error">
            {text("own.remote.prompt.failed")}
          </Notice>
        </Show>
      </div>
    </Dialog>
  )
}
