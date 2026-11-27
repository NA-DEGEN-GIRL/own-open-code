// Area menu (06 §9.4 영역 행 `⋯`, §9.5, §10.1; 07 §7.4), opened from the area rows, the owner header's pill and the
// Main 멈춤 banner (team/intents.ts `openAreaMenu`); the sidebar mounts it (lazy, team chunk). The top line is
// `모델: 팀과 같게(GPT-6 Astra · high @ 개인 Pro) · 프리셋: 다른 회사 리뷰 [바꾸기]`. Since 2026-10-16 the items are
// grouped (view-model.ts `AREA_GROUPS`): 대화, 메인 요청, 설정 and 작업 under headings, 구성 바꾸기 ▸ folded until the
// user opens it (Enter, Space or → opens it and moves into it, ← closes it), 영역 끝내기… and 팀에서 빼기 after a
// separator in danger tone, then the peers and 자세히. `팀 메인과 상의하기…` fills the team main's composer with a
// draft about this area (nothing is sent), and `새 대화로 이어가기` asks once before it starts (focus on 취소). The
// items (view-model.ts `areaActions`) show where this build of own.team has their feature and this connection their
// scope: 담당과 대화 열기, 메인 멈춤 / 메인 멈춤 끄기, 기다리는 메인 요청 보기, 새 대화로 이어가기, 모델 바꾸기… (the
// switcher on the area's model, filtered by the team's R4, switcher/team-flow.ts), 프리셋 바꾸기… (the area main group's presets with the ones that
// break the team's R4 dimmed and why, and the team's worst case), 큰 파일 폴더 가져오기…, 이 영역 반영하기
// (`area.integrate`: its card follows in the owner conversation and above the team main, 9.7), 이름 바꾸기, the T3
// reorganizations 나누기…, 영역 묶기…, 파일 모양 바꾸기 and 대화 옮기기… (8.2: panels of team/reorg.tsx, each the user's
// own `reorg.apply{teamID, proposal}`), 다시 만들기… (an area whose folder is gone: a new area from its record, 8.8),
// 영역 끝내기… (its panel says what stays; the folder's removal asks again in the confirm dialog, 8.6), 팀에서 빼기 (an
// adopted area, after a confirm in the popover: `area.unadopt`), 자세히. An item that needs more opens its panel in
// the same popover. A request may name a panel to open with (`panel: "retire"`: a retire suggestion, a missing
// folder's `[끝내기]`, the cleanup of a folder team mode locked; `panel: "recreate"`: a missing folder's
// `[다시 만들기]`, 'B 다시 만들기' on a join's card, 8.2). Area peers (동료, 2026-10-09): `동료 추가…` (a new peer
// conversation, `area.peer.add{create}`), the area's peers above 자세히 (each opens its conversation, with 역할
// 바꾸기… and 동료에서 빼기 where allowed), and the panels a conversation's menus open directly (`registerPeer`:
// 동료로 등록… of `sessionID`; `editPeer` / `removePeer` of `peer`; `addPeer`: 동료 추가… from the result card of an area
// the user created). 사용자가 정하는 영역 (2026-10-26): `역할 바꾸기…` (the area's role, `area.edit{goal}`, with the
// role templates also offered in the peer forms) and the `내가 정한 영역` switch (`area.edit{userMade}`: the team main
// asks before it changes the area's layout) in 설정, and the mark on the top line. The popover is
// portaled to the body (the phone's list keeps the sidebar inert while a conversation shows), in the top layer with
// light dismiss and Esc; focus goes back to where it opened. 새 영역 of the worktree picker opens 영역 만들기
// (team/create-area.tsx) since 2026-10-26. 담당 대화 바꾸기 (2026-11-12): the peers' group is `팀과 이야기하는 대화`, with
// the owner first (its `메모 바꾸기…` edits the owner note, `area.edit{note}`), then the peers, each with its note on a
// second line and `이 대화를 담당으로` where the conversation may take the seat. That item (here and in a
// conversation's menus, `panel: "seat"` of `sessionID`) opens one confirm: a sentence naming the conversation and its
// model, 취소 and 바꾸기 (enable.ts `runSeat`). 직접 작업 (2026-11-14): `메인에게 넘기기` leads 메인 요청 while the user
// works with the area directly (`area.pause{on: false}`); 기다리는 메인 요청 says when they wait for that, and a long
// request or note opens with `원문 보기`. Roles count characters with no native limit (1,000, refused above), and
// 큰 파일 폴더 takes up to 64 folders at once.
import { Preset } from "@own/protocol/preset"
import type { OwnTeam } from "@own/protocol/rpc-team"
import { OwnTeamText } from "@own/protocol/rpc-team-text"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { Portal } from "solid-js/web"
import { requestComposerRestore } from "@/attachments/intents"
import { PresetMenu } from "@/composer/preset-button"
import { useData, type ServerRuntime } from "@/data"
import { nextFrame } from "@/data/frame"
import { useI18n } from "@/i18n"
import { teamTitle } from "./title"
import { mainGroup, presetByID, presetName, teamClash } from "@/presets/session-view"
import { usePresetsText } from "@/presets/strings"
import { useRouter } from "@/routing/router"
import { useSubagentText } from "@/subagent/strings"
import { formatClock } from "@/switcher/format"
import { accountOf, modelName, variantName } from "@/switcher/labels"
import { dismissToast, showToast } from "@/switcher/toast"
import { pauseArea, peerActions, peerItems, runSeat, seatBlock } from "./enable"
import { openSwitcherForArea, type AreaTarget } from "./intents"
import { lfsUpload, withLfs } from "./lfs"
import { RoleTemplates } from "./templates"
import {
  errorText,
  mainLine,
  peerErrorText,
  presetLine,
  runningOn,
  seatErrorText,
  type RunningOn,
  type TeamText,
} from "./model"
import { ConvertPanel, MergePanel, MovePanel, RecreatePanel, RetirePanel, SplitPanel } from "./reorg"
import { teamText, type TeamKey } from "./strings"
import {
  aliasForm,
  aliasTaken,
  areaActions,
  areaGroups,
  areaTalkers,
  convertProposal,
  convertTarget,
  mergeProposal,
  moveCandidates,
  moveProposal,
  noteForm,
  PEER_LABEL_MAX,
  peerAddInput,
  peerEditInput,
  peerForm,
  recreateProposal,
  renameProposal,
  retireProposal,
  PATHS_MAX,
  pathsForm,
  roleLeft,
  roleMax,
  shortPath,
  splitProposal,
  worstWith,
  type AreaAction,
  type AreaGroup,
} from "./view-model"

type Panel =
  | "menu"
  | "rotate"
  | "addPeer"
  | "registerPeer"
  | "editPeer"
  | "removePeer"
  | "seat"
  | "ownerNote"
  | "alias"
  | "outbox"
  | "preset"
  | "role"
  | "paths"
  | "rename"
  | "split"
  | "merge"
  | "convert"
  | "move"
  | "recreate"
  | "retire"
  | "unadopt"
  | "details"

const ITEM =
  "flex w-full flex-col items-start rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-inherit hover:bg-own-hover focus-visible:bg-own-hover"
/** 영역 끝내기… and 팀에서 빼기: the item in danger tone (its colour replaces the item's inherited one). */
const DANGER_ITEM = ITEM.replace("text-inherit", "text-own-danger")
/** The longest area name and subtitle (V12: own.team cuts both at 40 characters, so the field stops there). */
const NAME_MAX = 40

const BUTTON = "rounded-md border border-own-border px-2 py-0.5 text-[12.5px] hover:bg-own-hover disabled:opacity-50"
const FIELD =
  "w-full rounded-md border border-own-border-input bg-own-bg px-2 py-1 text-[13px] text-own-text outline-offset-[-1px]"
/** The headings of the area menu's groups (06 §9.4, 2026-10-16). */
const GROUP_KEYS = {
  talk: "own.team.areaMenu.group.talk",
  requests: "own.team.areaMenu.group.requests",
  settings: "own.team.areaMenu.group.settings",
  work: "own.team.areaMenu.group.work",
  structure: "own.team.areaMenu.group.structure",
  danger: "own.team.areaMenu.group.danger",
  details: "own.team.action.details",
} as const satisfies Record<AreaGroup, TeamKey>

/** 역할 바꾸기… and 동료에서 빼기 beside a peer's name. */
const PEER_ITEM =
  "flex-none rounded-md border-0 bg-transparent px-1.5 py-1 text-[12px] text-own-muted hover:bg-own-hover hover:text-own-text focus-visible:bg-own-hover disabled:opacity-50"

export default function AreaMenu(props: { readonly target: AreaTarget; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const router = useRouter()
  const names = usePresetsText()
  const subagent = useSubagentText()
  const text: TeamText = (key, params) => teamText.text(i18n.locale(), key, params)
  const runtime = () => data.get(props.target.serverKey)
  const entry = () => runtime()?.team.team(props.target.teamID)
  const area = () => entry()?.areas[props.target.areaID]
  const ids = { teamID: props.target.teamID, areaID: props.target.areaID }
  // 영역 끝내기 asked for directly (team/reorg.tsx `openRetirePanel`, worktree/remove.tsx): the request names the panel.
  const [panel, setPanel] = createSignal<Panel>(props.target.panel ?? "menu")
  const [busy, setBusy] = createSignal(false)
  /** 구성 바꾸기 ▸ is folded whenever the menu opens. */
  const [structure, setStructure] = createSignal(false)
  /** The peer 역할 바꾸기… and 동료에서 빼기 work on (`Peer.key`). */
  const [peerKey, setPeerKey] = createSignal(props.target.peer)
  const peer = () => area()?.peers?.find((item) => item.key === peerKey())
  /** What this connection may do to a peer (enable.ts `peerActions`). */
  const peerChoices = createMemo(() => {
    const current = runtime()
    if (!current) return []
    return peerActions({
      has: (feature) => current.team.has(feature),
      allowed: (method) => current.team.rpc.allowed(method),
    })
  })
  /** 메모 바꾸기… on the owner's row: this build of own.team keeps an owner note and this connection may edit the area. */
  const noteEditable = () => {
    const current = runtime()
    return (
      !!current && current.team.has("owner-note") && current.team.rpc.allowed("area.edit") && area()?.state === "active"
    )
  }
  /** A conversation's title as the sidebar shows it: what 동료로 등록… registers, who takes or holds the seat. */
  const titleOf = (sessionID: string) => {
    const current = runtime()
    return (
      teamTitle(
        current?.data.session.get(sessionID)?.title || current?.sessions.state.sessions[sessionID]?.title,
        current?.team.placeOf(sessionID)?.role,
        i18n.locale(),
      ) ||
      i18n.t("own.shell.untitled")
    )
  }
  /** The conversation 이 대화를 담당으로 asks about: the request's, else the row of 팀과 이야기하는 대화 it was chosen on. */
  const [seatID, setSeatID] = createSignal(props.target.panel === "seat" ? props.target.sessionID : undefined)
  /** Whether a conversation of the area may take its seat (enable.ts `peerItems`). */
  const seatable = (sessionID: string) => {
    const current = runtime()
    if (!current) return false
    const items = peerItems(current, { sessionID, directory: current.sessions.directory(sessionID) })?.items
    return !!items?.includes("seat")
  }
  /** Why the seat cannot move now although the conversation may take it (enable.ts `seatBlock`). */
  const seatBlocked = () => {
    const current = runtime()
    const key = current && seatBlock(current.team, ids.teamID)
    return key ? text(key) : undefined
  }
  /** 대화 옮기기: root conversations of the team's project outside the area's folder (view-model.ts). */
  const candidates = createMemo(() => {
    const current = runtime()
    const value = area()
    const team = entry()
    if (!current || !value || !team) return []
    const index = current.sessions.state
    return moveCandidates({
      area: value,
      projectID: team.team.projectID,
      sessions: index.order.flatMap((sessionID) => index.sessions[sessionID] ?? []),
      place: (sessionID) => current.team.placeOf(sessionID),
    })
  })
  /** The team's other active areas, for 영역 묶기. */
  const peers = createMemo(() => {
    const team = entry()
    if (!team) return []
    return team.order.flatMap((id) => {
      const other = team.areas[id]
      return other && other.id !== ids.areaID && other.state === "active" ? [{ id: other.id, name: other.name }] : []
    })
  })
  let popover!: HTMLDivElement
  untrack(() => runtime()?.team.ensure())

  /** `sessionID`: the conversation that runs `ref`, whose account it names (SL-8: Claude accounts share a provider). */
  const named = (
    current: ServerRuntime,
    ref: { readonly providerID: string; readonly id: string; readonly variant?: string },
    sessionID: string | null | undefined,
    directory?: string,
  ): RunningOn => ({
    model: modelName(current, ref, directory),
    // The model's default effort is left out (`RunningOn`).
    effort: ref.variant && ref.variant !== "default" ? variantName(i18n, ref.variant) : undefined,
    account: accountOf(current, ref.providerID, sessionID ?? undefined)?.label,
  })
  // The bindings of the area's owner, the team main and the conversation that may take the seat, whose accounts the
  // menu names. Keyed by the ids, so a registry update that keeps them reads nothing again.
  const holders = createMemo(() =>
    [area()?.owner.sessionID, entry()?.team.main.sessionID, seatID()]
      .flatMap((sessionID) => (sessionID ? [sessionID] : []))
      .join(" "),
  )
  createEffect(
    on([runtime, holders], ([current, ids]) => {
      if (current && ids) onCleanup(current.own.watchVisible(ids.split(" ")))
    }),
  )
  /** A conversation's model (its binding, else what the session data knows). */
  const refOf = (sessionID: string | null | undefined) => {
    const current = runtime()
    if (!current || !sessionID) return undefined
    return (
      current.own.state.binding[sessionID]?.model ??
      current.data.session.get(sessionID)?.model ??
      current.sessions.state.sessions[sessionID]?.model
    )
  }
  const teamRef = () => refOf(entry()?.team.main.sessionID)
  /** The seat confirm's one sentence: the area, the conversation and what it runs on (left out while unknown). */
  const seatLine = (sessionID: string) => {
    const current = runtime()
    const ref = refOf(sessionID)
    const names = { area: area()?.name ?? "", name: titleOf(sessionID) }
    if (!current || !ref) return text("own.team.seat.confirmPlain", names)
    return text("own.team.seat.confirm", {
      ...names,
      model: runningOn(text, named(current, ref, sessionID, current.sessions.directory(sessionID))),
    })
  }
  /** The area main: its own (`area.main`), else the team main's. */
  const mainRef = () => area()?.main?.model ?? teamRef()
  const presetLabel = (presetID: string) => {
    const preset = presetByID(data.local().own.state.presetGroups, presetID)
    return preset ? presetName(preset, names("own.preset.builtin")) : presetID
  }
  const top = createMemo(() => {
    const current = runtime()
    const value = area()
    if (!current || !value) return undefined
    const own = value.main?.model
    const team = teamRef()
    return {
      main: mainLine(
        text,
        own && named(current, own, value.owner.sessionID, value.directory),
        team ? named(current, team, entry()?.team.main.sessionID) : undefined,
      ),
      preset: presetLine(text, presetLabel(value.preset)),
      builtin: Preset.isBuiltin(value.preset),
    }
  })
  const actions = createMemo(() => {
    const current = runtime()
    const value = area()
    if (!current || !value) return []
    return areaActions({
      area: value,
      has: (feature) => current.team.has(feature),
      allowed: (method) => current.team.rpc.allowed(method),
      peers: peers().length,
      discuss: entry()?.team.main.sessionID !== undefined,
    })
  })

  onMount(() => {
    const anchor = props.target.anchor
    try {
      // SAFETY: `source` (Chromium 133+) makes the opener the invoker, exempt from light dismiss; older engines
      // ignore the option.
      ;(popover.showPopover as (options?: { source?: HTMLElement }) => void)(anchor ? { source: anchor } : undefined)
    } catch {
      popover.showPopover()
    }
    place()
  })
  // Each panel (the menu first) is placed again and takes focus once drawn.
  createEffect(() => {
    panel()
    nextFrame(() => {
      place()
      focusFirst()
    })
  })

  function place() {
    const anchor = props.target.anchor
    const width = popover.offsetWidth
    const height = popover.offsetHeight
    if (!anchor?.isConnected) {
      popover.style.left = `${Math.max(8, (innerWidth - width) / 2)}px`
      popover.style.top = `${Math.max(8, Math.min(80, innerHeight - height - 8))}px`
      return
    }
    const rect = anchor.getBoundingClientRect()
    popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`
    popover.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`
  }

  function focusFirst() {
    popover
      .querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled), input, textarea, [role="group"] button')
      ?.focus()
  }

  function close() {
    if (popover.matches(":popover-open")) popover.hidePopover()
  }

  async function run(work: () => Promise<unknown>, describe = (error: unknown) => errorText(text, error)) {
    if (busy()) return
    setBusy(true)
    try {
      await work()
      close()
    } catch (error) {
      showToast({ message: describe(error), tone: "danger" })
    } finally {
      setBusy(false)
    }
  }

  const peerError = (error: unknown) => peerErrorText(text, error)

  /** 동료 추가… (a new conversation, which the toast opens) or 동료로 등록… (the conversation `sessionID`). */
  function addPeer(form: { readonly label: string; readonly role: string }, sessionID?: string) {
    void run(async () => {
      const output = await runtime()!.team.rpc.call("area.peer.add", peerAddInput(ids, form, sessionID))
      const message = text("own.team.peer.added", { label: output.peer.label, area: output.area.name })
      if (sessionID) return void showToast({ message })
      const serverKey = props.target.serverKey
      showToast({
        message,
        action: {
          label: text("own.team.action.open"),
          run: () => router.navigate({ name: "session", serverKey, sessionID: output.peer.sessionID }),
        },
      })
    }, peerError)
  }

  /** 역할 바꾸기…: only what changed goes; nothing changed closes the menu. */
  function editPeer(current: OwnTeam.Peer, form: { readonly label: string; readonly role: string }) {
    const input = peerEditInput(ids, current, form)
    if (!input) return close()
    void run(async () => {
      await runtime()!.team.rpc.call("area.peer.edit", input)
      showToast({ message: text("own.team.peer.edited", { label: form.label }) })
    }, peerError)
  }

  /** 동료에서 빼기: the conversation stays; main requests that waited for the peer are not sent. */
  function removePeer(current: OwnTeam.Peer) {
    void run(async () => {
      await runtime()!.team.rpc.call("area.peer.remove", { ...ids, key: current.key })
      showToast({ message: text("own.team.peer.removed", { label: current.label }) })
    }, peerError)
  }

  /** A peer's name in the menu opens its conversation. */
  function openPeer(sessionID: string) {
    close()
    router.navigate({ name: "session", serverKey: props.target.serverKey, sessionID })
  }

  function choose(action: AreaAction) {
    const current = runtime()
    const value = area()
    if (!current || !value) return
    switch (action) {
      case "open": {
        const sessionID = value.owner.sessionID
        close()
        if (sessionID) router.navigate({ name: "session", serverKey: props.target.serverKey, sessionID })
        return
      }
      case "pause":
        close()
        return void pauseArea(current, ids, value.paused === false, i18n.locale())
      case "handBack":
        // 2026-11-14: hands the area back to the main; the waiting main requests go in, the reports go to the main.
        close()
        return void pauseArea(current, ids, false, i18n.locale())
      case "discuss": {
        // 2026-10-16: a draft about this area in the team main's composer; the user edits and sends it.
        const main = entry()?.team.main.sessionID
        close()
        if (!main) return
        const serverKey = props.target.serverKey
        router.navigate({ name: "session", serverKey, sessionID: main })
        requestAnimationFrame(() => {
          requestComposerRestore({
            serverKey,
            sessionID: main,
            text: text("own.team.areaMenu.discussDraft", { area: value.name }),
            attachments: [],
            mode: "fill",
          })
          document.getElementById("own-composer-input")?.focus()
        })
        return
      }
      case "rotate":
        // 2026-10-16: a one-line confirm first (the previous conversation stays as 지난 대화).
        return setPanel("rotate")
      case "main":
        close()
        // The switcher registers its area mode with its chunk; the request waits in the channel until then.
        void import("@/switcher/team-flow").catch(report)
        return openSwitcherForArea(props.target)
      case "userMade":
        // 2026-10-26: the mark goes on or off at once (`area.edit`); the main reads it in its next team update.
        return void run(async () => {
          const on = value.userMade === undefined
          await current.team.rpc.call("area.edit", { ...ids, userMade: on })
          showToast({ message: text(on ? "own.team.userMade.on" : "own.team.userMade.off", { area: value.name }) })
        })
      case "integrate":
        // 7.1: the candidate the owner reported, else the area's latest work; the card follows (9.7).
        return void run(async () => {
          await current.team.rpc.call("area.integrate", ids)
          showToast({ message: text("own.team.integrate.running", { area: value.name }) })
        })
      case "addPeer":
      case "outbox":
      case "preset":
      case "role":
      case "alias":
      case "paths":
      case "rename":
      case "split":
      case "merge":
      case "convert":
      case "move":
      case "recreate":
      case "retire":
      case "unadopt":
      case "details":
        return setPanel(action)
    }
  }

  /**
   * The user's own reorganization (06 §2.7, §8.2): its result card follows above the team main. A split or a new area
   * (다시 만들기) on an SSH host whose repository uses LFS may need the large-file tool first (4.13, `withLfs`).
   */
  function reorganize(proposal: OwnTeam.Proposal) {
    return run(async () => {
      const current = runtime()!
      await withLfs(
        () => current.team.rpc.call("reorg.apply", { teamID: ids.teamID, proposal }),
        lfsUpload(data, props.target.serverKey),
      )
      showToast({ message: text("own.team.reorg.running") })
    })
  }

  const label = (action: AreaAction) => {
    const value = area()
    switch (action) {
      case "open":
        return text("own.team.areaMenu.openOwner")
      case "discuss":
        return text("own.team.areaMenu.discuss")
      case "addPeer":
        return text("own.team.areaMenu.addPeer")
      case "handBack":
        return text("own.team.action.handBack")
      case "pause":
        return text(value?.paused === false ? "own.team.action.pauseOn" : "own.team.action.pauseOff")
      case "outbox":
        return text("own.team.areaMenu.outbox")
      case "rotate":
        return text("own.team.areaMenu.rotate")
      case "main":
        return text("own.team.areaMenu.main")
      case "preset":
        return text("own.team.areaMenu.preset")
      case "role":
        return text("own.team.areaMenu.role")
      case "alias":
        return text("own.team.areaMenu.alias")
      case "userMade":
        return text("own.team.areaMenu.userMade")
      case "paths":
        return text("own.team.areaMenu.paths")
      case "integrate":
        return text("own.team.areaMenu.integrate")
      case "rename":
        return text("own.team.areaMenu.rename")
      case "split":
        return text("own.team.areaMenu.split")
      case "merge":
        return text("own.team.areaMenu.merge")
      case "convert":
        return text("own.team.areaMenu.convert")
      case "move":
        return text("own.team.areaMenu.move")
      case "recreate":
        return text("own.team.areaMenu.recreate")
      case "retire":
        return text("own.team.areaMenu.retire")
      case "unadopt":
        return text("own.team.areaMenu.unadopt")
      case "details":
        return text("own.team.action.details")
    }
  }

  /** One item of the menu: its label, its hint, its testid `area-menu-<action>`; `danger` in danger tone. */
  function menuItem(action: AreaAction, danger = false) {
    const value = area()
    const check = action === "userMade"
    return (
      <button
        type="button"
        role={check ? "menuitemcheckbox" : "menuitem"}
        aria-checked={check ? value?.userMade !== undefined : undefined}
        class={danger ? DANGER_ITEM : ITEM}
        disabled={busy()}
        data-testid={`area-menu-${action}`}
        onClick={() => choose(action)}
      >
        <span>
          {label(action)}
          <Show when={check && value?.userMade}> ✓</Show>
        </span>
        <Show when={check}>
          <span class="text-[11.5px] text-own-muted">{text("own.team.areaMenu.userMadeHint")}</span>
        </Show>
        <Show when={action === "main"}>
          <span class="text-[11.5px] text-own-muted">{text("own.team.areaMenu.mainHint")}</span>
        </Show>
        <Show when={action === "alias"}>
          <span class="text-[11.5px] text-own-muted" data-testid="area-menu-alias-now">
            {value?.owner.alias
              ? text("own.team.areaMenu.aliasNow", { alias: value.owner.alias })
              : text("own.team.areaMenu.aliasNone")}
          </span>
        </Show>
        <Show when={action === "handBack"}>
          <span class="text-[11.5px] text-own-muted">{text("own.team.areaMenu.handBackHint")}</span>
        </Show>
        <Show when={action === "pause" && value?.paused === false}>
          <span class="text-[11.5px] text-own-muted">{text("own.team.sessionMenu.pauseHint")}</span>
        </Show>
        <Show when={action === "convert" && value && convertTarget(value.shape)}>
          {(to) => (
            <span class="text-[11.5px] text-own-muted">
              {text(to() === "code" ? "own.team.areaMenu.convertTo.code" : "own.team.areaMenu.convertTo.full")}
            </span>
          )}
        </Show>
      </button>
    )
  }

  /**
   * 구성 바꾸기 ▸: Enter, Space or → on the toggle opens it and moves to its first item (→ inside it too), ← closes it
   * and goes back to the toggle. A mouse click on the toggle opens or closes it.
   */
  function onStructureKey(event: KeyboardEvent) {
    const toggle = event.target === event.currentTarget
    if (event.key === "ArrowRight" || (toggle && (event.key === "Enter" || event.key === " "))) {
      event.preventDefault()
      setStructure(true)
      nextFrame(() =>
        popover.querySelector<HTMLElement>('[data-group="structure"] [role="menuitem"]:not([aria-expanded])')?.focus(),
      )
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault()
      setStructure(false)
      popover.querySelector<HTMLElement>('[data-testid="area-menu-group-structure"]')?.focus()
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    // The popover closes itself on Esc; keep the key from also closing the drawer or the sidebar around it.
    if (event.key === "Escape") return event.stopPropagation()
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const items = [...popover.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <Portal>
      <div
        ref={popover}
        popover="auto"
        role="dialog"
        aria-label={text("own.team.areaMenu.label", { area: area()?.name ?? props.target.areaID })}
        class="m-0 max-h-[calc(100dvh-16px)] w-[min(340px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-own-border bg-own-raised p-1 text-[13px] text-own-text shadow-[var(--own-shadow-float)]"
        style={{ position: "fixed", inset: "auto" }}
        data-testid="area-menu"
        data-panel={panel()}
        onToggle={(event) => {
          if (event.newState === "open") return
          const anchor = props.target.anchor
          const inside = popover.contains(document.activeElement) || document.activeElement === document.body
          props.onClose()
          if (inside && anchor?.isConnected) anchor.focus({ preventScroll: true })
        }}
        onKeyDown={onKeyDown}
      >
        <Show
          when={area()}
          fallback={
            <p class="m-0 px-2.5 py-2 text-own-muted" role="status">
              {text(runtime()?.team.state.load === "unavailable" ? "own.team.view.failed" : "own.team.view.loading")}
            </p>
          }
        >
          {(value) => (
            <>
              <Show when={top()}>
                {(line) => (
                  // A styles/seps.css line: a wrapped line never starts with `·` (UX 2026-10-27).
                  <div class="px-2.5 pt-1.5 pb-1 text-[12px] text-own-muted" data-testid="area-menu-top">
                    <span class="own-seps">
                      <span class="own-seps-in">
                        <span data-wrap>{line().main}</span>
                        <span data-wrap>
                          <span classList={{ "text-own-faint": line().builtin }}>{line().preset}</span>
                          <Show when={actions().includes("preset") && panel() !== "preset"}>
                            {" "}
                            <button
                              type="button"
                              class="rounded px-1 text-own-accent-text hover:bg-own-hover"
                              data-testid="area-menu-change"
                              onClick={() => setPanel("preset")}
                            >
                              {text("own.team.action.change")}
                            </button>
                          </Show>
                        </span>
                        <Show when={value().userMade}>
                          <span class="text-own-accent-text" data-testid="area-menu-user-made">
                            {text("own.team.areaMenu.userMade")}
                          </span>
                        </Show>
                      </span>
                    </span>
                  </div>
                )}
              </Show>
              <hr class="my-1 border-0 border-t border-own-border" />
              <Switch>
                <Match when={panel() === "menu"}>
                  <div role="menu" aria-label={text("own.team.areaMenu.label", { area: value().name })}>
                    <For each={areaGroups(actions())}>
                      {(entry) => (
                        <Switch
                          fallback={
                            <div
                              role="group"
                              aria-label={text(GROUP_KEYS[entry.group])}
                              data-group={entry.group}
                              data-testid={`area-menu-group-${entry.group}`}
                            >
                              <p class="m-0 px-2.5 pt-0.5 pb-0.5 text-[11.5px] text-own-muted">
                                {text(GROUP_KEYS[entry.group])}
                              </p>
                              <For each={entry.actions}>{(action) => menuItem(action)}</For>
                            </div>
                          }
                        >
                          <Match when={entry.group === "structure"}>
                            <div
                              role="group"
                              aria-label={text("own.team.areaMenu.group.structure")}
                              data-group="structure"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                class={ITEM}
                                aria-expanded={structure()}
                                data-testid="area-menu-group-structure"
                                onClick={() => setStructure((open) => !open)}
                                onKeyDown={onStructureKey}
                                // Space would click on its release and fold the group again.
                                onKeyUp={(event) => event.key === " " && event.preventDefault()}
                              >
                                <span>
                                  {text("own.team.areaMenu.group.structure")} {structure() ? "▾" : "▸"}
                                </span>
                              </button>
                              <Show when={structure()}>
                                <div class="pl-2" onKeyDown={onStructureKey}>
                                  <For each={entry.actions}>{(action) => menuItem(action)}</For>
                                </div>
                              </Show>
                            </div>
                          </Match>
                          <Match when={entry.group === "danger"}>
                            <hr class="my-1 border-0 border-t border-own-border" />
                            <div role="group" aria-label={text(GROUP_KEYS.danger)} data-group="danger">
                              <For each={entry.actions}>{(action) => menuItem(action, true)}</For>
                            </div>
                          </Match>
                          <Match when={entry.group === "details"}>
                            <Show when={areaTalkers(value()).length > 0}>
                              <hr class="my-1 border-0 border-t border-own-border" />
                              <div
                                role="group"
                                aria-label={text("own.team.talkers.title")}
                                data-testid="area-menu-peers"
                              >
                                <p class="m-0 px-2.5 pt-0.5 pb-0.5 text-[11.5px] text-own-muted">
                                  {text("own.team.talkers.title")}
                                </p>
                                <For each={areaTalkers(value())}>
                                  {(item) => (
                                    // The buttons that do not fit beside the name wrap under it, at the right.
                                    <div
                                      class="flex flex-wrap items-center justify-end gap-0.5"
                                      data-testid={`area-menu-${item.kind}`}
                                    >
                                      <button
                                        type="button"
                                        role="menuitem"
                                        class="flex min-w-0 flex-1 basis-32 flex-col items-start rounded-md border-0 bg-transparent px-2.5 py-1 text-left text-inherit hover:bg-own-hover focus-visible:bg-own-hover"
                                        title={item.note || undefined}
                                        aria-label={text("own.team.peer.open", {
                                          label: item.label ?? titleOf(item.sessionID),
                                        })}
                                        data-testid={`area-menu-${item.kind}-open`}
                                        onClick={() => openPeer(item.sessionID)}
                                      >
                                        <span class="flex max-w-full items-baseline gap-1.5">
                                          <span class="truncate">{item.label ?? titleOf(item.sessionID)}</span>
                                          <span class="flex-none text-[11.5px] text-own-muted">
                                            {text(
                                              item.kind === "owner" ? "own.team.talkers.owner" : "own.team.peer.word",
                                            )}
                                          </span>
                                        </span>
                                        <Show when={item.note}>
                                          <span
                                            class="max-w-full truncate text-[11.5px] text-own-muted"
                                            data-testid={`area-menu-${item.kind}-note`}
                                          >
                                            {item.note}
                                          </span>
                                        </Show>
                                      </button>
                                      <Show when={item.kind === "owner" && noteEditable()}>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class={PEER_ITEM}
                                          disabled={busy()}
                                          data-testid="area-menu-owner-note-edit"
                                          onClick={() => setPanel("ownerNote")}
                                        >
                                          {text("own.team.seat.noteEdit")}
                                        </button>
                                      </Show>
                                      <Show when={item.key}>
                                        {(key) => (
                                          <For each={peerChoices()}>
                                            {(choice) => (
                                              <button
                                                type="button"
                                                role="menuitem"
                                                class={PEER_ITEM}
                                                disabled={busy()}
                                                data-testid={`area-menu-peer-${choice}`}
                                                onClick={() => {
                                                  setPeerKey(key())
                                                  setPanel(choice === "edit" ? "editPeer" : "removePeer")
                                                }}
                                              >
                                                {text(
                                                  choice === "edit" ? "own.team.peer.edit" : "own.team.peer.remove",
                                                )}
                                              </button>
                                            )}
                                          </For>
                                        )}
                                      </Show>
                                      <Show when={item.kind === "peer" && seatable(item.sessionID)}>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          class={PEER_ITEM}
                                          disabled={busy() || seatBlocked() !== undefined}
                                          title={seatBlocked()}
                                          data-testid="area-menu-peer-seat"
                                          onClick={() => {
                                            setSeatID(item.sessionID)
                                            setPanel("seat")
                                          }}
                                        >
                                          {text("own.team.seat.make")}
                                        </button>
                                      </Show>
                                    </div>
                                  )}
                                </For>
                                <Show
                                  when={(value().peers ?? []).some((item) => seatable(item.sessionID)) && seatBlocked()}
                                >
                                  {(reason) => (
                                    <p
                                      class="m-0 px-2.5 py-0.5 text-[11.5px] text-own-muted"
                                      data-testid="area-menu-seat-blocked"
                                    >
                                      {reason()}
                                    </p>
                                  )}
                                </Show>
                              </div>
                            </Show>
                            <hr class="my-1 border-0 border-t border-own-border" />
                            {menuItem("details")}
                          </Match>
                        </Switch>
                      )}
                    </For>
                  </div>
                </Match>
                <Match when={panel() === "rotate"}>
                  <div
                    role="group"
                    aria-label={text("own.team.areaMenu.rotate")}
                    class="flex flex-col gap-1.5 px-2.5 py-1.5"
                    data-testid="area-rotate"
                  >
                    <p class="m-0 font-semibold">{text("own.team.areaMenu.rotate")}</p>
                    <p class="m-0 text-[12px] text-own-muted">
                      {text("own.team.rotate.confirm", { area: value().name })}
                    </p>
                    <span class="flex justify-end gap-1.5">
                      <button type="button" class={BUTTON} onClick={close}>
                        {text("own.team.action.cancel")}
                      </button>
                      <button
                        type="button"
                        class={BUTTON}
                        disabled={busy()}
                        data-testid="area-menu-rotate-do"
                        onClick={() => {
                          const current = runtime()
                          if (!current) return
                          void run(async () => {
                            await current.team.rpc.call("area.rotate", ids)
                            showToast({ message: text("own.team.rotate.started", { area: value().name }) })
                          })
                        }}
                      >
                        {text("own.team.rotate.do")}
                      </button>
                    </span>
                  </div>
                </Match>
                <Match when={panel() === "seat" && seatID()}>
                  {(sessionID) => (
                    <div
                      role="group"
                      aria-label={text("own.team.seat.make")}
                      class="flex flex-col gap-1.5 px-2.5 py-1.5"
                      data-testid="area-seat"
                    >
                      <p class="m-0" data-testid="area-seat-line">
                        {seatLine(sessionID())}
                      </p>
                      <Show when={runtime()?.team.peerOf(sessionID())}>
                        {(found) => (
                          // SM-23 (2026-11-14): with no owner note the peer's role becomes the note.
                          <p class="m-0 text-[12px] text-own-muted" data-testid="area-seat-peer">
                            {text(
                              found().peer.role.trim() !== "" && !found().area.owner.note?.trim()
                                ? "own.team.seat.peerRoleKept"
                                : "own.team.seat.peerLeaves",
                            )}
                          </p>
                        )}
                      </Show>
                      <Show when={seatBlocked()}>
                        {(reason) => (
                          <p class="m-0 text-[12px] text-own-muted" data-testid="area-seat-blocked">
                            {reason()}
                          </p>
                        )}
                      </Show>
                      <span class="flex justify-end gap-1.5">
                        <button type="button" class={BUTTON} onClick={close}>
                          {text("own.team.action.cancel")}
                        </button>
                        <button
                          type="button"
                          class={BUTTON}
                          disabled={seatBlocked() !== undefined}
                          data-testid="area-seat-do"
                          onClick={() => {
                            const current = runtime()
                            if (!current) return
                            close()
                            // The move outlives the menu: its toasts follow the task to its end (enable.ts).
                            void runSeat(
                              {
                                team: current.team,
                                text,
                                describe: (error) => seatErrorText(text, error),
                                toast: { show: showToast, dismiss: dismissToast },
                                name: titleOf,
                              },
                              { ...ids, sessionID: sessionID() },
                            )
                          }}
                        >
                          {text("own.team.action.change")}
                        </button>
                      </span>
                    </div>
                  )}
                </Match>
                <Match when={panel() === "ownerNote"}>
                  <OwnerNotePanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    note={value().owner.note ?? ""}
                    onSubmit={(note) =>
                      void run(async () => {
                        await runtime()!.team.rpc.call("area.edit", { ...ids, note })
                        showToast({ message: text("own.team.seat.noteSaved", { area: value().name }) })
                      })
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "alias"}>
                  <AliasPanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    alias={value().owner.alias ?? ""}
                    taken={entry() ? aliasTaken(entry()!, value().id) : []}
                    onSubmit={(alias) =>
                      void run(async () => {
                        await runtime()!.team.rpc.call("area.edit", { ...ids, alias })
                        showToast({
                          message: alias
                            ? text("own.team.alias.saved", { area: value().name, alias })
                            : text("own.team.alias.cleared", { area: value().name }),
                        })
                      })
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "addPeer"}>
                  <PeerForm
                    text={text}
                    busy={busy()}
                    title={text("own.team.peer.add.title", { area: value().name })}
                    hint={text("own.team.peer.add.hint")}
                    submit={text("own.team.peer.add.do")}
                    onSubmit={(form) => addPeer(form)}
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "registerPeer" && props.target.sessionID}>
                  {(sessionID) => (
                    <PeerForm
                      text={text}
                      busy={busy()}
                      title={text("own.team.peer.register.title", { area: value().name })}
                      subject={text("own.team.peer.register.session", { title: titleOf(sessionID()) })}
                      hint={text("own.team.peer.register.hint")}
                      submit={text("own.team.peer.register.do")}
                      onSubmit={(form) => addPeer(form, sessionID())}
                      onCancel={close}
                    />
                  )}
                </Match>
                <Match when={panel() === "editPeer" && peer()}>
                  {(current) => (
                    <PeerForm
                      text={text}
                      busy={busy()}
                      title={text("own.team.peer.edit.title", { label: current().label })}
                      label={current().label}
                      role={current().role}
                      submit={text("own.team.action.save")}
                      onSubmit={(form) => editPeer(current(), form)}
                      onCancel={close}
                    />
                  )}
                </Match>
                <Match when={panel() === "removePeer" && peer()}>
                  {(current) => (
                    <div
                      role="group"
                      aria-label={text("own.team.peer.remove.title", { label: current().label })}
                      class="flex flex-col gap-1.5 px-2.5 py-1.5"
                      data-testid="area-peer-remove"
                    >
                      <p class="m-0 font-semibold">{text("own.team.peer.remove.title", { label: current().label })}</p>
                      <p class="m-0 text-[12px] text-own-muted">{text("own.team.peer.remove.body")}</p>
                      <span class="flex justify-end gap-1.5">
                        <button type="button" class={BUTTON} onClick={close}>
                          {text("own.team.action.cancel")}
                        </button>
                        <button
                          type="button"
                          class={BUTTON}
                          disabled={busy()}
                          data-testid="area-peer-remove-confirm"
                          onClick={() => removePeer(current())}
                        >
                          {text("own.team.peer.remove")}
                        </button>
                      </span>
                    </div>
                  )}
                </Match>
                <Match when={(panel() === "editPeer" || panel() === "removePeer") && !peer()}>
                  <p class="m-0 px-2.5 py-2 text-own-muted" role="status">
                    {text("own.team.error.notFound")}
                  </p>
                </Match>
                <Match when={panel() === "outbox"}>
                  <OutboxPanel runtime={runtime()!} ids={ids} text={text} onClose={close} />
                </Match>
                <Match when={panel() === "preset"}>
                  <PresetPanel
                    runtime={runtime()!}
                    area={value()}
                    mainRef={mainRef()}
                    text={text}
                    onPick={(presetID) =>
                      void run(async () => {
                        await runtime()!.team.rpc.call("area.preset", { ...ids, presetID })
                        const worst = worstLine(presetID)
                        const applied = subagent("own.subagent.preset.applied", { name: presetLabel(presetID) })
                        showToast({ message: worst ? `${applied} · ${worst}` : applied })
                      })
                    }
                    worst={worstLine(value().preset)}
                    onClose={close}
                  />
                </Match>
                <Match when={panel() === "role"}>
                  <RolePanel
                    text={text}
                    busy={busy()}
                    max={roleMax(runtime()?.team.has)}
                    area={value().name}
                    goal={value().goal}
                    onSubmit={(goal) =>
                      void run(async () => {
                        await runtime()!.team.rpc.call("area.edit", { ...ids, goal })
                        showToast({ message: text("own.team.role.saved", { area: value().name }) })
                      })
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "paths"}>
                  <PathsPanel
                    text={text}
                    busy={busy()}
                    onSubmit={(dirs, reason) =>
                      void run(() =>
                        runtime()!.team.rpc.call("area.paths", {
                          ...ids,
                          add: dirs,
                          ...(reason ? { reason } : {}),
                        }),
                      )
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "rename"}>
                  <RenamePanel
                    text={text}
                    busy={busy()}
                    name={value().name}
                    subtitle={value().subtitle ?? ""}
                    onSubmit={(name, subtitle) =>
                      void run(() =>
                        runtime()!.team.rpc.call("reorg.apply", {
                          teamID: ids.teamID,
                          proposal: renameProposal(ids.areaID, name, subtitle),
                        }),
                      )
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "split"}>
                  <SplitPanel
                    text={text}
                    busy={busy()}
                    max={roleMax(runtime()?.team.has)}
                    area={value().name}
                    onSubmit={(name, goal) =>
                      void reorganize(
                        splitProposal(
                          ids.areaID,
                          name,
                          goal,
                          (entry()?.order ?? []).map((areaID) => areaID.slice("ar_".length)),
                        ),
                      )
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "merge"}>
                  <MergePanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    peers={peers()}
                    onPick={(from) => void reorganize(mergeProposal(ids.areaID, from))}
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "convert" && convertTarget(value().shape)}>
                  {(to) => (
                    <ConvertPanel
                      text={text}
                      busy={busy()}
                      area={value().name}
                      to={to()}
                      onConfirm={() => void reorganize(convertProposal(ids.areaID, to()))}
                      onCancel={close}
                    />
                  )}
                </Match>
                <Match when={panel() === "move"}>
                  <MovePanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    candidates={candidates()}
                    folder={(directory) => shortPath(directory, entry()?.team.home.directory ?? directory)}
                    onPick={(sessionID) => void reorganize(moveProposal(sessionID, ids.areaID))}
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "recreate"}>
                  <RecreatePanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    kind={value().state === "retired" ? "finished" : "missing"}
                    onConfirm={() => void reorganize(recreateProposal(value()))}
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "retire"}>
                  <RetirePanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    kind={
                      value().state === "retired"
                        ? "leftover"
                        : value().state === "broken" && value().broken?.why === "missing"
                          ? "missing"
                          : "active"
                    }
                    onConfirm={() => void reorganize(retireProposal(ids.areaID))}
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "unadopt"}>
                  <UnadoptPanel
                    text={text}
                    busy={busy()}
                    area={value().name}
                    onConfirm={() =>
                      void run(async () => {
                        await runtime()!.team.rpc.call("area.unadopt", ids)
                        showToast({ message: text("own.team.unadopt.running", { area: value().name }) })
                      })
                    }
                    onCancel={close}
                  />
                </Match>
                <Match when={panel() === "details"}>
                  <DetailsPanel area={value()} text={text} onClose={close} />
                </Match>
              </Switch>
            </>
          )}
        </Show>
      </div>
    </Portal>
  )

  /** The team's worst case with this area on `presetID` (06 §10.3), when it is heavy. */
  function worstLine(presetID: string) {
    const current = runtime()
    const team = entry()
    if (!current || !team) return undefined
    const local = data.local().own.state
    const shared = teamRef()
    return worstWith(
      text,
      team,
      { areaID: ids.areaID, presetID },
      (id) => presetByID(local.presetGroups, id),
      local.presetSettings.ultraCaps,
      {
        ...(shared ? { shared: accountOf(current, shared.providerID, team.team.main.sessionID)?.label } : {}),
        metered: (accountID) => {
          const billing = current.own.state.accounts[accountID]?.billing
          return billing === "metered" || billing === "prepaid"
        },
      },
    )
  }
}

/** 기다리는 메인 요청 보기 (06 §5.2): the outbox, why it waits, the peer a request goes to, `지우기` per request. */
function OutboxPanel(props: {
  readonly runtime: ServerRuntime
  readonly ids: { readonly teamID: OwnTeam.TeamID; readonly areaID: OwnTeam.AreaID }
  readonly text: TeamText
  readonly onClose: () => void
}) {
  const [outbox, { refetch }] = createResource(() => props.runtime.team.rpc.call("outbox.list", props.ids))
  const [removing, setRemoving] = createSignal<string>()
  const cancellable = () => props.runtime.team.has("outbox") && props.runtime.team.rpc.allowed("outbox.cancel")
  const peerLabel = (key: string) =>
    props.runtime.team.area(props.ids.teamID, props.ids.areaID)?.peers?.find((peer) => peer.key === key)?.label ?? key
  /** Who an item comes from: the main, the program, or another area's owner or peer (06 §5.8). */
  const from = (item: OwnTeam.Dispatch) => {
    const sender = item.sender
    if (item.from !== "area" || !sender) return props.text(`own.team.outbox.from.${item.from}`, { area: "", label: "" })
    return sender.peer
      ? props.text("own.team.outbox.from.areaPeer", { area: sender.area, label: sender.peer.label })
      : props.text("own.team.outbox.from.area", { area: sender.area })
  }
  // `outbox.changed` (another window, a delivery) reads the list again.
  onCleanup(
    props.runtime.team.on("outbox.changed", (event) => {
      if (event.data.areaID === props.ids.areaID) void refetch()
    }),
  )
  async function cancel(dispatchID: OwnTeam.DispatchID) {
    setRemoving(dispatchID)
    try {
      await props.runtime.team.rpc.call("outbox.cancel", { ...props.ids, dispatchID })
      showToast({ message: props.text("own.team.outbox.cancelled") })
      await refetch()
    } catch (error) {
      showToast({ message: errorText(props.text, error), tone: "danger" })
    } finally {
      setRemoving(undefined)
    }
  }
  return (
    <div role="group" aria-label={props.text("own.team.outbox.title")} class="flex flex-col gap-1.5 px-2.5 py-1.5">
      <p class="m-0 font-semibold">{props.text("own.team.outbox.title")}</p>
      <Show when={outbox.error}>
        <p class="m-0 text-own-danger">{errorText(props.text, outbox.error)}</p>
      </Show>
      <Show when={outbox()}>
        {(answer) => (
          <>
            <Show when={answer().why}>
              {(why) => (
                <p class="m-0 text-[12px] text-own-muted">
                  {props.text(answer().cause?.direct ? "own.team.outbox.why.direct" : `own.team.outbox.why.${why()}`)}
                </p>
              )}
            </Show>
            <Show
              when={answer().items.length > 0}
              fallback={<p class="m-0 text-own-muted">{props.text("own.team.outbox.empty")}</p>}
            >
              <ul
                class="m-0 flex max-h-[50vh] list-none flex-col gap-1.5 overflow-y-auto p-0"
                data-testid="outbox-list"
              >
                <For each={answer().items}>
                  {(item) => (
                    <li class="flex flex-col gap-0.5 rounded-md border border-own-border p-2" data-testid="outbox-item">
                      <span class="text-[11.5px] text-own-muted">
                        {[
                          from(item),
                          // A main request to an area peer names it (`to`, its key; a peer removed since by its key).
                          ...(item.to ? [props.text("own.team.outbox.to", { label: peerLabel(item.to) })] : []),
                          props.text(`own.team.outbox.kind.${item.kind}`),
                          ...(item.fresh ? [props.text("own.team.outbox.fresh")] : []),
                          ...(item.task ? [props.text("own.team.outbox.task", { task: item.task })] : []),
                        ].join(" · ")}
                      </span>
                      <ClampedText text={props.text} value={item.text} />
                      <Show when={cancellable()}>
                        <button
                          type="button"
                          class={`${BUTTON} self-end`}
                          disabled={removing() !== undefined}
                          data-testid="outbox-cancel"
                          onClick={() => void cancel(item.id)}
                        >
                          {props.text("own.team.outbox.cancel")}
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            {/* Notes (쪽지) other areas left for the owner or a peer: no turn, they go with the next request (5.8). */}
            <Show when={answer().notes?.length}>
              {(count) => (
                <div class="flex flex-col gap-1.5" data-testid="outbox-notes">
                  <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.outbox.notes", { n: count() })}</p>
                  <For each={answer().notes ?? []}>
                    {(note) => (
                      <div
                        class="flex flex-col gap-0.5 rounded-md border border-own-border p-2"
                        data-testid="outbox-note"
                      >
                        <span class="text-[11.5px] text-own-muted">
                          {[
                            props.text("own.team.outbox.note", {
                              name: OwnTeamText.senderName(note.sender),
                              time: formatClock(note.at),
                            }),
                            ...(note.to ? [props.text("own.team.outbox.to", { label: peerLabel(note.to) })] : []),
                          ].join(" · ")}
                        </span>
                        <ClampedText text={props.text} value={note.text} />
                      </div>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
      <button type="button" class={`${BUTTON} self-end`} onClick={() => props.onClose()}>
        {props.text("own.team.action.close")}
      </button>
    </div>
  )
}

/**
 * A request or note text clamped to three lines (2026-11-14: they carry up to 20,000 characters whole): when the clamp
 * hides some of it, `원문 보기` / `원문 접기` opens and folds the whole text.
 */
function ClampedText(props: { readonly text: TeamText; readonly value: string }) {
  const [open, setOpen] = createSignal(false)
  const [clamped, setClamped] = createSignal(false)
  let shown: HTMLSpanElement | undefined
  onMount(() => nextFrame(() => setClamped(shown !== undefined && shown.scrollHeight > shown.clientHeight + 1)))
  return (
    <>
      <span ref={shown} class="overflow-wrap-anywhere whitespace-pre-wrap" classList={{ "line-clamp-3": !open() }}>
        {props.value}
      </span>
      <Show when={clamped() || open()}>
        <button
          type="button"
          class={`${BUTTON} self-start`}
          aria-expanded={open()}
          data-testid="outbox-expand"
          onClick={() => setOpen(!open())}
        >
          {props.text(open() ? "own.team.sent.hideOriginal" : "own.team.sent.showOriginal")}
        </button>
      </Show>
    </>
  )
}

/**
 * 프리셋 바꾸기… (06 §10.1, 07 §7.4): the presets of the area main's group (the composer's menu), a preset that would
 * break the team's R4 dimmed with the account it would add, and the team's worst case while it is heavy. The team's
 * accounts come from the preset binding of the area's owner (else the team main), read while the panel is open.
 */
function PresetPanel(props: {
  readonly runtime: ServerRuntime
  readonly area: OwnTeam.AreaView
  readonly mainRef: { readonly providerID: string; readonly id: string; readonly variant?: string } | undefined
  readonly text: TeamText
  readonly worst: string | undefined
  readonly onPick: (presetID: Preset.ID) => void
  readonly onClose: () => void
}) {
  const subagent = useSubagentText()
  const own = () => props.runtime.own
  const holder = () => props.area.owner.sessionID ?? props.runtime.team.team(props.area.teamID)?.team.main.sessionID
  createEffect(() => {
    const sessionID = holder()
    if (sessionID) onCleanup(own().watchPreset(sessionID))
  })
  // R4 (`teamClash`) judges every Claude account as the Claude slot, like the server's team context: the provider's
  // account, never the holder's Claude account (SL-8); the group is the account's kind either way.
  const account = () => (props.mainRef ? accountOf(props.runtime, props.mainRef.providerID) : undefined)
  const group = () => mainGroup(props.mainRef, (providerID) => accountOf(props.runtime, providerID))
  const clash = (preset: Preset.Info) => {
    const sessionID = holder()
    const team = sessionID ? own().state.sessionPreset[sessionID]?.binding?.team : undefined
    const accountID = teamClash(preset, account()?.id ?? null, (id) => own().state.accounts[id], team)
    return accountID
      ? subagent("own.subagent.preset.teamClash", { account: own().state.accounts[accountID]?.label ?? accountID })
      : undefined
  }
  return (
    <div role="group" aria-label={props.text("own.team.presetPicker.title", { area: props.area.name })}>
      <p class="m-0 px-2.5 pt-1 pb-0.5 font-semibold">
        {props.text("own.team.presetPicker.title", { area: props.area.name })}
      </p>
      <Show
        when={group()}
        fallback={<p class="m-0 px-2.5 py-1.5 text-own-muted">{props.text("own.team.view.loading")}</p>}
      >
        {(value) => (
          <PresetMenu
            group={value()}
            current={props.area.preset}
            server={props.runtime}
            area
            main={props.mainRef}
            disabled={clash}
            onPick={(presetID) => props.onPick(presetID)}
            onClose={() => props.onClose()}
            style={{ display: "flex", "flex-direction": "column", padding: "2px 0" }}
          />
        )}
      </Show>
      <Show when={props.worst}>
        {(line) => (
          <p class="m-0 px-2.5 pt-1 pb-1.5 text-[11.5px] text-own-warn" data-testid="area-preset-worst">
            {line()}
          </p>
        )}
      </Show>
    </div>
  )
}

/** 큰 파일 폴더 가져오기… (06 §4.6): folders from the repository root, one per line, and the reason. */
function PathsPanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly onSubmit: (dirs: string[], reason: string) => void
  readonly onCancel: () => void
}) {
  const [dirs, setDirs] = createSignal("")
  const [reason, setReason] = createSignal("")
  const form = createMemo(() => pathsForm(dirs()))
  const over = createUniqueId()
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.text("own.team.paths.title")}
      onSubmit={(event) => {
        event.preventDefault()
        if (form().ok) props.onSubmit(form().dirs, reason().trim())
      }}
    >
      <p class="m-0 font-semibold">{props.text("own.team.paths.title")}</p>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.paths.dirs")}
        <textarea
          class={`${FIELD} min-h-[72px] font-mono`}
          value={dirs()}
          aria-describedby={over}
          aria-invalid={form().dirs.length > PATHS_MAX}
          data-testid="area-paths-dirs"
          onInput={(event) => setDirs(event.currentTarget.value)}
        />
      </label>
      <span id={over} class="text-[11.5px] text-own-danger empty:hidden" aria-live="polite">
        <Show when={form().dirs.length > PATHS_MAX}>
          <span data-testid="area-paths-over">
            {props.text("own.team.paths.over", { max: PATHS_MAX, n: form().dirs.length })}
          </span>
        </Show>
      </span>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.paths.reason")}
        <input
          class={FIELD}
          value={reason()}
          maxLength={200}
          data-testid="area-paths-reason"
          onInput={(event) => setReason(event.currentTarget.value)}
        />
      </label>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button type="submit" class={BUTTON} disabled={props.busy || !form().ok} data-testid="area-paths-fetch">
          {props.text("own.team.paths.fetch")}
        </button>
      </span>
    </form>
  )
}

/** 이름 바꾸기 (06 §8.2): name and subtitle, as the user's own `reorg.apply` (2.7). */
function RenamePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly name: string
  readonly subtitle: string
  readonly onSubmit: (name: string, subtitle: string) => void
  readonly onCancel: () => void
}) {
  const [name, setName] = createSignal(untrack(() => props.name))
  const [subtitle, setSubtitle] = createSignal(untrack(() => props.subtitle))
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.text("own.team.rename.title")}
      onSubmit={(event) => {
        event.preventDefault()
        if (name().trim()) props.onSubmit(name(), subtitle())
      }}
    >
      <p class="m-0 font-semibold">{props.text("own.team.rename.title")}</p>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.rename.name")}
        <input
          class={FIELD}
          value={name()}
          maxLength={NAME_MAX}
          data-testid="area-rename-name"
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.rename.subtitle")}
        <input
          class={FIELD}
          value={subtitle()}
          maxLength={NAME_MAX}
          data-testid="area-rename-subtitle"
          onInput={(event) => setSubtitle(event.currentTarget.value)}
        />
      </label>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button type="submit" class={BUTTON} disabled={props.busy || !name().trim()} data-testid="area-rename-save">
          {props.text("own.team.action.save")}
        </button>
      </span>
    </form>
  )
}

/**
 * A peer's 이름 and 역할 (동료 추가…, 동료로 등록…, 역할 바꾸기…): the name is required and at most 40 characters, the
 * role at most 1,024 characters, with the characters left (or how far it is over) under it (view-model.ts `peerForm`).
 */
function PeerForm(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly title: string
  /** 동료로 등록…: the conversation it registers. */
  readonly subject?: string
  readonly hint?: string
  readonly label?: string
  readonly role?: string
  readonly submit: string
  readonly onSubmit: (form: { readonly label: string; readonly role: string }) => void
  readonly onCancel: () => void
}) {
  const [label, setLabel] = createSignal(untrack(() => props.label ?? ""))
  const [role, setRole] = createSignal(untrack(() => props.role ?? ""))
  const form = createMemo(() => peerForm(label(), role()))
  const left = createUniqueId()
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.title}
      data-testid="area-peer-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (form().ok) props.onSubmit({ label: form().label, role: form().role })
      }}
    >
      <p class="m-0 font-semibold">{props.title}</p>
      <Show when={props.subject}>{(subject) => <p class="m-0 truncate text-[12px]">{subject()}</p>}</Show>
      <Show when={props.hint}>{(hint) => <p class="m-0 text-[12px] text-own-muted">{hint()}</p>}</Show>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.peer.label")}
        <input
          class={FIELD}
          value={label()}
          maxLength={PEER_LABEL_MAX}
          required
          data-testid="area-peer-label"
          onInput={(event) => setLabel(event.currentTarget.value)}
        />
      </label>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.peer.role")}
        <textarea
          class={`${FIELD} min-h-[88px]`}
          value={role()}
          placeholder={props.text("own.team.peer.rolePlaceholder")}
          aria-describedby={left}
          aria-invalid={form().left < 0}
          data-testid="area-peer-role"
          onInput={(event) => setRole(event.currentTarget.value)}
        />
      </label>
      <RoleTemplates text={props.text} onPick={(value) => setRole(value)} />
      <span
        id={left}
        class="text-[11.5px]"
        classList={{ "text-own-muted": form().left >= 0, "text-own-danger": form().left < 0 }}
        data-testid="area-peer-role-left"
      >
        {form().left < 0
          ? props.text("own.team.peer.roleOver", { n: -form().left })
          : props.text("own.team.peer.roleLeft", { n: form().left })}
      </span>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button type="submit" class={BUTTON} disabled={props.busy || !form().ok} data-testid="area-peer-save">
          {props.submit}
        </button>
      </span>
    </form>
  )
}

/**
 * 팀에서 빼기 (06 §8.2, §8.8): the folder, its record name and the conversations stay; waiting main requests are not
 * sent. Focus starts on 취소.
 */
function UnadoptPanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  return (
    <div
      role="group"
      aria-label={props.text("own.team.unadopt.title", { area: props.area })}
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      data-testid="area-unadopt"
    >
      <p class="m-0 font-semibold">{props.text("own.team.unadopt.title", { area: props.area })}</p>
      <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.unadopt.body")}</p>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button
          type="button"
          class={BUTTON}
          disabled={props.busy}
          data-testid="area-unadopt-confirm"
          onClick={() => props.onConfirm()}
        >
          {props.text("own.team.areaMenu.unadopt")}
        </button>
      </span>
    </div>
  )
}

/**
 * 역할 바꾸기… (06 §9.4, 2026-10-26): the area's role (its `goal`, at most `max` characters) with the role templates, as
 * `area.edit{goal}`; an attached owner gets it at once.
 */
function RolePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly goal: string
  /** The longest role the server keeps ({@link roleMax}). */
  readonly max: number
  readonly onSubmit: (goal: string) => void
  readonly onCancel: () => void
}) {
  const [goal, setGoal] = createSignal(untrack(() => props.goal))
  const left = () => roleLeft(goal(), props.max)
  const counter = createUniqueId()
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.text("own.team.role.title", { area: props.area })}
      data-testid="area-role"
      onSubmit={(event) => {
        event.preventDefault()
        if (left() >= 0) props.onSubmit(goal().trim())
      }}
    >
      <p class="m-0 font-semibold">{props.text("own.team.role.title", { area: props.area })}</p>
      <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.role.hint")}</p>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.createArea.role")}
        <textarea
          class={`${FIELD} min-h-[72px]`}
          value={goal()}
          placeholder={props.text("own.team.createArea.rolePlaceholder")}
          aria-describedby={counter}
          aria-invalid={left() < 0}
          data-testid="area-role-text"
          onInput={(event) => setGoal(event.currentTarget.value)}
        />
      </label>
      <RoleTemplates text={props.text} onPick={(value) => setGoal(value)} />
      <span
        id={counter}
        class="text-[11.5px]"
        classList={{ "text-own-muted": left() >= 0, "text-own-danger": left() < 0 }}
        aria-live="polite"
        data-testid="area-role-left"
      >
        {left() < 0
          ? props.text("own.team.createArea.roleOver", { n: -left() })
          : props.text("own.team.createArea.roleLeft", { n: left() })}
      </span>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button type="submit" class={BUTTON} disabled={props.busy || left() < 0} data-testid="area-role-save">
          {props.text("own.team.action.save")}
        </button>
      </span>
    </form>
  )
}

/**
 * 메모 바꾸기… (담당 대화 바꾸기, 2026-11-12): the owner note, at most 1,024 characters with the characters left under
 * it as the peers' role has (view-model.ts `noteForm`), as `area.edit{note}`; an empty note removes it.
 */
function OwnerNotePanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly note: string
  readonly onSubmit: (note: string) => void
  readonly onCancel: () => void
}) {
  const [note, setNote] = createSignal(untrack(() => props.note))
  const form = createMemo(() => noteForm(note()))
  const left = createUniqueId()
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.text("own.team.seat.noteTitle", { area: props.area })}
      data-testid="area-owner-note"
      onSubmit={(event) => {
        event.preventDefault()
        if (form().ok) props.onSubmit(form().note)
      }}
    >
      <p class="m-0 font-semibold">{props.text("own.team.seat.noteTitle", { area: props.area })}</p>
      <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.seat.noteHint")}</p>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.seat.note")}
        <textarea
          class={`${FIELD} min-h-[88px]`}
          value={note()}
          placeholder={props.text("own.team.seat.notePlaceholder")}
          aria-describedby={left}
          aria-invalid={form().left < 0}
          data-testid="area-owner-note-text"
          onInput={(event) => setNote(event.currentTarget.value)}
        />
      </label>
      <span
        id={left}
        class="text-[11.5px]"
        classList={{ "text-own-muted": form().left >= 0, "text-own-danger": form().left < 0 }}
        data-testid="area-owner-note-left"
      >
        {form().left < 0
          ? props.text("own.team.peer.roleOver", { n: -form().left })
          : props.text("own.team.peer.roleLeft", { n: form().left })}
      </span>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button type="submit" class={BUTTON} disabled={props.busy || !form().ok} data-testid="area-owner-note-save">
          {props.text("own.team.action.save")}
        </button>
      </span>
    </form>
  )
}

/**
 * 별칭 바꾸기… (2026-11-27): the owner alias, at most 12 characters on one line, unique in the team (view-model.ts
 * `aliasForm`), as `area.edit{alias}`; an empty one removes it. The team main may call the area by it and the screens
 * show `별칭 · 영역`; the owner conversation is not told.
 */
function AliasPanel(props: {
  readonly text: TeamText
  readonly busy: boolean
  readonly area: string
  readonly alias: string
  readonly taken: readonly string[]
  readonly onSubmit: (alias: string) => void
  readonly onCancel: () => void
}) {
  const [alias, setAlias] = createSignal(untrack(() => props.alias))
  const form = createMemo(() => aliasForm(alias(), props.taken))
  const said = createUniqueId()
  const problem = () => {
    const value = form()
    if (value.left < 0) return props.text("own.team.alias.over", { n: -value.left })
    if (!value.line) return props.text("own.team.alias.line")
    if (!value.free) return props.text("own.team.alias.taken")
    return undefined
  }
  return (
    <form
      class="flex flex-col gap-1.5 px-2.5 py-1.5"
      aria-label={props.text("own.team.alias.title", { area: props.area })}
      data-testid="area-alias"
      onSubmit={(event) => {
        event.preventDefault()
        if (form().ok) props.onSubmit(form().alias)
      }}
    >
      <p class="m-0 font-semibold">{props.text("own.team.alias.title", { area: props.area })}</p>
      <p class="m-0 text-[12px] text-own-muted">{props.text("own.team.alias.hint")}</p>
      <label class="flex flex-col gap-0.5 text-[12px] text-own-muted">
        {props.text("own.team.alias.field")}
        <input
          class={FIELD}
          value={alias()}
          placeholder={props.text("own.team.alias.placeholder")}
          aria-describedby={said}
          aria-invalid={!form().ok}
          autocomplete="off"
          data-testid="area-alias-text"
          onInput={(event) => setAlias(event.currentTarget.value)}
        />
      </label>
      <span
        id={said}
        class="text-[11.5px]"
        classList={{ "text-own-muted": form().ok, "text-own-danger": !form().ok }}
        data-testid="area-alias-left"
      >
        {problem() ?? props.text("own.team.alias.left", { n: form().left })}
      </span>
      <span class="flex justify-end gap-1.5">
        <button type="button" class={BUTTON} onClick={() => props.onCancel()}>
          {props.text("own.team.action.cancel")}
        </button>
        <button type="submit" class={BUTTON} disabled={props.busy || !form().ok} data-testid="area-alias-save">
          {props.text("own.team.action.save")}
        </button>
      </span>
    </form>
  )
}

/** 자세히 (06 §9.4): the folder's path, its record name, its kind, and the large-file folders it fetched or kept. */
function DetailsPanel(props: {
  readonly area: OwnTeam.AreaView
  readonly text: TeamText
  readonly onClose: () => void
}) {
  const extra = () => Object.keys(props.area.cone.extra)
  const kept = () => Object.entries(props.area.cone.kept)
  return (
    <div role="group" aria-label={props.text("own.team.action.details")} class="flex flex-col gap-1.5 px-2.5 py-1.5">
      <dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]" data-testid="area-details">
        <dt class="text-own-muted">{props.text("own.team.details.folder")}</dt>
        <dd class="m-0 flex flex-col">
          <span class="font-mono break-all">{props.area.directory}</span>
          <span class="text-own-muted">{props.text(`own.team.details.shape.${props.area.shape}`)}</span>
        </dd>
        <dt class="text-own-muted">{props.text("own.team.details.record")}</dt>
        <dd class="m-0 font-mono break-all">{props.area.branch}</dd>
        <Show when={extra().length > 0}>
          <dt class="text-own-muted">{props.text("own.team.details.extra")}</dt>
          <dd class="m-0 font-mono break-all">{extra().join(", ")}</dd>
        </Show>
        <Show when={kept().length > 0}>
          <dt class="text-own-muted">{props.text("own.team.details.kept")}</dt>
          <dd class="m-0 font-mono break-all">
            {kept()
              .map(([dir, why]) => `${dir} (${why})`)
              .join(", ")}
          </dd>
        </Show>
      </dl>
      <button type="button" class={`${BUTTON} self-end`} onClick={() => props.onClose()}>
        {props.text("own.team.action.close")}
      </button>
    </div>
  )
}

function report(error: unknown) {
  console.error("[own-web] area menu", error)
}
