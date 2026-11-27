// Preset repair notices (07 §4.3, §7.3): one line per model event, a model that is gone from where this PC's presets
// use it (a pinned target, a model pool entry, a lighter pair, a group's new-session default), as `presets.list`
// `repairs` gives them with the service's suggestions. `[<후속 모델>로 고치기]` / `[짝 고치기]` store the suggested fix
// (`presets.set{repairOf}`, `presets.defaults.set{lighter}`; a pool entry takes the successor under a new key, without
// its card, so the service freezes a new one), `[직접 고르기]` opens the editor with 자세히 on that role or pool entry
// (`focusRole`, like the team view's `고치기`), and a gone default offers `[바꾸기]` on its settings 프리셋 tab. Nothing
// is fixed, picked again or switched by itself (U3). This module is a lazy chunk (PF5): the repairs themselves, the dot
// and what is still to announce are in presets/repairs.ts, which the shell's notifier (shell/notifications.tsx) keeps
// read; it loads these lines to announce a model event once, the composer's preset menu and settings 프리셋 to show a
// group's lines.
import type { Model } from "@opencode/schema/model"
import { Preset } from "@own/protocol/preset"
import { Schema, Struct } from "effect"
import { createMemo, createRoot, createSignal, For, Show } from "solid-js"
import { errorData, errorMessage, errorType } from "@/accounts/errors"
import { useData, type OwnStore } from "@/data"
import type { OwnInput } from "@/data/rpc"
import { useI18n, type I18nParams } from "@/i18n"
import { useRouter } from "@/routing/router"
import { catalog } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import {
  draftOf,
  openPresetEditor,
  poolRuns,
  samePoolTarget,
  sameTarget,
  toSave,
  withMode,
  type EditorRequest,
} from "./model"
import { lighterPlaces, presetRepairs } from "./repairs"
import { errorKey, ROLE_KEY } from "./session-view"
import { presetsKo, usePresetsText, type PresetsKey } from "./strings"

// ---- settings 프리셋 on a group's tab ----

const [tabRequest, setTabRequest] = createRoot(() => createSignal<Preset.Group>())

/** A gone default's `[바꾸기]`: settings 프리셋 on that group's tab, where its default model row is. */
export function openPresetSettings(
  navigate: (route: { readonly name: "settings"; readonly section: "presets" }) => void,
  group: Preset.Group,
) {
  setTabRequest(group)
  navigate({ name: "settings", section: "presets" })
}

/** The tab {@link openPresetSettings} asked for, taken once (reactive: settings 프리셋 follows a later request). */
export function takePresetTab() {
  const group = tabRequest()
  if (group) setTabRequest(undefined)
  return group
}

/** What new sessions of a group start on instead of its gone default model (07 §4.3), as the service says. */
export function defaultRepair(list: ReadonlyArray<Preset.Repair>, group: Preset.Group) {
  return list
    .flatMap((repair) =>
      repair.uses.flatMap((use) =>
        use.kind === "default" && use.group === group ? [{ model: repair.model, next: use.suggestion }] : [],
      ),
    )
    .at(0)
}

// ---- the lines ----

type Text = (key: PresetsKey, params?: I18nParams) => string

/** Display names a line uses: a model (on the account that pinned it, when known), a place, a group. */
export interface NoticeNames {
  readonly model: (id: string, account?: string) => string
  readonly place: (place: Preset.Place) => string
  readonly group: (group: Preset.Group) => string
}

/** One write of a fix, in order: a later write of a preset already holds the earlier fixes of that preset. */
export type FixStep =
  | { readonly method: "presets.set"; readonly input: OwnInput<"presets.set"> }
  | { readonly method: "presets.defaults.set"; readonly input: OwnInput<"presets.defaults.set"> }

export interface NoticeLine {
  readonly model: Model.ID
  /** What the line says: a pin first, then a lighter pair, then a default model. */
  readonly kind: Preset.Use["kind"]
  readonly group: Preset.Group
  readonly text: string
  /** `[<model>로 고치기]`, `[고치기]` or `[짝 고치기]`: every suggested fix of the line's pins and pairs. */
  readonly fix?: { readonly label: string; readonly steps: ReadonlyArray<FixStep> }
  /** `[직접 고르기]`: the editor on the first place that used the model, 자세히 open there. */
  readonly pick?: EditorRequest
  /** `[바꾸기]` of a gone default model: its settings 프리셋 tab. */
  readonly change?: Preset.Group
}

type Pin = Extract<Preset.Use, { kind: "pin" }>
type Pair = Extract<Preset.Use, { kind: "lighter" }>

const isPlace = Schema.is(Preset.Place)

/**
 * One line per model event (07 §4.3 `리뷰 모델 GPT-5.5가 없어져 리뷰를 메인 모델로 돌립니다 · 프리셋 2개 [GPT-5.6 Sol로
 * 고치기] [직접 고르기]`), whatever the number of presets, groups or accounts that use it. With `group`, only that
 * group's uses count and get fixed.
 */
export function noticeLines(input: {
  readonly repairs: ReadonlyArray<Preset.Repair>
  readonly groups: Readonly<Record<string, Preset.GroupView>>
  readonly text: Text
  readonly names: NoticeNames
  readonly group?: Preset.Group
  /** Accounts by id: a fixed pool entry's new key takes the tail of what it runs on (`Preset.poolKey`). */
  readonly lookup?: Preset.Lookup
}): NoticeLine[] {
  return input.repairs.flatMap((repair) => {
    const uses = repair.uses.filter((use) => input.group === undefined || use.group === input.group)
    const pins = uses.filter((use): use is Pin => use.kind === "pin")
    const pairs = uses.filter((use): use is Pair => use.kind === "lighter")
    const lead = [...pins, ...pairs, ...uses].at(0)
    if (!lead) return []
    const repins = pinSteps(repair.model, pins, input.groups, input.lookup ?? (() => undefined))
    const steps = [...repins, ...pairSteps(pairs)]
    const label = steps.length ? fixLabel(input, repins.length ? pins : [], pairs) : undefined
    const pick = pins[0]
      ? pinPick(pins[0])
      : lead.kind === "lighter"
        ? lighterPick(lead.group, input.groups)
        : undefined
    return [
      {
        model: repair.model,
        kind: lead.kind,
        group: lead.group,
        text: lineText(input, repair.model, lead, pins),
        ...(label ? { fix: { label, steps } } : {}),
        ...(pick ? { pick } : {}),
        ...(lead.kind === "default" ? { change: lead.group } : {}),
      },
    ]
  })
}

function lineText(
  input: {
    readonly groups: Readonly<Record<string, Preset.GroupView>>
    readonly text: Text
    readonly names: NoticeNames
  },
  model: Model.ID,
  lead: Preset.Use,
  pins: ReadonlyArray<Pin>,
) {
  const names = input.names
  if (lead.kind === "pin") {
    const roles = [...new Set(pins.map((use) => use.place))].filter(isPlace)
    const keys = [...new Set(pins.flatMap((use) => Preset.poolKeyOf(use.place) ?? []))]
    const presets = new Set(pins.map((use) => use.presetID)).size
    const name = names.model(model, lead.account)
    const gone = [
      ...(roles.length
        ? [input.text("own.preset.repair.pinGone", { role: roles.map(names.place).join(", "), model: name })]
        : []),
      ...(keys.length ? [input.text("own.preset.repair.poolGone", { keys: keys.join(", "), model: name })] : []),
    ]
    return `${gone.join(" · ")} · ${input.text("own.preset.repair.presets", { n: presets })}`
  }
  if (lead.kind === "lighter") {
    const places = lighterPlaces(input.groups[lead.group])
    const role = places.length
      ? [...new Set(places.map((item) => item.place))].map(names.place).join(", ")
      : input.text("own.preset.target.lighter")
    return input.text("own.preset.repair.lighterGone", { model: names.model(model), role })
  }
  return input.text("own.preset.repair.defaultGone", {
    group: names.group(lead.group),
    model: names.model(model),
    next: lead.suggestion ? names.model(lead.suggestion) : "—",
  })
}

/**
 * `[짝 고치기]` when only pairs are fixed; else `[<model>로 고치기]` when every fix names one model, `[고치기]` when they
 * differ. `pins` are the pins fixed (none when no stored preset can take the fix).
 */
function fixLabel(
  input: { readonly text: Text; readonly names: NoticeNames },
  pins: ReadonlyArray<Pin>,
  pairs: ReadonlyArray<Pair>,
) {
  const pinned = pins.filter((use) => use.suggestion !== undefined)
  const first = pinned[0]
  if (!first?.suggestion) return input.text("own.preset.repair.fixLighter")
  const models = new Set([...pinned, ...pairs].flatMap((use) => (use.suggestion ? [use.suggestion] : [])))
  return models.size === 1
    ? input.text("own.preset.repair.fixTo", { model: input.names.model(first.suggestion, first.account) })
    : input.text("own.preset.repair")
}

/**
 * `presets.set{repairOf}` per place of each stored preset whose pin has a suggestion (07 §4.3 `[고치기]`): the gone
 * pin becomes the suggested model on the same account, in its rank; a pool entry takes it under a new key
 * ({@link repooled}). A preset's later write keeps its earlier fixes.
 */
function pinSteps(
  model: Model.ID,
  pins: ReadonlyArray<Pin>,
  groups: Readonly<Record<string, Preset.GroupView>>,
  lookup: Preset.Lookup,
): FixStep[] {
  const fixable = pins.flatMap((use) => (use.suggestion ? [{ ...use, suggestion: use.suggestion }] : []))
  return [...Map.groupBy(fixable, (use) => use.presetID)].flatMap(([presetID, uses]) => {
    const stored = groups[uses[0].group]?.presets?.find((item) => item.id === presetID && !Preset.isBuiltin(item.id))
    if (!stored) return []
    return [...Map.groupBy(uses, (use) => use.place)].reduce<{ draft: Preset.Draft; steps: FixStep[] }>(
      (done, [place, placed]) => {
        const draft = placed.reduce((current, use) => {
          const key = Preset.poolKeyOf(place)
          if (key !== undefined) return repooled(current, key, use.suggestion, lookup)
          const account = use.account
          if (account === undefined || !isPlace(place)) return current
          return repinned(current, place, { pin: { account, model } }, { pin: { account, model: use.suggestion } })
        }, done.draft)
        const step: FixStep = { method: "presets.set", input: { preset: toSave(draft), repairOf: { model, place } } }
        return { draft, steps: [...done.steps, step] }
      },
      { draft: draftOf(stored.group, stored), steps: [] },
    ).steps
  })
}

/** `[짝 고치기]`: the suggested pair of each main model, stored as the user's pair (07 §4.2). */
function pairSteps(pairs: ReadonlyArray<Pair>): FixStep[] {
  return pairs.flatMap((use) =>
    use.suggestion
      ? [
          {
            method: "presets.defaults.set" as const,
            input: { group: use.group, lighter: { mainModelID: use.main, model: use.suggestion } },
          },
        ]
      : [],
  )
}

/** `gone` replaced by `next` in a place, in its rank; a target listed twice afterwards stays once. */
function repinned(draft: Preset.Draft, place: Preset.Place, gone: Preset.Target, next: Preset.Target): Preset.Draft {
  const workers = draft.workers
  if (place === "single")
    return workers.single && sameTarget(workers.single, gone)
      ? { ...draft, workers: { ...workers, single: next } }
      : draft
  const row = workers.roles[place]
  if (!row) return draft
  const swapped = row.targets.map((target) => (sameTarget(target, gone) ? next : target))
  const targets = swapped.filter((target, index) => swapped.findIndex((other) => sameTarget(other, target)) === index)
  return { ...draft, workers: { ...workers, roles: { ...workers.roles, [place]: { ...row, targets } } } }
}

/**
 * A pool entry fixed with the successor (07 §4.3 모델 묶음 `[고치기]`): the model changes, the key is made again for
 * it (`Preset.poolKey`) and the card goes, so the service freezes the new model's; its effort and note stay. With the
 * successor already in the pool on that account, the gone entry just leaves.
 */
function repooled(draft: Preset.Draft, key: string, next: Model.ID, lookup: Preset.Lookup): Preset.Draft {
  const pool = draft.workers.pool ?? []
  const entry = pool.find((item) => item.key === key)
  if (!entry) return draft
  const rest = pool.filter((item) => item !== entry)
  if (rest.some((item) => samePoolTarget(item, { account: entry.account, model: next })))
    return withMode(draft, "pool", rest)
  const fixed = {
    ...Struct.omit(entry, ["card"]),
    model: next,
    key: Preset.poolKey(
      next,
      rest.map((item) => item.key),
      poolRuns(entry.account, lookup),
    ),
  }
  return withMode(
    draft,
    "pool",
    pool.map((item) => (item === entry ? fixed : item)),
  )
}

function pinPick(use: Pin): EditorRequest {
  return { group: use.group, presetID: use.presetID, focusRole: use.place }
}

/** A gone pair's `[직접 고르기]`: the first preset that runs on it, 자세히 open on that role (the pair table is there). */
function lighterPick(
  group: Preset.Group,
  groups: Readonly<Record<string, Preset.GroupView>>,
): EditorRequest | undefined {
  const first = lighterPlaces(groups[group]).at(0)
  return first && { group, presetID: first.presetID, focusRole: first.place }
}

// ---- actions ----

/** Stores a line's fixes in order, then reads `presets.list` again (the dot and the lines follow the new status). */
export async function applyFixes(own: Pick<OwnStore, "rpc" | "refreshPresets">, steps: ReadonlyArray<FixStep>) {
  await steps.reduce<Promise<unknown>>((previous, step) => previous.then(() => write(own, step)), Promise.resolve())
  await own.refreshPresets()
}

function write(own: Pick<OwnStore, "rpc">, step: FixStep): Promise<unknown> {
  if (step.method === "presets.set") return own.rpc.call("presets.set", step.input)
  return own.rpc.call("presets.defaults.set", step.input)
}

/** The lines in the current language with their actions; `toastAction` is a toast's one action. */
export function useRepairActions() {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const router = useRouter()
  const own = () => data.local().own
  const names: NoticeNames = {
    model(id, account) {
      const providerID =
        account === undefined
          ? undefined
          : Preset.isLocal(account)
            ? account.slice("local:".length)
            : own().state.accounts[account]?.providerID
      const models = catalog(data.local())
      const found =
        models.find((model) => model.id === id && (providerID === undefined || model.providerID === providerID)) ??
        models.find((model) => model.id === id)
      return found?.name ?? id
    },
    place: (place) => (place === "single" ? text("own.preset.place.single") : text(ROLE_KEY[place])),
    group(group) {
      const key = `own.preset.groupName.${Preset.isLocal(group) ? group.slice("local:".length) : group}`
      return isKey(key) ? text(key) : group
    },
  }
  /** A preset error in the editor's words (R4 names the account), else the shared sentence. */
  const failure = (error: unknown) => {
    const key = errorKey(errorType(error))
    if (!key) return errorMessage(i18n, error)
    const detail = errorData<{ accountID: string; role: string }>(error)
    const role = Preset.ROLES.find((item) => item === detail.role)
    const pooled = detail.role?.startsWith("pool:") ? detail.role.slice("pool:".length) : undefined
    return text(key, {
      account: (detail.accountID && own().state.accounts[detail.accountID]?.label) || detail.accountID || "—",
      role: role
        ? names.place(role)
        : pooled !== undefined
          ? text("own.preset.pool.place", { key: pooled })
          : (detail.role ?? "—"),
    })
  }
  const fix = (line: NoticeLine) =>
    line.fix &&
    applyFixes(own(), line.fix.steps).then(
      () => showToast({ message: text("own.preset.repair.fixed") }),
      (error: unknown) => showToast({ message: failure(error), tone: "danger" }),
    )
  const pick = (line: NoticeLine) => line.pick && openPresetEditor(line.pick)
  const change = (line: NoticeLine) => line.change && openPresetSettings((route) => router.navigate(route), line.change)
  /** Fixes and `직접 고르기` write this PC's presets (`admin`); a connection without it only reads the lines. */
  const writable = () => own().rpc.allowed("presets.set")
  return {
    text,
    names,
    lines: (group?: Preset.Group) =>
      noticeLines({
        repairs: presetRepairs() ?? [],
        groups: own().state.presetGroups,
        text,
        names,
        group,
        lookup: (accountID) => own().state.accounts[accountID],
      }),
    writable,
    fix,
    pick,
    change,
    /** The one action a toast carries: the fix, else `직접 고르기`, else `바꾸기`. */
    toastAction(line: NoticeLine) {
      if (line.fix && writable()) return { label: line.fix.label, run: () => void fix(line) }
      if (line.pick && writable()) return { label: text("own.preset.repair.pickOwn"), run: () => pick(line) }
      if (line.change) return { label: text("own.preset.editor.change"), run: () => change(line) }
      return undefined
    },
  }
}

function isKey(key: string): key is PresetsKey {
  return Object.hasOwn(presetsKo, key)
}

// ---- the lines on screen ----

/**
 * The repair lines of one group, or of every group. In the composer's preset menu (`menu`) the actions are menu items
 * under the line; elsewhere they are small buttons after it. `defaults: false` leaves out the lines of a gone default
 * model (settings 프리셋 shows that one on the default model row).
 */
export function RepairNotices(props: {
  readonly group?: Preset.Group
  readonly defaults?: boolean
  readonly menu?: boolean
  /** After an action (the menu closes). */
  readonly onAction?: () => void
}) {
  const actions = useRepairActions()
  const text = actions.text
  const lines = createMemo(() =>
    actions.lines(props.group).filter((line) => props.defaults !== false || line.kind !== "default"),
  )
  const act = (run: () => unknown) => {
    props.onAction?.()
    void run()
  }
  const button = (label: string, testid: string, run: () => unknown) =>
    props.menu ? (
      <button type="button" role="menuitem" class="own-cp-menu-item" data-testid={testid} onClick={() => act(run)}>
        {label}
      </button>
    ) : (
      <button type="button" class="own-btn" data-size="sm" data-testid={testid} onClick={() => act(run)}>
        {label}
      </button>
    )
  const list = () => (
    <For each={lines()}>
      {(line) => (
        <div
          role={props.menu ? "group" : undefined}
          class={props.menu ? "flex flex-col" : "flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[12.5px]"}
          data-testid="preset-repair"
          data-kind={line.kind}
          data-model={line.model}
        >
          <span
            role={props.menu ? "presentation" : undefined}
            class={props.menu ? "px-2.5 pt-1.5 pb-0.5 text-[12px] leading-[17px] whitespace-normal" : "min-w-0 flex-1"}
            data-testid="preset-repair-text"
          >
            <span class="mr-1 text-own-warn" aria-hidden="true">
              ●
            </span>
            {line.text}
          </span>
          <Show when={actions.writable() ? line.fix : undefined}>
            {(fix) => button(fix().label, "preset-repair-fix", () => actions.fix(line))}
          </Show>
          <Show when={line.pick && actions.writable()}>
            {button(text("own.preset.repair.pickOwn"), "preset-repair-pick", () => actions.pick(line))}
          </Show>
          <Show when={line.change}>
            {button(text("own.preset.editor.change"), "preset-repair-change", () => actions.change(line))}
          </Show>
          <Show when={props.menu}>
            <div role="separator" class="my-1 border-t border-own-border" />
          </Show>
        </div>
      )}
    </For>
  )
  if (props.menu) return list()
  return (
    <Show when={lines().length}>
      <div class="flex flex-col pt-2" role="status" data-testid="preset-repairs">
        {list()}
      </div>
    </Show>
  )
}
