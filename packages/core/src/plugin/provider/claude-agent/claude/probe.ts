export * as ClaudeProbe from "./probe.js"

import type { AccountInfo, ModelInfo, Options, Query } from "@anthropic-ai/claude-agent-sdk"
import { Effect, Schema } from "effect"
import { ClaudeSDK } from "./sdk.js"

export interface Model extends ModelInfo {
  contextWindow?: number
}

export interface Result {
  readonly version: string | undefined
  readonly account: AccountInfo
  readonly models: readonly Model[]
  // OWN-PATCH(P-060) begin
  // The models this check asked for their window (each answered or failed); absent from a chat's startup report.
  readonly discovered?: readonly string[]
  // OWN-PATCH(P-060) end
}

export class ProbeError extends Schema.TaggedError<ProbeError>()("ClaudeProbe.ProbeError", {
  cause: Schema.Defect(),
}) {}

// Older binaries silently ignore verbatimPrompts and can interpret user text as Claude commands.
const MINIMUM_VERSION = "2.1.248"
// Older binaries do not support summary-only context usage. Their models keep the conservative fallback.
const CONTEXT_DISCOVERY_VERSION = "2.1.257"

export function versionError(version: string | undefined) {
  // OWN-PATCH(P-051) begin
  // own: only a version known to be too old blocks a chat. A Claude Code from before the initialize reply's
  // `claude_code_version` field (2.1.282 leaves it out) is read through `claude --version` (resolveVersion); when
  // neither answers, the check is skipped (fail open): the chat itself shows whether the binary works.
  if (!version || atLeast(version, MINIMUM_VERSION)) return
  return new Error(
    `Claude Code ${version} 버전은 너무 오래돼서 own에서 쓸 수 없어요(${MINIMUM_VERSION} 이상 필요). ` +
      "own은 이 PC에 설치된 Claude Code를 실행해요. 터미널에서 `claude update`로 업데이트한 뒤 다시 보내 주세요.",
  )
  // OWN-PATCH(P-051) end
}

// OWN-PATCH(P-051) begin
// Reads a Claude Code binary's version from its `--version` (ClaudeIO.version).
export type ReadVersion = (
  executable: string,
  env: Readonly<Record<string, string | undefined>>,
) => Promise<string | undefined>

// The version the process reported, else what its binary's `--version` prints; undefined when neither answers.
export async function resolveVersion(reported: string | undefined, options: Options, read: ReadVersion | undefined) {
  if (reported) return reported
  if (!read || !options.pathToClaudeCodeExecutable) return undefined
  return read(options.pathToClaudeCodeExecutable, options.env ?? {}).catch(() => undefined)
}
// OWN-PATCH(P-051) end

// Compares release numbers like 2.1.248. A pre-release or build suffix is ignored.
function atLeast(version: string, minimum: string) {
  const parse = (value: string) => value.split(/[-+]/)[0].split(".").map(Number)
  const current = parse(version)
  const required = parse(minimum)
  const index = required.findIndex((part, position) => (current[position] ?? 0) !== part)
  return index === -1 || (current[index] ?? 0) > required[index]
}

// The input never sends a message, so no model call is made and no tokens are used.
export const run = Effect.fn("ClaudeProbe.run")(function* (
  options: Options,
  // OWN-PATCH(P-051) begin
  readVersion?: ReadVersion,
  // OWN-PATCH(P-051) end
) {
  const stop = Promise.withResolvers<void>()
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async () => {
        const { query } = await ClaudeSDK.load()
        return query({ prompt: waitFor(stop.promise), options: { ...options, persistSession: false } })
      },
      catch: (cause) => new ProbeError({ cause }),
    }),
    (session) =>
      Effect.gen(function* () {
        const init = yield* Effect.tryPromise({
          try: () => session.initializationResult(),
          catch: (cause) => new ProbeError({ cause }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(new ProbeError({ cause: new Error("claude did not start within 30 seconds") })),
          }),
        )
        // No prompt is sent here, so an old Claude Code can still list its models.
        // The version is checked when a chat starts, and that chat's error tells the user to update.
        // OWN-PATCH(P-051) begin
        const version = yield* Effect.promise(() => resolveVersion(init.claude_code_version, options, readVersion))
        if (!version)
          yield* Effect.logWarning("Claude Code did not report its version; the compatibility check is skipped")
        // OWN-PATCH(P-051) end
        const models: Model[] = init.models.map((model) => ({ ...model }))
        // OWN-PATCH(P-060) begin
        if (!version || !atLeast(version, CONTEXT_DISCOVERY_VERSION))
          return { version, account: init.account, models } satisfies Result
        const discovered = yield* discoverContext(session, models)
        return { version, account: init.account, models, discovered } satisfies Result
        // OWN-PATCH(P-060) end
      }),
    (session) =>
      Effect.sync(() => {
        stop.resolve()
        session.close()
      }),
  )
})

// Sets each model's context window in place, so models discovered before a timeout keep theirs.
// OWN-PATCH(P-060) begin
// own: each model has its own 15 s (a subscription login checks access per model, and one slow answer took the shared
// 30 s from every model after it, leaving them on the 200k fallback). Answers the models it asked, answered or not.
const discoverContext = Effect.fn("ClaudeProbe.discoverContext")(function* (session: Query, models: readonly Model[]) {
  const asked: string[] = []
  for (const model of models) {
    if (model.value === "default") continue
    asked.push(model.value)
    yield* Effect.tryPromise(async () => {
      await session.setModel(model.value)
      const usage = await session.getContextUsage({ detail: "summary" })
      // rawMaxTokens is capacity; maxTokens can reflect Claude's own compaction window.
      if (!Number.isSafeInteger(usage.rawMaxTokens) || usage.rawMaxTokens <= 0) {
        throw new Error("Claude Code did not report a valid context window")
      }
      model.contextWindow = usage.rawMaxTokens
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        // A stuck control must not become a login failure. Closing this query cancels the pending request.
        orElse: () => Effect.fail(new Error("timed out")),
      }),
      Effect.catch((error) =>
        Effect.logWarning("Claude Code context discovery failed", {
          model: model.value,
          cause: error,
        }),
      ),
    )
  }
  return asked
})
// OWN-PATCH(P-060) end

// OWN-PATCH(P-039) begin
// Plan windows of an account folder without a chat: start claude with no prompt, ask for usage, close. claude asks
// claude.ai's usage endpoint; no model call is made.
export async function usage(options: Options) {
  const { query } = await ClaudeSDK.load()
  const stop = Promise.withResolvers<void>()
  const session = query({ prompt: waitFor(stop.promise), options: { ...options, persistSession: false } })
  const timer = setTimeout(() => session.close(), 30_000)
  try {
    await session.initializationResult()
    return await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
  } finally {
    clearTimeout(timer)
    stop.resolve()
    session.close()
  }
}
// OWN-PATCH(P-039) end

export function isLoggedIn(account: AccountInfo) {
  return account.tokenSource !== "none" || account.apiKeySource !== undefined
}

export function loginMessage(configDir: string | undefined) {
  if (!configDir) return "Claude Code is not logged in. Run `claude auth login` in a terminal."
  if (process.platform === "win32")
    return `Claude Code is not logged in. Run \`$env:CLAUDE_CONFIG_DIR = "${configDir}"; claude auth login\` in PowerShell.`
  return `Claude Code is not logged in. Run \`CLAUDE_CONFIG_DIR="${configDir}" claude auth login\` in a terminal.`
}

async function* waitFor(done: Promise<void>): AsyncGenerator<never> {
  await done
}
