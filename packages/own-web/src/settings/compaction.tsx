// Settings > 자동 압축 (03 §5.8.4, CompactionSettings / CompactionRow / CompactionImpactDialog). Core values are shown
// read-only (own never changes `auto`, `buffer`, `keep`); kind defaults write `policy.set{patch.compaction.byKind}`,
// accounts and account×model rows write `accounts.update{compaction}`. Previews and the cost comparison are computed
// here with `Compaction.resolve`/`cycleCost` (no RPC while editing). Saving asks the router first with `dryRun` and
// opens the impact dialog when sessions would compact at their next step (5.8.4 "저장은 영향 확인을 먼저 한다").
import type { Account, Kind, Ratecard } from "@own/protocol"
import { Compaction } from "@own/protocol/compaction"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "@/data"
import { useI18n, type I18nKey } from "@/i18n"
import { COLORS, kindLabel, TUNABLE_KINDS } from "@/accounts/model"
import { errorData, errorMessage, errorType } from "@/accounts/errors"
import { amount, grouped, parseTokens, tokens } from "@/limits/format"
import { Dot, Notice, Segmented, Tag, TextField, createStatus, StatusLine } from "@/limits/kit"
import { SOURCE_LABEL } from "@/limits/meter"
import { loadPolicy, policyState, updatePolicy } from "@/limits/shared"
import { clearCompactionFocus, compactionFocus } from "./focus"
import { CompactionFallbackSection } from "./compaction-fallback"
import { IdleCompactionSection } from "./idle-compaction"
import { CompactionImpactDialog, type ImpactRequest } from "./impact"
import {
  accountValue,
  costCompare,
  DEFAULT_CYCLE,
  editorFields,
  KIND_CHOICES,
  kindChoiceOf,
  kindValue,
  LAYER_CHOICES,
  layerChoiceOf,
  modelValue,
  preview,
  ratesFor,
  withKind,
  type Choice,
  type Fields,
} from "./compaction-model"

const CHOICE_LABEL: Record<Choice, I18nKey> = {
  inherit: "own.compact.choice.inherit",
  v2: "own.compact.choice.v2",
  custom: "own.compact.choice.custom",
}

export default function CompactionSettings() {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  void loadPolicy(own)
  const [cards, setCards] = createSignal<readonly Ratecard.Card[]>([])
  void own.rpc
    .call("ratecards.get", {})
    .then((file) => setCards(file.cards))
    .catch(() => setCards([]))
  const [search, setSearch] = createSignal("")
  const [impact, setImpact] = createSignal<ImpactRequest>()
  const status = createStatus()

  const compaction = () => policyState()?.policy.compaction
  const views = () =>
    Object.values(own.state.cache).flatMap((snapshot) => (snapshot.compaction ? [snapshot.compaction] : []))
  const keep = () => compaction()?.keepTokens ?? views().find((view) => view.keepTokens !== null)?.keepTokens ?? null
  // An open session reports the core value; otherwise `health` warns only when the own config turned it off.
  const auto = () => {
    const reported = views().find((view) => view.auto !== null)?.auto
    if (reported !== undefined && reported !== null) return reported
    const health = own.state.health
    return health ? !(health.warnings ?? []).includes("compaction_auto_off") : null
  }
  const accounts = createMemo(() =>
    own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account && account.status !== "retired" ? [account] : []
    }),
  )
  const shown = () => {
    const query = search().trim().toLowerCase()
    return accounts().filter((account) => !query || account.label.toLowerCase().includes(query))
  }
  const warnings = () => own.state.health?.warnings ?? []
  const mismatches = () => {
    const sessions = data.local().sessions
    return [
      ...new Set(
        own.state.alerts
          .filter((alert) => alert.code === "compaction_threshold_mismatch")
          .map((alert) => (alert.sessionID ? (sessions.directory(alert.sessionID) ?? alert.message) : alert.message)),
      ),
    ]
  }

  // 5.8.4: `바꾸기…` / `자동 압축 설정…` / the switcher `⚙` scroll to the requested row.
  createEffect(() => {
    const target = compactionFocus()
    if (!target) return
    const id = target.accountID
      ? `compaction-account-${target.accountID}`
      : target.kind
        ? `compaction-kind-${target.kind}`
        : undefined
    const frame = requestAnimationFrame(() => {
      const element = id ? document.getElementById(id) : undefined
      if (!element) return
      element.scrollIntoView({ block: "center" })
      element.querySelector<HTMLElement>("button, [tabindex]")?.focus({ preventScroll: true })
      clearCompactionFocus()
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })

  const context: RowContext = {
    keep: () => keep() ?? Compaction.KEEP_TOKENS,
    byKind: () => compaction()?.byKind,
    cards,
    cycleFor: (providerID, modelID) =>
      views().find((view) => view.providerID === providerID && view.modelID === modelID)?.cycle ?? DEFAULT_CYCLE,
    save: (request) => void start(request),
  }

  const start = async (request: ImpactRequest) => {
    status.clear()
    const dry = await request.run(true).catch((error: unknown) => {
      request.onError?.(error)
      if (!request.onError) status.error(errorMessage(i18n, error))
      return null
    })
    if (dry === null) return
    if (dry?.sessions.length) return void setImpact({ ...request, impact: dry })
    await request
      .run(false)
      .then((final) => status.ok(appliedText(final?.sessions.length ?? 0)))
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
  }
  const appliedText = (count: number) =>
    count ? i18n.t("own.compact.applied", { n: count }) : i18n.t("own.compact.appliesNext")

  return (
    <div class="flex flex-col gap-1" data-testid="settings-compaction">
      <Show when={warnings().includes("compaction_buffer_set")}>
        <Notice tone="warn" testid="compaction-buffer-warning">
          {i18n.t("own.compact.ownConfigBuffer")}
        </Notice>
      </Show>
      <Show when={warnings().includes("compaction_auto_off")}>
        <Notice tone="warn">{i18n.t("own.set.compactAutoOff")}</Notice>
      </Show>
      <For each={mismatches()}>
        {(directory) => <Notice tone="warn">{i18n.t("own.compact.thresholdMismatch", { directory })}</Notice>}
      </For>

      <section class="own-psec !mt-2">
        <div class="own-psec-head">
          <h2>{i18n.t("own.compact.core")}</h2>
        </div>
        <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
          <dt class="text-own-muted">{i18n.t("own.compact.title")}</dt>
          <dd class="m-0" data-testid="core-auto">
            {auto() === null
              ? i18n.t("own.conf.unknown")
              : auto()
                ? i18n.t("own.compact.autoOn")
                : i18n.t("own.set.autoOff")}
          </dd>
          <dt class="text-own-muted">{i18n.t("own.compact.keep")}</dt>
          <dd class="m-0" data-testid="core-keep">
            {keep() === null
              ? i18n.t("own.conf.unknown")
              : i18n.t("own.compact.keepReadonly", { tokens: grouped(keep()!) })}
          </dd>
        </dl>
      </section>

      <section class="own-psec">
        <div class="own-psec-head">
          <h2>{i18n.t("own.set.byKind")}</h2>
        </div>
        <div class="flex flex-col">
          <For each={TUNABLE_KINDS}>{(kind) => <KindRow kind={kind} context={context} accounts={accounts()} />}</For>
          <div
            class="flex flex-wrap items-center gap-3 border-b border-own-border py-2.5 text-[13px]"
            id="compaction-kind-claude-sub"
          >
            <span class="min-w-[180px] font-semibold">{kindLabel(i18n, "claude-sub")}</span>
            <Tag tone="danger">{i18n.t("own.accounts.type.unofficial")}</Tag>
            <span class="text-own-muted">{i18n.t("own.set.claudeFixed")}</span>
          </div>
        </div>
      </section>

      <section class="own-psec">
        <div class="own-psec-head flex-wrap">
          <h2>{i18n.t("own.set.byAccount")}</h2>
          <div class="ml-auto w-[220px]">
            <TextField
              label={i18n.t("own.set.search")}
              hideLabel
              placeholder={i18n.t("own.set.search")}
              value={search()}
              onValue={setSearch}
              type="search"
              class="h-7"
            />
          </div>
        </div>
        <For each={shown()} fallback={<p class="own-placeholder px-0">{i18n.t("own.empty.accounts")}</p>}>
          {(account) => <AccountRow account={account} context={context} />}
        </For>
      </section>

      <CompactionFallbackSection accounts={accounts()} />

      <IdleCompactionSection />

      <p class="m-0 mt-4 flex gap-1.5 text-[12px] leading-[18px] text-own-muted">
        <span aria-hidden="true">ⓘ</span>
        {i18n.t("own.compact.budgetNote")}
      </p>
      <StatusLine status={status} testid="compaction-status" />
      <CompactionImpactDialog
        request={impact()}
        onClose={(applied) => {
          setImpact(undefined)
          if (applied !== undefined) status.ok(appliedText(applied))
        }}
      />
    </div>
  )
}

interface RowContext {
  readonly keep: () => number
  readonly byKind: () => Compaction.ByKind | undefined
  readonly cards: () => readonly Ratecard.Card[]
  readonly cycleFor: (providerID: string, modelID: string) => Compaction.Cycle
  readonly save: (request: ImpactRequest) => void
}

/** `창의 60% · 최대 256k · 여유 32k` for a merged layer of `kind` (the model limit reads as the kind's ceiling). */
function describe(i18n: ReturnType<typeof useI18n>, fields: Fields, kind?: Compaction.Tunable) {
  return [
    i18n.t("own.set.percentOfWindow", { percent: Compaction.shownPercent(fields.triggerPercent, kind) }),
    fields.maxTriggerTokens ? i18n.t("own.acct.compactCap", { tokens: tokens(fields.maxTriggerTokens) }) : undefined,
    fields.minReserveTokens ? i18n.t("own.compact.reserve", { tokens: tokens(fields.minReserveTokens) }) : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

function mergeFields(...layers: (Fields | null | undefined)[]): Fields {
  return layers.reduce<Fields>(
    (result, layer) => ({
      ...result,
      ...(layer?.triggerPercent === undefined ? {} : { triggerPercent: layer.triggerPercent }),
      ...(layer?.maxTriggerTokens === undefined ? {} : { maxTriggerTokens: layer.maxTriggerTokens }),
      ...(layer?.minReserveTokens === undefined ? {} : { minReserveTokens: layer.minReserveTokens }),
    }),
    {},
  )
}

function KindRow(props: {
  readonly kind: Compaction.Tunable
  readonly context: RowContext
  readonly accounts: readonly Account.View[]
}) {
  const i18n = useI18n()
  const data = useData()
  const own = data.local().own
  const stored = () => props.context.byKind()?.[props.kind]
  const choice = () => kindChoiceOf(stored())
  const [editing, setEditing] = createSignal<Fields>()
  const [fieldError, setFieldError] = createSignal<string>()
  const merged = () => mergeFields(Compaction.defaults[props.kind], stored())
  const ofKind = () => props.accounts.filter((account) => account.kind === props.kind)
  const windows = () =>
    new Map(
      ofKind().flatMap((account) =>
        (account.compaction?.effective ?? []).map((item) => [item.modelID, item.windowTokens] as const),
      ),
    )
  const allowed = () => own.rpc.allowed("policy.set")

  const save = (next: Choice, fields: Fields) => {
    const value = kindValue(next, fields)
    if (value) {
      const problem = Compaction.check(value, windows(), { keep: props.context.keep() })
      if (problem)
        return void setFieldError(
          i18n.t("own.compact.outOfRange", { min: bound(problem.min), max: bound(problem.max) }),
        )
    }
    setFieldError(undefined)
    props.context.save({
      label: kindLabel(i18n, props.kind),
      run: (dryRun) =>
        own.rpc
          .call("policy.set", { patch: { compaction: { byKind: { [props.kind]: value } } }, dryRun })
          .then((output) => {
            if (!dryRun) {
              updatePolicy(own, output.policy)
              setEditing(undefined)
            }
            return output.compactionImpact
          }),
      onError: (error) => setFieldError(rangeError(i18n, error)),
    })
  }
  const pick = (next: Choice) => {
    if (next === "custom") return void setEditing(editorFields(stored(), merged()))
    setEditing(undefined)
    if (next !== choice()) save(next, {})
  }
  const draftByKind = () => {
    const fields = editing()
    return fields ? withKind(props.context.byKind(), props.kind, kindValue("custom", fields)) : props.context.byKind()
  }
  return (
    <div
      class="border-b border-own-border py-2.5"
      id={`compaction-kind-${props.kind}`}
      data-testid="compaction-kind-row"
      data-kind={props.kind}
    >
      <div class="flex flex-wrap items-center gap-3 text-[13px]">
        <span class="min-w-[180px] font-semibold">{kindLabel(i18n, props.kind)}</span>
        <Segmented
          label={kindLabel(i18n, props.kind)}
          value={editing() ? "custom" : choice()}
          options={KIND_CHOICES.map((value) => ({
            value,
            label: i18n.t(CHOICE_LABEL[value]),
            disabled: !allowed(),
          }))}
          onChange={pick}
        />
        <span class="text-own-muted" data-testid="compaction-kind-desc">
          {describe(i18n, editing() ?? merged(), props.kind)}
        </span>
      </div>
      <Show when={editing()}>
        {(fields) => (
          <Editor
            fields={fields()}
            onChange={setEditing}
            error={fieldError()}
            onCancel={() => {
              setEditing(undefined)
              setFieldError(undefined)
            }}
            onSave={() => save("custom", fields())}
          >
            <For each={ofKind().slice(0, 3)}>
              {(account) => (
                <PreviewLine
                  account={account}
                  byKind={draftByKind()}
                  setting={account.compaction?.setting}
                  context={props.context}
                />
              )}
            </For>
          </Editor>
        )}
      </Show>
      <Show when={fieldError() && !editing()}>
        <p class="m-0 mt-1 text-[12px] text-own-danger">{fieldError()}</p>
      </Show>
    </div>
  )
}

function AccountRow(props: { readonly account: Account.View; readonly context: RowContext }) {
  const i18n = useI18n()
  const data = useData()
  const own = data.local().own
  const [open, setOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<Fields>()
  const [model, setModel] = createStore<{ id?: string; fields?: Fields; choice?: Choice }>({})
  const [fieldError, setFieldError] = createSignal<string>()
  const claude = () => props.account.kind === "claude-sub"
  const setting = () => props.account.compaction?.setting ?? null
  const effective = () => props.account.compaction?.effective ?? []
  const windows = () => new Map(effective().map((item) => [item.modelID, item.windowTokens] as const))
  const kindLayer = () =>
    claude()
      ? Compaction.defaults["claude-sub"]
      : mergeFields(
          Compaction.defaults[props.account.kind as Compaction.Tunable],
          props.context.byKind()?.[props.account.kind as Compaction.Tunable],
        )
  const allowed = () => own.rpc.allowed("accounts.update") && !claude()
  const sourceLabel = () =>
    i18n.t(
      setting() && !claude() ? "own.compact.source.account" : (SOURCE_LABEL[effective()[0]?.source ?? "v2"] as I18nKey),
    )

  createEffect(() => {
    if (compactionFocus()?.accountID === props.account.id) setOpen(true)
  })

  const save = (value: Compaction.SettingInput | null) => {
    if (value) {
      const problem = Compaction.check(value, windows(), { keep: props.context.keep() })
      if (problem)
        return void setFieldError(
          i18n.t("own.compact.outOfRange", { min: bound(problem.min), max: bound(problem.max) }),
        )
    }
    setFieldError(undefined)
    props.context.save({
      label: props.account.label,
      run: (dryRun) =>
        own.rpc.call("accounts.update", { accountID: props.account.id, compaction: value, dryRun }).then((output) => {
          if (!dryRun) {
            setEditing(undefined)
            setModel({ id: undefined, fields: undefined, choice: undefined })
          }
          return output.compactionImpact
        }),
      onError: (error) => setFieldError(rangeError(i18n, error)),
    })
  }
  const pick = (next: Choice) => {
    if (next === "custom") return void setEditing(editorFields(setting(), kindLayer()))
    setEditing(undefined)
    if (next !== layerChoiceOf(setting())) save(accountValue(setting(), next, {}))
  }
  const draft = () => {
    if (model.id && model.choice) return modelValue(setting(), model.id, model.choice, model.fields ?? {})
    const fields = editing()
    return fields ? accountValue(setting(), "custom", fields) : setting()
  }
  const draftSetting = () => {
    const value = draft()
    return value ? Compaction.normalize(value) : null
  }

  return (
    <div
      class="border-b border-own-border py-2"
      id={`compaction-account-${props.account.id}`}
      data-testid="compaction-account-row"
      data-account-id={props.account.id}
    >
      <div class="flex flex-wrap items-center gap-2 text-[13px]">
        <button
          type="button"
          class="flex min-w-[200px] items-center gap-1.5 border-0 bg-transparent p-0 text-left font-semibold"
          aria-expanded={open()}
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden="true" class="w-3 text-own-faint">
            {open() ? "▾" : "▸"}
          </span>
          <Dot color={COLORS.includes(props.account.color) ? props.account.color : "slate"} />
          {props.account.label}
          <span class="font-normal text-own-muted">({sourceLabel()})</span>
        </button>
        <Show when={!claude()} fallback={<span class="text-own-muted">{i18n.t("own.set.claudeFixed")}</span>}>
          <Segmented
            label={props.account.label}
            value={editing() ? "custom" : layerChoiceOf(setting())}
            options={LAYER_CHOICES.map((value) => ({
              value,
              label: i18n.t(CHOICE_LABEL[value]),
              disabled: !allowed(),
            }))}
            onChange={pick}
            testid="compaction-account-choice"
          />
        </Show>
      </div>
      <Show when={editing()}>
        {(fields) => (
          <Editor
            fields={fields()}
            onChange={setEditing}
            error={fieldError()}
            onCancel={() => {
              setEditing(undefined)
              setFieldError(undefined)
            }}
            onSave={() => save(accountValue(setting(), "custom", fields()))}
          >
            <PreviewLine
              account={props.account}
              byKind={props.context.byKind()}
              setting={draftSetting()}
              context={props.context}
            />
          </Editor>
        )}
      </Show>
      <Show when={fieldError() && !editing() && !model.id}>
        <p class="m-0 mt-1 text-[12px] text-own-danger">{fieldError()}</p>
      </Show>
      <Show when={open()}>
        <ul class="m-0 mt-2 flex list-none flex-col gap-1 p-0 pl-5" data-testid="compaction-models">
          <For each={effective()} fallback={<li class="text-[12.5px] text-own-faint">{i18n.t("own.set.noModels")}</li>}>
            {(item) => {
              const fixed = () =>
                Compaction.ceiling(item.windowTokens) < props.context.keep() + Compaction.FLOOR_MARGIN_TOKENS
              const stored = () => setting()?.models?.[item.modelID]
              return (
                <li class="text-[12.5px]" data-model={item.modelID}>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="own-mono min-w-[160px]">{item.modelID}</span>
                    <span class="text-own-muted" data-testid="compaction-model-row">
                      {i18n.t("own.compact.row", {
                        window: tokens(item.windowTokens),
                        trigger: tokens(item.triggerTokens),
                      })}{" "}
                      · {i18n.t(SOURCE_LABEL[item.source])}
                    </span>
                    <Show when={allowed() && !fixed()}>
                      <button
                        type="button"
                        class="own-icon-button h-6 w-6"
                        aria-label={i18n.t("own.set.modelSettings", { model: item.modelID })}
                        aria-expanded={model.id === item.modelID}
                        onClick={() =>
                          model.id === item.modelID
                            ? setModel({ id: undefined, fields: undefined, choice: undefined })
                            : setModel({
                                id: item.modelID,
                                choice: layerChoiceOf(stored()),
                                fields: editorFields(stored(), mergeFields(kindLayer(), setting())),
                              })
                        }
                      >
                        <span aria-hidden="true">⚙</span>
                      </button>
                    </Show>
                    <Show when={fixed()}>
                      <span class="text-own-faint">{i18n.t("own.compact.windowTooSmall")}</span>
                    </Show>
                  </div>
                  <Show when={model.id === item.modelID}>
                    <div class="mt-1.5 rounded-lg border border-own-border p-2.5">
                      <Segmented
                        label={item.modelID}
                        value={model.choice ?? "inherit"}
                        options={LAYER_CHOICES.map((value) => ({
                          value,
                          label: i18n.t(value === "inherit" ? "own.set.followAccount" : CHOICE_LABEL[value]),
                        }))}
                        onChange={(value) => setModel("choice", value)}
                      />
                      <Show when={model.choice === "custom"}>
                        <FieldInputs fields={model.fields ?? {}} onChange={(fields) => setModel("fields", fields)} />
                      </Show>
                      <PreviewLine
                        account={props.account}
                        byKind={props.context.byKind()}
                        setting={draftSetting()}
                        context={props.context}
                        modelID={item.modelID}
                      />
                      <Show when={fieldError()}>
                        <p class="m-0 mt-1 text-[12px] text-own-danger">{fieldError()}</p>
                      </Show>
                      <div class="mt-2 flex gap-2">
                        <button
                          type="button"
                          class="own-btn"
                          data-size="sm"
                          onClick={() => setModel({ id: undefined, fields: undefined, choice: undefined })}
                        >
                          {i18n.t("own.kit.cancel")}
                        </button>
                        <button
                          type="button"
                          class="own-btn"
                          data-size="sm"
                          data-variant="primary"
                          onClick={() =>
                            save(modelValue(setting(), item.modelID, model.choice ?? "inherit", model.fields ?? {}))
                          }
                        >
                          {i18n.t("own.kit.save")}
                        </button>
                      </div>
                    </div>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/** Custom editor with its own action row and live preview (children). */
function Editor(props: {
  readonly fields: Fields
  readonly onChange: (fields: Fields) => void
  readonly onSave: () => void
  readonly onCancel: () => void
  readonly error?: string
  readonly children?: JSX.Element
}) {
  const i18n = useI18n()
  return (
    <div class="mt-2 rounded-lg border border-own-border bg-own-subtle p-3" data-testid="compaction-editor">
      <FieldInputs fields={props.fields} onChange={props.onChange} />
      <div class="mt-2 flex flex-col gap-1">{props.children}</div>
      <Show when={props.error}>
        <p class="m-0 mt-1 text-[12px] text-own-danger" role="alert" data-testid="compaction-error">
          {props.error}
        </p>
      </Show>
      <div class="mt-2.5 flex gap-2">
        <button type="button" class="own-btn" data-size="sm" onClick={() => props.onCancel()}>
          {i18n.t("own.kit.cancel")}
        </button>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-variant="primary"
          onClick={() => props.onSave()}
          data-testid="compaction-save"
        >
          {i18n.t("own.kit.save")}
        </button>
      </div>
    </div>
  )
}

/**
 * The three optional fields of `Compaction.Setting`: percent (10–90 slider, never above 90 = v2), trigger cap and
 * minimum reserve in tokens (thousands separators and `k`/`M` accepted, 12장 IME-safe inputs).
 */
function FieldInputs(props: { readonly fields: Fields; readonly onChange: (fields: Fields) => void }) {
  const i18n = useI18n()
  const [cap, setCap] = createSignal(props.fields.maxTriggerTokens ? grouped(props.fields.maxTriggerTokens) : "")
  const [reserve, setReserve] = createSignal(
    props.fields.minReserveTokens ? grouped(props.fields.minReserveTokens) : "",
  )
  const percent = () => props.fields.triggerPercent ?? Compaction.PERCENT_MAX
  const update = (patch: Partial<Record<keyof Fields, number | null | undefined>>) => {
    const next: Record<string, number | null | undefined> = { ...props.fields, ...patch }
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
    props.onChange(next as Fields)
  }
  return (
    <div class="grid grid-cols-1 gap-3 tablet:grid-cols-3">
      <label class="own-field">
        <span class="own-field-label">{i18n.t("own.set.percent", { percent: percent() })}</span>
        <input
          type="range"
          min={Compaction.PERCENT_MIN}
          max={Compaction.PERCENT_MAX}
          step={1}
          value={percent()}
          onInput={(event) => update({ triggerPercent: Number(event.currentTarget.value) })}
          data-testid="compaction-percent"
        />
        <span class="own-field-hint">{i18n.t("own.compact.maxPercent")}</span>
      </label>
      <TextField
        label={i18n.t("own.set.cap")}
        value={cap()}
        onValue={(value) => {
          setCap(value)
          update({ maxTriggerTokens: value.trim() ? (parseTokens(value) ?? null) : undefined })
        }}
        inputMode="numeric"
        placeholder={i18n.t("own.set.none")}
        testid="compaction-cap"
      />
      <TextField
        label={i18n.t("own.set.reserve")}
        value={reserve()}
        onValue={(value) => {
          setReserve(value)
          update({ minReserveTokens: value.trim() ? parseTokens(value) : undefined })
        }}
        inputMode="numeric"
        placeholder="0"
        testid="compaction-reserve"
      />
    </div>
  )
}

/**
 * 5.8.4 preview: `"gpt-5.5 @ 개인 Pro"는 245k에서 압축합니다.` plus the clamp notes and, when the rate card has
 * explicit rates, the ⑫ cost per request at the v2 default versus this threshold.
 */
function PreviewLine(props: {
  readonly account: Account.View
  readonly byKind: Compaction.ByKind | undefined
  readonly setting: Compaction.Setting | null | undefined
  readonly context: RowContext
  readonly modelID?: string
}) {
  const i18n = useI18n()
  const item = () => {
    const effective = props.account.compaction?.effective ?? []
    return (props.modelID ? effective.find((entry) => entry.modelID === props.modelID) : undefined) ?? effective[0]
  }
  const result = () => {
    const current = item()
    if (!current) return undefined
    return preview({
      kind: props.account.kind,
      modelID: current.modelID,
      windowTokens: current.windowTokens,
      byKind: props.byKind,
      account: props.setting,
      keep: props.context.keep(),
    })
  }
  const cost = () => {
    const current = item()
    const resolved = result()?.resolved
    if (!current || !resolved) return undefined
    const rates = ratesFor(props.context.cards(), props.account.kind, current.modelID)
    if (!rates) return undefined
    return costCompare({
      kind: props.account.kind,
      windowTokens: current.windowTokens,
      triggerTokens: resolved.triggerTokens,
      rates,
      cycle: props.context.cycleFor(props.account.providerID, current.modelID),
      keep: props.context.keep(),
    })
  }
  return (
    <Show when={item() && result()}>
      <div class="text-[12px] leading-[18px] text-own-muted" data-testid="compaction-preview">
        <p class="m-0">
          {i18n.t("own.set.preview", {
            model: item()!.modelID,
            account: props.account.label,
            tokens: tokens(result()!.resolved.triggerTokens),
          })}
        </p>
        <Show when={result()!.fixed}>
          <p class="m-0 text-own-warn">{i18n.t("own.compact.windowTooSmall")}</p>
        </Show>
        <Show when={!result()!.fixed && result()!.resolved.clamped === "floor"}>
          <p class="m-0 text-own-warn">
            {i18n.t("own.compact.raisedToFloor", { floor: tokens(result()!.resolved.floorTokens) })}
          </p>
        </Show>
        <Show when={result()!.resolved.clamped === "ceiling"}>
          <p class="m-0">{i18n.t("own.compact.maxPercent")}</p>
        </Show>
        <Show when={cost()}>
          {(value) => (
            <p class="m-0 flex flex-wrap items-center gap-1.5">
              {i18n.t("own.set.costLine", {
                model: item()!.modelID,
                v2: value().v2 === null ? "—" : amount(value().v2!, value().unit, false),
                chosen: value().chosen === null ? "—" : amount(value().chosen!, value().unit, false),
              })}
              <Tag tone="dashed">{i18n.t("own.conf.estimated")}</Tag>
            </p>
          )}
        </Show>
      </div>
    </Show>
  )
}

function bound(value: number | null) {
  return value === null ? "—" : tokens(value)
}

function rangeError(i18n: ReturnType<typeof useI18n>, error: unknown) {
  if (errorType(error) === "setting_out_of_range") {
    const range = errorData<{ min: number | null; max: number | null }>(error)
    return i18n.t("own.compact.outOfRange", { min: bound(range.min ?? null), max: bound(range.max ?? null) })
  }
  if (errorType(error) === "policy_denied") return i18n.t("own.acct.err.policy")
  return errorMessage(i18n, error)
}
