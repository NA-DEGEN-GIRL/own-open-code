// Neutral chip for a subagent call the preset gate refused (07 §5.4 거절 경로, §7.3 거절 안내, §2.6). The transcript draws
// it in place of session-ui's failure card: the refusal is the gate working, not the call failing. The gate's text is
// read back with `Preset.parse` (presets/chips.ts); models are named as the transcript names them ("모델 @ 계정", 03 §1:
// the account label, never an internal slot id such as `own-codex-02`) and the gate's sentence (written for the LLM) is
// the tooltip. Kinds and their actions:
//   - a cap: `하위 에이전트 대기: 3개 실행 중`; per message with `이번 메시지만 늘리기` while that turn runs
//     (`session.preset.raiseOnce`); per conversation;
//   - not in the preset: `[하위 에이전트에 추가…]` opens the editor with the role filled (nothing is stored before
//     `저장`), never for another subscription of the main's company; `[그대로]` folds the actions away;
//   - not in a model pool (`이 모델 묶음에 없습니다`, 07 §8.3 모델 묶음): `[묶음에 추가…]` opens the editor with that model
//     checked (the main account's model for one the main slot offers) and the session's pool facts, saving nothing;
//   - a paid role the user has not allowed: `[이 대화에서만] [아니오]` (`session.preset.consent`), naming the paid account
//     and the subscription it waits on (the session's preset view is read while such a chip is on screen);
//   - a per-call effort (07 §2.3): an unknown level; or above the ceiling, naming the asked and the allowed level, with
//     `이번 메시지만 허용` while that turn runs (`session.preset.raiseOnce{effort}`), never for a paid model;
//   - a used-up budget, delegation `안 함`; any other gate text keeps T0's plain chip.
import type { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { LOCAL, useData } from "@/data"
import { useI18n } from "@/i18n"
import { chipOf, type Addition, type Chip } from "@/presets/chips"
import { openPresetEditor, presetPlace } from "@/presets/model"
import { presetInEffect, ROLE_KEY } from "@/presets/session-view"
import { usePresetsText } from "@/presets/strings"
import { variantName } from "@/switcher/labels"
import { showToast } from "@/switcher/toast"
import { useTranscript } from "@/transcript/context"
import { effortOf, requestedRef, type PresetRejection } from "./model"
import { useSubagentText } from "./strings"
import "./subagent.css"

export function PresetRejectedChip(props: { readonly rejection: PresetRejection }) {
  const text = useSubagentText()
  const names = usePresetsText()
  const i18n = useI18n()
  const data = useData()
  const transcript = useTranscript()
  const runtime = transcript.runtime
  const own = runtime.own
  const sessionID = transcript.sessionID
  const [folded, setFolded] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  /** What the user answered here: a raise, a consent (`true` allowed, `false` refused), or a higher effort allowed. */
  const [done, setDone] = createSignal<{ readonly raised?: number; readonly allow?: boolean; readonly effort?: true }>()

  const mainRef = () => own.state.binding[sessionID]?.model ?? runtime.data.session.get(sessionID)?.model
  const group = () => {
    const ref = mainRef()
    return ref ? Preset.groupOf(ref.providerID, own.accountFor(ref.providerID)) : undefined
  }
  const view = () => own.state.sessionPreset[sessionID]
  const chip = createMemo<Chip>(() => {
    const ref = mainRef()
    return chipOf(props.rejection, {
      group: group(),
      preset: view()?.preset ?? undefined,
      resolution: view()?.resolution,
      // Preset pins and R4 name every Claude account as the Claude slot (the server's `member`): the provider's.
      accountOf: (providerID) => own.accountFor(providerID),
      lookup: (accountID) => own.state.accounts[accountID],
      ...(ref
        ? {
            main: {
              providerID: ref.providerID,
              models: Object.keys(transcript.catalog.ui().all.get(ref.providerID)?.models ?? {}),
            },
          }
        : {}),
    })
  })
  // A consent or budget chip names the paid account of the preset in effect, and a pool chip hands the editor its pool
  // facts: keep its view while the chip is shown.
  const needsView = createMemo(() => {
    const value = chip()
    return value.kind === "consent" || value.kind === "budget" || (value.kind === "model" && value.pool === true)
  })
  createEffect(() => {
    if (needsView()) onCleanup(own.watchPreset(sessionID))
  })

  const label = (accountID: string | undefined) => (accountID && own.state.accounts[accountID]?.label) || accountID
  /**
   * The account (or a known provider) and the model's name; a bare id by the main slot's name for it; the value as
   * written when neither is known.
   */
  const model = () => {
    const requested = props.rejection.requestedModel
    const ref = requested ? requestedRef(requested) : undefined
    const main = mainRef()
    if (!ref)
      return requested && main ? transcript.catalog.modelName(main.providerID, requested.split("#")[0]!) : requested
    const provider = transcript.catalog.providerName(ref.providerID)
    // A Claude model runs on the conversation's Claude account (SL-8: the tree's, one per tree).
    const owner =
      own.accountOfSession(sessionID, ref.providerID)?.label ?? (provider === ref.providerID ? undefined : provider)
    if (!owner) return requested
    return i18n.t("own.session.runningOn", {
      model: transcript.catalog.modelName(ref.providerID, ref.modelID),
      account: owner,
    })
  }

  const line = () => {
    const value = chip()
    const answer = done()
    if (value.kind === "caps") {
      if (answer?.raised !== undefined) return text("own.subagent.chip.raised", { n: answer.raised })
      if (value.cap === "concurrent") return names("own.preset.waiting", { n: value.max })
      return text(value.cap === "perMessage" ? "own.subagent.chip.perMessage" : "own.subagent.chip.perSession", {
        n: value.max,
      })
    }
    if (value.kind === "off") return text("own.subagent.chip.off")
    const asked = effortOf(props.rejection.requestedModel)
    if (value.kind === "effort")
      return asked ? text("own.subagent.chip.effort", { effort: asked }) : text("own.subagent.chip.effortPlain")
    if (value.kind === "effortCap") {
      if (answer?.effort) return text("own.subagent.chip.effortAllowed")
      const max = variantName(i18n, value.max)
      if (!value.once) return text("own.subagent.chip.effortCapPaid", { max })
      return asked
        ? text("own.subagent.chip.effortCap", { effort: variantName(i18n, asked), max })
        : text("own.subagent.chip.effortCapPlain", { max })
    }
    if (value.kind === "model") {
      const name = model()
      if (value.pool)
        return name ? text("own.subagent.chip.notInPool", { model: name }) : text("own.subagent.chip.notInPoolPlain")
      return name ? text("own.subagent.chip.notInPreset", { model: name }) : text("own.subagent.chip.notInPresetPlain")
    }
    if (value.kind === "budget") {
      const account = label(value.account)
      return account ? text("own.subagent.chip.budget", { account }) : text("own.subagent.chip.budgetPlain")
    }
    if (value.kind === "consent") {
      const account = label(value.account) ?? ""
      if (answer?.allow !== undefined)
        return text(answer.allow ? "own.subagent.chip.allowed" : "own.subagent.chip.denied", { account })
      const role = names(ROLE_KEY[value.role])
      if (!value.account) return text("own.subagent.chip.consentPlain", { role })
      const blocked = label(value.blocked)
      return blocked
        ? text("own.subagent.chip.consentWaiting", { blocked, role, account })
        : text("own.subagent.chip.consent", { role, account })
    }
    const name = model()
    return name ? text("own.subagent.rejected.model", { model: name }) : text("own.subagent.rejected.plain")
  }

  /** `이번 메시지만 늘리기`: only while the turn that hit the per-message cap still runs. */
  const canRaise = () => {
    const value = chip()
    return (
      value.kind === "caps" &&
      value.cap === "perMessage" &&
      done() === undefined &&
      transcript.status().type === "busy" &&
      own.rpc.allowed("session.preset.raiseOnce")
    )
  }
  /** `이번 메시지만 허용` (07 §2.3): a free target over the ceiling, while the turn that asked still runs. */
  const canAllowEffort = () => {
    const value = chip()
    return (
      value.kind === "effortCap" &&
      value.once &&
      done() === undefined &&
      transcript.status().type === "busy" &&
      own.rpc.allowed("session.preset.raiseOnce")
    )
  }
  /**
   * `[하위 에이전트에 추가…]`: the editor saves this PC's presets, so on this PC's server, or on a remote one that
   * mirrors them (07 §8.1 원격, T3; one without the mirror keeps `평소대로`), and where this PC's connection may save.
   */
  const addition = () => {
    const value = chip()
    if (value.kind !== "model" || folded() || !data.local().rpc.allowed("presets.set")) return undefined
    const here = runtime.key === LOCAL
    const mirrored = presetPlace(own.state.presetGroups, data.local().own.state.presetGroups) === "mirror"
    return here || mirrored ? value.add : undefined
  }
  const consent = () => {
    const value = chip()
    return value.kind === "consent" &&
      value.account &&
      done() === undefined &&
      own.rpc.allowed("session.preset.consent")
      ? value.account
      : undefined
  }

  async function raiseOnce() {
    setBusy(true)
    try {
      const result = await own.rpc.call("session.preset.raiseOnce", { sessionID })
      setDone({ raised: result.perMessage })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  async function allowEffort() {
    setBusy(true)
    try {
      await own.rpc.call("session.preset.raiseOnce", { sessionID, effort: true })
      setDone({ effort: true })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  async function answer(accountID: Account.ID, allow: boolean) {
    setBusy(true)
    try {
      await own.rpc.call("session.preset.consent", { sessionID, accountID, allow })
      setDone({ allow })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }

  function add(fill: Addition) {
    const value = group()
    const ref = mainRef()
    if (!value) return
    const current = presetInEffect(value, view(), own.state.presetGroups[value])
    // The session's pool facts belong to the preset in effect, the one the editor opens.
    const facts = view()?.preset?.id === current.id ? view()?.resolution?.pool : undefined
    openPresetEditor({
      group: value,
      ...(Preset.isBuiltin(current.id) ? {} : { presetID: current.id }),
      prefill: fill,
      ...(ref
        ? { main: { providerID: ref.providerID, id: ref.id, ...(ref.variant ? { variant: ref.variant } : {}) } }
        : {}),
      ...(facts ? { pool: facts } : {}),
    })
  }

  function failed(error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    showToast({ message: text("own.subagent.chip.failed", { reason }), tone: "danger" })
  }

  return (
    <div class="own-sa-rejected" role="note" data-testid="subagent-preset-rejected" data-kind={chip().kind}>
      <span class="own-sa-rejected-chip" title={props.rejection.reason || undefined}>
        <span class="own-sa-rejected-icon" aria-hidden="true">
          ⊘
        </span>
        <span data-testid="subagent-preset-rejected-text">{line()}</span>
        <Show when={canRaise()}>
          <button
            type="button"
            class="own-sa-open"
            data-testid="subagent-chip-raise"
            disabled={busy()}
            onClick={() => void raiseOnce()}
          >
            {names("own.preset.caps.raiseOnce")}
          </button>
        </Show>
        <Show when={canAllowEffort()}>
          <button
            type="button"
            class="own-sa-open"
            data-testid="subagent-chip-effort-allow"
            disabled={busy()}
            onClick={() => void allowEffort()}
          >
            {text("own.subagent.chip.effortAllow")}
          </button>
        </Show>
        <Show when={addition()}>
          {(fill) => (
            <>
              <button type="button" class="own-sa-open" data-testid="subagent-chip-add" onClick={() => add(fill())}>
                {"pool" in fill() ? names("own.preset.pool.addFromChip") : text("own.subagent.chip.add")}
              </button>
              <button
                type="button"
                class="own-sa-open"
                data-testid="subagent-chip-keep"
                onClick={() => setFolded(true)}
              >
                {text("own.subagent.chip.keep")}
              </button>
            </>
          )}
        </Show>
        <Show when={consent()}>
          {(accountID) => (
            <>
              <button
                type="button"
                class="own-sa-open"
                data-testid="subagent-chip-allow"
                disabled={busy()}
                onClick={() => void answer(accountID(), true)}
              >
                {text("own.subagent.chip.allowHere")}
              </button>
              <button
                type="button"
                class="own-sa-open"
                data-testid="subagent-chip-deny"
                disabled={busy()}
                onClick={() => void answer(accountID(), false)}
              >
                {text("own.subagent.chip.no")}
              </button>
            </>
          )}
        </Show>
      </span>
    </div>
  )
}
