// Add account (03 §5.4 "계정 추가 흐름", AddAccountDialog): one dialog in steps. 1) type grid; 2) API key form (with
// the compat base URL / models / context limits / image input and tools / rates), ChatGPT login (Sign in with ChatGPT
// included), old-app import, the Claude plugin slot, or Claude Agent (02 §8.10, its own lazy chunk); 3) done, with the
// one-time "ChatGPT 요금제로 연결됨" notice after the first new Sign in with ChatGPT account. The key goes out only in
// the request body of `accounts.add.key` and leaves the form state right away (16.3). Adding an account never touches
// running sessions (P5), and the global active credential never changes.
import type { Account, Kind, OwnAccounts } from "@own/protocol"
import { createEffect, createSignal, For, Index, lazy, Match, on, Show, Suspense, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "@/data"
import { useI18n, type I18nKey } from "@/i18n"
import { parseTokens } from "@/limits/format"
import { requestNewSession } from "@/limits/intents"
import {
  ColorPicker,
  Dialog,
  Notice,
  ProviderMark,
  Spinner,
  Tag,
  TextField,
  createStatus,
  StatusLine,
} from "@/limits/kit"
import { policyState } from "@/limits/shared"
import { useRouter } from "@/routing/router"
import { ChatGPTLogin, PlanWelcome } from "./chatgpt-login"
import { firstPlanLogin } from "./chatgpt-plan"
import { useClaudeAgentText } from "./claude-agent-strings"
import { ClaudeFlow, type ClaudeStatusStore } from "./claude-slot"
import { CodexImportFlow } from "./codex-import"
import { CapabilitySettings } from "./compat-capabilities"
import { useCompatText } from "./compat-strings"
import { useLocalText } from "./local-strings"
import { errorMessage } from "./errors"
import { COLORS, defaultLabel, kindLabel, nextColor, outputLimitOf, shortID } from "./model"

// Claude Agent's steps load with their own chunk, the first time its card is picked.
const ClaudeAgentFlow = lazy(() => import("./claude-agent").then((module) => ({ default: module.ClaudeAgentFlow })))
// 02 §3.3a: so does the local model form.
const LocalModelForm = lazy(() => import("./local-model-form").then((module) => ({ default: module.LocalModelForm })))

type Choice = Kind.Api | "codex" | "codexImport" | "claude-sub" | "claude-agent" | "local"

interface TypeCard {
  readonly choice: Choice
  /** Absent on the local model card, whose texts are in its own catalog (local-strings.ts). */
  readonly title?: I18nKey
  /** Absent on the Claude Agent and local model cards, whose lines are in their own catalogs. */
  readonly subtitle?: I18nKey
  readonly badges: readonly { readonly key: I18nKey; readonly tone?: "danger" | "accent" }[]
}

/** 5.4 step 1 table, in its order. */
const CARDS: readonly TypeCard[] = [
  {
    choice: "codex",
    title: "own.acct.kind.codex",
    subtitle: "own.acct.add.codexSub",
    badges: [{ key: "own.accounts.type.subscription" }],
  },
  {
    choice: "codexImport",
    title: "own.acct.add.importTitle",
    subtitle: "own.acct.add.importSub",
    badges: [{ key: "own.accounts.type.subscription" }],
  },
  {
    choice: "oai",
    title: "own.acct.add.oaiTitle",
    subtitle: "own.acct.add.oaiSub",
    badges: [{ key: "own.accounts.type.api" }],
  },
  {
    choice: "anth",
    title: "own.acct.add.anthTitle",
    subtitle: "own.acct.add.anthSub",
    badges: [{ key: "own.accounts.type.api" }, { key: "own.switch.recommended", tone: "accent" }],
  },
  {
    choice: "claude-sub",
    title: "own.acct.add.claudeTitle",
    subtitle: "own.acct.add.claudeSub",
    badges: [{ key: "own.accounts.type.unofficial", tone: "danger" }],
  },
  // 02 §8.10 (CAG): the user's own Claude Code, unmodified and logged in by itself, so no 비공식 badge.
  {
    choice: "claude-agent",
    title: "own.acct.kind.claude-agent",
    badges: [{ key: "own.accounts.type.subscription" }],
  },
  {
    choice: "ds",
    title: "own.acct.kind.ds",
    subtitle: "own.acct.add.keySub",
    badges: [{ key: "own.accounts.type.api" }],
  },
  {
    choice: "xai",
    title: "own.acct.kind.xai",
    subtitle: "own.acct.add.keySub",
    badges: [{ key: "own.accounts.type.api" }],
  },
  {
    choice: "or",
    title: "own.acct.kind.or",
    subtitle: "own.acct.add.keySub",
    badges: [{ key: "own.accounts.type.api" }],
  },
  // 02 §3.3a: a local server (no key, free, reasoning effort), apart from other OpenAI-compatible servers.
  { choice: "local", badges: [] },
  {
    choice: "compat",
    title: "own.acct.kind.compat",
    subtitle: "own.acct.add.compatSub",
    badges: [{ key: "own.accounts.type.api" }],
  },
]

const ICON_KIND: Record<Choice, Kind.Any> = {
  codex: "codex",
  codexImport: "codex",
  oai: "oai",
  anth: "anth",
  "claude-sub": "claude-sub",
  "claude-agent": "claude-agent",
  ds: "ds",
  xai: "xai",
  or: "or",
  compat: "compat",
  local: "compat",
}

/** Default name base for a new key account (`Anthropic 1`). */
const NAME_BASE: Record<Kind.Api, string> = {
  oai: "OpenAI",
  anth: "Anthropic",
  ds: "DeepSeek",
  xai: "xAI",
  or: "OpenRouter",
  compat: "Compatible",
}

type Step =
  | { readonly name: "type" }
  | { readonly name: "key"; readonly kind: Kind.Api }
  | { readonly name: "chatgpt" }
  | { readonly name: "import" }
  | { readonly name: "claude" }
  | { readonly name: "claudeAgent" }
  | { readonly name: "local" }
  | {
      readonly name: "done"
      readonly account?: { readonly id: string; readonly providerID: string }
      readonly notes: readonly string[]
      readonly welcome?: boolean
    }

export function AddAccountDialog(props: {
  readonly open: boolean
  readonly onClose: () => void
  /** The connection may use the old-app import (`local` scope); availability is checked when the grid shows. */
  readonly canImport: boolean
  readonly claude: ClaudeStatusStore
  /** Opens on this kind's key form (이미지 만들기 도구's `OpenAI API 키 추가`). */
  readonly kind?: Kind.Api
}) {
  const i18n = useI18n()
  const localText = useLocalText()
  const first = (): Step => (props.kind ? { name: "key", kind: props.kind } : { name: "type" })
  const [step, setStep] = createSignal<Step>(first())
  createEffect(on(() => [props.open, props.kind] as const, ([open]) => open && setStep(first()), { defer: true }))
  const close = () => {
    setStep({ name: "type" })
    props.onClose()
  }
  const title = () => {
    const current = step()
    if (current.name === "key") return kindLabel(i18n, current.kind)
    if (current.name === "chatgpt") return i18n.t("own.acct.kind.codex")
    if (current.name === "import") return i18n.t("own.codex.importTitle")
    if (current.name === "claude") return i18n.t("own.acct.kind.claude-sub")
    if (current.name === "claudeAgent") return kindLabel(i18n, "claude-agent")
    if (current.name === "local") return localText("own.local.title")
    return i18n.t("own.page.accountsAdd")
  }
  return (
    <Dialog open={props.open} title={title()} onClose={close} size="wide" testid="add-account-dialog">
      <Switch>
        <Match when={step().name === "type"}>
          <TypeGrid canImport={props.canImport} onPick={(choice) => setStep(stepFor(choice))} />
        </Match>
        <Match when={step().name === "key" && (step() as Extract<Step, { name: "key" }>)}>
          {(current) => (
            <ApiKeyForm
              kind={current().kind}
              onBack={() => setStep({ name: "type" })}
              onDone={(account, notes) => setStep({ name: "done", account, notes })}
            />
          )}
        </Match>
        <Match when={step().name === "chatgpt"}>
          <ChatGPTLogin
            onCancel={() => setStep({ name: "type" })}
            onDone={(result) =>
              setStep({
                name: "done",
                account: { id: result.account.id, providerID: result.account.providerID },
                notes: result.reauthenticated ? [i18n.t("own.acct.reauthDone", { account: result.account.label })] : [],
                welcome: result.account.kind === "siwc" && !result.reauthenticated && firstPlanLogin(),
              })
            }
          />
        </Match>
        <Match when={step().name === "import"}>
          <CodexImportFlow onClose={close} />
        </Match>
        <Match when={step().name === "claude"}>
          <ClaudeFlow
            claude={props.claude}
            onClose={close}
            onUseApiKey={() => setStep({ name: "key", kind: "anth" })}
          />
        </Match>
        <Match when={step().name === "local"}>
          <Suspense>
            <LocalModelForm
              onBack={() => setStep({ name: "type" })}
              onDone={(account, notes) => setStep({ name: "done", account, notes })}
            />
          </Suspense>
        </Match>
        <Match when={step().name === "claudeAgent"}>
          <Suspense>
            <ClaudeAgentFlow onBack={() => setStep({ name: "type" })} onClose={close} />
          </Suspense>
        </Match>
        <Match when={step().name === "done" && (step() as Extract<Step, { name: "done" }>)}>
          {(current) => (
            <Done account={current().account} notes={current().notes} welcome={current().welcome} onClose={close} />
          )}
        </Match>
      </Switch>
    </Dialog>
  )
}

function stepFor(choice: Choice): Step {
  if (choice === "codex") return { name: "chatgpt" }
  if (choice === "codexImport") return { name: "import" }
  if (choice === "claude-sub") return { name: "claude" }
  if (choice === "claude-agent") return { name: "claudeAgent" }
  if (choice === "local") return { name: "local" }
  return { name: "key", kind: choice }
}

/**
 * 5.4 step 1. The old-app card appears only when `accounts.import.codex.list` reports `available: true`, or the old
 * app has saved API keys to link (`accounts.import.keys.list`, 02 §3.2b).
 */
function TypeGrid(props: { readonly canImport: boolean; readonly onPick: (choice: Choice) => void }) {
  const data = useData()
  const i18n = useI18n()
  const agent = useClaudeAgentText()
  const local = useLocalText()
  const [available, setAvailable] = createSignal(false)
  const own = data.local().own
  if (props.canImport) {
    void own.rpc
      .call("accounts.import.codex.list", {})
      .then((output) => output.available && setAvailable(true))
      .catch(() => undefined)
    if (own.rpc.allowed("accounts.import.keys.list"))
      void own.rpc
        .call("accounts.import.keys.list", {})
        .then((output) => output.available && output.keys.length > 0 && setAvailable(true))
        .catch(() => undefined)
  }
  const cards = () => CARDS.filter((card) => card.choice !== "codexImport" || available())
  return (
    <div class="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2" data-testid="add-type-grid">
      <For each={cards()}>
        {(card) => (
          <button
            type="button"
            class="flex flex-col items-start gap-1.5 rounded-[10px] border border-own-border bg-own-bg p-3 text-left hover:border-own-border-strong hover:bg-own-hover"
            data-choice={card.choice}
            onClick={() => props.onPick(card.choice)}
          >
            <span class="flex w-full items-center gap-2">
              <ProviderMark kind={ICON_KIND[card.choice]} />
              <b class="text-[13.5px] font-semibold">{card.title ? i18n.t(card.title) : local("own.local.title")}</b>
            </span>
            <span class="text-[12px] leading-4 text-own-muted">
              {card.subtitle
                ? i18n.t(card.subtitle)
                : card.choice === "local"
                  ? local("own.local.sub")
                  : agent("own.claudeAgent.add.sub")}
            </span>
            <span class="flex flex-wrap gap-1">
              <For each={card.badges}>{(badge) => <Tag tone={badge.tone ?? "soft"}>{i18n.t(badge.key)}</Tag>}</For>
              <Show when={card.choice === "local"}>
                <Tag tone="soft">{local("own.local.free")}</Tag>
              </Show>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

interface CompatRow {
  id: string
  context: string
  /** Output token cap (07 §6.2 #7); empty = the server's value, else 32k shown as `모름`. */
  outputLimit: string
  input: string
  cacheRead: string
  /** Output rate, $/1M tokens. */
  output: string
  /** 02 §3.3 `그림 입력` and `도구`: `auto` follows what the server reports. */
  image: Account.CompatSetting
  tools: Account.CompatSetting
}

const EMPTY_ROW: CompatRow = {
  id: "",
  context: "",
  outputLimit: "",
  input: "",
  cacheRead: "",
  output: "",
  image: "auto",
  tools: "auto",
}

/**
 * 5.4 API key step. The router tests the key while adding it (`accounts.add.key` probes first and stores only a
 * working key); the answer tells what the test detected (org, workspace later).
 */
function ApiKeyForm(props: {
  readonly kind: Kind.Api
  readonly onBack: () => void
  readonly onDone: (account: { readonly id: string; readonly providerID: string }, notes: readonly string[]) => void
}) {
  const data = useData()
  const i18n = useI18n()
  const own = data.local().own
  const existing = () =>
    own.state.accountOrder.flatMap((id) =>
      own.state.accounts[id]?.kind === props.kind ? [own.state.accounts[id]!.label] : [],
    )
  const [label, setLabel] = createSignal(defaultLabel(NAME_BASE[props.kind], existing()))
  const [key, setKey] = createSignal("")
  const [shown, setShown] = createSignal(false)
  const [color, setColor] = createSignal<Account.Color>(
    nextColor(own.state.accountOrder.map((id) => own.state.accounts[id]?.color)),
  )
  const [workspace, setWorkspace] = createSignal("")
  const [organization, setOrganization] = createSignal("")
  const [project, setProject] = createSignal("")
  const [baseURL, setBaseURL] = createSignal("")
  const [models, setModels] = createStore<CompatRow[]>([{ ...EMPTY_ROW }])
  const [busy, setBusy] = createSignal(false)
  const status = createStatus()
  const fallback = () => policyState()?.policy.credentialBackend === "opencode-credential"
  const compatText = useCompatText()

  const compatProblem = () => {
    if (props.kind !== "compat") return undefined
    if (!/^https?:\/\/\S+$/.test(baseURL().trim())) return i18n.t("own.acct.baseUrlNeeded")
    if (!models.length || models.some((row) => !row.id.trim() || !(parseTokens(row.context) ?? 0)))
      return i18n.t("own.acct.modelsNeeded")
    if (models.some((row) => !outputLimitOf(row.outputLimit).ok)) return compatText("own.compat.outputLimitInvalid")
    return undefined
  }
  const ready = () => !!label().trim() && !!key().trim() && !compatProblem()

  const paste = async () => {
    const text = await navigator.clipboard?.readText?.().catch(() => undefined)
    if (text) setKey(text.trim())
  }

  const submit = async () => {
    if (!ready() || busy()) return
    setBusy(true)
    status.clear()
    const secret = key().trim()
    // 16.3: the secret goes into the request body only and leaves the form state immediately.
    setKey("")
    const input: OwnAccounts.AddKeyInput = {
      kind: props.kind,
      label: label().trim(),
      key: secret,
      color: color(),
      options: options(),
    }
    await own.rpc
      .call("accounts.add.key", input)
      .then((result) => props.onDone(result.account, notes(result)))
      .catch((error: unknown) => status.error(errorMessage(i18n, error, (id) => own.state.accounts[id]?.label)))
    setBusy(false)
  }

  const options = (): OwnAccounts.AddKeyInput["options"] => {
    if (props.kind === "anth") return workspace().trim() ? { workspaceName: workspace().trim() } : undefined
    if (props.kind === "oai")
      return {
        ...(organization().trim() ? { organization: organization().trim() } : {}),
        ...(project().trim() ? { project: project().trim() } : {}),
      }
    if (props.kind !== "compat") return undefined
    return {
      baseURL: baseURL().trim(),
      models: models.map((row) => {
        const rates = [row.input, row.cacheRead, row.output].map((value) => (value.trim() ? Number(value) : undefined))
        const hasRates =
          rates[0] !== undefined &&
          rates[2] !== undefined &&
          rates.every((value) => value === undefined || Number.isFinite(value))
        const outputLimit = outputLimitOf(row.outputLimit)
        return {
          id: row.id.trim(),
          contextLimit: parseTokens(row.context),
          ...(outputLimit.ok && outputLimit.value !== undefined ? { outputLimit: outputLimit.value } : {}),
          // Left out on `auto`: the router then follows what the server reports.
          ...(row.image === "auto" ? {} : { image: row.image }),
          ...(row.tools === "auto" ? {} : { tools: row.tools }),
          ...(hasRates
            ? {
                cost: {
                  input: rates[0]!,
                  output: rates[2]!,
                  ...(rates[1] === undefined ? {} : { cacheRead: rates[1] }),
                },
              }
            : {}),
        }
      }),
    }
  }

  /** 5.4 test result and same-org / same-domain notes (information only; MVP always adds a separate account). */
  const notes = (result: { test: { detected?: Account.Detected }; sameDomainCandidates: readonly string[] }) => {
    const detected = result.test.detected
    const test =
      props.kind === "anth"
        ? i18n.t("own.accounts.testOkAnthropic")
        : detected?.organizationId
          ? i18n.t("own.accounts.testOkOrg", { org: shortID(detected.organizationId) })
          : i18n.t("own.accounts.testOk")
    const sameOrg = detected?.organizationId
      ? own.state.accountOrder
          .map((id) => own.state.accounts[id])
          .find(
            (account) => account?.kind === props.kind && account.identity?.organizationId === detected.organizationId,
          )
      : undefined
    const domain = result.sameDomainCandidates.map((id) => own.state.accounts[id]?.label ?? id)
    return [
      test,
      ...(sameOrg ? [i18n.t("own.accounts.sameOrg", { account: sameOrg.label })] : []),
      ...(domain.length
        ? [
            `${i18n.t("own.accounts.sameDomain", { account: domain.join(", ") })} · ${i18n.t("own.accounts.sameDomainNote")}`,
          ]
        : []),
    ]
  }

  return (
    <form
      class="flex flex-col gap-3"
      data-testid="api-key-form"
      data-kind={props.kind}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <TextField
        label={i18n.t("own.acct.name")}
        value={label()}
        onValue={setLabel}
        onEnter={() => void submit()}
        testid="key-label"
      />
      <div class="flex items-end gap-2">
        <div class="min-w-0 flex-1">
          <TextField
            label={i18n.t("own.acct.apiKey")}
            type={shown() ? "text" : "password"}
            value={key()}
            onValue={setKey}
            onEnter={() => void submit()}
            autocomplete="off"
            spellcheck={false}
            class="own-mono"
            testid="key-secret"
            autofocus
          />
        </div>
        <button type="button" class="own-btn" aria-pressed={shown()} onClick={() => setShown((value) => !value)}>
          {i18n.t(shown() ? "own.acct.hide" : "own.acct.show")}
        </button>
        <button type="button" class="own-btn" onClick={() => void paste()}>
          {i18n.t("own.acct.paste")}
        </button>
      </div>
      <Show when={props.kind === "anth"}>
        <TextField
          label={i18n.t("own.acct.workspaceName")}
          value={workspace()}
          onValue={setWorkspace}
          hint={i18n.t("own.acct.workspaceHint")}
        />
      </Show>
      <Show when={props.kind === "oai"}>
        <div class="grid grid-cols-1 gap-3 tablet:grid-cols-2">
          <TextField
            label={i18n.t("own.acct.orgID")}
            value={organization()}
            onValue={setOrganization}
            class="own-mono"
          />
          <TextField label={i18n.t("own.acct.projectID")} value={project()} onValue={setProject} class="own-mono" />
        </div>
      </Show>
      <Show when={props.kind === "compat"}>
        <CompatModelFields baseURL={baseURL()} onBaseURL={setBaseURL} models={models} setModels={setModels} />
      </Show>
      <div class="own-field">
        <span class="own-field-label">{i18n.t("own.acct.color")}</span>
        <ColorPicker value={color()} colors={COLORS} onChange={setColor} />
      </div>
      <p
        class="m-0 text-[12px] leading-[18px]"
        classList={{ "text-own-muted": !fallback(), "text-own-warn": fallback() }}
      >
        {i18n.t(fallback() ? "own.accounts.keyStorageFallback" : "own.accounts.keyStorage")}
      </p>
      <Show when={compatProblem() && (baseURL() || models[0]?.id)}>
        <p class="m-0 text-[12.5px] text-own-warn">{compatProblem()}</p>
      </Show>
      <StatusLine status={status} testid="key-status" />
      <div class="flex justify-end gap-2">
        <button type="button" class="own-btn" onClick={() => props.onBack()}>
          {i18n.t("own.acct.back")}
        </button>
        <button
          type="submit"
          class="own-btn"
          data-variant="primary"
          disabled={!ready() || busy()}
          data-testid="key-submit"
        >
          <Show when={busy()}>
            <Spinner />
          </Show>
          {i18n.t(busy() ? "own.acct.testing" : "own.acct.testAndAdd")}
        </button>
      </div>
    </form>
  )
}

/**
 * 5.4 compat fields: base URL (not secret), then per model the id, the context limit (required, it drives compaction
 * and switch warnings), the optional output cap (07 §6.2 #7: the server's value wins, empty = 32k shown as `모름`),
 * image input and tools (02 §3.3: 자동 / 켬 / 끔, `자동` follows the server) and optional rates ($/1M: input, cache
 * read, output). The browser never calls the base URL; the model list RPC is open
 * question 18, so ids are typed.
 */
function CompatModelFields(props: {
  readonly baseURL: string
  readonly onBaseURL: (value: string) => void
  readonly models: CompatRow[]
  readonly setModels: ReturnType<typeof createStore<CompatRow[]>>[1]
}) {
  const i18n = useI18n()
  const text = useCompatText()
  return (
    <div class="flex flex-col gap-2" data-testid="compat-fields">
      <TextField
        label={i18n.t("own.accounts.compat.baseURL")}
        value={props.baseURL}
        onValue={props.onBaseURL}
        placeholder="https://example.com/v1"
        class="own-mono"
        testid="compat-base-url"
      />
      <p class="m-0 text-[12.5px] font-semibold text-own-muted">{i18n.t("own.accounts.compat.model")}</p>
      <Index each={props.models}>
        {(row, index) => (
          <fieldset class="m-0 grid grid-cols-1 gap-2 rounded-lg border border-own-border p-2.5 tablet:grid-cols-[1.4fr_1fr]">
            <legend class="sr-only">{i18n.t("own.accounts.compat.model")}</legend>
            <TextField
              label={i18n.t("own.accounts.compat.modelManual")}
              value={row().id}
              onValue={(value) => props.setModels(index, "id", value)}
              class="own-mono"
              testid="compat-model-id"
            />
            <TextField
              label={i18n.t("own.accounts.compat.contextLimit")}
              value={row().context}
              onValue={(value) => props.setModels(index, "context", value)}
              inputMode="numeric"
              placeholder="128,000"
              testid="compat-model-context"
            />
            <div class="tablet:col-span-2">
              <TextField
                label={text("own.compat.outputLimit")}
                value={row().outputLimit}
                onValue={(value) => props.setModels(index, "outputLimit", value)}
                inputMode="numeric"
                placeholder={text("own.compat.outputLimitPlaceholder")}
                hint={text("own.compat.outputLimitHint")}
                error={outputLimitOf(row().outputLimit).ok ? undefined : text("own.compat.outputLimitInvalid")}
                testid="compat-model-output"
              />
            </div>
            <div class="tablet:col-span-2">
              <CapabilitySettings
                model={row().id || i18n.t("own.accounts.compat.model")}
                image={row().image}
                tools={row().tools}
                onImage={(value) => props.setModels(index, "image", value)}
                onTools={(value) => props.setModels(index, "tools", value)}
              />
            </div>
            <div class="tablet:col-span-2">
              <span class="own-field-label text-[12.5px] text-own-muted">{i18n.t("own.accounts.compat.rates")}</span>
              <div class="mt-1 grid grid-cols-3 gap-2">
                <TextField
                  label={i18n.t("own.acct.rateInput")}
                  value={row().input}
                  onValue={(value) => props.setModels(index, "input", value)}
                  inputMode="decimal"
                />
                <TextField
                  label={i18n.t("own.acct.rateCacheRead")}
                  value={row().cacheRead}
                  onValue={(value) => props.setModels(index, "cacheRead", value)}
                  inputMode="decimal"
                />
                <TextField
                  label={i18n.t("own.acct.rateOutput")}
                  value={row().output}
                  onValue={(value) => props.setModels(index, "output", value)}
                  inputMode="decimal"
                />
              </div>
              <Show when={!row().input.trim() || !row().output.trim()}>
                <p class="m-0 mt-1 text-[11.5px] text-own-faint">{i18n.t("own.accounts.compat.noRates")}</p>
              </Show>
            </div>
            <Show when={props.models.length > 1}>
              <div class="tablet:col-span-2">
                <button
                  type="button"
                  class="own-link"
                  onClick={() => props.setModels((rows) => rows.filter((_, position) => position !== index))}
                >
                  {i18n.t("own.acct.removeModel")}
                </button>
              </div>
            </Show>
          </fieldset>
        )}
      </Index>
      <p class="m-0 text-[11.5px] text-own-faint">{text("own.compat.settingsHint")}</p>
      <div>
        <button
          type="button"
          class="own-btn"
          data-size="sm"
          onClick={() => props.setModels(props.models.length, { ...EMPTY_ROW })}
        >
          {i18n.t("own.acct.addModel")}
        </button>
      </div>
    </div>
  )
}

/** 5.4 step 3: `계정이 추가되었습니다. 실행 중인 세션은 바뀌지 않습니다.` with `이 계정으로 새 세션` / `닫기`. */
function Done(props: {
  readonly account?: { readonly id: string; readonly providerID: string }
  readonly notes: readonly string[]
  readonly welcome?: boolean
  readonly onClose: () => void
}) {
  const i18n = useI18n()
  const router = useRouter()
  return (
    <div class="flex flex-col gap-2" data-testid="add-done">
      <Show when={props.welcome}>
        <PlanWelcome />
      </Show>
      <For each={props.notes}>{(note, index) => <Notice tone={index() === 0 ? "ok" : "info"}>{note}</Notice>}</For>
      <p class="m-0 mt-1 text-[13.5px] font-semibold">{i18n.t("own.accounts.added")}</p>
      <div class="mt-3 flex justify-end gap-2">
        <Show when={props.account}>
          {(account) => (
            <button
              type="button"
              class="own-btn"
              onClick={() => {
                requestNewSession({ accountID: account().id, providerID: account().providerID })
                props.onClose()
                router.navigate({ name: "home" })
              }}
            >
              {i18n.t("own.acct.newSessionWith")}
            </button>
          )}
        </Show>
        <button
          type="button"
          class="own-btn"
          data-variant="primary"
          onClick={() => props.onClose()}
          data-testid="add-close"
        >
          {i18n.t("own.kit.close")}
        </button>
      </div>
    </div>
  )
}
