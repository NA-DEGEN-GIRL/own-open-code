// What the agent is doing in a session's browser (03 §4.7 tab badge, §18.17 "에이전트가 조작 중" and the last action),
// and the user's takeover. Source: the session event stream the window already has. Browser tools are Code Mode tools
// (`codemode: true`, packages/plugin-browser/src/tools.ts), so they run inside one `execute` tool call; core reports
// every nested call as `session.tool.progress` metadata `toolCalls: [{tool, status, input?}]` (`tool` is the dotted
// path, e.g. `browser.click`; packages/core/src/codemode/tool.ts progressHooks) and the final list again on
// `session.tool.success` / `failed`. Nothing here talks to main or changes the session: the indicator only reads.
//
// Phases of one session (window-local, not persisted):
//  - operating: a browser call is running, or its `execute` part is still open after one → "● 에이전트가 조작 중";
//  - recent: the turn still runs and the last browser call ended less than RECENT_MS ago (the model is between calls);
//  - takeover: the user pressed "멈추고 직접 조작" (the turn was interrupted); cleared by the agent's next browser call;
// and touched tabs: the user drove a tab (address, back, reload…) while the agent was active (03 §18.17 "그 탭은
// 사용자가 조작한 것으로 표시"); cleared when the agent targets that tab again.
import type { OpenCodeEvent } from "@opencode/client"
import { createSignal } from "solid-js"
import type { ActivityPhase, BrowserActivityTracker } from "./registry"

export type { ActivityPhase, BrowserActivityTracker } from "./registry"

export const RECENT_MS = 15_000

export interface BrowserCall {
  /** Operation without the namespace: `click`, `tabs.open`, `snapshot`. */
  readonly operation: string
  readonly status: "running" | "completed" | "error"
  readonly tabID?: string
  readonly input?: Readonly<Record<string, unknown>>
}

export interface SessionActivity {
  /** The `execute` tool part that ran the latest browser call. */
  readonly partID: string
  /** Browser calls seen in that part (progress repeats the whole list). */
  readonly calls: number
  readonly last: BrowserCall
  /** Browser calls running now. */
  readonly running: number
  /** The part has not finished yet. */
  readonly open: boolean
  /** ms of the last agent change. */
  readonly at: number
  readonly takeover?: { readonly at: number; readonly tabID?: string }
  readonly touched: ReadonlySet<string>
}

/** Browser calls of an `execute` metadata value, in start order. Anything else (other tools, bad shapes) is dropped. */
export function browserCalls(metadata: unknown): BrowserCall[] {
  if (!metadata || typeof metadata !== "object") return []
  const calls = (metadata as { toolCalls?: unknown }).toolCalls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call): BrowserCall[] => {
    if (!call || typeof call !== "object") return []
    const { tool, status, input } = call as { tool?: unknown; status?: unknown; input?: unknown }
    if (typeof tool !== "string" || !tool.startsWith("browser.")) return []
    if (status !== "running" && status !== "completed" && status !== "error") return []
    const fields =
      input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
    const tabID = typeof fields?.tabID === "string" ? fields.tabID : undefined
    return [
      {
        operation: tool.slice("browser.".length),
        status,
        ...(tabID ? { tabID } : {}),
        ...(fields ? { input: fields } : {}),
      },
    ]
  })
}

export type ToolEvent = Extract<
  OpenCodeEvent,
  { type: "session.tool.progress" | "session.tool.success" | "session.tool.failed" }
>

/** Next activity of the event's session, or `undefined` when the event says nothing about the browser. */
export function reduceActivity(
  previous: SessionActivity | undefined,
  event: ToolEvent,
  now: number,
): SessionActivity | undefined {
  const calls = browserCalls(event.data.metadata)
  const partID = event.data.id
  const finished = event.type !== "session.tool.progress"
  if (!calls.length) {
    // Our part finished without final metadata (a failure can drop it): close it.
    if (finished && previous?.partID === partID && previous.open) return { ...previous, open: false, running: 0 }
    return undefined
  }
  const last = calls[calls.length - 1]!
  const newer = !previous || previous.partID !== partID || calls.length > previous.calls
  const touched = new Set(previous?.touched ?? [])
  if (newer && last.tabID) touched.delete(last.tabID)
  // The takeover stands until the agent starts another browser call after it.
  const takeover = previous?.takeover && !newer ? previous.takeover : undefined
  const settled = finished && last.status === "running"
  return {
    partID,
    calls: calls.length,
    last: settled ? { ...last, status: event.type === "session.tool.failed" ? "error" : "completed" } : last,
    running: finished ? 0 : calls.filter((call) => call.status === "running").length,
    open: !finished,
    at: newer || !previous ? now : previous.at,
    ...(takeover ? { takeover } : {}),
    touched,
  }
}

/** What the pane and the tab badge show for a session right now. */
export function activityPhase(
  activity: SessionActivity | undefined,
  input: { readonly now: number; readonly turnRunning: boolean },
): ActivityPhase {
  if (!activity) return "idle"
  if (activity.takeover) return "takeover"
  if (activity.running > 0 || activity.open) return "operating"
  if (input.turnRunning && input.now - activity.at < RECENT_MS) return "recent"
  return "idle"
}

export type ActionKey =
  | "open"
  | "focus"
  | "close"
  | "list"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "read"
  | "find"
  | "click"
  | "hover"
  | "drag"
  | "fill"
  | "select"
  | "check"
  | "press"
  | "scroll"
  | "wait"
  | "screenshot"
  | "dialog"
  | "evaluate"
  | "files"
  | "inspect"
  | "measure"
  | "preview"
  | "other"

const ACTIONS: Readonly<Record<string, ActionKey>> = {
  "tabs.open": "open",
  "tabs.focus": "focus",
  "tabs.close": "close",
  "tabs.list": "list",
  navigate: "navigate",
  back: "back",
  forward: "forward",
  reload: "reload",
  stop: "stop",
  snapshot: "read",
  frames: "read",
  find: "find",
  click: "click",
  hover: "hover",
  drag: "drag",
  fill: "fill",
  fill_form: "fill",
  select: "select",
  check: "check",
  press: "press",
  scroll: "scroll",
  wait: "wait",
  screenshot: "screenshot",
  dialog: "dialog",
  evaluate: "evaluate",
  console: "inspect",
  "network.list": "inspect",
  "network.get": "inspect",
  preview: "preview",
}

/** The action word and a short detail for the header ("클릭 · e12", "이동 · localhost:5173/settings"). */
export function describeCall(call: BrowserCall): { readonly action: ActionKey; readonly detail?: string } {
  const action =
    ACTIONS[call.operation] ??
    (call.operation.startsWith("files.")
      ? "files"
      : /^(trace|cpu|memory|lighthouse|performance)\b/.test(call.operation)
        ? "measure"
        : "other")
  const input = call.input ?? {}
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)
  const detail =
    action === "navigate" || action === "open"
      ? shortUrl(text(input.url))
      : action === "press"
        ? text(input.key)
        : action === "find" || action === "wait"
          ? quoted(text(input.text))
          : action === "drag"
            ? [text(input.from), text(input.to)].filter(Boolean).join(" → ") || undefined
            : action === "other"
              ? call.operation
              : text(input.ref)
  return detail ? { action, detail } : { action }
}

function shortUrl(url: string | undefined) {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`
    return `${parsed.host}${rest}`.slice(0, 80)
  } catch {
    return url.slice(0, 80)
  }
}

function quoted(value: string | undefined) {
  return value ? `"${value.slice(0, 40)}"` : undefined
}

export interface ActivityBus {
  on<Type extends ToolEvent["type"]>(
    type: Type,
    handler: (event: Extract<ToolEvent, { type: Type }>) => void,
  ): () => void
}

/**
 * One server's tracker, fed by its event bus. `turnRunning` is the data layer's session status; `now` and `timer`
 * are injectable for tests. A 1 s clock runs only while some session can be `recent`, so idle windows do no work.
 */
export function createBrowserActivity(input: {
  readonly bus: ActivityBus
  readonly turnRunning: (sessionID: string) => boolean
  readonly now?: () => number
  readonly timer?: (run: () => void, ms: number) => () => void
}): BrowserActivityTracker & { activity(sessionID: string): SessionActivity | undefined } {
  const now = input.now ?? Date.now
  const timer =
    input.timer ??
    ((run, ms) => {
      const id = setInterval(run, ms)
      return () => clearInterval(id)
    })
  const [sessions, setSessions] = createSignal<ReadonlyMap<string, SessionActivity>>(new Map())
  const [clock, setClock] = createSignal(now())
  let stopClock: (() => void) | undefined
  const tick = () => {
    const current = now()
    setClock(current)
    const pending = [...sessions()].some(([, activity]) => activity.open || current - activity.at < RECENT_MS)
    if (pending) return
    stopClock?.()
    stopClock = undefined
  }
  const write = (sessionID: string, next: SessionActivity | undefined) => {
    const map = new Map(sessions())
    if (next) map.set(sessionID, next)
    else map.delete(sessionID)
    setSessions(map)
  }
  const onTool = (event: ToolEvent) => {
    const sessionID = event.data.sessionID
    const next = reduceActivity(sessions().get(sessionID), event, now())
    if (!next) return
    write(sessionID, next)
    setClock(now())
    stopClock ??= timer(tick, 1_000)
  }
  const unsubscribe = [
    input.bus.on("session.tool.progress", onTool),
    input.bus.on("session.tool.success", onTool),
    input.bus.on("session.tool.failed", onTool),
  ]
  const edit = (sessionID: string, change: (activity: SessionActivity) => SessionActivity | undefined) => {
    const current = sessions().get(sessionID)
    if (current) write(sessionID, change(current))
  }
  const tracker = {
    activity: (sessionID: string) => sessions().get(sessionID),
    phase: (sessionID: string) =>
      activityPhase(sessions().get(sessionID), { now: clock(), turnRunning: input.turnRunning(sessionID) }),
    last(sessionID: string) {
      const activity = sessions().get(sessionID)
      return activity ? { ...describeCall(activity.last), tabID: activity.last.tabID } : undefined
    },
    agentTab: (sessionID: string) => sessions().get(sessionID)?.last.tabID,
    takeover(sessionID: string, tabID?: string) {
      edit(sessionID, (activity) => ({
        ...activity,
        running: 0,
        open: false,
        takeover: { at: now(), ...(tabID ? { tabID } : {}) },
        touched: tabID ? new Set([...activity.touched, tabID]) : activity.touched,
      }))
    },
    release(sessionID: string) {
      edit(sessionID, ({ takeover: _takeover, ...rest }) => rest)
    },
    userCommand(sessionID: string, tabID: string | undefined) {
      if (!tabID || tracker.phase(sessionID) === "idle") return
      edit(sessionID, (activity) =>
        activity.touched.has(tabID) ? activity : { ...activity, touched: new Set([...activity.touched, tabID]) },
      )
    },
    touched: (sessionID: string, tabID: string) => sessions().get(sessionID)?.touched.has(tabID) ?? false,
    dispose() {
      unsubscribe.forEach((stop) => stop())
      stopClock?.()
      stopClock = undefined
    },
  }
  return tracker
}
