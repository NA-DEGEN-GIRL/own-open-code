// 설정 > 웹 검색 (03 §18.2, §5.7, WM 2026-10-19; lazy, `/settings/websearch`). The server's web search service in one
// place a user finds: which one answers now (its name, what a search costs, where the query goes, and whether it was
// chosen here or is the app's default), `검색 방식` (`한 서비스` or `여러 서비스 함께`, MS 2026-10-19), and then either
// every service the server lists with a short note (ChatGPT first and recommended), `목록의 서비스 중 하나(자동)` and
// `웹 검색 끄기`, or the services to ask together as checkboxes with what one search may cost; `저장` and `기본으로`
// (own.accounts `websearch.set`, `default` removes the config key, `multi` stores the checked services), each
// service's own key under its row (own's vault, SP, SK 2026-10-23: Brave is listed only with a key, so without one its
// row says `키 필요` and cannot be chosen; a keyless service's key adds its `(내 키)` row right under it, which
// `여러 서비스 함께` then asks instead), and what this page does not decide: Codex 방식's GPT models search with OpenAI's
// own tool. Before 2026-10-19 the choice was a section of
// 설정 > 승인·권한, whose first option was `자동` (core `random` over every listed service), so a user with ChatGPT
// accounts could end up searching with a free third-party service without knowing it.
import type { Approval } from "@own/protocol"
import { createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { errorData, errorType } from "@/accounts/errors"
import { LOCAL, useData, type ServerRuntime } from "@/data"
import { Tag } from "@/limits/kit"
import { RouteLink } from "@/routing/router"
import { showToast } from "@/switcher/toast"
import { SearchKeyRow, searchKeys } from "./search-key"
import {
  asked,
  BRAVE,
  CHATGPT,
  current,
  facts,
  keylessOf,
  keyServiceOf,
  multiCost,
  multiRows,
  noteKey,
  ordered,
  paid,
  serviceName,
  type Current,
  type Listed,
} from "./services"
import { webSearchInfo } from "./state"
import { useWebSearchText } from "./strings"
import { dismissHint } from "./used"
import "@/requests/requests.css"
import "./websearch.css"

type Text = ReturnType<typeof useWebSearchText>
type Keys = Readonly<Record<string, Approval.WebSearchKey>> | undefined
type Mode = "single" | "multi"

export default function WebSearchSettings() {
  const data = useData()
  return (
    <div data-testid="settings-websearch-page">
      <Show when={data.get(LOCAL)}>{(runtime) => <WebSearchPage runtime={runtime()} />}</Show>
    </div>
  )
}

function WebSearchPage(props: { readonly runtime: ServerRuntime }) {
  const text = useWebSearchText()
  const rpc = props.runtime.rpc
  const info = webSearchInfo(props.runtime)
  const directory = () => props.runtime.entry()?.controlDir ?? props.runtime.sessions.directories()[0]
  const listed = createMemo(() => ordered(info.listed(directory()) ?? []))
  const choice = () => info.state()?.choice
  const keys = () => info.state()?.keys
  const now = createMemo(() => current(choice(), listed()))
  const [picked, setPicked] = createSignal<string>()
  const [modeDraft, setModeDraft] = createSignal<Mode>()
  const [checkedDraft, setCheckedDraft] = createSignal<readonly string[]>()
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const savedMode = (): Mode => (choice()?.type === "multi" ? "multi" : "single")
  const mode = () => modeDraft() ?? savedMode()
  /**
   * The services `여러 서비스 함께` asks (the stored selection, else own's default), as far as they are listed now; a
   * service whose key was just stored or removed as it is asked now (its `(내 키)` row or the keyless one).
   */
  const savedChecked = () => {
    const now = listed()
    const services = (info.state()?.multi?.services ?? []).map((id) => asked(id, now))
    return [...new Set(services)].filter((id) => now.some((item) => item.id === id))
  }
  const checked = () => checkedDraft() ?? savedChecked()
  /** The option that answers now: the chosen one, else the default service (ChatGPT while listed). */
  const effective = () => {
    const answering = now()
    return keyOf(choice()) ?? (answering.type === "service" ? `service:${answering.id}` : undefined)
  }
  const selected = () => picked() ?? effective()
  const writable = () => rpc.allowed("websearch.set") && !info.error()
  const names = () => listed().map((item) => item.name)
  const namesOf = (ids: readonly string[]) => ids.map((id) => serviceName(id, listed()))
  /** A ChatGPT login that can search; `true` until the account list is in (no warning flashes while it loads). */
  const ready = () =>
    props.runtime.own.state.status !== "ready" ||
    Object.values(props.runtime.own.state.accounts).some(
      (account) => account.kind === "codex" && (account.status === "ready" || account.status === "unverified"),
    )
  const labelOf = (key: string) => {
    if (key === "any") return text("own.ws.any")
    if (key === "off") return text("own.ws.off")
    return serviceName(key.slice("service:".length), listed())
  }
  const toggle = (id: string) => {
    const next = checked().includes(id) ? checked().filter((item) => item !== id) : [...checked(), id]
    // The order shown (ChatGPT first, then the server's), which is also the order the results are merged in.
    setCheckedDraft(multiRows(listed()).flatMap((item) => (next.includes(item.id) ? [item.id] : [])))
    setProblem(undefined)
  }
  const multiChanged = () => savedMode() !== "multi" || checked().join() !== savedChecked().join()
  const canSave = () => {
    if (busy() || !writable()) return false
    if (mode() === "multi") return checked().length > 0 && multiChanged()
    return picked() !== undefined
  }

  async function save(next: Approval.WebSearchSetChoice) {
    if (busy()) return
    setBusy(true)
    setProblem(undefined)
    await info.set(next).then(
      () => {
        setPicked(undefined)
        setModeDraft(undefined)
        setCheckedDraft(undefined)
        // A choice made here answers the one-time hint above the composer too (18.2).
        dismissHint()
        showToast({ message: savedMessage(next) })
      },
      (error: unknown) => {
        if (errorType(error) === "websearch_unavailable") {
          const reason = errorData<{ reason: string }>(error).reason
          setProblem(text(reason === "unknown_service" ? "own.ws.unknownService" : "own.ws.configUnavailable"))
          if (reason === "unknown_service") info.reload(directory())
          return
        }
        console.error("[own-web] websearch.set failed", error)
        setProblem(text("own.ws.failed"))
      },
    )
    setBusy(false)
  }
  const savedMessage = (next: Approval.WebSearchSetChoice) => {
    if (next.type === "default") return text("own.ws.saved.default")
    if (next.type === "off") return text("own.ws.saved.off")
    if (next.type === "multi") return text("own.ws.saved.multi", { names: namesOf(next.services ?? []).join(", ") })
    return text("own.ws.saved", { choice: labelOf(keyOf(next)!) })
  }

  const readProblem = () => {
    if (!rpc.allowed("websearch.get")) return text("own.ws.noScope")
    const error = info.error()
    if (!error) return undefined
    return errorType(error) === "rpc.method_not_found" ? text("own.ws.unsupported") : text("own.ws.readFailed")
  }

  const options = () => [
    ...listed().map((item) => ({ key: `service:${item.id}`, service: item })),
    { key: "any" as const, service: undefined },
    { key: "off" as const, service: undefined },
  ]
  const keyState = searchKeys(props.runtime)
  const braveListed = () => listed().some((item) => item.id === BRAVE)
  /**
   * The key entry under a row (`keyServiceOf`): Brave's under Brave, a keyless service's under its `(내 키)` row while
   * that is listed, else under the keyless row. None while `websearch.key.get` does not know the service.
   */
  const keyRow = (id: string) => {
    const service = keyServiceOf(id, listed())
    const state = service && keyState.state(service)
    if (!state) return undefined
    return (
      <SearchKeyRow
        runtime={props.runtime}
        state={state}
        onView={keyState.set}
        onChange={() => info.reload(directory())}
      />
    )
  }
  /** A keyed variant right under its keyless row repeats that row's note, so it shows only its cost. */
  const besideKeyless = (id: string) => {
    const keyless = keylessOf(id)
    return keyless !== undefined && listed().some((item) => item.id === keyless)
  }
  /** Brave without a key: a row that cannot be chosen, and the key entry under it. */
  const braveNeedsKey = () => (
    <Show when={keyState.state(BRAVE) && !braveListed()}>
      <div class="own-rq-option own-ws-static" data-testid="settings-websearch-brave-needkey">
        <span class="own-rq-check" aria-hidden="true" />
        <ServiceText service={{ id: BRAVE, name: serviceName(BRAVE) }} keys={undefined} text={text} needsKey />
      </div>
      {keyRow(BRAVE)}
    </Show>
  )
  const anyNote = () => {
    const paidNames = listed().flatMap((item) => (paid(item.id) ? [item.name] : []))
    return [
      text("own.ws.note.any", { names: names().join(", ") }),
      text("own.ws.note.anyEmpty"),
      ...(paidNames.length > 0 ? [text("own.ws.note.anyPaid", { names: paidNames.join(", ") })] : []),
      text("own.ws.note.anyMulti"),
    ].join(" ")
  }

  return (
    <>
      <p class="own-rq-note m-0 mb-1">{text("own.ws.lead")}</p>
      <section class="own-as-section" aria-labelledby="own-ws-now" data-testid="websearch-current">
        <h2 id="own-ws-now">{text("own.ws.now")}</h2>
        <Show
          when={!readProblem()}
          fallback={
            <p class="own-rq-problem" role="alert" data-testid="settings-websearch-state">
              {readProblem()}
            </p>
          }
        >
          <Show
            when={!info.loading() || info.state()}
            fallback={
              <p class="own-rq-note" data-testid="settings-websearch-state">
                {text("own.ws.now.loading")}
              </p>
            }
          >
            <NowCard
              now={now()}
              listed={listed()}
              keys={keys()}
              names={names()}
              multi={savedChecked()}
              chatgptReady={ready()}
              text={text}
            />
          </Show>
        </Show>
      </section>

      <section class="own-as-section" aria-labelledby="own-ws-mode" data-testid="settings-websearch-mode">
        <h2 id="own-ws-mode">{text("own.ws.mode")}</h2>
        <div class="own-rq-options" role="radiogroup" aria-labelledby="own-ws-mode">
          <For each={["single", "multi"] as const}>
            {(item) => (
              <button
                type="button"
                class="own-rq-option"
                role="radio"
                aria-checked={mode() === item}
                data-picked={mode() === item ? "" : undefined}
                data-testid={`settings-websearch-mode-${item}`}
                disabled={!writable() || busy()}
                onClick={() => {
                  setProblem(undefined)
                  setModeDraft(item === savedMode() ? undefined : item)
                }}
              >
                <span class="own-rq-check" data-type="radio" aria-hidden="true">
                  {mode() === item ? "✓" : ""}
                </span>
                <span class="own-rq-option-main">
                  <span>{text(`own.ws.mode.${item}`)}</span>
                  <span class="own-rq-option-desc">{text(`own.ws.mode.${item}.note`)}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </section>

      <section class="own-as-section" aria-labelledby="own-ws-pick" data-testid="settings-websearch">
        <h2 id="own-ws-pick">{text(mode() === "multi" ? "own.ws.multi.pick" : "own.ws.pick")}</h2>
        <Show when={info.listed(directory()) && listed().length === 0}>
          <p class="own-rq-note">{text("own.ws.none")}</p>
        </Show>
        <Show
          when={mode() === "multi"}
          fallback={
            <div class="own-rq-options" role="radiogroup" aria-labelledby="own-ws-pick">
              <For each={options()}>
                {(option) => (
                  <>
                    <Show when={option.key === "any"}>{braveNeedsKey()}</Show>
                    <button
                      type="button"
                      class="own-rq-option"
                      role="radio"
                      aria-checked={selected() === option.key}
                      data-picked={selected() === option.key ? "" : undefined}
                      data-testid={`settings-websearch-${option.key}`}
                      disabled={!writable() || busy()}
                      onClick={() => {
                        setProblem(undefined)
                        setPicked(option.key === effective() ? undefined : option.key)
                      }}
                    >
                      <span class="own-rq-check" data-type="radio" aria-hidden="true">
                        {selected() === option.key ? "✓" : ""}
                      </span>
                      <Show
                        when={option.service}
                        fallback={
                          <span class="own-rq-option-main">
                            <span class="own-ws-label">{labelOf(option.key)}</span>
                            <span class="own-rq-option-desc" data-testid={`websearch-option-note-${option.key}`}>
                              {option.key === "any" ? anyNote() : text("own.ws.note.off")}
                            </span>
                          </span>
                        }
                      >
                        {(service) => (
                          <ServiceText
                            service={service()}
                            keys={keys()}
                            text={text}
                            noNote={besideKeyless(service().id)}
                          />
                        )}
                      </Show>
                    </button>
                    {/* An expression, not Show's callback: that runs untracked, before the key states arrive. */}
                    {option.service && keyRow(option.service.id)}
                  </>
                )}
              </For>
            </div>
          }
        >
          <p class="own-rq-note m-0 mb-1">{text("own.ws.multi.pickNote")}</p>
          <div class="own-rq-options" role="group" aria-labelledby="own-ws-pick">
            <For each={multiRows(listed())}>
              {(service) => (
                <>
                  <button
                    type="button"
                    class="own-rq-option"
                    role="checkbox"
                    aria-checked={checked().includes(service.id)}
                    data-picked={checked().includes(service.id) ? "" : undefined}
                    data-testid={`settings-websearch-multi-${service.id}`}
                    disabled={!writable() || busy()}
                    onClick={() => toggle(service.id)}
                  >
                    <span class="own-rq-check" data-type="checkbox" aria-hidden="true">
                      {checked().includes(service.id) ? "✓" : ""}
                    </span>
                    <ServiceText service={service} keys={keys()} text={text} />
                  </button>
                  {keyRow(service.id)}
                </>
              )}
            </For>
            {braveNeedsKey()}
          </div>
          <p class="own-ws-cost" data-testid="websearch-multi-cost" aria-live="polite">
            {checked().length > 0 ? costLine(multiCost(checked(), listed(), keys()), text) : text("own.ws.multi.none")}
          </p>
          <p class="own-rq-note m-0">{text("own.ws.multi.time")}</p>
        </Show>
        <Show when={!rpc.allowed("websearch.set") && rpc.allowed("websearch.get")}>
          <p class="own-rq-note">{text("own.ws.noScope")}</p>
        </Show>
        <Show when={problem()}>
          {(message) => (
            <p class="own-rq-problem" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div class="own-rq-actions justify-start">
          <button
            type="button"
            class="own-rq-btn"
            data-variant="primary"
            data-testid="settings-websearch-save"
            disabled={!canSave()}
            onClick={() => {
              if (mode() === "multi") return void save({ type: "multi", services: [...checked()] })
              const key = picked()
              if (key) void save(choiceOf(key))
            }}
          >
            {text("own.ws.save")}
          </button>
          <button
            type="button"
            class="own-rq-btn"
            data-testid="settings-websearch-default"
            disabled={!choice() || busy() || !writable()}
            title={text("own.ws.reset.note")}
            onClick={() => void save({ type: "default" })}
          >
            {text("own.ws.reset")}
          </button>
        </div>
        <p class="own-rq-note m-0">{text("own.ws.reset.note")}</p>
      </section>

      <p class="own-rq-note mt-3" data-testid="websearch-codex-note">
        {text("own.ws.codex")}
      </p>
      <p class="own-rq-note">{text("own.ws.prices")}</p>
    </>
  )
}

/**
 * A service's name (ChatGPT `추천`, Brave without a key `키 필요`), its cost and destination, and its note (none with
 * `noNote`).
 */
function ServiceText(props: {
  readonly service: Listed
  readonly keys: Keys
  readonly text: Text
  readonly needsKey?: boolean
  readonly noNote?: boolean
}): JSX.Element {
  const text = props.text
  return (
    <span class="own-rq-option-main">
      <span class="own-ws-label">
        {props.service.name}
        <Show when={props.service.id === CHATGPT}>
          <Tag tone="accent" testid="websearch-recommended">
            {text("own.ws.recommended")}
          </Tag>
        </Show>
        <Show when={props.needsKey}>
          <Tag tone="soft" testid="websearch-brave-needkey">
            {text("own.ws.brave.needKey")}
          </Tag>
        </Show>
      </span>
      <span class="own-rq-option-desc" data-testid="websearch-option-cost">
        {facts(props.service, props.keys, text).join(" · ")}
      </span>
      <Show when={!props.noNote && noteKey(props.service.id)}>
        {(key) => <span class="own-rq-option-desc">{text(key())}</span>}
      </Show>
    </span>
  )
}

/**
 * What one search of `여러 서비스 함께` may cost: `검색 한 번에 최대 약 $0.00575 (1,000번이면 약 $5.75)` or
 * `검색 한 번에 드는 돈: 없음`, then `ChatGPT 구독 사용량도 조금 써요` and services whose price is not known.
 */
function costLine(cost: ReturnType<typeof multiCost>, text: Text) {
  return [
    cost.usd > 0
      ? text("own.ws.multi.cost", { usd: dollars(cost.usd, 5), thousand: dollars(cost.usd * 1000, 2) })
      : text("own.ws.multi.cost.free"),
    ...(cost.subscription ? [text("own.ws.multi.cost.subscription")] : []),
    ...(cost.unknown.length > 0 ? [text("own.ws.multi.cost.unknown", { names: cost.unknown.join(", ") })] : []),
  ].join(" · ")
}

function dollars(value: number, digits: number) {
  return `$${Number(value.toFixed(digits)).toString()}`
}

/** The service that answers now: name with `기본값`/`직접 고름`, cost, where the query goes, and why it is this one. */
function NowCard(props: {
  readonly now: Current
  readonly listed: readonly Listed[]
  readonly keys: Keys
  readonly names: readonly string[]
  /** The services `여러 서비스 함께` asks (listed now). */
  readonly multi: readonly string[]
  readonly chatgptReady: boolean
  readonly text: Text
}) {
  const text = props.text
  const service = () => (props.now.type === "service" ? props.now : undefined)
  const listedService = () => {
    const now = service()
    return now ? { id: now.id, name: serviceName(now.id, props.listed) } : undefined
  }
  const multiNames = () => props.multi.map((id) => serviceName(id, props.listed))
  const name = () => {
    if (props.now.type === "any") return text("own.ws.any")
    if (props.now.type === "off") return text("own.ws.now.off")
    if (props.now.type === "unset") return text("own.ws.now.unset")
    if (props.now.type === "multi") return text("own.ws.mode.multi")
    return listedService()!.name
  }
  const chatgptAsked = () => service()?.id === CHATGPT || (props.now.type === "multi" && props.multi.includes(CHATGPT))
  return (
    <div class="own-ws-now" data-testid="websearch-now" data-kind={props.now.type}>
      <p class="own-ws-now-name" data-testid="settings-websearch-state">
        <b data-testid="websearch-now-name">{name()}</b>
        <Show when={service()}>
          {(now) => (
            <Tag tone={now().chosen ? "plain" : "soft"} testid="websearch-now-source">
              {text(now().chosen ? "own.ws.now.chosen" : "own.ws.now.default")}
            </Tag>
          )}
        </Show>
        <Show when={props.now.type === "multi"}>
          <Tag tone="plain" testid="websearch-now-source">
            {text("own.ws.now.chosen")}
          </Tag>
        </Show>
      </p>
      <Show when={listedService()}>
        {(item) => (
          <ul class="own-ws-facts" data-testid="websearch-now-facts">
            <For each={facts(item(), props.keys, text)}>{(fact) => <li>{fact}</li>}</For>
          </ul>
        )}
      </Show>
      <Show when={props.now.type === "any"}>
        <ul class="own-ws-facts" data-testid="websearch-now-facts">
          <li>{text("own.ws.cost.any")}</li>
          <li>{text("own.ws.where.any", { names: props.names.join(", ") })}</li>
        </ul>
      </Show>
      <Show when={props.now.type === "multi"}>
        <ul class="own-ws-facts" data-testid="websearch-now-facts">
          <li>{text("own.ws.multi.asks", { names: multiNames().join(", ") })}</li>
          <li>{costLine(multiCost(props.multi, props.listed, props.keys), text)}</li>
          <li>
            {text("own.ws.where.multi", {
              names: props.multi
                .map((id) => (id === CHATGPT ? "ChatGPT(OpenAI)" : serviceName(id, props.listed)))
                .join(", "),
            })}
          </li>
        </ul>
      </Show>
      <p class="own-rq-note m-0" data-testid="websearch-now-why">
        {(() => {
          const now = service()
          if (props.now.type === "off") return text("own.ws.note.off")
          if (props.now.type === "any") return text("own.ws.note.anyEmpty")
          if (props.now.type === "unset") return text("own.ws.source.unset")
          if (props.now.type === "multi") return text("own.ws.source.multi")
          if (now?.missing) return text("own.ws.source.missing")
          return text(now?.chosen ? "own.ws.source.chosen" : "own.ws.source.default")
        })()}
      </p>
      {/* ChatGPT asked but no account can sign in, or there is no ChatGPT service: the accounts page is one step. */}
      <Show
        when={
          (chatgptAsked() && !props.chatgptReady) ||
          (!props.listed.some((item) => item.id === CHATGPT) && props.now.type !== "off")
        }
      >
        <p class="own-rq-warn m-0" data-testid="websearch-now-account">
          {text(chatgptAsked() ? "own.ws.chatgpt.login" : "own.ws.chatgpt.add")}{" "}
          <RouteLink to={{ name: "accounts" }} class="own-rq-link">
            {text("own.ws.accounts")}
          </RouteLink>
        </p>
      </Show>
    </div>
  )
}

/** The option key of a choice: `any`, `off` or `service:<id>` (`multi` is the mode, not an option of the list). */
function keyOf(choice: Approval.WebSearchSetChoice | undefined) {
  if (!choice || choice.type === "multi" || choice.type === "default") return undefined
  return choice.type === "service" ? `service:${choice.id}` : choice.type
}

function choiceOf(key: string): Approval.WebSearchChoice {
  if (key === "any" || key === "off") return { type: key }
  return { type: "service", id: key.slice("service:".length) }
}
