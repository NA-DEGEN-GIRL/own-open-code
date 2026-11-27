export * as Hooks from "./hooks.js"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { Model } from "@opencode/schema/model"
import { CompactionCache } from "@own/protocol/compaction-cache"
import { Kind } from "@own/protocol/kind"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { DateTime, Effect } from "effect"
import { Baseline } from "./codex/baseline.js"
import type { Collab } from "./codex/collab.js"
import type { CollabV1 } from "./codex/collab-v1.js"
import { Checkpoint } from "./checkpoint.js"
import { Custom } from "./custom.js"
import { CodexCompaction } from "./codex/compaction.js"
import type { CodexEffort } from "./codex/effort.js"
import { ExecManager } from "./codex/exec/manager.js"
import { Fragments } from "./codex/fragments.js"
import { CodexReadOnly } from "./codex/read-only.js"
import { CodexRequest } from "./codex/request.js"
import { Fallback } from "./fallback.js"
import { History } from "./history.js"
import { DshErrors } from "./dsh/errors.js"
import { DshRequest } from "./dsh/request.js"
import { DshSeries } from "./dsh/series.js"
import { DshSnapshots } from "./dsh/snapshots.js"
import { PiRequest } from "./pi/request.js"
import { PiShell } from "./pi/shell.js"
import { Registry } from "./registry.js"
import { Served } from "./codex/served.js"

type Ctx = Pick<Context, "session" | "model" | "skill" | "location" | "agent" | "storage" | "rpc">

/** The route own's OpenAI slots use (02 §3.6): OpenAI Responses. */
export const RESPONSES_PACKAGE = "@opencode/ai/providers/openai"

/**
 * The request hooks (10 §3.3). The same transform runs for `context`, `compaction` and `generate` (02 §4.3 D2). A
 * `codex` session gets Codex's request, a `pi` session Pi's (12); any other session gets its history in its harness's
 * tool names and own's checkpoints in their rendered form, which leaves a session that never ran another harness or
 * compacted exactly as core built it. `fallback` is Options' `compactionFallback`.
 */
export const register = (ctx: Ctx, tree: Collab.Tree, treeV1: CollabV1.Tree, fallback: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const packages = new Map<string, string | undefined>()
    const series = new DshSeries.Memory()
    // Core names the AGENTS.md files it finds by real path (core/src/config/plugin/instruction.ts `fs.resolve`), so
    // the requests tell them apart against the Location's directory resolved the same way (Baseline.sources).
    const realCwd = yield* Effect.try({
      try: () => fs.realpathSync(path.resolve(ctx.location.directory)),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => ctx.location.directory))
    // Which shell Pi's bash runs on Windows, as a <rules> line of every pi request (12 §3.6); found once per process.
    const piGuidelines = PiShell.windowsGuidelines()
    // `record`: false for a side question (곁질문, own-accounts): shaped like the next sampling request, so its prefix
    // reads the same cache, but it leaves no dsh snapshot or series line behind.
    const transform = (event: SessionContext, kind: "context" | "compaction" | "generate", record = true) =>
      Effect.gen(function* () {
        const info = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.option)
        if (info._tag === "None") return undefined
        const harness = OwnHarness.harnessOf(info.value.metadata)
        const built = yield* build(event, kind, harness, info.value, record)
        // The Claude Agent provider sends Claude Code's prompt with an agent role and instructions it reads from these
        // options only; its own hooks, which run before this one, filled them from the system core built. A harness
        // that rebuilt the system hands all of it over as the role, so Claude gets the harness's prompt (with
        // everything it carries: AGENTS.md, own's entries, 내 지시문, skills) after Claude Code's, once.
        if (event.model.providerID === OwnHarness.CLAUDE_AGENT && DELIVERED.has(harness)) {
          event.options[OwnHarness.CLAUDE_AGENT_ROLE] = event.system.map((part) => part.text).join("\n\n")
          event.options[OwnHarness.CLAUDE_AGENT_INSTRUCTIONS] = ""
        }
        return built
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            warn("request_hook_failed", String(cause))
            return undefined
          }),
        ),
      )
    const build = (
      event: SessionContext,
      kind: "context" | "compaction" | "generate",
      harness: OwnHarness.HarnessID,
      info: Effect.Success<ReturnType<Ctx["session"]["get"]>>,
      record: boolean,
    ) =>
      Effect.gen(function* () {
        const checkpoints = yield* checkpointsOf(ctx, event)
        const prompt = OwnHarness.promptOf(info.metadata)
        // 내 지시문 is read at every request, so a save or a reset reaches the session's next request (10 §3.11).
        // `omo` has no 내 지시문: omo writes its own prompts per request (own-omo); `claude-code` sends Claude Code's.
        const userText =
          prompt === "custom" && harness !== "opencode" && harness !== "omo" && harness !== "claude-code"
            ? (yield* Custom.get(ctx, harness))?.text
            : undefined
        if (harness === "pi") {
          const responses = (yield* modelPackage(ctx, packages, event.model)) === RESPONSES_PACKAGE
          const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.option)
          const custom = agent._tag === "Some" ? agent.value.data.system : undefined
          const built = PiRequest.build(event, {
            cwd: ctx.location.directory,
            checkpoints,
            realCwd,
            responses,
            agentInstructions: custom ? event.system[0]?.text : undefined,
            skills: yield* sessionSkills(ctx, event),
            prompt,
            custom: userText,
            guidelines: piGuidelines,
          })
          return { history: built.history }
        }
        if (harness === "dsh") {
          const pkg = yield* modelPackage(ctx, packages, event.model)
          const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.option)
          const custom = agent._tag === "Some" ? agent.value.data.system : undefined
          const built = DshRequest.build(event, {
            cwd: ctx.location.directory,
            checkpoints,
            realCwd,
            model: { id: event.model.id, providerID: event.model.providerID },
            responses: pkg === RESPONSES_PACKAGE,
            agentInstructions: custom ? event.system[0]?.text : undefined,
            skills: (yield* sessionSkills(ctx, event)).map((skill) => ({
              name: skill.id,
              description: skill.description,
            })),
            prompt,
            custom: userText,
            mode: Fragments.mode(info.permissions, event.agent),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            home: os.homedir(),
            facts: yield* historyFacts(ctx, event.sessionID),
            snapshots: yield* DshSnapshots.read(ctx, event.sessionID),
          })
          if (kind === "context" && record && built.recorded !== undefined)
            yield* DshSnapshots.add(ctx, event.sessionID, built.recorded)
          // dsh's DeepSeek adapter asks for thinking at `high` when nothing chose an effort (llm-deepseek `serialize`);
          // own's DeepSeek variants already send dsh's thinking and effort pairs, so only a session without a variant
          // gets the default (13 §2.5). max_tokens stays core's: min(catalog output, 256,000), dsh's default for V4.
          const chosen = event.model.variant !== undefined && event.model.variant !== "default"
          if (pkg === DEEPSEEK_PACKAGE && !chosen && event.options.reasoningEffort === undefined)
            event.options.reasoningEffort = "high"
          if (kind === "context" && record) logSeries(series, event, built.history)
          return { history: built.history }
        }
        if (harness !== "codex") {
          event.messages = History.translate(event.messages, Registry.get(harness)).flatMap((entry) =>
            CodexCompaction.render(entry, checkpoints),
          )
          return undefined
        }
        // The served catalog first (10 §6.14): a model the account's list gives runs with its own row.
        yield* Served.refresh(ctx)
        const responses = (yield* modelPackage(ctx, packages, event.model)) === RESPONSES_PACKAGE
        const skills = yield* sessionSkills(ctx, event)
        const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(Effect.option)
        const custom = agent._tag === "Some" ? agent.value.data.system : undefined
        const built = CodexRequest.build(event, {
          model: event.model.id,
          checkpoints,
          sessionID: event.sessionID,
          agentPath: tree.path(event.sessionID, info.metadata as Record<string, unknown> | undefined),
          forked: yield* tree.forked(event.sessionID),
          effort: typeof event.options.reasoningEffort === "string" ? event.options.reasoningEffort : undefined,
          variant: event.model.variant,
          responses,
          cwd: ctx.location.directory,
          realCwd,
          mode: Fragments.mode(info.permissions, event.agent),
          // An agent that cannot be read may deny a search: own's websearch, which the permission hooks meet, goes.
          searchDenied:
            agent._tag === "None" || CodexRequest.searchDenied(event.agent, agent.value.data.permissions ?? []),
          reads: CodexReadOnly.answers(info.permissions, event.agent),
          shell: ExecManager.defaultShell().type,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          plan: event.agent === "plan",
          agentInstructions: custom ? event.system[0]?.text : undefined,
          skills,
          freeform: responses,
          // Claude Agent's tools are MCP tools, which take JSON only: Codex's apply_patch goes as a JSON `{input}` tool.
          jsonPatch: event.model.providerID === OwnHarness.CLAUDE_AGENT,
          prompt,
          custom: userText,
          // Sign in with ChatGPT refuses `configuration_update` (02 §3.2c); own-accounts' hook, which drops core's
          // effort markers there, runs before this one (plugin order), so Codex's updates are never made for it.
          effortUpdates: Kind.ProviderID.parse(event.model.providerID)?.kind !== "siwc",
          kind,
          ...(yield* historyMarks(ctx, event.sessionID)),
        })
        return { history: built.history, input: built.input }
      })
    yield* ctx.session.hook("context", (event) =>
      transform(event, "context").pipe(
        // A full-history fork of this agent copies what this request carried (collab.ts).
        Effect.map((built) => void (built && tree.remember(event.sessionID, built.history, built.input))),
      ),
    )
    // Compaction (P-025), the same for every harness and model (own/docs/11-compaction-prompt.md): own's checkpoint
    // prompt, checked and repaired once. It measured at least as good as Codex's and OpenCode's prompts for GPT, DeepSeek
    // and Claude, without an analysis step, which added output and no recall for any of them (§6.8). Tools stay in the
    // request so the prefix cache holds; the prompt forbids tool calls. The user messages Codex keeps go into the
    // checkpoint's metadata. When the compaction fails, other models stand in, then code makes the checkpoint (§3).
    //
    // Cache-preserving compaction (P-034, 11 §2.5): core runs these hooks on the whole history with its kept start
    // (`kept`) first. Only when own-accounts' verdict in the metadata says `full` (it asks only on a warm Anthropic
    // cache and may still decline once it sees the kept part, CC-12; no verdict, as without own-accounts, is the older
    // request on every provider, CC-16) does the first attempt send that whole history, the next primary request byte
    // for byte, with a prompt that names where the kept messages start; core then runs the hooks again on the older
    // part, which names none. The checkpoint's user messages and the model-free digest cover only the part before the
    // kept start, which `<recent-context>` holds after it. An idle compaction (own-accounts' trigger, 02 §4.7.7) gets no stand-ins or
    // digest: when it fails the session stays as it was.
    yield* ctx.session.hook("compaction", (event) =>
      Effect.gen(function* () {
        const built = yield* transform(event, "compaction")
        // Other harnesses condense the history core built, in their tool names.
        const whole = built?.history ?? event.messages
        const keptID = event.kept?.messageID
        const at = keptID === undefined ? -1 : whole.findIndex((message) => message.id === keptID)
        const kept = at < 0 ? undefined : Checkpoint.kept(whole, at)
        const history = kept === undefined ? whole : whole.slice(0, at)
        // own-accounts names its reason in the record when it declines the whole history (it runs first).
        const asked =
          CompactionCache.verdictOf(event.metadata)?.prefix === "full" &&
          event.metadata?.[CompactionCache.PREFIX_KEY] === undefined
        // A kept start this history does not show (or shows nothing to quote) keeps the older request.
        const missing = keptID !== undefined && kept === undefined
        const update = history.some((message) =>
          message.content.some((part) => part.type === "text" && Checkpoint.isCheckpoint(part.text)),
        )
        const idle = event.metadata?.[CompactionCache.TRIGGER_KEY] === "idle"
        const metadata = {
          ...event.metadata,
          [CodexCompaction.USER_MESSAGES_KEY]: CodexCompaction.retained(history),
          [CodexCompaction.FORMAT_KEY]: CodexCompaction.CHECKPOINT_FORMAT,
          ...(asked && missing ? { [CompactionCache.PREFIX_KEY]: { request: "older", reason: "declined" } } : {}),
        }
        if (asked && !missing) event.prefix = "full"
        event.prompt = Checkpoint.prompt({ update, ...(kept === undefined ? {} : { kept }) })
        event.accept = (reply) => {
          const parsed = Checkpoint.parse(reply)
          return parsed.ok ? parsed.checkpoint : undefined
        }
        event.repair = Checkpoint.repair()
        event.metadata = metadata
        event.fallbackModels = idle ? [] : yield* Fallback.standIns(ctx, fallback, event.model)
        event.fallback = idle
          ? undefined
          : (error) => ({ summary: Checkpoint.digest(history, error.message), metadata })
      }),
    )
    // A side question (own-accounts' 곁질문, core P-061 `side`) is a `generate` request that should be the next sampling
    // request byte for byte up to its question, so it takes the `context` shape (Codex's effort updates included).
    yield* ctx.session.hook("generate", (event) =>
      transform(event, event.side ? "context" : "generate", !event.side).pipe(Effect.asVoid),
    )
    // dsh reads an exhausted balance before a rate limit (dsh/errors.ts): a dsh session's backoff retry of one ends.
    // An immediate retry (another plugin moving the session to another account) stays.
    yield* ctx.session.hook("retry", (event) =>
      Effect.gen(function* () {
        if (!event.decision.retry || event.decision.delay <= 0 || !DshErrors.exhausted(event.error)) return
        const info = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.option)
        if (info._tag === "None" || OwnHarness.harnessOf(info.value.metadata) !== "dsh") return
        event.decision = { retry: false }
      }),
    )
  })

/** The harnesses that build their own system and hand it to the Claude Agent provider (`transform`). */
const DELIVERED: ReadonlySet<OwnHarness.HarnessID> = new Set(["codex", "pi", "dsh"])

/** dsh's native DeepSeek route (`@opencode/ai/providers/deepseek`), which dsh's DeepSeek adapter defaults apply to. */
export const DEEPSEEK_PACKAGE = "@opencode/ai/providers/deepseek"

/**
 * dsh's request-series reasons (dsh/series.ts) as one log line per primary request that opens or changes a series, so
 * a cache miss of a dsh session can be traced to its cause.
 */
function logSeries(series: DshSeries.Memory, event: SessionContext, history: ReadonlyArray<{ readonly role: string }>) {
  const print = DshSeries.print({
    model: `${event.model.providerID}/${event.model.id}`,
    options: event.options,
    tools: event.tools,
    system: event.system,
    messages: event.messages,
  })
  const result = series.record(
    event.sessionID,
    print,
    history.some((message) => message.role === "assistant"),
  )
  if (result.reason === undefined) return
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "info", scope: "own.harness", msg: "dsh_request_series", sessionID: event.sessionID, ...result })}\n`,
  )
}

/** Core's checkpoint metadata, read only when the request holds a checkpoint (`CodexCompaction.render`). */
function checkpointsOf(ctx: Ctx, event: SessionContext) {
  const held = event.messages.some(
    (message) =>
      message.role === "user" &&
      message.content[0]?.type === "text" &&
      message.content[0].text.startsWith("<conversation-checkpoint>\n"),
  )
  if (!held) return Effect.succeed<CodexCompaction.Checkpoints>(new Map())
  return ctx.session.context({ sessionID: event.sessionID }).pipe(
    Effect.map(CodexCompaction.checkpoints),
    Effect.orElseSucceed((): CodexCompaction.Checkpoints => new Map()),
  )
}

/** Each message's kind and times as dsh's request builder reads them (dsh/request.ts `Fact`). */
function historyFacts(ctx: Ctx, sessionID: SessionContext["sessionID"]) {
  return ctx.session.context({ sessionID }).pipe(
    Effect.map(
      (history): ReadonlyMap<string, DshRequest.Fact> =>
        new Map(
          history.map((message): [string, DshRequest.Fact] => {
            const created = millis(message.time.created)
            if (message.type !== "assistant")
              return [message.id, { kind: message.type === "user" ? "user" : "other", created }]
            const tools = message.content.flatMap((part) =>
              part.type === "tool" ? [millis(part.time.completed ?? part.time.created)] : [],
            )
            // A step's tools settle before the next step starts; a reply without tools settles when it streamed.
            const settled =
              tools.length > 0 ? Math.max(...tools) : millis(message.time.streamed ?? message.time.created)
            return [message.id, { kind: "assistant", created, settled }]
          }),
        ),
    ),
    Effect.orElseSucceed((): ReadonlyMap<string, DshRequest.Fact> => new Map()),
  )
}

function millis(value: DateTime.Utc | number) {
  return typeof value === "number" ? value : DateTime.toEpochMillis(value)
}

/** Message kinds that never reach the model; a turn's last visible message is the one before its `idle` marker. */
const INVISIBLE = new Set(["idle", "agent-switched", "model-switched"])

/**
 * From the session's history: the last visible message of every turn the user interrupted (`interrupted`), the
 * first visible message after each change of model to the model it changed to (`switches`, Codex's `<model_switch>`;
 * an account change on the same model is not one), and the model and variant each assistant message ran on (`steps`,
 * Codex's effort updates).
 */
function historyMarks(ctx: Ctx, sessionID: SessionContext["sessionID"]) {
  type Marks = { interrupted: Set<string>; switches: Map<string, string>; last?: string; pending?: string }
  return ctx.session.context({ sessionID }).pipe(
    Effect.map((history) => {
      const steps = new Map<string, CodexEffort.Step>(
        history.flatMap((message) =>
          message.type === "assistant"
            ? [[message.id, { model: message.model.id, variant: message.model.variant }] as const]
            : [],
        ),
      )
      const marks = history.reduce<Marks>(
        (state, message) => {
          if (message.type === "idle")
            return message.outcome === "interrupted" && state.last !== undefined
              ? { ...state, interrupted: new Set([...state.interrupted, state.last]) }
              : state
          if (message.type === "model-switched")
            return message.previous === undefined || message.previous.id === message.model.id
              ? state
              : { ...state, pending: message.model.id }
          // A context reset's marker (core P-035) renders nothing either, whether active or undone.
          if (INVISIBLE.has(message.type) || (message.type === "compaction" && message.reason === "reset")) return state
          if (state.pending === undefined) return { ...state, last: message.id }
          return {
            ...state,
            last: message.id,
            pending: undefined,
            switches: new Map([...state.switches, [message.id, state.pending]]),
          }
        },
        { interrupted: new Set(), switches: new Map() },
      )
      return { interrupted: marks.interrupted, switches: marks.switches, steps }
    }),
    Effect.orElseSucceed(() => ({
      interrupted: new Set<string>(),
      switches: new Map<string, string>(),
      steps: new Map<string, CodexEffort.Step>(),
    })),
  )
}

function modelPackage(ctx: Ctx, cache: Map<string, string | undefined>, model: Model.Ref) {
  const key = `${model.providerID}/${model.id}`
  if (cache.has(key)) return Effect.succeed(cache.get(key))
  return ctx.model.list().pipe(
    Effect.map(
      (list) => list.data.find((entry) => entry.providerID === model.providerID && entry.id === model.id)?.package,
    ),
    Effect.tap((found) => Effect.sync(() => cache.set(key, found))),
    Effect.orElseSucceed(() => undefined),
  )
}

/**
 * The skills the session's baseline lists, in its order, with their files (Codex lists skills by path) and their ids
 * (what own's `skill` tool takes, which dsh's catalog names). A skill the Location no longer loads (removed, or turned
 * off there by own.accounts' skill switches, SG) is left out at once, while the baseline still names it until core's
 * next skills delta: the Codex, Pi and dsh requests list skills near their start, so such a change rewrites what
 * follows (exported for its unit test).
 */
export function sessionSkills(ctx: Pick<Ctx, "skill">, event: Pick<SessionContext, "system">) {
  const baseline = event.system.find((part) => Baseline.isBaseline(part.text))
  const listed = baseline === undefined ? undefined : Baseline.parse(baseline.text).skills
  const ids = [...(listed ?? "").matchAll(/<id>([^<]*)<\/id>/g)].map((match) => match[1]!)
  if (ids.length === 0) return Effect.succeed([])
  return ctx.skill.list().pipe(
    Effect.map((list) =>
      ids.flatMap((id) => {
        const skill = list.data.find((entry) => entry.id === id)
        return skill === undefined ? [] : [{ id, name: skill.name, description: skill.description, path: skill.path }]
      }),
    ),
    Effect.orElseSucceed(() => []),
  )
}

function warn(message: string, detail: string) {
  process.stderr.write(
    `${JSON.stringify({ ts: Date.now(), level: "warn", scope: "own.harness", msg: message, detail })}\n`,
  )
}
