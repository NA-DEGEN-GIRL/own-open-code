// Transcript harness: mounts the real `Transcript` (lazy view, session-ui rows, vendored virtualizer, footers,
// markers) on fixture sessions without a server. The data path is the production one: createData from
// @opencode/client/solid fed by a fake transport, the own-web EventBus (one batch per frame) and OwnStore (own.accounts
// on a fake RPC). `window.__transcript` lets Playwright open sessions, stream deltas and read timings.
import "@/styles/index.css"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createData } from "@opencode/client/solid"
import { ThemeProvider } from "@opencode/ui/theme/context"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { ChatViewMenu } from "@/chat-view"
import { CompactionsLayer } from "@/compactions"
import { DataProvider, type DataLayer, type ServerRuntime } from "@/data"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createI18n, I18nProvider } from "@/i18n"
import { ShortcutProvider } from "@/keyboard"
import { createMemoryRouter, RouterProvider } from "@/routing/router"
import { PendingSwitchChip, RunningOnPill, Switcher } from "@/switcher"
import { Toasts } from "@/switcher/toast"
import { ChildSessionNotice } from "@/subagent"
import { SessionTitle, Transcript } from "@/transcript"
import { SessionUiShell } from "@/adapter/session-ui"
import { MarkdownProvider } from "@opencode/session-ui/context/markdown"
import { Markdown } from "@opencode/session-ui/markdown"
import type { TranscriptRuntime } from "@/transcript/context"
import {
  ACCOUNT_A,
  ACCOUNT_B,
  BASE_TIME,
  buildClaudeSession,
  buildCompactionSession,
  buildImageFormatSession,
  buildImageSession,
  buildMarkerSession,
  buildSession,
  buildSignedSession,
  buildSwitchSessions,
  CLAUDE_ACCOUNTS,
  DIRECTORY,
  MODEL_A,
  MODEL_CLAUDE,
  MODEL_SONNET,
  type FixtureSession,
} from "./transcript-fixture"

const params = new URLSearchParams(location.search)
const initialLimit = Number(params.get("limit") ?? 5_000)
const sessions = new Map<
  string,
  FixtureSession & { parentID?: string; agent?: string; model?: { providerID: string; id: string } }
>()
for (const session of [
  buildSession({ id: "ses_perf", title: "긴 세션 2,000", turns: 400, switchEvery: 50, compactEvery: 70 }),
  buildSession({ id: "ses_small", title: "짧은 세션", turns: 12 }),
  buildSession({ id: "ses_paged", title: "페이지 세션", turns: 40 }),
  buildMarkerSession("ses_mark"),
  buildImageSession("ses_image"),
  buildImageFormatSession("ses_image_formats"),
  buildCompactionSession("ses_compact"),
  buildClaudeSession("ses_claude"),
  ...buildSwitchSessions(),
])
  sessions.set(session.id, session)
// SL-8: a subagent of the Claude conversation whose one step AC-02 signed; its tree is bound to AC-03.
sessions.set("ses_claude_child", {
  ...buildSignedSession("ses_claude_child", "계정 표시 조사 (@explore subagent)", [
    ["step", MODEL_CLAUDE, CLAUDE_ACCOUNTS[1].id],
  ]),
  parentID: "ses_claude",
  agent: "explore",
  model: MODEL_CLAUDE,
})
sessions.set("ses_child", {
  ...buildSession({ id: "ses_child", title: "라우터 조사 (@explore subagent)", turns: 2 }),
  parentID: "ses_small",
  agent: "explore",
})
// SL-17, pending switches: a ChatGPT conversation whose tree the switcher bound to AC-03 (`claudeAuth.session.set`)
// before its switch to Claude, and a Claude conversation on AC-03.
sessions.set("ses_pending_gpt", {
  ...buildSignedSession("ses_pending_gpt", "ChatGPT에서 Claude로", [["step", MODEL_A, ACCOUNT_A.id]]),
  model: MODEL_A,
})
sessions.set("ses_pending_cl3", {
  ...buildSignedSession("ses_pending_cl3", "AC-03 대화", [["step", MODEL_CLAUDE, CLAUDE_ACCOUNTS[2].id]]),
  model: MODEL_CLAUDE,
})

const accounts = [
  { ...ACCOUNT_A, kind: "codex", billing: "subscription", connection: { type: "oauth" } },
  { ...ACCOUNT_B, kind: "oai", billing: "metered", connection: { type: "key" } },
  // Several Claude accounts on the one `anthropic` provider (02 §8.7, SL 2026-10-26).
  ...CLAUDE_ACCOUNTS.map((account) => ({
    ...account,
    providerID: MODEL_CLAUDE.providerID,
    kind: "claude-sub",
    billing: "subscription",
    connection: { type: "plugin" },
  })),
].map((account) => ({
  ...account,
  shortLabel: account.label,
  status: "ready",
  autoSwitch: false,
  thirdParty: false,
  readOnly: false,
}))

/** Conversations whose Claude tree runs on AC-03 (`session.binding`); the app's header pill watches the open one. */
const CLAUDE_TREES = new Set(["ses_claude", "ses_switch", "ses_switch_model", "ses_claude_child", "ses_pending_cl3"])
/** Conversations on ChatGPT (개인 Pro) with a binding of their own (the header pill shows them). */
const CODEX_BOUND = new Set(["ses_pending_gpt"])
/** The router's switch records (`switch.state`), set live by `__transcript.switchState`. */
const switchStates = new Map<string, Record<string, unknown>>()

const answers: Record<string, (input: Record<string, unknown>) => unknown> = {
  health: () => ({ version: "fixture", buildId: "fixture", guard: "ok", controlDir: DIRECTORY }),
  "accounts.list": () => ({ revision: 1, accounts }),
  "quota.snapshot": () => ({ windows: [] }),
  // The Claude conversations' trees are bound to AC-03 now (`ses_claude`: its last step's auto switch; the switch
  // sessions, SL-8: the Claude account they run on, or go back to).
  "session.binding": (input) => ({
    bindings: (Array.isArray(input.sessionIDs) ? input.sessionIDs : [])
      .filter((sessionID) => CLAUDE_TREES.has(String(sessionID)) || CODEX_BOUND.has(String(sessionID)))
      .map((sessionID) => ({
        sessionID,
        model: CODEX_BOUND.has(String(sessionID)) ? MODEL_A : MODEL_CLAUDE,
        accountID: CODEX_BOUND.has(String(sessionID)) ? ACCOUNT_A.id : CLAUDE_ACCOUNTS[2].id,
        builtin: false,
        thirdParty: false,
        home: null,
        switch: switchStates.get(String(sessionID)) ?? { state: "STEADY" },
      })),
  }),
  "switch.state": (input) => switchStates.get(String(input.sessionID)) ?? { state: "STEADY" },
  "cache.state": (input) => ({
    sessionID: input.sessionID,
    now: Date.now(),
    slots: [],
    compaction: {
      providerID: MODEL_A.providerID,
      modelID: MODEL_A.id,
      windowTokens: 272_000,
      triggerTokens: 244_800,
      slotTriggerTokens: 244_800,
      source: "kind",
      sessionTriggerTokens: null,
      floorTokens: 20_000,
      keepTokens: 15_000,
      auto: true,
      P: 40_000,
      remainingTokens: 204_800,
      cycle: { Z: 12_000, delta: 3_000, summary: 8_000 },
      pendingDue: null,
    },
  }),
  "ledger.session": (input) => {
    const lines = sessions.get(String(input.sessionID))?.lines ?? []
    const end = typeof input.cursor === "string" ? Number(input.cursor) : lines.length
    const start = Math.max(0, end - Number(input.limit ?? 200))
    return {
      steps: lines.slice(start, end),
      totals: { byAccount: {} },
      switchCount: 0,
      ...(start > 0 ? { cursor: String(start) } : {}),
    }
  },
}

function info(id: string) {
  const session = sessions.get(id)!
  return {
    id,
    projectID: "prj_fixture",
    title: session.title,
    parentID: session.parentID,
    agent: session.agent,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: BASE_TIME, updated: BASE_TIME },
    location: { directory: DIRECTORY },
    model: session.model ?? MODEL_A,
  }
}

const location_ = { directory: DIRECTORY }
/** Messages read one by one (`session.message.get`). */
const reads: string[] = []
/** Message pages read (the transcript's own pages after its first read). */
const pageReads = { count: 0 }
const client = {
  session: {
    get: async ({ sessionID }: { sessionID: string }) => info(sessionID),
    active: async () => ({}),
    inbox: { list: async () => [] },
    // The message a live `session.model.selected` appended (`selectModel`), read again as core would answer; an image
    // card reads its whole message here (the store keeps no tool file bytes, as in the app).
    message: {
      get: async (input: { sessionID: string; messageID: string }) => {
        reads.push(input.messageID)
        return sessions.get(input.sessionID)?.messages.find((message) => message.id === input.messageID)
      },
    },
  },
  message: {
    // Newest first, `cursor` = exclusive end index of the next older page (the server's paging contract). `type`
    // filters before paging; `order: "asc"` pages from the oldest (`cursor` = the next start index).
    list: async (input: {
      sessionID: string
      limit: number
      cursor?: string
      order?: "asc" | "desc"
      type?: string
    }) => {
      const messages = (sessions.get(input.sessionID)?.messages ?? []).filter(
        (message) => input.type === undefined || message.type === input.type,
      )
      if (input.order === "asc") {
        const start = input.cursor === undefined ? 0 : Number(input.cursor)
        const end = start + input.limit
        return { data: messages.slice(start, end), cursor: { next: end < messages.length ? String(end) : null } }
      }
      // A transcript view's own pages (transcript/history.ts) read newer ones too: `previous` is `>index`.
      const after = input.cursor?.startsWith(">") ? Number(input.cursor.slice(1)) : undefined
      const end =
        after !== undefined ? Math.min(messages.length, after + input.limit) : Number(input.cursor ?? messages.length)
      const start = after ?? Math.max(0, end - input.limit)
      pageReads.count++
      return {
        data: messages.slice(start, end).toReversed(),
        cursor: { next: start > 0 ? String(start) : null, previous: `>${end}` },
      }
    },
  },
  provider: {
    list: async () => ({
      location: location_,
      data: [
        { id: ACCOUNT_A.providerID, name: "ChatGPT (개인 Pro)", activation: "enabled", package: "openai" },
        { id: ACCOUNT_B.providerID, name: "OpenAI (회사)", activation: "enabled", package: "openai" },
        { id: MODEL_CLAUDE.providerID, name: "Anthropic", activation: "enabled", package: "anthropic" },
      ],
    }),
  },
  model: {
    list: async () => ({
      location: location_,
      data: [
        // No effort levels: a child session's role line reads `variants` (`ChildSessionNotice`, SL-8).
        { id: "gpt-5.6-sol", providerID: ACCOUNT_A.providerID, name: "GPT-5.6 Sol", variants: [] },
        { id: "gpt-5.5", providerID: ACCOUNT_B.providerID, name: "GPT-5.5", variants: [] },
        { id: MODEL_CLAUDE.id, providerID: MODEL_CLAUDE.providerID, name: "Claude Haiku 5.5", variants: [] },
        { id: MODEL_SONNET.id, providerID: MODEL_SONNET.providerID, name: "Claude Sonnet 5.5", variants: [] },
      ],
    }),
  },
  location: { get: async () => location_ },
  vcs: { get: async () => ({ location: location_, data: undefined }) },
  project: { list: async () => [] },
  shell: { output: async () => ({ output: "", truncated: false }) },
  rpc: {
    call: async (input: { method: string; input?: Record<string, unknown> }) => ({
      output: answers[input.method]?.(input.input ?? {}) ?? {},
    }),
  },
}
// SAFETY: the transcript and the stores reach only the members defined above.
const api = client as unknown as OpenCodeClient

const bus = createEventBus()
const connection = { status: () => "connected" as const, attempt: () => 0, error: () => undefined }
const data = createData({
  api: () => api,
  directory: DIRECTORY,
  initialMessageLimit: () => initialLimit,
  // As the app (data/server.ts): pages and live events keep no tool file bytes.
  omitToolFileData: true,
  event: { on: bus.on, listen: (handler) => bus.listen((event) => handler({ name: event.type, details: event })) },
  connection,
})
const rpc = createOwnRpc({
  client: () => api,
  routing: { control: async () => DIRECTORY, sessionDirectory: () => DIRECTORY },
  scopes: () => ALL_SCOPES,
})
const own = createOwnStore({ rpc, bus, client: () => api, sessionDirectory: () => DIRECTORY })
// The bindings the app's header pill would read (`watchVisible`): the Claude trees' account.
own.watchVisible([...CLAUDE_TREES])
const runtime: TranscriptRuntime = {
  key: "local",
  data,
  own,
  rpc,
  connection,
  client: () => api,
  sessions: {
    directory: () => DIRECTORY,
    state: { source: "empty", sessions: {}, order: [], projects: {}, next: null, loading: false },
  },
}
// SAFETY: `Transcript`, the breadcrumb, the pill and the switcher only call `get(serverKey)`; the breadcrumb asks the
// team registry for a title's role (English team titles, team/title.ts), and no fixture session is a team's.
const layer = { get: () => Object.assign(runtime, { team: { placeOf: () => undefined } }) } as unknown as DataLayer
const router = createMemoryRouter(`own.web.harness.${Math.random()}`)
const i18n = createI18n("ko")
/** The open session of the route. */
const openID = () => {
  const route = router.route()
  return route.name === "session" ? route.sessionID : undefined
}

let eventSeq = 0
function publish(type: string, payload: Record<string, unknown>) {
  // SAFETY: fixture events in the wire shape createData and OwnStore consume.
  bus.publish({ id: `evt_h${eventSeq++}`, created: Date.now(), type, data: payload } as unknown as OpenCodeEvent)
}

const [typed, setTyped] = createSignal(0)
const inputLatencies: number[] = []

render(
  () => (
    <ThemeProvider>
      <I18nProvider value={i18n}>
        <DataProvider value={layer}>
          <RouterProvider value={router}>
            {/* The shortcut registry the app provides (the transcript's find registers Ctrl+F, 19.13). */}
            <ShortcutProvider>
              <main
                class="own-app"
                data-tier="wide"
                style={{ height: "100vh", display: "flex", "flex-direction": "column" }}
              >
                {/* The shell header's title slot: the plain title, or the breadcrumb of a child session (18.11), and the
                    header's `보기` menu (4.5 대화 보기). */}
                <div class="flex items-center gap-2 pr-4">
                  <h1 class="own-header-title m-0 px-4 py-2 text-[14px]" data-testid="header-title">
                    <SessionTitle
                      serverKey={() => "local"}
                      sessionID={() => {
                        const route = router.route()
                        return route.name === "session" ? route.sessionID : undefined
                      }}
                    />
                  </h1>
                  <ChatViewMenu />
                  {/* The shell header's running-on pill and the switcher's landing toasts (SL-17). */}
                  <RunningOnPill serverKey={() => "local"} sessionID={openID} />
                  <Switcher serverKey={() => "local"} sessionID={openID} />
                  {/* 압축 내용 보기 (UC 2026-10-18): the dialog layer and the toasts its copy button shows. */}
                  <CompactionsLayer />
                  <Toasts />
                </div>
                <section class="own-session" data-testid="session-view">
                  <Transcript
                    serverKey={() => "local"}
                    sessionID={() => {
                      const route = router.route()
                      return route.name === "session" ? route.sessionID : undefined
                    }}
                  />
                  {/* The composer's pending-switch line (03 §4.6, SL-17); SAFETY: it reads only the harness runtime's
                      stores (own, data) of a ServerRuntime. */}
                  <Show when={openID()}>
                    {(id) => (
                      <PendingSwitchChip
                        runtime={runtime as unknown as ServerRuntime}
                        sessionID={id()}
                        held={0}
                        children={0}
                      />
                    )}
                  </Show>
                  {/* The composer's place in a child session (18.11): its notice and role line. */}
                  <ChildSessionNotice
                    serverKey={() => "local"}
                    sessionID={() => {
                      const route = router.route()
                      return route.name === "session" ? route.sessionID : undefined
                    }}
                  />
                  <textarea
                    data-testid="harness-input"
                    rows={2}
                    style={{ "flex-shrink": "0", margin: "8px 24px 16px", "min-height": "48px", "font-size": "14px" }}
                    onKeyDown={(event) => {
                      setTyped(typed() + 1)
                      inputLatencies.push(performance.now() - event.timeStamp)
                    }}
                  />
                </section>
              </main>
            </ShortcutProvider>
          </RouterProvider>
        </DataProvider>
      </I18nProvider>
    </ThemeProvider>
  ),
  document.getElementById("root")!,
)
publish("server.connected", {})

Object.assign(window, {
  __transcript: {
    open(sessionID: string) {
      router.navigate({ name: "session", serverKey: "local", sessionID })
    },
    home() {
      router.navigate({ name: "home" })
    },
    route: () => router.route(),
    inputLatencies: () => inputLatencies.splice(0),
    counts: () => Object.fromEntries([...sessions].map(([id, session]) => [id, session.messages.length])),
    messages: (sessionID: string) => sessions.get(sessionID)?.messages ?? [],
    reads: () => [...reads],
    pages: () => pageReads.count,
    /** Messages the store holds for the session (its newest; older pages are the view's own). */
    loaded: (id: string) => data.session.message.list(id).length,
    /** Commits a revert at the user message starting with `text` (core deletes it and all after it, then says so). */
    commitRevert(sessionID: string, text: string) {
      const session = sessions.get(sessionID)!
      const at = session.messages.findIndex((message) => message.type === "user" && message.text.startsWith(text))
      const to = session.messages[at]!.id
      session.messages.splice(at)
      publish("session.revert.committed", { sessionID, to })
    },
    /**
     * Streams one new step into `sessionID`: `deltas` text deltas at `perSecond`, then ends the step and turn. With
     * `text`, the deltas are that text in pieces of `chunk` characters (default 9).
     */
    async stream(input: { sessionID: string; deltas?: number; perSecond: number; text?: string; chunk?: number }) {
      const assistantMessageID = `msg_zz_stream_${eventSeq}`
      publish("session.execution.started", { sessionID: input.sessionID })
      publish("session.step.started", {
        sessionID: input.sessionID,
        assistantMessageID,
        agent: "build",
        model: MODEL_A,
        started: Date.now(),
      })
      publish("session.text.started", { sessionID: input.sessionID, assistantMessageID, ordinal: 0 })
      const interval = 1_000 / input.perSecond
      const started = performance.now()
      const size = input.chunk ?? 9
      const text = input.text
      const pieces = text
        ? Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size))
        : Array.from({ length: input.deltas ?? 0 }, (_, index) => (index % 40 === 39 ? "\n\n" : `스트리밍 ${index} `))
      for (let index = 0; index < pieces.length; index++) {
        publish("session.text.delta", {
          sessionID: input.sessionID,
          assistantMessageID,
          ordinal: 0,
          delta: pieces[index],
        })
        const due = started + (index + 1) * interval
        const wait = due - performance.now()
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      }
      publish("session.step.streamed", { sessionID: input.sessionID, assistantMessageID })
      publish("session.step.ended", {
        sessionID: input.sessionID,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 900, output: 400, reasoning: 0, cache: { read: 60_000, write: 0 } },
      })
      publish("session.execution.succeeded", { sessionID: input.sessionID })
      return { durationMs: performance.now() - started }
    },
    /**
     * `text` rendered the way an answer that never streamed renders (session-ui `Markdown`, own-web's substitute, with
     * the transcript's markdown hooks); resolves once it is ready.
     */
    async once(text: string) {
      const host = document.createElement("div")
      host.dataset.testid = "harness-once"
      host.style.cssText = "position:absolute;left:-10000px;top:0;width:800px"
      document.body.append(host)
      render(
        () => (
          <SessionUiShell locale={() => "ko"}>
            <MarkdownProvider openLocalFile={() => undefined} openSession={() => undefined}>
              <Markdown text={text} />
            </MarkdownProvider>
          </SessionUiShell>
        ),
        host,
      )
      const deadline = performance.now() + 15_000
      while (!host.querySelector("[data-markdown-ready]") && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50))
    },
    /** A live model switch, as core's `session.model.selected` delivers it (with the message it appends). */
    selectModel(input: {
      sessionID: string
      model: { providerID: string; id: string; variant?: string }
      previous: { providerID: string; id: string; variant?: string }
    }) {
      const id = `evt_zz_switch_${eventSeq++}`
      const created = Date.now()
      sessions.get(input.sessionID)?.messages.push({
        id: id.replace(/^evt_/, "msg_"),
        type: "model-switched",
        model: input.model,
        previous: input.previous,
        time: { created },
      } as SessionMessageInfo)
      // SAFETY: a fixture event in the wire shape the data layer consumes.
      bus.publish({
        id,
        created,
        type: "session.model.selected",
        data: { sessionID: input.sessionID, model: input.model, previous: input.previous },
      } as unknown as OpenCodeEvent)
    },
    /** A live switch state of the router, as `switch.state` delivers it (and `switch.state` answers it since). */
    switchState(input: { sessionID: string; detail: Record<string, unknown> }) {
      switchStates.set(input.sessionID, input.detail)
      bus.publish({
        id: `evt_h${eventSeq++}`,
        created: Date.now(),
        type: "rpc.own.accounts.switch.state",
        location: location_,
        data: {
          eventId: `st_${eventSeq}`,
          sessionID: input.sessionID,
          state: input.detail.state,
          detail: input.detail,
        },
      } as unknown as OpenCodeEvent)
    },
    /** A live router switch record, as `switch.recorded` would deliver it. */
    recordSwitch(input: { sessionID: string; from: unknown; to: unknown; strategy: string; created: number }) {
      bus.publish({
        id: `evt_h${eventSeq++}`,
        created: input.created,
        type: "rpc.own.accounts.switch.recorded",
        location: location_,
        data: {
          eventId: `rec_${eventSeq}`,
          sessionID: input.sessionID,
          from: input.from,
          to: input.to,
          strategy: input.strategy,
          reason: "manual",
          estimate: { lo: 1.2, hi: 1.2, unit: "credits" },
        },
      } as unknown as OpenCodeEvent)
    },
  },
})
