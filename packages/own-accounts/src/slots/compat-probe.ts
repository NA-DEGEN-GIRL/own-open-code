export * as CompatProbe from "./compat-probe.js"

import { Option, Schema } from "effect"
import type { Account, OwnAccounts, Registry } from "@own/protocol"
import { LocalModel } from "./local-model.js"
import { Templates } from "./templates.js"

/**
 * What a `compat` server tells about itself (07 §6.2 #2, #7, PG9; 02 §3.3): its software family, read from the answers
 * of its OpenAI-compatible `/models` and of its native endpoints, the output caps it reports per model, and each
 * model's image input and tools where the family's native API says (Ollama `/api/show`, LM Studio `/api/v1/models`
 * or `/api/v0/models`, llama.cpp `/props`; vLLM and other servers say nothing). The account's own auth headers go
 * only to the account's own base URL. Read when the account is added, at start for an account whose server or model
 * capabilities were never read, and on `accounts.test`; a server that does not answer changes nothing. Pure parts
 * (`apply`, `configure`, `classified`, `view`) turn what was read, set or observed into the registry and the
 * `accounts.list` view.
 */

/**
 * Server families whose context-overflow errors PG9 saw core classify as an overflow and recover from (07 §8.4 PG9).
 * The compat card drops its warning for every server of such a family. Empty until PG9 runs on real servers (a user
 * gate of T1); until then only an overflow own observed on the account itself drops it ({@link classified}).
 */
export const OVERFLOW_VERIFIED: ReadonlySet<Account.CompatFamily> = new Set()

/** One request to the server; a local server can be slow to answer while it loads a model. */
const TIMEOUT_MS = 3_000

export interface Input {
  /** The account's OpenAI-compatible base URL (`…/v1`). */
  readonly baseURL: string
  readonly headers: Readonly<Record<string, string>>
  /** The account's model ids. */
  readonly models: ReadonlyArray<string>
  readonly signal?: AbortSignal
}

export interface Result {
  readonly family: Account.CompatFamily
  /** Context windows the server reported, by model id (positive integers). */
  readonly contexts?: ReadonlyMap<string, number>
  /** Output caps the server reported, by model id (positive integers). */
  readonly outputs: ReadonlyMap<string, number>
  /** What the server reported of each account model's image input and tools; `{}` when it said nothing. */
  readonly capabilities: ReadonlyMap<string, Account.CompatDetected>
}

const Count = Schema.NullOr(Schema.Finite)

/** One `/models` entry with the fields some servers add (vLLM, llama.cpp, LM Studio, routers). */
const Entry = Schema.Struct({
  id: Schema.String,
  owned_by: Schema.optionalKey(Schema.NullOr(Schema.String)),
  max_model_len: Schema.optionalKey(Count),
  meta: Schema.optionalKey(Schema.NullOr(Schema.Struct({ n_ctx_train: Schema.optionalKey(Count) }))),
  max_output_tokens: Schema.optionalKey(Count),
  max_completion_tokens: Schema.optionalKey(Count),
  top_provider: Schema.optionalKey(Schema.NullOr(Schema.Struct({ max_completion_tokens: Schema.optionalKey(Count) }))),
  /** llama.cpp: what the model reads (`["text", "image"]` with a multimodal projector). */
  architecture: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ input_modalities: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))) })),
  ),
  /** Servers that name a model's effort levels (02 §3.3a): the levels and the one used when a request names none. */
  reasoning_efforts: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  default_reasoning_effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Routers (OpenRouter style): the request parameters a model takes, `reasoning` among them when it reasons. */
  supported_parameters: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
type Entry = typeof Entry.Type

const decodeList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) })),
)
const decodeEntry = Schema.decodeUnknownOption(Entry)
/** Ollama `GET /api/version`. */
const decodeVersion = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))
/** LM Studio `GET /api/v1/models`, the shape upstream's `lmstudio` discovery reads (`local-provider-lmstudio`). */
const decodeLMStudio = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ models: Schema.Array(Schema.Struct({ key: Schema.String, max_context_length: Schema.Finite })) }),
  ),
)
/** LM Studio `GET /api/v1/models` entries, read one by one: a model's vision and native tool use. */
const decodeLMStudioModels = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ models: Schema.Array(Schema.Unknown) })),
)
const decodeLMStudioModel = Schema.decodeUnknownOption(
  Schema.Struct({
    key: Schema.String,
    max_context_length: Schema.optionalKey(Count),
    capabilities: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          vision: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
          trained_for_tool_use: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
          /** Newer LM Studio: the reasoning settings a model takes (`off`/`on`, or effort levels). */
          reasoning: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({ allowed_options: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))) }),
            ),
          ),
        }),
      ),
    ),
  }),
)
/** LM Studio's older `GET /api/v0/models` entries: `type` `vlm` reads images, `capabilities` may list `tool_use`. */
const decodeLMStudioV0 = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    type: Schema.optionalKey(Schema.NullOr(Schema.String)),
    capabilities: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  }),
)
/**
 * Ollama `POST /api/show`: the model's Modelfile parameters, one `name value` per line, and its `capabilities`
 * (`completion`, `tools`, `vision`, …; absent from Ollama versions before 0.6.4).
 */
const decodeShow = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      parameters: Schema.optionalKey(Schema.NullOr(Schema.String)),
      capabilities: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
      /** The model's GGUF metadata; `<architecture>.context_length` is its trained window. */
      model_info: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    }),
  ),
)
/**
 * llama.cpp `GET /props`: `modalities.vision` is true while a multimodal projector is loaded (`--mmproj`);
 * `chat_template_caps.supports_tool_calls` says whether the loaded chat template renders tool calls.
 */
const decodeProps = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      modalities: Schema.optionalKey(Schema.NullOr(Schema.Struct({ vision: Schema.optionalKey(Schema.Boolean) }))),
      chat_template_caps: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ supports_tool_calls: Schema.optionalKey(Schema.Boolean) })),
      ),
    }),
  ),
)

/** Reads the server's family, output caps and model capabilities; `undefined` when its `/models` does not answer. */
export async function run(input: Input): Promise<Result | undefined> {
  return read(input, () => input.models)
}

/** Models {@link discover} reads in detail at most; a larger server lists the rest by id only. */
const DISCOVER_MAX = 40

export type Discovered =
  | { readonly ok: true; readonly result: Result; readonly models: ReadonlyArray<string> }
  | { readonly ok: false; readonly status?: number }

/**
 * A server not added yet (02 §3.3a `서버에서 불러오기`): every model its `/models` lists, the first
 * {@link DISCOVER_MAX} read like an account's models. `ok: false` with the HTTP status when `/models` did not answer.
 */
export async function discover(input: Omit<Input, "models">): Promise<Discovered> {
  const listed: { ids: ReadonlyArray<string>; status?: number } = { ids: [] }
  const result = await read({ ...input, models: [] }, (ids) => {
    listed.ids = ids
    return ids.slice(0, DISCOVER_MAX)
  }).catch(() => undefined)
  if (result) return { ok: true, result, models: listed.ids }
  const status = await fetch(`${input.baseURL.replace(/\/+$/, "")}/models`, {
    headers: { ...input.headers, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((response) => response.status)
    .catch(() => undefined)
  return { ok: false, ...(status === undefined ? {} : { status }) }
}

async function read(input: Input, pick: (listed: ReadonlyArray<string>) => ReadonlyArray<string>) {
  const base = root(input.baseURL)
  if (!base) return undefined
  const listed = Option.getOrUndefined(decodeList(await request(`${input.baseURL.replace(/\/+$/, "")}/models`, input)))
  if (!listed) return undefined
  const entries = listed.data.flatMap((entry) => Option.toArray(decodeEntry(entry)))
  const models = pick(entries.map((entry) => entry.id))
  const family = familyOf(entries) ?? (await native(base, input))
  const reported = new Map(
    entries.flatMap((entry): Array<[string, number]> => {
      const tokens = reportedOutput(entry)
      return tokens !== undefined && models.includes(entry.id) ? [[entry.id, tokens]] : []
    }),
  )
  const shown =
    family === "ollama" ? await Promise.all(models.map(async (id) => [id, await show(base, id, input)] as const)) : []
  const outputs = new Map([
    ...reported,
    ...shown.flatMap((entry): Array<[string, number]> => {
      const tokens = modelParameter(entry[1]?.parameters, "num_predict")
      return reported.has(entry[0]) || tokens === undefined ? [] : [[entry[0], tokens]]
    }),
  ])
  const natives =
    family === "ollama"
      ? new Map<string, Native>(
          shown.map((entry) => [entry[0], { detected: ollamaCapabilities(entry[0], entry[1]?.capabilities) }] as const),
        )
      : family === "lmstudio"
        ? await lmstudio(base, { ...input, models })
        : family === "llamacpp"
          ? await llamacpp(base, entries, { ...input, models })
          : new Map<string, Native>()
  const contexts = new Map(
    models.flatMap((id): Array<[string, number]> => {
      const entry = entries.find((item) => item.id === id)
      const shownModel = shown.find((item) => item[0] === id)?.[1]
      const tokens =
        positive(entry?.max_model_len) ??
        positive(entry?.meta?.n_ctx_train) ??
        natives.get(id)?.context ??
        modelParameter(shownModel?.parameters, "num_ctx") ??
        trainedWindow(shownModel?.model_info)
      return tokens === undefined ? [] : [[id, tokens]]
    }),
  )
  return {
    family,
    contexts,
    outputs,
    capabilities: new Map(
      models.map((id) => {
        const detected = natives.get(id)?.detected ?? {}
        const listedReasoning = entryReasoning(entries.find((entry) => entry.id === id))
        return [id, listedReasoning === undefined ? detected : { ...detected, reasoning: listedReasoning }] as const
      }),
    ),
  }
}

/** What a family's native API told about one model: its capabilities and, where it says, its window. */
interface Native {
  readonly detected: Account.CompatDetected
  readonly context?: number
}

/**
 * A model's reasoning as its `/models` entry gives it away (02 §3.3a): effort levels it names
 * (`reasoning_efforts`, with the default level), or a router's `supported_parameters` naming `reasoning_effort` or
 * `reasoning` (the usual three levels). `undefined` when the entry says nothing.
 */
function entryReasoning(entry: Entry | undefined): Account.Reasoning | undefined {
  const levels = entry?.reasoning_efforts?.filter((level) => level.length > 0) ?? []
  if (levels.length > 0)
    return {
      style: "effort",
      levels,
      ...(entry?.default_reasoning_effort ? { default: entry.default_reasoning_effort } : {}),
    }
  const parameters = entry?.supported_parameters ?? []
  if (parameters.includes("reasoning_effort") || parameters.includes("reasoning"))
    return { style: "effort", levels: ["low", "medium", "high"] }
  return undefined
}

/** `<architecture>.context_length` of an Ollama model's GGUF metadata. */
function trainedWindow(info: Readonly<Record<string, unknown>> | null | undefined) {
  const entry = Object.entries(info ?? {}).find((item) => item[0].endsWith(".context_length"))
  return typeof entry?.[1] === "number" ? positive(entry[1]) : undefined
}

/**
 * The server's native API root: the base URL without its trailing `/v1`, as upstream's Ollama and LM Studio discovery
 * derive it (`core/src/plugin/provider/{ollama,lmstudio}.ts` `configured`). `undefined` for a non-http(s) URL.
 */
export function root(baseURL: string) {
  if (!URL.canParse(baseURL)) return undefined
  const url = new URL(baseURL)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  const path = url.pathname.replace(/\/+$/, "")
  return `${url.origin}${path.endsWith("/v1") ? path.slice(0, -3) : path}`
}

/** A positive integer value of an Ollama Modelfile parameter (`num_ctx 8192`); `-1` and absent ones are none. */
export function modelParameter(parameters: string | null | undefined, name: string) {
  const match = new RegExp(`^\\s*${name}\\s+(\\d+)\\s*$`, "m").exec(parameters ?? "")
  return positive(match ? Number(match[1]) : undefined)
}

/** The body of a 2xx JSON answer within the timeout, else `undefined`. A JSON `body` is POSTed. Never throws. */
export async function request(
  url: string,
  input: Pick<Input, "headers" | "signal"> & { readonly body?: Readonly<Record<string, string>> },
) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const response = await fetch(url, {
    ...(input.body
      ? {
          method: "POST",
          headers: { ...input.headers, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(input.body),
        }
      : { headers: { ...input.headers, accept: "application/json" } }),
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  return response.text().catch(() => undefined)
}

/** An Ollama model's Modelfile parameter through `POST /api/show`. */
export async function parameter(base: string, model: string, name: string, input: Pick<Input, "headers" | "signal">) {
  return modelParameter((await show(base, model, input))?.parameters, name)
}

/**
 * `registry` with what the probe read stored on the `compat` account (07 §6.2 #7, 02 §3.3): the family (keeping an
 * overflow already observed), each reported output cap as `server`, which wins over the user's value and the
 * fallback, and what the server reported of each model's image input and tools (the user's settings stay). The slot's
 * own template registers the same caps, never above the model's window, and the capabilities that follow
 * ({@link Templates.compatCapabilities}). `undefined` when nothing changes.
 */
export function apply(registry: Registry.File, accountID: string, result: Result): Registry.File | undefined {
  const target = compatOf(registry, accountID)
  if (!target) return undefined
  const outputs = Object.fromEntries(
    target.template.models.flatMap((model): Array<[string, Account.CompatOutput]> => {
      const reported = result.outputs.get(model.id)
      return reported === undefined
        ? []
        : [[model.id, { tokens: Math.min(reported, model.limit.context), source: "server" }]]
    }),
  )
  const stored = target.account.compat?.capabilities
  const capabilities = Object.fromEntries(
    target.template.models.map((model) => [
      model.id,
      { ...stored?.[model.id], detected: result.capabilities.get(model.id) ?? {} },
    ]),
  )
  return commit(registry, target, {
    // `local` and `notLocal` (02 §3.3a) stay as they are.
    ...target.account.compat,
    server: {
      family: result.family,
      overflowClassified: target.account.compat?.server?.overflowClassified ?? false,
      reasoningRead: true,
    },
    outputs: { ...target.account.compat?.outputs, ...outputs },
    capabilities: { ...stored, ...capabilities },
  })
}

export type Configured =
  | { readonly ok: true; readonly registry: Registry.File | undefined }
  | { readonly ok: false; readonly unknown: ReadonlyArray<string> }

/**
 * `registry` with the user's image input and tools settings of a `compat` account's models (02 §3.3,
 * `accounts.update{compatCapabilities}`); the template registers what follows. A model id the account does not have
 * refuses the whole change. `registry: undefined` when nothing changes.
 */
export function configure(
  registry: Registry.File,
  accountID: string,
  settings: ReadonlyArray<OwnAccounts.CompatModelCapabilities>,
): Configured {
  const target = compatOf(registry, accountID)
  if (!target) return { ok: true, registry: undefined }
  const known = new Set(target.template.models.map((model) => String(model.id)))
  const unknown = settings.filter((item) => !known.has(item.id)).map((item) => item.id)
  if (unknown.length > 0) return { ok: false, unknown }
  const stored = target.account.compat?.capabilities
  const changed = Object.fromEntries(
    settings.map((item) => [item.id, Templates.compatSettings(stored?.[item.id], item)] as const),
  )
  return {
    ok: true,
    registry: commit(registry, target, { ...target.account.compat, capabilities: { ...stored, ...changed } }),
  }
}

/**
 * Whether the server of a `compat` account is read at start: its family was never read, nor its models' reasoning
 * (accounts added before 02 §3.3a), or a model's capabilities were not (accounts added before the capability settings,
 * models whose server never answered).
 */
export function due(account: Account.Info, models: ReadonlyArray<string>) {
  const compat = account.compat
  return !compat?.server?.reasoningRead || models.some((id) => compat.capabilities?.[id]?.detected === undefined)
}

/**
 * `registry` with a `compat` account made a local model of this format (02 §3.3a `로컬 모델로 바꾸기`) or `기타 OpenAI
 * 호환` again (`null`); the key, models and every setting stay, and the template registers the format's package and
 * variants. `undefined` when nothing changes.
 */
export function localize(
  registry: Registry.File,
  accountID: string,
  local: Account.Local | null,
): Registry.File | undefined {
  const target = compatOf(registry, accountID)
  if (!target) return undefined
  const current = target.account.compat ?? {}
  const keyless = current.local?.keyless
  const rest = Object.fromEntries(
    Object.entries(current).filter((entry) => entry[0] !== "local" && entry[0] !== "notLocal"),
  )
  return commit(
    registry,
    target,
    local === null
      ? { ...rest, notLocal: true }
      : { ...rest, local: { format: local.format, ...(keyless ? { keyless } : {}) } },
  )
}

/**
 * A `기타 OpenAI 호환` account that is a local model by its base URL (02 §3.3a): on this PC or the local network
 * ({@link LocalModel.isLocalURL}), no model with rates, not turned back by the user. Made one at start with its
 * server's format (Ollama, else Chat Completions).
 */
export function migratable(account: Account.Info, slot: Registry.Slot, models: ReadonlyArray<Registry.TemplateModel>) {
  return (
    account.kind === "compat" &&
    !slot.retired &&
    account.compat?.local === undefined &&
    account.compat?.notLocal === undefined &&
    LocalModel.isLocalURL(slot.baseURL) &&
    models.every((model) => model.cost.length === 0)
  )
}

/**
 * `registry` with the `compat` account marked as seen classifying a context overflow (07 §6.2 #2, PG9): core
 * recovered from one of its errors, so its card drops the warning. `undefined` when already marked.
 */
export function classified(registry: Registry.File, accountID: string): Registry.File | undefined {
  const account = registry.accounts.find((item) => item.id === accountID)
  if (!account || account.kind !== "compat" || account.compat?.server?.overflowClassified) return undefined
  const server = {
    ...account.compat?.server,
    family: account.compat?.server?.family ?? "other",
    overflowClassified: true,
  }
  return {
    ...registry,
    accounts: registry.accounts.map((item) =>
      item.id === accountID ? { ...item, compat: { ...item.compat, server } } : item,
    ),
  }
}

/**
 * `accounts.list` `compat` of a `compat` account (07 §6.2 #2, #7, #8; 02 §3.3): the server facts, where a PG9-verified
 * family counts as classified; each model's output cap with its source (a model without a stored one keeps its
 * registered cap, which only the 32k fallback can have produced); its image input and tools as registered with the
 * user's setting and what the server reported; and the running window of a local runtime server.
 */
export function view(
  account: Account.Info,
  models: ReadonlyArray<Registry.TemplateModel>,
  localWindow: (modelID: string) => Account.LocalWindow | undefined,
): Account.CompatView {
  const server = account.compat?.server
  return {
    ...(account.compat?.local ? { local: { format: account.compat.local.format } } : {}),
    ...(server
      ? {
          server: {
            family: server.family,
            overflowClassified: server.overflowClassified || OVERFLOW_VERIFIED.has(server.family),
          },
        }
      : {}),
    models: models.map((model) => {
      const output =
        account.compat?.outputs?.[model.id] ??
        (model.limit.output > 0 ? { tokens: model.limit.output, source: "fallback" as const } : undefined)
      const running = localWindow(model.id)
      const stored = account.compat?.capabilities?.[model.id]
      return {
        id: model.id,
        ...(output ? { output } : {}),
        ...(running ? { localWindow: running } : {}),
        image: capability(model.capabilities.input.includes("image"), stored?.image, stored?.detected?.image),
        tools: capability(model.capabilities.tools, stored?.tools, stored?.detected?.tools),
        reasoning: {
          setting: LocalModel.settingOf(stored),
          ...(stored?.detected?.reasoning === undefined ? {} : { detected: stored.detected.reasoning }),
          levels: model.variants.map((variant) => String(variant.id)),
        },
      }
    }),
  }
}

/** A live `compat` account with its slot and the slot's template. */
interface Target {
  readonly account: Account.Info
  readonly slot: Registry.Slot
  readonly template: Registry.ModelTemplate
}

function compatOf(registry: Registry.File, accountID: string): Target | undefined {
  const account = registry.accounts.find((item) => item.id === accountID)
  const slot = account && registry.slots[account.providerID]
  const template = slot && registry.modelTemplates[slot.modelTemplate]
  if (!account || account.kind !== "compat" || !slot || !template) return undefined
  return { account, slot, template }
}

/**
 * `registry` with `compat` stored on the account and the slot's template following it: each model's output cap (a
 * stored one, else as registered) and capabilities. Models whose values are already registered stay byte-identical.
 * `undefined` when nothing changes.
 */
function commit(registry: Registry.File, target: Target, compat: Account.Compat): Registry.File | undefined {
  const pkg = LocalModel.packageOf(compat)
  const format = compat.local?.format ?? "chat"
  const models = target.template.models.map((model) => {
    const tokens = compat.outputs?.[model.id]?.tokens ?? model.limit.output
    const stored = compat.capabilities?.[model.id]
    const capabilities = Templates.compatCapabilities(stored)
    const variants = LocalModel.variants(LocalModel.reasoningOf(stored), format, tokens)
    if (
      tokens === model.limit.output &&
      pkg === model.package &&
      Bun.deepEquals(capabilities, model.capabilities) &&
      Bun.deepEquals(variants, model.variants)
    )
      return model
    return { ...model, package: pkg, capabilities, variants, limit: { ...model.limit, output: tokens } }
  })
  const changed = models.some((model, index) => model !== target.template.models[index])
  if (!changed && Bun.deepEquals(target.account.compat, compat)) return undefined
  return {
    ...registry,
    accounts: registry.accounts.map((item) => (item.id === target.account.id ? { ...item, compat } : item)),
    modelTemplates: changed
      ? { ...registry.modelTemplates, [target.slot.modelTemplate]: { ...target.template, models } }
      : registry.modelTemplates,
  }
}

function capability(on: boolean, setting: "on" | "off" | undefined, detected: boolean | undefined) {
  return { on, setting: setting ?? ("auto" as const), ...(detected === undefined ? {} : { detected }) }
}

/**
 * The family the `/models` answer gives away: vLLM and llama.cpp name themselves in `owned_by` and add their window
 * fields, LM Studio answers `organization_owner`.
 */
function familyOf(entries: ReadonlyArray<Entry>): Account.CompatFamily | undefined {
  if (entries.some((entry) => entry.owned_by === "vllm" || positive(entry.max_model_len) !== undefined)) return "vllm"
  if (entries.some((entry) => entry.owned_by === "llamacpp" || positive(entry.meta?.n_ctx_train) !== undefined))
    return "llamacpp"
  if (entries.some((entry) => entry.owned_by === "organization_owner")) return "lmstudio"
  return undefined
}

/** Families that only their native endpoints give away: Ollama's `/api/version`, LM Studio's `/api/v1/models`. */
async function native(base: string, input: Input): Promise<Account.CompatFamily> {
  if (Option.isSome(decodeVersion(await request(`${base}/api/version`, input)))) return "ollama"
  if (Option.isSome(decodeLMStudio(await request(`${base}/api/v1/models`, input)))) return "lmstudio"
  return "other"
}

/** An Ollama model's `POST /api/show` answer, `undefined` when it does not answer. */
async function show(base: string, model: string, input: Pick<Input, "headers" | "signal">) {
  return Option.getOrUndefined(decodeShow(await request(`${base}/api/show`, { ...input, body: { model } })))
}

/**
 * An Ollama model's capabilities list: `vision`, `tools` and `thinking` are there or not; no list (older Ollama) says
 * nothing. A thinking model takes `reasoning_effort` on `/v1`: gpt-oss its three levels, any other on or off.
 */
function ollamaCapabilities(id: string, list: ReadonlyArray<string> | null | undefined): Account.CompatDetected {
  if (!list) return {}
  const thinking = list.includes("thinking")
  return {
    image: list.includes("vision"),
    tools: list.includes("tools"),
    reasoning: !thinking
      ? null
      : id.toLowerCase().includes("gpt-oss")
        ? { style: "effort", levels: ["low", "medium", "high"] }
        : { style: "toggle" },
  }
}

/** LM Studio's reasoning options of a model: effort levels, else `off`/`on` as a toggle; none listed = unknown. */
function lmstudioReasoning(options: ReadonlyArray<string> | null | undefined): Account.Reasoning | null | undefined {
  if (!options) return undefined
  const levels = options.filter((option) => option !== "off" && option !== "on")
  if (levels.length > 0) return { style: "effort", levels: options.includes("off") ? ["none", ...levels] : levels }
  return options.includes("on") ? { style: "toggle" } : null
}

/**
 * LM Studio models by key: `/api/v1/models` `capabilities.vision`, else the older `/api/v0/models` `type` (`vlm`). Only
 * native tool use counts as reported: LM Studio serves tools to every model (a model without native support through
 * its default tool prompt), so `trained_for_tool_use: false` says nothing.
 */
async function lmstudio(base: string, input: Input) {
  const listed = Option.getOrUndefined(decodeLMStudioModels(await request(`${base}/api/v1/models`, input)))
  const current = new Map(
    (listed?.models ?? []).flatMap((raw) =>
      Option.toArray(decodeLMStudioModel(raw)).map((model): [string, Native] => {
        const reasoning = lmstudioReasoning(model.capabilities?.reasoning?.allowed_options)
        const context = positive(model.max_context_length)
        return [
          model.key,
          {
            detected: {
              ...known({
                image: model.capabilities?.vision ?? undefined,
                tools: model.capabilities?.trained_for_tool_use === true ? true : undefined,
              }),
              ...(reasoning === undefined ? {} : { reasoning }),
            },
            ...(context === undefined ? {} : { context }),
          },
        ]
      }),
    ),
  )
  if (input.models.every((id) => current.get(id)?.detected.image !== undefined)) return current
  const older = Option.getOrUndefined(decodeList(await request(`${base}/api/v0/models`, input)))
  const legacy = new Map(
    (older?.data ?? []).flatMap((raw) =>
      Option.toArray(decodeLMStudioV0(raw)).map((model): [string, Account.CompatDetected] => [
        model.id,
        known({
          image: model.type === "vlm" ? true : model.type === "llm" ? false : undefined,
          tools: model.capabilities?.includes("tool_use") ? true : undefined,
        }),
      ]),
    ),
  )
  return new Map(
    input.models.map((id) => {
      const now = current.get(id)
      return [id, { ...now, detected: { ...legacy.get(id), ...now?.detected } }] as const
    }),
  )
}

/**
 * llama.cpp's `/props` describes the model it serves: `modalities.vision` and the chat template's tool calls (true
 * unless probing the template found it never renders tools). A server routing several models (router mode) answers
 * per model with `?model=`, which a single-model server ignores. Without `/props`, the `/models` entry's
 * `architecture.input_modalities` still tells image input.
 */
async function llamacpp(base: string, entries: ReadonlyArray<Entry>, input: Input) {
  const answers = await Promise.all(
    input.models.map(async (id) => {
      const props = Option.getOrUndefined(
        decodeProps(await request(`${base}/props?model=${encodeURIComponent(id)}`, input)),
      )
      const modalities = entries.find((entry) => entry.id === id)?.architecture?.input_modalities
      return [
        id,
        {
          detected: known({
            image: props?.modalities?.vision ?? modalities?.includes("image"),
            tools: props?.chat_template_caps?.supports_tool_calls,
          }),
        },
      ] as const
    }),
  )
  return new Map<string, Native>(answers)
}

/** The reported fields only. */
function known(detected: { readonly image: boolean | undefined; readonly tools: boolean | undefined }) {
  return {
    ...(detected.image === undefined ? {} : { image: detected.image }),
    ...(detected.tools === undefined ? {} : { tools: detected.tools }),
  }
}

function reportedOutput(entry: Entry) {
  return (
    positive(entry.max_output_tokens) ??
    positive(entry.max_completion_tokens) ??
    positive(entry.top_provider?.max_completion_tokens)
  )
}

function positive(value: number | null | undefined) {
  return value !== null && value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined
}
