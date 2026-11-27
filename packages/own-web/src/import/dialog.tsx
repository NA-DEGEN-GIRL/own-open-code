// 이어서 하기 (I2: 09 §4.5–4.8, §6 이어서 하기 대화상자), a lazy chunk that `ImportLayer` shows for the list row's and
// the viewer's `이어서 하기` and the viewer's `여기까지 이어서 하기`. Also the details behind an imported conversation's
// header badge (`OriginDetails`, 09 §4.7), loaded only when the badge is pressed (03 §20.2 R5).
//
// The dialog plans with `migrate.plan` and runs the plan's nonce with `migrate.execute`; it never chooses for the user
// (07 R4, U1, U5): the target starts as an account of the source tool's company (`원래와 같은 회사`) or the folder's
// new-session default, `추천` is a badge, and on a usage shortage the `추천` accounts are offered by headroom for the
// user to pick. A team folder lists the accounts its new conversations may use (`outsideTeam`, 07 §5.4). Every change
// of the target, the mode, the location or `자세히` plans again after 300 ms. Each mode row shows its costs (summary,
// first request, each later request from the cache) or why it cannot be chosen; the send notice and `다른 회사` show for
// every mode above the button (IG10). An imported source asks `열기` / `새로 가져오기` first.
//
// The job (`원본 읽는 중` → `요약 중` → `대화 만드는 중`) is followed per server here, outside the dialog: closing the
// dialog leaves a toast, its end is announced while nobody looks, and a reopened dialog (or one after a reload, from
// `jobs.list`) shows it again. Success opens the new session with the composer focused; a failure shows the cause and
// the alternatives (LLM 없이, 그대로 when it fits, another target), and nothing is retried by itself.
import type { Account } from "@own/protocol"
import { Preset } from "@own/protocol/preset"
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { importEvent, LOCAL, OwnRpcError, useData, type ImportOrigin, type ServerKey, type ServerRuntime } from "@/data"
import { useI18n, type I18n, type Locale } from "@/i18n"
import { limitText } from "@/limits/display"
import { Dialog, Notice, Spinner, Tag } from "@/limits/kit"
import { baseName, samePath } from "@/projects/path"
import { useRouter } from "@/routing/router"
import type { Route } from "@/routing/routes"
import { minuteNow } from "@/shell/clock"
import type { TargetRef } from "@/switcher"
import { quotaText } from "@/switcher/describe"
import { formatRange, formatTokens } from "@/switcher/format"
import { ensureCatalog, kindName, modelName, providerModels, variantName } from "@/switcher/labels"
import { newSessionTarget } from "@/switcher/new-session"
import {
  groupAccounts,
  keepVariant,
  modelForAccount,
  recommendedAccounts,
  rowModel,
  teamAccounts,
  unusable,
  type Picked,
  type PickerModel,
} from "@/switcher/picker"
import { companyName } from "@/switcher/team-flow"
import { showToast } from "@/switcher/toast"
import { openImport, requestMigrate, type MigrateTarget } from "./index"
import {
  alternatives,
  choiceOf,
  createPlanner,
  defaultTarget,
  errorText,
  headroomRanked,
  jobErrorKey,
  jobEvent,
  jobSteps,
  modeRows,
  planInput,
  quotaShort,
  restoreJob,
  sameSource,
  selectedRow,
  sendNotice,
  summarizes,
  summarySource,
  summaryState,
  targetAccount,
  TOOL_COMPANY,
  TOOL_NAME,
  type JobStep,
  type JobView,
  type MigrateInputs,
  type ModeChoice,
  type ModeOption,
  type Plan,
  type PlanWarning,
} from "./model"
import { importGates, importStore } from "./store"
import { importText, useImportText, type ImportKey } from "./strings"

/** Warnings shown as notes; the rest have their own place (the tag, the summarizer line, `자세히`, the location). */
const WARNING: { readonly [W in PlanWarning]: ImportKey | undefined } = {
  source_live: "own.otherTools.migrate.warn.source_live",
  source_folder_missing: "own.otherTools.migrate.warn.source_folder_missing",
  z_unknown: "own.otherTools.migrate.warn.z_unknown",
  compaction_may_truncate: "own.otherTools.migrate.warn.compaction_may_truncate",
  images_dropped: "own.otherTools.migrate.warn.images_dropped",
  unknown_records: "own.otherTools.migrate.warn.unknown_records",
  history_base_partial: "own.otherTools.migrate.warn.history_base_partial",
  quota_insufficient: "own.otherTools.migrate.warn.quota_insufficient",
  cross_company: undefined,
  summarizer_overridden: undefined,
  import_too_large: undefined,
  location_differs: undefined,
}

/** `추천` alternatives shown at once on a usage shortage. */
const HEADROOM_SHOWN = 3

export default function MigrateDialog(props: { readonly target: MigrateTarget; readonly onClose: () => void }) {
  const data = useData()
  return (
    <Show when={data.get(props.target.serverKey)} keyed>
      {(runtime) => <Migrate runtime={runtime} request={props.target} onClose={props.onClose} />}
    </Show>
  )
}

function Migrate(props: {
  readonly runtime: ServerRuntime
  readonly request: MigrateTarget
  readonly onClose: () => void
}) {
  const i18n = useI18n()
  const text = useImportText()
  const router = useRouter()
  const runtime = props.runtime
  const own = runtime.own
  const request = props.request
  const tool = TOOL_NAME[request.ref.kind]
  const store = importStore(runtime)
  void store.ensure()
  const jobs = jobTracker(runtime)
  jobs.bind({ locale: i18n.locale, navigate: (route) => router.navigate(route) })
  onCleanup(jobs.watch(request.ref))
  let disposed = false
  onCleanup(() => (disposed = true))
  let accountSelect: HTMLSelectElement | undefined

  // ---- inputs (each change plans again)
  const [target, setTarget] = createSignal<TargetRef>()
  /** The account picked (`targetAccount`): several Claude accounts share `anthropic` (02 §8.7). */
  const [picking, setPicking] = createSignal<string>()
  /**
   * The user's explicit model and effort (the start, the model and effort selects): what each account would run where it
   * offers it (`runs`); picking an account never changes it (the switcher's `Picked`).
   */
  const [picked, setPicked] = createSignal<Picked>()
  const pickedOf = (ref: TargetRef): Picked => ({
    id: ref.id,
    name: modelName(runtime, ref, request.directory),
    variant: ref.variant,
  })
  const [choice, setChoice] = createSignal<ModeChoice>()
  const [upTo, setUpTo] = createSignal(request.upToTurn)
  const [location, setLocation] = createSignal(request.location)
  const [storeFull, setStoreFull] = createSignal(true)
  const [redact, setRedact] = createSignal(true)
  // This PC's windows plan any conversation the index knows and may keep secrets; a device only its project's, with
  // secrets hidden (09 §5.5: the gateway refuses `scope: "all"` and `redact: false`).
  const wide = runtime.imports.allowed("migrate.plan", { scope: "all" })
  const keepable = runtime.imports.allowed("migrate.plan", { redact: false })

  const [state, setState] = createStore<{
    plan?: Plan
    planning: boolean
    /** The plan does not match the inputs yet (a re-plan is due or running): nothing can run. */
    stale: boolean
    error?: string
    /**
     * `가져오기` stopped before it ran: the picked Claude account could not become the one chosen last (02 §8.7). Not a
     * plan error (the plan stands and planning again changes nothing): the fix is that account, or another one.
     */
    refused: boolean
    /** A line about what happened (`다시 계획했습니다`, `취소할 수 없습니다`). */
    note?: string
    /** `새로 가져오기` answered the `이미 가져옴` question. */
    again: boolean
    executing: boolean
    cancelling: boolean
    /** The conversation's turns (`여기까지` range): the caller's, else the first plan of all turns. */
    total?: number
  }>({
    planning: false,
    stale: true,
    refused: false,
    again: false,
    executing: false,
    cancelling: false,
    total: request.turns,
  })
  const plan = () => state.plan

  // ---- target (09 §4.5): picker data of the switcher (03 §5.2)
  const folder = () => plan()?.location.directory ?? location() ?? request.directory
  ensureCatalog(runtime, request.directory, true)
  createEffect(() => {
    if (runtime.key === LOCAL) untrack(() => runtime.team.ensure())
  })
  // A team folder's new conversations list what the team's R4 allows (07 §5.4): the team main's binding names them.
  const teamMain = createMemo(() => runtime.team.teamOfDirectory(folder())?.team.main.sessionID)
  createEffect(() => {
    const main = teamMain()
    if (main) onCleanup(own.watchPreset(main))
  })
  const lookup: Preset.Lookup = (accountID) => own.state.accounts[accountID]
  const listed = createMemo(() => {
    const all = own.state.accountOrder.flatMap((id) => {
      const account = own.state.accounts[id]
      return account && account.status !== "disabled" && account.status !== "retired" ? [account] : []
    })
    const main = teamMain()
    const team = main ? own.state.sessionPreset[main]?.binding?.team : undefined
    return team ? teamAccounts(all, team, lookup) : { shown: all, hidden: [] }
  })
  const models = (providerID: string): PickerModel[] =>
    providerModels(runtime, providerID, request.directory).map((model) => ({
      id: model.id,
      name: model.name,
      variants: model.variants.map((variant) => variant.id),
    }))
  const groupModel = (account: Account.View): TargetRef | undefined => {
    const pick = modelForAccount(undefined, models(account.providerID), own.state.groupDefaults[account.kind])
    return pick && { providerID: account.providerID, id: pick.model.id, variant: pick.variant }
  }
  // The start: once the accounts and the group defaults are known (or own.accounts is not there).
  createEffect(() => {
    if (target()) return
    const status = own.state.status
    if (status === "idle" || status === "loading" || (status === "ready" && !own.state.defaultsLoaded)) return
    const index = runtime.sessions.state
    const recent = index.order.flatMap((id) => {
      const row = index.sessions[id]
      return row?.model && samePath(row.directory, request.directory) ? [row.model.providerID] : []
    })
    const start = defaultTarget({
      kind: request.ref.kind,
      accounts: listed().shown,
      recent,
      modelOf: groupModel,
      folder: newSessionTarget(runtime, request.serverKey, request.directory),
    })
    if (!start.target) return
    setTarget(start.target)
    setPicking(start.account?.id)
    setPicked(pickedOf(start.target))
  })
  const account = () => targetAccount(own.state.accounts[picking() ?? ""], target(), own.accountFor)
  const groups = createMemo(() => groupAccounts(listed().shown))
  /**
   * The model an account would run here: what picking it chooses (`selectAccount`, the picked model where the account
   * offers it, else its group default), as a switcher row's (`rowModel`). Which account is picked does not change it.
   */
  const runs = (item: Account.View) => rowModel(picked(), models(item.providerID), own.state.groupDefaults[item.kind])
  // 추천 (every provider group's, as the switcher's) and the headroom alternatives rank each account with the model it
  // would run, on the minute clock.
  const recommended = createMemo(() => recommendedAccounts(listed().shown, own.state.quota, minuteNow(), runs))
  const sameCompany = () => {
    const current = account()
    return !!current && TOOL_COMPANY[request.ref.kind] === Preset.company(current)
  }
  const modelList = () => {
    const current = target()
    return current ? models(current.providerID) : []
  }
  const variants = () => modelList().find((model) => model.id === target()?.id)?.variants ?? []

  function selectAccount(accountID: string) {
    const next = own.state.accounts[accountID]
    if (!next) return
    setState({ refused: false })
    const pick = modelForAccount(picked(), models(next.providerID), own.state.groupDefaults[next.kind])
    if (!pick) return
    setPicking(next.id)
    setTarget({ providerID: next.providerID, id: pick.model.id, variant: pick.variant })
  }
  function selectModel(modelID: string) {
    const current = target()
    const model = modelList().find((item) => item.id === modelID)
    if (!current || !model) return
    const next = { providerID: current.providerID, id: model.id, variant: keepVariant(current.variant, model) }
    setTarget(next)
    setPicked(pickedOf(next))
  }
  function selectVariant(variant: string) {
    const current = target()
    if (!current) return
    const next = { ...current, variant: variant || undefined }
    setTarget(next)
    setPicked(pickedOf(next))
  }

  // ---- planning (09 §6: 300 ms after the last change; the first plan at once)
  const inputs = createMemo<MigrateInputs | undefined>(
    () => {
      const current = target()
      if (!current) return undefined
      // The picked account plans too: Claude 1 → Claude 2 keeps the target, so without it nothing would plan again.
      const picked = account()
      return {
        ref: request.ref,
        directory: request.directory,
        ...(wide ? { scope: "all" as const } : {}),
        target: current,
        ...(picked ? { accountID: picked.id } : {}),
        choice: choice(),
        upToTurn: upTo(),
        location: location(),
        storeFull: storeFull(),
        redact: keepable ? redact() : true,
      }
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  )
  const planner = createPlanner({
    ask: (value: MigrateInputs) => runtime.imports.call("migrate.plan", planInput(value)),
    inputs,
    started: () => setState({ planning: true, error: undefined }),
    answered: (answer) => {
      if (!answer.result.ok) return setState({ planning: false, error: errorText(text, answer.result.failure) })
      const output = answer.result.plan
      // An answer for inputs the user has changed since is shown but stays stale: its nonce would import with the old
      // target or mode (IG9).
      setState({ plan: output, planning: false, stale: !answer.current })
      if (answer.value.upToTurn === undefined && state.total === undefined) setState("total", output.turns)
    },
  })
  onCleanup(planner.cancel)
  createEffect(
    on(inputs, (value, previous) => {
      if (!value) return
      setState("stale", true)
      planner.changed(value, previous === undefined)
    }),
  )
  /** The nonce is single use: after a run (or a refusal) the same inputs plan again at once. */
  function replan(note?: ImportKey) {
    const value = inputs()
    if (note) setState("note", text(note))
    if (!value) return
    setState("stale", true)
    planner.again(value)
  }

  const rows = createMemo(() => {
    const current = plan()
    return current ? modeRows(current) : undefined
  })
  const row = createMemo(() => {
    const current = plan()
    return current ? selectedRow(current, choice()) : undefined
  })
  /** On a usage shortage, the `추천` accounts by headroom for the user to pick (09 §4.5). */
  const headroom = createMemo(() => {
    const current = plan()
    return current && quotaShort(current, row())
      ? headroomRanked(listed().shown, account(), own.state.quota, minuteNow(), runs).slice(0, HEADROOM_SHOWN)
      : []
  })

  // ---- the job
  const job = () => {
    const current = jobs.current()
    return current && (sameSource(current.job.ref, request.ref) || !current.job.outcome) ? current.job : undefined
  }
  const running = () => {
    const current = job()
    return !!current && !current.outcome
  }
  onMount(() => void jobs.restore(request, () => plan()?.title))
  createEffect(
    on(
      () => job()?.outcome,
      (outcome) => {
        const current = job()
        if (!current || !outcome) return
        untrack(() => {
          if (outcome === "succeeded" && current.sessionID) return finish(current.sessionID)
          // The nonce was used: plan again so the alternatives (or the same row) can run.
          if (outcome === "cancelled") jobs.clear()
          replan(outcome === "cancelled" ? "own.otherTools.job.cancelled" : undefined)
        })
      },
      { defer: true },
    ),
  )
  function finish(sessionID: string) {
    jobs.clear()
    void known(runtime, sessionID).then(() => {
      router.navigate({ name: "session", serverKey: request.serverKey, sessionID })
      focusComposer()
      if (!disposed) props.onClose()
    })
  }

  const migrateAllowed = () => importGates(store.health(), runtime.imports.allowed).migrate
  const existing = () => plan()?.existing.toSorted((a, b) => b.importedAt - a.importedAt) ?? []
  const asking = () => existing().length > 0 && !state.again && !running()
  const ready = () => {
    const current = row()
    return (
      migrateAllowed() &&
      !!plan() &&
      !state.stale &&
      !state.planning &&
      !planner.pending() &&
      !state.executing &&
      !!current?.available &&
      !asking() &&
      !running()
    )
  }

  async function execute() {
    const current = plan()
    const selected = row()
    if (!current || !selected || !ready()) return
    setState({ executing: true, error: undefined, refused: false, note: undefined })
    jobs.clear()
    // The conversation, and its summary, start on the Claude account chosen last (02 §8.7), as a new conversation from
    // the switcher does: the picked one becomes it first. A refusal imports nothing (it would run on another account).
    const claude = account()
    if (claude?.kind === "claude-sub" && own.rpc.allowed("plugin.claudeAuth.default.set")) {
      const chosen = await own.rpc.call("plugin.claudeAuth.default.set", { accountID: claude.id }).then(
        () => true,
        () => false,
      )
      if (disposed) return
      if (!chosen) return setState({ executing: false, refused: true })
    }
    const output = await runtime.imports
      .call("migrate.execute", { nonce: current.nonce })
      .catch((error: unknown) => ({ failure: error }))
    if (disposed) return
    setState("executing", false)
    if (!("failure" in output))
      return jobs.start({
        job: {
          jobID: output.jobID,
          ref: request.ref,
          step: "reading",
          startedAt: Date.now(),
          summarizes: summarizes(selected),
        },
        title: current.title,
        request,
      })
    const failure = output.failure
    const type = failure instanceof OwnRpcError ? failure.type : undefined
    if (type === "nonce_invalid") return replan("own.otherTools.migrate.expired")
    if (type === "source_changed") return replan("own.otherTools.migrate.replanned")
    if (type === "job_busy") {
      setState("note", text("own.otherTools.migrate.busy"))
      return void jobs.restore(request, () => current.title)
    }
    setState("error", errorText(text, failure))
    replan()
  }

  async function cancel() {
    const current = job()
    if (!current || current.outcome || state.cancelling) return
    setState({ cancelling: true, note: undefined })
    const output = await runtime.imports.call("migrate.cancel", { jobID: current.jobID }).catch(() => undefined)
    if (disposed) return
    setState("cancelling", false)
    if (output && !output.cancelled) setState("note", text("own.otherTools.job.notCancelled"))
  }

  function close() {
    const current = jobs.current()
    if (current && !current.job.outcome) jobs.announceRunning()
    props.onClose()
  }

  function pickAlternative(alternative: "brief" | "full" | "target") {
    jobs.clear()
    setState({ error: undefined, refused: false })
    if (alternative === "brief") return setChoice({ mode: "summary", source: "brief" })
    if (alternative === "full") return setChoice({ mode: "full" })
    accountSelect?.focus()
  }

  /** The Claude refusal's fix: the account on the accounts page (the dialog closes; nothing was imported). */
  function openAccounts() {
    props.onClose()
    router.navigate({ name: "accounts" })
  }

  const importLabel = () =>
    text(summarizes(row()) ? "own.otherTools.migrate.importSummary" : "own.otherTools.migrate.import")

  return (
    <Dialog
      open
      size="wide"
      title={text("own.otherTools.migrate.title", { tool })}
      onClose={close}
      testid="import-migrate"
      footer={
        <Show
          when={!running()}
          fallback={
            <button type="button" class="own-btn" data-testid="import-migrate-close" onClick={close}>
              {text("own.otherTools.migrate.close")}
            </button>
          }
        >
          <button type="button" class="own-btn" data-testid="import-migrate-cancel" onClick={close}>
            {text("own.otherTools.migrate.cancel")}
          </button>
          <Show when={!asking()}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              disabled={!ready()}
              data-testid="import-migrate-run"
              onClick={() => void execute()}
            >
              {importLabel()}
            </button>
          </Show>
        </Show>
      }
    >
      <div class="flex flex-col gap-3" data-testid="import-migrate-body">
        <Show when={plan()}>{(current) => <TitleLine plan={current()} tool={tool} />}</Show>

        <Show when={job()}>
          {(current) => (
            <JobProgress
              job={current()}
              other={!sameSource(current().ref, request.ref)}
              cancelling={state.cancelling}
              onCancel={() => void cancel()}
            />
          )}
        </Show>

        <Show when={job()?.outcome === "failed" && job()}>
          {(failed) => (
            <Notice tone="danger" testid="import-migrate-failed">
              <p class="m-0">{text("own.otherTools.migrate.failed", { reason: text(jobErrorKey(failed().error)) })}</p>
              <Show when={failed().error?.type === "summary_failed"}>
                <div class="mt-1.5 flex flex-wrap gap-1.5">
                  <For each={alternatives(rows())}>
                    {(alternative) => (
                      <button
                        type="button"
                        class="own-btn"
                        data-size="sm"
                        data-testid={`import-migrate-alt-${alternative}`}
                        onClick={() => pickAlternative(alternative)}
                      >
                        {text(ALTERNATIVE[alternative])}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </Notice>
          )}
        </Show>

        <Show when={asking()}>
          <ExistingQuestion
            existing={existing()}
            onOpen={(sessionID) => {
              router.navigate({ name: "session", serverKey: request.serverKey, sessionID })
              props.onClose()
            }}
            onAgain={() => setState("again", true)}
          />
        </Show>

        <Show when={!asking() && !running()}>
          {/* 이어 갈 모델 (09 §4.5) */}
          <section class="flex flex-col gap-1" aria-label={text("own.otherTools.migrate.target")}>
            <span class="text-[12px] font-medium text-own-muted">{text("own.otherTools.migrate.target")}</span>
            <div class="flex flex-wrap items-center gap-1.5">
              <select
                ref={(element) => (accountSelect = element)}
                class="own-input h-8 w-auto max-w-[16rem] py-0"
                aria-label={text("own.otherTools.migrate.account")}
                data-testid="import-migrate-account"
                value={account()?.id ?? ""}
                onChange={(event) => selectAccount(event.currentTarget.value)}
              >
                <Show when={!account()}>
                  <option value="" disabled>
                    {target()?.providerID ?? "—"}
                  </option>
                </Show>
                <For each={groups()}>
                  {(group) => (
                    <optgroup label={kindName(i18n, group.kind)}>
                      <For each={group.accounts}>
                        {(item) => (
                          <option value={item.id} selected={item.id === account()?.id}>
                            {accountOption(item, recommended().has(item.id), own.state.quota[item.id])}
                          </option>
                        )}
                      </For>
                    </optgroup>
                  )}
                </For>
              </select>
              <Show when={sameCompany()}>
                <Tag
                  tone="accent"
                  title={text("own.otherTools.migrate.sameCompanyHint", { tool })}
                  testid="import-migrate-same-company"
                >
                  {text("own.otherTools.migrate.sameCompany")}
                </Tag>
              </Show>
              <Show when={account() && recommended().has(account()?.id ?? "")}>
                <Tag
                  tone="ok"
                  title={text("own.otherTools.migrate.recommendedHint")}
                  testid="import-migrate-recommended"
                >
                  {text("own.otherTools.migrate.recommended")}
                </Tag>
              </Show>
              <select
                class="own-input h-8 w-auto max-w-[16rem] py-0"
                aria-label={text("own.otherTools.migrate.model")}
                data-testid="import-migrate-model"
                value={target()?.id ?? ""}
                disabled={modelList().length === 0}
                onChange={(event) => selectModel(event.currentTarget.value)}
              >
                <Show when={modelList().length === 0}>
                  <option value="">{target()?.id ?? text("own.otherTools.migrate.noModels")}</option>
                </Show>
                {/* The list is rebuilt with each pick: every option says whether it is the target, so the select
                    never falls back to the first one while the plan runs on another (IG9). */}
                <For each={modelList()}>
                  {(model) => (
                    <option value={model.id} selected={model.id === target()?.id}>
                      {model.name}
                    </option>
                  )}
                </For>
              </select>
              <Show when={variants().length > 0}>
                <select
                  class="own-input h-8 w-auto py-0"
                  aria-label={text("own.otherTools.migrate.variant")}
                  data-testid="import-migrate-variant"
                  value={target()?.variant ?? ""}
                  onChange={(event) => selectVariant(event.currentTarget.value)}
                >
                  <option value="" selected={!target()?.variant}>
                    {variantName(i18n, undefined)}
                  </option>
                  <For each={variants()}>
                    {(variant) => (
                      <option value={variant} selected={variant === target()?.variant}>
                        {variantName(i18n, variant)}
                      </option>
                    )}
                  </For>
                </select>
              </Show>
            </div>
            <p class="m-0 flex flex-wrap gap-x-2 text-[12px] text-own-muted" data-testid="import-migrate-original">
              <Show when={request.original}>
                {(original) => <span>{text("own.otherTools.migrate.original", { model: original() })}</span>}
              </Show>
              <Show when={!state.stale && plan()}>
                {(current) => (
                  <span class="own-num" data-testid="import-migrate-ratio">
                    {text("own.otherTools.migrate.ratio", { n: Math.round(current().size.ratio * 100) })}
                  </span>
                )}
              </Show>
            </p>
            <Show when={!target()}>
              <p class="m-0 text-[12.5px] text-own-muted">{text("own.otherTools.migrate.noTarget")}</p>
            </Show>
            <Show when={listed().hidden.length > 0}>
              <p class="m-0 text-[12px] text-own-faint">{text("own.otherTools.migrate.teamHidden")}</p>
            </Show>
            <Show when={headroom().length > 0}>
              <HeadroomList accounts={headroom()} onPick={selectAccount} />
            </Show>
          </section>

          <Show when={state.error}>
            {(message) => (
              <Notice tone="danger" testid="import-migrate-error">
                {text("own.otherTools.migrate.planFailed", { reason: message() })}{" "}
                <button type="button" class="own-btn" data-size="sm" onClick={() => replan()}>
                  {text("own.otherTools.migrate.retry")}
                </button>
              </Notice>
            )}
          </Show>
          {/* `가져오기` refused before it ran (02 §8.7): the plan stands, so the fix is the account, not a re-plan. */}
          <Show when={state.refused}>
            <Notice tone="danger" testid="import-migrate-claude-refused">
              <p class="m-0">{text("own.otherTools.migrate.claudeRefused")}</p>
              <div class="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="import-migrate-open-accounts"
                  onClick={openAccounts}
                >
                  {text("own.otherTools.migrate.openAccounts")}
                </button>
                <button
                  type="button"
                  class="own-btn"
                  data-size="sm"
                  data-testid="import-migrate-alt-target"
                  onClick={() => pickAlternative("target")}
                >
                  {text("own.otherTools.migrate.altTarget")}
                </button>
              </div>
            </Notice>
          </Show>
          <Show when={!plan() && state.planning}>
            <p class="m-0 flex items-center gap-2 text-own-muted" role="status">
              <Spinner />
              {text("own.otherTools.migrate.planning")}
            </p>
          </Show>

          <Show when={plan()}>
            {(current) => (
              <>
                <ModeRowsView
                  plan={current()}
                  selected={row()}
                  stale={state.stale}
                  runtime={runtime}
                  onChoose={(next) => setChoice(next)}
                />
                <LocationLine plan={current()} list={request.directory} onHere={() => setLocation(request.directory)} />
                <Details
                  plan={current()}
                  upTo={upTo()}
                  total={state.total}
                  storeFull={storeFull()}
                  redact={keepable ? redact() : true}
                  keepable={keepable}
                  onUpTo={setUpTo}
                  onStoreFull={setStoreFull}
                  onRedact={setRedact}
                />
                <Warnings plan={current()} tool={tool} />
                <Show when={row()}>
                  {(selected) => <SendLine plan={current()} row={selected()} runtime={runtime} tool={tool} />}
                </Show>
              </>
            )}
          </Show>
        </Show>

        <Show when={state.note}>
          {(note) => (
            <p class="m-0 text-[12.5px] text-own-muted" role="status" data-testid="import-migrate-note">
              {note()}
            </p>
          )}
        </Show>
      </div>
    </Dialog>
  )

  function accountOption(item: Account.View, isRecommended: boolean, quota: Parameters<typeof unusable>[1]) {
    return [
      item.label,
      ...(isRecommended ? [text("own.otherTools.migrate.recommended")] : []),
      ...(unusable(item, quota) ? [text("own.otherTools.migrate.unusable")] : []),
    ].join(" · ")
  }
}

const ALTERNATIVE: { readonly [A in ReturnType<typeof alternatives>[number]]: ImportKey } = {
  brief: "own.otherTools.migrate.altBrief",
  full: "own.otherTools.migrate.altFull",
  target: "own.otherTools.migrate.altTarget",
}

function focusComposer() {
  requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById("own-composer-input")?.focus()))
}

/**
 * The imported session's info (its folder) before it opens: the composer's own.accounts reads route by the session's
 * folder (03 §16.3), and the session is new to this window (its `session.created` read may still run).
 */
function known(runtime: ServerRuntime, sessionID: string) {
  return runtime.data.session.sync(sessionID).catch(() => undefined)
}

// ---------------------------------------------------------------------------------------------------------------
// Parts

/** `설치기 정리 · 41턴 · 약 182k 토큰 · Codex 압축 2번(읽을 수 없음)`. */
function TitleLine(props: { readonly plan: Plan; readonly tool: string }) {
  const text = useImportText()
  const compactions = () => props.plan.boundary.sourceCompactions
  return (
    <p class="m-0 flex flex-wrap gap-x-1.5 text-[13px]" data-testid="import-migrate-title">
      <span class="min-w-0 truncate font-medium">{props.plan.title || text("own.otherTools.row.untitled")}</span>
      <span aria-hidden="true">·</span>
      <span class="own-num">{text("own.otherTools.migrate.turns", { n: props.plan.turns })}</span>
      <span aria-hidden="true">·</span>
      <span class="own-num">
        {text("own.otherTools.migrate.tokens", { tokens: formatTokens(props.plan.size.visible) })}
      </span>
      <Show when={compactions() > 0}>
        <span aria-hidden="true">·</span>
        <span>
          {text(
            props.plan.boundary.checkpoint === "codex-remote"
              ? "own.otherTools.migrate.compactionsEncrypted"
              : "own.otherTools.migrate.compactions",
            { tool: props.tool, n: compactions() },
          )}
        </span>
      </Show>
    </p>
  )
}

/** `이미 가져옴`: `열기` / `새로 가져오기` before anything else (09 §4.7). */
function ExistingQuestion(props: {
  readonly existing: Plan["existing"]
  readonly onOpen: (sessionID: string) => void
  readonly onAgain: () => void
}) {
  const i18n = useI18n()
  const text = useImportText()
  const latest = () => props.existing[0]
  return (
    <Show when={latest()}>
      {(imported) => (
        <div class="flex flex-col gap-2" data-testid="import-migrate-existing">
          <p class="m-0">
            {text("own.otherTools.migrate.existing", {
              when: dateTime(i18n.locale(), imported().importedAt),
              mode: text(`own.otherTools.origin.mode.${imported().mode}`),
            })}
            <Show when={props.existing.length > 1}>
              {" "}
              {text("own.otherTools.migrate.existingMore", { n: props.existing.length })}
            </Show>
          </p>
          <p class="m-0 text-[12.5px] text-own-muted">{text("own.otherTools.migrate.againNote")}</p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              data-testid="import-migrate-open-existing"
              onClick={() => props.onOpen(imported().sessionID)}
            >
              {text("own.otherTools.migrate.open")}
            </button>
            <button type="button" class="own-btn" data-testid="import-migrate-again" onClick={() => props.onAgain()}>
              {text("own.otherTools.migrate.again")}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}

/** `추천` accounts by headroom on a usage shortage (02 §5.10); the user picks one, nothing switches by itself. */
function HeadroomList(props: {
  readonly accounts: ReturnType<typeof headroomRanked>
  readonly onPick: (accountID: string) => void
}) {
  const text = useImportText()
  const i18n = useI18n()
  return (
    <div class="flex flex-wrap items-center gap-1.5 text-[12.5px]" data-testid="import-migrate-headroom">
      <span class="text-own-muted">{text("own.otherTools.migrate.headroom")}</span>
      <For each={props.accounts}>
        {(item) => (
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            data-testid="import-migrate-headroom-pick"
            onClick={() => props.onPick(item.account.id)}
          >
            {text("own.otherTools.migrate.headroomPick", { account: item.account.label })}
            <Show when={item.used}>
              {(used) => <span class="own-num ml-1 text-own-muted">{limitText(i18n, used())}</span>}
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

/** 방식 (09 §4.3, §6): the two rows with their costs; `요약해서 이어가기` opens its two sources. */
function ModeRowsView(props: {
  readonly plan: Plan
  readonly selected: ModeOption | undefined
  readonly stale: boolean
  readonly runtime: ServerRuntime
  readonly onChoose: (choice: ModeChoice) => void
}) {
  const text = useImportText()
  const rows = () => modeRows(props.plan)
  const summary = () => summaryState(rows())
  const remote = () => props.plan.boundary.checkpoint === "codex-remote"
  const name = `import-mode-${createUniqueId()}`
  return (
    <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0" data-testid="import-migrate-modes" aria-busy={props.stale}>
      <legend class="mb-1 p-0 text-[12px] font-medium text-own-muted">{text("own.otherTools.migrate.mode")}</legend>
      <Show when={rows().full}>
        {(full) => (
          <ModeLine
            name={name}
            label={text("own.otherTools.migrate.full")}
            row={full()}
            available={full().available}
            reason={full().reason}
            checked={props.selected?.mode === "full"}
            testid="import-migrate-mode-full"
            onChoose={() => props.onChoose({ mode: "full" })}
          />
        )}
      </Show>
      <Show when={rows().llm || rows().brief}>
        <ModeLine
          name={name}
          label={text("own.otherTools.migrate.summary")}
          row={rows().llm?.available ? rows().llm : rows().brief}
          available={summary().available}
          reason={summary().reason}
          checked={props.selected?.mode === "summary"}
          quiet={props.selected?.mode === "summary"}
          testid="import-migrate-mode-summary"
          onChoose={() => props.onChoose({ mode: "summary", source: summarySource(rows()) })}
        />
      </Show>
      <Show when={props.selected?.mode === "summary"}>
        <div class="ml-6 flex flex-col gap-1" role="radiogroup" data-testid="import-migrate-sources">
          <Show when={rows().llm}>
            {(llm) => (
              <ModeLine
                name={`${name}-source`}
                label={text(remote() ? "own.otherTools.migrate.llmAll" : "own.otherTools.migrate.llm")}
                row={llm()}
                available={llm().available}
                reason={llm().reason}
                checked={props.selected?.source === "llm"}
                testid="import-migrate-source-llm"
                onChoose={() => props.onChoose(choiceOf(llm()))}
              />
            )}
          </Show>
          <Show when={props.plan.summarizer?.overridden && props.plan.summarizer}>
            {(summarizer) => (
              <p class="m-0 ml-6 text-[12px] text-own-muted" data-testid="import-migrate-summarizer">
                {text("own.otherTools.migrate.summarizer", {
                  model: modelName(props.runtime, summarizer().model),
                })}
              </p>
            )}
          </Show>
          <Show when={rows().brief}>
            {(brief) => (
              <ModeLine
                name={`${name}-source`}
                label={text("own.otherTools.migrate.brief")}
                row={brief()}
                available={brief().available}
                reason={brief().reason}
                checked={props.selected?.source === "brief"}
                testid="import-migrate-source-brief"
                onChoose={() => props.onChoose(choiceOf(brief()))}
              />
            )}
          </Show>
        </div>
      </Show>
    </fieldset>
  )
}

function ModeLine(props: {
  readonly name: string
  readonly label: string
  readonly row: ModeOption | undefined
  readonly available: boolean
  readonly reason: ModeOption["reason"]
  readonly checked: boolean
  /** The costs are on the sources below (an open `요약해서 이어가기`). */
  readonly quiet?: boolean
  readonly testid: string
  readonly onChoose: () => void
}) {
  const i18n = useI18n()
  const text = useImportText()
  const costs = () => (props.row && props.available && !props.quiet ? costLines(i18n, text, props.row) : [])
  return (
    <label
      class="flex items-start gap-2 rounded-md px-1.5 py-1 data-[off]:opacity-55"
      data-off={props.available ? undefined : ""}
      data-testid={props.testid}
    >
      <input
        type="radio"
        class="mt-1"
        name={props.name}
        checked={props.checked}
        disabled={!props.available}
        onChange={() => props.onChoose()}
      />
      <span class="flex min-w-0 flex-col">
        <span class="font-medium">{props.label}</span>
        <Show
          when={props.available}
          fallback={
            <Show when={props.reason}>
              {(reason) => (
                <span class="text-[12px] text-own-muted" data-testid={`${props.testid}-reason`}>
                  {text(`own.otherTools.migrate.reason.${reason()}`)}
                </span>
              )}
            </Show>
          }
        >
          <For each={costs()}>{(line) => <span class="own-num text-[12px] text-own-muted">{line}</span>}</For>
          <Show when={!props.quiet && props.row?.cost.autoCompactSoon}>
            {(soon) => (
              <span class="text-[12px] text-own-warn" data-testid={`${props.testid}-auto-compact`}>
                {text("own.otherTools.migrate.autoCompact", { cost: formatRange(i18n, soon()) })}
              </span>
            )}
          </Show>
        </Show>
      </span>
    </label>
  )
}

/** A row's costs in account units (09 §4.6): the summary (LLM) or `무료`, the cold first request, each later one. */
function costLines(
  i18n: I18n,
  text: (key: ImportKey, params?: Record<string, string | number>) => string,
  row: ModeOption,
) {
  const cost = row.cost
  const quota = quotaText(i18n, cost.quota ?? undefined)
  const amount = (delta: NonNullable<typeof cost.first>) =>
    quota ? `${formatRange(i18n, delta)} · ${quota}` : formatRange(i18n, delta)
  const summary =
    row.mode === "summary" && row.source === "llm"
      ? [
          cost.summary
            ? text("own.otherTools.migrate.costSummary", { cost: amount(cost.summary) })
            : text("own.otherTools.migrate.costUnknown"),
        ]
      : row.mode === "summary"
        ? [text("own.otherTools.migrate.free")]
        : []
  return [
    ...summary,
    cost.first
      ? text("own.otherTools.migrate.costFirst", { cost: formatRange(i18n, cost.first) })
      : text("own.otherTools.migrate.costUnknown"),
    ...(cost.perRequest ? [text("own.otherTools.migrate.costPer", { cost: formatRange(i18n, cost.perRequest) })] : []),
  ]
}

/** 가져올 위치 and its branch; when it is not the list's folder, `이 폴더에서 이어가기` (09 §2.2, §6). */
function LocationLine(props: { readonly plan: Plan; readonly list: string; readonly onHere: () => void }) {
  const text = useImportText()
  const place = () => props.plan.location
  return (
    <div class="flex flex-col gap-0.5 text-[12.5px]" data-testid="import-migrate-location">
      <p class="m-0">
        <span class="text-own-muted">{text("own.otherTools.migrate.location")}</span>{" "}
        <span class="font-mono" title={place().directory}>
          {place().branch
            ? text("own.otherTools.migrate.locationBranch", { folder: place().directory, branch: place().branch ?? "" })
            : place().directory}
        </span>
      </p>
      <Show when={place().differsFromList}>
        <p class="m-0 flex flex-wrap items-center gap-1.5 text-own-muted">
          {text("own.otherTools.migrate.locationDiffers")}
          <button
            type="button"
            class="own-btn"
            data-size="sm"
            title={props.list}
            data-testid="import-migrate-location-here"
            onClick={() => props.onHere()}
          >
            {text("own.otherTools.migrate.locationHere", { folder: baseName(props.list) })}
          </button>
        </p>
      </Show>
    </div>
  )
}

/** 자세히: `여기까지(턴 N)`, `원래 대화 전체도 own에 저장` (on by default, Q3), `비밀 가리기(N개)`. */
function Details(props: {
  readonly plan: Plan
  readonly upTo: number | undefined
  readonly total: number | undefined
  readonly storeFull: boolean
  readonly redact: boolean
  /** This connection may import with secrets kept (`redact: false`): this PC's windows only (09 §5.5). */
  readonly keepable: boolean
  readonly onUpTo: (turn: number | undefined) => void
  readonly onStoreFull: (on: boolean) => void
  readonly onRedact: (on: boolean) => void
}) {
  const text = useImportText()
  const last = () => (props.upTo ?? props.plan.turns - 1) + 1
  const trimmed = () => props.plan.store.trimmedTurns
  const summaryLine = () =>
    [
      text("own.otherTools.migrate.upTo", { n: last() }),
      `${text("own.otherTools.migrate.storeFull")} ${props.storeFull ? "☑" : "☐"}`,
      text("own.otherTools.migrate.redact", { n: props.plan.redactions }),
    ].join(", ")
  return (
    <details class="text-[12.5px]" data-testid="import-migrate-details">
      <summary class="cursor-pointer text-own-muted">
        {text("own.otherTools.migrate.details")}: {summaryLine()}
      </summary>
      <div class="mt-1.5 flex flex-col gap-2 pl-4">
        <label class="flex flex-wrap items-center gap-2">
          <span>{text("own.otherTools.migrate.upToLabel")}</span>
          <input
            type="number"
            class="own-input h-7 w-20 py-0"
            min={1}
            max={props.total}
            value={last()}
            data-testid="import-migrate-upto"
            onChange={(event) => {
              const value = Math.floor(Number(event.currentTarget.value))
              if (!Number.isFinite(value) || value < 1) return
              const turn = Math.min(value, props.total ?? value) - 1
              props.onUpTo(props.total !== undefined && turn >= props.total - 1 ? undefined : turn)
            }}
          />
          <Show when={props.upTo !== undefined}>
            <button type="button" class="own-btn" data-size="sm" onClick={() => props.onUpTo(undefined)}>
              {text("own.otherTools.migrate.upToAll")}
            </button>
          </Show>
        </label>
        <div class="flex flex-col gap-0.5">
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={props.storeFull}
              data-testid="import-migrate-store-full"
              onChange={(event) => props.onStoreFull(event.currentTarget.checked)}
            />
            <span>{text("own.otherTools.migrate.storeFull")}</span>
          </label>
          <p class="m-0 pl-6 text-[12px] text-own-muted">{text("own.otherTools.migrate.storeFullNote")}</p>
          <Show when={trimmed() > 0 || props.plan.warnings.includes("import_too_large")}>
            <p class="m-0 pl-6 text-[12px] text-own-warn" data-testid="import-migrate-trimmed">
              {text("own.otherTools.migrate.trimmed", { n: trimmed() })}
            </p>
          </Show>
        </div>
        <div class="flex flex-col gap-0.5">
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={props.redact}
              disabled={!props.keepable}
              data-testid="import-migrate-redact"
              onChange={(event) => props.onRedact(event.currentTarget.checked)}
            />
            <span>{text("own.otherTools.migrate.redact", { n: props.plan.redactions })}</span>
          </label>
          <p class="m-0 pl-6 text-[12px] text-own-muted">{text("own.otherTools.migrate.redactNote")}</p>
        </div>
      </div>
    </details>
  )
}

function Warnings(props: { readonly plan: Plan; readonly tool: string }) {
  const text = useImportText()
  const keys = () => props.plan.warnings.flatMap((warning) => WARNING[warning] ?? [])
  return (
    <For each={keys()}>
      {(key) => (
        <p class="m-0 text-[12.5px] text-own-warn" role="note" data-testid="import-migrate-warning">
          ⚠ {text(key, { tool: props.tool })}
        </p>
      )}
    </For>
  )
}

/** The send notice of the chosen row with `다른 회사` (09 §4.5 동의와 전송 안내; every mode, IG10). */
function SendLine(props: {
  readonly plan: Plan
  readonly row: ModeOption
  readonly runtime: ServerRuntime
  readonly tool: string
}) {
  const i18n = useI18n()
  const text = useImportText()
  const notice = () => sendNotice(props.row)
  const receiver = () => {
    const current = notice()
    const label =
      (current.accountID ? props.runtime.own.state.accounts[current.accountID]?.label : undefined) ??
      props.runtime.own.accountFor(props.plan.summarizer?.model.providerID ?? "")?.label ??
      current.accountID ??
      "—"
    return current.company
      ? text("own.otherTools.migrate.receiver", { account: label, company: companyName(i18n, current.company) })
      : label
  }
  const summarizer = () => {
    const model = props.plan.summarizer
    return model?.overridden ? modelName(props.runtime, model.model) : receiver()
  }
  return (
    <div
      class="flex flex-wrap items-center gap-1.5 text-[12.5px]"
      data-testid="import-migrate-send"
      data-kind={notice().key}
    >
      <span>
        {notice().key === "now"
          ? text("own.otherTools.migrate.sendNow", {
              now: formatTokens(notice().now),
              summarizer: summarizer(),
              tokens: formatTokens(notice().withFirst),
              to: receiver(),
            })
          : text("own.otherTools.migrate.sendFirst", { tokens: formatTokens(notice().withFirst), to: receiver() })}
      </span>
      <Show when={notice().crossCompany}>
        <Tag
          tone="warn"
          title={text("own.otherTools.migrate.crossCompanyHint", { tool: props.tool })}
          testid="import-migrate-cross-company"
        >
          {text("own.otherTools.migrate.crossCompany")}
        </Tag>
      </Show>
    </div>
  )
}

/** `원본 읽는 중` → `요약 중` → `대화 만드는 중` with `취소` (09 §6 진행). */
function JobProgress(props: {
  readonly job: JobView
  readonly other: boolean
  readonly cancelling: boolean
  readonly onCancel: () => void
}) {
  const text = useImportText()
  const steps = () => jobSteps(props.job)
  const index = () => Math.max(0, steps().indexOf(props.job.step))
  const done = () => props.job.outcome === "succeeded"
  return (
    <Show when={props.job.outcome !== "failed" && props.job.outcome !== "cancelled"}>
      <div class="flex flex-col gap-1.5" data-testid="import-migrate-progress" data-step={props.job.step}>
        <Show when={props.other}>
          <p class="m-0 text-[12.5px] text-own-muted">{text("own.otherTools.job.other")}</p>
        </Show>
        <progress
          class="h-1.5 w-full"
          max={steps().length}
          value={done() ? steps().length : index() + 0.5}
          aria-label={text("own.otherTools.job.progress")}
        />
        <ol class="m-0 flex list-none flex-wrap gap-x-3 p-0 text-[12.5px]">
          <For each={steps()}>
            {(step, at) => (
              <li
                class="data-[state=current]:font-medium data-[state=pending]:text-own-faint data-[state=done]:text-own-muted"
                data-state={done() || at() < index() ? "done" : at() === index() ? "current" : "pending"}
                aria-current={at() === index() && !done() ? "step" : undefined}
              >
                {text(STEP[step])}
              </li>
            )}
          </For>
        </ol>
        <Show when={!props.job.outcome}>
          <div class="flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="own-btn"
              data-size="sm"
              disabled={props.cancelling}
              data-testid="import-migrate-job-cancel"
              onClick={() => props.onCancel()}
            >
              {text(props.cancelling ? "own.otherTools.job.cancelling" : "own.otherTools.job.cancel")}
            </button>
            <span class="text-[12px] text-own-faint">{text("own.otherTools.job.closeNote")}</span>
          </div>
        </Show>
      </div>
    </Show>
  )
}

const STEP: { readonly [S in JobStep]: ImportKey } = {
  reading: "own.otherTools.job.reading",
  summarizing: "own.otherTools.job.summarizing",
  importing: "own.otherTools.job.importing",
}

function dateTime(locale: Locale, at: number) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at)
}

// ---------------------------------------------------------------------------------------------------------------
// The job of each server, followed outside the dialog (09 §6 진행: a closed dialog leaves a toast, a reopened one or a
// reload shows it again from `jobs.list`). One job per service at a time (09 §4.8).

interface Tracked {
  readonly job: JobView
  /** For the toasts: the plan's title (empty until known after a restore). */
  readonly title: string
  /** What reopens the dialog (`보기`). */
  readonly request: MigrateTarget
}

interface Binding {
  readonly locale: () => Locale
  readonly navigate: (route: Route) => void
}

const trackers = new WeakMap<ServerRuntime, ReturnType<typeof createJobTracker>>()

function jobTracker(runtime: ServerRuntime) {
  const known = trackers.get(runtime)
  if (known) return known
  const created = createJobTracker(runtime)
  trackers.set(runtime, created)
  return created
}

function createJobTracker(runtime: ServerRuntime) {
  const [current, setCurrent] = createRoot(() => createSignal<Tracked>())
  const state: { binding?: Binding; watching?: MigrateTarget["ref"] } = {}
  const words = (key: ImportKey, params?: Record<string, string | number>) =>
    importText(state.binding?.locale() ?? "ko", key, params)
  const titleOf = (tracked: Tracked) =>
    tracked.title || words("own.otherTools.job.untitled", { tool: TOOL_NAME[tracked.job.ref.kind] })
  // A dialog showing this conversation handles the end itself; otherwise the end is a toast.
  const watched = (tracked: Tracked) => !!state.watching && sameSource(tracked.job.ref, state.watching)

  runtime.bus.listen((raw) => {
    const event = importEvent(raw)
    const tracked = current()
    if (!event || !tracked) return
    const job = jobEvent(tracked.job, event)
    if (!job || job === tracked.job) return
    const next = { ...tracked, job }
    setCurrent(next)
    if (job.outcome && !tracked.job.outcome && !watched(next)) announceEnd(next)
  })

  function announceEnd(tracked: Tracked) {
    const job = tracked.job
    const title = titleOf(tracked)
    const reopen = { label: words("own.otherTools.job.show"), run: () => requestMigrate(tracked.request) }
    if (job.outcome === "succeeded" && job.sessionID) {
      const sessionID = job.sessionID
      setCurrent(undefined)
      return showToast({
        message: words("own.otherTools.job.toastDone", { title }),
        duration: 12_000,
        action: {
          label: words("own.otherTools.job.open"),
          run: () =>
            void known(runtime, sessionID).then(() => {
              state.binding?.navigate({ name: "session", serverKey: tracked.request.serverKey, sessionID })
              focusComposer()
            }),
        },
      })
    }
    if (job.outcome === "cancelled") {
      setCurrent(undefined)
      return showToast({ message: words("own.otherTools.job.toastCancelled", { title }) })
    }
    showToast({
      message: words("own.otherTools.job.toastFailed", { title, reason: words(jobErrorKey(job.error)) }),
      tone: "danger",
      duration: 12_000,
      action: reopen,
    })
  }

  return {
    current,
    bind(binding: Binding) {
      state.binding = binding
    },
    /** An open dialog shows this conversation until the release (a newer dialog's watch stays). */
    watch(ref: MigrateTarget["ref"]) {
      state.watching = ref
      return () => {
        if (state.watching === ref) state.watching = undefined
      }
    },
    start(tracked: Tracked) {
      setCurrent(tracked)
    },
    clear() {
      setCurrent(undefined)
    },
    /** `jobs.list` on open (a reload or another window started it): the running job, unless already followed. */
    async restore(request: MigrateTarget, title: () => string | undefined) {
      const output = await runtime.imports.call("jobs.list", {}).catch(() => undefined)
      const job = output ? restoreJob(output.jobs) : undefined
      const known = current()
      if (!job || (known && known.job.jobID === job.jobID && !known.job.outcome)) return
      const same = sameSource(job.ref, request.ref)
      setCurrent({ job, title: same ? (title() ?? "") : "", request: same ? request : { ...request, ref: job.ref } })
    },
    /** The dialog closed while the job runs: a toast that reopens it. */
    announceRunning() {
      const tracked = current()
      if (!tracked || tracked.job.outcome) return
      showToast({
        message: words("own.otherTools.job.toastRunning", {
          title: titleOf(tracked),
          step: words(STEP[tracked.job.step]),
        }),
        duration: 8_000,
        action: { label: words("own.otherTools.job.show"), run: () => requestMigrate(tracked.request) },
      })
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The header badge's details (09 §4.7): origin, imported time, mode, summarizer, redactions and `원본 보기`.

export function OriginDetails(props: {
  readonly serverKey: ServerKey
  readonly projectID: string | undefined
  readonly origin: ImportOrigin
  readonly onClose: () => void
}) {
  const i18n = useI18n()
  const text = useImportText()
  const data = useData()
  const runtime = () => data.get(props.serverKey)
  createEffect(() => {
    const current = runtime()
    if (current) untrack(() => void importStore(current).ensure())
  })
  const tool = () => TOOL_NAME[props.origin.kind]
  const viewable = () => {
    const current = runtime()
    return (
      !!current &&
      !!props.origin.ref &&
      !!props.projectID &&
      importGates(importStore(current).health(), current.imports.allowed).view
    )
  }
  const start = () => {
    const checkpoint = props.origin.checkpoint
    return checkpoint === null
      ? text("own.otherTools.origin.start.none")
      : text(`own.otherTools.origin.start.${checkpoint}`, { tool: tool() })
  }
  const summarizer = () => {
    const model = props.origin.summarizer
    const current = runtime()
    return model && current ? modelName(current, model) : model?.id
  }
  return (
    <Dialog
      open
      dismissable
      title={text("own.otherTools.origin.title", { tool: tool() })}
      onClose={props.onClose}
      testid="import-origin"
      footer={
        <>
          <Show when={viewable()}>
            <button
              type="button"
              class="own-btn"
              data-variant="primary"
              data-testid="import-origin-view"
              onClick={() => {
                const ref = props.origin.ref
                const projectID = props.projectID
                if (ref && projectID) openImport({ serverKey: props.serverKey, projectID, ref })
                props.onClose()
              }}
            >
              {text("own.otherTools.origin.view")}
            </button>
          </Show>
          <button type="button" class="own-btn" onClick={() => props.onClose()}>
            {text("own.otherTools.migrate.close")}
          </button>
        </>
      }
    >
      <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]" data-testid="import-origin-details">
        <dt class="text-own-muted">{text("own.otherTools.origin.source")}</dt>
        <dd class="m-0 min-w-0 break-words">
          {tool()} · {props.origin.title || text("own.otherTools.row.untitled")}
        </dd>
        <dt class="text-own-muted">{text("own.otherTools.origin.importedAt")}</dt>
        <dd class="m-0">{dateTime(i18n.locale(), props.origin.importedAt)}</dd>
        <dt class="text-own-muted">{text("own.otherTools.origin.turns")}</dt>
        <dd class="own-num m-0">{props.origin.turns}</dd>
        <dt class="text-own-muted">{text("own.otherTools.origin.mode")}</dt>
        <dd class="m-0">{text(`own.otherTools.origin.mode.${props.origin.mode}`)}</dd>
        <dt class="text-own-muted">{text("own.otherTools.origin.start")}</dt>
        <dd class="m-0">{start()}</dd>
        <Show when={summarizer()}>
          {(model) => (
            <>
              <dt class="text-own-muted">{text("own.otherTools.origin.summarizer")}</dt>
              <dd class="m-0">{model()}</dd>
            </>
          )}
        </Show>
        <dt class="text-own-muted">{text("own.otherTools.origin.redactions")}</dt>
        <dd class="own-num m-0">{text("own.otherTools.origin.redactionsCount", { n: props.origin.redactions })}</dd>
      </dl>
      <p class="mt-2 mb-0 text-[12.5px] text-own-muted">{text("own.otherTools.origin.note")}</p>
      <Show when={props.origin.ref && !viewable()}>
        <p class="mt-1 mb-0 text-[12px] text-own-faint">{text("own.otherTools.origin.viewUnavailable")}</p>
      </Show>
    </Dialog>
  )
}
