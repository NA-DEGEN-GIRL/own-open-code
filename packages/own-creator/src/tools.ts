export * as CreatorTools from "./tools.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Permission } from "@opencode/schema/permission"
import type { Tool } from "@opencode/schema/tool"
import { Creator } from "@own/protocol/creator"
import { Portable } from "@own/protocol/portable"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Effect, Schema } from "effect"
import { Authored } from "./authored.js"
import { HarnessText } from "./harness.js"
import { Match } from "./match.js"
import { Rules } from "./rules.js"
import { Staging } from "./staging.js"
import type { CreatorState } from "./state.js"
import { CreatorStore } from "./store.js"
import { Runtime } from "./runtime.js"
import { Views } from "./views.js"

/**
 * Creator mode's two tools (17 §6.1), listed only in `creator` sessions (`Authored.GATE`):
 * - `creator_inspect` reads what exists (extensions, the format's JSON schema, agents, commands, skills, tools, the
 *   harnesses' 내 지시문); it never asks.
 * - `creator_manage` validates, creates, updates, turns on and off, rolls back, limits and removes extensions. Every
 *   write asks `creator` with a card of what it does, unless the conversation runs with full approval; read-only mode
 *   refuses writes. It never approves allow rules: that is Settings' alone.
 */

export const INSPECT = "creator_inspect"
export const MANAGE = "creator_manage"
/** The permission a write asks. */
export const ACTION = Rules.CreatorAsk.WRITE

type Ctx = Pick<Context, "tool" | "agent" | "command" | "skill" | "session" | "permission" | "rpc" | "location">

const TOPICS = [
  "overview",
  "extensions",
  "extension",
  "schema",
  "agents",
  "commands",
  "skills",
  "tools",
  "harness",
] as const
const ACTIONS = ["validate", "list", "create", "update", "enable", "disable", "rollback", "scope", "remove", "log"] as const

const InspectInput = Schema.Struct({
  topic: Schema.Literals(TOPICS),
  id: Schema.optionalKey(Schema.String),
})
const ManageInput = Schema.Struct({
  action: Schema.Literals(ACTIONS),
  id: Schema.optionalKey(Schema.String),
  extension: Schema.optionalKey(Schema.Unknown),
  version: Schema.optionalKey(Schema.Int),
  projects: Schema.optionalKey(Schema.Array(Schema.String)),
  note: Schema.optionalKey(Schema.String),
})
const decodeInspect = Schema.decodeUnknownResult(InspectInput)
const decodeManage = Schema.decodeUnknownResult(ManageInput)

/** JSON schema of the format, as `creator_inspect` `schema` shows it. */
const SCHEMA = Schema.toJsonSchemaDocument(Creator.Extension)

/** How creator mode stages code versions: Bun (the service's executable) and the npm registry. */
export interface StageOptions {
  readonly bun: string
  readonly registry?: string
}

export const register = (
  ctx: Ctx,
  state: CreatorState.State,
  reload: () => Effect.Effect<void>,
  staging: StageOptions,
) =>
  ctx.tool.transform((editor) => {
    editor.add({
      name: INSPECT,
      description:
        "Creator mode: reads what this app has and what an own extension can be. Topics: overview, extensions (the store), extension (one, with `id`: its versions and active manifest), schema (the own.ext/1 JSON schema and limits), agents, commands, skills, tools, harness (each harness's 내 지시문). Read-only; never asks.",
      input: {
        type: "object",
        properties: {
          topic: { type: "string", enum: [...TOPICS] },
          id: { type: "string", description: "Extension id, for topic `extension`" },
        },
        required: ["topic"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: Authored.GATE },
      execute: (raw: unknown) => inspect(ctx, state, raw),
    })
    editor.add({
      name: MANAGE,
      description:
        "Creator mode: changes own extensions. Actions: validate (check a manifest, no change), list, create (new extension from `extension`), update (new version of `extension.id`), enable, disable, rollback (`id`, `version`), scope (`id`, `projects`: absolute project folders, [] for every project), remove (`id`), log (`id`: the end of its log). Every change asks the user unless the conversation runs with full approval (code dependencies always ask); read-only mode refuses changes. A code extension (kind mcp or plugin) is staged first: install, typecheck, its tests, a smoke or e2e check; a failure writes nothing. Allow rules and code plugins stay off until the user approves them in Settings > 확장.",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          id: { type: "string" },
          extension: { type: "object", description: "An own.ext/1 manifest (validate, create, update)" },
          version: { type: "integer" },
          projects: { type: "array", items: { type: "string" } },
          note: { type: "string", description: "What this version changes, for the history" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: Authored.GATE },
      execute: (raw: unknown, call: Tool.Context) => manage(ctx, state, reload, staging, raw, call),
    })
  })

function inspect(ctx: Ctx, state: CreatorState.State, raw: unknown) {
  return Effect.gen(function* () {
    const input = decodeInspect(raw)
    if (input._tag === "Failure") return text({ error: "topic must be one of " + TOPICS.join(", ") })
    const topic = input.success.topic
    if (topic === "schema")
      return text({ format: Creator.FORMAT, itemTypes: Creator.ITEM_TYPES, limits: Creator.LIMITS, schema: SCHEMA })
    if (topic === "extensions" || topic === "overview") {
      const snapshot = yield* Effect.promise(() => state.store.read())
      const extensions = Views.views(snapshot).map((view) => ({
        id: view.id,
        title: view.title,
        status: view.status,
        active: view.active,
        projects: view.projects,
        loosenPending: view.loosenPending,
        effects: view.effects,
        problems: view.problems,
      }))
      if (topic === "extensions") return text({ root: state.store.root, extensions })
      return text({
        format: Creator.FORMAT,
        itemTypes: Creator.ITEM_TYPES,
        stages: stagesOf(state.snapshot),
        store: state.store.root,
        project: ctx.location.directory,
        extensions: extensions.map((item) => ({ id: item.id, title: item.title, status: item.status })),
        next: "Load the skill own-creator-extensions for the format and templates (own-creator-code for MCP servers and code plugins).",
      })
    }
    if (topic === "extension") {
      const id = input.success.id ?? ""
      const snapshot = yield* Effect.promise(() => state.store.read())
      const loaded = snapshot.loaded.find((item) => item.entry.id === id)
      if (loaded === undefined) return text({ error: `no extension '${id}'` })
      const active = yield* Effect.promise(() => state.store.version(id, loaded.entry.active))
      return text({ ...Views.view(loaded), manifest: active.ok ? active.raw : undefined })
    }
    if (topic === "agents") {
      const agents = yield* ctx.agent.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))
      return text(
        agents.data.map((agent) => ({
          id: agent.id,
          mode: agent.mode,
          hidden: agent.hidden,
          description: agent.description,
          model: agent.model,
        })),
      )
    }
    if (topic === "commands") {
      const commands = yield* ctx.command.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))
      return text(commands.data)
    }
    if (topic === "skills") {
      const skills = yield* ctx.skill.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))
      return text(
        skills.data.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          path: skill.path,
        })),
      )
    }
    if (topic === "tools") {
      const tools = yield* ctx.tool.list()
      return text(
        tools.map((tool) => ({
          name: tool.id,
          description: tool.description.slice(0, 200),
          codemode: tool.options?.codemode !== false,
        })),
      )
    }
    const harness = yield* ctx
      .rpc(Portable.definition(OwnHarness.Definition))
      .list({})
      .pipe(Effect.orElseSucceed(() => ({ error: "own.harness is not loaded here" })))
    return text({
      harness,
      note: "A harness's 내 지시문 is set with a `harness.instructions` item; sessions use it with the prompt variant `custom`.",
    })
  })
}

function manage(
  ctx: Ctx,
  state: CreatorState.State,
  reload: () => Effect.Effect<void>,
  staging: StageOptions,
  raw: unknown,
  call: Tool.Context,
) {
  return Effect.gen(function* () {
    const decoded = decodeManage(raw)
    if (decoded._tag === "Failure") return failed({ error: `action must be one of ${ACTIONS.join(", ")}` })
    const input = decoded.success
    const store = state.store
    const reserved = yield* reservedNames(ctx, state)
    if (input.action === "list") return text({ extensions: Views.views(yield* Effect.promise(() => store.read())) })
    if (input.action === "log") {
      const lines = yield* Effect.promise(() => Runtime.readLog(store.root, input.id ?? "", 120))
      return text({ id: input.id, lines })
    }
    if (input.action === "validate") {
      const checked = yield* Effect.promise(() =>
        store.check(input.extension, reserved, existing(state, input.extension)),
      )
      if (!checked.ok) return text({ ok: false, ...failure(checked) })
      return text({
        ok: true,
        effects: Creator.effects(checked.extension),
        card: Views.card("create", checked.extension.id, checked.extension),
      })
    }
    const target = targetOf(input)
    if (target === undefined) return failed({ error: "give `id` (or `extension` for create and update)" })
    const plan = yield* Effect.promise(() => planOf(store, input, reserved, state))
    if (!plan.ok) return failed({ ok: false, ...failure(plan) })
    const mode = yield* approvalMode(ctx, call)
    if (mode === "read-only")
      return failed({ error: "This conversation is read-only (읽기 전용): extensions cannot be changed here." })
    // Installing a code extension's dependencies always asks, whatever the mode (17 §11.4).
    if (mode !== "full" || plan.installs)
      yield* ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        action: ACTION,
        resources: plan.card,
        save: [],
        metadata: { creator: { action: input.action, id: target, effects: plan.effects } },
        source: { type: "tool", messageID: call.messageID, id: call.id },
      })
    // C3 only: staging runs the plugin's own code (the e2e hook check), which in the service means full file and
    // network access and the account tokens. It must not run before the user approves running it — a distinct card,
    // always, even under 전체 허용 (17 §12.3). The final activation approval stays (Settings' 이 판 승인).
    if (plan.code !== undefined && Creator.kindOf(plan.code) === "plugin")
      yield* ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        action: ACTION,
        resources: Views.runCard(plan.code.id),
        save: [],
        metadata: { creator: { action: "run-code", id: target, effects: plan.effects } },
        source: { type: "tool", messageID: call.messageID, id: call.id },
      })
    const staged = plan.code === undefined ? undefined : yield* Effect.promise(() => Staging.run(store, plan.code!, {
      bun: staging.bun,
      ...(staging.registry === undefined ? {} : { registry: staging.registry }),
    }))
    if (staged !== undefined && !staged.ok)
      return failed({
        ok: false,
        reason: "stage_failed",
        problems: staged.problems,
        checks: staged.checks,
        note: "Nothing was written; the active version stays as it was. Fix the files and try again.",
      })
    const outcome = yield* Effect.promise(() => apply(store, input, reserved, staged?.staged))
    if (!outcome.ok && staged !== undefined) yield* Effect.promise(() => Staging.discard(staged.staged))
    if (!outcome.ok) return failed({ ok: false, ...failure(outcome) })
    const harness = yield* HarnessText.sync(ctx, store, outcome.snapshot)
    yield* reload()
    const loaded = outcome.snapshot.loaded.find((item) => item.entry.id === outcome.id)
    return text({
      ok: true,
      action: input.action,
      id: outcome.id,
      ...(outcome.version === undefined ? {} : { version: outcome.version }),
      ...(loaded === undefined
        ? {}
        : { status: loaded.status, problems: loaded.problems, effects: Views.view(loaded).effects }),
      ...(harness.changed.length > 0 ? { harnessInstructions: harness.changed } : {}),
      ...(harness.unavailable
        ? { warning: "own.harness did not answer: the 내 지시문 items wait for the next change" }
        : {}),
      ...(loaded !== undefined && Views.view(loaded).loosenPending
        ? { pending: "Its allow rules stay off until the user approves them in Settings > 확장." }
        : {}),
      ...(loaded?.status === "pending"
        ? { trust: "This code plugin loads only after the user approves this version in Settings > 확장." }
        : {}),
      ...(staged === undefined ? {} : { checks: staged.checks }),
    })
  })
}

type ManageInput = typeof ManageInput.Type

function targetOf(input: ManageInput) {
  if (input.action === "create" || input.action === "update") return idOf(input.extension)
  return input.id
}

/** What a write will do, checked before anyone is asked: its card lines, or why it cannot be done. */
interface Plan {
  readonly ok: true
  readonly card: string[]
  readonly effects: ReadonlyArray<Creator.ItemEffect>
  /** A code extension to stage before the write. */
  readonly code?: Creator.Extension
  /** It installs dependencies, which always asks. */
  readonly installs?: boolean
}

async function planOf(
  store: CreatorStore.Store,
  input: ManageInput,
  reserved: CreatorStore.Reserved,
  state: CreatorState.State,
): Promise<Plan | CreatorStore.Failure> {
  if (input.action === "create" || input.action === "update") {
    const id = idOf(input.extension)
    const snapshot = await store.read()
    const exists = snapshot.file.extensions.some((entry) => entry.id === id)
    if (input.action === "create" && exists) return { ok: false, reason: "exists", id: id ?? "" }
    if (input.action === "update" && !exists) return { ok: false, reason: "not_found", id: id ?? "" }
    const checked = await store.check(
      input.extension,
      reserved,
      input.action === "update" ? id : existing(state, input.extension),
    )
    if (!checked.ok) return checked
    const kind = Creator.kindOf(checked.extension)
    if (kind === "plugin" && snapshot.file.settings?.plugins !== true) return { ok: false, reason: "plugins_off" }
    const next =
      input.action === "update"
        ? Math.max(0, ...snapshot.file.extensions.find((entry) => entry.id === id)!.versions.map((v) => v.n)) + 1
        : 1
    return {
      ok: true,
      card: Views.card(input.action, checked.extension.id, checked.extension, next),
      effects: Creator.effects(checked.extension),
      ...(kind === "declarative" ? {} : { code: checked.extension }),
      installs: checked.extension.items.some(
        (item) => item.type === "mcp.server" && Object.keys(item.dependencies ?? {}).length > 0,
      ),
    }
  }
  const snapshot = await store.read()
  const loaded = snapshot.loaded.find((item) => item.entry.id === input.id)
  if (loaded === undefined) return { ok: false, reason: "not_found", id: input.id ?? "" }
  if (input.action === "rollback") {
    const version = input.version ?? -1
    const target = await store.version(loaded.entry.id, version)
    if (!target.ok) return { ok: false, reason: "version_not_found", id: loaded.entry.id, version }
    return {
      ok: true,
      card: Views.card("rollback", loaded.entry.id, target.extension, version),
      effects: target.extension === undefined ? [] : Creator.effects(target.extension),
    }
  }
  const card = Views.card(input.action, loaded.entry.id, loaded.extension)
  if (input.action === "scope")
    return {
      ok: true,
      card: [
        ...card,
        (input.projects ?? []).length === 0 ? "· 모든 프로젝트" : `· ${(input.projects ?? []).join(", ")}`,
      ],
      effects: [],
    }
  return { ok: true, card, effects: loaded.extension === undefined ? [] : Creator.effects(loaded.extension) }
}

function apply(
  store: CreatorStore.Store,
  input: ManageInput,
  reserved: CreatorStore.Reserved,
  staged: CreatorStore.Staged | undefined,
): Promise<CreatorStore.Outcome> {
  const id = input.id ?? ""
  if (input.action === "create") return store.create(input.extension, "model", reserved, input.note, staged)
  if (input.action === "update") return store.update(input.extension, "model", reserved, input.note, staged)
  if (input.action === "enable") return store.enable(id, true, "model", reserved)
  if (input.action === "disable") return store.enable(id, false, "model")
  if (input.action === "rollback") return store.rollback(id, input.version ?? -1, "model", reserved)
  if (input.action === "scope") return store.scope(id, input.projects ?? [], "model")
  return store.remove(id)
}

/**
 * The approval mode the session's rules end with, read the way own's bundles write it (own-accounts
 * `SessionApproval`): `read-only` denies edits, `full` allows edits and commands, anything else asks.
 */
export const approvalMode = (ctx: Pick<Context, "session">, call: Pick<Tool.Context, "sessionID">) =>
  ctx.session.get({ sessionID: call.sessionID }).pipe(
    Effect.map((info) => modeOf(info.permissions ?? [])),
    Effect.orElseSucceed(() => "ask" as const),
  )

export function modeOf(rules: ReadonlyArray<Permission.Rule>) {
  const effect = (action: string) =>
    rules.findLast((rule) => Match.wildcard(rule.action, action) && (rule.resource === "*" || rule.resource === "**"))
      ?.effect
  const edit = effect("edit")
  if (edit === "deny") return "read-only" as const
  if (edit === "allow" && effect("shell") === "allow") return "full" as const
  return "ask" as const
}

/**
 * Names the app already uses that an extension may not take: agents, commands and tools that are not this store's own
 * (those are checked between extensions).
 */
const reservedNames = (ctx: Ctx, state: CreatorState.State) =>
  Effect.gen(function* () {
    const mine = new Set(
      state.snapshot.loaded.flatMap((loaded) =>
        loaded.extension === undefined
          ? []
          : loaded.extension.items.flatMap((item) => {
              if (item.type === "agent" || item.type === "command") return [`${item.type}:${item.name}`]
              if (item.type === "tool.command") return [`tool:${Creator.toolName(item.name)}`]
              return []
            }),
      ),
    )
    const agents = yield* ctx.agent.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))
    const commands = yield* ctx.command.list().pipe(Effect.orElseSucceed(() => ({ data: [] })))
    const tools = yield* ctx.tool.list()
    return {
      agents: new Set([
        Authored.AGENT,
        ...agents.data.map((agent) => agent.id as string).filter((id) => !mine.has(`agent:${id}`)),
      ]),
      commands: new Set(commands.data.map((command) => command.name).filter((name) => !mine.has(`command:${name}`))),
      tools: new Set(tools.map((tool) => tool.id).filter((name) => !mine.has(`tool:${name}`))),
    } satisfies CreatorStore.Reserved
  })

function existing(state: CreatorState.State, manifest: unknown) {
  const id = idOf(manifest)
  return state.snapshot.file.extensions.some((entry) => entry.id === id) ? id : undefined
}

function idOf(manifest: unknown) {
  if (typeof manifest !== "object" || manifest === null || !("id" in manifest)) return undefined
  return typeof manifest.id === "string" ? manifest.id : undefined
}

/** The stages this build runs: C0–C2 always, C3 while the switch is on. */
export function stagesOf(snapshot: CreatorStore.Snapshot) {
  return { declarative: true, mcp: true, plugin: snapshot.file.settings?.plugins === true }
}

function failure(result: CreatorStore.Failure) {
  if (result.reason === "plugins_off")
    return {
      reason: result.reason,
      note: "Code plugins are off (Settings > 고급 > 확장). Use a declarative item or an MCP server, or ask the user to turn them on.",
    }
  if (result.reason === "invalid" || result.reason === "scope_invalid")
    return { reason: result.reason, problems: result.problems }
  if (result.reason === "version_not_found") return { reason: result.reason, id: result.id, version: result.version }
  if (result.reason === "read_only") return { reason: result.reason, note: "Extensions are made on the PC only (17 §10)." }
  return { reason: result.reason, id: result.id }
}

function text(value: unknown): Tool.Result {
  return { content: JSON.stringify(value, null, 2) }
}

function failed(value: unknown): Tool.Result {
  return { content: JSON.stringify(value, null, 2), metadata: { isError: true } }
}
