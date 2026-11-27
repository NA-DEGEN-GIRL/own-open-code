// A web search service's own key under its row of 설정 > 웹 검색 (02 §9.2, 03 §18.2, SP 2026-10-19, SK 2026-10-23):
// Brave's, and those of core's keyless services (Exa, Firecrawl, Parallel, Tavily, TinyFish) that own asks with the key
// under an id of its own (`own-exa` …). Whether one is set (its last four characters only), `Exa 키 넣기…` with a
// password field, and remove with an inline confirmation. The key goes into own's vault through own.accounts
// `websearch.key.set` (this PC only, like the voice-only keys), never into core's credential table. The typed key
// leaves the field before the request goes out and is never shown again. Storing it lists `Brave` or `Exa (내 키)`
// among the services (the page's list follows `websearch.updated`; `onChange` asks again).
import type { SearchKey } from "@own/protocol"
import { createResource, createSignal, Show } from "solid-js"
import { errorType } from "@/accounts/errors"
import type { ServerRuntime } from "@/data"
import { TextField } from "@/limits/kit"
import { BRAVE, serviceName, type SearchKeyService } from "./services"
import { useWebSearchText } from "./strings"

/**
 * own.accounts `websearch.key.get` for the page: a service's key state, `undefined` while it loads, when this
 * connection may not read it or the service does not know the method or that service (then the page shows no key row
 * for it: an older service lists only Brave).
 */
export function searchKeys(runtime: ServerRuntime) {
  const rpc = runtime.rpc
  const [view, { mutate }] = createResource(
    () => runtime.connection.status() === "connected" && rpc.allowed("websearch.key.get"),
    () => rpc.call("websearch.key.get", {}),
  )
  return {
    state: (service: SearchKeyService) =>
      view.error ? undefined : view()?.keys.find((item) => item.service === service),
    set: (next: SearchKey.View) => mutate(next),
  }
}

export function SearchKeyRow(props: {
  readonly runtime: ServerRuntime
  readonly state: SearchKey.KeyState
  readonly onView: (view: SearchKey.View) => void
  readonly onChange?: () => void
}) {
  const text = useWebSearchText()
  const rpc = props.runtime.rpc
  const [open, setOpen] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const editable = () => rpc.allowed("websearch.key.set")
  const service = () => props.state.service
  const brave = () => service() === BRAVE
  const name = () => serviceName(service())
  const testid = (part: string) => `settings-websearch-${service()}-key${part}`

  const send = async (value: string | null) => {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    // The secret goes into the request body only; the field is emptied before the call returns.
    setKey("")
    await rpc.call("websearch.key.set", { service: service(), key: value }).then(
      (next) => {
        props.onView(next)
        setOpen(false)
        props.onChange?.()
      },
      (error: unknown) =>
        setProblem(text(errorType(error) === "websearch_key_invalid" ? "own.ws.key.invalid" : "own.ws.key.failed")),
    )
    setConfirming(false)
    setBusy(false)
  }
  const save = () => {
    const value = key().trim()
    if (value) void send(value)
  }

  return (
    <div class="own-ws-key" data-testid={testid("")}>
      <p class="own-rq-note m-0" data-testid={testid("-state")}>
        {text("own.ws.key.label", { name: name() })}:{" "}
        {props.state.configured
          ? text("own.ws.key.saved", { hint: props.state.keyHint ?? "" })
          : brave()
            ? text("own.ws.key.none.brave")
            : text("own.ws.key.none", { name: name() })}
      </p>
      <Show when={editable()} fallback={<p class="own-rq-note m-0">{text("own.ws.key.local")}</p>}>
        <div class="own-rq-actions justify-start">
          <button
            type="button"
            class="own-rq-btn"
            data-testid={testid("-open")}
            disabled={busy()}
            aria-expanded={open()}
            onClick={() => setOpen((value) => !value)}
          >
            {text(props.state.configured ? "own.ws.key.replace" : "own.ws.key.add", { name: name() })}
          </button>
          <Show when={props.state.configured && !confirming()}>
            <button type="button" class="own-rq-btn" data-variant="ghost" onClick={() => setConfirming(true)}>
              {text("own.ws.key.remove")}
            </button>
          </Show>
        </div>
        <Show when={confirming()}>
          <div class="own-rq-actions justify-start" role="alertdialog">
            <span class="own-rq-note">
              {brave() ? text("own.ws.key.removeConfirm.brave") : text("own.ws.key.removeConfirm", { name: name() })}
            </span>
            <button
              type="button"
              class="own-rq-btn"
              data-variant="danger"
              data-testid={testid("-remove")}
              disabled={busy()}
              onClick={() => void send(null)}
            >
              {text("own.ws.key.remove")}
            </button>
            <button type="button" class="own-rq-btn" data-variant="ghost" onClick={() => setConfirming(false)}>
              {text("own.ws.key.cancel")}
            </button>
          </div>
        </Show>
        <Show when={open()}>
          <form
            class="own-rq-actions justify-start"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <TextField
              label={text("own.ws.key.field", { name: brave() ? "Brave Search" : name() })}
              hint={text("own.ws.key.fieldNote")}
              type="password"
              value={key()}
              onValue={setKey}
              onEnter={save}
              autocomplete="off"
              spellcheck={false}
              class="own-mono"
              testid={testid("-input")}
            />
            <button
              type="submit"
              class="own-rq-btn"
              data-variant="primary"
              data-testid={testid("-save")}
              disabled={busy() || !key().trim()}
            >
              {text("own.ws.key.save")}
            </button>
          </form>
        </Show>
      </Show>
      <Show when={problem()}>
        {(message) => (
          <p class="own-rq-problem" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </div>
  )
}
