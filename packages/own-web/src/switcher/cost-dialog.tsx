// Switch-cost dialog (03 §6.3), a lazy chunk. Shows the router's `options[]` in the order of the table (`display:
// "secondary"` under `더 보기`), the recommendation as the router set it, the confidence note with `[자세히]`, and the
// "다시 묻지 않기" checkbox. Modal: focus is trapped and goes back to the opener on close (03 §11).
// T1 (07 §5.3, §5.5; 06 §9.5, §10.1): another provider group adds the `프리셋: <지금> → <다음>(<묶음>)` line; subagents
// on the subscription the main leaves replace the confirm button with [멈추고 바꾸기] [끝나면 바꾸기]
// (`switch.apply{children}`); an owner conversation offers `지금 전환` only, which goes through its area main; and a
// 팀 계정 바꾸기 plan (team-flow.ts) shows the team-wide lines with [취소] [멈추고 바꾸기] [끝나면 바꾸기]
// (`team.account{mode}`) instead of the switch options.
import type { Estimate, Switch } from "@own/protocol"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useData, type ServerRuntime } from "@/data"
import { useI18n } from "@/i18n"
import { useCostDialogText } from "./cost-dialog-strings"
import { eventCode } from "@/keyboard"
import { useRouter } from "@/routing/router"
import "./popover.css"
import { minuteNow } from "@/shell/clock"
import { coldTokens, dialogPlan, shrinkFactor } from "./cost"
import { switcherControl, type DialogState } from "./control"
import {
  childWaitText,
  confidenceNote,
  costText,
  footerCost,
  switchText,
  tokenText,
  unavailableText,
  warningNotes,
} from "./describe"
import {
  CHILD_WAIT,
  confirmThresholds,
  continuingChildren,
  currentRef,
  dontAskFor,
  executeStrategy,
  type FlowEnv,
} from "./flow"
import { usePresetFixesText } from "@/presets/pf-strings"
import { formatDelta, formatTokens } from "./format"
import { accountOf, cacheText, modelName, slotOf, targetAccount, variantName } from "./labels"
import {
  closeTeamDialog,
  presetLineFor,
  presetName,
  roleName,
  routeOf,
  runTeamAccount,
  teamAccountLines,
  teamDialogOf,
  textOf,
  type TeamDialog,
} from "./team-flow"

export interface CostDialogProps {
  readonly runtime: ServerRuntime
  readonly dialog: DialogState
  readonly onClose: () => void
}

export default function CostDialog(props: CostDialogProps) {
  const team = () => teamDialogOf(props.dialog.sessionID, props.dialog.target)
  return (
    <Show when={team()} keyed fallback={<SwitchDialog {...props} />}>
      {(plan) => <TeamAccountDialog {...props} team={plan} />}
    </Show>
  )
}

function SwitchDialog(props: CostDialogProps) {
  const i18n = useI18n()
  const fixes = usePresetFixesText()
  const dialogText = useCostDialogText()
  const router = useRouter()
  const data = useData()
  const runtime = props.runtime
  const own = runtime.own
  const estimate = () => props.dialog.estimate
  const sessionID = () => props.dialog.sessionID
  const target = () => props.dialog.target
  const env: FlowEnv = {
    runtime,
    serverKey: props.dialog.serverKey,
    i18n,
    navigate: (route) => router.navigate(route),
  }
  // An owner conversation switches through its area main, which only switches now (06 §9.5, `area.main{now:true}`).
  const owner = () => routeOf(runtime, sessionID(), target()).kind === "owner"
  const plan = createMemo(() =>
    dialogPlan(owner() ? { options: estimate().options.filter((option) => option.strategy === "now") } : estimate()),
  )
  const [choice, setChoice] = createSignal<Estimate.Strategy | undefined>(plan().choice)
  const [more, setMore] = createSignal(plan().expandMore)
  const [details, setDetails] = createSignal(false)
  const [dontAsk, setDontAsk] = createSignal(false)
  const [running, setRunning] = createSignal(false)
  const [dialogAt, setDialogAt] = createSignal<number>()
  void confirmThresholds(runtime).then((confirm) =>
    setDialogAt(dontAskFor(coldTokens(estimate()).hi, confirm, switcherControl.state.override[sessionID()])),
  )

  const current = () => currentRef(runtime, sessionID())
  // The conversation's own accounts (SL-8: the Claude accounts share `anthropic`; a Claude model switch stays on it).
  const from = () => {
    const ref = current()
    return (ref && accountOf(runtime, ref.providerID, sessionID())?.label) || i18n.t("own.cache.unknown")
  }
  // SL-17: a switch to Claude lands on the account the estimate names (the switcher moved the tree to it first).
  const toAccount = () => targetAccount(runtime, target().providerID, sessionID(), estimate().target.accountID)
  const to = () => toAccount()?.label ?? target().providerID
  const directory = () => runtime.data.session.get(sessionID())?.location.directory
  const busy = () => runtime.data.session.status(sessionID()) === "running"
  const variantOnly = () => estimate().variantOnly
  const ctx = () => ({
    i18n,
    estimate: estimate(),
    targetIsClaudeSlot: toAccount()?.kind === "claude-sub",
    ...(toAccount()?.kind === "claude-agent" ? { planText: fixes("own.pf.costPlan") } : {}),
  })
  const fromCache = () => {
    const ref = current()
    const slot = ref
      ? slotOf(own.state.cache[sessionID()], ref.providerID, own.state.binding[sessionID()]?.accountID)
      : undefined
    return cacheText(i18n, slot, minuteNow()).text
  }
  const notes = () => {
    const listed = warningNotes(i18n, estimate(), { account: from(), cacheState: fromCache() })
    // A Claude Agent target is a plan with no per-token rates to miss (CAM-7).
    const missing = i18n.t("own.switcher.warn.rateUnknown")
    return toAccount()?.kind === "claude-agent" ? listed.filter((note) => note.text !== missing) : listed
  }
  const children = () => continuingChildren(runtime, sessionID())
  /** `<옛 계정>에서 하위 에이전트 n개가 실행 중입니다` (07 §5.5, `busyChildren`). */
  const childWait = () => {
    const busyChildren = estimate().busyChildren
    if (!busyChildren) return undefined
    const label = own.state.accounts[busyChildren.accountID]?.label ?? busyChildren.accountID
    return childWaitText(i18n, label, busyChildren.count)
  }
  const presetLine = () => {
    const base = current()
    if (!base) return undefined
    return presetLineFor({
      i18n,
      runtime,
      groups: data.local().own.state.presetGroups,
      base,
      target: target(),
      sessionID: sessionID(),
      team: own.state.sessionPreset[sessionID()]?.binding?.team,
    })
  }

  const title = () => {
    if (variantOnly())
      return dialogText("own.switch.dialogTitleVariant", {
        from: variantName(i18n, current()?.variant),
        to: variantName(i18n, target().variant),
      })
    return dialogText("own.switch.dialogTitle", { from: from(), to: to() })
  }
  const contextLine = () => {
    const ref = current()
    const fromModel = ref ? modelName(runtime, ref, directory()) : ""
    const toModel = modelName(runtime, target(), directory())
    const tokens = formatTokens(estimate().context.P)
    if (!ref || fromModel === toModel) return dialogText("own.switch.contextKeep", { model: toModel, tokens })
    return dialogText("own.switch.contextLine", { from: fromModel, to: toModel, tokens })
  }

  const optionTitle = (option: Estimate.Option) => {
    switch (option.strategy) {
      case "now":
        return i18n.t("own.switch.optNow")
      case "compact-then-switch":
        return i18n.t("own.switch.optCompact")
      case "switch-then-compact":
        return i18n.t("own.switch.optSwitchThenCompact")
      case "cold-point":
        if (!option.available) return i18n.t("own.switch.optCold")
        if (option.trigger === "either")
          return dialogText("own.switch.optColdEither", { minutes: Math.round(option.idleMinutes ?? 0) })
        if (option.trigger === "compaction") return dialogText("own.switch.optColdCompaction")
        return i18n.t("own.switch.optCold")
      case "new-session":
        return i18n.t("own.switch.optNewSession")
      case "fork":
        return i18n.t("own.switch.optFork")
    }
  }
  const coldDelta = (option: Estimate.Option) => {
    const delta = option.delta
    if (!delta) return i18n.t("own.switcher.costUnknown")
    if (Math.max(delta.lo, delta.hi) < 0.005) return dialogText("own.switch.coldFree")
    return formatDelta(i18n, delta)
  }
  const optionDescription = (option: Estimate.Option) => {
    if (!option.available) return unavailableText(i18n, option.reason, from())
    const cost = costText(ctx(), option)
    switch (option.strategy) {
      case "now":
        return dialogText("own.switch.optNowDesc", {
          tokens: tokenText(estimate()),
          delta: cost,
          when: busy() ? dialogText("own.switch.whenBusy") : dialogText("own.switch.whenIdle"),
        })
      case "compact-then-switch":
        return dialogText("own.switch.optCompactShort", { from: from(), delta: cost })
      case "switch-then-compact":
        return dialogText("own.switch.optSwitchThenCompactShort", { to: to(), delta: cost })
      case "cold-point": {
        const minutes = Math.round(option.idleMinutes ?? 0)
        if (option.trigger === "idle_ttl") return dialogText("own.switch.optColdIdleDesc", { from: from(), minutes })
        if (option.trigger === "compaction")
          return dialogText("own.switch.optColdCompactionDesc", { from: from(), delta: coldDelta(option) })
        return dialogText("own.switch.optColdEitherDesc", { from: from(), delta: coldDelta(option) })
      }
      case "new-session":
        return dialogText("own.switch.optNewSessionCost", { delta: cost })
      case "fork":
        return dialogText("own.switch.optForkDesc", { to: to(), from: from(), delta: cost })
    }
  }
  const extraLines = (option: Estimate.Option) => {
    if (!option.available) return []
    const lines: { tone: "info" | "warn"; text: string }[] = []
    if (option.strategy === "compact-then-switch") {
      const factor = shrinkFactor(estimate(), option)
      if (factor) lines.push({ tone: "info", text: dialogText("own.switch.compactBenefit", { n: factor }) })
      if (option.warnings?.includes("anthropic_compaction_may_be_cold"))
        lines.push({ tone: "warn", text: dialogText("own.switch.anthCompactCold") })
    }
    if (option.strategy === "switch-then-compact" && plan().cantCompact)
      lines.push({ tone: "info", text: dialogText("own.switch.cantCompact") })
    return lines
  }

  const selected = () => [...plan().primary, ...plan().secondary].find((option) => option.strategy === choice())
  /** The chosen option moves this root's main while subagents run on the old subscription: ask what to do with them. */
  const asksChildren = () => {
    const option = selected()
    return childWait() !== undefined && option?.available === true && CHILD_WAIT.has(option.strategy)
  }
  const confirmLabel = () => {
    const option = selected()
    if (!option) return i18n.t("own.switcher.close")
    if (busy() && option.strategy === "now") return dialogText("own.switch.confirmWait")
    return optionTitle(option).replace(/ — .*/, "")
  }

  /** `children`: [끝나면 바꾸기] (`after-idle`, also Enter on an option) or [멈추고 바꾸기] (`stop`), 07 §5.5. */
  async function confirm(children: Switch.Children | undefined = asksChildren() ? "after-idle" : undefined) {
    const option = selected()
    if (!option?.available || running()) return
    setRunning(true)
    // Read everything first: closing unmounts this dialog and its props go stale.
    const request = {
      sessionID: sessionID(),
      target: { ...target() },
      estimate: estimate(),
      option,
      dontAskBelow: dontAsk() ? dialogAt() : undefined,
      children,
    }
    props.onClose()
    await executeStrategy(env, request)
  }

  // ---- focus trap and keys (03 §11) ----
  let panel: HTMLDivElement | undefined
  onMount(() => {
    const checked = panel?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    ;(checked ?? panel?.querySelector<HTMLElement>("button"))?.focus()
  })
  const onKeyDown = modalKeys(
    () => panel,
    () => props.onClose(),
  )
  function onRadioKey(event: KeyboardEvent) {
    const code = eventCode(event)
    if (code !== "ArrowDown" && code !== "ArrowUp" && code !== "ArrowRight" && code !== "ArrowLeft") {
      if (code === "Enter" || code === "Space") {
        event.preventDefault()
        if (code === "Enter") void confirm()
      }
      return
    }
    event.preventDefault()
    const enabled = [...plan().primary, ...(more() ? plan().secondary : [])].filter((option) => option.available)
    const index = enabled.findIndex((option) => option.strategy === choice())
    const delta = code === "ArrowDown" || code === "ArrowRight" ? 1 : -1
    const next = enabled[(index + delta + enabled.length) % enabled.length]
    if (!next) return
    setChoice(next.strategy)
    panel?.querySelector<HTMLElement>(`[data-strategy="${next.strategy}"]`)?.focus()
  }
  const onScrim = (event: MouseEvent) => {
    if (event.target === event.currentTarget) props.onClose()
  }

  const Option = (option: Estimate.Option) => (
    <div
      class="own-sw-opt"
      role="radio"
      aria-checked={choice() === option.strategy}
      aria-disabled={!option.available}
      tabIndex={choice() === option.strategy ? 0 : -1}
      data-strategy={option.strategy}
      data-testid={`switch-option-${option.strategy}`}
      onClick={() => option.available && setChoice(option.strategy)}
      onKeyDown={onRadioKey}
    >
      <span class="own-sw-opt-radio" aria-hidden="true" />
      <span class="min-w-0">
        <span class="own-sw-opt-title">
          {optionTitle(option)}
          <Show when={option.recommended && option.available}>
            <span class="own-sw-tag own-sw-rec">{i18n.t("own.switch.recommended")}</span>
          </Show>
          <Show when={option.strategy === "cold-point" && option.available && option.uncertain}>
            <span class="own-sw-tag own-sw-dashed">{i18n.t("own.switch.coldUncertain")}</span>
          </Show>
          <Show when={option.available && option.strategy !== "cold-point" && option.delta}>
            <span class="own-sw-tag own-sw-dashed">{i18n.t("own.conf.estimated")}</span>
          </Show>
        </span>
        <span class="own-sw-opt-desc">{optionDescription(option)}</span>
        <For each={extraLines(option)}>
          {(line) => (
            <span class="own-sw-opt-desc" data-tone={line.tone}>
              {line.tone === "warn" ? "⚠ " : ""}
              {line.text}
            </span>
          )}
        </For>
      </span>
    </div>
  )

  return (
    <div class="own-sw-dlg-layer" onClick={onScrim} data-testid="switch-dialog-layer">
      <div
        ref={panel}
        class="own-sw-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-sw-dlg-title"
        data-testid="switch-dialog"
        onKeyDown={onKeyDown}
      >
        <div class="own-sw-dlg-head">
          <h2 id="own-sw-dlg-title">{title()}</h2>
          <button
            type="button"
            class="own-sw-icon own-target"
            aria-label={i18n.t("own.switcher.close")}
            onClick={() => props.onClose()}
          >
            ×
          </button>
        </div>
        <div class="own-sw-dlg-body">
          <p class="own-sw-dlg-why">
            {contextLine()}
            <br />
            {variantOnly() ? dialogText("own.switch.whyVariant") : dialogText("own.switch.why", { to: to() })}
            <For each={notes()}>
              {(note) => (
                <>
                  <br />
                  <span data-tone={note.tone}>
                    {note.tone === "warn" ? "⚠ " : "ⓘ "}
                    {note.text}
                  </span>
                </>
              )}
            </For>
            <Show
              when={childWait()}
              fallback={
                <Show when={children() > 0}>
                  <br />ⓘ {i18n.t("own.switch.subagents", { n: children() })}
                </Show>
              }
            >
              {(line) => (
                <>
                  <br />
                  <span data-testid="switch-dialog-child-wait">ⓘ {line()}</span>
                </>
              )}
            </Show>
            <Show when={presetLine()}>
              {(line) => (
                <>
                  <br />
                  <span data-testid="switch-dialog-preset-line">ⓘ {line()}</span>
                </>
              )}
            </Show>
          </p>
          <div role="radiogroup" aria-labelledby="own-sw-dlg-title" class="own-sw-opts">
            <For each={plan().primary}>{(option) => Option(option)}</For>
            <Show when={plan().secondary.length}>
              <button
                type="button"
                class="own-sw-link own-sw-dlg-more"
                aria-expanded={more()}
                onClick={() => setMore(!more())}
              >
                {more() ? "▾" : "▸"} {dialogText("own.switch.more")}
              </button>
              <Show when={more()}>
                <For each={plan().secondary}>{(option) => Option(option)}</For>
              </Show>
            </Show>
          </div>
          <div class="own-sw-faint">
            ⓘ {confidenceNote(i18n, estimate().confidence)}
            <Show when={estimate().context.units.source !== estimate().context.units.target}>
              {" · "}
              {dialogText("own.switch.unitsDiffer")}
            </Show>{" "}
            <button type="button" class="own-sw-link" aria-expanded={details()} onClick={() => setDetails(!details())}>
              {details() ? dialogText("own.switch.detailsHide") : dialogText("own.switch.details")}
            </button>
          </div>
          <Show when={details()}>
            <pre class="own-sw-dlg-detail">{detailText(estimate())}</pre>
          </Show>
        </div>
        <div class="own-sw-dlg-foot">
          <Show when={dialogAt()}>
            {(tokens) => (
              <label class="own-sw-dlg-check">
                <input
                  type="checkbox"
                  checked={dontAsk()}
                  onChange={(event) => setDontAsk(event.currentTarget.checked)}
                />
                {dialogText("own.switch.dontAsk", { tokens: formatTokens(tokens()) })}
              </label>
            )}
          </Show>
          <button type="button" class="own-sw-btn" onClick={() => props.onClose()}>
            {i18n.t("own.switcher.cancel")}
          </button>
          <Show
            when={asksChildren()}
            fallback={
              <button
                type="button"
                class="own-sw-btn own-sw-primary"
                disabled={!selected()?.available || running()}
                data-testid="switch-dialog-confirm"
                onClick={() => void confirm()}
              >
                {confirmLabel()}
              </button>
            }
          >
            <button
              type="button"
              class="own-sw-btn"
              disabled={running()}
              data-testid="switch-dialog-stop"
              onClick={() => void confirm("stop")}
            >
              {switchText(i18n.locale(), "own.switch.children.stop")}
            </button>
            <button
              type="button"
              class="own-sw-btn own-sw-primary"
              disabled={running()}
              data-testid="switch-dialog-after-idle"
              onClick={() => void confirm("after-idle")}
            >
              {switchText(i18n.locale(), "own.switch.children.afterIdle")}
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

/**
 * 팀 계정 바꾸기 (06 §9.5, §10.1): the plan of `team.account{dryRun}` with the team-wide line (`팀 전체(메인과 영역
 * 3개)를 ChatGPT 02로 · ChatGPT 01에서 … 일하는 중입니다`), the areas that continue in new conversations, the preset
 * targets the new account breaks, and the team main's own switch cost when own.accounts could estimate it.
 * [끝나면 바꾸기] waits for the old account's work, [멈추고 바꾸기] stops it (`team.account{mode}`).
 */
function TeamAccountDialog(props: CostDialogProps & { readonly team: TeamDialog }) {
  const i18n = useI18n()
  const fixes = usePresetFixesText()
  const router = useRouter()
  const data = useData()
  const runtime = props.runtime
  const text = textOf(i18n)
  const env: FlowEnv = {
    runtime,
    serverKey: props.dialog.serverKey,
    i18n,
    navigate: (route) => router.navigate(route),
  }
  const sessionID = props.dialog.sessionID
  // Closing unmounts this dialog first; only then the plan goes, so the switch dialog never shows in its place.
  const close = () => {
    props.onClose()
    closeTeamDialog(sessionID)
  }
  const plan = () => props.team.plan
  /** The team main, else the conversation the switch started from: its account names the team's (SL-8). */
  const holder = () => {
    const main = runtime.team.team(props.team.teamID)?.team.main.sessionID
    return main && currentRef(runtime, main) ? main : sessionID
  }
  // SL-17: a move to Claude lands on the team's Claude account, which the estimate names.
  const to = () =>
    targetAccount(runtime, props.team.target.providerID, holder(), plan().estimate?.target.accountID)?.label ??
    props.team.target.providerID
  /** The team's account now. */
  const from = () => {
    const ref = currentRef(runtime, holder())
    return (ref && accountOf(runtime, ref.providerID, holder())?.label) || i18n.t("own.cache.unknown")
  }
  const lines = createMemo(() =>
    teamAccountLines(text, plan(), {
      to: to(),
      from: from(),
      area: (areaID) => runtime.team.area(props.team.teamID, areaID)?.name ?? areaID,
      preset: (presetID) => presetName(i18n, data.local().own.state.presetGroups, presetID),
      account: (accountID) => runtime.own.state.accounts[accountID]?.label ?? accountID,
      role: (role) => roleName(i18n, role),
    }),
  )
  /** The team main's switch cost (03 §5.2 footer line); none without an estimate or a conversation yet. */
  const cost = () => {
    const estimate = plan().estimate
    if (!estimate || estimate.context.P === 0) return undefined
    const kind = accountOf(runtime, props.team.target.providerID, holder())?.kind
    return footerCost(
      {
        i18n,
        estimate,
        targetIsClaudeSlot: kind === "claude-sub",
        ...(kind === "claude-agent" ? { planText: fixes("own.pf.costPlan") } : {}),
      },
      undefined,
    )
  }
  const [running, setRunning] = createSignal(false)

  async function run(mode: Switch.Children) {
    if (running()) return
    setRunning(true)
    // Read everything first: closing unmounts this dialog and its props go stale.
    const request = {
      teamID: props.team.teamID,
      target: { ...props.team.target },
      mode,
      waiting: mode === "after-idle" && lines().waits ? from() : undefined,
    }
    close()
    await runTeamAccount(env, request)
  }

  let panel: HTMLDivElement | undefined
  onMount(() => panel?.querySelector<HTMLElement>('[data-testid="team-account-after-idle"]')?.focus())
  const onKeyDown = modalKeys(() => panel, close)
  const onScrim = (event: MouseEvent) => {
    if (event.target === event.currentTarget) close()
  }

  return (
    <div class="own-sw-dlg-layer" onClick={onScrim} data-testid="switch-dialog-layer">
      <div
        ref={panel}
        class="own-sw-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="own-sw-dlg-title"
        data-testid="team-account-dialog"
        onKeyDown={onKeyDown}
      >
        <div class="own-sw-dlg-head">
          <h2 id="own-sw-dlg-title">{text("own.team.account.title")}</h2>
          <button
            type="button"
            class="own-sw-icon own-target"
            aria-label={i18n.t("own.switcher.close")}
            onClick={close}
          >
            ×
          </button>
        </div>
        <div class="own-sw-dlg-body">
          <p class="own-sw-dlg-why" data-testid="team-account-move">
            {lines().move}
            <Show when={lines().rotate}>
              {(line) => (
                <>
                  <br />ⓘ {line()}
                </>
              )}
            </Show>
            <For each={lines().repairs}>
              {(line) => (
                <>
                  <br />
                  <span data-tone="warn">⚠ {line}</span>
                </>
              )}
            </For>
          </p>
          <Show when={cost()}>{(line) => <div class="own-sw-faint">{line()}</div>}</Show>
        </div>
        <div class="own-sw-dlg-foot">
          <button type="button" class="own-sw-btn" onClick={close}>
            {i18n.t("own.switcher.cancel")}
          </button>
          <button
            type="button"
            class="own-sw-btn"
            disabled={running()}
            data-testid="team-account-stop"
            onClick={() => void run("stop")}
          >
            {text("own.team.account.stop")}
          </button>
          <button
            type="button"
            class="own-sw-btn own-sw-primary"
            disabled={running()}
            data-testid="team-account-after-idle"
            onClick={() => void run("after-idle")}
          >
            {text("own.team.account.afterIdle")}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Keys of a modal dialog (03 §11): Esc closes, Tab and Shift+Tab stay inside the panel. */
function modalKeys(panel: () => HTMLElement | undefined, close: () => void) {
  const focusables = () =>
    Array.from(
      panel()?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [role="radio"][tabindex="0"]',
      ) ?? [],
    )
  return (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return
    const code = eventCode(event)
    if (code === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      return close()
    }
    if (code === "Tab") {
      const items = focusables()
      if (!items.length) return
      const index = items.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length
      event.preventDefault()
      items[next]?.focus()
    }
  }
}

/** `[자세히]`: the router's inputs and confidence as they are (03 §6.3), no UI arithmetic beyond `P − W`. */
function detailText(estimate: Estimate.Result) {
  const tokens = coldTokens(estimate)
  const rates = Object.entries(estimate.inputs.rates)
    .map(([key, value]) => `${key}=${value ?? "?"}`)
    .join(", ")
  return [
    `P = ${estimate.context.P} · Z = ${estimate.context.Z} · units ${estimate.context.units.source} → ${estimate.context.units.target}`,
    `W_lo = ${estimate.inputs.W_lo} · W_hi = ${estimate.inputs.W_hi} · cold = ${tokens.lo}–${tokens.hi}`,
    `rates (per 1M): ${rates || "—"}`,
    `ttl: lo ${estimate.inputs.ttl.lo ?? "?"} s · hi ${estimate.inputs.ttl.hi ?? "?"} s`,
    `confidence: ${estimate.confidence.steps} steps · error ${estimate.confidence.recentError ?? "—"}`,
    `target: ${estimate.target.providerID}/${estimate.target.id}${estimate.target.variant ? `#${estimate.target.variant}` : ""} · fits ${estimate.target.fits}`,
    estimate.target.compactAt
      ? `compactAt: ${estimate.target.compactAt.triggerTokens} / ${estimate.target.compactAt.windowTokens} (${estimate.target.compactAt.source})`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}
