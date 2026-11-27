// 압축 내용 dialog (lazy, 03 §4.5 "압축 내용 보기", UC 2026-10-18): every compaction of the conversation in order,
// read-only. Each entry says when it ran, why (`자동`/`수동`), who wrote it (`<계정>에서 요약` with the account that
// signed the request, from its ledger line, SL 2026-10-26; a stand-in model; or `모델 없이 줄임`), the context before
// and after when the steps around it are loaded, and the compaction request's
// own usage. A summary compaction shows its summary (copyable), the user's messages own's checkpoint puts back, and the
// recent messages kept word for word; a provider-native one says it is encrypted and shows what is known. The newest
// completed one is `지금 모델이 받는 내용`; older ones were folded into the next. The list is the server's
// (`message.list{type: "compaction"}`, every page), read again when a compaction of the conversation starts or ends.
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useData, type ServerKey } from "@/data"
import { useI18n } from "@/i18n"
import { copyText, Dialog, Notice, Tag } from "@/limits/kit"
import { showToast } from "@/switcher/toast"
import { buildCatalog } from "@/transcript/catalog"
import { AccountName } from "@/transcript/chip"
import { formatClock, formatClockFull, formatTokens, splitAt } from "@/transcript/format"
import { createLedgerLines } from "@/transcript/ledger"
import { useMarkerText } from "@/transcript/marker-strings"
import { signerOf } from "@/transcript/signer"
import { useResetText } from "@/context-reset/strings"
import { compactionEntries, type CompactionEntry, type CompactionMessage } from "./model"
import { useCompactionDialogText, type CompactionDialogKey } from "./dialog-strings"
import { compactionsText } from "./strings"
import "./compactions.css"

/**
 * Reasons the older request has words for (own-accounts' first and second run, core's record, `stand-in` from
 * `CompactionCache.sentOf`; `transport` only on checkpoints from before CC-12); an unknown one shows the request alone.
 */
const REASONS: ReadonlySet<string> = new Set(
  [
    "cold",
    "model",
    "longest-prefix",
    "unmeasured",
    "stand-in",
    "short",
    "fresh",
    "error",
    "flattened",
    "transport",
    "thinking",
    "no-ttl",
    "account",
    "overflow",
    "fit",
    "tier",
    "failed",
    "declined",
  ].map((reason) => `own.compactions.reason.${reason}`),
)

/** Pages of 200 (the API's most), at most this many: 2,000 compactions is far past any conversation. */
const PAGES = 10

export default function CompactionsDialog(props: {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly messageID?: string
  readonly onClose: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const words = useMarkerText()
  const resetWords = useResetText()
  const text = useCompactionDialogText()
  /** `대화 전체로 요청해 캐시를 이어 씀`, or `앞부분만 요청(캐시가 식어서)` (P-034, CC 2026-10-24). */
  const requestText = (request: CompactionEntry["request"]) => {
    if (!request) return undefined
    if (request.request === "full") return text("own.compactions.request.full")
    const key = `own.compactions.reason.${request.reason ?? ""}`
    if (!REASONS.has(key)) return text("own.compactions.request.older")
    return text("own.compactions.request.olderBecause", { reason: text(key as CompactionDialogKey) })
  }
  const runtime = () => data.get(props.serverKey)
  const [list, setList] = createSignal<ReadonlyArray<CompactionMessage>>()
  const [error, setError] = createSignal<string>()

  const loaded = (): ReadonlyArray<SessionMessageInfo> => runtime()?.data.session.message.list(props.sessionID) ?? []
  const entries = createMemo(() => {
    const value = list()
    return value && compactionEntries(value, loaded())
  })
  const directory = () => runtime()?.sessions.directory(props.sessionID)
  const catalog = createMemo(() => {
    const location = runtime()?.data.location
    const at = directory()
    return buildCatalog(
      at ? location?.provider.list({ directory: at }) : undefined,
      at ? location?.model.list({ directory: at }) : undefined,
    )
  })
  const modelName = (providerID: string, modelID: string) =>
    catalog().all.get(providerID)?.models[modelID]?.name ?? modelID
  // The router's lines name the account that signed each compaction (several Claude accounts share one provider).
  const ledger = createMemo(() => {
    const own = runtime()?.own
    return own && createLedgerLines({ own, sessionID: props.sessionID, ready: () => own.state.status === "ready" })
  })
  createEffect(() => {
    const lines = ledger()
    if (lines && entries()?.some((entry) => entry.usage && !lines.line(entry.id))) lines.wantOlder()
  })

  const load = async () => {
    const current = runtime()
    if (!current) return
    const pages = async (cursor: string | undefined, left: number): Promise<CompactionMessage[]> => {
      const page = await current
        .client()
        .message.list({ sessionID: props.sessionID, type: "compaction", order: "asc", limit: 200, cursor })
      const items = page.data.filter((message): message is CompactionMessage => message.type === "compaction")
      const next = page.cursor.next
      return next && left > 1 ? [...items, ...(await pages(next, left - 1))] : items
    }
    await pages(undefined, PAGES)
      .then((items) => {
        setError(undefined)
        setList(items)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  // Read again when a compaction of the conversation starts, ends or fails (the live messages say so first).
  const live = createMemo(() =>
    loaded()
      .flatMap((message) => (message.type === "compaction" ? [`${message.id}:${message.status}`] : []))
      .join(","),
  )
  createEffect(on(live, () => void load()))

  return (
    <Dialog
      open
      size="wide"
      title={text("own.compactions.title")}
      onClose={props.onClose}
      testid="compactions-dialog"
      dismissable
    >
      <div class="flex flex-col gap-3">
        <p class="m-0 text-[12.5px] text-own-muted">{text("own.compactions.lead")}</p>
        <Show when={error()}>
          {(reason) => (
            <Notice tone="danger" testid="compactions-error">
              {text("own.compactions.loadFailed", { reason: reason() })}
            </Notice>
          )}
        </Show>
        <Show
          when={entries()}
          fallback={
            <Show when={!error()}>
              <p class="m-0 text-own-muted">{text("own.compactions.loading")}</p>
            </Show>
          }
        >
          {(items) => (
            <Show
              when={items().length > 0}
              fallback={
                <p class="m-0 text-own-muted" data-testid="compactions-empty">
                  {text("own.compactions.empty")}
                </p>
              }
            >
              <ol class="own-cpx-list" data-testid="compactions-list">
                <For each={items()}>
                  {(entry, index) => (
                    <Entry
                      entry={entry}
                      number={index() + 1}
                      open={props.messageID ? entry.id === props.messageID : entry.current}
                      focus={entry.id === props.messageID}
                    />
                  )}
                </For>
              </ol>
            </Show>
          )}
        </Show>
      </div>
    </Dialog>
  )

  function Entry(entryProps: {
    readonly entry: CompactionEntry
    readonly number: number
    readonly open: boolean
    readonly focus: boolean
  }) {
    const entry = () => entryProps.entry
    const [open, setOpen] = createSignal(entryProps.open)
    const own = () => runtime()?.own
    /** `<계정>에서 요약` (or `대체 요약 · <model>` by a stand-in), `모델 없이 줄임`; none for a native one. */
    const author = () => {
      const value = entry()
      if (value.content.kind === "native" || value.content.kind === "reset") return undefined
      if (value.fallback && value.fallback.model === undefined) return { byCode: true as const }
      const providerID = value.fallback?.model?.split("/")[0] ?? value.model?.providerID
      const store = own()
      if (!providerID || !store) return undefined
      const model = value.fallback?.model
        ? value.fallback.model.split("/").slice(1).join("/")
        : value.model && modelName(value.model.providerID, value.model.id)
      return {
        byCode: false as const,
        account: signerOf(
          { own: store, i18n, providerName: (id) => catalog().all.get(id)?.name ?? id },
          { sessionID: props.sessionID, providerID, line: ledger()?.line(value.id) },
        ).display,
        standIn: !!value.fallback,
        model,
      }
    }
    const copy = async (value: string) => {
      const ok = await copyText(value)
      showToast({
        message: text(ok ? "own.compactions.copied" : "own.compactions.copyFailed"),
        tone: ok ? "neutral" : "danger",
      })
    }
    return (
      <li
        class="own-cpx-entry"
        data-testid="compaction-entry"
        data-current={entry().current ? "" : undefined}
        data-kind={entry().content.kind}
        ref={(element) => {
          if (entryProps.focus) requestAnimationFrame(() => element.scrollIntoView({ block: "nearest" }))
        }}
      >
        <div class="own-cpx-head">
          <b>{text("own.compactions.number", { n: entryProps.number })}</b>
          <time dateTime={new Date(entry().at).toISOString()} title={formatClockFull(i18n, entry().at)}>
            {formatClock(i18n, entry().at)}
          </time>
          <span>
            {entry().content.kind === "reset"
              ? resetWords(
                  resetOf(entry().content)?.undone === undefined ? "own.reset.viewer" : "own.reset.viewerUndone",
                )
              : words(entry().reason === "manual" ? "own.marker.compactManual" : "own.marker.compactAuto")}
          </span>
          {/* Keyed: the account comes in later with the ledger line (it names the account that signed it). */}
          <Show when={author()} keyed>
            {(current) => {
              if (current.byCode)
                return (
                  <span
                    class="own-marker-fallback"
                    title={words("own.marker.compactFailure", { reason: entry().fallback?.reason ?? "" })}
                  >
                    {words("own.marker.compactByCode")}
                  </span>
                )
              const [head, tail] = splitAt(
                words(current.standIn ? "own.marker.compactByFallback" : "own.marker.compactBy"),
                "{account}",
              )
              return (
                <span
                  classList={{ "own-marker-fallback": current.standIn }}
                  title={
                    current.standIn
                      ? words("own.marker.compactFailure", { reason: entry().fallback?.reason ?? "" })
                      : undefined
                  }
                >
                  {head}
                  <AccountName account={current.account} />
                  {tail}
                  {current.model ? ` · ${current.model}` : ""}
                </span>
              )
            }}
          </Show>
          <Show
            when={entry().current}
            fallback={
              <Show when={entry().content.kind === "summary" || entry().content.kind === "native"}>
                <span class="text-own-faint" title={text("own.compactions.olderHint")}>
                  {text("own.compactions.older")}
                </span>
              </Show>
            }
          >
            <Tag tone="accent" testid="compaction-current">
              {text("own.compactions.current")}
            </Tag>
          </Show>
        </div>
        <Show when={entry().request?.trigger === "idle"}>
          <p class="own-cpx-facts" data-testid="compaction-idle">
            {compactionsText.text(i18n.locale(), "own.compactions.idle")}
          </p>
        </Show>
        <Show when={entry().before !== undefined || entry().usage}>
          <p class="own-cpx-facts" data-testid="compaction-facts">
            {[
              entry().before === undefined
                ? undefined
                : text("own.compactions.sizes", {
                    before: formatTokens(entry().before!),
                    after:
                      entry().after === undefined
                        ? words("own.marker.compactAfterPending")
                        : formatTokens(entry().after!),
                  }),
              entry().usage &&
                text("own.compactions.usage", {
                  input: formatTokens(entry().usage!.input),
                  output: formatTokens(entry().usage!.output),
                }),
              entry().cached === undefined
                ? undefined
                : text("own.compactions.cached", { percent: `${Math.round(entry().cached! * 100)}%` }),
              requestText(entry().request),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </Show>
        <Body />
      </li>
    )

    function Body() {
      const content = () => entry().content
      return (
        <>
          <Show when={content().kind === "reset"}>
            <p class="own-cpx-note" data-testid="compaction-reset">
              {resetWords("own.reset.viewerNote")}
            </p>
          </Show>
          <Show when={content().kind === "running"}>
            <p class="own-cpx-note">{text("own.compactions.running")}</p>
          </Show>
          <Show when={failedOf(content())}>
            {(value) => (
              <div class="own-cpx-note" data-testid="compaction-failed">
                <p class="m-0 text-own-danger">{text("own.compactions.failed", { error: value().error })}</p>
                <p class="m-0">{text("own.compactions.failedHint")}</p>
              </div>
            )}
          </Show>
          <Show when={nativeOf(content())}>
            {(value) => (
              <div class="own-cpx-note" data-testid="compaction-native">
                <p class="m-0">
                  {text("own.compactions.native", {
                    provider: catalog().all.get(value().providerID)?.name ?? value().providerID,
                  })}
                </p>
                <p class="m-0 text-own-faint">
                  {text("own.compactions.nativeFacts", {
                    model: modelName(value().providerID, value().modelID),
                    items: value().items,
                    size: i18n.number(value().size),
                  })}
                </p>
              </div>
            )}
          </Show>
          <Show when={summaryOf(content())}>
            {(value) => (
              <>
                <div class="own-cpx-row">
                  <button
                    type="button"
                    class="own-link"
                    aria-expanded={open()}
                    data-testid="compaction-toggle"
                    onClick={() => setOpen((shown) => !shown)}
                  >
                    {text(open() ? "own.compactions.hideSummary" : "own.compactions.showSummary")} {open() ? "▾" : "▸"}
                  </button>
                  <Show when={open() && value().summary}>
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      data-testid="compaction-copy"
                      onClick={() => void copy(value().summary)}
                    >
                      {text("own.compactions.copy")}
                    </button>
                  </Show>
                </div>
                <Show when={open()}>
                  <section aria-label={text("own.compactions.summary")}>
                    <Show
                      when={value().summary}
                      fallback={<p class="own-cpx-note">{text("own.compactions.emptySummary")}</p>}
                    >
                      <pre class="own-cpx-text" tabindex="0" data-testid="compaction-summary">
                        {value().summary}
                      </pre>
                    </Show>
                    <Show when={value().userMessages.length > 0}>
                      <details class="own-cpx-more" data-testid="compaction-user-messages">
                        <summary>{text("own.compactions.userMessages", { n: value().userMessages.length })}</summary>
                        <ol class="own-cpx-messages">
                          <For each={value().userMessages}>{(item) => <li class="own-cpx-text">{item}</li>}</For>
                        </ol>
                      </details>
                    </Show>
                    <Show when={value().recent}>
                      <details class="own-cpx-more" data-testid="compaction-recent">
                        <summary>{text("own.compactions.recent", { n: i18n.number(value().recent.length) })}</summary>
                        <div class="own-cpx-row">
                          <button
                            type="button"
                            class="own-btn"
                            data-size="sm"
                            onClick={() => void copy(value().recent)}
                          >
                            {text("own.compactions.copy")}
                          </button>
                        </div>
                        <pre class="own-cpx-text" tabindex="0">
                          {value().recent}
                        </pre>
                      </details>
                    </Show>
                    <Show when={!value().recent && value().kept}>
                      {(kept) => (
                        <p class="m-0 text-own-faint" data-testid="compaction-kept">
                          {text("own.compactions.kept", { n: kept() })}
                        </p>
                      )}
                    </Show>
                  </section>
                </Show>
              </>
            )}
          </Show>
        </>
      )
    }
  }
}

function summaryOf(content: CompactionEntry["content"]) {
  return content.kind === "summary" ? content : undefined
}

function resetOf(content: CompactionEntry["content"]) {
  return content.kind === "reset" ? content : undefined
}

function nativeOf(content: CompactionEntry["content"]) {
  return content.kind === "native" ? content : undefined
}

function failedOf(content: CompactionEntry["content"]) {
  return content.kind === "failed" ? content : undefined
}
