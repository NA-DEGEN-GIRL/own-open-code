import path from "node:path"
import { claudeFolder, claudeSession, writeJsonl, writeText, type WriteOptions } from "./make.js"

/**
 * Synthetic Claude Code conversations (09 §7.3), built from the record shapes the research notes list (key names,
 * record types and block types only) and the Claude Agent SDK's documented readers. Nothing here is copied or cut
 * from a real `~/.claude`. A {@link Session} appends records the way Claude Code does: one record per content block
 * of a response (same `message.id` and `usage`), every record a child of the previous one unless a test branches,
 * metadata records (`custom-title`, `last-prompt`, …) without a uuid. The scenario builders below are the IG2
 * fixtures; each takes the Claude Code version to stamp on its records.
 */

/** The releases the fixtures are written for (09 §7.4 IG2: one fixture set per version). */
export const VERSIONS = ["2.1.281", "2.1.288"] as const
export type Version = (typeof VERSIONS)[number]

export const START = Date.UTC(2026, 9, 1, 9)
export const MODEL = "claude-fixture-opus"

export type Block = Readonly<Record<string, unknown>>

export const text = (value: string): Block => ({ type: "text", text: value })
export const thinking = (value: string): Block => ({
  type: "thinking",
  thinking: value,
  signature: "RkFLRS1zaWduYXR1cmU=",
})
export const redacted = (): Block => ({ type: "redacted_thinking", data: "RkFLRS1yZWRhY3RlZA==" })
export const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input })
export const image = (mime: string, data: string): Block => ({
  type: "image",
  source: { type: "base64", media_type: mime, data },
})

export interface SessionInput {
  readonly cwd: string
  /** The session id (the file name); a UUID. */
  readonly id: string
  readonly version: Version | string
  readonly branch?: string
  readonly start?: number
}

interface RecordOptions {
  /** The parent record; default the last record appended (`null` starts a new root). */
  readonly parent?: string | null
  /** The record's uuid; default the next deterministic one. */
  readonly uuid?: string
  /** Fields merged into the record (`isMeta`, `origin`, `toolUseResult`, …). */
  readonly extra?: Readonly<Record<string, unknown>>
}

export type Session = ReturnType<typeof session>

/**
 * One conversation's records. Every record gets a deterministic uuid and a timestamp one second after the previous
 * one. Release 2.1.288 also writes the newer fields (`entrypoint: "claude-desktop"`, `promptId`, `requestId`) and a
 * `file-history-delta` record, so the reader is checked against both shapes.
 */
export function session(input: SessionInput) {
  const records: Array<Record<string, unknown>> = []
  const state = { count: 0, last: null as string | null, clock: input.start ?? START, cwd: input.cwd }
  const newer = input.version >= "2.1.288"
  const prefix = input.id.slice(0, 8)

  const uuid = () => `${prefix}-0000-4000-8000-${String(++state.count).padStart(12, "0")}`
  const tick = () => {
    state.clock += 1000
    return new Date(state.clock).toISOString()
  }
  const envelope = (type: string, options: RecordOptions = {}) => {
    const id = options.uuid ?? uuid()
    const parent = options.parent === undefined ? state.last : options.parent
    state.last = id
    return {
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      cwd: state.cwd,
      sessionId: input.id,
      version: input.version,
      gitBranch: input.branch ?? "main",
      ...(newer ? { entrypoint: "claude-desktop" } : { entrypoint: "cli" }),
      type,
      uuid: id,
      timestamp: tick(),
    }
  }
  /** The uuid the next record will get: a boundary names the summary record that follows it. */
  const next = () => `${prefix}-0000-4000-8000-${String(state.count + 1).padStart(12, "0")}`
  const push = (record: Record<string, unknown>) => {
    records.push(record)
    return String(record.uuid)
  }

  return {
    get last() {
      return state.last
    },
    /** Changes the cwd of the records that follow (a `/cd` or a Desktop worktree move). */
    move(cwd: string) {
      state.cwd = cwd
    },
    /** A human message: a string or content blocks. */
    user(content: string | ReadonlyArray<Block>, options: RecordOptions = {}) {
      return push({
        ...envelope("user", options),
        message: { role: "user", content },
        ...(newer ? { promptId: `prompt-${state.count}` } : {}),
        ...options.extra,
      })
    },
    /**
     * One response: one record per block (Claude Code's split responses), all with the same `message.id` and the
     * same full `usage`; `split: false` writes all blocks in one record.
     */
    assistant(
      blocks: ReadonlyArray<Block>,
      options: RecordOptions & {
        readonly id: string
        readonly model?: string
        readonly usage?: Readonly<Record<string, number>>
        readonly split?: boolean
      },
    ) {
      const usage = options.usage ?? {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      }
      const groups = options.split === false ? [blocks] : blocks.map((block) => [block])
      return groups.map((group, index) =>
        push({
          ...envelope("assistant", index === 0 ? options : {}),
          message: {
            model: options.model ?? MODEL,
            id: options.id,
            type: "message",
            role: "assistant",
            content: group,
            stop_reason: null,
            usage,
          },
          ...(newer ? { requestId: `req_FAKE${options.id}` } : {}),
          ...options.extra,
        }),
      )
    },
    /** A tool result record: the model-visible `content` and the UI-only `toolUseResult`. */
    result(
      toolUseId: string,
      content: string | ReadonlyArray<Block>,
      options: RecordOptions & { readonly error?: boolean; readonly toolUseResult?: unknown } = {},
    ) {
      return push({
        ...envelope("user", options),
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUseId, content, ...(options.error ? { is_error: true } : {}) },
          ],
        },
        ...(options.toolUseResult === undefined ? {} : { toolUseResult: options.toolUseResult }),
        ...options.extra,
      })
    },
    /**
     * A `compact_boundary`: a new root (`parentUuid: null`) pointing back at the last message before it with
     * `logicalParentUuid`, and with `preservedSegment` when `preserved` is given (newer releases).
     */
    boundary(options: {
      readonly logicalParent: string
      readonly trigger?: string
      readonly preTokens?: number
      readonly postTokens?: number
      readonly preserved?: { readonly head: string; readonly tail: string; readonly anchor?: string }
    }) {
      return push({
        ...envelope("system", { parent: null }),
        subtype: "compact_boundary",
        content: "Conversation compacted",
        level: "info",
        isMeta: false,
        logicalParentUuid: options.logicalParent,
        compactMetadata: {
          trigger: options.trigger ?? "auto",
          preTokens: options.preTokens ?? 180_000,
          postTokens: options.postTokens ?? 12_000,
          durationMs: 4200,
          ...(options.preserved === undefined
            ? {}
            : {
                preservedSegment: {
                  anchorUuid: options.preserved.anchor ?? next(),
                  headUuid: options.preserved.head,
                  tailUuid: options.preserved.tail,
                },
              }),
        },
      })
    },
    /** The `isCompactSummary` user record that follows a boundary. */
    summary(body: string, options: RecordOptions = {}) {
      return push({
        ...envelope("user", options),
        message: { role: "user", content: body },
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      })
    },
    /** An `attachment` record (Claude Code's own context, or a `queued_command`). */
    attachment(attachment: Readonly<Record<string, unknown>>, options: RecordOptions = {}) {
      return push({ ...envelope("attachment", options), attachment, ...options.extra })
    },
    /** A prompt queued while the tool worked. */
    queued(
      prompt: string,
      options: RecordOptions & {
        readonly origin?: string
        readonly commandMode?: string
        readonly isMeta?: boolean
        readonly sourceUuid?: string
      } = {},
    ) {
      return push({
        ...envelope("attachment", options),
        ...(options.isMeta ? { isMeta: true } : {}),
        attachment: {
          type: "queued_command",
          prompt,
          commandMode: options.commandMode ?? "prompt",
          ...(options.origin === undefined ? {} : { origin: { kind: options.origin } }),
          ...(options.sourceUuid === undefined ? {} : { source_uuid: options.sourceUuid }),
          timestamp: new Date(state.clock).toISOString(),
        },
      })
    },
    /** A `system` record of another subtype (`stop_hook_summary`, `local_command`, …). */
    system(subtype: string, options: RecordOptions = {}) {
      return push({ ...envelope("system", options), subtype, content: "", level: "info" })
    },
    /** A record without a uuid (`custom-title`, `ai-title`, `last-prompt`, `relocated`, `cost-state`, …). */
    meta(record: Readonly<Record<string, unknown>>) {
      records.push({ ...record, sessionId: input.id })
    },
    /** A record appended as is (an unknown type, a broken shape). */
    raw(record: Readonly<Record<string, unknown>>) {
      records.push({ ...record })
    },
    /** Release 2.1.288 records file-history deltas; older ones do not. Either way they are metadata. */
    history() {
      if (newer)
        records.push({
          type: "file-history-delta",
          messageId: state.last,
          trackingPath: "src/a.ts",
          backup: { backupFileName: null, backupTime: new Date(state.clock).toISOString(), version: 1 },
          timestamp: new Date(state.clock).toISOString(),
        })
    },
    records: () => records,
  }
}

/** Writes a session to `<root>/projects/<folder of cwd>/<id>.jsonl` and returns the file. */
export function write(root: string, input: SessionInput, built: Session, options: WriteOptions = {}) {
  return writeJsonl(claudeSession(root, input.cwd, input.id), built.records(), options)
}

/** `<root>/projects/<folder>/<id>/` (sub-agents, `custom-title.json`, `tool-results/`). */
export function sessionFolder(root: string, cwd: string, id: string) {
  return path.join(root, "projects", claudeFolder(cwd), id)
}

/** A sub-agent transcript and its `.meta.json` (`subagents/[nested/]agent-<agentId>.jsonl`). */
export async function subagent(
  root: string,
  input: {
    readonly cwd: string
    readonly sessionId: string
    readonly agentId: string
    readonly nested?: string
    readonly records: ReadonlyArray<unknown>
    readonly meta?: Readonly<Record<string, unknown>>
  },
) {
  const folder = path.join(
    sessionFolder(root, input.cwd, input.sessionId),
    "subagents",
    ...(input.nested ? [input.nested] : []),
  )
  const file = await writeJsonl(path.join(folder, `agent-${input.agentId}.jsonl`), input.records)
  if (input.meta !== undefined)
    await writeText(path.join(folder, `agent-${input.agentId}.meta.json`), JSON.stringify(input.meta))
  return file
}

// ---------------------------------------------------------------------------------------------------------------
// Harness text (as the research notes describe it; the paths are fixture paths)

/** A compact summary as Claude Code writes it: the opener, the summary, the transcript line, the instruction. */
export function harnessSummary(body: string, transcript: string) {
  return [
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
    "",
    body,
    "",
    `If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcript}`,
    "Please continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.",
  ].join("\n")
}

/** The same three phrases slightly reworded, as a later release might write them. */
export function rewordedSummary(body: string, transcript: string) {
  return [
    "This conversation continues an earlier session that ran out of context; it is summarized below:",
    "",
    body,
    "",
    `The complete transcript is available at ${transcript} if exact details are needed.`,
    "Resume the work from where it stopped, without asking the user further questions.",
  ].join("\n")
}

export const SUMMARY_BODY =
  "Summary:\n1. Primary Request and Intent:\n   Fix the installer.\n2. Current Work:\n   Running the tests."

/** A `<persisted-output>` preview as Claude Code writes it for a large tool output. */
export function persistedPreview(file: string, preview: string) {
  return `<persisted-output>\nOutput too large (118.4KB). Full output saved to: ${file}\n\nPreview (first 2KB):\n${preview}\n</persisted-output>`
}

// ---------------------------------------------------------------------------------------------------------------
// Scenarios (IG2)

export const CWD = "C:\\work\\proj"

/** Session ids: one per scenario, valid UUIDs, so the file names are what the scan accepts. */
export const IDS = {
  basic: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d01",
  parallel: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d02",
  abandoned: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d03",
  afterTool: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d04",
  afterUser: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d05",
  oldBoundary: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d06",
  queued: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d07",
  notices: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d08",
  harness: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d09",
  sidechain: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d0a",
  relocated: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d0b",
  agents: "0b9e2a4c-6a7d-4c4e-9d1e-3f1a2b3c4d0c",
} as const

const USAGE = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 40 }

/**
 * Split responses and the view's tool data: thinking (empty and readable), a response split over five records, a
 * shell call with its exit code, an edit with `structuredPatch`, a user image, titles in metadata records.
 */
export function basic(version: Version) {
  const input = { cwd: CWD, id: IDS.basic, version, branch: "fix-installer" }
  const s = session(input)
  s.meta({ type: "permission-mode", permissionMode: "default" })
  s.user([text("설치기를 고쳐 줘"), image("image/png", "AAECAwQF")])
  s.assistant(
    [
      thinking(""),
      redacted(),
      thinking("Look at the installer first."),
      text("Let me look."),
      toolUse("toolu_FAKE01", "Bash", { command: "bun test" }),
    ],
    { id: "msg_FAKE01", usage: USAGE },
  )
  s.result("toolu_FAKE01", "3 pass", { toolUseResult: { stdout: "3 pass", stderr: "", interrupted: false } })
  s.assistant(
    [toolUse("toolu_FAKE02", "Edit", { file_path: "C:\\work\\proj\\a.ts", old_string: "a", new_string: "b" })],
    {
      id: "msg_FAKE02",
      usage: USAGE,
    },
  )
  s.result("toolu_FAKE02", "The file C:\\work\\proj\\a.ts has been updated.", {
    toolUseResult: {
      filePath: "C:\\work\\proj\\a.ts",
      oldString: "a",
      newString: "b",
      originalFile: "a\n",
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
    },
  })
  s.history()
  s.assistant([text("Fixed."), text("The tests pass.")], { id: "msg_FAKE03", usage: USAGE })
  s.meta({ type: "ai-title", aiTitle: "Installer fix" })
  s.meta({ type: "custom-title", customTitle: "설치기 정리" })
  s.meta({ type: "last-prompt", lastPrompt: "설치기를 고쳐 줘", leafUuid: s.last })
  s.meta({ type: "cost-state", totalCostUSD: 0.01, modelUsage: { [MODEL]: { inputTokens: 1 } } })
  return { input, session: s }
}

/**
 * Parallel tool calls: each `tool_use` record has two children, the next block and its own result, so the result of
 * the first call hangs off a sibling branch; the third call never got a result.
 */
export function parallel(version: Version) {
  const input = { cwd: CWD, id: IDS.parallel, version }
  const s = session(input)
  s.user("Read both files")
  const uses = s.assistant(
    [toolUse("toolu_FAKE11", "Read", { file_path: "a.ts" }), toolUse("toolu_FAKE12", "Read", { file_path: "b.ts" })],
    { id: "msg_FAKE11" },
  )
  s.result("toolu_FAKE11", "content of a", { parent: uses[0] })
  s.result("toolu_FAKE12", "content of b", { parent: uses[1] })
  s.assistant([text("Both read."), toolUse("toolu_FAKE13", "Bash", { command: "ls" })], { id: "msg_FAKE12" })
  return { input, session: s }
}

/** An edit: the human rewrote the second prompt, so the first answer to it is an abandoned branch. */
export function abandoned(version: Version) {
  const input = { cwd: CWD, id: IDS.abandoned, version }
  const s = session(input)
  s.user("first request")
  s.assistant([text("first answer")], { id: "msg_FAKE21" })
  const fork = s.last
  s.user("second request, old wording")
  s.assistant([text("answer to the old wording")], { id: "msg_FAKE22" })
  s.user("second request, new wording", { parent: fork })
  s.assistant([text("answer to the new wording")], { id: "msg_FAKE23" })
  s.meta({ type: "last-prompt", lastPrompt: "second request, old wording", leafUuid: "not-the-leaf" })
  return { input, session: s }
}

/**
 * An automatic compaction mid-turn right after a tool result (09 §2.6 자리), with `preservedSegment` (head..tail =
 * the last tool call and its result) and the harness summary; the answer after it continues the same turn.
 */
export function afterTool(version: Version, reworded = false) {
  const input = { cwd: CWD, id: IDS.afterTool, version }
  const s = session(input)
  s.user("refactor the installer")
  s.assistant([text("Starting.")], { id: "msg_FAKE31" })
  s.user("also update the docs")
  s.assistant([toolUse("toolu_FAKE31", "Bash", { command: "bun test" })], { id: "msg_FAKE32" })
  const head = s.last ?? ""
  const tail = s.result("toolu_FAKE31", "2 pass", { toolUseResult: { stdout: "2 pass", stderr: "" } })
  s.boundary({ logicalParent: tail, preserved: { head, tail } })
  const transcript = `C:\\Users\\fixture\\.claude\\projects\\C--work-proj\\${IDS.afterTool}.jsonl`
  s.summary((reworded ? rewordedSummary : harnessSummary)(SUMMARY_BODY, transcript))
  s.attachment({ type: "compact_file_reference", filename: "a.ts" })
  s.assistant([text("Continuing after the compaction.")], { id: "msg_FAKE33" })
  s.user("thanks")
  s.assistant([text("You are welcome.")], { id: "msg_FAKE34" })
  return { input, session: s }
}

/** A compaction right after the human's request: the boundary sits at step 0 of that turn. */
export function afterUser(version: Version) {
  const input = { cwd: CWD, id: IDS.afterUser, version }
  const s = session(input)
  s.user("first")
  s.assistant([text("one")], { id: "msg_FAKE41" })
  const request = s.user("second, a long one")
  s.boundary({
    logicalParent: request,
    trigger: "auto",
    preTokens: 150_000.4,
    postTokens: 9000,
    preserved: { head: request, tail: request },
  })
  s.summary(harnessSummary(SUMMARY_BODY, "/home/fixture/.claude/projects/-home-fixture-proj/x.jsonl"))
  s.assistant([text("two")], { id: "msg_FAKE42" })
  return { input, session: s }
}

/**
 * An older release: a manual `/compact` whose boundary has no `preservedSegment`, a summary without the transcript
 * line (`boilerplateUnmatched`), and the `/compact` command record after it, which the model never answered.
 */
export function oldBoundary(version: Version) {
  const input = { cwd: CWD, id: IDS.oldBoundary, version }
  const s = session(input)
  s.user("first")
  const answer = s.assistant([text("one")], { id: "msg_FAKE51" })[0]
  s.boundary({ logicalParent: answer, trigger: "manual" })
  s.summary(
    [
      "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:",
      SUMMARY_BODY,
      "Please continue the conversation from where we left it off without asking the user any further questions.",
    ].join("\n"),
  )
  s.user(
    "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>",
  )
  s.user("<local-command-stdout>Compacted</local-command-stdout>")
  s.user("next")
  s.assistant([text("two")], { id: "msg_FAKE52" })
  return { input, session: s }
}

export const QUEUED_SOURCE = "0b9e2a4c-0000-4000-8000-000000000099"

/**
 * Prompts queued while the tool worked: a human one (a turn), another agent's hand-off (`peer`, `isMeta`: a note), a
 * task notification (a note), and a human one also written as a user record (by `source_uuid` and by text).
 */
export function queued(version: Version) {
  const input = { cwd: CWD, id: IDS.queued, version }
  const s = session(input)
  s.user("run the suite")
  s.assistant([toolUse("toolu_FAKE61", "Bash", { command: "bun test" })], { id: "msg_FAKE61" })
  s.result("toolu_FAKE61", "ok")
  s.queued("also check the lint", { origin: "human" })
  s.assistant([text("Checking the lint too.")], { id: "msg_FAKE62" })
  s.queued("handoff from the reviewer agent", { origin: "peer", isMeta: true })
  s.queued(
    '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command "bun build" completed</summary></task-notification>',
    {
      origin: "task_notification",
      commandMode: "task-notification",
    },
  )
  s.queued("same prompt twice", { origin: "human", sourceUuid: QUEUED_SOURCE })
  s.queued("same text twice", { origin: "human" })
  s.assistant([text("Lint is clean.")], { id: "msg_FAKE63" })
  // The user record the first duplicate names by `source_uuid`; its text differs, so only the uuid matches.
  s.user("same prompt twice, as sent", { uuid: QUEUED_SOURCE })
  s.assistant([text("Sent.")], { id: "msg_FAKE64" })
  s.user("same text twice")
  s.assistant([text("Done.")], { id: "msg_FAKE65" })
  return { input, session: s }
}

/**
 * The tool's own notices: a synthetic API error before a retry, a usage-limit note, a denied tool call, a
 * persisted-output preview and a tool reference; the turn after the error ends in another error.
 */
export function notices(version: Version, saved: string) {
  const input = { cwd: CWD, id: IDS.notices, version }
  const s = session(input)
  s.user("search the logs")
  s.assistant([text("API Error: 529 overloaded")], {
    id: "msg_FAKE70",
    model: "<synthetic>",
    extra: { isApiErrorMessage: true },
  })
  s.assistant([toolUse("toolu_FAKE71", "Grep", { pattern: "error" })], { id: "msg_FAKE71" })
  s.result("toolu_FAKE71", persistedPreview(saved, "line 1\nline 2"))
  s.assistant([toolUse("toolu_FAKE72", "Bash", { command: "rm -rf build" })], { id: "msg_FAKE72" })
  s.result("toolu_FAKE72", "The user doesn't want to proceed with this tool use. The tool use was rejected.", {
    error: true,
    extra: { toolDenialKind: "user-rejected" },
  })
  s.assistant([toolUse("toolu_FAKE73", "ToolSearch", { query: "web" })], { id: "msg_FAKE73" })
  s.result("toolu_FAKE73", [{ type: "tool_reference", tool_name: "WebFetch" }])
  s.assistant([text("Claude usage limit reached.")], { id: "msg_FAKE74", model: "<synthetic>" })
  s.user("Claude usage limit reached. Your limit will reset at 5pm.", {
    extra: { usageLimitNote: true, isMeta: false },
  })
  s.user("try again")
  s.assistant([text("API Error: 500")], { id: "msg_FAKE75", model: "<synthetic>", extra: { isApiErrorMessage: true } })
  return { input, session: s }
}

/**
 * Harness wrappers around human input (09 §2.6 사람의 입력): a system reminder, IDE context, a slash command the model
 * answered and one it did not, a local command's output, `isMeta` records, a task notification, the interrupt marker,
 * attachments (`prompt_snapshot`), an unknown record type and block, and a torn last line.
 */
export function harness(version: Version) {
  const input = { cwd: CWD, id: IDS.harness, version }
  const s = session(input)
  s.attachment({ type: "prompt_snapshot", systemPrompt: "FIXTURE SYSTEM PROMPT", tools: [], rendered: false })
  s.user("<ide_opened_file>The user opened C:\\work\\proj\\a.ts in the IDE.</ide_opened_file>")
  s.user([
    text("<ide_selection>a.ts lines 1-2</ide_selection>"),
    text("fix this function\n\n<system-reminder>Remember the todo list.</system-reminder>"),
  ])
  s.user("Caveat: generated by a hook", { extra: { isMeta: true } })
  s.assistant([text("On it."), { type: "server_tool_use", id: "srvtoolu_FAKE", name: "web_search", input: {} }], {
    id: "msg_FAKE81",
  })
  s.raw({ type: "atis-latch", value: true })
  s.raw({ type: "mystery-record", uuid: "0b9e2a4c-0000-4000-8000-0000000000aa", parentUuid: s.last })
  s.user(
    "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
    {
      parent: "0b9e2a4c-0000-4000-8000-0000000000aa",
    },
  )
  s.user("<local-command-stdout>Set model to fixture</local-command-stdout>")
  s.user(
    "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the parser</command-args>",
  )
  s.user("Expanded review prompt for the parser", { extra: { isMeta: true } })
  s.assistant([text("Reviewing the parser.")], { id: "msg_FAKE82" })
  s.user(
    '<task-notification>\n<task-id>bash-1</task-id>\n<status>completed</status>\n<summary>Background command "bun test" completed (exit code 0)</summary>\n</task-notification>',
    { extra: { origin: { kind: "task_notification" } } },
  )
  s.assistant([toolUse("toolu_FAKE81", "Bash", { command: "sleep 100" })], { id: "msg_FAKE83" })
  s.result("toolu_FAKE81", "[Request interrupted by user for tool use]", { error: true })
  s.user([text("[Request interrupted by user for tool use]")])
  s.system("stop_hook_summary")
  s.user("never mind")
  s.assistant([text("Stopped.")], { id: "msg_FAKE84" })
  return { input, session: s }
}

/** An older layout with sub-agent (sidechain) records inside the main file, and a team message. */
export function sidechain(version: Version) {
  const input = { cwd: CWD, id: IDS.sidechain, version }
  const s = session(input)
  s.user("explore the repo")
  s.assistant([toolUse("toolu_FAKE91", "Task", { description: "explore", prompt: "map the repo" })], {
    id: "msg_FAKE91",
  })
  const call = s.last
  s.user("map the repo", { parent: null, extra: { isSidechain: true } })
  s.assistant([text("Mapped.")], { id: "msg_FAKE92", extra: { isSidechain: true } })
  s.result("toolu_FAKE91", "The repo has two packages.", { parent: call })
  s.user("a teammate says hi", { extra: { teamName: "fixture-team" } })
  s.assistant([text("Two packages.")], { id: "msg_FAKE93" })
  return { input, session: s }
}

/**
 * Several cwds (09 §2.2 Claude cwd): the session moves to a worktree in the middle of the file, more than 64 KiB from
 * both ends, so only the confirm pass sees that folder.
 */
export function relocated(version: Version, worktree: string) {
  const input = { cwd: CWD, id: IDS.relocated, version }
  const s = session(input)
  const big = "x".repeat(80 * 1024)
  s.user("start in the main checkout")
  s.assistant([toolUse("toolu_FAKEA1", "Read", { file_path: "big.txt" })], { id: "msg_FAKEA1" })
  s.result("toolu_FAKEA1", big)
  s.meta({ type: "relocated", relocatedCwd: worktree })
  s.move(worktree)
  s.user("continue in the worktree")
  s.assistant([toolUse("toolu_FAKEA2", "Read", { file_path: "big.txt" })], { id: "msg_FAKEA2" })
  s.move(CWD)
  s.result("toolu_FAKEA2", big)
  s.assistant([text("Back in the main checkout.")], { id: "msg_FAKEA3" })
  return { input, session: s }
}

/** A conversation that started two sub-agents (one nested in a workflow folder) and was renamed in Desktop. */
export async function agents(root: string, version: Version) {
  const input = { cwd: CWD, id: IDS.agents, version }
  const s = session(input)
  s.user("explore and plan")
  s.assistant(
    [
      toolUse("toolu_FAKEB1", "Agent", { description: "explore", subagent_type: "Explore", prompt: "map it" }),
      toolUse("toolu_FAKEB2", "Agent", { description: "plan", subagent_type: "Plan", prompt: "plan it" }),
    ],
    { id: "msg_FAKEB1" },
  )
  s.result("toolu_FAKEB1", "Mapped: two packages.", { toolUseResult: { agentId: "a1b2", status: "completed" } })
  s.result("toolu_FAKEB2", "Plan: three steps.", { toolUseResult: { status: "completed" } })
  s.assistant([text("Explored and planned.")], { id: "msg_FAKEB2" })
  const file = await write(root, input, s)
  const child = session({ cwd: CWD, id: IDS.agents, version })
  child.user("map it", { extra: { isSidechain: true, agentId: "a1b2" } })
  child.assistant([text("Mapped: two packages.")], { id: "msg_FAKEB3", extra: { isSidechain: true, agentId: "a1b2" } })
  await subagent(root, {
    cwd: CWD,
    sessionId: IDS.agents,
    agentId: "a1b2",
    records: child.records(),
    meta: { agentType: "Explore", description: "explore", toolUseId: "toolu_FAKEB1" },
  })
  const planner = session({ cwd: CWD, id: IDS.agents, version })
  planner.user("plan it", { extra: { isSidechain: true } })
  planner.assistant([text("Plan: three steps.")], { id: "msg_FAKEB4", extra: { isSidechain: true } })
  await subagent(root, {
    cwd: CWD,
    sessionId: IDS.agents,
    agentId: "c3d4",
    nested: path.join("workflows", "wf_fixture"),
    records: planner.records(),
    meta: { agentType: "Plan", description: "plan", toolUseId: "toolu_FAKEB2" },
  })
  await subagent(root, { cwd: CWD, sessionId: IDS.agents, agentId: "bad id", records: planner.records() })
  await writeText(
    path.join(sessionFolder(root, CWD, IDS.agents), "custom-title.json"),
    JSON.stringify({ customTitle: "탐색과 계획" }),
  )
  return { input, session: s, file }
}
