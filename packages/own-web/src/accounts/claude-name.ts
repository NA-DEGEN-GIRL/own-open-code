// The name of a Claude subscription account in the switcher and the pill (02 §8.7, 03 §6.2): `Claude · {label}`, and
// a label that already starts with `Claude` (the slot's own `Claude`, `Claude 구독`, `Claude Max · …`) as it is. Kept
// apart from the cards so the switcher loads none of them.
import type { Account } from "@own/protocol"
import type { I18n } from "@/i18n"

export function claudeAccountName(i18n: I18n, account: Pick<Account.View, "kind" | "label">) {
  if (account.kind !== "claude-sub" || /^Claude(?![\p{L}\p{N}])/u.test(account.label)) return account.label
  return i18n.t("own.claude.switcher.name", { label: account.label })
}
