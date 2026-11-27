// Settings > 전환 정책 (03 §5.7 row, §6.2 thresholds, §6.7 auto switch). Values are the router's `policy.get` and are
// written with `policy.set` (02 §2.4.3). Subscription accounts never switch automatically (6.7, 02 §5.10): the
// `자동` choice is shown disabled with its reason, `toClaudeSlot` is fixed off, and a `policy_denied` answer puts the
// server values back on screen with `구독 계정 자동 전환은 제공하지 않습니다`.
import type { Policy } from "@own/protocol"
import { createSignal, Show, type JSX } from "solid-js"
import { useData } from "@/data"
import { useI18n, type I18nKey } from "@/i18n"
import { errorMessage, errorType } from "@/accounts/errors"
import { grouped, parseTokens, usd } from "@/limits/format"
import { Segmented, TextField, createStatus, StatusLine } from "@/limits/kit"
import { loadPolicy, policyState, updatePolicy } from "@/limits/shared"

const MODE_LABEL: Record<Policy.SwitchMode, I18nKey> = {
  auto: "own.set.modeAuto",
  ask: "own.set.modeAsk",
  off: "own.set.modeOff",
}

export default function PolicySettings() {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  void loadPolicy(own)
  const status = createStatus()
  const policy = () => policyState()?.policy
  const writable = () => own.rpc.allowed("policy.set")

  const patch = async (value: Policy.Patch) => {
    status.clear()
    await own.rpc
      .call("policy.set", { patch: value })
      .then((output) => {
        updatePolicy(own, output.policy)
        status.ok(i18n.t("own.set.saved"))
      })
      .catch(async (error: unknown) => {
        if (errorType(error) === "policy_denied") {
          await loadPolicy(own, true)
          return status.error(i18n.t("own.policy.denied"))
        }
        status.error(errorMessage(i18n, error))
      })
  }

  const modes = (allowed: readonly Policy.SwitchMode[]) =>
    (["auto", "ask", "off"] as const).map((mode) => ({
      value: mode,
      label: i18n.t(MODE_LABEL[mode]),
      disabled: !writable() || !allowed.includes(mode),
    }))

  return (
    <Show when={policy()} fallback={<p class="own-placeholder px-0">{i18n.t("own.shell.loading")}</p>}>
      {(current) => (
        <div class="flex flex-col" data-testid="settings-policy">
          <p class="m-0 text-[13px] leading-5 text-own-muted">{i18n.t("own.set.policy.lead")}</p>
          <section class="own-psec !mt-2">
            <div class="own-psec-head">
              <h2>{i18n.t("own.set.autoSwitch")}</h2>
            </div>
            <Row title={i18n.t("own.set.apiToApi")} note={i18n.t("own.set.apiToApiNote")}>
              <Segmented
                label={i18n.t("own.set.apiToApi")}
                value={current().autoSwitch.apiToApi}
                options={modes(["auto", "ask", "off"])}
                onChange={(mode) => void patch({ autoSwitch: { apiToApi: mode } })}
              />
            </Row>
            <Row title={i18n.t("own.set.subToApi")} note={i18n.t("own.policy.subAutoOff")}>
              <Segmented
                label={i18n.t("own.set.subToApi")}
                value={current().autoSwitch.subscriptionToApi}
                options={modes(["ask", "off"])}
                onChange={(mode) => void patch({ autoSwitch: { subscriptionToApi: mode } })}
                testid="policy-sub-api"
              />
            </Row>
            <Row title={i18n.t("own.set.subToSub")} note={i18n.t("own.policy.subAutoOff")}>
              <Segmented
                label={i18n.t("own.set.subToSub")}
                value={current().autoSwitch.subscriptionToSubscription}
                options={modes(["ask", "off"])}
                onChange={(mode) => void patch({ autoSwitch: { subscriptionToSubscription: mode } })}
              />
            </Row>
            <Row title={i18n.t("own.set.toClaude")} note={i18n.t("own.set.toClaudeNote")}>
              <span class="text-[13px] text-own-muted">{i18n.t("own.set.modeOff")}</span>
            </Row>
            <Row title={i18n.t("own.set.claudeToClaude")} note={i18n.t("own.set.claudeToClaudeNote")}>
              <Segmented
                label={i18n.t("own.set.claudeToClaude")}
                value={current().autoSwitch.claudeToClaude ?? "off"}
                options={(["auto", "off"] as const).map((mode) => ({
                  value: mode,
                  label: i18n.t(MODE_LABEL[mode]),
                  disabled: !writable(),
                }))}
                onChange={(mode) => void patch({ autoSwitch: { claudeToClaude: mode } })}
                testid="policy-claude-claude"
              />
            </Row>
            <p class="m-0 mt-2 text-[12px] text-own-muted">
              {i18n.t("own.set.breaker", {
                n: current().hysteresis.breakerAutoPerHour,
                minutes: current().hysteresis.breakerOpenMinutes,
                cooldown: current().hysteresis.cooldownMinutes,
              })}
            </p>
          </section>

          <section class="own-psec">
            <div class="own-psec-head">
              <h2>{i18n.t("own.set.confirm")}</h2>
            </div>
            <Thresholds
              confirm={current().thresholds.confirm}
              disabled={!writable()}
              onSave={(confirm) => void patch({ thresholds: { confirm } })}
            />
          </section>
          <StatusLine status={status} testid="policy-status" />
        </div>
      )}
    </Show>
  )
}

function Row(props: { readonly title: string; readonly note?: string; readonly children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-own-border py-2.5">
      <div class="min-w-[220px] flex-1">
        <b class="block text-[13.5px] font-semibold">{props.title}</b>
        <Show when={props.note}>
          <span class="text-[12px] text-own-muted">{props.note}</span>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

/** 6.2: when a switch asks first (tokens, calibrated limit %, dollars) and below which it applies silently. */
function Thresholds(props: {
  readonly confirm: Policy.Confirm
  readonly disabled: boolean
  readonly onSave: (confirm: Policy.Confirm) => void
}) {
  const i18n = useI18n()
  const [silent, setSilent] = createSignal(grouped(props.confirm.silentBelowTokens))
  const [tokens, setTokens] = createSignal(grouped(props.confirm.dialogAtTokens))
  const [quota, setQuota] = createSignal(String(props.confirm.dialogAtQuotaPercent))
  const [money, setMoney] = createSignal(String(props.confirm.dialogAtUSD))
  const parsed = () => {
    const silentBelowTokens = parseTokens(silent())
    const dialogAtTokens = parseTokens(tokens())
    const dialogAtQuotaPercent = Number(quota())
    const dialogAtUSD = Number(money().replace("$", ""))
    if (silentBelowTokens === undefined || dialogAtTokens === undefined) return undefined
    if (
      !Number.isFinite(dialogAtQuotaPercent) ||
      !Number.isFinite(dialogAtUSD) ||
      dialogAtQuotaPercent < 0 ||
      dialogAtUSD < 0
    )
      return undefined
    return { silentBelowTokens, dialogAtTokens, dialogAtQuotaPercent, dialogAtUSD }
  }
  const save = () => {
    const value = parsed()
    if (value) props.onSave(value)
  }
  return (
    <div class="grid grid-cols-1 gap-3 tablet:grid-cols-2">
      <TextField
        label={i18n.t("own.set.silentBelow")}
        value={silent()}
        onValue={setSilent}
        onEnter={save}
        inputMode="numeric"
        disabled={props.disabled}
      />
      <TextField
        label={i18n.t("own.set.dialogTokens")}
        value={tokens()}
        onValue={setTokens}
        onEnter={save}
        inputMode="numeric"
        disabled={props.disabled}
      />
      <TextField
        label={i18n.t("own.set.dialogQuota")}
        value={quota()}
        onValue={setQuota}
        onEnter={save}
        inputMode="decimal"
        disabled={props.disabled}
      />
      <TextField
        label={i18n.t("own.set.dialogUSD")}
        value={money()}
        onValue={setMoney}
        onEnter={save}
        inputMode="decimal"
        disabled={props.disabled}
        hint={parsed() ? usd(parsed()!.dialogAtUSD, true) : undefined}
      />
      <div class="tablet:col-span-2">
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          data-variant="primary"
          disabled={props.disabled || !parsed()}
          onClick={save}
        >
          {i18n.t("own.kit.save")}
        </button>
      </div>
    </div>
  )
}
