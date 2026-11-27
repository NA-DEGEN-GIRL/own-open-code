// "이 대화" card of the 계정·한도 tab (03 §4.7.1, UX 2026-10-26), at most four rows: `이 대화 · GPT-5.5` with `전환…` at
// the right (the account is the highlighted row below, tagged `이 대화`), the context bar with its auto-compaction tick
// (5.8.3), one muted line `캐시 따뜻함 · 약 4분 추정 · 지금까지 입력 17k (캐시 100%) · 출력 170 · ≈0.3 cr 추정`, and the
// links `대화 정보` and `이 대화 압축 설정…` (5.8.5). Bindings, cache state and totals come from OwnStore (events); the
// totals are loaded once and then advanced by `ledger.step` lines.
import type { Cache, Ledger } from "@own/protocol"
import { createEffect, createSignal, createUniqueId, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData, type OwnStore, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { modelLabel } from "@/sidebar/model"
import { modelName, slotOf } from "@/switcher/labels"
import { amount, percent, tokens } from "./format"
import { openSessionInfo, openSwitcher } from "./intents"
import { Tag } from "./kit"
import { CacheStateBadge, ContextBar } from "./meter"
import { SessionCompactionDialog } from "./session-compaction"
import { useSessionCardText } from "./session-strings"
import { add, merge } from "./totals"

export function SessionCard(props: {
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly now: () => number
  /** The tab is showing: totals load only then (a hidden tab does no work, 4.7). */
  readonly active: () => boolean
}) {
  const data = useData()
  const i18n = useI18n()
  const runtime = () => data.get(props.serverKey)
  const own = () => runtime()?.own
  const [editing, setEditing] = createSignal(false)

  createEffect(() => {
    const store = own()
    if (!store) return
    onCleanup(store.watchVisible([props.sessionID]))
    onCleanup(store.watchOpen(props.sessionID))
  })

  const binding = () => own()?.state.binding[props.sessionID]
  const cache = () => own()?.state.cache[props.sessionID]
  const slot = () => {
    const current = binding()
    return current?.model ? slotOf(cache(), current.model.providerID, current.accountID) : undefined
  }
  const totals = createSessionTotals(own, runtime, () => props.sessionID, props.active)
  const heading = createUniqueId()

  return (
    <section class="own-acard mb-2" aria-labelledby={heading} data-testid="session-card">
      <div class="flex min-w-0 items-center gap-2">
        <div
          class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] leading-5"
          data-testid="session-binding"
        >
          {/* A real heading (UX 2026-10-27), muted beside the model it introduces. */}
          <h3 id={heading} class="m-0 text-[13px] font-normal leading-5 text-own-muted">
            {i18n.t("own.lim.thisSession")}
          </h3>
          <span class="text-own-faint" aria-hidden="true">
            ·
          </span>
          <Show when={binding()} fallback={<span class="text-own-faint">{i18n.t("own.shell.loading")}</span>}>
            {(current) => (
              <Show
                when={current().model}
                fallback={
                  <span class="own-chip rounded-[6px] border border-dashed border-own-border-strong px-1.5 text-own-muted">
                    ◌ {i18n.t("own.binding.unpinned")}
                  </span>
                }
              >
                {(model) => (
                  <Show
                    when={!current().builtin}
                    fallback={
                      <span
                        class="own-chip rounded-[6px] border border-dashed border-own-border-strong px-1.5 text-own-muted"
                        title={i18n.t("own.binding.builtinWarn")}
                      >
                        ◌ {i18n.t("own.binding.builtin", { provider: model().providerID })} ⚠
                      </span>
                    }
                  >
                    {/* The catalog name, as in the header pill and the switcher (03 §4.4). */}
                    {/* `비공식` is the account's (UX 2026-10-27): its row below, tagged `이 대화`, carries it. */}
                    <b class="min-w-0 truncate font-semibold" data-testid="session-model">
                      {runtime() ? modelName(runtime()!, model()) : modelLabel(model().id)}
                    </b>
                  </Show>
                )}
              </Show>
            )}
          </Show>
        </div>
        <Show when={own()?.rpc.allowed("switch.estimate")}>
          <button
            type="button"
            class="own-btn -my-1 flex-none"
            data-size="sm"
            data-testid="session-switch"
            onClick={() => openSwitcher({ serverKey: props.serverKey, sessionID: props.sessionID })}
          >
            {i18n.t("own.lim.switch")}
          </button>
        </Show>
      </div>
      <Show when={cache()?.compaction}>
        {(compaction) => (
          <div class="mt-1">
            <ContextBar compaction={compaction()} />
          </div>
        )}
      </Show>
      <Show when={binding()?.model || totals()}>
        <SessionFacts
          slot={binding()?.model ? { value: slot() } : undefined}
          now={props.now}
          totals={totals()}
          side={totals.side()}
          thirdParty={binding()?.thirdParty === true}
        />
      </Show>
      <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] leading-[18px]">
        <button
          type="button"
          class="own-link"
          data-testid="session-info-open"
          onClick={() => openSessionInfo({ serverKey: props.serverKey, sessionID: props.sessionID })}
        >
          {i18n.t("own.lim.sessionInfo")}
        </button>
        <Show when={cache()?.compaction && own()?.rpc.allowed("compaction.setSession")}>
          <button type="button" class="own-link" data-testid="session-compaction-open" onClick={() => setEditing(true)}>
            {i18n.t("own.lim.sessionCompaction")}
          </button>
        </Show>
      </div>
      <Show when={cache()?.compaction}>
        {(compaction) => (
          <SessionCompactionDialog
            open={editing()}
            serverKey={props.serverKey}
            sessionID={props.sessionID}
            compaction={compaction()}
            onClose={() => setEditing(false)}
          />
        )}
      </Show>
    </section>
  )
}

/**
 * The card's muted line: the cache state (when the conversation has a model), `지금까지 입력 1.2M (캐시 91%) · 출력 38k`
 * and the cost with its 추정 tag (`≈42.6 cr`). Each part carries its separator before it, so a wrapped line never starts
 * with `·` (styles/seps.css `.own-seps`). The Claude slot's cost is never shown as $0 (0-11): its whole warning has a
 * line of its own.
 */
function SessionFacts(props: {
  /** The cache slot of the conversation's model; absent when the conversation has none. */
  readonly slot: { readonly value: Cache.Slot | undefined } | undefined
  readonly now: () => number
  readonly totals: Ledger.Totals | undefined
  /** Side questions among the totals' lines (02 §9.7). */
  readonly side: number
  readonly thirdParty: boolean
}) {
  const i18n = useI18n()
  const t = useSessionCardText()
  const input = (totals: Ledger.Totals) => totals.tokens.input + totals.tokens.cacheRead + totals.tokens.cacheWrite
  const hit = (totals: Ledger.Totals) =>
    input(totals) > 0 ? percent(Math.round((100 * totals.tokens.cacheRead) / input(totals))) : "—"
  return (
    <>
      <div class="own-seps mt-1 text-[12px] leading-[18px] text-own-muted" data-testid="session-facts">
        <span class="own-seps-in">
          <Show when={props.slot}>
            {(slot) => (
              <span>
                <CacheStateBadge slot={slot().value} now={props.now} />
              </span>
            )}
          </Show>
          <Show when={props.totals}>
            {(totals) => (
              <>
                <span class="own-num" data-testid="session-totals">
                  {t("own.lim.sess.totals", {
                    input: tokens(input(totals())),
                    hit: hit(totals()),
                    output: tokens(totals().tokens.output + totals().tokens.reasoning),
                  })}
                </span>
                <Show when={!props.thirdParty && totals().cost.length}>
                  <span class="own-num" data-testid="session-cost">
                    {totals()
                      .cost.map((item) => amount(item.amount, item.unit, false))
                      .join(" + ")}{" "}
                    <Tag tone="dashed">{i18n.t("own.conf.estimated")}</Tag>
                  </span>
                </Show>
                <Show when={props.side > 0}>
                  <span data-testid="session-side">{t("own.lim.sess.side", { n: props.side })}</span>
                </Show>
              </>
            )}
          </Show>
        </span>
      </div>
      <Show when={props.thirdParty}>
        <p class="m-0 mt-1 text-[12px] leading-4 text-own-warn" data-testid="session-cost-unknown">
          {i18n.t("own.claude.costUnknown")}
        </p>
      </Show>
    </>
  )
}

/**
 * Session totals: `ledger.session` once (and after every reconnect), then each `ledger.step` of the session is added
 * (02 §9.2 totals are over all lines; `limit: 1` keeps the payload small).
 */
function createSessionTotals(
  own: () => OwnStore | undefined,
  runtime: () => ServerRuntime | undefined,
  sessionID: () => string,
  active: () => boolean,
) {
  // `side`: how many of the lines are side questions (02 §9.7), shown as `곁질문 n번 포함`.
  const [state, setState] = createStore<{ value?: Ledger.Totals; side: number; key?: string }>({ side: 0 })
  const load = (store: OwnStore, id: string) =>
    store.rpc
      .call("ledger.session", { sessionID: id, limit: 1 })
      .then((output) => {
        if (sessionID() === id)
          setState({
            value: merge(Object.values(output.totals.byAccount)),
            side: output.totals.side?.requests ?? 0,
            key: id,
          })
      })
      .catch(() => undefined)
  // Events keep the totals current whether or not the tab shows; a reconnect drops them until the next load.
  createEffect(
    on([own, sessionID], ([store, id]) => {
      setState({ value: undefined, side: 0, key: undefined })
      if (!store) return
      const stopStep = store.on("ledger.step", (event) => {
        const line = event.data.line
        if (line.sessionID !== id || !state.value) return
        setState("value", add(state.value, line))
        if (line.kind === "side") setState("side", (count) => count + 1)
      })
      const stopBus = runtime()?.bus.listen((event) => {
        if (event.type === "server.connected") setState({ value: undefined, side: 0, key: undefined })
      })
      onCleanup(() => {
        stopStep()
        stopBus?.()
      })
    }),
  )
  // The request itself waits until the tab is visible (4.7: hidden tabs do no work).
  createEffect(() => {
    const store = own()
    const id = sessionID()
    if (!store || !active() || state.key === id) return
    setState("key", id)
    void load(store, id)
  })
  return Object.assign(() => state.value, { side: () => state.side })
}
