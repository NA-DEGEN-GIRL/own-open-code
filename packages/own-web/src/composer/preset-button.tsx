// The composer's preset controls (07 §7.3, §5.1, §5.3, §8.1 원격; 06 §9.5 담당 대화 입력창):
//   - `PresetButton`: `[프리셋: <이름> ▾]` after the effort button, dimmed for `평소대로`. Its menu (`PresetMenu`) lists
//     the presets of the main account's group only (★ first, `평소대로` always), `최근`, `새 프리셋…` and `편집…`, with
//     `비용 없음 · 바로 적용` under them: a preset never changes the main, so there is no cost dialog. Choosing calls
//     `session.preset.apply`; in an owner conversation the choice is the area's preset (own.team `area.preset`); on the
//     new-session screen it is the next session's start preset. A team session's menu dims presets that break the
//     team's R4. A remote server's session (T3, 07 §8.1 원격) lists that server's `presets.list`, its mirror of this
//     PC's presets, and applies there (that server's own.team `area.preset` in an owner conversation); `새 프리셋…`
//     and `편집…` open this PC's editor, the only place presets are written. A remote server without the mirror (an
//     older build) lists `평소대로` only, with a neutral line.
//   - `PresetBanner`: the one line above the box while ultra is on (`울트라 · ChatGPT 01 5시간 42% · Claude 구독 18%`, plus
//     this conversation's paid amount) or the preset is heavy (`적극적으로`, a paid target); an owner conversation adds
//     the team's worst case (team/model.ts, loaded only there). T2 (07 §4.3): when `session.preset.get` says the main
//     model or its effort level is gone, a line above it offers `[바꾸기]`, which opens the switcher on the service's
//     suggestion (the send gate of send.ts does the same); nothing switches by itself.
//   - `applyStartPreset`: binds a new session to its start preset after `session.create`, before its first prompt.
// Repairs (07 §4.3, §7.3): the button carries a dot while a preset of its group needs a repair, and the menu starts
// with that group's repair lines (presets/repair-notice.tsx, a lazy chunk that presets/repairs.ts loads, PF5); a remote
// server's session has neither (its list has no repairs). The editor (presets/editor.tsx) stays a lazy chunk:
// `새 프리셋…`, `편집…` and a repair's `직접 고르기` only call `openPresetEditor`.
import { Preset } from "@own/protocol/preset"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { OwnRpcError, useData, type OwnState, type OwnStore, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { eventCode } from "@/keyboard"
import { windowValue } from "@/limits/display"
import { tightest } from "@/limits/windows"
import { openPresetEditor, presetPlace, type MainRef, type PresetPlace } from "@/presets/model"
import { needsRepair, repairLines } from "@/presets/repairs"
import {
  bannerOf,
  errorKey,
  mainGroup,
  menuRows,
  presetByID,
  presetInEffect,
  presetName,
  presetOf,
  recentRows,
  roleKey,
  startPreset,
  teamClash,
} from "@/presets/session-view"
import { usePresetsBootText } from "@/presets/boot-strings"
import { useSubagentText, type SubagentKey } from "@/subagent/strings"
import { openSwitcher, showToast, type TargetRef } from "@/switcher"
import { windowName } from "@/switcher/describe"
import { formatMoney } from "@/switcher/format"
import { accountOf, modelName, variantName } from "@/switcher/labels"
import type { TeamText, worstCase } from "@/team/model"
import type { BindingView } from "./binding-button"
import { fitMenu } from "./fit"
import { goneTarget } from "./send"
import { minuteNow } from "@/shell/clock"
import { inFocusedPane } from "@/shell/pane-context"

// ---- the new-session screen's choice (07 §5.1): kept per server and group until the session is created ----

const [choices, setChoices] = createSignal<Readonly<Record<string, Preset.ID>>>({})
const choiceKey = (serverKey: ServerKey, group: Preset.Group) => `${serverKey}\n${group}`

/** The new-session screen's pick (07 §5.1): the next session of that server and group starts with it. */
export function chooseStartPreset(serverKey: ServerKey, group: Preset.Group, presetID: Preset.ID) {
  setChoices((all) => ({ ...all, [choiceKey(serverKey, group)]: presetID }))
}

/**
 * 07 §5.1 새 세션: after `session.create` and before the first prompt, bind the new root to the preset chosen on the
 * new-session screen, else the group's start preset, on the session's own server. A remote server starts from its
 * mirror of this PC's presets (07 §8.1 원격, T3); one without them stays on `평소대로`. A failure never holds the prompt
 * back: the service binds the group's ★ on `session.created` by itself.
 */
export async function applyStartPreset(input: {
  readonly runtime: Pick<ServerRuntime, "kind" | "rpc" | "own">
  /** This PC's service: presets and their settings are global there (07 §8.1). */
  readonly local: Pick<ServerRuntime, "own">
  readonly serverKey: ServerKey
  readonly sessionID: string
  readonly target: TargetRef
  readonly directory: string
}) {
  const runtime = input.runtime
  const group = mainGroup(input.target, (providerID) => runtime.own.accountFor(providerID))
  if (!group || !runtime.rpc.allowed("session.preset.apply")) return
  const presets = presetStore(runtime, input.local.own)
  if (presets.place === "builtin") return
  const key = choiceKey(input.serverKey, group)
  const state = presets.state
  const presetID =
    choices()[key] ??
    startPreset(group, state.presetSettings, state.presetGroups[group], (accountID) => state.accounts[accountID])
  setChoices((all) => Object.fromEntries(Object.entries(all).filter(([item]) => item !== key)))
  await runtime.rpc
    .call("session.preset.apply", { sessionID: input.sessionID, presetID }, { directory: input.directory })
    .catch(report)
}

/**
 * Where a session on `runtime` reads presets ({@link presetPlace}, 07 §8.1 원격) and the store state holding them: a
 * remote server's own list while it mirrors this PC's presets, else this PC's.
 */
function presetStore(runtime: Pick<ServerRuntime, "kind" | "own">, local: Pick<OwnStore, "state">) {
  const remote = runtime.kind === "ssh" ? runtime.own.state.presetGroups : undefined
  const place = presetPlace(remote, local.state.presetGroups)
  return { place, state: place === "mirror" ? runtime.own.state : local.state }
}

/**
 * Applies a preset picked in the composer's menu (07 §5.3) on the session's own server, never as a write of presets:
 * an owner conversation's choice is its area's (own.team `area.preset`, 06 §10.1), any other root binds its own
 * (`session.preset.apply`). A remote server's session goes to that server and its own.team (07 §8.1 원격, T3).
 */
export function applyPreset(
  runtime: {
    readonly rpc: Pick<ServerRuntime["rpc"], "call">
    readonly team: { readonly rpc: Pick<ServerRuntime["team"]["rpc"], "call"> }
  },
  input: {
    readonly sessionID: string
    readonly presetID: Preset.ID
    readonly area: { readonly teamID: string; readonly areaID: string } | undefined
  },
) {
  return input.area
    ? runtime.team.rpc.call("area.preset", { ...input.area, presetID: input.presetID })
    : runtime.rpc.call("session.preset.apply", { sessionID: input.sessionID, presetID: input.presetID })
}

// ---- preset button ----

export function PresetButton(props: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  /** `undefined` on the new-session screen: the choice is the next session's start preset. */
  readonly sessionID: string | undefined
  readonly view: BindingView | undefined
  readonly disabled?: boolean
}) {
  const data = useData()
  const text = useSubagentText()
  const names = usePresetsBootText()
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  let button: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined

  const own = () => props.runtime.own
  const local = () => data.local().own.state
  /** This PC's presets, a remote server's mirror of them, or a remote server's `평소대로` only (07 §8.1 원격). */
  const presets = () => presetStore(props.runtime, data.local().own)
  const lookup: Preset.Lookup = (accountID) => own().state.accounts[accountID]
  const ref = () => (props.view?.builtin ? undefined : (props.view?.ref ?? undefined))
  // R4 judges every Claude account as the Claude slot (`acc_claude_slot`, the server's `member`): the provider's.
  const account = () => {
    const main = ref()
    return main ? accountOf(props.runtime, main.providerID) : undefined
  }
  /** No group, no button: a built-in provider's main, or a server without a working own.accounts. */
  const group = () =>
    own().state.status === "ready" ? mainGroup(ref(), (providerID) => accountOf(props.runtime, providerID)) : undefined
  // A remote server's list (T3) loads while its composer shows, then again on every resync.
  createEffect(() => {
    if (props.runtime.kind === "ssh" && own().state.status === "ready") untrack(() => void own().refreshPresets())
  })
  const session = () => (props.sessionID ? own().state.sessionPreset[props.sessionID] : undefined)
  /** The owner conversation of an area (not an earlier one): its preset is the area's (06 §9.5). */
  const area = () => {
    const place = props.sessionID ? props.runtime.team.placeOf(props.sessionID) : undefined
    return place?.role === "owner" && !place.previous && place.areaID
      ? { teamID: place.teamID, areaID: place.areaID }
      : undefined
  }
  const current = createMemo(() => {
    const value = group()
    if (!value) return undefined
    const source = presets()
    if (source.place === "builtin") return Preset.builtin(value)
    const view = source.state.presetGroups[value]
    if (props.sessionID) return presetInEffect(value, session(), view)
    const chosen =
      choices()[choiceKey(props.serverKey, value)] ?? startPreset(value, source.state.presetSettings, view, lookup)
    return presetOf(value, view, chosen) ?? Preset.builtin(value)
  })
  const builtin = () => {
    const preset = current()
    return !preset || Preset.isBuiltin(preset.id)
  }
  /** 07 §7.3 `해당 프리셋 단추의 점`: this group's presets need a repair (only this PC's list has repairs). */
  const repair = () => {
    const value = group()
    return value !== undefined && presets().place === "local" && needsRepair(local().presetGroups[value])
  }
  const allowed = () => {
    const place = area()
    return place ? props.runtime.team.rpc.allowed("area.preset") : props.runtime.rpc.allowed("session.preset.apply")
  }
  /** A team session's presets that break the team's R4 (07 §5.1): dimmed with the account they would add. */
  const clash = (preset: Preset.Info) => {
    const accountID = teamClash(preset, account()?.id ?? null, lookup, session()?.binding?.team)
    return accountID
      ? text("own.subagent.preset.teamClash", { account: own().state.accounts[accountID]?.label ?? accountID })
      : undefined
  }

  const close = (refocus = true) => {
    setOpen(false)
    document.removeEventListener("pointerdown", outside, true)
    if (refocus) button?.focus()
  }
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && (menu?.contains(event.target) || button?.contains(event.target))) return
    close(false)
  }
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))

  async function pick(presetID: Preset.ID) {
    close()
    const value = group()
    const sessionID = props.sessionID
    if (!value || presetID === current()?.id) return
    if (!sessionID) return chooseStartPreset(props.serverKey, value, presetID)
    const preset = presetOf(value, presets().state.presetGroups[value], presetID)
    setBusy(true)
    try {
      await applyPreset(props.runtime, { sessionID, presetID, area: area() })
      const name = preset ? presetName(preset, names("own.preset.builtin")) : presetID
      showToast({ message: text("own.subagent.preset.applied", { name }) })
    } catch (error) {
      showToast({ message: text("own.subagent.preset.failed", { reason: failure(error) }), tone: "danger" })
    } finally {
      setBusy(false)
    }
  }

  /** A preset error in the editor's words, else the service's message. */
  function failure(error: unknown) {
    const key = errorKey(error instanceof OwnRpcError ? error.type : undefined)
    if (!key) return error instanceof Error ? error.message : String(error)
    const detail = error instanceof OwnRpcError && typeof error.data === "object" && error.data ? error.data : {}
    const accountID = "accountID" in detail && typeof detail.accountID === "string" ? detail.accountID : undefined
    const role = "role" in detail && typeof detail.role === "string" ? detail.role : undefined
    const roleName = roleKey(role)
    return names(key, {
      account: (accountID && own().state.accounts[accountID]?.label) || accountID || "—",
      role: roleName ? names(roleName) : (role ?? "—"),
    })
  }

  const label = () => {
    const preset = current()
    return text("own.subagent.preset.button", {
      name: preset ? presetName(preset, names("own.preset.builtin")) : names("own.preset.builtin"),
    })
  }

  return (
    <Show when={group()}>
      {(value) => (
        <span class="own-cp-variant-wrap own-cp-preset-wrap" data-testid="composer-preset-wrap">
          <button
            ref={button}
            type="button"
            class="own-cp-tool"
            aria-haspopup="menu"
            aria-expanded={open()}
            data-testid="composer-preset"
            data-builtin={builtin() ? "" : undefined}
            data-repair={repair() ? "" : undefined}
            aria-description={repair() ? names("own.preset.needsRepair") : undefined}
            style={builtin() ? { color: "var(--own-text-faint)" } : undefined}
            title={[
              // The name may be cut short on a narrow toolbar.
              label(),
              allowed() ? text("own.subagent.preset.title") : names("own.preset.page.readOnly"),
              ...(repair() ? [names("own.preset.needsRepair")] : []),
            ].join(" · ")}
            disabled={props.disabled || busy() || !allowed()}
            onClick={() => {
              if (open()) return close()
              setOpen(true)
              document.addEventListener("pointerdown", outside, true)
              // The preset in use first: a repair line's fix above it must never take an Enter by surprise. A remote
              // server's list may still be loading: the menu itself takes focus, so Escape and the arrows work.
              queueMicrotask(() => {
                fitMenu(menu)
                ;(
                  menu?.querySelector<HTMLElement>('[aria-checked="true"]') ??
                  menu?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)') ??
                  menu
                )?.focus()
              })
            }}
          >
            <span class="own-cp-tool-label">{label()}</span>
            <Show when={repair()}>
              <span
                class="ml-1 inline-block size-1.5 flex-none rounded-full bg-own-warn"
                aria-hidden="true"
                data-testid="composer-preset-repair"
              />
            </Show>
            <span class="own-cp-caret" aria-hidden="true">
              ▾
            </span>
          </button>
          <Show when={open()}>
            <PresetMenu
              ref={(element) => (menu = element)}
              class="own-cp-menu"
              style={{ "min-width": "220px", "max-width": "min(340px, calc(100vw - 32px))" }}
              group={value()}
              current={current()?.id}
              server={props.runtime}
              area={area() !== undefined}
              main={mainRef(ref())}
              pool={session()?.preset?.id === current()?.id ? session()?.resolution?.pool : undefined}
              disabled={clash}
              onPick={(presetID) => void pick(presetID)}
              onClose={() => close()}
            />
          </Show>
        </span>
      )}
    </Show>
  )
}

function mainRef(ref: TargetRef | undefined): MainRef | undefined {
  if (!ref) return undefined
  return { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) }
}

// ---- preset menu (also the team's area menu `프리셋 바꾸기…`) ----

const HEAD: JSX.CSSProperties = { padding: "6px 10px 2px", "font-size": "11px", color: "var(--own-text-faint)" }
const RULE: JSX.CSSProperties = { margin: "4px 0", "border-top": "1px solid var(--own-border)" }
const NOTE: JSX.CSSProperties = {
  margin: "4px 0 0",
  padding: "4px 10px 2px",
  "font-size": "11px",
  color: "var(--own-text-faint)",
}
const DIMMED: JSX.CSSProperties = {
  display: "flex",
  "flex-direction": "column",
  "align-items": "flex-start",
  height: "auto",
  "min-height": "30px",
  padding: "4px 10px",
  opacity: "0.6",
  cursor: "not-allowed",
}
const REASON: JSX.CSSProperties = { "font-size": "11px", color: "var(--own-text-muted)", "white-space": "normal" }

/**
 * What a preset menu shows for where it reads presets ({@link presetPlace}, 07 §7.3, §8.1 원격): repair lines and marks
 * only from this PC's list; `평소대로` alone, without `최근` or editing and with the neutral line, from a remote server
 * that has none of this PC's presets. Editing opens this PC's editor wherever the menu is: presets are written there
 * only (a remote server answers `remote_managed`).
 */
export function menuParts(place: PresetPlace, area: boolean) {
  const note: ReadonlyArray<SubagentKey> =
    place === "builtin"
      ? ["own.subagent.preset.remoteBuiltin"]
      : area
        ? ["own.subagent.preset.free", "own.subagent.preset.area"]
        : ["own.subagent.preset.free"]
  return { builtinOnly: place === "builtin", repairs: place === "local", editing: place !== "builtin", note }
}

/**
 * The presets of one group (07 §7.3): ★ first and `평소대로` always, `최근`, then `새 프리셋…` and `편집…` (this PC's
 * presets, so only where this connection may save them), and `비용 없음 · 바로 적용`. Presets of other groups are never
 * listed. `disabled` dims a preset with its reason (a team's R4). Arrow keys move, Esc closes.
 */
export function PresetMenu(props: {
  readonly group: Preset.Group
  readonly onPick: (presetID: Preset.ID) => void
  /** Why a preset can't be picked here, shown with it; `undefined` = it can. */
  readonly disabled?: (preset: Preset.Info) => string | undefined
  /** The preset in use (checked; `편집…` edits it). */
  readonly current?: Preset.ID
  /**
   * The session's server. A remote one lists its own `presets.list`, its mirror of this PC's presets (T3), read again
   * as the menu opens; `평소대로` only while it has none of them.
   */
  readonly server?: Pick<ServerRuntime, "kind" | "own">
  /** The choice is an area's preset (06 §9.5): the note says so. */
  readonly area?: boolean
  /** The main the editor's preview resolves against. */
  readonly main?: MainRef
  /**
   * The session's model pool facts (`Resolution.pool`) of the preset in use: `편집…` of that preset hands them to the
   * editor's previews (07 §3.3 모델 묶음).
   */
  readonly pool?: Preset.PoolResolution
  readonly onClose?: () => void
  readonly class?: string
  readonly style?: JSX.CSSProperties
  readonly ref?: (element: HTMLDivElement) => void
}) {
  const data = useData()
  const text = useSubagentText()
  const names = usePresetsBootText()
  const presets = (): { readonly place: PresetPlace; readonly state: OwnState } =>
    props.server ? presetStore(props.server, data.local().own) : { place: "local", state: data.local().own.state }
  const parts = () => menuParts(presets().place, props.area === true)
  const view = () => presets().state.presetGroups[props.group]
  const star = () => view()?.star ?? Preset.builtinID(props.group)
  const rows = () => menuRows(props.group, view(), parts().builtinOnly)
  const recent = () =>
    parts().builtinOnly ? [] : recentRows(props.group, view(), presets().state.presetSettings.recent, props.current)
  const editable = () => parts().editing && data.local().rpc.allowed("presets.set")
  const editing = () => (props.current && !Preset.isBuiltin(props.current) ? props.current : undefined)
  // A remote server never announces its mirror's changes: read its list again as the menu opens.
  onMount(() => {
    if (props.server?.kind === "ssh") void props.server.own.refreshPresets()
  })

  function edit(presetID?: Preset.ID) {
    props.onClose?.()
    openPresetEditor({
      group: props.group,
      ...(presetID ? { presetID } : {}),
      ...(props.main ? { main: props.main } : {}),
      ...(presetID && presetID === props.current && props.pool ? { pool: props.pool } : {}),
    })
  }

  function onKey(event: KeyboardEvent) {
    const code = eventCode(event)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return props.onClose?.()
    }
    if (code !== "ArrowDown" && code !== "ArrowUp") return
    event.preventDefault()
    const items = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'),
    )
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = code === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length
    items[next]?.focus()
  }

  const item = (preset: Preset.Listed, testid: string) => {
    const why = () => props.disabled?.(preset)
    const repair = () => parts().repairs && preset.status === "needs_repair"
    return (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={preset.id === props.current}
        class="own-cp-menu-item"
        data-testid={testid}
        data-preset-id={preset.id}
        disabled={why() !== undefined}
        title={why() ?? (repair() ? names("own.preset.needsRepair") : undefined)}
        aria-description={repair() ? names("own.preset.needsRepair") : undefined}
        style={why() === undefined ? undefined : DIMMED}
        onClick={() => props.onPick(preset.id)}
      >
        <span>
          {preset.id === star() ? "★ " : ""}
          {presetName(preset, names("own.preset.builtin"))}
          <Show when={repair()}>
            <span
              class="ml-1.5 inline-block size-1.5 rounded-full bg-own-warn align-middle"
              aria-hidden="true"
              data-testid="preset-menu-repair"
            />
          </Show>
        </span>
        <Show when={why()}>{(reason) => <span style={REASON}>{reason()}</span>}</Show>
      </button>
    )
  }

  return (
    <div
      ref={props.ref}
      role="menu"
      tabIndex={-1}
      class={props.class}
      style={props.style}
      aria-label={text("own.subagent.preset.title")}
      data-testid="preset-menu"
      onKeyDown={onKey}
    >
      {/* 07 §4.3: this group's repair lines first, their fixes as menu items (a remote server has none). */}
      {/* A lazy chunk (PF5) that presets/repairs.ts loads once this PC's service names a repair. */}
      <Show when={parts().repairs && repairLines()}>
        {(RepairNotices) => (
          <Dynamic
            component={RepairNotices()}
            group={props.group}
            menu
            defaults={false}
            onAction={() => props.onClose?.()}
          />
        )}
      </Show>
      <For each={rows()}>{(preset) => item(preset, "preset-menu-item")}</For>
      <Show when={recent().length > 0}>
        <div role="presentation" style={HEAD}>
          {text("own.subagent.preset.recent")}
        </div>
        <For each={recent()}>{(preset) => item(preset, "preset-menu-recent")}</For>
      </Show>
      <Show when={editable()}>
        <div role="separator" style={RULE} />
        <button
          type="button"
          role="menuitem"
          class="own-cp-menu-item"
          data-testid="preset-menu-new"
          onClick={() => edit()}
        >
          {names("own.preset.new")}
        </button>
        <button
          type="button"
          role="menuitem"
          class="own-cp-menu-item"
          data-testid="preset-menu-edit"
          disabled={!editing()}
          title={editing() ? undefined : names("own.preset.err.builtinLocked")}
          onClick={() => edit(editing())}
        >
          {names("own.preset.edit")}
        </button>
      </Show>
      <p role="presentation" style={NOTE} data-testid="preset-menu-note">
        {parts()
          .note.map((key) => text(key))
          .join(" · ")}
      </p>
    </div>
  )
}

// ---- heavy / ultra banner ----

/** The one line above the box (07 §5.1, §2.9, §7.4): ultra's usage, a heavy preset, an owner's team worst case. */
export function PresetBanner(props: {
  readonly runtime: ServerRuntime
  readonly sessionID: string
  readonly view: BindingView | undefined
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useSubagentText()
  const names = usePresetsBootText()
  const own = () => props.runtime.own
  const lookup: Preset.Lookup = (accountID) => own().state.accounts[accountID]
  const ref = () => (props.view?.builtin ? undefined : (props.view?.ref ?? undefined))
  const main = () => {
    const value = ref()
    return value ? accountOf(props.runtime, value.providerID) : undefined
  }
  const session = () => own().state.sessionPreset[props.sessionID]
  const preset = createMemo(() => {
    const group = mainGroup(ref(), (providerID) => accountOf(props.runtime, providerID))
    if (!group) return undefined
    // A remote server reads its mirror of this PC's presets (07 §8.1 원격); one without them runs `평소대로`.
    const presets = presetStore(props.runtime, data.local().own)
    if (presets.place === "builtin") return undefined
    return presetInEffect(group, session(), presets.state.presetGroups[group])
  })
  const banner = createMemo(() => {
    const value = preset()
    return value ? bannerOf(session(), value, main()?.id, lookup) : undefined
  })
  /** 07 §4.3: the main model or its level is gone; the next prompt waits for the user's switch. */
  const gone = () => session()?.main
  const goneLine = () => {
    const value = gone()
    const current = ref()
    if (!value || !current) return undefined
    if (value.missing === "variant")
      return i18n.t("own.composer.mainGone.variant", {
        variant: variantName(i18n, current.variant),
        next: variantName(i18n, value.suggestion?.variant),
      })
    const model = modelName(props.runtime, current)
    const next = value.suggestion
    return next
      ? i18n.t("own.composer.mainGone.model", {
          model,
          next: modelName(props.runtime, { providerID: current.providerID, id: next.id }),
        })
      : i18n.t("own.composer.mainGone.modelPick", { model })
  }
  const switchMain = () => {
    const value = gone()
    openSwitcher({
      anchor: inFocusedPane('[data-testid="composer-switcher"]'),
      ...(value ? { target: goneTarget(ref(), value) } : {}),
    })
  }
  const spend = () => {
    const amount = session()?.spend ?? 0
    return banner()?.paid || amount > 0 ? text("own.subagent.ultra.spend", { money: formatMoney(amount) }) : undefined
  }
  const line = () => {
    const value = banner()
    if (!value) return undefined
    if (value.kind === "ultra") {
      const usage = value.accounts.map((accountID) => {
        const label = own().state.accounts[accountID]?.label ?? accountID
        // The conversation's model: a model weekly bucket of that model leads like on every other surface.
        const window = tightest(own().state.quota[accountID] ?? [], minuteNow(), ref()?.id)
        return window
          ? text("own.subagent.ultra.usage", {
              account: label,
              window: windowName(i18n, window.id, window.label),
              value: windowValue(i18n, window),
            })
          : label
      })
      return [names("own.preset.ultra"), ...usage, ...(spend() ? [spend()!] : [])].join(" · ")
    }
    const name = presetName(preset()!, names("own.preset.builtin"))
    const key = value.active
      ? value.paid
        ? "own.subagent.banner.activePaid"
        : "own.subagent.banner.active"
      : "own.subagent.banner.paid"
    const head = text(key, { name })
    return spend() ? `${head} · ${spend()}` : head
  }

  // An owner conversation: the team's worst case (06 §10.3, 07 §7.4), with team/model.ts loaded only here.
  const area = () => {
    const place = props.runtime.team.placeOf(props.sessionID)
    return place?.role === "owner" && !place.previous && place.areaID
      ? { teamID: place.teamID, areaID: place.areaID }
      : undefined
  }
  const [team, setTeam] = createSignal<{ readonly worstCase: typeof worstCase; readonly text: TeamText }>()
  createEffect(() => {
    if (!area()) return
    untrack(() => {
      props.runtime.team.ensure()
      if (!team()) void loadTeam().catch(report)
    })
  })
  async function loadTeam() {
    const { worstCase } = await import("@/team/model")
    const { teamText } = await import("@/team/strings")
    setTeam({ worstCase, text: (key, params) => teamText.text(i18n.locale(), key, params) })
  }
  const worst = createMemo(() => {
    const place = area()
    const model = team()
    const entry = place ? props.runtime.team.team(place.teamID) : undefined
    if (!place || !model || !entry) return undefined
    const ultra = session()?.binding?.ultra !== undefined
    const areas = entry.order.flatMap((id) => {
      const item = entry.areas[id]
      return item && item.state !== "retired"
        ? [{ presetID: item.preset, ultra: ultra && item.id === place.areaID }]
        : []
    })
    const groups = data.local().own.state.presetGroups
    const shared = teamAccount(props.runtime, entry.team.main.sessionID)
    const result = model.worstCase(
      model.text,
      areas,
      (presetID) => presetByID(groups, presetID),
      data.local().own.state.presetSettings.ultraCaps,
      {
        ...(shared ? { shared } : {}),
        metered: (accountID) => {
          const billing = own().state.accounts[accountID]?.billing
          return billing === "metered" || billing === "prepaid"
        },
      },
    )
    return result?.heavy ? result.line : undefined
  })

  return (
    <>
      <Show when={goneLine()}>
        {(message) => (
          <div class="own-sw-chip-line" role="alert" data-testid="preset-main-gone" data-missing={gone()?.missing}>
            <span class="own-sw-chip-icon" aria-hidden="true">
              ⚠
            </span>
            <span class="min-w-0 flex-1">{message()}</span>
            <button type="button" class="own-sw-chip-link" data-testid="preset-main-gone-switch" onClick={switchMain}>
              {i18n.t("own.composer.mainGone.switch")}
            </button>
          </div>
        )}
      </Show>
      <Show when={line() || worst()}>
        <div class="own-sw-chip-line" role="status" data-testid="preset-banner" data-kind={banner()?.kind}>
          <span class="own-sw-chip-icon" aria-hidden="true">
            {banner()?.kind === "ultra" ? "◆" : "⇉"}
          </span>
          <Show when={line()}>
            <span class="min-w-0 flex-1" data-testid="preset-banner-line">
              {line()}
            </span>
          </Show>
          <Show when={worst()}>
            <span class="own-sw-chip-faint min-w-0" data-testid="preset-banner-worst">
              {worst()}
            </span>
          </Show>
        </div>
      </Show>
    </>
  )
}

/** The label of the account the team main runs on: the areas share its limits (07 §7.4). */
function teamAccount(runtime: ServerRuntime, sessionID: string) {
  const model =
    runtime.own.state.binding[sessionID]?.model ??
    runtime.data.session.get(sessionID)?.model ??
    runtime.sessions.state.sessions[sessionID]?.model
  return model ? accountOf(runtime, model.providerID, sessionID)?.label : undefined
}

function report(error: unknown) {
  console.error("[own-web] preset", error)
}
