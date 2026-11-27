// Import ChatGPT logins from the old app codex-multi-provider (03 §5.4.2, D7). List (`accounts.import.codex.list`),
// one mode for all rows (linked by default, takeover on request), then per row plan → confirm (warnings, duplicate
// account, name, color, mode can change) → execute. Token values and file paths never reach the UI; the router only
// reports profile ids, aliases, masked identities and problems. Below the profiles, the API keys the old app saved
// (`accounts.import.keys.*`, 02 §3.2b, linking only: legacy-key-import.tsx). Also the stale-source banner
// (CodexStaleBanner).
import type { Account, Credential, OwnError } from "@own/protocol"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { useData, type ServerKey } from "@/data"
import type { OwnOutput } from "@/data/rpc"
import { useI18n } from "@/i18n"
import { useCodexImportText } from "./codex-import-strings"
import { ago } from "@/limits/format"
import { openSwitcher } from "@/limits/intents"
import { ColorPicker, Dialog, Notice, Spinner, TextField, createStatus, StatusLine } from "@/limits/kit"
import { errorData, errorMessage, errorType } from "./errors"
import { LegacyKeyConfirm, LegacyKeyRows, type LegacyKeyList } from "./legacy-key-import"
import { legacyKeyText } from "./legacy-key-strings"
import { COLORS, planLabel } from "./model"

type Candidate = OwnOutput<"accounts.import.codex.list">["sources"][number]
type Plan = OwnOutput<"accounts.import.codex.plan">
type Mode = Credential.CodexImportMode

export interface CodexTarget {
  /** Re-link or take over this account instead of detecting it by fingerprint (5.4.2 `⋯` actions). */
  readonly accountID: string
  /** Go straight to the confirmation of this profile (`이 앱으로 인수…`). */
  readonly profileID?: string
  readonly mode?: Mode
}

const PROBLEM_LABEL: Record<OwnError.SourceProblem, `own.codex.problem.${OwnError.SourceProblem}`> = {
  unreadable: "own.codex.problem.unreadable",
  parse_failed: "own.codex.problem.parse_failed",
  not_chatgpt: "own.codex.problem.not_chatgpt",
  missing_tokens: "own.codex.problem.missing_tokens",
  token_expired: "own.codex.problem.token_expired",
  account_mismatch: "own.codex.problem.account_mismatch",
}

export function CodexImportDialog(props: {
  readonly open: boolean
  readonly target?: CodexTarget
  readonly onClose: () => void
}) {
  const i18n = useI18n()
  return (
    <Dialog
      open={props.open}
      title={i18n.t("own.codex.importTitle")}
      onClose={props.onClose}
      size="wide"
      testid="codex-import-dialog"
    >
      <CodexImportFlow target={props.target} onClose={props.onClose} />
    </Dialog>
  )
}

/** The flow without its dialog frame (the add-account dialog embeds it). */
export function CodexImportFlow(props: { readonly target?: CodexTarget; readonly onClose: () => void }) {
  const data = useData()
  const i18n = useI18n()
  const codex = useCodexImportText()
  const own = data.local().own
  const [list, setList] = createSignal<OwnOutput<"accounts.import.codex.list">>()
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [mode, setMode] = createSignal<Mode>(props.target?.mode ?? "linked")
  const [queue, setQueue] = createSignal<readonly string[]>([])
  const [done, setDone] = createSignal<readonly { label: string; mode: Mode }[]>([])
  const [problems, setProblems] = createSignal<Readonly<Record<string, OwnError.SourceProblem>>>({})
  const [keys, setKeys] = createSignal<LegacyKeyList>()
  const [keyTarget, setKeyTarget] = createSignal<string>()
  const [keysDone, setKeysDone] = createSignal<readonly { label: string; keyHint: string }[]>([])
  const [keyProblems, setKeyProblems] = createSignal<Readonly<Record<string, OwnError.LegacyKeyProblem>>>({})
  const [loading, setLoading] = createSignal(false)
  const status = createStatus()

  const load = async () => {
    setLoading(true)
    status.clear()
    await Promise.all([
      own.rpc
        .call("accounts.import.codex.list", {})
        .then((next) => void setList(next))
        .catch((error: unknown) => status.error(errorMessage(i18n, error))),
      // Saved API keys (02 §3.2b). A router without the method simply has none to show.
      own.rpc.allowed("accounts.import.keys.list")
        ? own.rpc
            .call("accounts.import.keys.list", {})
            .then((next) => void setKeys(next))
            .catch(() => void setKeys(undefined))
        : Promise.resolve(),
    ])
    setLoading(false)
  }
  const hasKeys = () => !!keys()?.available && (keys()?.keys.length ?? 0) > 0
  if (props.target?.profileID) setQueue([props.target.profileID])
  else void load()

  const candidate = (profileID: string) => list()?.sources.find((source) => source.profileID === profileID)
  const toggle = (profileID: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(profileID)) next.delete(profileID)
      else next.add(profileID)
      return next
    })
  const next = () => {
    const rows =
      list()
        ?.sources.filter((source) => selected().has(source.profileID))
        .map((source) => source.profileID) ?? []
    setDone([])
    setQueue(rows)
  }
  const finishRow = (result?: { label: string; mode: Mode }) => {
    if (result) setDone((current) => [...current, result])
    setQueue((current) => current.slice(1))
  }
  const backToList = (profileID: string, problem: OwnError.SourceProblem | undefined) => {
    if (problem) setProblems((current) => ({ ...current, [profileID]: problem }))
    setQueue([])
    void load()
  }
  const keyBack = (providerRef: string, problem: OwnError.LegacyKeyProblem | undefined) => {
    if (problem) setKeyProblems((current) => ({ ...current, [providerRef]: problem }))
    setKeyTarget(undefined)
    void load()
  }

  return (
    <div data-testid="codex-import">
      <Switch>
        <Match when={queue()[0]}>
          {(profileID) => (
            <ImportConfirm
              profileID={profileID()}
              candidate={candidate(profileID())}
              mode={mode()}
              accountID={props.target?.accountID ?? candidate(profileID())?.importedAs?.accountID}
              remaining={queue().length}
              onDone={finishRow}
              onSkip={() => finishRow()}
              onProblem={(problem) => backToList(profileID(), problem)}
              onCancel={props.onClose}
            />
          )}
        </Match>
        <Match when={keyTarget()}>
          {(providerRef) => (
            <LegacyKeyConfirm
              providerRef={providerRef()}
              onDone={(result) => {
                setKeysDone((current) => [...current, result])
                setKeyTarget(undefined)
              }}
              onProblem={(problem) => keyBack(providerRef(), problem)}
              onCancel={() => setKeyTarget(undefined)}
            />
          )}
        </Match>
        <Match when={done().length || keysDone().length}>
          <div class="flex flex-col gap-2" data-testid="codex-done">
            <For each={done()}>
              {(item) => (
                <Notice tone="ok">
                  {codex("own.acct.codexDone", {
                    label: item.label,
                    mode: i18n.t(item.mode === "linked" ? "own.codex.linked" : "own.codex.takeover"),
                  })}
                </Notice>
              )}
            </For>
            <For each={keysDone()}>
              {(item) => (
                <Notice tone="ok" testid="legacy-key-done">
                  {legacyKeyText.text(i18n.locale(), "own.legacyKey.done", { label: item.label, hint: item.keyHint })}
                </Notice>
              )}
            </For>
            <div class="mt-3 flex justify-end">
              <button type="button" class="own-btn" data-variant="primary" onClick={() => props.onClose()}>
                {i18n.t("own.kit.close")}
              </button>
            </div>
          </div>
        </Match>
        <Match when={true}>
          <div class="mb-2 flex items-center gap-2">
            <p class="m-0 flex-1 text-[13px] text-own-muted">
              <Show
                when={list()?.available}
                fallback={loading() ? i18n.t("own.shell.loading") : hasKeys() ? "" : codex("own.acct.codexUnavailable")}
              >
                {codex("own.codex.found", { n: list()?.sources.length ?? 0 })}
              </Show>
            </p>
            <button type="button" class="own-btn" data-size="sm" disabled={loading()} onClick={() => void load()}>
              <Show when={loading()}>
                <Spinner />
              </Show>
              {codex("own.acct.rescan")}
            </button>
          </div>
          <Show when={list()?.available || !hasKeys()}>
            <ul class="m-0 flex list-none flex-col border-y border-own-border p-0" data-testid="codex-list">
              <For each={list()?.sources ?? []}>
                {(source) => {
                  const problem = () => problems()[source.profileID] ?? source.problem
                  return (
                    <li class="border-b border-own-border last:border-b-0" data-profile={source.profileID}>
                      <label class="grid grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1.3fr)_auto] items-center gap-x-3 gap-y-0.5 px-1 py-2 text-[12.5px] max-tablet:grid-cols-[auto_minmax(0,1fr)]">
                        <input
                          type="checkbox"
                          disabled={!source.importable}
                          checked={selected().has(source.profileID)}
                          onChange={() => toggle(source.profileID)}
                          data-testid="codex-row-check"
                        />
                        <span class="min-w-0 truncate font-semibold">
                          {source.alias ?? `${source.profileID} ${codex("own.codex.noAlias")}`}
                        </span>
                        <span class="min-w-0 truncate text-own-muted max-tablet:col-start-2">
                          {identity(source.identity) || "—"}
                          <Show when={source.lastRefresh}>
                            {(at) => (
                              <span class="ml-2 text-own-faint">
                                {codex("own.acct.codexRefreshed", { ago: ago(i18n, Date.now(), Date.parse(at())) })}
                              </span>
                            )}
                          </Show>
                        </span>
                        <span
                          class="text-right max-tablet:col-start-2 max-tablet:text-left"
                          data-testid="codex-row-state"
                        >
                          <Switch fallback={<span class="text-own-ok">{codex("own.acct.codexImportable")}</span>}>
                            <Match when={source.importedAs}>
                              {(imported) => (
                                <span class="text-own-muted">
                                  {codex("own.codex.imported", {
                                    mode: i18n.t(
                                      imported().mode === "linked" ? "own.codex.linked" : "own.codex.takeover",
                                    ),
                                    account: own.state.accounts[imported().accountID]?.label ?? imported().accountID,
                                  })}
                                </span>
                              )}
                            </Match>
                            <Match when={problem()}>
                              {(value) => <span class="text-own-warn">{codex(PROBLEM_LABEL[value()])}</span>}
                            </Match>
                          </Switch>
                        </span>
                      </label>
                    </li>
                  )
                }}
              </For>
            </ul>
            <ModeChoice mode={mode()} onChange={setMode} />
          </Show>
          <Show when={hasKeys() && keys()}>
            {(current) => <LegacyKeyRows list={current()} problems={keyProblems()} onLink={setKeyTarget} />}
          </Show>
          <StatusLine status={status} />
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="own-btn" onClick={() => props.onClose()}>
              {i18n.t("own.kit.cancel")}
            </button>
            <Show when={list()?.available || !hasKeys()}>
              <button
                type="button"
                class="own-btn"
                data-variant="primary"
                disabled={selected().size === 0}
                onClick={next}
                data-testid="codex-next"
              >
                {codex("own.acct.nextArrow")}
              </button>
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

function identity(value: Candidate["identity"]) {
  return [value?.emailMasked, value?.plan ? planLabel(value.plan) : undefined].filter(Boolean).join(" · ")
}

function ModeChoice(props: { readonly mode: Mode; readonly onChange: (mode: Mode) => void }) {
  const i18n = useI18n()
  const codex = useCodexImportText()
  return (
    <fieldset class="m-0 mt-3 flex flex-col gap-1.5 border-0 p-0 text-[13px]">
      <legend class="mb-1 font-semibold">{codex("own.acct.codexMode")}</legend>
      <label class="flex items-start gap-2">
        <input
          type="radio"
          class="mt-1"
          name="codex-mode"
          checked={props.mode === "linked"}
          onChange={() => props.onChange("linked")}
        />
        <span>
          <b class="font-semibold">{codex("own.acct.codexLinkedRecommended")}</b> — {codex("own.codex.linkedDesc")}
        </span>
      </label>
      <label class="flex items-start gap-2">
        <input
          type="radio"
          class="mt-1"
          name="codex-mode"
          checked={props.mode === "takeover"}
          onChange={() => props.onChange("takeover")}
          data-testid="codex-mode-takeover"
        />
        <span>
          <b class="font-semibold">{i18n.t("own.codex.takeover")}</b> — {codex("own.codex.takeoverDesc")}
        </span>
      </label>
    </fieldset>
  )
}

const WARNING_LABEL = {
  linked_depends_on_source: "own.codex.warn.linked_depends_on_source",
  takeover_supersedes_source: "own.codex.warn.takeover_supersedes_source",
  source_token_expired: "own.codex.warn.source_token_expired",
} as const

/** One row's confirmation (5.4.2 "확인 단계"): plan → card → execute; `nonce_invalid` plans again. */
function ImportConfirm(props: {
  readonly profileID: string
  readonly candidate: Candidate | undefined
  readonly mode: Mode
  readonly accountID: string | undefined
  readonly remaining: number
  readonly onDone: (result: { label: string; mode: Mode }) => void
  readonly onSkip: () => void
  readonly onProblem: (problem: OwnError.SourceProblem | undefined) => void
  readonly onCancel: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const codex = useCodexImportText()
  const own = data.local().own
  const [mode, setMode] = createSignal<Mode>(props.mode)
  const [plan, setPlan] = createSignal<Plan>()
  const [label, setLabel] = createSignal("")
  const [color, setColor] = createSignal<Account.Color>("violet")
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()

  const load = async (next: Mode) => {
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.import.codex.plan", {
        profileID: props.profileID,
        mode: next,
        ...(props.accountID ? { accountID: props.accountID } : {}),
      })
      .then((result) => {
        setPlan(result)
        if (!label()) setLabel(result.alias ?? result.profileID)
      })
      .catch((error: unknown) => fail(error))
    setBusy(false)
  }
  const fail = (error: unknown) => {
    const type = errorType(error)
    if (type === "source_invalid") return props.onProblem(errorData<{ reason: OwnError.SourceProblem }>(error).reason)
    if (type === "source_not_found") return props.onProblem(undefined)
    status.error(errorMessage(i18n, error))
  }
  void load(mode())

  const execute = async () => {
    const current = plan()
    if (!current || busy()) return
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.import.codex.execute", {
        nonce: current.nonce,
        label: label().trim() || current.alias || current.profileID,
        color: color(),
      })
      .then((result) => props.onDone({ label: result.account.label, mode: result.mode }))
      .catch(async (error: unknown) => {
        if (errorType(error) === "nonce_invalid") {
          status.info(i18n.t("own.acct.err.nonce"))
          await load(mode())
          return
        }
        fail(error)
      })
    setBusy(false)
  }

  const duplicate = () => {
    const id = plan()?.duplicateOf
    return id ? (own.state.accounts[id]?.label ?? id) : undefined
  }
  return (
    <div class="flex flex-col gap-3" data-testid="codex-confirm" data-profile={props.profileID}>
      <Show when={props.remaining > 1}>
        <p class="m-0 text-[12px] text-own-faint">{codex("own.acct.codexRemaining", { n: props.remaining })}</p>
      </Show>
      <Show when={plan()} fallback={<p class="own-placeholder p-0">{i18n.t("own.shell.loading")}</p>}>
        {(current) => (
          <>
            <p class="m-0 text-[14px] font-semibold" data-testid="codex-confirm-title">
              {[current().alias ?? current().profileID, identity(current().identity)].filter(Boolean).join(" · ")}
            </p>
            <ModeChoice
              mode={mode()}
              onChange={(next) => {
                setMode(next)
                void load(next)
              }}
            />
            <Show when={duplicate()}>
              {(account) => (
                <Notice tone="info">
                  {codex("own.codex.duplicate", {
                    account: account(),
                    mode: i18n.t(mode() === "linked" ? "own.codex.linked" : "own.codex.takeover"),
                  })}
                </Notice>
              )}
            </Show>
            <For each={current().warnings}>
              {(warning) => (
                <Notice
                  tone={
                    warning === "source_token_expired" || warning === "takeover_supersedes_source" ? "warn" : "info"
                  }
                >
                  {codex(WARNING_LABEL[warning])}
                </Notice>
              )}
            </For>
            <Show when={!duplicate() && !props.accountID}>
              <TextField
                label={i18n.t("own.acct.name")}
                value={label()}
                onValue={setLabel}
                onEnter={() => void execute()}
                testid="codex-label"
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
        <Show when={props.remaining > 1}>
          <button type="button" class="own-btn" onClick={() => props.onSkip()}>
            {codex("own.acct.skip")}
          </button>
        </Show>
        <button
          type="button"
          class="own-btn"
          data-variant="primary"
          disabled={!plan() || busy()}
          onClick={() => void execute()}
          data-testid="codex-execute"
        >
          <Show when={busy()}>
            <Spinner />
          </Show>
          {codex(mode() === "linked" ? "own.acct.codexLink" : "own.acct.codexTakeover")}
        </button>
      </div>
    </div>
  )
}

/**
 * 5.4.2 stale banner for a session running on a linked account whose source has not been refreshed (session banners
 * belong to the transcript; this is the shared component). `다시 확인` is `accounts.test`, which re-reads the source.
 */
export function CodexStaleBanner(props: {
  readonly account: Account.View
  readonly serverKey?: ServerKey
  readonly sessionID?: string
  readonly onTakeover: () => void
}) {
  const data = useData()
  const i18n = useI18n()
  const codex = useCodexImportText()
  const own = data.local().own
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const recheck = async () => {
    setBusy(true)
    status.clear()
    await own.rpc
      .call("accounts.test", { accountID: props.account.id })
      .then((result) =>
        result.ok ? status.ok(codex("own.acct.recheckOk")) : status.error(codex("own.acct.recheckStill")),
      )
      .catch((error: unknown) => status.error(errorMessage(i18n, error)))
    setBusy(false)
  }
  const alias = () =>
    props.account.connection.source?.alias ?? props.account.connection.source?.profileID ?? props.account.label
  return (
    <div class="own-notice" data-tone="warn" role="alert" data-testid="codex-stale-banner">
      <span class="font-extrabold" aria-hidden="true">
        !
      </span>
      <div class="min-w-0 flex-1">
        <p class="m-0 font-semibold">{i18n.t("own.codex.stale", { alias: alias() })}</p>
        <p class="m-0 mt-0.5 text-own-muted">{codex("own.codex.staleHelp")}</p>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <Show when={own.rpc.allowed("accounts.test")}>
            <button type="button" class="own-btn" data-size="sm" disabled={busy()} onClick={() => void recheck()}>
              {codex("own.codex.recheck")}
            </button>
          </Show>
          <Show when={own.rpc.allowed("accounts.import.codex.plan")}>
            <button type="button" class="own-btn" data-size="sm" onClick={() => props.onTakeover()}>
              {i18n.t("own.codex.takeoverAction")}
            </button>
          </Show>
          <Show when={props.serverKey && props.sessionID}>
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              onClick={() => openSwitcher({ serverKey: props.serverKey!, sessionID: props.sessionID! })}
            >
              {i18n.t("own.action.switchOther")}
            </button>
          </Show>
        </div>
        <StatusLine status={status} />
      </div>
    </div>
  )
}
