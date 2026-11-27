// The composer toolbar's "모델 @ 계정" button and variant button (03 §4.6). The switcher button is the toolbar's most
// important element: account dot, `model @ account`, the tightest limit as a mini bar with `남음 62%` (03 §7.2, at the
// 설정 > 일반 > 한도 표시 mode and list density; warning from 30 % left, danger from 10 %), `!` when the account cannot
// run. The variant button changes only the variant, which is a switch too: it goes through `switch.estimate` and the
// 03 §6.2 levels (lazy flow).
// 07 §2.9, §7.3: the ultra switch `울트라 ○` of a session right after the effort (a dry run first; the cost dialog
// only when the main's effort leaves the effort-update path; Claude keeps its effort and offers `켤 때 강도도 xhigh로`,
// grouped with the switch and also in the effort menu, where a narrow composer still shows it, UC 2026-10-18;
// `울트라 강도 맞추기` once the main moved and the service left ultra's new effort to the cost dialog), with `ⓘ`
// explaining it and linking to its caps, and the effort menu's ultra row (2026-10-10); the small badge
// `하위 에이전트 2/3 실행 중 · 이 메시지 5개` while the preset delegates actively or ultra is on.
import { Preset } from "@own/protocol/preset"
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  lazy,
  on,
  onCleanup,
  Show,
  Suspense,
} from "solid-js"
import { useData, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { chordLabel, eventCode } from "@/keyboard"
import { limitDensity } from "@/limits/display"
import { LimitGlance } from "@/limits/glance"
import { ultraChoice, type UltraChoice } from "@/presets/model"
import { keepsEffort, liveCounts, mainGroup, runningBadge } from "@/presets/session-view"
import { capsNumbers, usePresetsBootText, type PresetsBootKey } from "@/presets/boot-strings"
import { useRouter } from "@/routing/router"
import { focusUltraCaps } from "@/settings/focus"
import { minuteNow } from "@/shell/clock"
import { childIDs } from "@/subagent/data"
import { useSubagentText } from "@/subagent/strings"
import { openSwitcher, switcherControl, type TargetRef } from "@/switcher"
import { nowOption } from "@/switcher/cost"
import { costText, tokenText } from "@/switcher/describe"
import { accountOf, modelInfo, modelName, namedVariant, runningOnParts, variantName } from "@/switcher/labels"
import { unusable } from "@/switcher/picker"
import { fitMenu } from "./fit"
import type { LimitFold } from "./limit-fit"
import { closeUltraAsk, confirmUltra, requestUltra, setUltraRaise, ultraFlow } from "./ultra-flow"

const Dialog = lazy(() => import("@/limits/kit").then((module) => ({ default: module.Dialog })))

/** The Claude slot's provider (own-accounts plugins/claude.ts `PROVIDER_ID`). */
const CLAUDE_PROVIDER = "anthropic"

/** The ultra caps level names (07 §2.6) for the ultra card's `울트라 상한: 추천 · 동시 5 · …`. */
const ULTRA_LEVEL: Record<UltraChoice, PresetsBootKey> = {
  save: "own.preset.ultraLevel.save",
  recommended: "own.preset.ultraLevel.recommended",
  large: "own.preset.ultraLevel.large",
  custom: "own.preset.ultraLevel.custom",
}

export interface BindingView {
  readonly ref: TargetRef | null
  readonly builtin: boolean
  /** A session whose model is not pinned (03 §5.2.1). */
  readonly unpinned: boolean
}

export function SwitcherButton(props: {
  readonly runtime: ServerRuntime
  readonly view: BindingView | undefined
  /** The conversation: its own Claude account names the pill (02 §8.7), never the first one sharing `anthropic`. */
  readonly sessionID?: string
  readonly disabled?: boolean
  /** How far the toolbar folded the limit for room (./limit-fit.ts): from 1 on, the ring. */
  readonly fold?: LimitFold
}) {
  const i18n = useI18n()
  const account = () => {
    const ref = props.view?.ref
    return ref && !props.view?.builtin ? accountOf(props.runtime, ref.providerID, props.sessionID) : undefined
  }
  const windows = () => {
    const owner = account()
    return owner ? props.runtime.own.state.quota[owner.id] : undefined
  }
  const problem = () => {
    const owner = account()
    return owner ? unusable(owner, windows(), props.view?.ref?.id) : undefined
  }
  // `모델 @ 계정` in parts (UX 2026-10-26): the model gives way first, the account stays readable; a label without an
  // account (unpinned, no target, a built-in provider) is one part that shortens like the model.
  const label = () => {
    const view = props.view
    if (!view?.ref)
      return [
        {
          part: "model" as const,
          text: view?.unpinned ? i18n.t("own.binding.unpinned") : i18n.t("own.composer.noTarget"),
        },
      ]
    if (view.builtin)
      return [{ part: "model" as const, text: i18n.t("own.binding.builtin", { provider: view.ref.providerID }) }]
    return runningOnParts(i18n, modelName(props.runtime, view.ref), account()?.label ?? view.ref.providerID)
  }
  let button: HTMLButtonElement | undefined
  return (
    <button
      ref={button}
      type="button"
      class="own-cp-switch"
      classList={{ "own-cp-switch-warn": !!props.view && (props.view.builtin || props.view.unpinned) }}
      data-testid="composer-switcher"
      aria-haspopup="dialog"
      disabled={props.disabled}
      title={i18n.t("own.composer.switcherTitle", { shortcut: chordLabel("Mod+Period") })}
      onClick={() => openSwitcher({ anchor: button })}
    >
      <Show when={account()} fallback={<span class="own-sw-dot own-sw-dot-empty" aria-hidden="true" />}>
        {(owner) => <span class="own-sw-dot" data-color={owner().color} aria-hidden="true" />}
      </Show>
      <span class="own-cp-switch-label" data-testid="composer-switcher-label">
        <For each={label()}>
          {(segment) => <span data-part={segment.part ?? "sep"}>{segment.text}</span>}
        </For>
      </span>
      <Show when={account()?.thirdParty}>
        <span class="own-sw-tag">{i18n.t("own.accounts.type.unofficial")}</span>
      </Show>
      {/* One window at every list density (UX 2026-10-26): the ring at 아주 간단히, else a bar and `남음 58%`, the ring
          where the toolbar has no room for the bar (UX 2026-10-27); the switcher it opens shows every window. */}
      <LimitGlance
        windows={windows()}
        density={props.fold || limitDensity("lists") === "minimal" ? "minimal" : "simple"}
        now={minuteNow}
        model={props.view?.ref?.id}
        testid="composer-limit"
      />
      <Show when={problem() || props.view?.builtin || props.view?.unpinned}>
        <span class="own-cp-switch-alert" aria-label={i18n.t("own.composer.accountProblem")}>
          {problem() ? "!" : "⚠"}
        </span>
      </Show>
      <span class="own-cp-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  )
}

/**
 * `high ▾` (03 §4.6): the variants of the current model, named as the provider names them (`variantName`). On a
 * session it asks the router what the change costs and applies it per 03 §6.2; on the home route it only sets the new
 * session's variant. Under a line the menu ends with `울트라 ○/●` (07 §2.9, 2026-10-10): a mode, not a level, so users
 * coming from Codex (where ultra sits among the efforts) find it here; it runs the same dry run and cost dialog as the
 * switch beside this button.
 */
export function VariantButton(props: {
  readonly runtime: ServerRuntime
  readonly serverKey: ServerKey
  readonly sessionID: string | undefined
  readonly view: BindingView | undefined
}) {
  const i18n = useI18n()
  const router = useRouter()
  const text = useSubagentText()
  const names = usePresetsBootText()
  const ultra = useUltraState(props)
  const [open, setOpen] = createSignal(false)
  let button: HTMLButtonElement | undefined
  let menu: HTMLDivElement | undefined
  const variants = () => {
    const ref = props.view?.ref
    return ref ? (modelInfo(props.runtime, ref)?.variants.map((variant) => variant.id) ?? []) : []
  }
  const current = () => props.view?.ref?.variant

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

  async function choose(variant: string) {
    close()
    const ref = props.view?.ref
    if (!ref || variant === ref.variant) return
    const target = { providerID: ref.providerID, id: ref.id, variant }
    if (!props.sessionID) return switcherControl.setNewSessionTarget(props.serverKey, target)
    const { requestSwitch } = await import("@/switcher/flow")
    await requestSwitch(
      { runtime: props.runtime, serverKey: props.serverKey, i18n, navigate: (route) => router.navigate(route) },
      { sessionID: props.sessionID, target, opener: button },
    )
  }

  function toggleUltra() {
    close()
    const sessionID = props.sessionID
    if (!sessionID) return
    const next = !ultra.on()
    void requestUltra(
      { runtime: props.runtime, i18n, text },
      {
        sessionID,
        on: next,
        ...(ultra.claude() ? { raiseClaude: ultra.raised() } : {}),
        retuning: next && ultra.retuning(),
      },
    )
  }

  function toggleRaise() {
    close()
    const sessionID = props.sessionID
    if (!sessionID) return
    const next = !ultra.raised()
    setUltraRaise(sessionID, next)
    if (ultra.on())
      void requestUltra(
        { runtime: props.runtime, i18n, text },
        { sessionID, on: true, raiseClaude: next, retuning: ultra.retuning() },
      )
  }

  function onMenuKey(event: KeyboardEvent) {
    const code = eventCode(event)
    const items = Array.from(
      menu?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitemcheckbox"]:not([disabled])') ?? [],
    )
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close()
    }
    if (code === "ArrowDown" || code === "ArrowUp") {
      event.preventDefault()
      const next = code === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length
      items[next]?.focus()
    }
  }

  return (
    <Show when={variants().length}>
      <span class="own-cp-variant-wrap own-cp-effort-wrap">
        <button
          ref={button}
          type="button"
          class="own-cp-tool"
          aria-haspopup="menu"
          aria-expanded={open()}
          data-testid="composer-variant"
          title={i18n.t("own.switcher.variantLabel")}
          disabled={props.view?.builtin || props.view?.unpinned}
          onClick={() => {
            if (open()) return close()
            setOpen(true)
            document.addEventListener("pointerdown", outside, true)
            queueMicrotask(() => {
              fitMenu(menu)
              menu?.querySelector<HTMLElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus()
            })
          }}
        >
          {variantName(i18n, current())}
          <span class="own-cp-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <Show when={open()}>
          <div
            ref={menu}
            class="own-cp-menu"
            role="menu"
            aria-label={i18n.t("own.switcher.variantLabel")}
            onKeyDown={onMenuKey}
          >
            <For each={variants()}>
              {(variant) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={variant === current()}
                  class="own-cp-menu-item"
                  onClick={() => void choose(variant)}
                >
                  {variantName(i18n, variant)}
                </button>
              )}
            </For>
            {/* The row shows for every main once own.accounts answers, greyed with the switch's reason (UC 2026-10-18). */}
            <Show when={ultra.ready()}>
              <div class="own-cp-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={ultra.on()}
                class="own-cp-menu-item own-cp-menu-rich"
                data-testid="composer-variant-ultra"
                title={ultra.reason()}
                disabled={!!ultra.reason() || ultra.busy()}
                onClick={toggleUltra}
              >
                <span>
                  {names("own.preset.ultra")} <span aria-hidden="true">{ultra.on() ? "●" : "○"}</span>
                </span>
                <span class="own-cp-menu-note">
                  {ultra.reason() ??
                    text(ultra.claude() ? "own.subagent.ultra.menuNoteClaude" : "own.subagent.ultra.menuNote")}
                </span>
              </button>
              {/* Claude: the box beside the switch, here too, since a narrow composer folds the switch away. */}
              <Show when={ultra.claude() && !ultra.reason()}>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={ultra.raised()}
                  class="own-cp-menu-item own-cp-menu-rich"
                  data-testid="composer-variant-ultra-raise"
                  disabled={ultra.busy() || !ultra.canRaise()}
                  onClick={toggleRaise}
                >
                  <span>
                    {names("own.preset.ultra.raiseClaude")}
                    <Show when={ultra.raisePreview()}>{(preview) => <> {preview()}</>}</Show>
                  </span>
                  <span class="own-cp-menu-note">{ultra.raiseNote()}</span>
                </button>
              </Show>
            </Show>
          </div>
        </Show>
      </span>
    </Show>
  )
}

/**
 * What the ultra switch and the effort menu's ultra row read (07 §2.9): whether ultra is on, whether the main has a
 * preset group (an own account's main) and the RPC is allowed, the Claude `켤 때 강도도 xhigh로` case (whether it can
 * raise anything, what it would raise, its note), and why it cannot be changed here (another provider's main, or the
 * Claude plugin not loaded there; a new conversation, where it is always off until it starts).
 */
function useUltraState(props: {
  readonly runtime: ServerRuntime
  readonly sessionID: string | undefined
  readonly view: BindingView | undefined
}) {
  const i18n = useI18n()
  const text = useSubagentText()
  const session = () => (props.sessionID ? props.runtime.own.state.sessionPreset[props.sessionID] : undefined)
  const group = () =>
    mainGroup(props.view?.builtin ? undefined : props.view?.ref, (providerID) => accountOf(props.runtime, providerID))
  const ready = () =>
    props.runtime.own.state.status === "ready" && props.runtime.rpc.allowed("session.ultra.set") && !!props.view?.ref
  const state = () => session()?.binding?.ultra
  const raised = () => {
    const current = state()
    return current ? (current.raiseClaude ?? false) : !!props.sessionID && !!ultraFlow.raise[props.sessionID]
  }
  /** Claude: the user's effort without ultra (what ultra replaced, else what runs now), the one a raise starts from. */
  const baseline = () => {
    const before = state()?.before
    return before === undefined ? namedVariant(props.view?.ref?.variant) : (before ?? undefined)
  }
  /** What `켤 때 강도도 xhigh로` does from the baseline on this model (the service's `Preset.ultraEffort`). */
  const raise = () => {
    const ref = props.view?.ref
    const main = group()
    if (!ref || !main) return undefined
    const from = baseline()
    const variants = modelInfo(props.runtime, ref)?.variants.map((variant) => variant.id) ?? []
    const to = Preset.ultraEffort(main, variants, {
      ...(from === undefined ? {} : { current: from }),
      raiseClaude: true,
    })
    return to.variant === undefined || to.variant === from ? undefined : { from, to: to.variant }
  }
  return {
    on: () => state() !== undefined,
    /** The session's ultra state, for the switch to take a Claude raise back into the tick when ultra goes off. */
    state,
    /** The main moved and ultra's effort for it waits for the cost dialog (`ultra.pending`, 07 §2.9). */
    retuning: () => session()?.binding?.ultra?.pending !== undefined,
    group,
    claude: () => keepsEffort(group()),
    /**
     * Claude: whether ultra raised the effort when it was turned on; while it is off, whether `xhigh로 올리기` is ticked
     * beside the switch (the switch and the effort menu's ultra row turn it on alike).
     */
    raised,
    /** Claude: the box can be ticked (the baseline is below `xhigh`); a ticked box can always be unticked. */
    canRaise: () => raised() || Preset.raisesClaude(baseline()),
    /** `(high → xhigh)` when the raise changes the effort. */
    raisePreview: () => {
      const value = raise()
      return value
        ? text("own.subagent.ultra.raisePreview", {
            from: variantName(i18n, value.from),
            to: variantName(i18n, value.to),
          })
        : undefined
    },
    /** The box's description: what it does, and that a change applies at once while ultra is on (or why it is off). */
    raiseNote: () =>
      [
        text("own.subagent.ultra.raiseHint"),
        ...(raised() || Preset.raisesClaude(baseline())
          ? []
          : [text("own.subagent.ultra.raiseHigh", { effort: variantName(i18n, baseline()) })]),
        ...(state() ? [text("own.subagent.ultra.raiseNow")] : []),
      ].join(" "),
    /** On screen: own.accounts answers and the main is known. */
    ready,
    busy: () => !!props.sessionID && !!ultraFlow.busy[props.sessionID],
    /** Why it cannot be changed now; `undefined` when it can. */
    reason: () =>
      !group()
        ? // The Claude slot's provider with no own account behind it: the plugin is not loaded where this runs.
          text(
            props.view?.ref?.providerID === CLAUDE_PROVIDER
              ? "own.subagent.ultra.claudeMissing"
              : "own.subagent.ultra.unavailable",
          )
        : !props.sessionID
          ? text("own.subagent.ultra.newSession")
          : undefined,
  }
}

/**
 * `울트라 ○` / `울트라 ●` (07 §2.9) right after the effort it raises: a session switch, never stored in a preset and
 * always off in a new session (there it is shown grey with that reason, 2026-10-10). Every change asks
 * `session.ultra.set{dryRun}` first and applies at once when the effort stays or changes on the effort-update path;
 * otherwise the cost dialog shows the effort change and its cost first (ultra-flow.ts). Claude keeps its effort, so
 * its switch comes grouped with `켤 때 강도도 xhigh로` (UC 2026-10-18): what it raises (`(high → xhigh)`), off where
 * the effort is already `xhigh` or above, applied at once while ultra is on, kept per conversation while it is off. After a model change whose ultra effort would rewrite the cache, the service
 * keeps it as `ultra.pending` (07 §2.9) and `울트라 강도 맞추기` runs the same dry run and dialog. `ⓘ` opens a small
 * card: what ultra does, the ultra caps in force and a link to 설정 > 프리셋 > 울트라 상한.
 */
export function UltraSwitch(props: {
  readonly runtime: ServerRuntime
  readonly sessionID: string | undefined
  readonly view: BindingView | undefined
  readonly disabled?: boolean
}) {
  const i18n = useI18n()
  const data = useData()
  const router = useRouter()
  const text = useSubagentText()
  const names = usePresetsBootText()
  const ultra = useUltraState(props)
  const [info, setInfo] = createSignal(false)
  let infoButton: HTMLButtonElement | undefined
  let card: HTMLDivElement | undefined
  const env = () => ({ runtime: props.runtime, i18n, text })
  const caps = () => data.local().own.state.presetSettings.ultraCaps
  const raiseHint = createUniqueId()
  // Claude: when ultra goes off, what it was raised with becomes the tick again (on in another window, or from the
  // effort menu), so the box and the next turn-on agree. Only within one conversation.
  createEffect(
    on(
      () => [props.sessionID, ultra.state()] as const,
      ([sessionID, now], previous) => {
        const [before, was] = previous ?? []
        if (sessionID && before === sessionID && was && !now && ultra.claude())
          setUltraRaise(sessionID, was.raiseClaude ?? false)
      },
    ),
  )

  function change(next: boolean, raiseClaude: boolean) {
    const sessionID = props.sessionID
    if (!sessionID) return
    void requestUltra(env(), {
      sessionID,
      on: next,
      ...(ultra.claude() ? { raiseClaude } : {}),
      retuning: next && ultra.retuning(),
    })
  }

  const closeInfo = (refocus = true) => {
    setInfo(false)
    document.removeEventListener("pointerdown", outside, true)
    if (refocus) infoButton?.focus()
  }
  const outside = (event: PointerEvent) => {
    if (event.target instanceof Node && (card?.contains(event.target) || infoButton?.contains(event.target))) return
    closeInfo(false)
  }
  onCleanup(() => document.removeEventListener("pointerdown", outside, true))

  function openCaps() {
    closeInfo(false)
    focusUltraCaps()
    router.navigate({ name: "settings", section: "presets" })
  }

  return (
    <Show when={ultra.ready()}>
      <span class="own-cp-variant-wrap" data-testid="composer-ultra-wrap">
        {/* Claude (UC 2026-10-18): the switch and its `켤 때 강도도 xhigh로` box, one group. */}
        <span
          class="own-cp-ultra-group"
          role={ultra.claude() ? "group" : undefined}
          aria-label={ultra.claude() ? names("own.preset.ultra") : undefined}
          data-claude={ultra.claude() ? "" : undefined}
        >
          <button
            type="button"
            role="switch"
            aria-checked={ultra.on()}
            class="own-cp-tool"
            data-testid="composer-ultra"
            title={
              ultra.reason() ?? text(ultra.claude() ? "own.subagent.ultra.titleClaude" : "own.subagent.ultra.title")
            }
            disabled={props.disabled || ultra.busy() || !!ultra.reason()}
            onClick={() => change(!ultra.on(), ultra.raised())}
          >
            {names("own.preset.ultra")}
            <span aria-hidden="true">{ultra.on() ? "●" : "○"}</span>
          </button>
          <Show when={ultra.claude()}>
            <label class="own-cp-tool" data-testid="composer-ultra-raise" title={ultra.raiseNote()}>
              <input
                type="checkbox"
                checked={ultra.raised()}
                aria-describedby={raiseHint}
                disabled={props.disabled || ultra.busy() || !!ultra.reason() || !ultra.canRaise()}
                onChange={(event) => {
                  const value = event.currentTarget.checked
                  const sessionID = props.sessionID
                  if (!sessionID) return
                  setUltraRaise(sessionID, value)
                  if (!ultra.on()) return
                  // With ultra on the box shows the session's state until the change is applied (a cost dialog may
                  // come first, and may be cancelled).
                  event.currentTarget.checked = ultra.raised()
                  change(true, value)
                }}
              />
              {names("own.preset.ultra.raiseClaude")}
              <Show when={ultra.raisePreview()}>
                {(preview) => (
                  <span class="own-cp-ultra-preview" data-testid="composer-ultra-raise-preview">
                    {preview()}
                  </span>
                )}
              </Show>
              <span id={raiseHint} class="own-sr-only">
                {ultra.raiseNote()}
              </span>
            </label>
          </Show>
        </span>
        <button
          ref={infoButton}
          type="button"
          class="own-cp-tool own-cp-info"
          aria-haspopup="dialog"
          aria-expanded={info()}
          aria-label={text("own.subagent.ultra.info")}
          title={text("own.subagent.ultra.info")}
          data-testid="composer-ultra-info"
          onClick={() => {
            if (info()) return closeInfo()
            setInfo(true)
            document.addEventListener("pointerdown", outside, true)
            queueMicrotask(() => {
              fitMenu(card)
              card?.querySelector<HTMLElement>("button")?.focus()
            })
          }}
        >
          ⓘ
        </button>
        <Show when={info()}>
          <div
            ref={card}
            class="own-cp-menu own-cp-card"
            role="dialog"
            aria-label={text("own.subagent.ultra.info")}
            data-testid="composer-ultra-card"
            onKeyDown={(event) => {
              if (eventCode(event) !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              closeInfo()
            }}
          >
            <p>{text("own.subagent.ultra.infoBody")}</p>
            <Show when={ultra.claude()}>
              <p class="own-cp-menu-note" data-testid="composer-ultra-claude-line">
                {text("own.subagent.ultra.infoClaude")}
              </p>
            </Show>
            <Show when={ultra.reason()}>{(reason) => <p class="own-cp-menu-note">{reason()}</p>}</Show>
            <p class="own-cp-menu-note" data-testid="composer-ultra-caps-line">
              {text("own.subagent.ultra.infoCaps", {
                level: names(ULTRA_LEVEL[ultraChoice(caps())]),
                numbers: capsNumbers(names, Preset.levelCaps(caps())),
              })}
            </p>
            <button type="button" class="own-cp-link" data-testid="composer-ultra-caps" onClick={openCaps}>
              ⚙ {text("own.subagent.ultra.capsLink")}
            </button>
          </div>
        </Show>
        <Show when={ultra.retuning()}>
          <button
            type="button"
            class="own-cp-tool"
            data-testid="composer-ultra-retune"
            title={text("own.subagent.ultra.retuneHint")}
            disabled={props.disabled || ultra.busy()}
            onClick={() => change(true, ultra.raised())}
          >
            {text("own.subagent.ultra.retune")}
          </button>
        </Show>
      </span>
      <Show when={props.sessionID && ultraFlow.ask?.sessionID === props.sessionID ? ultraFlow.ask : undefined}>
        {(pending) => (
          <Suspense>
            <Dialog
              open
              testid="ultra-cost-dialog"
              title={text(
                !pending().input.on
                  ? "own.subagent.ultra.dialogOff"
                  : pending().retuning
                    ? "own.subagent.ultra.dialogRetune"
                    : "own.subagent.ultra.dialogOn",
              )}
              onClose={closeUltraAsk}
              footer={
                <>
                  <button type="button" class="own-cp-btn" onClick={closeUltraAsk}>
                    {text("own.subagent.ultra.cancel")}
                  </button>
                  <button
                    type="button"
                    class="own-cp-btn own-cp-btn-primary"
                    data-testid="ultra-cost-confirm"
                    onClick={() => void confirmUltra(env(), pending())}
                  >
                    {text(
                      !pending().input.on
                        ? "own.subagent.ultra.confirmOff"
                        : pending().retuning
                          ? "own.subagent.ultra.confirmRetune"
                          : "own.subagent.ultra.confirmOn",
                    )}
                  </button>
                </>
              }
            >
              <p>
                {text("own.subagent.ultra.effort", {
                  from: variantName(i18n, pending().result.variant.from ?? undefined),
                  to: variantName(i18n, pending().result.variant.to ?? undefined),
                })}
              </p>
              <Show when={pending().result.estimate}>
                {(estimate) => (
                  <>
                    <p>{text("own.subagent.ultra.rewrite")}</p>
                    <p data-testid="ultra-cost-line">
                      {i18n.t("own.switcher.cost", {
                        tokens: tokenText(estimate()),
                        delta: costText(
                          { i18n, estimate: estimate(), targetIsClaudeSlot: ultra.group() === "claude-sub" },
                          nowOption(estimate()),
                        ),
                      })}
                    </p>
                  </>
                )}
              </Show>
            </Dialog>
          </Suspense>
        )}
      </Show>
    </Show>
  )
}

/**
 * `하위 에이전트 2/3 실행 중 · 이 메시지 5개` (07 §7.3) while the preset delegates actively or ultra is on: the cap in
 * force from `session.preset.get`, the counts live from the session data (running children, and children started since
 * the root's last user message).
 */
export function RunningBadge(props: { readonly runtime: ServerRuntime; readonly sessionID: string | undefined }) {
  const text = useSubagentText()
  const badge = createMemo(() => {
    const sessionID = props.sessionID
    const session = sessionID ? props.runtime.own.state.sessionPreset[sessionID] : undefined
    if (!sessionID || !session) return undefined
    if (session.preset?.delegation !== "active" && !session.binding?.ultra) return undefined
    const data = props.runtime.data
    const children = childIDs(props.runtime, sessionID).map((id) => ({
      created: data.session.get(id)?.time.created ?? 0,
      running: data.session.status(id) === "running",
    }))
    const lastUser = data.session.message.list(sessionID).findLast((message) => message.type === "user")?.time.created
    return runningBadge(session, liveCounts(children, lastUser))
  })
  return (
    <Show when={badge()}>
      {(value) => (
        <span class="own-cp-variant-wrap">
          <span class="own-sw-tag" role="status" data-testid="composer-subagent-badge">
            {text("own.subagent.badge.running", { ...value() })}
          </span>
        </span>
      )}
    </Show>
  )
}
