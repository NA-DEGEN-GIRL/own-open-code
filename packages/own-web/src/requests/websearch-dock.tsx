// Web search first-use dock (03 §18.2): the choice of a search service for the whole server, not a permission, so no
// approval mode answers it and it is asked once (설정 > 웹 검색 makes the same choice ahead, and the card links there).
// When the server lists own's ChatGPT service, it is the first and recommended answer (WM 2026-10-19: the primary
// button used to be core's `allow`, a random pick over every listed service); without it the card says a ChatGPT
// account would search with the subscription. Core asks with
// a `websearch.provider` form whose `choice` field has three answers (packages/core/src/tool/plugin/websearch.ts:75-97);
// the dock shows the same three with the same meaning: allow the listed services, choose another (a second form with a
// `provider` field), or turn web search off for every session (core stores `websearch.select(false)` in the
// server-wide KV). Closing without an answer fails this one call. The state machine is the vendored upstream
// `websearch.ts` (created once per dock stack in docks.tsx, so the "choose" flow survives the first form's removal).
import { createEffect, createSignal, For, on, Show } from "solid-js"
import type { ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { useRouter } from "@/routing/router"
import { facts, paid } from "@/websearch/services"
import { CHATGPT } from "@/websearch/used"
import { useWebSearchText } from "@/websearch/strings"
import { frameRef, Head, isEscapeKey, titleID } from "./dock-parts"
import type { Origin, RequestModel } from "./model"
import { useRequestsText } from "./strings"
import { DockPrompt } from "@/adapter/dock-prompt"
import type { WebSearchRequestModel } from "./vendor/websearch"

export function WebSearchDock(props: {
  readonly ws: WebSearchRequestModel
  readonly model: RequestModel
  readonly origin: Origin
  readonly serverKey: ServerKey
  readonly onDone: (hadFocus: boolean) => void
}) {
  const i18n = useI18n()
  const text = useRequestsText()
  const words = useWebSearchText()
  const router = useRouter()
  const id = titleID()
  const [choosing, setChoosing] = createSignal(false)
  const chatgpt = () => props.ws.options().find((option) => option.value === CHATGPT)
  // A second form (`provider` field) starts on ChatGPT when it is listed, once per form.
  createEffect(
    on(
      () => [props.ws.request()?.id, !!chatgpt()] as const,
      ([form, listed]) => {
        if (form && listed && props.ws.specific()) props.ws.select(CHATGPT)
      },
    ),
  )
  let root: HTMLDivElement | undefined
  const busy = () => props.ws.sending() || !props.ws.connected()
  const form = () => props.ws.request()
  const names = () => props.ws.options().map((option) => option.label)
  const allowLabel = () =>
    i18n.t("own.websearch.allow", {
      providers: names().length ? names().join(", ") : text("own.requests.websearch.anyProvider"),
    })
  const chosenLabel = () => props.ws.options().find((option) => option.value === props.ws.selected())?.label
  // own's DeepSeek and Brave services cost money or send the query to China (02 §9.2): their cost and destination
  // show under `allow`, which may pick any listed service (SP 2026-10-19), and under their names in the list.
  const noted = () => props.ws.options().filter((option) => paid(option.value))

  async function answer(selection: string | false) {
    const hadFocus = !!root?.contains(document.activeElement)
    await props.ws.submit(selection)
    if (!props.ws.failed()) props.onDone(hadFocus)
  }

  async function skip() {
    const current = form()
    if (!current) return
    const hadFocus = !!root?.contains(document.activeElement)
    if (await props.model.cancel(current)) props.onDone(hadFocus)
  }

  const status = () => {
    if (props.ws.loading()) return text("own.requests.websearch.loading")
    if (props.ws.failed()) return text("own.requests.failed")
    if (!props.ws.loadFailed() && !props.ws.options().length) return text("own.requests.websearch.none")
    return undefined
  }

  return (
    <DockPrompt
      kind="question"
      ref={(element) => {
        root = element
        frameRef(id)(element)
        element.dataset.testid = "websearch-dock"
        element.dataset.flavor = "websearch"
      }}
      onKeyDown={(event) => {
        if (!isEscapeKey(event) || event.isComposing) return
        event.preventDefault()
        document.getElementById("own-composer-input")?.focus()
      }}
      header={
        <Head
          id={id}
          kind="question"
          title={props.ws.specific() ? text("own.requests.websearch.pick") : i18n.t("own.websearch.title")}
          origin={props.origin}
          serverKey={props.serverKey}
        >
          <p class="own-rq-note">
            {props.ws.specific() ? text("own.requests.websearch.pickBody") : i18n.t("own.websearch.body")}
          </p>
          <p class="own-rq-note">
            <Show when={!props.ws.loading() && !props.ws.loadFailed() && !chatgpt()}>
              <span data-testid="websearch-no-chatgpt">{words("own.ws.dock.noChatGPT")} </span>
            </Show>
            <button
              type="button"
              class="own-rq-link"
              data-testid="websearch-settings"
              onClick={() => router.navigate({ name: "settings", section: "websearch" })}
            >
              {words("own.ws.open")} →
            </button>
          </p>
        </Head>
      }
      footer={
        <>
          <Show when={status() || props.ws.loadFailed()}>
            <p class="own-rq-note" aria-live="polite" data-testid="websearch-status">
              <Show when={props.ws.loadFailed()} fallback={status()}>
                {text("own.requests.websearch.loadFailed")}{" "}
                <button type="button" class="own-rq-link" disabled={busy()} onClick={props.ws.retry}>
                  {text("own.requests.websearch.retry")}
                </button>
              </Show>
            </p>
          </Show>
          <div class="own-rq-actions">
            <span class="own-rq-grow own-rq-note">{i18n.t("own.websearch.cancelled")}</span>
            <button
              type="button"
              class="own-rq-btn"
              data-variant="ghost"
              data-testid="websearch-skip"
              disabled={busy()}
              onClick={() => void skip()}
            >
              {text("own.requests.form.skip")}
            </button>
            <Show when={props.ws.specific()}>
              <button
                type="button"
                class="own-rq-btn"
                data-variant="primary"
                data-testid="websearch-submit"
                disabled={busy() || !props.ws.selected()}
                onClick={() => {
                  const selected = props.ws.selected()
                  if (selected) void answer(selected)
                }}
              >
                {text("own.requests.form.submit")}
              </button>
            </Show>
          </div>
        </>
      }
    >
      <Show when={!props.ws.specific()} fallback={<Providers ws={props.ws} busy={busy()} />}>
        <div class="own-rq-choices">
          <Show when={chatgpt()}>
            {(option) => (
              <button
                type="button"
                class="own-rq-btn"
                data-variant="primary"
                data-testid="websearch-allow-chatgpt"
                disabled={busy()}
                onClick={() => void answer(CHATGPT)}
              >
                {i18n.t("own.websearch.allow", { providers: option().label })} · {words("own.ws.recommended")}
              </button>
            )}
          </Show>
          <button
            type="button"
            class="own-rq-btn"
            data-variant={chatgpt() ? undefined : "primary"}
            data-testid="websearch-allow"
            disabled={busy()}
            onClick={() => void answer("random")}
          >
            {allowLabel()}
          </button>
          <For each={noted()}>
            {(option) => (
              <p class="own-rq-note" data-testid={`websearch-note-${option.value}`}>
                {option.label}: {costLine(option, words)}
              </p>
            )}
          </For>
          <button
            type="button"
            class="own-rq-btn"
            data-testid="websearch-choose"
            aria-expanded={choosing()}
            disabled={busy() || props.ws.loadFailed() || !props.ws.options().length}
            onClick={() => setChoosing((value) => !value)}
          >
            {i18n.t("own.websearch.choose")}
          </button>
          <Show when={choosing()}>
            <Providers ws={props.ws} busy={busy()} />
            <button
              type="button"
              class="own-rq-btn"
              data-variant="primary"
              data-testid="websearch-choose-send"
              disabled={busy() || !chosenLabel() || props.ws.selected() === "random"}
              onClick={() => {
                const selected = props.ws.selected()
                if (selected && selected !== "random") void answer(selected)
              }}
            >
              {chosenLabel()
                ? i18n.t("own.websearch.allow", { providers: chosenLabel()! })
                : text("own.requests.websearch.pick")}
            </button>
          </Show>
          <button
            type="button"
            class="own-rq-btn"
            data-variant="danger"
            data-testid="websearch-disable"
            disabled={busy()}
            onClick={() => void answer(false)}
          >
            {i18n.t("own.websearch.disable")}
          </button>
          <p class="own-rq-warn">{i18n.t("own.websearch.disableWarn")}</p>
        </div>
      </Show>
    </DockPrompt>
  )
}

/** The services, ChatGPT first with `추천` when listed (the server's order otherwise). */
function Providers(props: { readonly ws: WebSearchRequestModel; readonly busy: boolean }) {
  const words = useWebSearchText()
  const options = () => [
    ...props.ws.options().filter((option) => option.value === CHATGPT),
    ...props.ws.options().filter((option) => option.value !== CHATGPT),
  ]
  return (
    <div class="own-rq-options" role="radiogroup" data-testid="websearch-providers">
      <For each={options()}>
        {(option) => (
          <button
            type="button"
            class="own-rq-option"
            role="radio"
            aria-checked={props.ws.selected() === option.value}
            data-picked={props.ws.selected() === option.value ? "" : undefined}
            disabled={props.busy}
            onClick={() => props.ws.select(option.value)}
          >
            <span class="own-rq-check" data-type="radio" aria-hidden="true">
              {props.ws.selected() === option.value ? "✓" : ""}
            </span>
            <span class="own-rq-option-main">
              <span>{option.label}</span>
              <Show when={option.value === CHATGPT}>
                <span class="own-rq-option-desc">{words("own.ws.recommended")}</span>
              </Show>
              <Show when={paid(option.value)}>
                <span class="own-rq-option-desc">{costLine(option, words)}</span>
              </Show>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

/** A paid service's cost and destination, as 설정 > 웹 검색 shows them (`DeepSeek 잔액에서 빠져요 · …`). */
function costLine(
  option: { readonly value: string; readonly label: string },
  words: ReturnType<typeof useWebSearchText>,
) {
  return facts({ id: option.value, name: option.label }, undefined, words).join(" · ")
}
