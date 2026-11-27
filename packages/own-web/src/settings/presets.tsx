// Settings > 프리셋 (07 §7.1, §2.2, §2.6, §5.1; 03 §5.7), lazy. Global rows first: `울트라 상한: 추천 [바꾸기]` with
// 아껴서 / 추천 / 크게 / 직접 정하기, and the start preset of new conversations (★ / 마지막에 쓴 것(가벼운 것만)). Then one
// tab per provider group that has an account (`siwc` is its own group with its kind label; a discovered local provider
// too): the group's new-session default model row (T0's `presets.defaults.set{defaultModel}` behaviour, the composer's
// first value stays in switcher/new-session.ts) and its preset list with ★, 새 프리셋…, 편집…, 지우기. Editing opens the
// lazy editor through `openPresetEditor`; this page mounts the editor layer while it is open. Values come from OwnStore
// (`presets.list`); writes are `presets.defaults.set` and `presets.remove`, then a `presets.list` read.
// T2 (07 §4.3): a tab starts with its group's repair lines (presets/repair-notice.tsx, `[고치기]` / `[직접 고르기]`), and
// a gone default model adds `<묶음> 새 대화 기본 모델 <모델>(이)가 없어졌습니다. 새 대화는 <다음>(으)로 시작합니다` under
// its row, whose `[바꾸기]` is the row's own. A gone default's `[바꾸기]` elsewhere opens this page on that tab.
// CA (07 §4.5, 2026-10-19): the ChatGPT tab adds `Codex 최신 모델 자동 확인` (accounts/codex-models-ui.tsx).
import { Model } from "@opencode/schema/model"
import { Preset } from "@own/protocol/preset"
import { createEffect, createMemo, createSignal, For, lazy, onCleanup, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { CodexModelsSetting } from "@/accounts/codex-models-ui"
import { errorMessage, errorType } from "@/accounts/errors"
import { useData } from "@/data"
import type { OwnInput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { Dialog, Notice, Segmented, Tag, TextField, createStatus, StatusLine } from "@/limits/kit"
import {
  defaultLabel,
  groupAccounts,
  groupMain,
  lighterFor,
  mainOf,
  openPresetEditor,
  parseCaps,
  capsFields,
  PER_SESSION_START,
  type CapsFields,
  presetRows,
  presetTabs,
  starOf,
  ULTRA_CHOICES,
  ultraChoice,
  type UltraChoice,
} from "@/presets/model"
import { HiddenModels } from "@/presets/hidden-list"
import { usePresetEffortText } from "@/presets/pe-strings"
import { RoleGuide } from "@/presets/role-guide"
import { presetRuns } from "@/presets/roles"
import { defaultRepair, RepairNotices, takePresetTab } from "@/presets/repair-notice"
import { presetRepairs } from "@/presets/repairs"
import { capsNumbers, usePresetsText, type PresetsKey } from "@/presets/strings"
import { useTargetText } from "@/presets/target-picker"
import { catalog, ensureCatalog, providerModels, variantName } from "@/switcher/labels"
import { clearUltraCapsFocus, ultraCapsFocus } from "./focus"
import "@/presets/presets.css"
import { navTarget } from "./layout"

const PresetEditorLayer = lazy(() => import("@/presets/editor"))

const ULTRA: Record<UltraChoice, PresetsKey> = {
  save: "own.preset.ultraLevel.save",
  recommended: "own.preset.ultraLevel.recommended",
  large: "own.preset.ultraLevel.large",
  custom: "own.preset.ultraLevel.custom",
}

const MODE: Record<Preset.Mode, PresetsKey> = {
  same: "own.preset.workers.same",
  single: "own.preset.workers.single",
  pool: "own.preset.workers.pool",
  "by-role": "own.preset.workers.byRole",
}

const DELEGATION: Record<Preset.Delegation, PresetsKey> = {
  off: "own.preset.delegation.off",
  model: "own.preset.delegation.model",
  "on-request": "own.preset.delegation.onRequest",
  "when-useful": "own.preset.delegation.whenUseful",
  active: "own.preset.delegation.active",
}

export default function PresetSettings() {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const names = useTargetText()
  const pe = usePresetEffortText()
  const runtime = data.local()
  const own = runtime.own
  ensureCatalog(runtime)
  const status = createStatus()
  const accounts = () =>
    own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
  const tabs = createMemo(() => presetTabs(accounts(), catalog(runtime)))
  const [tab, setTab] = createSignal<Preset.Group>()
  createEffect(() => {
    const requested = takePresetTab()
    if (requested) setTab(requested)
  })
  const group = () => {
    const chosen = tab()
    return chosen && tabs().includes(chosen) ? chosen : tabs()[0]
  }
  const writable = () => own.rpc.allowed("presets.defaults.set")

  /** `presets.defaults.set`, then a fresh `presets.list` so this window shows the result before `presets.changed`. */
  const setDefaults = async (input: OwnInput<"presets.defaults.set">) => {
    status.clear()
    return own.rpc
      .call("presets.defaults.set", input)
      .then(async () => {
        await own.refreshPresets()
        status.ok(i18n.t("own.set.saved"))
        return true
      })
      .catch((error: unknown) => {
        status.error(errorType(error) === "remote_managed" ? text("own.preset.err.remote") : errorMessage(i18n, error))
        return false
      })
  }

  return (
    <div class="flex flex-col" data-testid="settings-presets">
      <p class="m-0 text-[13px] leading-5 text-own-muted">{text("own.preset.page.lead")}</p>
      <Show when={!writable()}>
        <div class="mt-2">
          <Notice>{text("own.preset.page.readOnly")}</Notice>
        </div>
      </Show>

      <section class="own-psec !mt-3">
        <UltraRow group={group()} save={setDefaults} />
        <NewSessionRow group={group()} save={setDefaults} />
      </section>

      <section class="own-psec">
        <div class="own-psec-head">
          <h2>{text("own.preset.page.groups")}</h2>
        </div>
        <Show when={tabs().length} fallback={<p class="own-placeholder px-0">{text("own.preset.page.noGroups")}</p>}>
          {/* Only the selected tab is in the tab order (roving tabIndex), so the arrows move between tabs (APG tabs). */}
          <div
            class="own-pp-tabs"
            role="tablist"
            aria-label={text("own.preset.page.groups")}
            onKeyDown={(event) => {
              const list = tabs()
              const index = navTarget(event.key, list.indexOf(group()!), list.length, "horizontal")
              const next = index === undefined ? undefined : list[index]
              if (!next) return
              event.preventDefault()
              setTab(next)
              queueMicrotask(() => document.getElementById(`preset-tab-${next}`)?.focus())
            }}
          >
            <For each={tabs()}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  id={`preset-tab-${item}`}
                  aria-selected={group() === item}
                  aria-controls="preset-tab-panel"
                  tabIndex={group() === item ? 0 : -1}
                  data-testid={`preset-tab-${item}`}
                  onClick={() => setTab(item)}
                >
                  {names.group(item)}
                </button>
              )}
            </For>
          </div>
          <Show when={group()} keyed>
            {(current) => (
              <div id="preset-tab-panel" role="tabpanel" aria-labelledby={`preset-tab-${current}`}>
                <GroupPanel group={current} save={setDefaults} />
              </div>
            )}
          </Show>
        </Show>
      </section>
      <div class="mt-2">
        <StatusLine status={status} testid="presets-status" />
      </div>
      <HiddenModels />
      {/* Mounted for as long as the page is open, so it is the first layer and the editor opens here, never in the
          hidden composer of the conversation behind this page (presets/editor.tsx renders in the first layer only). */}
      <Suspense>
        <PresetEditorLayer />
      </Suspense>
    </div>
  )

  /** `울트라 상한: 추천 [바꾸기]` (07 §2.6): the global level; a preset's own level is set in 자세히 (T2). */
  function UltraRow(props: {
    readonly group: Preset.Group | undefined
    readonly save: (input: OwnInput<"presets.defaults.set">) => Promise<boolean>
  }) {
    const value = () => own.state.presetSettings.ultraCaps
    const [open, setOpen] = createSignal(false)
    const [choice, setChoice] = createSignal<UltraChoice>(ultraChoice(value()))
    const [fields, setFields] = createStore<CapsFields>({ concurrent: "", perMessage: "", perSession: null })
    const numbers = () => {
      const picked = choice()
      return picked === "custom" ? parseCaps(fields) : Preset.levelCaps(picked)
    }
    const start = () => {
      setChoice(ultraChoice(value()))
      setFields(capsFields(Preset.levelCaps(value())))
      setOpen(true)
    }
    const submit = async () => {
      const caps = numbers()
      const picked = choice()
      if (!props.group || !caps) return
      if (await props.save({ group: props.group, ultraCaps: picked === "custom" ? caps : picked })) setOpen(false)
    }
    const numbersText = (caps: Preset.Caps) => capsNumbers(text, caps)
    // The composer's ultra card links here (07 §2.9): scroll to this row and focus its `바꾸기`.
    createEffect(() => {
      if (!ultraCapsFocus()) return
      const frame = requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>('[data-testid="presets-ultra"]')
        if (!row) return
        row.scrollIntoView({ block: "center" })
        row.querySelector<HTMLElement>("button")?.focus({ preventScroll: true })
        clearUltraCapsFocus()
      })
      onCleanup(() => cancelAnimationFrame(frame))
    })
    return (
      <div class="own-pp-row" data-testid="presets-ultra">
        <div class="own-pp-main">
          <b class="font-semibold">
            {text("own.preset.ultraCaps")}: {text(ULTRA[ultraChoice(value())])}
          </b>
          <span class="ml-2 text-[12px] text-own-muted">{numbersText(Preset.levelCaps(value()))}</span>
        </div>
        <Show when={!open()}>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            disabled={!writable() || !props.group}
            data-testid="presets-ultra-change"
            onClick={start}
          >
            {text("own.preset.editor.change")}
          </button>
        </Show>
        <Show when={open()}>
          <div class="flex w-full flex-col gap-2 pt-1">
            <Segmented
              label={text("own.preset.ultraCaps")}
              value={choice()}
              options={ULTRA_CHOICES.map((item) => ({ value: item, label: text(ULTRA[item]) }))}
              onChange={setChoice}
              testid="presets-ultra-level"
            />
            <Show
              when={choice() === "custom"}
              fallback={<span class="text-[12.5px] text-own-muted">{numbersText(numbers()!)}</span>}
            >
              <div class="own-pp-form">
                <TextField
                  label={text("own.preset.caps.concurrent", { n: "N" })}
                  value={fields.concurrent}
                  onValue={(next) => setFields("concurrent", next)}
                  inputMode="numeric"
                />
                <TextField
                  label={text("own.preset.caps.perMessage", { n: "N" })}
                  value={fields.perMessage}
                  onValue={(next) => setFields("perMessage", next)}
                  inputMode="numeric"
                />
                <Show when={fields.perSession !== null}>
                  <TextField
                    label={text("own.preset.caps.perSession", { n: "N" })}
                    value={fields.perSession ?? ""}
                    onValue={(next) => setFields("perSession", next)}
                    inputMode="numeric"
                  />
                </Show>
              </div>
              <label class="own-pe-choice">
                <input
                  type="checkbox"
                  checked={fields.perSession !== null}
                  data-testid="presets-ultra-perSession-on"
                  onChange={(event) => setFields("perSession", event.currentTarget.checked ? PER_SESSION_START : null)}
                />
                <span>{text("own.preset.caps.perSessionOn")}</span>
                <Show when={fields.perSession === null}>
                  <span class="own-pe-hint">{text("own.preset.caps.perSessionNone")}</span>
                </Show>
              </label>
              <Show when={!numbers()}>
                <span class="text-[12px] text-own-danger">{text("own.preset.ultraInvalid")}</span>
              </Show>
            </Show>
            <Show when={numbers()}>
              {(caps) => (
                <span class="text-[12px] text-own-muted">
                  {text("own.preset.ultraCount", { n: caps().concurrent })}
                </span>
              )}
            </Show>
            <Show when={choice() === "large"}>
              <span class="text-[12px] text-own-warn" data-testid="presets-ultra-large">
                {text("own.preset.ultraLargeWarn")}
              </span>
            </Show>
            <div class="flex gap-2">
              <button type="button" class="own-btn" data-size="sm" onClick={() => setOpen(false)}>
                {i18n.t("own.kit.cancel")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-size="sm"
                data-variant="primary"
                disabled={!numbers()}
                data-testid="presets-ultra-save"
                onClick={() => void submit()}
              >
                {i18n.t("own.kit.save")}
              </button>
            </div>
          </div>
        </Show>
      </div>
    )
  }

  /** `새 대화 시작 프리셋: 묶음의 ★ / 마지막에 쓴 것(가벼운 것만)` (07 §5.1, §7.3). */
  function NewSessionRow(props: {
    readonly group: Preset.Group | undefined
    readonly save: (input: OwnInput<"presets.defaults.set">) => Promise<boolean>
  }) {
    return (
      <div class="own-pp-row" data-testid="presets-new-session">
        <div class="own-pp-main">
          <b class="block font-semibold">{text("own.preset.newSession")}</b>
          <span class="text-[12px] text-own-muted">{text("own.preset.newSession.note")}</span>
        </div>
        <Segmented
          label={text("own.preset.newSession")}
          value={own.state.presetSettings.newSession}
          options={(["star", "last-light"] as const).map((value) => ({
            value,
            label: text(value === "star" ? "own.preset.newSession.star" : "own.preset.newSession.lastLight"),
            disabled: !writable() || !props.group,
          }))}
          onChange={(newSession) => props.group && void props.save({ group: props.group, newSession })}
          testid="presets-new-session-choice"
        />
      </div>
    )
  }

  /** One group's tab: its shared line, new-session default model row and preset list. */
  function GroupPanel(props: {
    readonly group: Preset.Group
    readonly save: (input: OwnInput<"presets.defaults.set">) => Promise<boolean>
  }) {
    const view = () => own.state.presetGroups[props.group]
    const rows = createMemo(() => presetRows(props.group, view()))
    const star = () => starOf(props.group, view())
    const shared = () => groupAccounts(props.group, accounts()).length
    const editable = () => own.rpc.allowed("presets.set")
    const [removing, setRemoving] = createSignal<Preset.Listed>()
    const [rolesOpen, setRolesOpen] = createSignal(false)
    const remove = async (preset: Preset.Listed) => {
      status.clear()
      await own.rpc
        .call("presets.remove", { presetID: preset.id })
        .then(async () => {
          await own.refreshPresets()
          status.ok(text("own.preset.removed"))
        })
        .catch((error: unknown) => status.error(errorMessage(i18n, error)))
      setRemoving(undefined)
    }
    /** `모델 묶음에서 알아서 · 모델 4개 · 도움될 때`, `일마다 정하기 · 역할 3개 · 도움될 때` … (07 §7.1). */
    const summary = (preset: Preset.Listed) => {
      const workers = preset.workers
      const mode = Preset.modeOf(workers)
      return [
        text(MODE[mode]),
        ...(mode === "by-role" ? [text("own.preset.summary.roles", { n: Object.keys(workers.roles).length })] : []),
        ...(mode === "single" && workers.single ? [names.target(workers.single)] : []),
        ...(mode === "pool" ? [text("own.preset.summary.pool", { n: workers.pool?.length ?? 0 })] : []),
        text(DELEGATION[preset.delegation]),
      ].join(" · ")
    }
    return (
      <div class="flex flex-col" data-testid="presets-group" data-group={props.group}>
        <Show when={shared() > 0}>
          <p class="m-0 px-0.5 pt-2 text-[12.5px] text-own-muted">
            {text("own.preset.group.shared", { group: names.group(props.group), n: shared() })}
          </p>
        </Show>
        <RepairNotices group={props.group} defaults={false} />
        <DefaultModelRow group={props.group} save={props.save} />
        {/* 07 §4.5 (CA): which Codex version the ChatGPT accounts' model lists are asked as. */}
        <Show when={props.group === "codex"}>
          <CodexModelsSetting />
        </Show>
        <div class="flex items-center justify-between px-0.5 pt-3">
          <b class="text-[13px] font-semibold">{text("own.preset.list")}</b>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            disabled={!editable()}
            data-testid="presets-new"
            onClick={() => openPresetEditor({ group: props.group })}
          >
            {text("own.preset.new")}
          </button>
        </div>
        <For each={rows()}>
          {(preset) => {
            const builtin = Preset.isBuiltin(preset.id)
            return (
              <div class="own-pp-row" data-testid="presets-row" data-preset-id={preset.id}>
                <button
                  type="button"
                  class="own-pp-star"
                  aria-pressed={star() === preset.id}
                  aria-label={text("own.preset.star")}
                  title={text("own.preset.star")}
                  disabled={!writable() || star() === preset.id}
                  data-testid="presets-star"
                  onClick={() => void props.save({ group: props.group, star: preset.id })}
                >
                  {star() === preset.id ? "★" : "☆"}
                </button>
                <div class="own-pp-main">
                  <span class="flex flex-wrap items-center gap-1.5">
                    <b class="font-semibold">{builtin ? text("own.preset.builtin") : preset.name}</b>
                    <Show when={star() === preset.id}>
                      <Tag tone="soft">{text("own.preset.starred")}</Tag>
                    </Show>
                    <Show when={preset.status === "needs_repair"}>
                      <Tag tone="warn">{text("own.preset.needsRepair")}</Tag>
                    </Show>
                  </span>
                  <span class="block text-[12px] text-own-muted">{summary(preset)}</span>
                </div>
                <Show when={!builtin}>
                  <div class="own-pp-actions">
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      disabled={!editable()}
                      data-testid="presets-edit"
                      onClick={() => openPresetEditor({ group: props.group, presetID: preset.id })}
                    >
                      {text("own.preset.edit")}
                    </button>
                    <button
                      type="button"
                      class="own-btn"
                      data-size="sm"
                      data-variant="danger"
                      disabled={!own.rpc.allowed("presets.remove")}
                      data-testid="presets-remove"
                      onClick={() => setRemoving(preset)}
                    >
                      {text("own.preset.remove")}
                    </button>
                  </div>
                </Show>
              </div>
            )
          }}
        </For>
        <details
          class="px-0.5 pt-3"
          data-testid="presets-roles"
          onToggle={(event) => setRolesOpen(event.currentTarget.open)}
        >
          <summary class="cursor-pointer text-[13px] font-semibold">{pe("own.pe.roles")}</summary>
          <Show when={rolesOpen()}>
            <StarRoles group={props.group} />
          </Show>
        </details>
        <Dialog
          open={removing() !== undefined}
          title={text("own.preset.removeTitle", { name: removing()?.name ?? "" })}
          onClose={() => setRemoving(undefined)}
          testid="presets-remove-dialog"
          footer={
            <>
              <button type="button" class="own-btn" onClick={() => setRemoving(undefined)}>
                {i18n.t("own.kit.cancel")}
              </button>
              <button
                type="button"
                class="own-btn"
                data-variant="danger"
                data-testid="presets-remove-confirm"
                onClick={() => {
                  const preset = removing()
                  if (preset) void remove(preset)
                }}
              >
                {text("own.preset.remove")}
              </button>
            </>
          }
        >
          <p class="m-0 text-[13px]">{text("own.preset.removeNote")}</p>
        </Dialog>
      </div>
    )
  }

  /**
   * `새 대화 기본 모델: GPT-6 Astra · high · Codex 설정을 따름 [바꾸기]` (07 §2.2): a model of the group's account becomes
   * its `user` default; `자동으로 되돌리기` returns it to `auto`. Nothing here changes an existing session.
   */
  /**
   * 하위 에이전트 역할 of a group's ★ preset (07 §2.4, decisions PE): each role's purpose, what it may do and where it
   * runs now against the group's new-session default model, as the editor previews it. A model pool's default rule
   * needs its candidates (`presets.suggest`), read once while this is open.
   */
  function StarRoles(props: { readonly group: Preset.Group }) {
    const view = () => own.state.presetGroups[props.group]
    const preset = () => presetRows(props.group, view()).find((item) => item.id === starOf(props.group, view()))
    const models = () => catalog(runtime)
    const main = createMemo(() =>
      mainOf(
        groupMain(props.group, accounts(), view()?.defaultModel ?? own.state.groupDefaults[props.group], models()),
        (providerID) => own.accountFor(providerID),
        models(),
      ),
    )
    const [candidates, setCandidates] = createSignal<ReadonlyArray<Preset.PoolCandidate>>([])
    createEffect(() => {
      if (preset() && Preset.modeOf(preset()!.workers) === "pool")
        void own.rpc
          .call("presets.suggest", { group: props.group })
          .then((answer) => setCandidates(answer.pool?.candidates ?? []))
          .catch(() => undefined)
    })
    const runs = createMemo(() => {
      const current = preset()
      return current
        ? presetRuns({
            preset: current,
            main: main(),
            accounts: own.state.accounts,
            models: models(),
            lighter: lighterFor(props.group, view()?.lighter, main(), models()),
            candidates: candidates(),
          })
        : undefined
    })
    return (
      <Show when={runs()}>
        {(list) => (
          <RoleGuide
            runs={list()}
            off={preset()?.delegation === "off"}
            title={pe("own.pe.rolesFor", {
              preset: Preset.isBuiltin(preset()!.id) ? text("own.preset.builtin") : preset()!.name,
            })}
            testid="presets-roles-guide"
          />
        )}
      </Show>
    )
  }

  function DefaultModelRow(props: {
    readonly group: Preset.Group
    readonly save: (input: OwnInput<"presets.defaults.set">) => Promise<boolean>
  }) {
    const view = () => own.state.presetGroups[props.group]
    const value = () => view()?.defaultModel ?? own.state.groupDefaults[props.group]
    const main = createMemo(() => groupMain(props.group, accounts(), value(), catalog(runtime)))
    const models = () => {
      const current = main()
      return current ? providerModels(runtime, current.providerID) : []
    }
    const [open, setOpen] = createSignal(false)
    const [modelID, setModelID] = createSignal("")
    const [variant, setVariant] = createSignal("")
    const variants = () =>
      models()
        .find((model) => model.id === modelID())
        ?.variants.map((item) => item.id) ?? []
    const label = () => defaultLabel(view())
    /**
     * 07 §4.3: the default model is gone (the service's repair, else the row's `missing` mark); new sessions start on
     * the service's suggestion, else this window's reading of the group rule. The stored value stays.
     */
    const gone = () => {
      const repair = defaultRepair(presetRepairs() ?? [], props.group)
      const model = repair?.model ?? (value()?.missing ? value()?.id : undefined)
      if (!model) return undefined
      const next = repair?.next ?? main()?.id
      const providerID = main()?.providerID
      return text("own.preset.repair.defaultGone", {
        group: names.group(props.group),
        model: names.model(providerID, model),
        next: next ? names.model(providerID, next) : "—",
      })
    }
    const start = () => {
      setModelID(value()?.id ?? main()?.id ?? models()[0]?.id ?? "")
      setVariant(value()?.variant ?? "")
      setOpen(true)
    }
    const submit = async (choice: Preset.Choice | null) => {
      if (await props.save({ group: props.group, defaultModel: choice })) setOpen(false)
    }
    return (
      <div class="own-pp-row" data-testid="presets-default-model">
        <div class="own-pp-main">
          <b class="mr-2 font-semibold">{text("own.preset.groupDefault")}:</b>
          <Show when={value()} fallback={<span class="text-own-muted">{text("own.preset.groupDefault.none")}</span>}>
            {(current) => (
              <span>
                {names.model(main()?.providerID, current().id)} · {variantName(i18n, current().variant)}
                <Show when={label()}>
                  {(source) => (
                    <span class="text-own-muted"> · {text(`own.preset.groupDefault.label.${source()}`)}</span>
                  )}
                </Show>
                <Show when={current().missing}>
                  <Tag tone="warn">{text("own.preset.groupDefault.missing")}</Tag>
                </Show>
              </span>
            )}
          </Show>
          <Show when={gone()}>
            {(line) => (
              <span class="block text-[12px] text-own-warn" data-testid="presets-default-gone">
                {line()}
              </span>
            )}
          </Show>
        </div>
        <Show when={!open()}>
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            disabled={!writable() || models().length === 0}
            data-testid="presets-default-change"
            onClick={start}
          >
            {text("own.preset.editor.change")}
          </button>
        </Show>
        <Show when={open()}>
          <div class="own-pp-form w-full">
            <label class="own-field">
              <span class="own-field-label">{text("own.preset.groupDefault.model")}</span>
              <select
                class="own-input"
                value={modelID()}
                data-testid="presets-default-model-select"
                onChange={(event) => {
                  setModelID(event.currentTarget.value)
                  setVariant("")
                }}
              >
                <For each={models()}>{(model) => <option value={model.id}>{model.name}</option>}</For>
              </select>
            </label>
            <Show when={variants().length}>
              <label class="own-field">
                <span class="own-field-label">{i18n.t("own.switcher.variantLabel")}</span>
                <select
                  class="own-input"
                  value={variant()}
                  data-testid="presets-default-variant-select"
                  onChange={(event) => setVariant(event.currentTarget.value)}
                >
                  <option value="">{variantName(i18n, undefined)}</option>
                  <For each={variants()}>{(item) => <option value={item}>{variantName(i18n, item)}</option>}</For>
                </select>
              </label>
            </Show>
            <button type="button" class="own-btn" data-size="sm" onClick={() => setOpen(false)}>
              {i18n.t("own.kit.cancel")}
            </button>
            <Show when={value()?.source === "user"}>
              <button type="button" class="own-btn" data-size="sm" onClick={() => void submit(null)}>
                {text("own.preset.groupDefault.auto")}
              </button>
            </Show>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="primary"
              disabled={!modelID()}
              data-testid="presets-default-save"
              onClick={() =>
                void submit({
                  id: Model.ID.make(modelID()),
                  ...(variant() ? { variant: Model.VariantID.make(variant()) } : {}),
                })
              }
            >
              {i18n.t("own.kit.save")}
            </button>
          </div>
        </Show>
      </div>
    )
  }
}
