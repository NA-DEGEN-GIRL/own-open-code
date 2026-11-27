// Account chip grammar (03 P1 "계정 칩 문법"): color dot + account name (always both; color is never the only cue),
// the model short name, `비공식` for third-party slots, dashed for built-in providers that use global credentials.
// Used by the turn footer and markers; exported for the header pill, sidebar rows and the switcher.
import type { Account, Kind } from "@own/protocol"
import { Show } from "solid-js"
import type { OwnStore } from "@/data"
import { useI18n, type I18n } from "@/i18n"

export interface AccountDisplay {
  readonly label: string
  readonly color: Account.Color | undefined
  readonly kind: Kind.Any | undefined
  /** Built-in provider, not a router account (5.2.1): dashed chip, no color. */
  readonly builtin: boolean
  readonly thirdParty: boolean
}

export interface DisplayInput {
  readonly own: OwnStore
  readonly i18n: I18n
  readonly providerName: (providerID: string) => string
}

export function ownDisplay(account: Account.View): AccountDisplay {
  return {
    label: account.label,
    color: account.color,
    kind: account.kind,
    builtin: false,
    thirdParty: account.thirdParty,
  }
}

export function builtinDisplay(input: DisplayInput, providerID: string): AccountDisplay {
  return {
    label: input.i18n.t("own.binding.builtin", { provider: input.providerName(providerID) }),
    color: undefined,
    kind: undefined,
    builtin: true,
    thirdParty: false,
  }
}

export function AccountDot(props: { readonly color: Account.Color | undefined }) {
  return (
    <span
      class="own-dot"
      data-empty={props.color ? undefined : ""}
      style={props.color ? { "--own-dot-color": `var(--own-account-${props.color})` } : undefined}
      aria-hidden="true"
    />
  )
}

/** `● 개인 Pro` (+ `비공식`). */
export function AccountName(props: { readonly account: AccountDisplay }) {
  const i18n = useI18n()
  return (
    <span class="own-account-name" data-builtin={props.account.builtin ? "" : undefined}>
      <AccountDot color={props.account.color} />
      <bdi>{props.account.label}</bdi>
      <Show when={props.account.thirdParty}>
        <span class="own-ttag">{i18n.t("own.accounts.type.unofficial")}</span>
      </Show>
    </span>
  )
}

/** "모델 @ 계정" (03 P1: model first), e.g. `GPT-5.6 Sol @ ● 개인 Pro`. */
export function ModelAccountChip(props: { readonly model: string; readonly account: AccountDisplay }) {
  const i18n = useI18n()
  return (
    <span
      class="own-chip"
      data-builtin={props.account.builtin ? "" : undefined}
      data-testid="model-account-chip"
      aria-label={i18n.t("own.session.runningOn", { model: props.model, account: props.account.label })}
    >
      <AccountDot color={props.account.color} />
      <span class="own-chip-text">
        {i18n.t("own.session.runningOn", { model: props.model, account: props.account.label })}
      </span>
      <Show when={props.account.thirdParty}>
        <span class="own-ttag">{i18n.t("own.accounts.type.unofficial")}</span>
      </Show>
    </span>
  )
}
