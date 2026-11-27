// 자세히 (07 §7.2), the preset editor's lazy panel, mounted through `registerPresetDetail` (presets/editor.tsx):
// - per-role reasoning effort (07 §2.3) with what it sends for the main now (`medium → high로 보냄`) and a help line;
//   a pinned model offers its own levels (missing ones dimmed), one without levels says why (a compat account's model:
//   where to set its levels); the preset's `강도 고정` replaces the line while set;
// - 하위 에이전트 역할 (07 §2.4, PE): each role's purpose, what it may do and where it runs now (presets/role-guide.tsx);
// - each role's ordered target list (`위로` / `아래로` / `대상 빼기` / `대상 추가`), always ending in `메인과 같게` (07 §1.2);
// - delegation `안 함` (07 §2.5, only here), the three caps and this preset's own ultra level (07 §2.6);
// - how far the conversation may raise one subagent's effort (07 §2.3 `대화에서 하위 에이전트 강도 올리기`);
// - a read-only preview of the `own.preset` instruction it adds (07 §3.3, `Preset.renderGuidance`);
// - the group's lighter-pair table with `짝 바꾸기` (07 §4.2), `★ 이 묶음에서 먼저 쓰기` and `다른 묶음에 복사…`;
// - the repair history, and Codex retirement dates dimmed beside their targets: never a notice or a successor (U3);
// - a model pool (T4, 07 §7.2 모델 묶음) instead of the role rows: each entry's frozen card in Korean with its as-of
//   date, one labelled `추론 강도` holding its effort and its fixed level (PE 2026-11-08: two optgroups, a help line
//   saying which applies), a one-line note for the LLM and `빼기`; `카드 새로 고치기` (the stored preset's
//   `presets.set{refreshCards}`); the default-rule line, the pool guidance (the session's facts when opened from one,
//   else the candidates') and the pool's repair history. No stale-catalog hint: the as-of date and the refresh suffice.
// Draft edits are saved by the editor's `저장` (`presets.set`, never a main model or effort, PG4). The ★, a lighter pair
// and a copy are group writes made at once (`presets.defaults.set`, `presets.set` of a new preset in another group).
// No model name, window or level list is written here: everything comes from the catalog and `presets.list` (07 §3.5).
import { Model } from "@opencode/schema/model"
import { Preset } from "@own/protocol/preset"
import { Struct } from "effect"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { Dialog, Segmented, Tag, TextField, createStatus, StatusLine } from "@/limits/kit"
import { catalog, variantName } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import {
  catalogOf,
  copyInput,
  defaultItems,
  draftMode,
  draftOf,
  effortChoices,
  effortLine,
  guidanceOf,
  historyOf,
  lighterChoices,
  lighterRows,
  listedTargets,
  monthDay,
  poolFacts,
  poolHistoryOf,
  presetTabs,
  presetUltraChoice,
  previewCards,
  PRESET_ULTRA_CHOICES,
  readCaps,
  capsFields,
  PER_SESSION_START,
  type CapsFields,
  retirementOf,
  retiringOf,
  samePoolTarget,
  stamp,
  starOf,
  starToggle,
  toSave,
  ultraCapsOf,
  ultraChoice,
  withAddedTarget,
  withDelegation,
  withEffort,
  withMovedTarget,
  withoutPoolEntry,
  withPoolCards,
  withPoolNote,
  withRemovedTarget,
  type LighterRow,
  type PresetDetailProps,
  type PresetUltraChoice,
} from "./model"
import { usePresetEffortText } from "./pe-strings"
import { usePresetFixesText } from "./pf-strings"
import { RoleGuide } from "./role-guide"
import { entryChoices, entryValue, roleRuns, withPoolChoice } from "./roles"
import { cardFacts, defaultLine, entryName, runsBadge } from "./pool-list"
import { capsNumbers, usePresetsText, type PresetsKey } from "./strings"
import { TargetPicker, useTargetText } from "./target-picker"

const ULTRA: Record<Exclude<PresetUltraChoice, "global">, PresetsKey> = {
  save: "own.preset.ultraLevel.save",
  recommended: "own.preset.ultraLevel.recommended",
  large: "own.preset.ultraLevel.large",
  custom: "own.preset.ultraLevel.custom",
}

const EFFORT_MAX: Record<Preset.EffortMax, PresetsKey> = {
  max: "own.preset.detail.effortMax.max",
  xhigh: "own.preset.detail.effortMax.xhigh",
  high: "own.preset.detail.effortMax.high",
  off: "own.preset.detail.effortMax.off",
}

const SKIP: Record<Preset.Skip, PresetsKey> = {
  unavailable: "own.preset.editor.unavailable",
  r4: "own.preset.editor.blocked",
  "lighter-unknown": "own.preset.editor.lighterUnknown",
  "lighter-missing": "own.preset.editor.lighterMissing",
}

/** The caps always typed as a number; the conversation cap is off (`제한 없음`) until the user turns it on. */
const NUMBERED = ["concurrent", "perMessage"] as const

const CAP: Record<Preset.Cap, PresetsKey> = {
  concurrent: "own.preset.caps.concurrent",
  perMessage: "own.preset.caps.perMessage",
  perSession: "own.preset.caps.perSession",
}

type Typed = Partial<CapsFields>

export default function PresetDetails(props: PresetDetailProps) {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const names = useTargetText()
  const runtime = data.local()
  const own = runtime.own
  const status = createStatus()
  const group = () => props.draft.group
  const view = () => own.state.presetGroups[group()]
  const models = () => catalog(runtime)
  const groupWritable = () => own.rpc.allowed("presets.defaults.set")
  const [adding, setAdding] = createSignal<Preset.Role>()
  // A field left invalid when the panel closes is dropped with it; the draft keeps its last valid value.
  onCleanup(() => {
    props.block("caps", false)
    props.block("ultraCaps", false)
  })

  const providerOf = (account: string) =>
    Preset.isLocal(account) ? account.slice("local:".length) : own.state.accounts[account]?.providerID
  /** A pinned model's levels in the catalog; `undefined` for a relative target or a model the catalog lacks. */
  const levelsOf = (target: Preset.Target) => {
    if (!("pin" in target)) return undefined
    const providerID = providerOf(target.pin.account)
    return models()
      .find((model) => model.providerID === providerID && model.id === target.pin.model)
      ?.variants.map((variant) => variant.id)
  }
  /** A target by its model alone (`GPT-6 Luna`), or the relative target's name. */
  const modelOf = (target: Preset.Target) =>
    "pin" in target ? names.model(providerOf(target.pin.account), target.pin.model) : names.target(target)
  const placeName = (place: Preset.Place) => (place === "single" ? text("own.preset.place.single") : names.role(place))
  const fixes = usePresetFixesText()
  const pe = usePresetEffortText()
  /** The preset's own `강도 고정`, which wins over every role's and entry's effort without one of its own. */
  const presetFixed = () => Preset.forcedEffortOf(props.draft.forcedEffort)
  /**
   * Why a model offers no effort: a `compat` account's model (a local model, `기타 OpenAI 호환`) takes the levels its
   * reasoning setting gives (02 §3.3a), so the line says where to set them; any other model has none.
   */
  const noLevels = (account: string | undefined) => {
    const owner = own.state.accounts[account ?? props.main?.account ?? ""]
    return pe(owner?.kind === "compat" ? "own.pe.noLevelsCompat" : "own.pe.noLevels")
  }
  /** What a forced level runs at on a model with these levels (07 §2.3 강도 고정): a line when it is not the level. */
  const fitted = (
    level: Preset.ForcedEffort | undefined,
    variants: ReadonlyArray<string> | undefined,
    meta?: Preset.Main["meta"],
  ) => {
    if (!level || variants === undefined) return undefined
    const fit = Preset.forcedFit(level, variants, meta)
    if (fit.unplaced) return fixes("own.pf.noLevels")
    if (!fit.clamped) return undefined
    return fixes("own.pf.clamped", { level, sent: variantName(i18n, fit.variant ?? "default") })
  }
  const effortName = (value: Preset.Effort) =>
    value === "inherit" ? text("own.preset.effort.inherit") : variantName(i18n, value)
  const capsText = (caps: Preset.Caps) => capsNumbers(text, caps)
  const pooled = () => draftMode(props.draft) === "pool"
  /** A model pool's facts for the previews: the session's (`Resolution.pool`), else the candidates' (07 §3.3, D8). */
  const facts = createMemo(() => {
    const main = props.main
    if (!pooled() || !main) return undefined
    return poolFacts({
      pool: props.draft.workers.pool ?? [],
      candidates: props.offer?.candidates ?? [],
      session: props.facts,
      main,
    })
  })
  const cards = createMemo(() =>
    previewCards({
      workers: props.draft.workers,
      main: props.main,
      resolution: props.resolution,
      accounts: own.state.accounts,
      models: models(),
    }),
  )
  const poolGuidance = createMemo(() => {
    const pool = facts()
    return pool?.entries.length ? Preset.poolGuidance(pool.entries, pool.main) : undefined
  })
  /** What this preset adds with ultra off, by the service's renderer and its card rule (07 §3.3). */
  const guidance = createMemo(() => guidanceOf(props.draft, cards(), poolGuidance()))
  /** Each subagent role under this draft (07 §2.4): what it may do, whether the main is told, where it runs now. */
  const runs = createMemo(() => {
    const pool = poolGuidance()
    return roleRuns({
      preset: props.draft,
      main: props.main,
      resolution: props.resolution,
      catalog: catalogOf(own.state.accounts, models()),
      named: Preset.namedRoles({
        delegation: props.draft.delegation,
        ultra: false,
        cards: cards(),
        ...(pool ? { pool } : {}),
      }),
      ...(pool ? { defaults: pool.defaults } : {}),
    })
  })

  return (
    <section class="flex flex-col gap-3.5 border-t border-own-border pt-3" data-testid="preset-detail">
      <Show when={pooled()}>
        <PoolEntries />
      </Show>
      <Show when={draftMode(props.draft) === "by-role"}>
        <fieldset class="own-pe-q" data-testid="preset-detail-effort">
          <legend>{text("own.preset.detail.effort")}</legend>
          <p class="own-pe-hint m-0" data-testid="preset-detail-effort-hint">
            {pe("own.pe.rolesHint")}
          </p>
          <For each={props.roles}>{(role) => <EffortRow role={role} />}</For>
        </fieldset>
        <fieldset class="own-pe-q" data-testid="preset-detail-targets">
          <legend>{text("own.preset.detail.targets")}</legend>
          <For each={props.roles}>{(role) => <OrderRow role={role} />}</For>
        </fieldset>
      </Show>

      <fieldset class="own-pe-q" data-testid="preset-detail-roles">
        <legend>{pe("own.pe.roles")}</legend>
        <RoleGuide runs={runs()} off={props.draft.delegation === "off"} />
      </fieldset>

      <fieldset class="own-pe-q" data-testid="preset-detail-delegation">
        <legend>{text("own.preset.editor.q2")}</legend>
        <label class="own-pe-choice">
          <input
            type="checkbox"
            checked={props.draft.delegation === "off"}
            data-testid="preset-detail-off"
            onChange={(event) =>
              props.update(withDelegation(props.draft, event.currentTarget.checked ? "off" : "model"))
            }
          />
          <span class="min-w-[90px]">{text("own.preset.delegation.off")}</span>
          <span class="own-pe-hint">{text("own.preset.delegation.hint.off")}</span>
        </label>
      </fieldset>

      <CapsFields />
      <UltraFields />
      <ForcedEffortFields />
      <EffortMaxFields />

      <fieldset class="own-pe-q" data-testid="preset-detail-guidance">
        <legend>{text("own.preset.detail.guidance")}</legend>
        <Show when={guidance()} fallback={<p class="own-pe-hint m-0">{text("own.preset.detail.guidanceNone")}</p>}>
          {(value) => (
            <pre
              class="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-own-subtle px-2.5 py-2 font-mono text-[11.5px] leading-[17px] text-own-muted"
              data-testid="preset-detail-guidance-text"
            >
              {value().text}
            </pre>
          )}
        </Show>
      </fieldset>

      <LighterTable />
      <GroupActions />
      <History />

      <StatusLine status={status} testid="preset-detail-status" />

      <Show when={adding()}>
        {(role) => (
          <TargetPicker
            group={group()}
            place={role()}
            draft={props.draft}
            main={props.main}
            lighter={props.lighter}
            local={props.local}
            onPick={(target) => props.update(withAddedTarget(props.draft, role(), target))}
            onClose={() => setAdding(undefined)}
          />
        )}
      </Show>
    </section>
  )

  /**
   * The model pool (07 §7.2 모델 묶음): each entry, the default-rule line, and `카드 새로 고치기` for a stored pool (it
   * freezes the stored preset's cards again; the draft's entries of the same key and target take them).
   */
  function PoolEntries() {
    const keys = () => (props.draft.workers.pool ?? []).map((entry) => entry.key)
    const stored = () => view()?.presets?.find((item) => item.id === props.draft.id && !Preset.isBuiltin(item.id))
    const [refreshing, setRefreshing] = createSignal(false)
    const refresh = async () => {
      const preset = stored()
      if (!preset || refreshing()) return
      setRefreshing(true)
      status.clear()
      await own.rpc
        .call("presets.set", { preset: toSave(draftOf(preset.group, preset)), refreshCards: true })
        .then(async (output) => {
          props.update(withPoolCards(props.draft, output.preset.workers.pool ?? []))
          await own.refreshPresets()
          status.ok(text("own.preset.pool.cardsRefreshed"))
        })
        .catch((error: unknown) => status.error(props.errorText(error)))
      setRefreshing(false)
    }
    const defaults = () => {
      const pool = facts()
      return pool?.entries.length ? defaultItems(Preset.poolGuidance(pool.entries, pool.main).defaults) : undefined
    }
    const keyName = (key: string) =>
      entryName(
        props.draft.workers.pool?.find((entry) => entry.key === key),
        key,
      )
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-pool">
        <legend>{text("own.preset.pool.title")}</legend>
        <Show when={keys().length} fallback={<p class="own-pe-hint m-0">{text("own.preset.pool.empty")}</p>}>
          <For each={keys()}>{(key) => <PoolEntryRow entryKey={key} />}</For>
        </Show>
        <Show when={defaults()}>
          {(items) => (
            <p class="own-pe-sub m-0 pt-1" data-testid="preset-detail-pool-defaults">
              {defaultLine(text, names.role, items(), keyName)}
            </p>
          )}
        </Show>
        <Show when={stored()?.workers.pool?.length}>
          <div class="pt-2">
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              disabled={refreshing() || !own.rpc.allowed("presets.set")}
              data-testid="preset-detail-refresh-cards"
              onClick={() => void refresh()}
            >
              {text("own.preset.pool.refreshCards")}
            </button>
          </div>
        </Show>
      </fieldset>
    )
  }

  /**
   * One pool entry (07 §7.2): its card in Korean with the date it was frozen, its effort (the model's own levels, the
   * whole scale while unknown) and what it sends for the main now, its note (at most `Preset.NOTE_MAX` characters) and
   * `빼기`. Keyed by the entry's key, so typing a note keeps the field.
   */
  function PoolEntryRow(rowProps: { readonly entryKey: string }) {
    const key = rowProps.entryKey
    const entry = () => props.draft.workers.pool?.find((item) => item.key === key)
    const focused = props.focusRole === Preset.poolSpot(key)
    let element: HTMLDivElement | undefined
    onMount(() => {
      if (focused) element?.scrollIntoView({ block: "nearest" })
    })
    const side = () => {
      const current = entry()
      return (
        facts()?.entries.find((item) => item.key === key)?.side ??
        props.offer?.candidates.find((candidate) => current !== undefined && samePoolTarget(candidate, current))
      )
    }
    const levels = () => {
      const current = entry()
      const providerID = current?.account === undefined ? props.main?.ref.providerID : providerOf(current.account)
      return models()
        .find((model) => model.providerID === providerID && model.id === current?.model)
        ?.variants.map((variant) => variant.id)
    }
    const effort = () => entry()?.effort ?? "inherit"
    const forced = () => Preset.forcedEffortOf(entry()?.forcedEffort)
    /** What the one `추론 강도` choice means now: its own fixed level, the preset's, or an effort the call may change. */
    const effortHint = () => {
      const fixed = forced()
      if (fixed) return pe("own.pe.fixedHint", { level: variantName(i18n, fixed) })
      const preset = presetFixed()
      if (preset) return pe("own.pe.presetFixed", { level: variantName(i18n, preset) })
      return pe("own.pe.flexibleHint")
    }
    const sends = () => {
      const main = props.main
      const resolved = props.resolution?.pool?.entries.find((item) => item.key === key)
      const line = main && resolved && effortLine(effort(), main, { targets: [resolved] })
      if (!line) return undefined
      const intent = variantName(i18n, line.intent)
      return line.unplaced
        ? text("own.preset.detail.sendsDefault", { intent })
        : text("own.preset.detail.sendsAs", { intent, level: variantName(i18n, line.level) })
    }
    const about = () => {
      const current = entry()
      const badge = runsBadge(side()?.runs, current?.account ? own.state.accounts[current.account]?.billing : undefined)
      const at = current?.card?.at
      return [
        ...(badge ? [text(badge)] : []),
        ...cardFacts(text, current?.card, side()?.runs === "local"),
        ...(at === undefined
          ? []
          : [text("own.preset.pool.cardAt", { date: `${new Date(at).getFullYear()}-${monthDay(at)}` })]),
      ].join(" · ")
    }
    return (
      <div
        ref={element}
        class="own-pe-role"
        classList={{ "rounded-md bg-own-accent-soft px-1.5": focused }}
        data-key={key}
        data-focus={focused ? "" : undefined}
        data-testid="preset-detail-pool-entry"
      >
        <span class="own-pe-role-name break-all">{key}</span>
        <div class="own-pe-role-body">
          <span>
            <b class="font-semibold">{entryName(entry(), key)}</b>
            <Retirement at={entry() ? view()?.retirements?.[entry()!.model] : undefined} />
          </span>
          <span class="own-pe-sub" data-testid="preset-detail-pool-card">
            {about()}
          </span>
          <Show
            when={entryChoices(levels(), forced())}
            fallback={
              <span class="own-pe-sub" data-testid="preset-detail-pool-no-levels">
                {noLevels(entry()?.account)}
              </span>
            }
          >
            {(choices) => (
              <label class="flex flex-col gap-0.5">
                <span class="text-[12px] text-own-muted">{pe("own.pe.effort")}</span>
                <select
                  class="own-input max-w-[260px]"
                  aria-label={`${key} · ${pe("own.pe.effort")}`}
                  data-testid="preset-detail-pool-effort"
                  onChange={(event) => props.update(withPoolChoice(props.draft, key, event.currentTarget.value))}
                >
                  <optgroup label={pe("own.pe.flexible")}>
                    <For each={choices().efforts}>
                      {(choice) => (
                        <option
                          value={choice.value}
                          disabled={!choice.available}
                          selected={choice.value === entryValue(entry())}
                        >
                          {effortName(choice.value)}
                        </option>
                      )}
                    </For>
                  </optgroup>
                  <optgroup label={pe("own.pe.fixed")}>
                    <For each={choices().fixed}>
                      {(choice) => (
                        <option
                          value={choice.value}
                          disabled={!choice.available}
                          selected={choice.value === entryValue(entry())}
                        >
                          {pe("own.pe.fixedLevel", { level: variantName(i18n, choice.level) })}
                        </option>
                      )}
                    </For>
                  </optgroup>
                </select>
              </label>
            )}
          </Show>
          <span class="own-pe-sub" data-testid="preset-detail-pool-effort-hint">
            {effortHint()}
          </span>
          <Show when={!forced() && !presetFixed() && sends()}>
            <span class="own-pe-sub" data-testid="preset-detail-sends">
              {sends()}
            </span>
          </Show>
          <Show when={fitted(forced() ?? presetFixed(), levels())}>
            {(line) => (
              <span class="own-pe-sub" data-testid="preset-detail-pool-force-clamped">
                {line()}
              </span>
            )}
          </Show>
          <TextField
            label={text("own.preset.pool.note")}
            value={entry()?.note ?? ""}
            onValue={(note) => props.update(withPoolNote(props.draft, key, note))}
            maxLength={Preset.NOTE_MAX}
            testid="preset-detail-pool-note"
          />
        </div>
        <div class="own-pe-role-actions">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="ghost"
            data-testid="preset-detail-pool-remove"
            onClick={() => props.update(withoutPoolEntry(props.draft, key))}
          >
            {text("own.preset.editor.removeRole")}
          </button>
        </div>
      </div>
    )
  }

  /** A role's effort (07 §2.3): the choices of its first target, and what it sends for the main now. */
  function EffortRow(rowProps: { readonly role: Preset.Role }) {
    const role = rowProps.role
    const effort = () => props.draft.workers.roles[role]?.effort ?? "inherit"
    const choices = createMemo(() => {
      const first = listedTargets(props.draft.workers.roles[role])[0]
      return effortChoices(first, first && levelsOf(first))
    })
    const pinnedAccount = () => {
      const first = listedTargets(props.draft.workers.roles[role])[0]
      return first && "pin" in first ? first.pin.account : undefined
    }
    const sends = () => {
      const main = props.main
      const line = main && effortLine(effort(), main, props.resolution?.roles[role])
      if (!line) return undefined
      const intent = variantName(i18n, line.intent)
      return line.unplaced
        ? text("own.preset.detail.sendsDefault", { intent })
        : text("own.preset.detail.sendsAs", { intent, level: variantName(i18n, line.level) })
    }
    return (
      <div class="own-pe-role" data-role={role} data-testid="preset-detail-effort-row">
        <span class="own-pe-role-name">{names.role(role)}</span>
        <div class="own-pe-role-body">
          <Show
            when={choices()}
            fallback={
              <span class="own-pe-sub" data-testid="preset-detail-effort-no-levels">
                {noLevels(pinnedAccount())}
              </span>
            }
          >
            {(list) => (
              <select
                class="own-input max-w-[220px]"
                aria-label={`${names.role(role)} · ${text("own.preset.detail.effort")}`}
                data-testid="preset-detail-effort-select"
                onChange={(event) => {
                  const picked = list().find((choice) => choice.value === event.currentTarget.value)
                  if (picked) props.update(withEffort(props.draft, role, picked.value))
                }}
              >
                <For each={list()}>
                  {(choice) => (
                    <option value={choice.value} disabled={!choice.available} selected={choice.value === effort()}>
                      {effortName(choice.value)}
                    </option>
                  )}
                </For>
              </select>
            )}
          </Show>
          <Show
            when={presetFixed()}
            fallback={
              <Show when={sends()}>
                <span class="own-pe-sub" data-testid="preset-detail-sends">
                  {sends()}
                </span>
              </Show>
            }
          >
            {(level) => (
              <span class="own-pe-sub" data-testid="preset-detail-effort-fixed">
                {pe("own.pe.presetFixed", { level: variantName(i18n, level()) })}
              </span>
            )}
          </Show>
        </div>
      </div>
    )
  }

  /** A role's targets in order, ending in `메인과 같게` (07 §1.2); the focused role (`focusRole`) scrolls into view. */
  function OrderRow(rowProps: { readonly role: Preset.Role }) {
    const role = rowProps.role
    const targets = () => listedTargets(props.draft.workers.roles[role])
    const focused = props.focusRole === role
    let element: HTMLDivElement | undefined
    onMount(() => {
      if (focused) element?.scrollIntoView({ block: "nearest" })
    })
    return (
      <div
        ref={element}
        class="own-pe-role"
        classList={{ "rounded-md bg-own-accent-soft px-1.5": focused }}
        data-role={role}
        data-focus={focused ? "" : undefined}
        data-testid="preset-detail-order"
      >
        <span class="own-pe-role-name">{names.role(role)}</span>
        <ol class="own-pe-role-body m-0 list-none p-0">
          <For each={targets()}>
            {(target, index) => <TargetItem role={role} target={target} index={index()} last={targets().length - 1} />}
          </For>
          <li class="own-pe-sub">
            {targets().length ? text("own.preset.editor.lastMain") : text("own.preset.target.main")}
          </li>
        </ol>
        <div class="own-pe-role-actions">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="preset-detail-add-target"
            onClick={() => setAdding(role)}
          >
            {text("own.preset.detail.addTarget")}
          </button>
        </div>
      </div>
    )
  }

  function TargetItem(itemProps: {
    readonly role: Preset.Role
    readonly target: Preset.Target
    readonly index: number
    readonly last: number
  }) {
    const resolved = () => props.resolution?.roles[itemProps.role]?.targets[itemProps.index]
    const label = () =>
      "pin" in itemProps.target
        ? text("own.preset.editor.pinned", { label: names.target(itemProps.target) })
        : names.target(itemProps.target)
    const move = (by: -1 | 1) => props.update(withMovedTarget(props.draft, itemProps.role, itemProps.index, by))
    return (
      <li class="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="preset-detail-target">
        <span>
          {text("own.preset.editor.rank", { n: itemProps.index + 1 })} {label()}
        </span>
        <Show when={resolved()?.skip}>{(skip) => <span class="own-pe-sub">{text(SKIP[skip()])}</span>}</Show>
        <Retirement at={retirementOf(view(), itemProps.target)} />
        <span class="ml-auto flex gap-1">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="ghost"
            aria-label={text("own.preset.detail.moveUp")}
            title={text("own.preset.detail.moveUp")}
            disabled={itemProps.index === 0}
            data-testid="preset-detail-up"
            onClick={() => move(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="ghost"
            aria-label={text("own.preset.detail.moveDown")}
            title={text("own.preset.detail.moveDown")}
            disabled={itemProps.index === itemProps.last}
            data-testid="preset-detail-down"
            onClick={() => move(1)}
          >
            ↓
          </button>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-variant="ghost"
            aria-label={text("own.preset.detail.removeTarget")}
            title={text("own.preset.detail.removeTarget")}
            data-testid="preset-detail-remove"
            onClick={() => props.update(withRemovedTarget(props.draft, itemProps.role, itemProps.index))}
          >
            ✕
          </button>
        </span>
      </li>
    )
  }

  /** A Codex retirement date, dimmed (07 §4.3): no notice, no successor, nothing changes by it (U3). */
  function Retirement(dateProps: { readonly at: number | undefined }) {
    return (
      <Show when={dateProps.at}>
        {(at) => (
          <span class="text-[12px] text-own-faint" data-testid="preset-retirement">
            {text("own.preset.retirement", { date: monthDay(at()) })}
          </span>
        )}
      </Show>
    )
  }

  /**
   * Whole numbers, each at least 1; at once and per message never above per conversation (07 §2.6). The conversation
   * cap is `제한 없음` until `대화당 상한 두기` turns it on.
   */
  function NumberFields(fieldsProps: {
    readonly values: () => Preset.Caps
    readonly field: string
    readonly testid: string
    readonly onCaps: (caps: Preset.Caps) => void
  }) {
    // Text typed since the last valid caps; the other fields show the values in force.
    const [typed, setTyped] = createSignal<Typed>({})
    const fields = (entered: Typed): CapsFields => ({ ...capsFields(fieldsProps.values()), ...entered })
    const problem = () => {
      const read = readCaps(fields(typed()))
      return typeof read === "string" ? read : undefined
    }
    const total = () => fields(typed()).perSession
    const edit = (cap: Preset.Cap, value: string | null) => {
      const next = { ...typed(), [cap]: value }
      const read = readCaps(fields(next))
      props.block(fieldsProps.field, typeof read === "string")
      if (typeof read === "string") return setTyped(next)
      setTyped({})
      fieldsProps.onCaps(read)
    }
    return (
      <>
        <div class="own-pp-form" data-testid={fieldsProps.testid}>
          <For each={NUMBERED}>
            {(cap) => (
              <TextField
                label={text(CAP[cap], { n: "N" })}
                value={fields(typed())[cap]}
                onValue={(value) => edit(cap, value)}
                inputMode="numeric"
                testid={`${fieldsProps.testid}-${cap}`}
              />
            )}
          </For>
          <Show when={total() !== null}>
            <TextField
              label={text(CAP.perSession, { n: "N" })}
              value={total() ?? ""}
              onValue={(value) => edit("perSession", value)}
              inputMode="numeric"
              testid={`${fieldsProps.testid}-perSession`}
            />
          </Show>
        </div>
        <label class="own-pe-choice">
          <input
            type="checkbox"
            checked={total() !== null}
            data-testid={`${fieldsProps.testid}-perSession-on`}
            onChange={(event) => edit("perSession", event.currentTarget.checked ? PER_SESSION_START : null)}
          />
          <span>{text("own.preset.caps.perSessionOn")}</span>
          <Show when={total() === null}>
            <span class="own-pe-hint">{text("own.preset.caps.perSessionNone")}</span>
          </Show>
        </label>
        <Show when={problem()}>
          {(code) => (
            <span class="text-[12px] text-own-danger" role="alert" data-testid={`${fieldsProps.testid}-error`}>
              {code() === "order" ? text("own.preset.detail.capsInvalid") : text("own.preset.ultraInvalid")}
            </span>
          )}
        </Show>
      </>
    )
  }

  /** `안전 상한` (07 §2.6): the caps in force without ultra, written as three numbers once edited. */
  function CapsFields() {
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-caps">
        <legend>{text("own.preset.caps.title")}</legend>
        <NumberFields
          values={() => Preset.caps(props.draft, false)}
          field="caps"
          testid="preset-detail-caps-fields"
          onCaps={(caps) => props.update({ ...props.draft, caps })}
        />
      </fieldset>
    )
  }

  /** `이 프리셋의 울트라 상한` (07 §2.6): the settings page's level (`null`), a level, or the preset's own numbers. */
  function UltraFields() {
    const global = () => own.state.presetSettings.ultraCaps
    const choice = () => presetUltraChoice(props.draft.ultraCaps)
    const numbers = () => Preset.levelCaps(props.draft.ultraCaps ?? global())
    const label = (item: PresetUltraChoice) =>
      item === "global"
        ? text("own.preset.detail.ultraCapsGlobal", { level: text(ULTRA[ultraChoice(global())]) })
        : text(ULTRA[item])
    const pick = (item: PresetUltraChoice) => {
      props.block("ultraCaps", false)
      props.update({ ...props.draft, ultraCaps: ultraCapsOf(item, numbers()) })
    }
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-ultra">
        <legend>{text("own.preset.detail.ultraCaps")}</legend>
        <div class="flex flex-col gap-2">
          <Segmented
            label={text("own.preset.detail.ultraCaps")}
            value={choice()}
            options={PRESET_ULTRA_CHOICES.map((item) => ({ value: item, label: label(item) }))}
            onChange={pick}
            testid="preset-detail-ultra-level"
          />
          <Show
            when={choice() === "custom"}
            fallback={<span class="text-[12.5px] text-own-muted">{capsText(numbers())}</span>}
          >
            <NumberFields
              values={numbers}
              field="ultraCaps"
              testid="preset-detail-ultra-fields"
              onCaps={(caps) => props.update({ ...props.draft, ultraCaps: caps })}
            />
          </Show>
          <span class="text-[12px] text-own-muted">{text("own.preset.ultraCount", { n: numbers().concurrent })}</span>
          <Show when={ultraChoice(props.draft.ultraCaps ?? global()) === "large"}>
            <span class="text-[12px] text-own-warn" data-testid="preset-detail-ultra-large">
              {text("own.preset.ultraLargeWarn")}
            </span>
          </Show>
        </div>
      </fieldset>
    )
  }

  /**
   * `강도 고정` (07 §2.3 강도 고정, PF 2026-11-03): the level the conversation's main and every subagent of this preset
   * run at, fitted to each model; unset by default. The line under it says what the preview's main runs it at.
   */
  function ForcedEffortFields() {
    const level = () => Preset.forcedEffortOf(props.draft.forcedEffort)
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-force">
        <legend>{fixes("own.pf.force")}</legend>
        <div class="flex flex-col gap-2">
          <select
            class="own-input max-w-[220px]"
            aria-label={fixes("own.pf.force")}
            data-testid="preset-detail-force-level"
            onChange={(event) => {
              const picked = Preset.forcedEffortOf(event.currentTarget.value)
              props.update(
                picked ? { ...props.draft, forcedEffort: picked } : Struct.omit(props.draft, ["forcedEffort"]),
              )
            }}
          >
            <option value="" selected={!level()}>
              {fixes("own.pf.forceOff")}
            </option>
            <For each={Preset.ForcedEffort.literals}>
              {(item) => (
                <option value={item} selected={item === level()}>
                  {variantName(i18n, item)}
                </option>
              )}
            </For>
          </select>
          <Show when={fitted(level(), props.main?.variants, props.main?.meta)}>
            {(line) => (
              <span class="own-pe-sub" data-testid="preset-detail-force-clamped">
                {line()}
              </span>
            )}
          </Show>
          <span class="text-[12px] text-own-muted">{fixes("own.pf.forceHint")}</span>
        </div>
      </fieldset>
    )
  }

  /**
   * `대화에서 하위 에이전트 강도 올리기` (07 §2.3): how far a conversation may raise one subagent's effort above the
   * preset's. `max` is stored as absent; lowering always works and a paid target is never raised (the gate's rule).
   */
  function EffortMaxFields() {
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-effort-max">
        <legend>{text("own.preset.detail.effortMax")}</legend>
        <div class="flex flex-col gap-2">
          <Segmented
            label={text("own.preset.detail.effortMax")}
            value={Preset.effortMaxOf(props.draft)}
            options={Preset.EffortMax.literals.map((item) => ({ value: item, label: text(EFFORT_MAX[item]) }))}
            onChange={(item) => props.update({ ...props.draft, subagentEffortMax: item })}
            testid="preset-detail-effort-max-level"
          />
          <span class="text-[12px] text-own-muted">{text("own.preset.detail.effortMaxHint")}</span>
        </div>
      </fieldset>
    )
  }

  /**
   * The group's lighter pairs (07 §4.2): `GPT-6 Astra → GPT-6 Luna · 자동 [짝 바꾸기]`, `없어짐` for a gone pair. A pair
   * is the group's (every preset and account of it), so `짝 바꾸기` writes `presets.defaults.set{lighter}` at once.
   */
  function LighterTable() {
    const providerID = () => props.main?.ref.providerID
    const rows = () => lighterRows(view()?.lighter, props.main?.ref.id)
    const [editing, setEditing] = createSignal<string>()
    const [choice, setChoice] = createSignal("")
    const [busy, setBusy] = createSignal(false)
    const choices = () => {
      const provider = providerID()
      const main = editing()
      return provider && main ? lighterChoices(models(), provider, main) : []
    }
    const start = (row: LighterRow) => {
      setEditing(row.main)
      const options = choices()
      setChoice(options.find((model) => model.id === row.pair?.model)?.id ?? options[0]?.id ?? "")
    }
    const save = async (mainModelID: string) => {
      if (!choice() || busy()) return
      setBusy(true)
      status.clear()
      await own.rpc
        .call("presets.defaults.set", {
          group: group(),
          lighter: { mainModelID: Model.ID.make(mainModelID), model: Model.ID.make(choice()) },
        })
        .then(async () => {
          await own.refreshPresets()
          setEditing(undefined)
        })
        .catch((error: unknown) => status.error(props.errorText(error)))
      setBusy(false)
    }
    const pairName = (row: LighterRow) =>
      row.pair ? names.model(providerID(), row.pair.model) : text("own.preset.editor.lighterUnknown")
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-lighter">
        <legend>{text("own.preset.detail.lighter")}</legend>
        <Show when={rows().length} fallback={<p class="own-pe-hint m-0">{text("own.preset.detail.lighterEmpty")}</p>}>
          <For each={rows()}>
            {(row) => (
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1 py-1" data-testid="preset-detail-lighter-row">
                <span>
                  {text("own.preset.detail.lighterRow", {
                    main: names.model(providerID(), row.main),
                    model: pairName(row),
                  })}
                </span>
                <Show when={row.pair}>
                  {(pair) => (
                    <span class="own-pe-sub">
                      · {text(`own.preset.detail.lighterSource.${pair().source ?? "auto"}`)}
                    </span>
                  )}
                </Show>
                <Show when={row.pair?.missing}>
                  <Tag tone="warn" testid="preset-detail-lighter-gone">
                    {text("own.preset.detail.lighterGone")}
                  </Tag>
                </Show>
                <Retirement at={row.pair ? view()?.retirements?.[row.pair.model] : undefined} />
                <Show
                  when={editing() === row.main}
                  fallback={
                    <button
                      type="button"
                      class="own-btn ml-auto"
                      data-size="sm"
                      disabled={!groupWritable() || !providerID()}
                      data-testid="preset-detail-lighter-change"
                      onClick={() => start(row)}
                    >
                      {text("own.preset.detail.lighterChange")}
                    </button>
                  }
                >
                  <div class="own-pp-form w-full">
                    <select
                      class="own-input max-w-[260px]"
                      aria-label={text("own.preset.detail.lighterChange")}
                      data-testid="preset-detail-lighter-select"
                      onChange={(event) => setChoice(event.currentTarget.value)}
                    >
                      <For each={choices()}>
                        {(model) => (
                          <option value={model.id} selected={model.id === choice()}>
                            {model.name}
                          </option>
                        )}
                      </For>
                    </select>
                    <button type="button" class="own-btn" data-size="sm" onClick={() => setEditing(undefined)}>
                      {i18n.t("own.kit.cancel")}
                    </button>
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      data-variant="primary"
                      disabled={!choice() || busy()}
                      data-testid="preset-detail-lighter-save"
                      onClick={() => void save(row.main)}
                    >
                      {i18n.t("own.kit.save")}
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </fieldset>
    )
  }

  /** `★ 이 묶음에서 먼저 쓰기` (a saved preset) and `다른 묶음에 복사…` (07 §7.2). */
  function GroupActions() {
    const star = () => starOf(group(), view())
    const starred = () => props.draft.id !== undefined && star() === props.draft.id
    const toggle = async () => {
      const id = props.draft.id
      if (!id) return
      status.clear()
      await own.rpc
        .call("presets.defaults.set", { group: group(), star: starToggle(group(), id, star()) })
        .then(() => own.refreshPresets())
        .catch((error: unknown) => status.error(props.errorText(error)))
    }
    const [copying, setCopying] = createSignal(false)
    return (
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="preset-detail-group">
        <Show when={props.draft.id}>
          <label class="own-pe-choice">
            <input
              type="checkbox"
              checked={starred()}
              disabled={!groupWritable()}
              data-testid="preset-detail-star"
              onChange={() => void toggle()}
            />
            <span>{text("own.preset.star")}</span>
          </label>
        </Show>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          disabled={!own.rpc.allowed("presets.set")}
          data-testid="preset-detail-copy"
          onClick={() => setCopying(true)}
        >
          {text("own.preset.copyToGroup")}
        </button>
        <Show when={copying()}>
          <CopyDialog onClose={() => setCopying(false)} />
        </Show>
      </div>
    )
  }

  /**
   * `다른 묶음에 복사…`: the draft as a new preset of another group with an account (`presets.set` without `id`). The
   * service judges R4 for that group; a breach is shown with the account it names and stores nothing.
   */
  function CopyDialog(dialogProps: { readonly onClose: () => void }) {
    const copyStatus = createStatus()
    const accounts = () =>
      own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
    const groups = createMemo(() => presetTabs(accounts(), models()).filter((item) => item !== group()))
    const [picked, setPicked] = createSignal<Preset.Group>()
    const destination = () => {
      const chosen = picked()
      return chosen && groups().includes(chosen) ? chosen : groups()[0]
    }
    const [busy, setBusy] = createSignal(false)
    const copy = async () => {
      const to = destination()
      if (!to || busy()) return
      if (!props.draft.name.trim()) return copyStatus.error(text("own.preset.err.nameRequired"))
      setBusy(true)
      copyStatus.clear()
      await own.rpc
        .call("presets.set", { preset: copyInput(props.draft, to) })
        .then(async () => {
          await own.refreshPresets()
          dialogProps.onClose()
          showToast({ message: text("own.preset.copyToGroup.done", { group: names.group(to) }) })
        })
        .catch((error: unknown) => copyStatus.error(props.errorText(error)))
      setBusy(false)
    }
    return (
      <Dialog
        open
        title={text("own.preset.copyToGroup.title", { name: props.draft.name.trim() || "—" })}
        onClose={dialogProps.onClose}
        dismissable
        testid="preset-copy-dialog"
        footer={
          <>
            <StatusLine status={copyStatus} testid="preset-copy-status" />
            <button type="button" class="own-btn" onClick={() => dialogProps.onClose()}>
              {i18n.t("own.kit.cancel")}
            </button>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={busy() || !destination()}
              data-testid="preset-copy-confirm"
              onClick={() => void copy()}
            >
              {text("own.preset.copy")}
            </button>
          </>
        }
      >
        <Show when={groups().length} fallback={<p class="m-0 text-[13px]">{text("own.preset.copyToGroup.none")}</p>}>
          <label class="own-field">
            <span class="own-field-label">{text("own.preset.copyToGroup.target")}</span>
            <select
              class="own-input"
              data-testid="preset-copy-group"
              onChange={(event) => setPicked(groups().find((item) => item === event.currentTarget.value))}
            >
              <For each={groups()}>
                {(item) => (
                  <option value={item} selected={item === destination()}>
                    {names.group(item)}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
      </Dialog>
    )
  }

  /**
   * 수리 기록 (07 §7.2 `10-14 09:00 리뷰: GPT-5.5 없어짐 → GPT-5.6 Sol로 고침`), newest first, then the pinned models
   * with a Codex retirement date, dimmed (07 §4.3): shown here and beside the target, never announced.
   */
  function History() {
    const records = () => historyOf(view(), props.draft.id)
    const pooledRecords = () => poolHistoryOf(view(), props.draft.id)
    const retiring = () => retiringOf(view(), props.draft)
    return (
      <fieldset class="own-pe-q" data-testid="preset-detail-history">
        <legend>{text("own.preset.repair.history")}</legend>
        <Show
          when={records().length || pooledRecords().length || retiring().length}
          fallback={<p class="own-pe-hint m-0">{text("own.preset.repair.historyEmpty")}</p>}
        >
          <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
            <For each={records()}>
              {(record) => (
                <li data-testid="preset-detail-repair">
                  <span class="mr-2 text-own-muted">{stamp(record.at)}</span>
                  {text("own.preset.repair.record", {
                    role: placeName(record.place),
                    from: names.model(undefined, record.from),
                    to: modelOf(record.to),
                  })}
                </li>
              )}
            </For>
            <For each={pooledRecords()}>
              {(record) => (
                <li data-testid="preset-detail-pool-repair">
                  <span class="mr-2 text-own-muted">{stamp(record.at)}</span>
                  {record.to === undefined
                    ? text("own.preset.pool.historyRemoved", {
                        key: record.key,
                        from: names.model(undefined, record.from),
                      })
                    : text("own.preset.pool.historyRecord", {
                        key: record.key,
                        from: names.model(undefined, record.from),
                        to: names.model(undefined, record.to),
                      })}
                </li>
              )}
            </For>
            <For each={retiring()}>
              {(item) => (
                <li class="text-own-faint" data-testid="preset-detail-retiring">
                  {modelOf(item.target)} · {text("own.preset.retirement", { date: monthDay(item.at) })}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </fieldset>
    )
  }
}
