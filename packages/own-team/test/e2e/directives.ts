// The scripted model of the team e2e tests (06 §11.2): a deterministic fake-LLM responder that reads directives in the
// newest user text of a model request and answers with the tool call each one stands for. The fake providers of the
// e2e kit (own-accounts `test/e2e-kit`) call it whenever their reply queue is empty, so a test drives the team main,
// the owners and their children only through the text it sends; verdicts come from durable state (`inspect.ts`).
//
// Directives (top level only; a directive's body may hold further directives, which then reach the receiving session
// verbatim, e.g. `[dispatch ui [write a.txt] [report done]]` makes the main send `[write a.txt] [report done]`):
//
//   [propose-areas <n> <slug…> +heavy=<dir,…> +shared=<dir,…> +setup +check +assets]   the judge's answer: a 06
//                                    §3.4 proposal creating n areas from `main` (text reply); `+heavy=` names heavy
//                                    folders (the areas are code-only then), `+shared=` ignored folders of the main
//                                    folder to share read-only (4.11); `+setup` picks the `bun.lock` install command as
//                                    the team's setup command, `+check` the `bun run typecheck` script as its code
//                                    check, `+assets` the `bun run build` script as its asset check (4.10)
//   [propose-areas adopt <folder…> +heavy=<dir,…> +setup +check]   the judge adopts folders that are already there:
//                                    the named folders (by their last path segment), or every active candidate when
//                                    none is named, read from the inventory lines of the judge's own prompt (3.4)
//   [propose-reorg <json>]           a reorganization (8.1): in a judge request (`reorg.propose`, its prompt starts
//                                    with {@link JUDGE}) the judge's answer, the JSON as text; anywhere else the
//                                    main's `team_reorganize{proposal: <json>}`
//   [dispatch <area> +fresh +task=<label> +member=<peer> <text…>]   `team_dispatch`; `+fresh`, `+task=` and
//                                    `+member=` (an area peer by key or label, 동료) are optional
//   [message <kind> <area> +member=<peer> +id=last|<id> +on=ready|integrated <text…>]   `team_message` (06 §5.8):
//                                    `ask`, `note` and `watch` name the area, `reply` none; `+id=last` is the id of
//                                    the newest `<dispatch … kind="ask" … id="dp_…">` in the user text (the ask this
//                                    turn answers); the text may hold directives for the receiver, like `[dispatch]`
//   [report ready|done|blocked|progress <text…>]     `team_report` (`[report ready]`: the 7.1 candidate;
//                                    `[report ready assets <text…>]` asks for the engine run, 4.10)
//   [integrate <area>]               `team_integrate` (the main: any area; an owner: its own)
//   [decide <title…>]                `team_decide` with a fixed body ({@link DECISION_BODY})
//   [need-paths <dir…>]              `team_need_paths`
//   [handoff <text…>]                `team_handoff`
//   [status <area>]                  `team_status` (the area is optional)
//   [voice <tool> <json> +token=last|<t>]   a voice action (06 §2.9): `team_<tool>(<json>)`, with `+token=` the
//                                    plan's token added: `last` is the newest token any team tool result showed in
//                                    this or an earlier turn (the responder remembers it: Codex over WebSocket sends
//                                    only the new items), `<t>` a given one
//   [write <path> <content…>]        core `write`, or `patch` adding the file where the model has no `write` (GPT)
//   [shell <command…>]               core `shell`
//   [computer <tool> <json…>]        own.computer-use `tools.computer.<tool>(<json>)` (default `{}`)
//   [github <tool> <json…>]          own.accounts' GitHub connection `tools.github.<tool>(<json>)` (default `{}`)
//   [tool <name> <json…>]            any Code Mode tool `tools.<name>(<json>)` (default `{}`; `<ns>.<name>` for a
//                                    namespaced one such as `worktree.start`, 06 §13), such as an
//                                    own.creator command tool `ext_<name>` (MR14)
//   [subagent <agent> <prompt…>]     core `subagent` (the child runs the directives of its prompt)
//   [fail]                           a provider error (HTTP 400): the run fails (`session.execution.failed`)
//   [slow <ms>]                      not a step: the turn's first reply waits `ms` (keeps the session busy)
//
// Team tools are Code Mode tools (06 §2.8), so they are called through `execute` (`tools.team.<name>(…)`). A turn runs
// its directives one per model request: the n-th request after the user text (counted by the tool results that follow
// it) performs the n-th directive, and once all ran the model answers with a short text, so every turn ends. Codex
// over WebSocket sends only the new items after `previous_response_id` (a follow-up holds just the tool result), so the
// responder names each call it makes and remembers which user text and step the call belongs to. Requests without
// directives get a short text; title requests a fixed title. Bracketed text that is not a directive is ignored.
// own.team's handoff request (`<team-request kind="handoff">`, 06 §6.2) is answered like `[handoff]`: the warm turn
// writes the document with `team_handoff` (a test's `before` can answer it otherwise).
//
// No test framework and no server here: own-web's e2e backends import this file as well.

import { Option, Schema } from "effect"
import type { RecordedRequest, Reply, Responder } from "../../../own-accounts/test/e2e-kit"

export type Directive =
  | {
      readonly kind: "propose-areas"
      readonly count: number
      readonly slugs: ReadonlyArray<string>
      /** Heavy folders (06 §3.4 `heavy`); without them every area is `plain`. */
      readonly heavy?: ReadonlyArray<string>
      /** The setup command candidate (06 §3.4 `commands.setup`), by its name. */
      readonly setup?: string
      /** Code check candidates (06 §3.4 `commands.code`), by their names. */
      readonly code?: ReadonlyArray<string>
      /** Asset check candidates (06 §3.4 `commands.assets`, 4.10), by their names. */
      readonly assets?: ReadonlyArray<string>
      /** Ignored folders of the main folder to share read-only (06 §3.4 `shared`, 4.11). */
      readonly shared?: ReadonlyArray<string>
      /** Folders the judge adopts (06 §3.4 `adopt`), from its prompt's inventory. */
      readonly adopt?: ReadonlyArray<Folder>
    }
  /** `judge`: the request is the judge call of `reorg.propose` (answered with the JSON as text). */
  | { readonly kind: "propose-reorg"; readonly proposal: unknown; readonly judge: boolean }
  | { readonly kind: "integrate"; readonly area: string }
  | { readonly kind: "decide"; readonly title: string }
  | {
      readonly kind: "dispatch"
      readonly area: string
      readonly text: string
      readonly fresh: boolean
      readonly task?: string
      /** An area peer (동료) by key or label. */
      readonly member?: string
    }
  /** An area message (06 §5.8); `message` is its kind. */
  | {
      readonly kind: "message"
      readonly message: string
      readonly text: string
      readonly to?: string
      readonly member?: string
      readonly id?: string
      readonly on?: string
    }
  /** `status` is not checked here, so a test can also send a kind the tool refuses; `assets` goes with `ready`. */
  | { readonly kind: "report"; readonly status: string; readonly text: string; readonly assets?: boolean }
  | { readonly kind: "need-paths"; readonly dirs: ReadonlyArray<string> }
  | { readonly kind: "handoff"; readonly text: string }
  | { readonly kind: "status"; readonly area?: string }
  /** `token`: `last` (the newest token seen in a team tool result) or a given one; absent = no token. */
  | {
      readonly kind: "voice"
      readonly tool: string
      readonly input: Readonly<Record<string, unknown>>
      readonly token?: string
    }
  | { readonly kind: "write"; readonly path: string; readonly content: string }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "subagent"; readonly agent: string; readonly prompt: string }
  | { readonly kind: "computer"; readonly tool: string; readonly input: string }
  | { readonly kind: "github"; readonly tool: string; readonly input: string }
  | { readonly kind: "tool"; readonly tool: string; readonly input: string }
  | { readonly kind: "fail" }
  /** A modifier, not a step: the turn's first reply waits `ms`. */
  | { readonly kind: "slow"; readonly ms: number }

/** Core's title agent prompt: title requests get {@link TITLE}. */
export const TITLE_PROMPT = "You name conversations so the user can find them later"
export const TITLE = "팀 e2e 대화"
/** The answer after a turn's last directive. */
export const DONE = "지시를 마쳤습니다."
/** The answer to a request without directives (a team update, a child without work, a plain question). */
export const IDLE = "확인했습니다."
/** The provider error message of `[fail]`. */
export const FAILURE = "e2e 지시어로 만든 실패입니다"
/** How own.team's handoff request starts (06 §6.2 step 1); the responder answers it with `team_handoff`. */
export const HANDOFF_REQUEST = '<team-request kind="handoff"'
/** The handoff document the scripted owner writes in a warm handoff turn. */
export const HANDOFF_TEXT = "# 인계: e2e\n\n## 목표\ne2e 영역\n\n## 남은 것\n다음 메인 요청을 기다립니다."
/** `reason` of every `team_need_paths` call. */
export const NEED_PATHS_REASON = "e2e 지시어"
/** The body of every `team_decide` call. */
export const DECISION_BODY = "e2e 지시어로 적은 결정입니다."
/** The code check `+check` picks: the `typecheck` script run by Bun (a project with `bun.lock`, V10). */
export const CHECK = "bun run typecheck"
/** The asset check `+assets` picks: the `build` script run by Bun (a project with `bun.lock`, V10, 4.10). */
export const ASSETS = "bun run build"
/** How the judge prompts start (enable 3.4 and `reorg.propose` 8.1, `judge/prompt.ts`). */
export const JUDGE = "너는 팀 모드의 판단을 맡는다"

/** A worktree line of the judge prompt's inventory (06 §3.4, `judge/prompt.ts`). */
export interface Folder {
  readonly path: string
  /** The last path segment. */
  readonly name: string
  readonly candidate: boolean
  readonly active: boolean
}

/** The directives at the top level of `text`, in order; `[propose-areas adopt …]` reads its folders from `text`. */
export function parse(text: string): Directive[] {
  return groups(text).flatMap((group) => {
    const directive = read(group, text)
    return directive ? [directive] : []
  })
}

/**
 * The inventory lines of a judge prompt: `- [<class>] <path> · <branch or 분리 HEAD> · 대상에 없는 커밋 n · … · 활동
 * 있음|없음`.
 */
export function folders(text: string): Folder[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^- \[([^\]]*)\] (.+?) · .* · (활동 있음|활동 없음)$/.exec(line)
    if (!match) return []
    const where = match[2] ?? ""
    return [
      {
        path: where,
        name: where.split(/[\\/]/).findLast((part) => part !== "") ?? where,
        candidate: (match[1] ?? "").startsWith("후보"),
        active: match[3] === "활동 있음",
      },
    ]
  })
}

/** The candidates named in `names` (every active one when `names` is empty), in the order the names are given. */
function adoptable(text: string, names: ReadonlyArray<string>) {
  const listed = folders(text).filter((folder) => folder.candidate)
  if (names.length === 0) return listed.filter((folder) => folder.active)
  return names.flatMap((name) => listed.filter((folder) => folder.name === name))
}

/**
 * The reply that performs `directive`: a tool call, or the judge's JSON text for `propose-areas`. `tools` are the tool
 * names the request offers: `write` falls back to `patch` where only that is offered.
 */
export function reply(directive: Directive, tools: ReadonlyArray<string> = []): Reply {
  switch (directive.kind) {
    case "propose-areas":
      return {
        type: "text",
        text: JSON.stringify(
          proposal(
            directive.count,
            directive.slugs,
            directive.heavy,
            directive.setup,
            directive.code,
            directive.adopt,
            { assets: directive.assets, shared: directive.shared },
          ),
        ),
      }
    case "propose-reorg":
      if (directive.judge) return { type: "text", text: JSON.stringify(directive.proposal) }
      return team("reorganize", { proposal: directive.proposal })
    case "integrate":
      return team("integrate", { area: directive.area })
    case "decide":
      return team("decide", { title: directive.title, body: DECISION_BODY })
    case "dispatch":
      return team("dispatch", {
        area: directive.area,
        text: directive.text,
        ...(directive.task === undefined ? {} : { task: directive.task }),
        ...(directive.fresh ? { fresh: true } : {}),
        ...(directive.member === undefined ? {} : { member: directive.member }),
      })
    case "message":
      return team("message", {
        kind: directive.message,
        text: directive.text,
        ...(directive.to === undefined ? {} : { to: directive.to }),
        ...(directive.member === undefined ? {} : { member: directive.member }),
        ...(directive.id === undefined ? {} : { id: directive.id }),
        ...(directive.on === undefined ? {} : { on: directive.on }),
      })
    case "report":
      return team("report", {
        kind: directive.status,
        text: directive.text,
        ...(directive.assets === true ? { assets: true } : {}),
      })
    case "need-paths":
      return team("need_paths", { dirs: directive.dirs, reason: NEED_PATHS_REASON })
    case "handoff":
      return team("handoff", { text: directive.text })
    case "status":
      return team("status", directive.area === undefined ? {} : { area: directive.area })
    case "voice":
      return team(directive.tool, {
        ...directive.input,
        ...(directive.token === undefined ? {} : { token: directive.token }),
      })
    case "write":
      if (tools.includes("write") || !tools.includes("patch"))
        return { type: "tool-call", name: "write", input: { path: directive.path, content: directive.content } }
      return { type: "tool-call", name: "patch", input: { patchText: addFile(directive.path, directive.content) } }
    case "shell":
      return { type: "tool-call", name: "shell", input: { command: directive.command } }
    case "subagent":
      return {
        type: "tool-call",
        name: "subagent",
        input: { agent: directive.agent, description: "e2e 하위 작업", prompt: directive.prompt },
      }
    case "github":
      return {
        type: "tool-call",
        name: "execute",
        input: { code: `return await tools.github.${directive.tool}(${directive.input})` },
      }
    case "computer":
      return {
        type: "tool-call",
        name: "execute",
        input: { code: `return await tools.computer.${directive.tool}(${directive.input})` },
      }
    case "tool":
      // Codex's Code Mode (own-harness, 10 §6) has no `execute`: its freeform `exec` nests Code Mode tools as
      // `tools.<namespace>__<name>`.
      if (tools.includes("exec") && !tools.includes("execute"))
        return {
          type: "tool-call",
          name: "exec",
          input: {},
          freeform: `text(JSON.stringify(await tools.${directive.tool.replace(".", "__")}(${directive.input})))`,
        }
      return {
        type: "tool-call",
        name: "execute",
        input: { code: `return await tools.${directive.tool}(${directive.input})` },
      }
    case "fail":
      return { type: "error", status: 400, body: { error: { message: FAILURE, type: "invalid_request_error" } } }
    case "slow":
      return { type: "text", text: IDLE, delayMs: directive.ms }
  }
}

/**
 * The 06 §3.4 proposal of `[propose-areas n]`: n new areas from `main` (slugs `area-1`… unless given), no target
 * change, the `heavy` folders, the `setup` command and the `code` checks when given. `adopt` adds one area per folder,
 * named and slugged after it (`adopt.worktree` only: the folder's branch and its most recent conversation are own's
 * choice, 3.6). `n = 0` without folders is the "no ongoing work" answer. `extra`: the asset checks (4.10) and the
 * shared folders (4.11) when given.
 */
export function proposal(
  count: number,
  slugs: ReadonlyArray<string> = [],
  heavy: ReadonlyArray<string> = [],
  setup?: string,
  code: ReadonlyArray<string> = [],
  adopt: ReadonlyArray<Folder> = [],
  extra: { readonly assets?: ReadonlyArray<string>; readonly shared?: ReadonlyArray<string> } = {},
) {
  const assets = extra.assets ?? []
  const shared = extra.shared ?? []
  const commands = {
    ...(setup === undefined ? {} : { setup }),
    ...(code.length === 0 ? {} : { code }),
    ...(assets.length === 0 ? {} : { assets }),
  }
  return {
    version: 1,
    ...(heavy.length === 0 ? {} : { heavy: heavy.map((dir) => ({ dir, why: "e2e 지시어의 큰 파일 폴더" })) }),
    ...(shared.length === 0
      ? {}
      : { shared: shared.map((dir) => ({ dir, why: "e2e 지시어의 읽기 전용 데이터 폴더" })) }),
    ...(Object.keys(commands).length === 0 ? {} : { commands }),
    areas: [
      ...adopt.map((folder) => ({
        slug: folder.name.toLowerCase(),
        name: folder.name,
        goal: `e2e 받아들인 ${folder.name}`,
        adopt: { worktree: folder.path },
        create: null,
      })),
      ...Array.from({ length: count }, (_, index) => ({
        slug: slugs[index] ?? `area-${index + 1}`,
        name: `영역 ${index + 1}`,
        goal: `e2e 영역 ${index + 1}`,
        shape: "code",
        adopt: null,
        create: { from: "main" },
      })),
    ],
    notes:
      adopt.length > 0
        ? `새 영역 ${count}개를 만들고 폴더 ${adopt.length}개를 받아들입니다.`
        : count === 0
          ? "진행 중인 일이 보이지 않아 영역을 만들지 않습니다."
          : `새 영역 ${count}개를 만듭니다.`,
  }
}

/** A `patch` text that adds `file` holding `content` (core `tool/patch.txt`). */
export function addFile(file: string, content: string) {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content
  return [
    "*** Begin Patch",
    `*** Add File: ${file}`,
    ...body.split("\n").map((line) => `+${line}`),
    "*** End Patch",
  ].join("\n")
}

/** A Code Mode call of team tool `name` through `execute`. */
export function team(name: string, input: Readonly<Record<string, unknown>>): Reply {
  return {
    type: "tool-call",
    name: "execute",
    input: { code: `return await tools.team.${name}(${JSON.stringify(input)})` },
  }
}

/** A model request reduced to what the scripted model reads. */
export interface Turn {
  /** System text: Responses `instructions` and system/developer items, Anthropic `system`, chat system messages. */
  readonly system: string
  /** The newest user text (a user message with text, not one that only carries tool results). */
  readonly user: string
  /** Tool results after that user text: how many directives of the turn already ran. */
  readonly done: number
  /** Their texts, oldest first. */
  readonly results: ReadonlyArray<string>
  /** The call id of the newest tool result in the request, if any. */
  readonly call?: string
  /** The names of the tools the request offers. */
  readonly tools: ReadonlyArray<string>
}

/** dsh's context messages (own-harness `src/dsh/context.ts`): a `<system-reminder>` or the runtime snapshot. */
const HARNESS_CONTEXT = /^(<system-reminder>|Current runtime context\.|Time sampled while preparing turn )/

/** Reads a Responses (OpenAI, Codex HTTP and WebSocket), Anthropic Messages or chat-completions request. */
export function turn(request: Pick<RecordedRequest, "json">): Turn {
  const json = isRecord(request.json) ? request.json : {}
  const entries = Array.isArray(json.input)
    ? json.input.flatMap(responsesEntry)
    : Array.isArray(json.messages)
      ? json.messages.flatMap(messageEntry)
      : []
  // own-harness's dsh adds its context after the user's message as user messages (06 §13.6 e2e): not the user's text.
  const last = entries.findLastIndex(
    (entry) => entry.kind === "user" && entry.text.trim() !== "" && !HARNESS_CONTEXT.test(entry.text.trimStart()),
  )
  const after = entries.slice(last + 1).filter((entry) => entry.kind === "result")
  const call = entries.findLast((entry) => entry.kind === "result")?.call
  return {
    system: [
      typeof json.instructions === "string" ? json.instructions : "",
      textOf(json.system),
      ...entries.flatMap((entry) => (entry.kind === "system" ? [entry.text] : [])),
    ]
      .filter((text) => text !== "")
      .join("\n"),
    user: last < 0 ? "" : (entries[last]?.text ?? ""),
    done: after.length,
    results: after.map((entry) => entry.text),
    ...(call === undefined ? {} : { call }),
    tools: toolNames(request),
  }
}

/** Tool names of a Responses, Anthropic or chat request, in request order (`name`, or chat's `function.name`). */
export function toolNames(request: Pick<RecordedRequest, "json">) {
  const json = isRecord(request.json) ? request.json : {}
  // Responses Lite (own-harness codex, P-022) sends the tools in an `additional_tools` input item.
  const lite = Array.isArray(json.input)
    ? json.input.flatMap((item: unknown) =>
        isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : [],
      )
    : []
  const listed = [...(Array.isArray(json.tools) ? json.tools : []), ...lite]
  // Codex's namespaced tools (`{type: "namespace", name: "functions", tools}`) by their own names.
  const tools = listed.flatMap((tool: unknown) =>
    isRecord(tool) && tool.type === "namespace" && Array.isArray(tool.tools) ? tool.tools : [tool],
  )
  return tools.map((tool: unknown) =>
    isRecord(tool) && typeof tool.name === "string"
      ? tool.name
      : isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === "string"
        ? tool.function.name
        : "",
  )
}

export interface ResponderOptions {
  /** Asked first; its reply wins (a test's special case). */
  readonly before?: Responder
}

/** The responder the fakes call when their queue is empty (see the file header). */
export function responder(options: ResponderOptions = {}): Responder {
  /** Each call this responder made: the user text it serves and the directive index it performed. */
  const calls = new Map<string, { readonly user: string; readonly step: number }>()
  const prefix = `call_e2e${Math.random().toString(36).slice(2, 8)}`
  /** The newest voice plan token a tool result showed (`[voice … +token=last]`). */
  const seen: { token?: string } = {}
  return (request) => {
    const special = options.before?.(request)
    if (special) return special
    if (request.body.includes(TITLE_PROMPT)) return { type: "text", text: TITLE }
    const current = turn(request)
    for (const result of current.results) {
      const token = [...result.matchAll(TOKEN)].at(-1)?.[1]
      if (token !== undefined) seen.token = token
    }
    // A follow-up without the user text (`previous_response_id`) continues the turn its last tool result belongs to.
    const known = current.user === "" && current.call !== undefined ? calls.get(current.call) : undefined
    const user = known?.user ?? current.user
    const step = known ? known.step + 1 : current.done
    // own.team's handoff request is answered like `[handoff]` (the owner role asks for `team_handoff`, 06 §6.2).
    const parsed: ReadonlyArray<Directive> = user.includes(HANDOFF_REQUEST)
      ? [{ kind: "handoff", text: HANDOFF_TEXT }]
      : parse(user)
    const directives = parsed.filter((directive) => directive.kind !== "slow")
    const slow = step === 0 ? parsed.find((directive) => directive.kind === "slow") : undefined
    const wait = slow?.kind === "slow" ? { delayMs: slow.ms } : {}
    const directive = directives[step]
    if (!directive) return { type: "text", text: parsed.length > 0 ? DONE : IDLE, ...wait }
    const next =
      directive.kind === "voice" && directive.token === "last"
        ? { ...directive, token: seen.token ?? "no-token-seen" }
        : directive
    const answer = reply(next, current.tools)
    if (answer.type === "text") return { ...answer, ...wait }
    if (answer.type !== "tool-call") return answer
    const id = `${prefix}_${calls.size + 1}`
    calls.set(id, { user, step })
    return { ...answer, id, ...wait }
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** The bodies of the top-level `[…]` groups of `text`; an unmatched `[` or `]` is plain text. */
function groups(text: string): string[] {
  const chars = [...text]
  const scan = chars.reduce(
    (state, char, index) => {
      if (char === "[") return { ...state, depth: state.depth + 1, start: state.depth === 0 ? index : state.start }
      if (char !== "]" || state.depth === 0) return state
      const depth = state.depth - 1
      if (depth > 0) return { ...state, depth }
      return { depth, start: -1, found: [...state.found, chars.slice(state.start + 1, index).join("")] }
    },
    { depth: 0, start: -1, found: new Array<string>() },
  )
  // An opening bracket that never closed: read on after it.
  if (scan.depth === 0) return scan.found
  return [...scan.found, ...groups(chars.slice(scan.start + 1).join(""))]
}

/** One `[…]` group; `text` is the whole message (`[propose-areas adopt]` reads the inventory from it). */
function read(group: string, text: string): Directive | undefined {
  const match = /^\s*([a-z-]+)(?:\s+([\s\S]*))?$/.exec(group)
  const name = match?.[1]
  const rest = (match?.[2] ?? "").trim()
  if (name === "propose-areas") {
    const words = split(rest)
    const adopting = words[0] === "adopt"
    const count = adopting ? 0 : Number.parseInt(words[0] ?? "", 10)
    if (!Number.isInteger(count) || count < 0) return undefined
    const named = words.slice(1).filter((word) => !word.startsWith("+"))
    const listed = (flag: string) => {
      const word = words.find((item) => item.startsWith(flag))
      return word === undefined
        ? undefined
        : word
            .slice(flag.length)
            .split(",")
            .filter((dir) => dir !== "")
    }
    const heavy = listed("+heavy=")
    const shared = listed("+shared=")
    // The install command and the checks of the fixture's `bun.lock` (own-team's candidate list names them so).
    const commands = {
      ...(words.includes("+setup") ? { setup: "bun install" } : {}),
      ...(words.includes("+check") ? { code: [CHECK] } : {}),
      ...(words.includes("+assets") ? { assets: [ASSETS] } : {}),
    }
    return {
      kind: name,
      count,
      slugs: adopting ? [] : named,
      ...(heavy === undefined ? {} : { heavy }),
      ...(shared === undefined ? {} : { shared }),
      ...commands,
      ...(adopting ? { adopt: adoptable(text, named) } : {}),
    }
  }
  if (name === "propose-reorg") {
    const found = json(rest)
    return found === undefined ? undefined : { kind: name, proposal: found, judge: text.includes(JUDGE) }
  }
  if (name === "integrate") return rest === "" ? undefined : { kind: name, area: rest }
  if (name === "decide") return rest === "" ? undefined : { kind: name, title: rest }
  if (name === "github") {
    const [tool, input] = head(rest)
    return /^[a-z_]+$/.test(tool) ? { kind: name, tool, input: input || "{}" } : undefined
  }
  if (name === "computer") {
    const [tool, input] = head(rest)
    return /^[a-z_]+$/.test(tool) ? { kind: name, tool, input: input || "{}" } : undefined
  }
  if (name === "tool") {
    const [tool, input] = head(rest)
    // A namespaced tool (`worktree.start`) is `tools.<namespace>.<name>`.
    return /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(tool) ? { kind: name, tool, input: input || "{}" } : undefined
  }
  if (name === "fail") return { kind: name }
  if (name === "slow") {
    const ms = Number.parseInt(rest, 10)
    return Number.isInteger(ms) && ms > 0 ? { kind: name, ms } : undefined
  }
  if (name === "dispatch") return dispatch(rest)
  if (name === "message") return message(rest, text)
  if (name === "report") {
    const [status, tail] = head(rest)
    if (status === "") return undefined
    // `[report ready assets …]`: the candidate needs an engine run (4.10).
    const [word, after] = head(tail)
    const assets = status === "ready" && word === "assets"
    const body = assets ? after : tail
    return { kind: name, status, text: body || `${status} 보고입니다.`, ...(assets ? { assets } : {}) }
  }
  if (name === "need-paths") {
    const dirs = split(rest)
    return dirs.length === 0 ? undefined : { kind: name, dirs }
  }
  if (name === "handoff") return { kind: name, text: rest || "인계 문서: e2e 지시어로 쓴 인계입니다." }
  if (name === "status") return rest === "" ? { kind: name } : { kind: name, area: rest }
  if (name === "voice") {
    const token = /\s\+token=(\S+)\s*$/.exec(rest)
    const [tool, body] = head(token ? rest.slice(0, token.index) : rest)
    const input = json(body)
    if (!/^[a-z_]+$/.test(tool) || !isRecord(input)) return undefined
    return { kind: name, tool, input, ...(token?.[1] === undefined ? {} : { token: token[1] }) }
  }
  if (name === "write") {
    const [file, content] = head(rest)
    return file === "" ? undefined : { kind: name, path: file, content: content || `e2e write: ${file}\n` }
  }
  if (name === "shell") return rest === "" ? undefined : { kind: name, command: rest }
  if (name === "subagent") {
    const [agent, prompt] = head(rest)
    return agent === "" ? undefined : { kind: name, agent, prompt: prompt || IDLE }
  }
  return undefined
}

/** `<area> +fresh +task=<label> +member=<peer> <text…>`: the flags only directly after the area. */
function dispatch(rest: string): Directive | undefined {
  const [area, tail] = head(rest)
  if (area === "") return undefined
  const flags = flagsOf(tail)
  return {
    kind: "dispatch",
    area,
    text: flags.text || "e2e 메인 요청입니다.",
    fresh: flags.fresh,
    ...(flags.task === undefined ? {} : { task: flags.task }),
    ...(flags.member === undefined ? {} : { member: flags.member }),
  }
}

/**
 * `<kind> <area> +member=<peer> +id=last|<id> +on=<event> <text…>` (06 §5.8): `reply` names no area; the flags only
 * directly after the kind and area. `text` is the whole user text `+id=last` reads the ask's envelope from.
 */
function message(rest: string, text: string): Directive | undefined {
  const [kind, tail] = head(rest)
  if (!["ask", "reply", "note", "watch"].includes(kind)) return undefined
  const [to, after] = kind === "reply" ? ["", tail] : head(tail)
  const flags = messageFlags(after)
  const asked = [...text.matchAll(/<dispatch\b[^>\n]*\bkind="ask"[^>\n]*\bid="(dp_[^"]+)"/g)].at(-1)?.[1]
  const id = flags.id === "last" ? asked : flags.id
  return {
    kind: "message",
    message: kind,
    text: flags.text || "e2e 영역 메시지입니다.",
    ...(to === "" ? {} : { to }),
    ...(flags.member === undefined ? {} : { member: flags.member }),
    ...(id === undefined ? {} : { id }),
    ...(flags.on === undefined ? {} : { on: flags.on }),
  }
}

function messageFlags(text: string): {
  readonly member?: string
  readonly id?: string
  readonly on?: string
  readonly text: string
} {
  const [word, tail] = head(text)
  for (const flag of ["member", "id", "on"] as const)
    if (word.startsWith(`+${flag}=`)) return { ...messageFlags(tail), [flag]: word.slice(flag.length + 2) }
  return { text }
}

function flagsOf(text: string): {
  readonly fresh: boolean
  readonly task?: string
  readonly member?: string
  readonly text: string
} {
  const [word, tail] = head(text)
  if (word === "+fresh") return { ...flagsOf(tail), fresh: true }
  if (word.startsWith("+task=")) return { ...flagsOf(tail), task: word.slice("+task=".length) }
  if (word.startsWith("+member=")) return { ...flagsOf(tail), member: word.slice("+member=".length) }
  return { fresh: false, text }
}

/** The first word and the trimmed rest. */
function head(text: string): readonly [string, string] {
  const match = /^(\S*)\s*([\s\S]*)$/.exec(text.trim())
  return [match?.[1] ?? "", (match?.[2] ?? "").trim()]
}

function split(text: string) {
  return text.split(/\s+/).filter((word) => word !== "")
}

type Entry =
  | { readonly kind: "user" | "system"; readonly text: string; readonly call?: undefined }
  | { readonly kind: "result"; readonly text: string; readonly call?: string }
  | { readonly kind: "other"; readonly text: ""; readonly call?: undefined }

/** A Responses `input` item. */
function responsesEntry(item: unknown): Entry[] {
  if (!isRecord(item)) return []
  // A freeform tool's result (core's `patch` on a model whose capabilities take freeform input, upstream #61703; Codex's
  // apply_patch and exec) is a custom_tool_call_output.
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output")
    return [result(textOf(item.output), item.call_id)]
  if (item.role === "user") return [{ kind: "user", text: textOf(item.content) }]
  if (item.role === "system" || item.role === "developer") return [{ kind: "system", text: textOf(item.content) }]
  return [{ kind: "other", text: "" }]
}

/** An Anthropic or chat message: tool results are `tool_result` blocks of a user message, or `tool` messages. */
function messageEntry(message: unknown): Entry[] {
  if (!isRecord(message)) return []
  if (message.role === "tool") return [result(textOf(message.content), message.tool_call_id)]
  if (message.role === "system" || message.role === "developer")
    return [{ kind: "system", text: textOf(message.content) }]
  if (message.role !== "user") return [{ kind: "other", text: "" }]
  const results = (Array.isArray(message.content) ? message.content : []).filter(
    (block): block is Readonly<Record<string, unknown>> => isRecord(block) && block.type === "tool_result",
  )
  if (results.length > 0) return results.map((block) => result(textOf(block.content), block.tool_use_id))
  return [{ kind: "user", text: textOf(message.content) }]
}

function result(text: string, call: unknown): Entry {
  return typeof call === "string" ? { kind: "result", text, call } : { kind: "result", text }
}

/** The text of a string, a content-part list or a JSON value (tool outputs). */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : textOf(part)))
      .join("\n")
  if (value === undefined || value === null) return ""
  return JSON.stringify(value)
}

/** A voice plan token in a tool result's text (`"token":"…"`, also inside an escaped JSON string). */
const TOKEN = /\\?"token\\?"\s*:\s*\\?"([0-9A-Za-z]{16,128})\\?"/g

/** `text` as JSON, or `undefined` when it is not JSON. */
function json(text: string): unknown {
  return Option.getOrUndefined(decodeJson(text))
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
