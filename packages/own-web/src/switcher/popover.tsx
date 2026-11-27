// "모델 @ 계정" switcher popover (03 §5.2, §11, §12), a lazy chunk. Two listboxes (accounts grouped by provider kind,
// models of the chosen account) driven from one search combobox that keeps focus (`aria-activedescendant`), a live
// `switch.estimate` footer and the Apply button whose label follows 03 §6.2. The search input is never replaced while
// composing Korean (rule 5); its Enter only commits a composition and applies on the next press (rule 8 exception).
// T1 (07 §5.3, §5.5, §7.3; 06 §9.5, §10.1): another provider group's account adds `프리셋: <지금> → <다음>(<묶음>)`
// under the cost line; subagents on the subscription the main leaves add `<옛 계정>에서 하위 에이전트 n개가 실행
// 중입니다` and send the switch to the dialog. In a team session the routes of team-flow.ts apply: an owner
// conversation and an area main list no other subscription of a team company (with the greyed `다른 <회사> 계정은 팀에
// 넣을 수 없어 목록에 없습니다` line), and on the team main such an account is 팀 계정 바꾸기. Opened on an area main
// (`openSwitcher({mode: "area"})`) the list starts with `팀과 같게` and applying sets `area.main`. Opened to pick a
// model for a new area (`openSwitcherToPick`, 영역 만들기, 2026-10-26) it lists the same way and only hands the choice
// back (`팀과 같게` = `null`): nothing is switched or estimated.
// T2 (07 §4.3, §7.3): a model the account's pinned template gained lately carries `새`, and a model with a Codex
// retirement date shows it dimmed; neither is announced and nothing changes by itself (U3).
// 04 §8.11.13: on an SSH host the Claude slot's models come only while this PC relays it there; until then the models
// column says why (`servers/claude.ts`) with the way to fix it, and a relayed Claude account carries `PC 경유`.
// 02 §4.8 (2026-10-10): beside the effort, in a strip under both columns (always in view), a `속도` row for the
// highlighted account and model (its `speed.offers`, read again on every move), grey with the reason when it has none. Applying sets a new conversation's speed, a session's
// speed with the same dry run and dialogs as the composer, or (with a model change) the speed once the switch landed.
import type { Account, Speed } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import "./popover.css"
import {
  afterSwitch,
  dropAfterSwitch,
  pendingChoice,
  requestSpeed,
  targetView,
  watchTargetOffers,
  type SpeedEnv,
} from "@/composer/speed-flow"
import { items, noneNote, offerBadge, offerNote, speedName, type Shown } from "@/composer/speed"
import { SpeedMark } from "@/composer/speed-mark"
import { claudeAccountName } from "@/accounts/claude-name"
import { isLocal } from "@/accounts/local-model"
import { useLocalText } from "@/accounts/local-strings"
import { useData, type ServerRuntime } from "@/data"
import { useHost } from "@/host"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { createImeEnter } from "@/ime/ime-enter"
import { eventCode } from "@/keyboard"
import { inputSampler } from "@/perf/event-timing"
import { groupOfAccount, hiddenOf, hideWithUndo, showAgain } from "@/presets/hidden"
import { monthDay } from "@/presets/model"
import { usePresetFixesText } from "@/presets/pf-strings"
import { mainGroup, presetInEffect } from "@/presets/session-view"
import { usePresetsText } from "@/presets/strings"
import { useCodexModelsText } from "@/accounts/codex-models-strings"
import { useRemoteText } from "@/remote/strings"
import { useRouter } from "@/routing/router"
import { remoteStore } from "@/servers/active"
import { claudeEmpty, serverClaude, viaPc, type ClaudeFix } from "@/servers/claude"
import { selectHostPanel } from "@/servers/panel"
import { useServersText } from "@/servers/strings"
import { limitDensity } from "@/limits/display"
import { resetText } from "@/limits/format"
import { ResetCreditCount } from "@/limits/reset-credits"
import { LimitSummaryLine } from "@/limits/summary-line"
import { minuteNow } from "@/shell/clock"
import { modelLabel } from "@/sidebar/model"
import { decide, sameRef, type Decision, type TargetRef } from "./cost"
import { switcherControl, type OpenState } from "./control"
import { childWaitText, costText, footerCost, warningNotes } from "./describe"
import { type EstimateState } from "./estimate"
import {
  chooseNewSessionTarget,
  confirmThresholds,
  continuingChildren,
  currentRef,
  estimatorFor,
  reasonOf,
  requestSwitch,
  withChildWait,
  type FlowEnv,
} from "./flow"
import { formatTokens } from "./format"
import { newSessionDirectory, newSessionLookup, newSessionTarget } from "./new-session"
import {
  accountOf,
  cacheText,
  catalog,
  catalogFailed,
  ensureCatalog,
  kindName,
  modelName,
  namedVariant,
  offered,
  slotOf,
  variantName,
} from "./labels"
import {
  filterModels,
  groupAccounts,
  keepVariant,
  matchesQuery,
  modelForAccount,
  modelMarks,
  recommendedAccounts,
  rowModel,
  rowSelection,
  step,
  teamAccounts,
  unusable,
  type Picked,
  type PickerModel,
} from "./picker"
import {
  applyAreaMain,
  areaOf,
  companyName,
  pickOf,
  presetLineFor,
  routeOf,
  teamSwitchRequired,
  textOf,
  type SwitchRoute,
} from "./team-flow"

export interface SwitcherPopoverProps {
  readonly runtime: ServerRuntime
  readonly request: OpenState
  readonly onClose: () => void
}

interface PickerState {
  query: string
  column: 0 | 1
  accountID?: string
  modelID?: string
  variant?: string
  /**
   * The user's explicit choice of model and effort (./picker `Picked`): the conversation's at open, a model or effort
   * of the model column, a target. Every row ranks with it and selecting a row maps it (`rowSelection`); moving between
   * accounts never changes it.
   */
  picked?: Picked
  /** Area mode: `팀과 같게` is chosen (`area.main{model: null}`); account and model then show the team main's. */
  same: boolean
  estimate: EstimateState
  /** The `속도` row's choice (02 §4.8); follows what the session or the new conversation has until it is touched. */
  speed: Speed.Choice
  speedTouched: boolean
}

const PHONE_MAX = 600
/** The `팀과 같게` row's place among the account ids of the accounts column (area mode). */
const SAME = "team-same"

/** Kinds whose several accounts share one provider and move a conversation's tree by hand (02 §8.7, §8.10). */
const SHARED: ReadonlySet<string> = new Set(["claude-sub", "claude-agent"])

export default function SwitcherPopover(props: SwitcherPopoverProps) {
  const i18n = useI18n()
  const host = useHost()
  const router = useRouter()
  const data = useData()
  const presets = usePresetsText()
  const codexText = useCodexModelsText()
  const remoteText = useRemoteText()
  const serversText = useServersText()
  const runtime = props.runtime
  const own = runtime.own
  const fixes = usePresetFixesText()
  // 07 §7.1 숨긴 모델 (PF 2026-11-03): the server's hidden models, out of the model column unless shown again.
  const hidden = hiddenOf(own)
  const [hiddenOpen, setHiddenOpen] = createSignal(false)
  const env: FlowEnv = {
    runtime,
    serverKey: props.request.serverKey,
    i18n,
    navigate: (route) => router.navigate(route),
  }
  const team = textOf(i18n)
  const lookup: Preset.Lookup = (accountID) => own.state.accounts[accountID]

  // ---- area mode (06 §10.1 `메인 바꾸기…`): the area's owner conversation stands in for the session ----
  const area = createMemo(() => areaOf(props.request.seq))
  // ---- pick mode (영역 만들기, 2026-10-26): no conversation; the team main's context, the choice handed back ----
  const pick = createMemo(() => pickOf(props.request.seq))
  const areaView = () => {
    const target = area()
    return target ? runtime.team.area(target.teamID, target.areaID) : undefined
  }
  const teamMain = () => {
    const teamID = area()?.teamID ?? pick()?.teamID
    return teamID ? runtime.team.team(teamID)?.team.main.sessionID : undefined
  }
  /** Pick mode: the team's main folder, where the new area's models are listed from. */
  const pickHome = () => {
    const teamID = pick()?.teamID
    return teamID ? runtime.team.team(teamID)?.team.home.directory : undefined
  }
  /** The team main's Ref: what `팀과 같게` follows. */
  const teamRef = () => {
    const id = teamMain()
    return id ? currentRef(runtime, id) : undefined
  }
  const sessionID = () => (area() ? (areaView()?.owner.sessionID ?? undefined) : props.request.sessionID)
  const directory = () => {
    const id = sessionID()
    if (id) return runtime.data.session.get(id)?.location.directory ?? runtime.sessions.directory(id)
    return areaView()?.directory ?? pickHome() ?? newSessionDirectory(runtime, router.route())
  }
  /**
   * The folder model names and lists are read from: the session's or area's, else the new-session screen's lookup,
   * which skips a default conversation folder not created yet (its Location answers 404, ML); the composer reads the same.
   */
  const modelFolder = () => (sessionID() || area() || pick() ? directory() : newSessionLookup(runtime, router.route()))
  // The area's conversations are rarely on screen: read their bindings (`currentRef`) while the switcher is open.
  createEffect(() => {
    const ids = area() || pick() ? [areaView()?.owner.sessionID, teamMain()].flatMap((id) => (id ? [id] : [])) : []
    if (ids.length) onCleanup(own.watchVisible(ids))
  })
  // Home route: the combination the composer shows for the next new session (03 §5.1). An area without a
  // conversation: its own main, else the team main's.
  const current = createMemo<TargetRef | null | undefined>(() => {
    const id = sessionID()
    if (id) return currentRef(runtime, id)
    const picking = pick()
    if (picking) return picking.current ?? teamRef()
    if (area()) return areaView()?.main?.model ?? teamRef()
    return newSessionTarget(runtime, props.request.serverKey, directory())
  })

  // ---- team context (06 §10.1, 07 §5.5): the root's binding names the team's accounts ----
  /** Whose binding to read: the session, else (an area without a conversation) the team main. */
  const bound = () => sessionID() ?? teamMain()
  createEffect(() => {
    const id = bound()
    if (!id || runtime.data.session.get(id)?.parentID) return
    onCleanup(own.watchPreset(id))
  })
  const teamOf = () => {
    const id = bound()
    return id ? own.state.sessionPreset[id]?.binding?.team : undefined
  }
  // Roles come from the registry: make sure it is read once this server's session is a team's.
  createEffect(() => {
    if (teamOf() || area() || pick()) runtime.team.ensure()
  })
  /** An owner conversation and an area main list no other subscription of a team company (06 §10.1). */
  const filtersTeam = () => area() !== undefined || pick() !== undefined || teamOf()?.role === "owner"
  const hasTurns = () => {
    const id = sessionID()
    if (!id) return false
    // An owner conversation off screen has no cache state here: its estimate tells (`P = 0` decides `new`).
    if (area()) return true
    const P = own.state.cache[id]?.compaction?.P
    return (P ?? 0) > 0 || runtime.data.session.message.list(id).length > 0
  }
  const [confirm, setConfirm] = createSignal<Awaited<ReturnType<typeof confirmThresholds>>>()
  void confirmThresholds(runtime).then(setConfirm)
  ensureCatalog(runtime, modelFolder(), true)

  const [state, setState] = createStore<PickerState>({
    query: "",
    column: 0,
    same: false,
    estimate: { status: "idle" },
    speed: "standard",
    speedTouched: false,
  })
  let input: HTMLInputElement | undefined
  let root: HTMLDivElement | undefined

  // ---- data ----
  // The team's R4 filter (06 §10.1): `hidden` names the companies whose other subscriptions were left out.
  const listed = createMemo(() => {
    const all = own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account ? [account] : []
    })
    const context = teamOf()
    return context && filtersTeam() ? teamAccounts(all, context, lookup) : { shown: all, hidden: [] }
  })
  const accounts = () => listed().shown
  // Models per provider, built once per catalog change (search and keys then only look up).
  const byProvider = createMemo(() => {
    const map = new Map<string, PickerModel[]>()
    for (const model of catalog(runtime, modelFolder())) {
      // A model the catalog dropped runs on in its sessions but is not offered (07 §4.4).
      if (!offered(model)) continue
      const list = map.get(model.providerID) ?? []
      // A catalog that names a model by its id (the Claude slot's `claude-opus-5-5`) reads in words (UX 2026-10-26).
      list.push({
        id: model.id,
        name: modelLabel(model.id, model.name),
        variants: model.variants.map((variant) => variant.id),
      })
      map.set(model.providerID, list)
    }
    return map
  })
  const models = (account: Account.View | undefined): readonly PickerModel[] =>
    (account && byProvider().get(account.providerID)) || []
  /** This PC's Claude relay on an SSH host (04 §8.11); `undefined` on this PC. */
  const claude = () => serverClaude(runtime)
  /** Why the chosen Claude account lists no model on this host, instead of an endless `불러오는 중`. */
  const claudeBlocked = () => claudeEmpty(claude(), account()?.kind, models(account()).length)
  // The relay verdict changes without an own.remote event: read the hosts' broker views on every open on a host.
  createEffect(
    on(
      () => props.request.seq,
      () => {
        if (runtime.kind === "ssh") void remoteStore()?.refreshBroker()
      },
    ),
  )
  const groups = createMemo(() => {
    const query = state.query
    return groupAccounts(accounts(), props.request.candidates ?? []).flatMap((group) => {
      const name = kindName(i18n, group.kind)
      const list = group.accounts.filter((account) =>
        matchesQuery(
          query,
          account,
          name,
          models(account).map((model) => model.name),
        ),
      )
      return list.length ? [{ kind: group.kind, name, accounts: list }] : []
    })
  })
  const visibleAccounts = createMemo(() => [
    ...((area() || pick()) && !state.query.trim() ? [SAME] : []),
    ...groups().flatMap((group) => group.accounts.map((account): string => account.id)),
  ])
  const account = () => (state.accountID ? own.state.accounts[state.accountID] : undefined)
  /**
   * 02 §8.7: the session's own Claude account (its binding), when it runs on `anthropic`; several Claude accounts share
   * that provider, so the provider alone does not say which one. 02 §8.10: the same for the Claude Agent accounts.
   */
  const boundClaude = () => {
    const id = sessionID()
    const bound = id ? own.state.binding[id] : undefined
    const owner = bound?.accountID ? own.state.accounts[bound.accountID] : undefined
    return owner && SHARED.has(owner.kind) ? owner : undefined
  }
  /** The account this session runs on now, for the `현재` mark and the first selection. */
  const runningOn = (providerID: string) => {
    const claude = boundClaude()
    return claude?.providerID === providerID ? claude : accountOf(runtime, providerID)
  }
  const accountMatched = () => {
    const selected = account()
    if (!selected || !state.query.trim()) return true
    return matchesQuery(state.query, selected, kindName(i18n, selected.kind), [])
  }
  /** The selected account's group its models are hidden under; `undefined` for a provider without an own account. */
  const hiddenGroup = () => {
    const selected = account()
    return selected ? groupOfAccount(selected.id, own.state.accounts) : undefined
  }
  /** A hidden model of the selected account, unless it is the one the conversation runs or the one picked. */
  const tucked = (id: string) =>
    hidden.is(hiddenGroup(), id) &&
    id !== state.modelID &&
    !(current()?.providerID === account()?.providerID && current()?.id === id)
  const hiddenCount = createMemo(() => models(account()).filter((item) => tucked(item.id)).length)
  /**
   * 목록에서 숨기기 / 다시 보이기 of a row (CAM-9). The picked model is moved to its neighbour first, so the row leaves
   * the list at once (a picked model stays listed, and hiding the one just picked looked like nothing happened); a
   * toast offers the way back, and a refused change says why.
   */
  const toggleHidden = (item: PickerModel) => {
    const group = hiddenGroup()
    if (group === undefined) return
    if (hidden.is(group, item.id)) return showAgain({ hidden, group, modelID: item.id, text: fixes })
    const list = modelList().filter((entry) => entry.id !== item.id && !tucked(entry.id))
    const index = modelList().findIndex((entry) => entry.id === item.id)
    const next = list[Math.min(index, list.length - 1)]
    if (state.modelID === item.id && next) selectModel(next.id)
    hideWithUndo({ hidden, group, model: item, text: fixes })
  }
  const modelList = createMemo(() =>
    filterModels(state.query, accountMatched(), models(account())).filter((item) => hiddenOpen() || !tucked(item.id)),
  )
  const model = () =>
    modelList().find((item) => item.id === state.modelID) ?? models(account()).find((item) => item.id === state.modelID)
  /**
   * 07 §2.3 강도 고정 (PF 2026-11-03): the level the conversation's preset fixes, fitted to the selected model; the
   * strip says so, and an effort picked by hand is an override until the preset is applied again or the model moves.
   */
  const forced = createMemo(() => {
    const id = sessionID()
    const selected = model()
    if (!id || !selected?.variants.length) return undefined
    const group = mainGroup(current(), (providerID) => accountOf(runtime, providerID, id))
    if (!group) return undefined
    const preset = presetInEffect(group, own.state.sessionPreset[id], own.state.presetGroups[group])
    const level = Preset.forcedEffortOf(preset.forcedEffort)
    if (!level) return undefined
    const fit = Preset.forcedFit(level, selected.variants)
    return fit.unplaced ? undefined : { preset: preset.name, level, fit }
  })
  /** The chosen Ref; none while `팀과 같게` is chosen (the area then has no main of its own). */
  const target = createMemo<TargetRef | undefined>(() => {
    const selected = account()
    if (state.same || !selected || !state.modelID) return undefined
    return { providerID: selected.providerID, id: state.modelID, variant: state.variant }
  })
  /** How applying goes for this session (team-flow.ts): plain, the area main of an owner, or 팀 계정 바꾸기. */
  const route = createMemo<SwitchRoute>(() => {
    const id = sessionID()
    const ref = target()
    return id && ref ? routeOf(runtime, id, ref) : { kind: "plain" }
  })

  // ---- speed (02 §4.8, 2026-10-10): the highlighted main's offers, read again on every account or model move ----
  const speedEnv: SpeedEnv = {
    runtime,
    serverKey: props.request.serverKey,
    i18n,
    fastAck: () => data.local().rpc.call("plugin.claudeAuth.fastAck", {}),
  }
  /** A root session or a new conversation: a child follows its root's speed, an area main has none of its own. */
  const speedHere = () => {
    const id = sessionID()
    return (
      !area() &&
      !pick() &&
      !(id && runtime.data.session.get(id)?.parentID) &&
      own.state.status === "ready" &&
      own.rpc.allowed("speed.offers")
    )
  }
  watchTargetOffers(own, () => (speedHere() ? target() : undefined))
  /** What applying keeps: the session's choice, or the new conversation's pending one. */
  const currentSpeed = (): Speed.Choice => {
    const id = sessionID()
    return id ? (own.state.sessionSpeed[id]?.choice ?? "standard") : pendingChoice(props.request.serverKey).choice
  }
  /** The row: the chosen speed resolved on what the highlighted main offers. */
  const speedView = createMemo<Shown | undefined>(() => {
    if (!speedHere()) return undefined
    // A pick here asks the Claude consent on apply, so it shows as picked; until then what would be sent now.
    const consented = state.speedTouched || (!sessionID() && pendingChoice(props.request.serverKey).consent)
    return targetView(own, target(), state.speed, consented)
  })
  // A session's view may arrive after opening: the row follows it until the user picks a speed.
  createEffect(
    on(currentSpeed, (value) => {
      if (!state.speedTouched) setState("speed", value)
    }),
  )
  const speedSettable = () => !sessionID() || own.rpc.allowed("session.speed.set")
  const speedChanged = () => state.speedTouched && speedView() !== undefined && state.speed !== currentSpeed()
  /** The row's note: why it is grey, or that the choice falls back on this main. */
  const speedNote = (view: Shown) => {
    if (view.offers.length === 0 && view.fixed === undefined) return noneNote(i18n, view)
    if (view.fixed !== undefined || view.choice === view.effective) return undefined
    return i18n.t("own.speed.fell", {
      choice: speedName(i18n, view.choice),
      effective: speedName(i18n, view.effective),
    })
  }

  // ---- selection ----
  function selectAccount(accountID: string) {
    if (accountID === SAME) return selectSame()
    const next = own.state.accounts[accountID]
    if (!next) return
    // The row's own model (`modelOf`): the picked one where the account offers it, else that provider group's default
    // with its effort (07 §2.2, PG12 (e)). The picked model stays, so the rows never follow the cursor.
    setState({
      ...rowSelection(state.picked, accountID, models(next), own.state.groupDefaults[next.kind]),
      same: false,
    })
  }
  /** `팀과 같게` (area mode): the columns show what it follows now, the team main's account and model. */
  function selectSame() {
    const ref = teamRef()
    // The team main's own account (SL-8: the Claude accounts share `anthropic`).
    const owner = ref ? accountOf(runtime, ref.providerID, teamMain()) : undefined
    setState({ same: true, accountID: owner?.id ?? state.accountID, modelID: ref?.id, variant: ref?.variant })
  }
  function selectModel(modelID: string) {
    const chosen = models(account()).find((item) => item.id === modelID)
    const variant = keepVariant(state.variant, chosen) ?? chosen?.variants[0]
    setState({ modelID, variant, picked: { id: modelID, name: chosen?.name, variant }, same: false })
  }
  /** An effort of the selected model: that model and effort become the picked ones. */
  function selectVariant(variant: string) {
    const id = state.modelID
    setState({ variant, same: false, ...(id ? { picked: { id, name: model()?.name, variant } } : {}) })
  }
  function selectTarget(ref: TargetRef) {
    // A Claude target keeps the conversation's own Claude account (02 §8.7): the provider names only the first one.
    const owner = accountOf(runtime, ref.providerID, sessionID())
    if (!owner) return
    const picked = { id: ref.id, name: modelName(runtime, ref), variant: ref.variant }
    setState({ accountID: owner.id, modelID: ref.id, variant: ref.variant, picked, column: 1, same: false })
  }

  // Reset on every open (the popover component stays mounted while `seq` changes), and once more when an area's
  // registry record arrives after opening.
  const areaLoaded = createMemo(() => areaView() !== undefined)
  createEffect(
    on([() => props.request.seq, areaLoaded], () => {
      const request = props.request
      const base = current()
      setState({
        query: "",
        column: 0,
        // The conversation's model is the picked one until the user picks another.
        picked: base ? { id: base.id, name: modelName(runtime, base), variant: base.variant } : undefined,
        same: false,
        estimate: { status: "idle" },
        speed: currentSpeed(),
        speedTouched: false,
      })
      if (input) input.value = ""
      if (request.target) return selectTarget(request.target)
      // An area that follows the team starts on `팀과 같게` (06 §10.1), and so does a pick without a model yet.
      if (area() && !areaView()?.main) return selectSame()
      if (pick() && !pick()?.current) return selectSame()
      const preset = request.accountID ? own.state.accounts[request.accountID] : undefined
      const fromCurrent = base ? runningOn(base.providerID) : undefined
      const first = visibleAccounts().find((id) => id !== SAME)
      const chosen = preset ?? fromCurrent ?? (first ? own.state.accounts[first] : undefined)
      if (!chosen) return
      if (base && chosen.providerID === base.providerID)
        return setState({ accountID: chosen.id, modelID: base.id, variant: base.variant })
      setState({ accountID: chosen.id, modelID: base?.id, variant: base?.variant })
      selectAccount(chosen.id)
    }),
  )

  // The catalog may arrive after opening: pick a model once the account's list is known.
  createEffect(() => {
    const list = models(account())
    if (!list.length || list.some((item) => item.id === state.modelID)) return
    const selected = account()
    // What selecting the row chooses (`rowSelection`); `팀과 같게` shows the team main's model.
    const chosen = modelForAccount(
      state.same ? (state.modelID ? { id: state.modelID, variant: state.variant } : undefined) : state.picked,
      list,
      selected && own.state.groupDefaults[selected.kind],
    )
    if (chosen) setState({ modelID: chosen.model.id, variant: chosen.variant })
  })

  // Search hides the selected account: move to the first visible one (keeping the model when possible).
  createEffect(
    on(visibleAccounts, (ids) => {
      if (!ids.length || (state.accountID && ids.includes(state.accountID))) return
      selectAccount(ids[0]!)
    }),
  )

  // ---- estimate (debounced 150 ms, cached 30 s) ----
  // 팀 계정 바꾸기 is planned by own.team (`team.account{dryRun}`) when applied: own.accounts would answer the
  // estimate with `team_switch_required`.
  const estimator = estimatorFor(runtime)
  createEffect(() => {
    const id = sessionID()
    const ref = target()
    if (!id || !ref || !hasTurns() || sameRef(current(), ref) || route().kind === "team-account") {
      estimator.cancel()
      return setState("estimate", { status: "idle" })
    }
    // Another Claude account's row (either route, CAG-53): the router reads that account's cache (SL-8), not the
    // conversation's.
    const selected = account()
    const claude =
      claudeMoves() && (selected?.kind === "claude-sub" || selected?.kind === "claude-agent") ? selected.id : undefined
    estimator.schedule(id, { ...ref }, (next) => setState("estimate", next), claude)
  })
  onCleanup(() => estimator.cancel())

  const ready = () => (state.estimate.status === "ready" ? state.estimate.result : undefined)
  /** 팀 계정 바꾸기: known from the binding, or told by own.accounts (`team_switch_required`, 07 §5.5). */
  const teamAccount = () =>
    route().kind === "team-account" ||
    (state.estimate.status === "error" && teamSwitchRequired(state.estimate.error) !== undefined)
  const decision = createMemo<Decision | undefined>(() => {
    const result = ready()
    const ref = target()
    const thresholds = confirm()
    const id = sessionID()
    if (!result || !ref || !thresholds || !id) return undefined
    const base = current()
    const slot = base ? slotOf(own.state.cache[id], base.providerID, own.state.binding[id]?.accountID) : undefined
    return withChildWait(
      decide({
        estimate: result,
        current: base,
        target: ref,
        confirm: thresholds,
        dialogAtTokens: switcherControl.state.override[id],
        currentCold: slot?.state === "cold",
      }),
      result,
    )
  })
  const busy = () => {
    const id = sessionID()
    return id ? runtime.data.session.status(id) === "running" : false
  }
  /**
   * The model an account's row would run (./picker `rowModel`): the picked model where the account offers it, else its
   * default; selecting the row chooses exactly it, and the cursor never changes it. Its line, `한도 도달` and `추천`
   * rank with it.
   */
  const modelOf = (item: Account.View) => rowModel(state.picked, models(item), own.state.groupDefaults[item.kind])
  const problem = () => {
    const selected = account()
    return selected ? unusable(selected, own.state.quota[selected.id], modelOf(selected)) : undefined
  }
  /**
   * 02 §8.7: another Claude account than the session's, whatever the model. A binding not read yet counts as another
   * account: moving to the account it already has changes nothing, while assuming the first Claude account would keep
   * a conversation on AC-02 when AC-01 is chosen.
   */
  const claudeMoves = () => {
    const selected = account()
    if (!selected || !SHARED.has(selected.kind)) return false
    const bound = boundClaude()
    return bound === undefined || bound.kind !== selected.kind || bound.id !== selected.id
  }
  const isSame = () => sameRef(current(), target()) && !claudeMoves()
  const canSwitch = () =>
    area() ? runtime.team.rpc.allowed("area.main") : pick() ? true : own.rpc.allowed("switch.apply")
  /** The account changes: on an area main that continues in a new conversation unless `지금 바꾸기` (06 §10.1). */
  const accountMoves = () => {
    const ref = target()
    const base = current()
    return ref !== undefined && (!base || base.providerID !== ref.providerID)
  }
  /** Area mode: the choice is what the area has now, so applying changes nothing. */
  const areaUnchanged = () => (state.same ? !areaView()?.main : !!areaView()?.main && isSame())

  // ---- apply ----
  async function apply() {
    const picking = pick()
    if (picking) {
      // 영역 만들기: only the choice goes back (read before closing, as below).
      const choice = state.same ? null : target()
      if (choice === undefined) return
      picking.onPick(choice)
      return props.onClose()
    }
    const place = area()
    if (place) return applyArea({ teamID: place.teamID, areaID: place.areaID }, false)
    const ref = target()
    const selected = account()
    if (!ref || !selected) return
    const trouble = problem()
    if (trouble && trouble.reason !== "exhausted") {
      props.onClose()
      return router.navigate({ name: "accounts" })
    }
    const id = sessionID()
    // 02 §4.8: the 속도 row's choice goes with the apply. Everything is read before `props.onClose()`: closing ends
    // the `<Show>` that hands this popover its request, so the accessors behind `sessionID()` and the row go stale.
    const speed = speedChanged() ? speedView() : undefined
    const settable = speed !== undefined && speedSettable()
    const to = state.speed
    const offer = speed?.offers.find((item) => item.choice === to)
    const withOffer = offer ? { offer } : {}
    if (!id) {
      // A new conversation starts on the Claude account chosen here (02 §8.7: the account chosen last). A refusal is
      // never swallowed: the conversation would start on another Claude account; the Claude card says why.
      const method = selected.kind === "claude-sub" ? "plugin.claudeAuth.default.set" : "claudeAgent.default.set"
      if (SHARED.has(selected.kind) && own.rpc.allowed(method)) {
        const chosen = await own.rpc
          .call(method, { accountID: selected.id })
          .then(() => true)
          .catch(() => false)
        if (!chosen) {
          props.onClose()
          return router.navigate({ name: "accounts" })
        }
      }
      chooseNewSessionTarget(env, { ...ref })
      if (speed) void requestSpeed(speedEnv, { sessionID: undefined, to, view: speed, ...withOffer })
      return props.onClose()
    }
    if (isSame()) {
      const view = speed && settable ? (own.state.sessionSpeed[id] ?? { ...speed, choice: currentSpeed() }) : undefined
      props.onClose()
      if (view) void requestSpeed(speedEnv, { sessionID: id, to, view, ...withOffer })
      return
    }
    if (!canSwitch()) return props.onClose()
    // Another Claude account: the conversation's tree moves to it (R4), then the model switch (if any) goes as usual.
    if (claudeMoves()) {
      // 02 §8.10: a Claude Agent account takes the tree the same way, by hand only (its next turn runs there).
      const method = selected.kind === "claude-sub" ? "plugin.claudeAuth.session.set" : "claudeAgent.session.set"
      const moved = await own.rpc
        .call(method, { sessionID: id, accountID: selected.id })
        .then(() => true)
        .catch(() => false)
      if (!moved) {
        props.onClose()
        return router.navigate({ name: "accounts" })
      }
      if (sameRef(current(), ref)) return props.onClose()
    }
    const opener = props.request.opener ?? props.request.anchor
    const estimate = ready()
    const way = route()
    props.onClose()
    // Model and speed together: the switch first, the speed once the session runs on the new main.
    if (settable) afterSwitch(id, ref, to)
    const result = await requestSwitch(env, {
      sessionID: id,
      target: { ...ref },
      estimate,
      confirmedInline: true,
      opener,
      route: way,
    })
    if (settable && (result === "failed" || result === "same")) dropAfterSwitch(id)
  }

  /**
   * Area mode (06 §10.1): `area.main`. `팀과 같게` clears the area's own main; an account change continues in a new
   * conversation at the next safe point. `지금 바꾸기` (`now`) and a model or effort change switch the owner conversation
   * now through the 02 cost path, which ends in `area.main{now:true}`.
   */
  async function applyArea(place: { readonly teamID: string; readonly areaID: string }, now: boolean) {
    const ref = target()
    if (areaUnchanged() || !canSwitch() || (!ref && !state.same)) return props.onClose()
    const trouble = problem()
    if (ref && trouble && trouble.reason !== "exhausted") {
      props.onClose()
      return router.navigate({ name: "accounts" })
    }
    const owner = sessionID()
    const opener = props.request.opener ?? props.request.anchor
    const estimate = ready()
    const moves = accountMoves()
    const same = isSame()
    props.onClose()
    if (!ref) return void (await applyAreaMain(env, { ...place, model: null }))
    if (owner && (now || !moves) && !same) {
      const way: SwitchRoute = { kind: "owner", ...place }
      return void (await requestSwitch(env, {
        sessionID: owner,
        target: { ...ref },
        estimate,
        confirmedInline: true,
        opener,
        route: way,
      }))
    }
    await applyAreaMain(env, { ...place, model: { ...ref }, later: moves && owner !== undefined })
  }

  /** The reason row's action: this PC's Claude card, or the host's panel in 설정 > 원격 호스트. */
  function fixClaude(fix: ClaudeFix) {
    props.onClose()
    if (fix === "accounts") return router.navigate({ name: "accounts" })
    selectHostPanel(props.request.serverKey)
    router.navigate({ name: "settings", section: "remote" })
  }

  const ime = createImeEnter({ commitOnly: true, onEnter: () => void apply() })

  function onKeyDown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    inputSampler.record(event)
    if (ime.keydown(event)) return
    const code = eventCode(event)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return props.onClose()
    }
    if (code === "ArrowDown" || code === "ArrowUp") {
      event.preventDefault()
      const delta = code === "ArrowDown" ? 1 : -1
      if (state.column === 0) {
        const next = step(visibleAccounts(), state.same ? SAME : state.accountID, delta)
        if (next) selectAccount(next)
        return
      }
      const next = step(
        modelList().map((item) => item.id),
        state.modelID,
        delta,
      )
      if (next) selectModel(next)
      return
    }
    if (code === "ArrowRight" || code === "ArrowLeft") {
      const element = event.currentTarget
      const atEnd = element.selectionStart === element.value.length && element.selectionEnd === element.value.length
      const atStart = element.selectionStart === 0 && element.selectionEnd === 0
      if (element.value && ((code === "ArrowRight" && !atEnd) || (code === "ArrowLeft" && !atStart))) return
      event.preventDefault()
      setState("column", code === "ArrowRight" ? 1 : 0)
    }
  }

  // Keep the active option in view after keyboard moves (one layout read per move, never while typing).
  const activeID = () =>
    state.column === 0
      ? state.same
        ? `own-sw-a-${SAME}`
        : state.accountID && `own-sw-a-${state.accountID}`
      : state.modelID && `own-sw-m-${cssSafe(state.modelID)}`
  createEffect(
    on(activeID, (id) => {
      if (!id) return
      nextFrame(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" }))
    }),
  )
  // The selected model of a long list is visible on open and after an account change, whatever column is active.
  createEffect(
    on([() => props.request.seq, () => state.accountID, () => modelList().length], () => {
      const id = state.modelID
      if (!id) return
      nextFrame(() => document.getElementById(`own-sw-m-${cssSafe(id)}`)?.scrollIntoView({ block: "nearest" }))
    }),
  )

  // ---- placement and dismissal ----
  const [placement, setPlacement] = createSignal<{ left: number; top: number } | "sheet">()
  // A phone's sheet on a touch screen (MUX 2026-11-06): the search box takes the focus only when tapped. Focusing it on
  // every open and every tapped row raised the keyboard over the list each time; the sheet itself holds the focus.
  const touchSheet = () => placement() === "sheet" && host.capabilities.touch
  const focusSearch = () => (touchSheet() ? root?.focus({ preventScroll: true }) : input?.focus())
  // Placed once per open, after the popover rendered: one layout read, never during typing.
  const place = () => {
    if (!root) return
    if (innerWidth < PHONE_MAX) return setPlacement("sheet")
    const anchor = props.request.anchor
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : undefined
    const width = root.offsetWidth
    const height = root.offsetHeight
    if (!rect) return setPlacement({ left: (innerWidth - width) / 2, top: Math.max(12, (innerHeight - height) / 3) })
    const left = Math.min(Math.max(12, rect.left), innerWidth - width - 12)
    const top = rect.top > innerHeight / 2 ? rect.top - height - 8 : rect.bottom + 8
    setPlacement({ left, top: Math.max(12, Math.min(top, innerHeight - height - 12)) })
  }
  createEffect(
    on(
      () => props.request.seq,
      () =>
        nextFrame(() => {
          place()
          // Only after placing: a `visibility: hidden` element cannot take focus.
          focusSearch()
        }),
    ),
  )
  onMount(() => {
    const outside = (event: PointerEvent) => {
      const node = event.target
      if (!(node instanceof Node) || root?.contains(node) || props.request.anchor?.contains(node)) return
      props.onClose()
    }
    document.addEventListener("pointerdown", outside, true)
    onCleanup(() => document.removeEventListener("pointerdown", outside, true))
  })

  /** Clicking a row makes its column active and keeps focus in the search box (03 §5.2 "마우스로"). */
  const keepFocus = (event: MouseEvent) => event.preventDefault()

  // ---- view helpers ----
  const now = minuteNow
  // Only accounts the list shows: a team session's recent combinations on a filtered account stay out.
  const recent = createMemo(() => {
    const shown = new Set<string>(accounts().map((item) => item.providerID))
    return switcherControl.recent.list.filter((ref) => shown.has(ref.providerID) && !sameRef(ref, current()))
  })
  // Every provider group's 추천 at once, on the whole list: the cursor and the search never move a badge.
  const recommended = createMemo(() => recommendedAccounts(accounts(), own.state.quota, now(), modelOf, hasTurns()))
  const effectiveFor = (selected: Account.View | undefined, modelID: string | undefined) =>
    selected?.compaction?.effective.find((item) => item.modelID === modelID)
  const compaction = () => {
    const result = ready()?.target.compactAt
    if (result) return result
    return effectiveFor(account(), state.modelID)
  }
  const sessionP = () => {
    const id = sessionID()
    return id ? (own.state.cache[id]?.compaction?.P ?? 0) : 0
  }
  const describeContext = () => {
    const result = ready()
    return result
      ? {
          i18n,
          estimate: result,
          targetIsClaudeSlot: account()?.kind === "claude-sub",
          ...(account()?.kind === "claude-agent" ? { planText: fixes("own.pf.costPlan") } : {}),
        }
      : undefined
  }
  const fromInfo = () => {
    const base = current()
    const id = sessionID()
    const slot = base && id ? slotOf(own.state.cache[id], base.providerID, own.state.binding[id]?.accountID) : undefined
    return {
      account: (base && accountOf(runtime, base.providerID, sessionID())?.label) || "",
      cacheState: cacheText(i18n, slot, now()).text,
    }
  }
  const notes = () => {
    const result = ready()
    if (!result) return []
    const notes = warningNotes(i18n, result, fromInfo())
    // A Claude Agent target is a plan with no per-token rates to miss (CAM-7).
    const missing = i18n.t("own.switcher.warn.rateUnknown")
    return account()?.kind === "claude-agent" ? notes.filter((note) => note.text !== missing) : notes
  }
  const children = () => {
    const id = sessionID()
    return id && ready() ? continuingChildren(runtime, id) : 0
  }
  const costLine = () => {
    if (state.same) return team("own.team.mainPicker.sameHint")
    if (pick()) return team("own.team.createArea.pickHint")
    if (teamAccount()) return team("own.team.account.title")
    if (!sessionID() || !hasTurns()) return i18n.t("own.switcher.costNewSession")
    if (isSame()) return i18n.t("own.switcher.current")
    const estimate = state.estimate
    if (estimate.status === "loading") return i18n.t("own.switcher.estimating")
    if (estimate.status === "error") return i18n.t("own.switcher.estimateFailed", { reason: reasonOf(estimate.error) })
    const ctx = describeContext()
    const line = ctx ? footerCost(ctx, decision()) : ""
    // On an area main the cost is that of `지금 바꾸기`; applying continues in a new conversation instead.
    return area() && accountMoves() && line ? `${team("own.team.mainPicker.now")} · ${line}` : line
  }
  /** Area mode: an account change waits for the next safe point and a new conversation (06 §10.1). */
  const continuesLater = () => area() !== undefined && sessionID() !== undefined && accountMoves()
  /** `프리셋: <지금> → <다음>(<묶음>)` when the main moves to another provider group (07 §5.3, §7.3). */
  const presetLine = createMemo(() => {
    const ref = target()
    const base = current()
    if (!ref || !base) return undefined
    const id = sessionID()
    return presetLineFor({
      i18n,
      runtime,
      groups: data.local().own.state.presetGroups,
      base,
      target: ref,
      sessionID: id,
      areaPreset: id ? undefined : areaView()?.preset,
      team: teamOf(),
    })
  })
  const applyLabel = () => {
    const trouble = problem()
    if (trouble && trouble.reason !== "exhausted") return i18n.t("own.switcher.fix")
    if (pick()) return team("own.team.createArea.pickApply")
    if (area()) return areaUnchanged() ? i18n.t("own.switcher.close") : i18n.t("own.switcher.apply")
    if (!sessionID()) return i18n.t("own.switcher.apply")
    if (isSame()) return speedChanged() && speedSettable() ? i18n.t("own.switcher.apply") : i18n.t("own.switcher.close")
    if (teamAccount()) return i18n.t("own.switcher.applyDialog")
    const verdict = decision()
    const base = busy() ? i18n.t("own.switcher.wait") : i18n.t("own.switcher.apply")
    if (verdict?.level === "dialog") return i18n.t("own.switcher.applyDialog")
    if (verdict?.level === "inline") {
      const ctx = describeContext()
      const now = ready()?.options.find((option) => option.strategy === "now")
      return i18n.t("own.switcher.applyWith", { action: base, delta: ctx ? costText(ctx, now) : "" })
    }
    return base
  }
  const applyDisabled = () => {
    if (area() || pick()) return (!target() && !state.same) || !canSwitch()
    return !target() || (!!sessionID() && !isSame() && !canSwitch())
  }
  /** Area mode: `지금 바꾸기` next to Apply while an account change would otherwise wait (06 §10.1). */
  const nowButton = () => continuesLater() && canSwitch()
  /** `<옛 계정>에서 하위 에이전트 n개가 실행 중입니다` (07 §5.5). */
  const childWait = () => {
    const busyChildren = ready()?.busyChildren
    if (!busyChildren) return undefined
    const label = own.state.accounts[busyChildren.accountID]?.label ?? busyChildren.accountID
    return childWaitText(i18n, label, busyChildren.count)
  }
  const sameLine = () => {
    const ref = teamRef()
    if (!ref) return team("own.team.main.same")
    const owner = accountOf(runtime, ref.providerID, teamMain())?.label ?? ref.providerID
    const main = `${modelName(runtime, ref, modelFolder())} @ ${owner}`
    return team("own.team.main.sameWith", { main })
  }

  return (
    <div
      ref={root}
      class="own-sw"
      tabIndex={-1}
      onKeyDown={(event) => {
        // The sheet itself holds the focus on a touch screen: Escape (and the app's back button, src/host/app-back.ts).
        if (event.target === root && eventCode(event) === "Escape") props.onClose()
      }}
      classList={{ "own-sw-sheet": placement() === "sheet" }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="own-sw-title"
      data-testid="switcher"
      style={
        typeof placement() === "object"
          ? { left: `${(placement() as { left: number }).left}px`, top: `${(placement() as { top: number }).top}px` }
          : placement() === "sheet"
            ? undefined
            : { visibility: "hidden" }
      }
    >
      <div class="own-sw-head">
        <b id="own-sw-title" class="text-[13px]">
          {i18n.t("own.switcher.title")}
          <Show when={areaView()}>{(view) => <> · {view().name}</>}</Show>
          <Show when={pick()}> · {team("own.team.createArea.title")}</Show>
        </b>
        <label class="own-sw-search">
          <span class="own-sr-only">{i18n.t("own.switcher.search")}</span>
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="own-sw-accounts own-sw-models"
            aria-autocomplete="list"
            aria-activedescendant={activeID() || undefined}
            placeholder={i18n.t("own.switcher.search")}
            autocomplete="off"
            spellcheck={false}
            data-testid="switcher-search"
            onKeyDown={onKeyDown}
            onKeyUp={(event) => ime.keyup(event)}
            onCompositionStart={(event) => {
              ime.compositionstart()
              inputSampler.record(event)
            }}
            onCompositionEnd={(event) => {
              ime.compositionend()
              inputSampler.record(event)
            }}
            onInput={(event) => {
              ime.input()
              // Results only: the input element itself is never re-rendered (03 §12 rule 5).
              setState("query", event.currentTarget.value)
              inputSampler.record(event)
            }}
          />
        </label>
        <button
          type="button"
          class="own-sw-icon own-target"
          aria-label={i18n.t("own.switcher.close")}
          onClick={() => props.onClose()}
        >
          <span aria-hidden="true" class="own-ico own-ico-x" />
        </button>
      </div>

      <Show when={recent().length}>
        <div class="own-sw-recent" onMouseDown={keepFocus}>
          <span>{i18n.t("own.switcher.recent")}</span>
          <For each={recent()}>
            {(ref) => (
              <button
                type="button"
                class="own-sw-chip"
                tabIndex={-1}
                onClick={() => {
                  selectTarget(ref)
                  focusSearch()
                }}
              >
                <span
                  class="own-sw-dot"
                  data-color={accountOf(runtime, ref.providerID, sessionID())?.color}
                  aria-hidden="true"
                />
                {modelName(runtime, ref, modelFolder())} @ {accountOf(runtime, ref.providerID, sessionID())?.label}
                {/* Two recent combinations may differ only by effort (03 §4.6): name it, as the selected line does. */}
                {namedVariant(ref.variant) ? ` · ${variantName(i18n, ref.variant)}` : ""}
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="own-sw-body">
        <div
          id="own-sw-accounts"
          class="own-sw-col"
          role="listbox"
          aria-label={i18n.t("own.switcher.accountsLabel")}
          data-active={state.column === 0 ? "" : undefined}
          onMouseDown={keepFocus}
        >
          <Show when={(area() || pick()) && !state.query.trim()}>
            <div
              id={`own-sw-a-${SAME}`}
              class="own-sw-account"
              role="option"
              aria-selected={state.same}
              data-active={state.column === 0 && state.same ? "" : undefined}
              data-testid="switcher-team-same"
              onClick={() => {
                setState("column", 0)
                selectSame()
                focusSearch()
              }}
            >
              <span class="own-sw-row1">
                <span class="own-sw-name">{team("own.team.mainPicker.same")}</span>
                <Show when={pick() ? !pick()?.current : !areaView()?.main}>
                  <span class="own-sw-tag">{i18n.t("own.switcher.currentBadge")}</span>
                </Show>
              </span>
              <span class="own-sw-why">{team("own.team.mainPicker.sameHint")}</span>
            </div>
          </Show>
          <For
            each={groups()}
            fallback={
              <p class="own-sw-empty">
                {state.query.trim()
                  ? i18n.t("own.switcher.noMatch", { query: state.query.trim() })
                  : i18n.t("own.empty.accounts")}
              </p>
            }
          >
            {(group) => (
              <div role="group" aria-label={group.name}>
                <div class="own-sw-group">{group.name}</div>
                <For each={group.accounts}>
                  {(item) => (
                    <AccountRow
                      runtime={runtime}
                      account={item}
                      sessionID={sessionID()}
                      selected={!state.same && state.accountID === item.id}
                      active={state.column === 0 && !state.same && state.accountID === item.id}
                      current={runningOn(current()?.providerID ?? "")?.id === item.id}
                      recommended={recommended().has(item.id)}
                      showCache={hasTurns()}
                      viaPc={viaPc(claude(), item.kind) || (runtime.kind === "ssh" && isLocal(item))}
                      model={modelOf(item)}
                      now={now()}
                      onPick={() => {
                        setState("column", 0)
                        selectAccount(item.id)
                        focusSearch()
                      }}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
          <Show when={!state.query.trim() && !accounts().some((item) => item.kind === "claude-sub")}>
            <div class="own-sw-group">{kindName(i18n, "claude-sub")}</div>
            <button
              type="button"
              class="own-sw-account"
              tabIndex={-1}
              onClick={() => {
                props.onClose()
                router.navigate({ name: "accountsAdd" })
              }}
            >
              <span class="own-sw-row1">
                <span class="own-sw-name text-own-muted">{i18n.t("own.switcher.claudeNotConnected")}</span>
                <span class="own-sw-link">{i18n.t("own.switcher.connect")}</span>
              </span>
              <span class="own-sw-why">{i18n.t("own.switcher.claudeNeeds")}</span>
            </button>
          </Show>
          <For each={listed().hidden}>
            {(company) => (
              <p class="own-sw-empty own-sw-faint" data-testid="switcher-team-hidden">
                {team("own.team.mainPicker.hidden", { company: companyName(i18n, company) })}
              </p>
            )}
          </For>
        </div>

        <div
          id="own-sw-models"
          class="own-sw-col own-sw-models"
          role="listbox"
          aria-label={i18n.t("own.switcher.modelsLabel")}
          data-active={state.column === 1 ? "" : undefined}
          onMouseDown={keepFocus}
        >
          <Show when={account()}>
            {(selected) => (
              <div class="own-sw-group">{i18n.t("own.switcher.modelsOf", { account: selected().label })}</div>
            )}
          </Show>
          <For
            each={modelList()}
            fallback={
              <Show
                when={claudeBlocked()}
                fallback={
                  <Show
                    when={catalogFailed(runtime) && catalog(runtime, modelFolder()).length === 0}
                    fallback={<p class="own-sw-empty">{i18n.t("own.shell.loading")}</p>}
                  >
                    <div class="own-sw-empty" data-testid="switcher-models-failed">
                      <p class="m-0">{i18n.t("own.switcher.modelsFailed")}</p>
                      <button
                        type="button"
                        class="own-sw-link mt-1.5"
                        onClick={() => ensureCatalog(runtime, modelFolder(), true)}
                      >
                        {i18n.t("own.acct.retry")}
                      </button>
                    </div>
                  </Show>
                }
              >
                {(reason) => (
                  <div class="own-sw-empty" data-testid="switcher-claude-reason" data-verdict={claude()}>
                    <p class="m-0">{remoteText(reason().key)}</p>
                    <button
                      type="button"
                      class="own-sw-link mt-1.5"
                      data-testid="switcher-claude-fix"
                      onClick={() => fixClaude(reason().fix)}
                    >
                      {reason().fix === "accounts"
                        ? i18n.t("own.switcher.fix")
                        : serversText("own.remote.action.details")}
                    </button>
                  </div>
                )}
              </Show>
            }
          >
            {(item) => {
              const effective = () => effectiveFor(account(), item.id)
              const isCurrent = () => current()?.providerID === account()?.providerID && current()?.id === item.id
              // Presets and their retirement dates are this PC's, per provider group (an own account's kind).
              const marks = () =>
                modelMarks({
                  marks: account()?.models,
                  retirements: data.local().own.state.presetGroups[account()?.kind ?? ""]?.retirements,
                  modelID: item.id,
                  now: now(),
                })
              const compactsNow = () => {
                const trigger = effective()?.triggerTokens
                return !isCurrent() && trigger !== undefined && sessionP() >= trigger
              }
              return (
                <div
                  id={`own-sw-m-${cssSafe(item.id)}`}
                  class="own-sw-model"
                  role="option"
                  aria-selected={!state.same && state.modelID === item.id}
                  data-active={state.column === 1 && !state.same && state.modelID === item.id ? "" : undefined}
                  data-testid="switcher-model"
                  onClick={() => {
                    setState("column", 1)
                    selectModel(item.id)
                    focusSearch()
                  }}
                >
                  <span class="own-sw-radio" aria-hidden="true" />
                  <span class="own-sw-model-text">
                    <span class="own-sw-model-name">
                      <span class="own-sw-model-label">{item.name}</span>
                      <Show when={isCurrent()}>
                        {" "}
                        <span class="own-sw-tag">{i18n.t("own.switcher.currentBadge")}</span>
                      </Show>
                      <Show when={marks().fresh}>
                        {" "}
                        <span class="own-sw-tag own-sw-rec" data-testid="switcher-model-new">
                          {presets("own.preset.newTag")}
                        </span>
                      </Show>
                      <Show when={hidden.is(hiddenGroup(), item.id)}>
                        {" "}
                        <span class="own-sw-tag" data-testid="switcher-model-hidden">
                          {fixes("own.pf.hiddenTag")}
                        </span>
                      </Show>
                    </span>
                    <span class="own-sw-meta">
                      {/* CAM-8: a Claude Agent alias names the model it runs ("Opus · Opus 5.5", core P-060); an older
                          Claude Code that does not say is named after the first turn on it. */}
                      <Show when={account()?.kind === "claude-agent" && !/\d/.test(item.name)}>
                        <span class="own-sw-faint" data-testid="switcher-model-version-later">
                          {fixes("own.pf.versionLater")}{" "}
                        </span>
                      </Show>
                      <Show when={account()?.models?.some((mark) => mark.id === item.id && mark.source === "served")}>
                        <span class="own-sw-faint" data-testid="switcher-model-served">
                          {codexText("own.codexModels.served")}{" "}
                        </span>
                      </Show>
                      <Show when={marks().retires}>
                        {(at) => (
                          <span class="own-sw-faint" data-testid="switcher-model-retirement">
                            {presets("own.preset.retirement", { date: monthDay(at()) })}{" "}
                          </span>
                        )}
                      </Show>
                      <Show when={effective()}>
                        {(row) => (
                          <>
                            {i18n.t("own.compact.row", {
                              window: formatTokens(row().windowTokens),
                              trigger: formatTokens(row().triggerTokens),
                            })}
                            <Show when={row().source !== "v2"}> · {i18n.t(`own.compact.source.${row().source}`)}</Show>
                          </>
                        )}
                      </Show>
                      <Show when={compactsNow()}>
                        {" "}
                        <span class="own-sw-warn" title={i18n.t("own.switcher.mayAutoCompact")}>
                          ⚠ {i18n.t("own.switcher.mayAutoCompact")}
                        </span>
                      </Show>
                    </span>
                  </span>
                  {/* CAM-9: its own trailing button (it sat at the end of the name and was cut off at narrow widths), a
                      44 px target on touch; the conversation's own model has none. */}
                  <Show when={hiddenGroup() !== undefined && hidden.editable() && !isCurrent()}>
                    <button
                      type="button"
                      class="own-sw-model-hide"
                      data-testid="switcher-model-hide"
                      aria-label={fixes(hidden.is(hiddenGroup(), item.id) ? "own.pf.unhide" : "own.pf.hide")}
                      title={fixes(hidden.is(hiddenGroup(), item.id) ? "own.pf.unhide" : "own.pf.hide")}
                      onMouseDown={keepFocus}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleHidden(item)
                      }}
                    >
                      {fixes(hidden.is(hiddenGroup(), item.id) ? "own.pf.unhideShort" : "own.pf.hideShort")}
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
          <Show when={hiddenCount() || hiddenOpen()}>
            <button
              type="button"
              class="own-sw-link own-sw-empty"
              aria-expanded={hiddenOpen()}
              data-testid="switcher-hidden-models"
              onMouseDown={keepFocus}
              onClick={() => setHiddenOpen((open) => !open)}
            >
              {hiddenOpen() ? "▾ " : "▸ "}
              {fixes("own.pf.hiddenCount", { n: hiddenCount() })}
            </button>
          </Show>
        </div>
      </div>

      {/* The effort and the speed under both columns, always in view (the 2026-10-10 review: the 속도 row sat below the
          fold of a long model list). */}
      <Show when={model()?.variants.length || speedView()}>
        <div class="own-sw-opts" data-testid="switcher-options">
          <Show when={model()?.variants.length}>
            <div class="own-sw-variants">
              <span>{i18n.t("own.switcher.variantLabel")}</span>
              <div class="own-sw-seg" role="group" aria-label={i18n.t("own.switcher.variantLabel")}>
                <For each={model()?.variants ?? []}>
                  {(variant) => (
                    <button
                      type="button"
                      aria-pressed={state.variant === variant}
                      onMouseDown={keepFocus}
                      onClick={() => {
                        selectVariant(variant)
                        focusSearch()
                      }}
                    >
                      {variantName(i18n, variant)}
                    </button>
                  )}
                </For>
              </div>
              <Show when={forced()}>
                {(fixed) => (
                  <span class="own-sw-faint" data-testid="switcher-forced-effort">
                    {fixed().fit.clamped
                      ? fixes("own.pf.switcherClamped", {
                          preset: fixed().preset,
                          level: variantName(i18n, fixed().level),
                          sent: variantName(i18n, fixed().fit.variant ?? "default"),
                        })
                      : fixes("own.pf.switcher", { preset: fixed().preset, level: variantName(i18n, fixed().level) })}
                    <Show when={fixed().fit.variant !== undefined && state.variant !== fixed().fit.variant}>
                      {" · "}
                      {fixes("own.pf.switcherOverride")}{" "}
                      <button
                        type="button"
                        class="own-sw-link"
                        data-testid="switcher-forced-effort-back"
                        onMouseDown={keepFocus}
                        onClick={() => selectVariant(fixed().fit.variant!)}
                      >
                        {fixes("own.pf.switcherBack")}
                      </button>
                    </Show>
                  </span>
                )}
              </Show>
              <Show when={ready()?.variantOnly}>
                {(variantOnly) => (
                  <span class="own-sw-faint">
                    {variantOnly().preservesCache
                      ? i18n.t("own.switcher.variantKeepsCache")
                      : i18n.t("own.switcher.variantBreaksCache")}
                  </span>
                )}
              </Show>
            </div>
          </Show>
          {/* 02 §4.8: `속도  표준 | Fast · 한도 ×2.5 | Ultrafast · 한도 ×8` behind each speed's mark, grey with the
              reason without one. */}
          <Show when={speedView()}>
            {(view) => (
              <div class="own-sw-variants" data-testid="switcher-speed">
                <span>{i18n.t("own.speed.label")}</span>
                <div class="own-sw-seg" role="group" aria-label={i18n.t("own.speed.label")}>
                  <For each={items(view())}>
                    {(item) => (
                      <button
                        type="button"
                        aria-pressed={view().effective === item.choice}
                        data-speed={item.choice}
                        disabled={item.disabled || !speedSettable() || view().fixed !== undefined}
                        title={item.offer ? offerNote(i18n, item.offer, now()) : undefined}
                        onMouseDown={keepFocus}
                        onClick={() => {
                          setState({ speed: item.choice, speedTouched: true })
                          focusSearch()
                        }}
                      >
                        <SpeedMark choice={item.choice} />
                        {item.offer ? offerBadge(i18n, item.offer, now()) : speedName(i18n, item.choice)}
                      </button>
                    )}
                  </For>
                </div>
                <Show when={speedNote(view())}>
                  {(note) => (
                    <span class="own-sw-faint" data-testid="switcher-speed-note">
                      {note()}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>

      <div class="own-sw-foot">
        <div class="own-sw-est" aria-live="polite" data-testid="switcher-estimate">
          <div class="truncate">
            <Show when={target()} fallback={<Show when={state.same}>{sameLine()}</Show>}>
              {/* A JSX expression, so the line follows later account/model picks (a bare string is computed once). */}
              {(ref) => (
                <>
                  {i18n.t("own.switcher.selected", {
                    model: modelName(runtime, ref(), modelFolder()),
                    account: account()?.label ?? "",
                  }) + (namedVariant(ref().variant) ? ` · ${variantName(i18n, ref().variant)}` : "")}
                </>
              )}
            </Show>
          </div>
          <div data-testid="switcher-cost">{costLine()}</div>
          <Show when={presetLine()}>
            {(line) => (
              <div class="own-sw-note" data-tone="info" data-testid="switcher-preset-line">
                {line()}
              </div>
            )}
          </Show>
          <Show when={continuesLater()}>
            <div class="own-sw-note" data-tone="info">
              ⓘ {team("own.team.mainPicker.later")}
            </div>
          </Show>
          <Show when={compaction()}>
            {(row) => (
              <div class="own-sw-faint">
                {i18n.t("own.compact.row", {
                  window: formatTokens(row().windowTokens),
                  trigger: formatTokens(row().triggerTokens),
                })}{" "}
                ({i18n.t(`own.compact.source.${row().source}`)}){" "}
                <button
                  type="button"
                  class="own-sw-link"
                  onClick={() => {
                    props.onClose()
                    router.navigate({ name: "settings", section: "compaction" })
                  }}
                >
                  ⚙ {i18n.t("own.switcher.compactSettings")}
                </button>
              </div>
            )}
          </Show>
          <For each={notes()}>
            {(note) => (
              <div class="own-sw-note" data-tone={note.tone}>
                {note.tone === "warn" ? "⚠ " : "ⓘ "}
                {note.text}
              </div>
            )}
          </For>
          <Show
            when={childWait()}
            fallback={
              <Show when={children() > 0}>
                <div class="own-sw-note" data-tone="info">
                  ⓘ {i18n.t("own.switch.subagents", { n: children() })}
                </div>
              </Show>
            }
          >
            {(line) => (
              <div class="own-sw-note" data-tone="info" data-testid="switcher-child-wait">
                ⓘ {line()}
              </div>
            )}
          </Show>
          <Show when={(sessionID() || area()) && !canSwitch()}>
            <div class="own-sw-note" data-tone="info">
              {i18n.t("own.switcher.readOnly")}
            </div>
          </Show>
        </div>
        {/* Nothing to cancel when the primary button only closes (the selection is what the conversation has). */}
        <Show when={applyLabel() !== i18n.t("own.switcher.close")}>
          <button type="button" class="own-sw-btn" onClick={() => props.onClose()}>
            {i18n.t("own.switcher.cancel")}
          </button>
        </Show>
        <Show when={nowButton()}>
          <button
            type="button"
            class="own-sw-btn"
            data-testid="switcher-area-now"
            onClick={() => {
              const place = area()
              if (place) void applyArea({ teamID: place.teamID, areaID: place.areaID }, true)
            }}
          >
            {team("own.team.mainPicker.now")}
          </button>
        </Show>
        <button
          type="button"
          class="own-sw-btn own-sw-primary"
          disabled={applyDisabled()}
          data-testid="switcher-apply"
          data-level={decision()?.level ?? (isSame() ? "same" : sessionID() && hasTurns() ? "pending" : "new")}
          onClick={() => void apply()}
        >
          {applyLabel()}
        </button>
      </div>
    </div>
  )
}

function AccountRow(props: {
  readonly runtime: ServerRuntime
  readonly account: Account.View
  readonly sessionID: string | undefined
  readonly selected: boolean
  readonly active: boolean
  readonly current: boolean
  readonly recommended: boolean
  readonly showCache: boolean
  /**
   * 04 §8.11.12: the Claude slot on an SSH host this PC relays (`PC 경유`, with its explanation); 04 §8.14: so is every
   * local model of this PC on an SSH host.
   */
  readonly viaPc: boolean
  /**
   * The model this account would run (./picker `rowModel`: the selected model, else the conversation's, where the
   * account offers it, else its default): its model weekly bucket may lead the row's line and names the row's reset
   * (./picker `unusable`).
   */
  readonly model: string | undefined
  readonly now: number
  readonly onPick: () => void
}) {
  const i18n = useI18n()
  const localText = useLocalText()
  const servers = useServersText()
  const remoteText = useRemoteText()
  const own = props.runtime.own
  const windows = () => own.state.quota[props.account.id]
  const trouble = () => unusable(props.account, windows(), props.model)
  const cache = () =>
    props.sessionID
      ? cacheText(i18n, slotOf(own.state.cache[props.sessionID], props.account.providerID, props.account.id), props.now)
      : undefined
  const typeLabel = () => {
    if (props.account.thirdParty) return i18n.t("own.accounts.type.unofficial")
    // A local model is free (02 §3.3a): not `API` (MUX, seen on the phone's sheet).
    if (isLocal(props.account)) return localText("own.local.free")
    if (props.account.billing === "subscription")
      return props.account.identity?.plan ?? i18n.t("own.accounts.type.subscription")
    return i18n.t("own.accounts.type.api")
  }
  const why = () => {
    const problem = trouble()
    if (problem?.reason === "auth") return i18n.t("own.switcher.unusable.auth")
    if (problem?.reason === "shared") return i18n.t("own.switcher.unusable.shared")
    if (problem?.reason === "plugin") return i18n.t("own.switcher.unusable.plugin")
    if (problem?.reason === "misconfigured") return i18n.t("own.switcher.unusable.misconfigured")
    if (problem?.reason === "exhausted")
      return problem.resetAt
        ? i18n.t("own.switcher.unusable.exhausted", { reset: resetText(i18n, props.now, problem.resetAt) })
        : i18n.t("own.switcher.unusable.exhaustedNoReset")
    if (props.account.kind === "claude-sub") return i18n.t("own.claude.costUnknown")
    return undefined
  }
  return (
    <div
      id={`own-sw-a-${props.account.id}`}
      class="own-sw-account"
      classList={{ "own-sw-dim": !!trouble() }}
      role="option"
      aria-selected={props.selected}
      data-active={props.active ? "" : undefined}
      data-account-id={props.account.id}
      data-testid="switcher-account"
      onClick={() => props.onPick()}
    >
      <span class="own-sw-row1">
        <span class="own-sw-dot" data-color={props.account.color} aria-hidden="true" />
        <span class="own-sw-name">{claudeAccountName(i18n, props.account)}</span>
        <span class="own-sw-tag">{typeLabel()}</span>
        <Show when={props.viaPc}>
          <span
            class="own-sw-tag"
            title={
              isLocal(props.account)
                ? remoteText("own.remote.localModel.badgeHelp")
                : servers("own.remote.claudeSlot.badgeHelp")
            }
            data-testid="switcher-claude-via-pc"
          >
            {servers("own.remote.claudeSlot.badge")}
          </span>
        </Show>
        <Show when={props.current}>
          <span class="own-sw-tag">{i18n.t("own.switcher.currentBadge")}</span>
        </Show>
        <Show when={props.recommended}>
          <span class="own-sw-tag own-sw-rec">{i18n.t("own.switcher.recommended")}</span>
        </Show>
        {/* 7.4 (UX 2026-10-26): the conversation's own account always, others only while their cache helps (warm,
            cooling); a cold row says nothing. A dot and `캐시 …`, never a glyph beside the model column's radios. */}
        <Show when={props.showCache && cache()}>
          {(state) => (
            <Show when={props.current || state().state === "warm" || state().state === "cooling"}>
              <span class="own-sw-cache" data-state={state().state} data-testid="switcher-cache">
                <span class="own-cache-dot" aria-hidden="true" />
                {i18n.t("own.pill.cache", { state: state().text })}
              </span>
            </Show>
          )}
        </Show>
      </span>
      {/* 03 §5.2 limits line (LV 2026-10-24): the summary's folded line, the tightest window alone at 아주 간단히, every
          window in its hover text. An option of the listbox holds no button, so it does not unfold here. */}
      <Show when={windows()?.length}>
        <span class="own-sw-limits">
          <LimitSummaryLine
            windows={windows()}
            now={() => props.now}
            max={limitDensity("lists") === "minimal" ? 1 : 2}
            model={props.model}
            testid="switcher-limits"
          />
          <ResetCreditCount account={props.account} />
        </span>
      </Show>
      <Show when={why()}>
        {(text) => (
          <span class="own-sw-why" data-tone={trouble() ? "danger" : undefined}>
            {text()}
          </span>
        )}
      </Show>
    </div>
  )
}

/** Model ids may contain `/`, `.` or `:`; ids used for `aria-activedescendant` stay plain. */
function cssSafe(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}
