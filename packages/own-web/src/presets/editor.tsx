// Preset editor, 간단히 (07 §7.1): the header `모든 <묶음> 계정(n개)에서 씁니다`, the name and the starters (unusable ones
// greyed with their reason), ① where subagents run, each radio with its one-line hint (`메인과 같은 모델로` /
// `다른 모델 하나로`, whose target is never the main / `모델 묶음에서 알아서` with its checklist, pool-list.tsx, shown
// only when `presets.suggest` offers a pool / `일마다 정하기` with the role rows 탐색·일반·리뷰 and `+ 역할 추가` for
// 빠른 일·어려운 일), ② how much to delegate, the read-only caps line, and the live
// resolution line from `Preset.resolve` with `[복사]`. Every target shows where it came from (`추천` / `직접 고름`), and a
// pinned model's Codex retirement date dimmed beside it (07 §4.3, never a notice). The checked pool is kept while the
// editor is open, so leaving `모델 묶음` and coming back restores it (only the chosen mode is saved). There is no main
// model or main effort field (U1). `자세히 ▸` (07 §7.2) opens the panel registered at the mount point below:
// presets/details.tsx, its own lazy chunk. `focusRole` (a repair notice's `[직접 고르기]`, the team view's `고치기`)
// opens with 자세히 expanded on that role or pool entry. Lazy: the default export is the layer that renders
// `openPresetEditor` requests (model.ts).
import { Preset } from "@own/protocol/preset"
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  lazy,
  onCleanup,
  Show,
  Suspense,
  type Component,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { errorData, errorMessage, errorType } from "@/accounts/errors"
import { useData } from "@/data"
import { useI18n } from "@/i18n"
import { usd } from "@/limits/format"
import { Dialog, Notice, TextField, copyText, createStatus, StatusLine } from "@/limits/kit"
import { useRouter } from "@/routing/router"
import { catalog, ensureCatalog } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import {
  catalogOf,
  closePresetEditor,
  copyLines,
  DELEGATIONS,
  draftMode,
  draftOf,
  EXTRA_ROLES,
  groupAccounts,
  groupMain,
  lighterFor,
  mainOf,
  monthDay,
  pickerSections,
  pinnables,
  presetEditorRequest,
  problems,
  provenance,
  resolutionLine,
  retirementOf,
  shownRoles,
  toSave,
  withDelegation,
  withMode,
  withoutRole,
  withPrefill,
  withStarter,
  withTarget,
  WORKER_MODES,
  type EditorRequest,
  type LocalCheck,
  type PresetDetailProps,
} from "./model"
import { PoolList } from "./pool-list"
import { usePresetsText, type PresetsKey } from "./strings"
import { createSpend, TargetPicker, useTargetText } from "./target-picker"
import "./presets.css"

const MODE: Record<Preset.Mode, PresetsKey> = {
  same: "own.preset.workers.same",
  single: "own.preset.workers.single",
  pool: "own.preset.workers.pool",
  "by-role": "own.preset.workers.byRole",
}

/** The line under each ① radio (UC 2026-10-18): what that choice runs subagents on. */
const MODE_HINT: Record<Preset.Mode, PresetsKey> = {
  same: "own.preset.workers.sameHint",
  single: "own.preset.workers.singleHint",
  pool: "own.preset.workers.poolHint",
  "by-role": "own.preset.workers.byRoleHint",
}

const DELEGATION: Record<Preset.Delegation, PresetsKey> = {
  off: "own.preset.delegation.off",
  model: "own.preset.delegation.model",
  "on-request": "own.preset.delegation.onRequest",
  "when-useful": "own.preset.delegation.whenUseful",
  active: "own.preset.delegation.active",
}

const HINT: Record<Exclude<Preset.Delegation, "off">, PresetsKey> = {
  model: "own.preset.delegation.hint.model",
  "on-request": "own.preset.delegation.hint.onRequest",
  "when-useful": "own.preset.delegation.hint.whenUseful",
  active: "own.preset.delegation.hint.active",
}

const [detail, setDetail] = createSignal<Component<PresetDetailProps>>()

/** The 자세히 panel's mount point (07 §7.2); returns the unregister. */
export function registerPresetDetail(panel: Component<PresetDetailProps>) {
  setDetail(() => panel)
  return () => setDetail(undefined)
}

// 자세히 loads the first time it opens: the simple editor stays the editor chunk's whole first render.
registerPresetDetail(lazy(() => import("./details")))

const [hosts, setHosts] = createSignal<ReadonlyArray<symbol>>([])

/**
 * Renders the editor for `openPresetEditor` requests. Mount it in the shell; the settings 프리셋 page mounts one too
 * while it is open. Only the first mounted layer renders, so a request never shows twice, and the last layer to go
 * drops an open request (no editor reappears later by surprise).
 */
export default function PresetEditorLayer() {
  const me = Symbol("preset-editor-layer")
  setHosts((list) => [...list, me])
  onCleanup(() => {
    const rest = hosts().filter((item) => item !== me)
    setHosts(rest)
    if (rest.length === 0) closePresetEditor()
  })
  return (
    <Show when={hosts()[0] === me && presetEditorRequest()} keyed>
      {(request) => <PresetEditor request={request} onClose={closePresetEditor} />}
    </Show>
  )
}

function PresetEditor(props: { readonly request: EditorRequest; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const text = usePresetsText()
  const names = useTargetText()
  const router = useRouter()
  const runtime = data.local()
  const own = runtime.own
  ensureCatalog(runtime, undefined, true)
  const group = props.request.group
  const view = () => own.state.presetGroups[group]
  const requested = props.request.presetID
  const stored = view()?.presets?.find((item) => item.id === requested && !Preset.isBuiltin(item.id))
  const missing = requested !== undefined && !Preset.isBuiltin(requested) && !stored
  const prefill = props.request.prefill
  const focus = props.request.focusRole
  const lookup: Preset.Lookup = (id) => own.state.accounts[id]
  const start = draftOf(group, stored)
  const [draft, setDraft] = createSignal(prefill ? withPrefill(start, prefill, lookup) : start)
  /** The last checked pool, kept while the editor is open: choosing `모델 묶음` again brings it back. */
  const [kept, setKept] = createSignal<ReadonlyArray<Preset.PoolEntry>>(draft().workers.pool ?? [])
  // A focused extra role (빠른 일, 어려운 일) shows its row even without targets.
  const [added, setAdded] = createSignal<ReadonlyArray<Preset.Role>>(EXTRA_ROLES.filter((role) => role === focus))
  const [details, setDetails] = createSignal(focus !== undefined)
  /** Fields of 자세히 that hold `저장` while invalid (07 §2.6 caps). */
  const [blocked, setBlocked] = createSignal<ReadonlyArray<string>>([])
  const block = (field: string, on: boolean) =>
    setBlocked((list) =>
      on ? [...list.filter((item) => item !== field), field] : list.filter((item) => item !== field),
    )
  const [chosen, setChosen] = createSignal<ReadonlyArray<Preset.Place>>(
    prefill && "role" in prefill ? [prefill.role] : [],
  )
  /** `presets.suggest`'s answer; `null` when the service has none yet (an older build). */
  const [served, setServed] = createSignal<Preset.Suggestion | null>()
  const [picker, setPicker] = createSignal<Preset.Place>()
  const [tried, setTried] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const spend = createSpend(own)
  const uid = createUniqueId()

  const accounts = () =>
    own.state.accountOrder.flatMap((id) => (own.state.accounts[id] ? [own.state.accounts[id]!] : []))
  const models = () => catalog(runtime)
  const main = createMemo(() =>
    mainOf(
      props.request.main ??
        groupMain(group, accounts(), view()?.defaultModel ?? own.state.groupDefaults[group], models()),
      (providerID) => own.accountFor(providerID),
      models(),
    ),
  )
  const lighter = createMemo(() => lighterFor(group, view()?.lighter, main(), models()))
  const resolution = createMemo(() => {
    const current = main()
    return current && Preset.resolve(draft(), current, catalogOf(own.state.accounts, models()), lighter())
  })
  // A local model the service suggested has a verified running window (07 §6.2 #8); others stay `창 확인 안 됨`.
  const local: LocalCheck = (providerID, modelID) => {
    const verified = Object.values(suggestion()?.rows ?? {}).some((row) =>
      row.targets.some(
        (target) => "pin" in target && target.pin.account === `local:${providerID}` && target.pin.model === modelID,
      ),
    )
    return verified ? { status: "verified" } : undefined
  }
  const issues = createMemo(() => problems(draft(), lookup))
  const r4 = () => issues().flatMap((item) => (item.code === "same-company" ? [item.accountID] : []))[0]
  const writable = () => own.rpc.allowed("presets.set")

  /** Without `presets.suggest`, the same rule over this window's catalog (it follows the catalog as it loads). */
  const fallback = (template?: Preset.Starter) =>
    Preset.suggest(group, pinnables(pickerSections({ group, accounts: accounts(), models: models() })), template)
  const suggestion = createMemo(() => {
    const answer = served()
    return answer === null ? fallback() : answer
  })
  const suggest = (template?: Preset.Starter) =>
    own.rpc.call("presets.suggest", { group, ...(template ? { template } : {}) }).catch(() => null)
  void suggest().then((answer) => setServed(answer))
  /** ① choices: `모델 묶음에서 알아서` only when the service offers a pool (an older one has none), or the draft is one. */
  const modes = () =>
    WORKER_MODES.filter((mode) => mode !== "pool" || suggestion()?.pool !== undefined || draftMode(draft()) === "pool")

  // Paid pinned targets (a model pool's pins too) show their spend (07 §7.3 `요금 종류 배지와 예산`).
  createEffect(() =>
    spend.load(
      Preset.targetsOf(draft().workers).flatMap((target) => {
        if (!("pin" in target)) return []
        const account = own.state.accounts[target.pin.account]
        return account && (account.billing === "metered" || account.billing === "prepaid") ? [account] : []
      }),
    ),
  )

  const update = (next: Preset.Draft) => {
    status.clear()
    const pool = draft().workers.pool
    if (pool?.length && !next.workers.pool) setKept(pool)
    setDraft(next)
  }
  const choose = (place: Preset.Place, target: Preset.Target) => {
    update(withTarget(draft(), place, target))
    setChosen((list) => (list.includes(place) ? list : [...list, place]))
  }
  const applyStarter = async (template: Preset.Starter) => {
    const answer = (await suggest(template)) ?? fallback(template)
    update(withStarter(draft(), answer.draft))
    setChosen([])
  }

  const save = async () => {
    setTried(true)
    if (issues().length || blocked().length || busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("presets.set", { preset: toSave(draft()) })
      .then(async () => {
        await own.refreshPresets()
        showToast({ message: text("own.preset.editor.saved") })
        props.onClose()
      })
      .catch((error: unknown) => status.error(saveError(error)))
    setBusy(false)
  }
  const saveError = (error: unknown) => {
    const type = errorType(error)
    if (type === "same_company_subscription") {
      const accountID = errorData<{ accountID: string }>(error).accountID
      return text("own.preset.err.sameCompany", {
        account: (accountID && own.state.accounts[accountID]?.label) || accountID || "—",
      })
    }
    if (type === "preset_not_found") return text("own.preset.err.notFound")
    if (type === "preset_wrong_group") return text("own.preset.err.wrongGroup")
    if (type === "preset_builtin_locked") return text("own.preset.err.builtinLocked")
    if (type === "remote_managed") return text("own.preset.err.remote")
    if (type === "preset_target_unavailable") {
      const role = errorData<{ role: string }>(error).role
      const known = Preset.ROLES.find((item) => item === role)
      const key = role?.startsWith("pool:") ? role.slice("pool:".length) : undefined
      return text("own.preset.err.targetUnavailable", {
        role: known ? names.role(known) : key ? text("own.preset.pool.place", { key }) : (role ?? "—"),
      })
    }
    return errorMessage(i18n, error)
  }

  const title = () =>
    stored
      ? text("own.preset.editor.titleEdit", { group: names.group(group), name: stored.name })
      : text("own.preset.editor.titleNew", { group: names.group(group) })
  const shared = () => groupAccounts(group, accounts()).length

  return (
    <Dialog
      open
      size="wide"
      title={title()}
      onClose={props.onClose}
      testid="preset-editor"
      footer={
        <>
          <StatusLine status={status} testid="preset-editor-status" />
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {i18n.t("own.kit.cancel")}
          </button>
          <button
            type="button"
            class="own-btn"
            data-variant="primary"
            data-testid="preset-editor-save"
            disabled={busy() || !writable() || blocked().length > 0 || (tried() && issues().length > 0)}
            onClick={() => void save()}
          >
            {i18n.t("own.kit.save")}
          </button>
        </>
      }
    >
      <div class="own-pe" data-group={group}>
        <Show when={shared() > 0}>
          <p class="own-pe-shared" data-testid="preset-editor-shared">
            {text("own.preset.group.shared", { group: names.group(group), n: shared() })}
          </p>
        </Show>
        <Show when={missing}>
          <Notice tone="warn">{text("own.preset.editor.notFound")}</Notice>
        </Show>

        <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div class="min-w-[200px] flex-1">
            <TextField
              label={text("own.preset.editor.name")}
              value={draft().name}
              onValue={(name) => update({ ...draft(), name })}
              placeholder={text("own.preset.editor.namePlaceholder")}
              maxLength={80}
              error={
                tried() && issues().some((item) => item.code === "name")
                  ? text("own.preset.err.nameRequired")
                  : undefined
              }
              testid="preset-editor-name"
            />
          </div>
          <div class="own-pe-starters" aria-label={text("own.preset.editor.starters")} role="group">
            <span class="own-pe-hint">{text("own.preset.editor.starters")}:</span>
            <For each={suggestion()?.starters ?? []}>
              {(starter) => (
                <>
                  <button
                    type="button"
                    class="own-pe-chip"
                    disabled={!starter.available}
                    title={starter.available ? undefined : starterProblem(starter.problem)}
                    data-testid={`preset-starter-${starter.template}`}
                    onClick={() => void applyStarter(starter.template)}
                  >
                    {starter.available
                      ? text(`own.preset.starter.${starter.template}`)
                      : starterProblem(starter.problem)}
                  </button>
                  <Show when={starter.problem === "no-other-subscription" || starter.problem === "no-local"}>
                    <button
                      type="button"
                      class="own-link"
                      onClick={() => {
                        props.onClose()
                        router.navigate({ name: starter.problem === "no-local" ? "accountsAdd" : "accounts" })
                      }}
                    >
                      {text("own.preset.starter.setup")}
                    </button>
                  </Show>
                </>
              )}
            </For>
          </div>
        </div>

        <fieldset class="own-pe-q" data-testid="preset-editor-workers">
          <legend>{text("own.preset.editor.q1")}</legend>
          <For each={modes()}>
            {(mode) => (
              <>
                <label class="own-pe-choice" data-stacked="">
                  <input
                    type="radio"
                    name="preset-workers"
                    value={mode}
                    checked={draftMode(draft()) === mode}
                    aria-labelledby={`${uid}-${mode}`}
                    aria-describedby={`${uid}-${mode}-hint`}
                    onChange={() => update(withMode(draft(), mode, kept()))}
                  />
                  <span class="own-pe-choice-text">
                    <span id={`${uid}-${mode}`}>{text(MODE[mode])}</span>
                    <span id={`${uid}-${mode}-hint`} class="own-pe-hint" data-testid="preset-editor-mode-hint">
                      {text(MODE_HINT[mode])}
                    </span>
                  </span>
                </label>
                <Show when={mode === "pool" && draftMode(draft()) === "pool"}>
                  <PoolList
                    group={group}
                    draft={draft()}
                    update={update}
                    offer={suggestion()?.pool}
                    main={main()}
                    facts={props.request.pool}
                    tried={tried()}
                  />
                </Show>
                <Show when={mode === "single" && draftMode(draft()) === "single"}>
                  <div
                    class="own-pe-single"
                    classList={{ "rounded-md bg-own-accent-soft": focus === "single" }}
                    data-testid="preset-editor-single"
                  >
                    <Show
                      when={draft().workers.single}
                      fallback={<span class="text-own-faint">{text("own.preset.editor.singleNone")}</span>}
                    >
                      {(target) => <span>{names.target(target())}</span>}
                    </Show>
                    <Source place="single" />
                    <Retirement target={draft().workers.single} />
                    <button type="button" class="own-btn" data-size="sm" onClick={() => setPicker("single")}>
                      {draft().workers.single ? text("own.preset.editor.change") : text("own.preset.editor.pickTarget")}{" "}
                      ▾
                    </button>
                    <Show when={tried() && issues().some((item) => item.code === "single")}>
                      <span class="text-[12px] text-own-danger">{text("own.preset.err.singleTarget")}</span>
                    </Show>
                  </div>
                </Show>
              </>
            )}
          </For>
          <Show when={draftMode(draft()) === "by-role"}>
            <div class="own-pe-roles" data-testid="preset-editor-roles">
              <For each={shownRoles(draft(), added())}>{(role) => <RoleRow role={role} />}</For>
              <Show when={EXTRA_ROLES.some((role) => !shownRoles(draft(), added()).includes(role))}>
                <div class="py-2">
                  <button
                    type="button"
                    class="own-link"
                    data-testid="preset-editor-add-role"
                    onClick={() => setAdded((list) => [...list, ...EXTRA_ROLES.filter((role) => !list.includes(role))])}
                  >
                    {text("own.preset.editor.addRole", {
                      roles: EXTRA_ROLES.filter((role) => !shownRoles(draft(), added()).includes(role))
                        .map((role) => names.role(role))
                        .join(", "),
                    })}
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </fieldset>

        <fieldset class="own-pe-q" data-testid="preset-editor-delegation">
          <legend>{text("own.preset.editor.q2")}</legend>
          <For each={DELEGATIONS}>
            {(value) => (
              <label class="own-pe-choice">
                <input
                  type="radio"
                  name="preset-delegation"
                  value={value}
                  checked={draft().delegation === value}
                  onChange={() => update(withDelegation(draft(), value))}
                />
                <span class="min-w-[90px]">{text(DELEGATION[value])}</span>
                <span class="own-pe-hint">{text(HINT[value])}</span>
              </label>
            )}
          </For>
          <Show when={draft().delegation === "off"}>
            <p class="own-pe-hint m-0">{text("own.preset.delegation.offNote")}</p>
          </Show>
        </fieldset>

        <p class="own-pe-caps m-0" data-testid="preset-editor-caps">
          <b class="mr-2 font-semibold text-own-text">{text("own.preset.caps.title")}</b>
          {capsText(Preset.caps(draft(), false))} {text("own.preset.caps.inDetail")}
        </p>

        <ResolutionLine />

        <Show when={detail()}>
          <div>
            <button
              type="button"
              class="own-link"
              aria-expanded={details()}
              data-testid="preset-editor-details"
              onClick={() => setDetails((open) => !open)}
            >
              {text("own.preset.detail")} {details() ? "▾" : "▸"}
            </button>
          </div>
        </Show>
        <Show when={details() && detail()}>
          {(panel) => (
            <Suspense>
              <Dynamic
                component={panel()}
                draft={draft()}
                update={update}
                main={main()}
                resolution={resolution()}
                roles={shownRoles(draft(), added())}
                lighter={lighter()}
                local={local}
                offer={suggestion()?.pool}
                facts={props.request.pool}
                focusRole={focus}
                block={block}
                errorText={saveError}
              />
            </Suspense>
          )}
        </Show>

        <Show when={r4()}>
          {(accountID) => (
            <Notice tone="danger" testid="preset-editor-r4">
              {text("own.preset.err.sameCompany", { account: own.state.accounts[accountID()]?.label ?? accountID() })}
            </Notice>
          )}
        </Show>
      </div>

      <Show when={picker()}>
        {(place) => (
          <TargetPicker
            group={group}
            place={place()}
            draft={draft()}
            main={main()}
            lighter={lighter()}
            local={local}
            onPick={(target) => choose(place(), target)}
            onClose={() => setPicker(undefined)}
          />
        )}
      </Show>
    </Dialog>
  )

  function starterProblem(problem: Preset.StarterProblem | undefined) {
    if (problem === "local-group") return text("own.preset.starter.noLighter")
    if (problem === "no-local") return text("own.preset.starter.noLocal")
    const home = Preset.isLocal(group) ? undefined : Preset.company({ kind: group })
    if (home === "openai") return text("own.preset.starter.noClaude")
    if (home === "anthropic") return text("own.preset.starter.noChatGPT")
    return text("own.preset.starter.noSubscription")
  }

  function capsText(caps: Preset.Caps) {
    return [
      text("own.preset.caps.concurrent", { n: caps.concurrent }),
      text("own.preset.caps.perMessage", { n: caps.perMessage }),
      caps.perSession === null
        ? text("own.preset.caps.perSessionNone")
        : text("own.preset.caps.perSession", { n: caps.perSession }),
    ].join(" · ")
  }

  function Source(sourceProps: { readonly place: Preset.Place }) {
    const value = () => provenance(draft(), sourceProps.place, chosen(), suggestion())
    return (
      <Show when={value()}>
        {(source) => (
          <span class="own-pe-src" data-source={source()} data-testid="preset-source">
            {text(source() === "suggested" ? "own.preset.source.suggested" : "own.preset.source.user")}
          </span>
        )}
      </Show>
    )
  }

  /** A pinned model's Codex retirement date, dimmed beside its row (07 §4.3): no notice, no successor (U3). */
  function Retirement(dateProps: { readonly target: Preset.Target | undefined }) {
    const at = () => dateProps.target && retirementOf(view(), dateProps.target)
    return (
      <Show when={at()}>
        {(value) => (
          <span class="text-[12px] text-own-faint" data-testid="preset-retirement">
            {text("own.preset.retirement", { date: monthDay(value()) })}
          </span>
        )}
      </Show>
    )
  }

  /** One role row (07 §7.1): its targets in order, what it resolves to now, `[바꾸기]`. */
  function RoleRow(rowProps: { readonly role: Preset.Role }) {
    const role = rowProps.role
    const row = () => draft().workers.roles[role]
    const summary = () => {
      const targets = row()?.targets ?? []
      if (targets.length === 0) return text("own.preset.target.main")
      const label = (target: Preset.Target) =>
        "pin" in target ? text("own.preset.editor.pinned", { label: names.target(target) }) : names.target(target)
      if (targets.length === 1 && "rel" in targets[0]!) return label(targets[0]!)
      return [
        ...targets.map((target, index) => `${text("own.preset.editor.rank", { n: index + 1 })} ${label(target)}`),
        text("own.preset.editor.lastMain"),
      ].join(" → ")
    }
    const detailLine = () => {
      const first = row()?.targets[0]
      const resolved = resolution()?.roles[role]?.targets[0]
      const current = main()
      if (!first) return undefined
      if (resolved?.skip === "lighter-unknown") return text("own.preset.editor.lighterUnknown")
      if (resolved?.skip === "lighter-missing") return text("own.preset.editor.lighterMissing")
      if (resolved?.skip === "r4") return text("own.preset.editor.blocked")
      if (resolved?.skip === "unavailable") return text("own.preset.editor.unavailable")
      if ("rel" in first) {
        if (!current || !resolved?.ref) return undefined
        if (resolved.ref.id === current.ref.id) return text("own.preset.lighter.none")
        return text("own.preset.editor.nowMain", {
          main: names.model(current.ref.providerID, current.ref.id),
          target: names.model(resolved.ref.providerID, resolved.ref.id),
        })
      }
      const badge = names.badgeText(names.badge(first))
      const account = own.state.accounts[first.pin.account]
      if (!account || account.billing === "subscription" || account.billing === "local") return badge
      const spent = spend.of(account.id)
      const amount = spent === undefined ? "—" : usd(spent, true)
      return `${badge} · ${
        account.budget
          ? text("own.preset.editor.spend", { spent: amount, budget: usd(account.budget.monthlyUSD, true) })
          : text("own.preset.editor.spendNoBudget", { spent: amount })
      }`
    }
    return (
      <div
        class="own-pe-role"
        classList={{ "rounded-md bg-own-accent-soft": focus === role }}
        data-role={role}
        data-focus={focus === role ? "" : undefined}
        data-testid="preset-editor-role"
      >
        <span class="own-pe-role-name">{names.role(role)}</span>
        <div class="own-pe-role-body">
          <span>
            {summary()}
            <Source place={role} />
          </span>
          <Show when={detailLine()}>
            <span class="own-pe-sub">{detailLine()}</span>
          </Show>
          <Retirement target={row()?.targets[0]} />
        </div>
        <div class="own-pe-role-actions">
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="preset-editor-change"
            onClick={() => setPicker(role)}
          >
            {text("own.preset.editor.change")}
          </button>
          <Show when={EXTRA_ROLES.includes(role)}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              data-variant="ghost"
              onClick={() => {
                update(withoutRole(draft(), role))
                setAdded((list) => list.filter((item) => item !== role))
              }}
            >
              {text("own.preset.editor.removeRole")}
            </button>
          </Show>
        </div>
      </div>
    )
  }

  /** `지금 메인(GPT-6 Astra · high)이면: 탐색 = GPT-6 Luna · high, … [복사]` (07 §7.1 last line). */
  function ResolutionLine() {
    const line = createMemo(() => {
      const current = resolution()
      return current && resolutionLine(draft(), current)
    })
    const copy = async () => {
      const value = line()
      if (!value) return
      const ok = await copyText(copyLines(value))
      showToast({ message: text(ok ? "own.preset.copied" : "own.preset.copyFailed"), tone: ok ? "neutral" : "danger" })
    }
    const items = () => {
      const value = line()
      if (!value || value.kind === "same") return text("own.preset.resolve.allMain")
      if (value.kind === "single")
        return value.fallback
          ? text("own.preset.resolve.singleFallback", { target: names.ref(value.ref) })
          : text("own.preset.resolve.single", { target: names.ref(value.ref) })
      if (value.kind === "pool") {
        if (value.items.length === 0) return text("own.preset.pool.empty")
        return value.items
          .map((item) =>
            item.ref
              ? text("own.preset.resolve.role", { role: item.key, target: names.ref(item.ref) })
              : text("own.preset.pool.skipped", { key: item.key }),
          )
          .join(", ")
      }
      return value.items
        .map((item) =>
          text(item.fallback ? "own.preset.resolve.fallback" : "own.preset.resolve.role", {
            role: names.role(item.role),
            target: names.ref(item.ref),
          }),
        )
        .join(", ")
    }
    return (
      <Show when={main()} fallback={<p class="own-pe-line m-0 text-own-muted">{text("own.preset.resolve.noMain")}</p>}>
        {(current) => (
          <p class="own-pe-line m-0" data-testid="preset-editor-resolution">
            <span>{text("own.preset.resolve.lead", { main: names.ref(current().ref) })}</span>
            <span>{items()}</span>
            <Show when={line() && copyLines(line()!) !== ""}>
              <button type="button" class="own-link" data-testid="preset-editor-copy" onClick={() => void copy()}>
                [{text("own.preset.copy")}]
              </button>
            </Show>
          </p>
        )}
      </Show>
    )
  }
}
