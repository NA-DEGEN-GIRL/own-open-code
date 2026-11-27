// Linked API keys saved by the old app codex-multi-provider (02 §3.2b), shown in the "이전 앱에서 가져오기" flow next to
// the Codex profiles. Linking only (no copy): the account keeps a reference to the old app's key file, which own-vault
// decrypts in memory per request. The router never sends the key or the file path; rows show the provider, its kind,
// the old app's URL and model, and whether a key file exists. Per row: plan → confirm (key hint, warnings, duplicate,
// name, color) → execute.
import type { Account, OwnError } from "@own/protocol"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { useData } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { ColorPicker, Notice, ProviderMark, Spinner, TextField, createStatus, StatusLine } from "@/limits/kit"
import { errorData, errorMessage, errorType } from "./errors"
import { useLegacyKeyText } from "./legacy-key-strings"
import { COLORS, kindLabel, nextColor } from "./model"

export type LegacyKeyList = OwnOutput<"accounts.import.keys.list">
type Candidate = LegacyKeyList["keys"][number]
type Plan = OwnOutput<"accounts.import.keys.plan">

export const LEGACY_PROBLEM_LABEL: Record<
  OwnError.LegacyKeyProblem,
  `own.legacyKey.problem.${OwnError.LegacyKeyProblem}`
> = {
  not_found: "own.legacyKey.problem.not_found",
  decrypt_failed: "own.legacyKey.problem.decrypt_failed",
  path_denied: "own.legacyKey.problem.path_denied",
  invalid_key: "own.legacyKey.problem.invalid_key",
  unreadable: "own.legacyKey.problem.unreadable",
  unsupported_provider: "own.legacyKey.problem.unsupported_provider",
  helper_outdated: "own.legacyKey.problem.helper_outdated",
}

/** Rows of the old app's saved keys, each with its own `연결…` action. */
export function LegacyKeyRows(props: {
  readonly list: LegacyKeyList
  readonly problems: Readonly<Record<string, OwnError.LegacyKeyProblem>>
  readonly onLink: (providerRef: string) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useLegacyKeyText()
  const own = data.local().own
  return (
    <section class="mt-4" data-testid="legacy-keys">
      <h3 class="m-0 mb-1 text-[13px] font-semibold">{text("own.legacyKey.title")}</h3>
      <p class="m-0 mb-1 text-[13px] text-own-muted">{text("own.legacyKey.found", { n: props.list.keys.length })}</p>
      <p class="m-0 mb-2 text-[12.5px] text-own-muted" data-testid="legacy-keys-note">
        {text("own.legacyKey.note")}
      </p>
      <ul class="m-0 flex list-none flex-col border-y border-own-border p-0" data-testid="legacy-key-list">
        <For each={props.list.keys}>
          {(key) => {
            const problem = () => props.problems[key.providerRef] ?? key.problem
            const imported = () => key.importedAs?.accountID
            return (
              <li
                class="grid grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1.3fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-own-border px-1 py-2 text-[12.5px] last:border-b-0 max-tablet:grid-cols-[auto_minmax(0,1fr)]"
                data-provider-ref={key.providerRef}
                data-testid="legacy-key-row"
              >
                <Show when={key.kind} fallback={<span class="w-4" aria-hidden="true" />}>
                  {(kind) => <ProviderMark kind={kind()} />}
                </Show>
                <span class="min-w-0 truncate font-semibold">
                  {key.name ?? key.providerRef}
                  <Show when={key.kind && kindLabel(i18n, key.kind) !== key.name && key.kind}>
                    {(kind) => <span class="ml-2 font-normal text-own-muted">{kindLabel(i18n, kind())}</span>}
                  </Show>
                </span>
                <span class="min-w-0 truncate text-own-muted max-tablet:col-start-2">
                  {[key.baseURL, key.models[0]].filter(Boolean).join(" · ") || "—"}
                </span>
                <span
                  class="flex items-center justify-end gap-2 max-tablet:col-start-2 max-tablet:justify-start"
                  data-testid="legacy-key-state"
                >
                  <Switch
                    fallback={
                      <>
                        <span class="text-own-ok">{text("own.legacyKey.linkable")}</span>
                        <Show when={own.rpc.allowed("accounts.import.keys.plan")}>
                          <button
                            type="button"
                            class="own-btn"
                            data-size="sm"
                            onClick={() => props.onLink(key.providerRef)}
                            data-testid="legacy-key-link"
                          >
                            {text("own.legacyKey.link")}
                          </button>
                        </Show>
                      </>
                    }
                  >
                    <Match when={imported()}>
                      {(accountID) => (
                        <span class="text-own-muted">
                          {text("own.legacyKey.imported", {
                            account: own.state.accounts[accountID()]?.label ?? accountID(),
                          })}
                        </span>
                      )}
                    </Match>
                    <Match when={problem()}>
                      {(value) => <span class="text-own-warn">{text(LEGACY_PROBLEM_LABEL[value()])}</span>}
                    </Match>
                  </Switch>
                </span>
              </li>
            )
          }}
        </For>
      </ul>
    </section>
  )
}

const WARNING_LABEL = {
  linked_key_depends_on_source: "own.legacyKey.warn.linked_key_depends_on_source",
  model_not_in_template: "own.legacyKey.warn.model_not_in_template",
} as const

/** One key's confirmation: plan → card → execute; `nonce_invalid` plans again, file problems go back to the list. */
export function LegacyKeyConfirm(props: {
  readonly providerRef: string
  readonly onDone: (result: { readonly label: string; readonly keyHint: string }) => void
  readonly onProblem: (problem: OwnError.LegacyKeyProblem | undefined) => void
  readonly onCancel: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const text = useLegacyKeyText()
  const own = data.local().own
  const [plan, setPlan] = createSignal<Plan>()
  const [label, setLabel] = createSignal("")
  const [color, setColor] = createSignal<Account.Color>(
    nextColor(own.state.accountOrder.map((id) => own.state.accounts[id]?.color)),
  )
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()

  const fail = (error: unknown) => {
    const type = errorType(error)
    if (type === "legacy_key_invalid")
      return props.onProblem(errorData<{ reason: OwnError.LegacyKeyProblem }>(error).reason)
    if (type === "legacy_key_not_found") return props.onProblem("not_found")
    status.error(errorMessage(i18n, error, (id) => own.state.accounts[id]?.label))
  }
  const load = async () => {
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.import.keys.plan", { providerRef: props.providerRef as Plan["providerRef"] })
      .then((result) => {
        setPlan(result)
        if (!label()) setLabel(result.label)
      })
      .catch((error: unknown) => fail(error))
    setBusy(false)
  }
  void load()

  const duplicate = () => {
    const id = plan()?.duplicateOf
    return id ? (own.state.accounts[id]?.label ?? id) : undefined
  }
  const execute = async () => {
    const current = plan()
    if (!current || busy() || duplicate()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.import.keys.execute", {
        nonce: current.nonce,
        label: label().trim() || current.label,
        color: color(),
      })
      .then((result) => props.onDone({ label: result.account?.label ?? current.label, keyHint: result.keyHint }))
      .catch(async (error: unknown) => {
        if (errorType(error) === "nonce_invalid") {
          status.info(i18n.t("own.acct.err.nonce"))
          await load()
          return
        }
        fail(error)
      })
    setBusy(false)
  }

  return (
    <div class="flex flex-col gap-3" data-testid="legacy-key-confirm" data-provider-ref={props.providerRef}>
      <Show when={plan()} fallback={<p class="own-placeholder p-0">{i18n.t("own.shell.loading")}</p>}>
        {(current) => (
          <>
            <p class="m-0 flex items-center gap-2 text-[14px] font-semibold" data-testid="legacy-key-title">
              <ProviderMark kind={current().kind} />
              <span>
                {[
                  ...new Set([current().name ?? kindLabel(i18n, current().kind), kindLabel(i18n, current().kind)]),
                  text("own.legacyKey.keyHint", { hint: current().keyHint }),
                ].join(" · ")}
              </span>
            </p>
            <Show when={current().model}>
              {(model) => (
                <p class="m-0 text-[12.5px] text-own-muted">{text("own.legacyKey.model", { model: model() })}</p>
              )}
            </Show>
            <Show when={duplicate()}>
              {(account) => (
                <Notice tone="warn" testid="legacy-key-duplicate">
                  {text("own.legacyKey.duplicate", { account: account() })}
                </Notice>
              )}
            </Show>
            <For each={current().warnings}>
              {(warning) => (
                <Notice tone={warning === "model_not_in_template" ? "warn" : "info"}>
                  {text(WARNING_LABEL[warning])}
                </Notice>
              )}
            </For>
            <Show when={!duplicate()}>
              <TextField
                label={i18n.t("own.acct.name")}
                value={label()}
                onValue={setLabel}
                onEnter={() => void execute()}
                testid="legacy-key-label"
              />
              <div class="own-field">
                <span class="own-field-label">{i18n.t("own.acct.color")}</span>
                <ColorPicker value={color()} colors={COLORS} onChange={setColor} />
              </div>
            </Show>
          </>
        )}
      </Show>
      <StatusLine status={status} />
      <div class="mt-1 flex justify-end gap-2">
        <button type="button" class="own-btn" onClick={() => props.onCancel()}>
          {i18n.t("own.kit.cancel")}
        </button>
        <button
          type="button"
          class="own-btn"
          data-variant="primary"
          disabled={!plan() || busy() || !!duplicate()}
          onClick={() => void execute()}
          data-testid="legacy-key-execute"
        >
          <Show when={busy()}>
            <Spinner />
          </Show>
          {text("own.legacyKey.connect")}
        </button>
      </div>
    </div>
  )
}
