// Pure logic of the screens for other tools' conversations (09 §3, §6): the list's filters and rows (sub-agents
// folded under their parent, `모든 폴더` grouped by cwd), the row tags with the Q3 rule, the viewer's page window and
// turn bookkeeping, which compaction a marker shows, the outline's re-reads while it streams, search hits and the text
// copy; for I2 the `이어서 하기` dialog's default target, mode rows, plan input and its debounce, send notice, job
// progress and restore, and the alternatives after a failure. No Solid, no DOM: unit-tested in import.test.ts and
// dialog.test.ts with a fake client for own.import.
import type { SessionMessageInfo } from "@opencode/client"
import type { Account, Limit } from "@own/protocol"
import { LimitRank } from "@own/protocol/limit-rank"
import { Preset } from "@own/protocol/preset"
import {
  IMPORT_META,
  OwnRpcError,
  type ImportEvent,
  type ImportInput,
  type ImportKind,
  type ImportOutput,
  type ImportSourceRef,
  type ImportSummary,
} from "@/data"
import type { ImportRef } from "@/routing/routes"
import type { TargetRef } from "@/switcher"
import { refKey } from "./store"
import type { ImportKey } from "./strings"

export { refKey }

export type Summary = ImportSummary
export type ReadOutput = ImportOutput<"sessions.read">
export type Outline = ReadOutput["outline"]
export type Hit = ImportOutput<"sessions.search">["hits"][number]
export type CheckpointKind = Outline["checkpoints"][number]["kind"]

export const TOOL_NAME: { readonly [K in ImportKind]: string } = { codex: "Codex", "claude-code": "Claude Code" }

const DAY = 86_400_000

// ---------------------------------------------------------------------------------------------------------------
// References

/** The route's form of a reference (plain tokens). */
export function routeRef(ref: ImportSourceRef): ImportRef {
  return { kind: ref.kind, rootID: ref.rootID, id: ref.id }
}

// ---------------------------------------------------------------------------------------------------------------
// List (09 §6 목록)

export type KindFilter = "all" | ImportKind

export interface ListFilters {
  /** `전체 / Codex / Claude Code`: `sessions.list` has no kind input, so the loaded rows are filtered here. */
  readonly kind: KindFilter
  /** `이 폴더 / 모든 폴더`. */
  readonly scope: "folder" | "all"
  readonly subagents: boolean
  readonly archived: boolean
  /** `자동 실행` (Codex `exec`), off by default. */
  readonly exec: boolean
}

export const DEFAULT_FILTERS: ListFilters = {
  kind: "all",
  scope: "folder",
  subagents: false,
  archived: false,
  exec: false,
}

/** The `sessions.list` input of the filters and the title search (at most 200 characters, 09 §5.2). */
export function listInput(
  directory: string,
  filters: ListFilters,
  query: string,
  cursor?: string,
): ImportInput<"sessions.list"> {
  const title = query.trim().slice(0, 200)
  return {
    directory,
    scope: filters.scope,
    include: { subagents: filters.subagents, exec: filters.exec, archived: filters.archived },
    ...(title ? { query: title } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

export type ListRow =
  /** `모든 폴더`: the conversations of one working folder follow its row. */
  | {
      readonly type: "folder"
      readonly key: string
      readonly cwd: string
      readonly count: number
      readonly exists: boolean
      readonly otherComputer: boolean
    }
  | {
      readonly type: "item"
      readonly key: string
      readonly summary: Summary
      /** A sub-agent conversation shown under its parent. */
      readonly child: boolean
      /** Loaded sub-agent conversations folded under this row. */
      readonly children: number
      readonly open: boolean
    }

/**
 * The rows on screen, in the server's order (newest first): the kind filter applied, sub-agent conversations folded
 * under a loaded parent (shown while its key is in `open`), and in scope `all` grouped by cwd, the group of the
 * newest conversation first. A sub-agent whose parent is not loaded stays a row of its own.
 */
export function listRows(items: readonly Summary[], filters: ListFilters, open: ReadonlySet<string>): ListRow[] {
  const kept = items.filter((item) => filters.kind === "all" || item.ref.kind === filters.kind)
  const present = new Set(kept.map((item) => refKey(item.ref)))
  const children = new Map<string, Summary[]>()
  const top: Summary[] = []
  for (const item of kept) {
    const parent = item.parent ? refKey(item.parent) : undefined
    if (parent && present.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), item])
      continue
    }
    top.push(item)
  }
  const rows = (list: readonly Summary[]) =>
    list.flatMap((item): ListRow[] => {
      const key = refKey(item.ref)
      const folded = children.get(key) ?? []
      const shown = folded.length > 0 && open.has(key)
      return [
        { type: "item", key, summary: item, child: false, children: folded.length, open: shown },
        ...(shown
          ? folded.map(
              (child): ListRow => ({
                type: "item",
                key: refKey(child.ref),
                summary: child,
                child: true,
                children: 0,
                open: false,
              }),
            )
          : []),
      ]
    })
  if (filters.scope === "folder") return rows(top)
  const groups = new Map<string, Summary[]>()
  for (const item of top) {
    const key = folderKey(item.cwd)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups].flatMap(([key, members]): ListRow[] => [
    {
      type: "folder",
      key: `folder:${key}`,
      cwd: members[0]!.cwd,
      count: members.length,
      exists: members.some((item) => item.folderExists),
      otherComputer: members.every((item) => item.otherComputer),
    },
    ...rows(members),
  ])
}

/** Folders as Windows compares them: separators and case do not matter, nor a trailing separator. */
function folderKey(cwd: string) {
  const unified = cwd.replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[A-Za-z]:/.test(unified) || unified.startsWith("//") ? unified.toLowerCase() : unified
}

// ---------------------------------------------------------------------------------------------------------------
// Tags (09 §6 목록, §8.2 Q3)

export type RowTag =
  | { readonly kind: "imported" }
  | { readonly kind: "newTurns"; readonly n: number }
  | { readonly kind: "live" }
  | { readonly kind: "folderMissing" }
  | { readonly kind: "unreadable"; readonly problem?: Summary["problem"] }
  | { readonly kind: "expires"; readonly days: number }
  | { readonly kind: "archived" }
  | { readonly kind: "exec" }
  | { readonly kind: "otherComputer" }

/**
 * Claude Code's default `cleanupPeriodDays`: its settings file is outside the files own reads (09 §2.1), so the
 * default stands for every Claude Code root (IMPORT phase note (b)).
 */
export const CLAUDE_CLEANUP_DAYS = 30
/** From this many days left the row carries the tag; before that only its tooltip says it (phase note (b)). */
export const EXPIRY_TAG_DAYS = 7

/**
 * Q3 (09 §8.2): a Claude Code conversation not imported yet may lose its file `days` days after its last activity.
 * `days` is 0 once the period passed (the next Claude Code start may remove it). `undefined` for other rows.
 */
export function expiry(summary: Summary, now: number) {
  if (summary.ref.kind !== "claude-code" || summary.imported.length > 0) return undefined
  const left = CLAUDE_CLEANUP_DAYS - Math.floor(Math.max(0, now - summary.updatedAt) / DAY)
  const days = Math.max(0, left)
  return { days, tag: days <= EXPIRY_TAG_DAYS }
}

/** The tags of a row, in the order they are shown. */
export function rowTags(summary: Summary, now: number): RowTag[] {
  const latest = summary.imported.toSorted((a, b) => b.importedAt - a.importedAt)[0]
  const expires = expiry(summary, now)
  return [
    ...(latest ? [{ kind: "imported" } as const] : []),
    ...(latest?.newTurns ? [{ kind: "newTurns", n: latest.newTurns } as const] : []),
    ...(summary.live ? [{ kind: "live" } as const] : []),
    ...(summary.folderExists ? [] : [{ kind: "folderMissing" } as const]),
    ...(summary.readable ? [] : [{ kind: "unreadable", problem: summary.problem } as const]),
    ...(expires?.tag ? [{ kind: "expires", days: expires.days } as const] : []),
    ...(summary.archived ? [{ kind: "archived" } as const] : []),
    ...(summary.app === "exec" ? [{ kind: "exec" } as const] : []),
    ...(summary.otherComputer ? [{ kind: "otherComputer" } as const] : []),
  ]
}

/** The import a row's `가져옴 → 열기` opens: the newest. */
export function latestImport(summary: Pick<Summary, "imported">) {
  return summary.imported.toSorted((a, b) => b.importedAt - a.importedAt)[0]
}

/** `원래: <모델>`: the model the tool used last. */
export function lastModel(summary: Pick<Summary, "models">) {
  return summary.models.at(-1)?.id
}

/** `Codex 0.150.0–0.153.2`: the first and last tool versions seen. */
export function versionRange(versions: readonly string[]) {
  const first = versions[0]
  const last = versions.at(-1)
  if (!first || !last) return undefined
  return first === last ? first : `${first}–${last}`
}

// ---------------------------------------------------------------------------------------------------------------
// Viewer pages (09 §3): a window of consecutive turns, extended at either end or replaced by a jump.

export interface ViewWindow {
  /** The window's first turn (0-based). */
  readonly start: number
  /** `from` of the page after the window; `undefined`: the window reaches the last turn. */
  readonly next: number | undefined
  readonly messages: readonly SessionMessageInfo[]
}

export interface Page {
  readonly messages: readonly SessionMessageInfo[]
  readonly next?: number
}

/** A window of one page read at `from`. */
export function pageWindow(from: number, page: Page): ViewWindow {
  return { start: from, next: page.next, messages: page.messages }
}

/** The page read at `window.next` joins the end. */
export function appendPage(window: ViewWindow, page: Page): ViewWindow {
  return { start: window.start, next: page.next, messages: [...window.messages, ...page.messages] }
}

/** The page read at `from` with `count = window.start − from` joins the front. */
export function prependPage(window: ViewWindow, from: number, page: Page): ViewWindow {
  return { start: from, next: window.next, messages: [...page.messages, ...window.messages] }
}

/** The page before the window: at most `size` turns ending at the window's first turn; `undefined` at turn 0. */
export function previousPage(window: Pick<ViewWindow, "start">, size: number) {
  if (window.start <= 0) return undefined
  const from = Math.max(0, window.start - size)
  return { from, count: window.start - from }
}

/**
 * Where a view message sits in the source conversation: own.import's view puts `{turn, step?, kind?, requests?}`
 * under this metadata key on every message (a compaction adds the step it stands before, its kind and how many user
 * requests its kept part holds). Derived from src/data's key, which alone names own.import (03 §16.3).
 */
export const VIEW_KEY = `${IMPORT_META.session}.view`

export interface Place {
  readonly turn: number
  readonly kind?: CheckpointKind
  readonly requests?: number
}

/** A message's place; `undefined` without one (the view always writes it, so this only guards odd input). */
export function placeOf(message: SessionMessageInfo): Place | undefined {
  const value = message.metadata?.[VIEW_KEY]
  if (typeof value !== "object" || value === null || !("turn" in value) || typeof value.turn !== "number")
    return undefined
  const kind = "kind" in value && (value.kind === "foreign" || value.kind === "codex-remote") ? value.kind : undefined
  const requests = "requests" in value && typeof value.requests === "number" ? value.requests : undefined
  return { turn: value.turn, ...(kind ? { kind } : {}), ...(requests === undefined ? {} : { requests }) }
}

/**
 * The turn of every message of the window, and each turn's user message (a turn without user text has none). The
 * place metadata decides; a message without it belongs to the turn its last user message opened.
 */
export function turnIndex(window: Pick<ViewWindow, "start" | "messages">) {
  const users = new Map<number, string>()
  const turns = new Map<string, number>()
  const last = { turn: window.start - 1 }
  for (const message of window.messages) {
    const turn = placeOf(message)?.turn ?? (message.type === "user" ? last.turn + 1 : Math.max(last.turn, window.start))
    last.turn = turn
    turns.set(message.id, turn)
    if (message.type === "user" && !users.has(turn)) users.set(turn, message.id)
  }
  return { users, turns }
}

/** The turns the window holds are `[start, end)`. */
export function windowEnd(window: Pick<ViewWindow, "start" | "messages" | "next">) {
  if (window.next !== undefined) return window.next
  const turns = [...turnIndex(window).turns.values()]
  return turns.length ? Math.max(...turns) + 1 : window.start
}

/**
 * The user message to scroll to for a turn: its own, else the nearest earlier one in the window (a turn without user
 * text draws under the turn before it).
 */
export function turnAnchor(window: Pick<ViewWindow, "start" | "messages">, turn: number) {
  const users = turnIndex(window).users
  const earlier = [...users.keys()].filter((index) => index <= turn).toSorted((a, b) => b - a)[0]
  return earlier === undefined ? undefined : users.get(earlier)
}

/**
 * Which compaction each compaction message of the window stands for. Its place says the kind and the requests its
 * kept part holds; without them the k-th compaction inside a turn is the k-th outline checkpoint of that turn.
 */
export function compactionKinds(window: Pick<ViewWindow, "start" | "messages">, outline: Pick<Outline, "checkpoints">) {
  const turns = turnIndex(window).turns
  const byTurn = Map.groupBy(
    outline.checkpoints.toSorted((a, b) => a.turn - b.turn || a.step - b.step),
    (checkpoint) => checkpoint.turn,
  )
  const seen = new Map<number, number>()
  const kinds = new Map<string, Compacted>()
  for (const message of window.messages) {
    if (message.type !== "compaction") continue
    const place = placeOf(message)
    const turn = turns.get(message.id) ?? window.start
    const index = seen.get(turn) ?? 0
    seen.set(turn, index + 1)
    const kind = place?.kind ?? byTurn.get(turn)?.[index]?.kind
    if (kind) kinds.set(message.id, { kind, requests: place?.requests ?? requestsBefore(turn) })
  }
  return kinds
}

export interface Compacted {
  readonly kind: CheckpointKind
  /** `그 앞의 사용자 요청 N개는 남아 있음`. */
  readonly requests: number
}

/**
 * Without the view's count: a checkpoint sits inside its turn, after that turn's user request, so the requests
 * before it are the turns up to and including its own.
 */
export function requestsBefore(turn: number) {
  return turn + 1
}

// ---------------------------------------------------------------------------------------------------------------
// Outline panel (09 §3: turns with their first lines, compaction places, sub-agent conversations)

export type OutlineEntry =
  | {
      readonly type: "turn"
      readonly key: string
      readonly index: number
      readonly line: string
      readonly time: number
      /** Compactions inside this turn. */
      readonly compactions: number
    }
  | {
      readonly type: "child"
      readonly key: string
      readonly ref: Outline["children"][number]["ref"]
      readonly title: string | undefined
    }
  /** `읽는 중`: the outline still streams. */
  | { readonly type: "reading"; readonly key: "reading" }
  | { readonly type: "failed"; readonly key: "failed" }

/** The panel's rows: each turn, the sub-agent conversations it started, the rest of them, then the reading state. */
export function outlineEntries(outline: Outline, complete: boolean, failed: boolean): OutlineEntry[] {
  const compactions = Map.groupBy(outline.checkpoints, (checkpoint) => checkpoint.turn)
  const known = new Set(outline.turns.map((turn) => turn.index))
  const children = Map.groupBy(outline.children, (child) =>
    child.turn !== undefined && known.has(child.turn) ? child.turn : -1,
  )
  const child = (item: Outline["children"][number]): OutlineEntry => ({
    type: "child",
    key: `child:${refKey(item.ref)}`,
    ref: item.ref,
    title: item.title,
  })
  return [
    ...outline.turns.flatMap((turn): OutlineEntry[] => [
      {
        type: "turn",
        key: `turn:${turn.index}`,
        index: turn.index,
        line: turn.firstLine,
        time: turn.time,
        compactions: compactions.get(turn.index)?.length ?? 0,
      },
      ...(children.get(turn.index) ?? []).map(child),
    ]),
    ...(children.get(-1) ?? []).map(child),
    ...(complete
      ? []
      : failed
        ? [{ type: "failed", key: "failed" } as const]
        : [{ type: "reading", key: "reading" } as const]),
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Outline while it streams (09 §2.8: a `.zst` conversation's outline grows until `outlineComplete`)

export type OutlineFollow = "complete" | "stopped" | "failed"

/**
 * Re-reads the outline until it is complete: the first wait `first` ms, doubling up to `max`. Ends early when
 * `stopped()` (the viewer closed or another conversation opened) or when a read fails. Nothing else re-asks, and the
 * waits are the viewer's own (03 §20.2 R9: no timer outlives the open view).
 */
export async function followOutline<Value extends Pick<ReadOutput, "outlineComplete">>(input: {
  readonly read: () => Promise<Value>
  readonly apply: (value: Value) => void
  readonly wait: (ms: number) => Promise<void>
  readonly stopped: () => boolean
  readonly first?: number
  readonly max?: number
}): Promise<OutlineFollow> {
  const max = input.max ?? 8_000
  const step = async (delay: number): Promise<OutlineFollow> => {
    await input.wait(delay)
    if (input.stopped()) return "stopped"
    const value = await input.read().catch(() => undefined)
    if (input.stopped()) return "stopped"
    if (!value) return "failed"
    input.apply(value)
    if (value.outlineComplete) return "complete"
    return step(Math.min(max, delay * 2))
  }
  return step(input.first ?? 750)
}

// ---------------------------------------------------------------------------------------------------------------
// Search (09 §3 검색)

/** Hits of a continued search (`계속 찾기`) join the earlier ones; the same turn of a conversation is listed once. */
export function mergeHits(previous: readonly Hit[], next: readonly Hit[]): Hit[] {
  const seen = new Set(previous.map((hit) => `${refKey(hit.ref)}#${hit.turn}`))
  return [
    ...previous,
    ...next.filter((hit) => {
      const key = `${refKey(hit.ref)}#${hit.turn}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  ]
}

/** Content hits grouped by conversation in the order found. */
export function hitGroups(hits: readonly Hit[]) {
  const groups = new Map<string, { readonly ref: Hit["ref"]; readonly hits: Hit[] }>()
  for (const hit of hits) {
    const key = refKey(hit.ref)
    const group = groups.get(key) ?? { ref: hit.ref, hits: [] }
    groups.set(key, group)
    group.hits.push(hit)
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------------------------------------------
// 텍스트로 복사 (09 §3 동작)

export interface CopyLabels {
  readonly user: string
  readonly assistant: string
  readonly tool: string
  readonly compaction: string
  /** A context reset (core P-035, 03 §18.18): a completed compaction without a summary, which it is not. */
  readonly reset: string
  readonly resetUndone: string
}

const COPY_INPUT = 300
const COPY_OUTPUT = 2_000

/** The conversation as plain text: user and model text, each tool call on one line with a short result. */
export function transcriptText(input: {
  readonly title: string
  readonly header: string
  readonly messages: readonly SessionMessageInfo[]
  readonly labels: CopyLabels
}) {
  const blocks = input.messages.flatMap((message): string[] => {
    if (message.type === "user") return [`## ${input.labels.user}\n\n${message.text}`]
    if (message.type === "compaction" && message.status === "completed" && message.reason === "reset")
      return [`--- ${message.undone ? input.labels.resetUndone : input.labels.reset} ---`]
    if (message.type === "compaction")
      return [
        `--- ${input.labels.compaction} ---${message.status === "completed" && message.summary ? `\n\n${message.summary}` : ""}`,
      ]
    if (message.type !== "assistant") return []
    const parts = message.content.flatMap((content): string[] => {
      if (content.type === "text") return content.text.trim() ? [content.text] : []
      if (content.type !== "tool") return []
      const call = `[${input.labels.tool}: ${content.name}] ${clip(JSON.stringify(content.state.input), COPY_INPUT)}`
      const output =
        "content" in content.state && content.state.content
          ? content.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
          : ""
      return [output ? `${call}\n${clip(output, COPY_OUTPUT)}` : call]
    })
    return parts.length ? [`## ${input.labels.assistant}\n\n${parts.join("\n\n")}`] : []
  })
  return [`# ${input.title}`, input.header, ...blocks].join("\n\n") + "\n"
}

function clip(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

// ---------------------------------------------------------------------------------------------------------------
// 이어서 하기 (I2: 09 §4.5–4.8, §6 이어서 하기 대화상자)

export type Plan = ImportOutput<"migrate.plan">
export type ModeOption = Plan["modes"][number]
export type Mode = ModeOption["mode"]
export type SummarySource = NonNullable<ModeOption["source"]>
export type Reason = NonNullable<ModeOption["reason"]>
export type PlanWarning = Plan["warnings"][number]
export type Job = ImportOutput<"jobs.list">["jobs"][number]
export type JobStep = Job["step"]
export type JobError = NonNullable<Extract<ImportEvent, { name: "job.finished" }>["data"]["error"]>

/**
 * The company of the source tool (09 §4.5: Codex → the ChatGPT `codex` slot's, Claude Code → the Claude subscription
 * slot's), in `Preset.company` terms, so `원래와 같은 회사` compares like the R4 checks do.
 */
export const TOOL_COMPANY: { readonly [K in ImportKind]: string } = {
  codex: Preset.company({ kind: "codex" }),
  "claude-code": Preset.company({ kind: "claude-sub" }),
}

/**
 * The subscription slots of the source tool (09 §4.5): Codex → the ChatGPT ones (`codex`, and `siwc` of the same
 * login), Claude Code → the Claude subscription. An API key of the same company is not the tool's slot: it is
 * metered, so it is never the default.
 */
const TOOL_SLOTS: { readonly [K in ImportKind]: ReadonlySet<Account.View["kind"]> } = {
  codex: new Set(["codex", "siwc"]),
  "claude-code": new Set(["claude-sub"]),
}

/** The service's test: `ready`, or an own account still `unverified` (the Claude slot's means not acknowledged). */
function serving(account: Pick<Account.View, "status" | "kind">) {
  return account.status === "ready" || (account.status === "unverified" && account.kind !== "claude-sub")
}

/**
 * The target the dialog starts with (09 §4.5, 07 R4, U1). A subscription slot of the source tool when there is one
 * (`원래와 같은 회사`, {@link TOOL_SLOTS}): the one this folder used last, else the first in account order that can
 * serve (a plan refuses a target account that cannot run, `account_not_ready`), else the first; its model is the
 * provider group's new-session default. Without one, the folder's new-session default (07 §2.2). Only a starting
 * value: the user changes it, and own never picks by headroom. `account` names the slot: several Claude accounts share
 * `anthropic` (02 §8.7), so the target's provider alone does not ({@link targetAccount}).
 */
export function defaultTarget(input: {
  readonly kind: ImportKind
  /** The accounts the picker lists, in account order (a team folder's already filtered with `outsideTeam`). */
  readonly accounts: readonly Account.View[]
  /** providerIDs of this folder's sessions, newest first. */
  readonly recent: readonly string[]
  /** The model a new session on the account starts with (its provider group's default, 07 §2.2). */
  readonly modelOf: (account: Account.View) => TargetRef | undefined
  /** The folder's new-session default. */
  readonly folder: TargetRef | undefined
}): { readonly target: TargetRef | undefined; readonly sameCompany: boolean; readonly account?: Account.View } {
  const same = input.accounts.filter((account) => TOOL_SLOTS[input.kind].has(account.kind))
  const account =
    input.recent.flatMap((providerID) => same.filter((item) => item.providerID === providerID))[0] ??
    same.find(serving) ??
    same[0]
  if (!account) return { target: input.folder, sameCompany: false }
  return { target: input.modelOf(account), sameCompany: true, account }
}

/**
 * The account the conversation continues on (09 §4.5): the one picked while it serves the target's provider, else the
 * provider's account (`byProvider`, own's `accountFor`). Several Claude accounts share `anthropic` (02 §8.7) and the
 * provider names only the first one listed, so without the pick Claude 2 snapped back to Claude 1.
 */
export function targetAccount(
  picked: Account.View | undefined,
  target: TargetRef | undefined,
  byProvider: (providerID: string) => Account.View | undefined,
) {
  if (!target) return undefined
  return picked?.providerID === target.providerID ? picked : byProvider(target.providerID)
}

/**
 * `추천` alternatives when the usage left is short (`quota_insufficient`, 09 §4.5, §4.6; 02 §5.10 headroom order): the
 * other ready accounts of the target's kind, each ranked as every surface ranks (`LimitRank`, LV 2026-10-25) with the
 * model it would run (`model(account)`, what picking it chooses): the most room left first, unknown last (`used`, its
 * lead's used share). An account whose lead for that model is used up, a used-up window known only by its state
 * (`주간 · Opus 차단`) included, is no alternative. Shown for the user to pick; nothing switches by itself.
 */
export function headroomRanked(
  accounts: readonly Account.View[],
  current: Account.View | undefined,
  quota: Readonly<Record<string, readonly Limit.Window[] | undefined>>,
  now: number,
  model: (account: Account.View) => string | undefined,
) {
  if (!current) return []
  return accounts
    .filter((account) => account.kind === current.kind && account.id !== current.id && account.status === "ready")
    .flatMap((account) => {
      const lead = LimitRank.ranked(quota[account.id] ?? [], now, model(account))[0]
      const facts = lead && LimitRank.facts(lead, now)
      return facts?.status === "exhausted" ? [] : [{ account, used: facts?.percent }]
    })
    .toSorted((a, b) => (a.used ?? Number.POSITIVE_INFINITY) - (b.used ?? Number.POSITIVE_INFINITY))
}

/** The plan reports a usage shortage for the target (the warning, or the chosen row's reason). */
export function quotaShort(plan: Pick<Plan, "warnings">, row: ModeOption | undefined) {
  return plan.warnings.includes("quota_insufficient") || row?.reason === "quota_insufficient"
}

// ---- mode rows (09 §4.3 table, §6: `그대로 이어가기`, `요약해서 이어가기` with `[이어 갈 모델로 요약]` `[LLM 없이]`)

/** The user's pick of a row; `undefined`: the plan's recommended row. */
export interface ModeChoice {
  readonly mode: Mode
  readonly source?: SummarySource
}

export interface ModeRows {
  readonly full: ModeOption | undefined
  readonly llm: ModeOption | undefined
  readonly brief: ModeOption | undefined
}

export function modeRows(plan: Pick<Plan, "modes">): ModeRows {
  return {
    full: plan.modes.find((row) => row.mode === "full"),
    llm: plan.modes.find((row) => row.mode === "summary" && row.source === "llm"),
    brief: plan.modes.find((row) => row.mode === "summary" && row.source === "brief"),
  }
}

/** The row the plan runs and the dialog shows chosen: the user's pick, else the recommended row, else an available one. */
export function selectedRow(plan: Pick<Plan, "modes">, choice: ModeChoice | undefined) {
  if (choice)
    return plan.modes.find(
      (row) => row.mode === choice.mode && (choice.mode === "full" || row.source === choice.source),
    )
  return plan.modes.find((row) => row.recommended) ?? plan.modes.find((row) => row.available)
}

/**
 * `요약해서 이어가기` as one row: choosable when either source is, else dimmed with the LLM source's reason (or the
 * brief's): `창에 들어가서 필요 없음`, `남은 사용량 부족`, ….
 */
export function summaryState(rows: ModeRows) {
  const available = !!rows.llm?.available || !!rows.brief?.available
  return { available, reason: available ? undefined : (rows.llm?.reason ?? rows.brief?.reason) }
}

/** The source picked with `요약해서 이어가기`: the recommended one, else the LLM summary when it can run, else none. */
export function summarySource(rows: ModeRows): SummarySource {
  if (rows.llm?.recommended) return "llm"
  if (rows.brief?.recommended) return "brief"
  return rows.llm?.available ? "llm" : "brief"
}

/** A row as a choice, so the next plan runs that row. */
export function choiceOf(row: Pick<ModeOption, "mode" | "source">): ModeChoice {
  return row.mode === "full" ? { mode: "full" } : { mode: "summary", source: row.source }
}

/** The button reads `요약하고 가져오기` when the chosen row summarizes with an LLM, else `가져오기` (09 §4.5). */
export function summarizes(row: Pick<ModeOption, "mode" | "source"> | undefined) {
  return row?.mode === "summary" && row.source === "llm"
}

/**
 * The send notice above the button, for every row (09 §4.5 동의와 전송 안내, IG10): `now` when the row sends tokens now
 * to summarize (`요약하려고 약 N 토큰이 지금 …`), else `first` (`첫 메시지와 함께 약 N 토큰이 …`); `다른 회사` whenever
 * the receiver is not the source tool's company.
 */
export function sendNotice(row: Pick<ModeOption, "send">) {
  const send = row.send
  return {
    key: send.now > 0 ? ("now" as const) : ("first" as const),
    now: send.now,
    withFirst: send.withFirst,
    accountID: send.accountID,
    company: send.company,
    crossCompany: send.crossCompany,
  }
}

// ---- plan input and its debounce (09 §6: every change asks `migrate.plan` again after 300 ms)

/** What the dialog's controls hold; each change plans again. */
export interface MigrateInputs {
  readonly ref: ImportRef
  /** The folder the list was opened for. */
  readonly directory: string
  /** `all`: the conversation may lie outside the folder's project (this PC's windows only, 09 §5.5). */
  readonly scope?: "all"
  readonly target: TargetRef
  /**
   * The picked account of `target` (`targetAccount`): several accounts serve one provider (every Claude account serves
   * `anthropic`), so the plan's costs, quota check and send notice are this account's (09 §4.5).
   */
  readonly accountID?: Account.View["id"]
  readonly choice?: ModeChoice
  /** `여기까지` (0-based). */
  readonly upToTurn?: number
  /** `이 폴더에서 이어가기`, `이 폴더로 가져오기`. */
  readonly location?: string
  /** `원래 대화 전체도 own에 저장` (Q3: on by default). */
  readonly storeFull: boolean
  /** `비밀 가리기` (on by default). */
  readonly redact: boolean
}

export function planInput(inputs: MigrateInputs): ImportInput<"migrate.plan"> {
  const target = inputs.target
  return {
    ref: { kind: inputs.ref.kind, rootID: inputs.ref.rootID, id: inputs.ref.id },
    directory: inputs.directory,
    ...(inputs.scope ? { scope: inputs.scope } : {}),
    target: { providerID: target.providerID, id: target.id, ...(target.variant ? { variant: target.variant } : {}) },
    ...(inputs.accountID === undefined ? {} : { accountID: inputs.accountID }),
    ...(inputs.choice ? { mode: inputs.choice.mode } : {}),
    ...(inputs.choice?.source ? { source: inputs.choice.source } : {}),
    ...(inputs.upToTurn === undefined ? {} : { upToTurn: inputs.upToTurn }),
    ...(inputs.location ? { location: inputs.location } : {}),
    storeFull: inputs.storeFull,
    redact: inputs.redact,
  }
}

export const PLAN_DELAY = 300

export interface Timers {
  readonly set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clear: (timer: ReturnType<typeof setTimeout> | undefined) => void
}

const TIMERS: Timers = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) }

/** Runs the last value pushed once `delay` ms pass without another push; `now` runs at once (the dialog's first plan). */
export function debounce<T>(run: (value: T) => void, delay = PLAN_DELAY, timers: Timers = TIMERS) {
  const state: { timer?: ReturnType<typeof setTimeout> } = {}
  const cancel = () => {
    timers.clear(state.timer)
    state.timer = undefined
  }
  return {
    push(value: T) {
      cancel()
      state.timer = timers.set(() => {
        state.timer = undefined
        run(value)
      }, delay)
    },
    now(value: T) {
      cancel()
      run(value)
    },
    cancel,
    pending: () => state.timer !== undefined,
  }
}

/** A plan request's outcome as {@link createPlanner} hands it over. */
export interface PlanAnswer<T, P> {
  /** The inputs it was asked with. */
  readonly value: T
  readonly result: { readonly ok: true; readonly plan: P } | { readonly ok: false; readonly failure: unknown }
  /**
   * It answers the inputs as they are now and no re-plan waits for the debounce: only then may its nonce run. An
   * answer that lands after the user changed the target or the mode would import with the old ones (09 §4.5, IG9).
   */
  readonly current: boolean
}

/**
 * The dialog's plans (09 §6): the first at once, each change {@link PLAN_DELAY} ms after the last one, `again` at once
 * (a used or refused nonce). Only the newest request's answer is handed over, with whether it is still current.
 */
export function createPlanner<T, P>(input: {
  readonly ask: (value: T) => Promise<P>
  /** The inputs as they are now. */
  readonly inputs: () => T | undefined
  /** A request starts (`계획하는 중`). */
  readonly started: () => void
  readonly answered: (answer: PlanAnswer<T, P>) => void
  readonly timers?: Timers
}) {
  const state = { asked: 0 }
  const debounced = debounce(
    async (value: T) => {
      const id = ++state.asked
      input.started()
      const result = await input.ask(value).then(
        (plan) => ({ ok: true as const, plan }),
        (failure: unknown) => ({ ok: false as const, failure }),
      )
      if (id !== state.asked) return
      const current = !debounced.pending() && JSON.stringify(value) === JSON.stringify(input.inputs())
      input.answered({ value, result, current })
    },
    PLAN_DELAY,
    input.timers,
  )
  return {
    /** The inputs changed: the first plan goes at once, later ones after the debounce. */
    changed: (value: T, first: boolean) => (first ? debounced.now(value) : debounced.push(value)),
    /** The same inputs again, at once. */
    again: (value: T) => debounced.now(value),
    pending: debounced.pending,
    /** Drops what is pending and any answer still to come. */
    cancel: () => {
      debounced.cancel()
      state.asked += 1
    },
  }
}

// ---- the job (09 §4.8, §5.3, §6 진행)

export interface JobView {
  readonly jobID: string
  readonly ref: ImportRef
  readonly step: JobStep
  readonly startedAt: number
  /** The job summarizes with an LLM (its bar has `요약 중`); `undefined` for a job restored from `jobs.list`. */
  readonly summarizes?: boolean
  /** The imported session, once it succeeded. */
  readonly sessionID?: string
  readonly outcome?: "succeeded" | "failed" | "cancelled"
  readonly error?: JobError
}

/** The running job after a reopen or a reload (`jobs.list`: at most one per service). */
export function restoreJob(jobs: readonly Job[]): JobView | undefined {
  const job = jobs[0]
  if (!job) return undefined
  return { jobID: job.jobID, ref: job.ref, step: job.step, startedAt: job.startedAt }
}

/** A `job.*` event applied to the job it names; other events, and events after the job ended, change nothing. */
export function jobEvent(job: JobView | undefined, event: ImportEvent): JobView | undefined {
  if (!job || event.name === "index.changed" || event.data.jobID !== job.jobID || job.outcome) return job
  if (event.name === "job.progress")
    return { ...job, step: event.data.step, summarizes: event.data.step === "summarizing" ? true : job.summarizes }
  return {
    ...job,
    outcome: event.data.outcome,
    ...(event.data.sessionID ? { sessionID: event.data.sessionID } : {}),
    ...(event.data.error ? { error: event.data.error } : {}),
  }
}

export const JOB_STEPS: readonly JobStep[] = ["reading", "summarizing", "importing"]

/** The bar's steps: `요약 중` only for an LLM summary (unknown after a restore, so shown). */
export function jobSteps(job: Pick<JobView, "summarizes">) {
  return job.summarizes === false ? JOB_STEPS.filter((step) => step !== "summarizing") : JOB_STEPS
}

export function sameSource(a: ImportRef, b: ImportRef) {
  return a.kind === b.kind && a.rootID === b.rootID && a.id === b.id
}

// ---- errors (09 §5.4): declared types worded here, never the server's text (it may hold a path)

const ERROR_KEY: Readonly<Record<string, ImportKey>> = {
  "own.scope_denied": "own.otherTools.error.scope",
  directory_unknown: "own.otherTools.error.directory_unknown",
  source_not_found: "own.otherTools.error.source_not_found",
  source_unreadable: "own.otherTools.error.source_unreadable",
  source_changed: "own.otherTools.error.source_changed",
  target_unavailable: "own.otherTools.error.target_unavailable",
  service_unreachable: "own.otherTools.error.service_unreachable",
  nonce_invalid: "own.otherTools.error.nonce_invalid",
  job_busy: "own.otherTools.error.job_busy",
}

/** A failed call as the screens word it. */
export function errorText(text: (key: ImportKey) => string, error: unknown) {
  const key = error instanceof OwnRpcError ? ERROR_KEY[error.type] : undefined
  return text(key ?? "own.otherTools.error.other")
}

const SUMMARY_FAILURE: { readonly [C in NonNullable<JobError["cause"]>]: ImportKey } = {
  exhausted: "own.otherTools.error.summary.exhausted",
  needs_reauth: "own.otherTools.error.summary.needs_reauth",
  overflow: "own.otherTools.error.summary.overflow",
  interrupted: "own.otherTools.error.summary.interrupted",
  other: "own.otherTools.error.summary.other",
}

/** How a failed job ended (`job.finished.error`): the summary's cause, else the declared type. */
export function jobErrorKey(error: JobError | undefined): ImportKey {
  if (error?.type === "summary_failed") return SUMMARY_FAILURE[error.cause ?? "other"]
  return (error && ERROR_KEY[error.type]) ?? "own.otherTools.error.other"
}

/**
 * What the dialog offers after a failed summary (09 §4.8): finishing without an LLM, moving as it is when that fits,
 * and another target (`추천`). Nothing is retried by itself.
 */
export function alternatives(rows: ModeRows | undefined): ("brief" | "full" | "target")[] {
  return [
    ...(rows?.brief?.available ? ["brief" as const] : []),
    ...(rows?.full?.available ? ["full" as const] : []),
    "target",
  ]
}
