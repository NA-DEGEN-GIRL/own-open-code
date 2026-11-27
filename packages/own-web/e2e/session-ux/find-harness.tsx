// Find harness (03 §19.13): the real `Transcript` (lazy view, session-ui rows, vendored virtualizer) on fixture
// sessions without a server — the same fake transport as e2e/transcript-harness.tsx. The transcript mounts its own
// `<SessionFind>` (P7 wiring) with the virtualizer's reveal. A 2,000-message session carries rare words near its
// start and end so a match is far away.
// `window.__find` opens sessions, streams deltas and reads what the tests check.
import "@/styles/index.css"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { createData } from "@opencode/client/solid"
import { ThemeProvider, useTheme } from "@opencode/ui/theme/context"
import { render } from "solid-js/web"
import { DataProvider, type DataLayer } from "@/data"
import { createEventBus } from "@/data/events"
import { createOwnStore } from "@/data/own-store"
import { ALL_SCOPES, createOwnRpc } from "@/data/rpc"
import { createI18n, I18nProvider } from "@/i18n"
import { createShortcutRegistry, ShortcutProvider } from "@/keyboard"
import { createMemoryRouter, RouterProvider } from "@/routing/router"
import { seedColorScheme } from "@/shell/theme-default"
import { Transcript } from "@/transcript"
import type { TranscriptRuntime } from "@/transcript/context"
import { ACCOUNT_A, BASE_TIME, buildSession, DIRECTORY, MODEL_A, type FixtureSession } from "../transcript-fixture"

const params = new URLSearchParams(location.search)
const initialLimit = Number(params.get("limit") ?? 5_000)

/** Rare words: `파인애플` in turn 3's question and turn 390's answer, `망고스틴` once in turn 200. */
function findSession(): FixtureSession {
  const session = buildSession({ id: "ses_find", title: "찾기 세션", turns: 400, switchEvery: 90, compactEvery: 130 })
  const users = session.messages.filter((message) => message.type === "user")
  const answer = (turn: number) =>
    session.messages.find(
      (message) =>
        message.type === "assistant" &&
        message.content.some((content) => content.type === "text" && content.text.endsWith(`(${turn})`)),
    )
  mutateUser(users[2]!, "3번째 요청: 파인애플 결제 흐름을 정리해 주세요.")
  mutateText(answer(390), "파인애플 결제는 두 번 확인합니다.")
  mutateText(answer(200), "망고스틴 설정을 바꿨습니다.")
  return session
}

function mutateUser(message: SessionMessageInfo, text: string) {
  if (message.type === "user") Object.assign(message, { text })
}

function mutateText(message: SessionMessageInfo | undefined, prefix: string) {
  if (message?.type !== "assistant") return
  const content = message.content.find((item) => item.type === "text")
  if (content?.type === "text") Object.assign(content, { text: `${prefix}\n\n${content.text}` })
}

const sessions = new Map<string, FixtureSession>()
for (const session of [findSession(), buildSession({ id: "ses_short", title: "짧은 세션", turns: 6 })])
  sessions.set(session.id, session)

function info(id: string) {
  const session = sessions.get(id)!
  return {
    id,
    projectID: "prj_fixture",
    title: session.title,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: BASE_TIME, updated: BASE_TIME },
    location: { directory: DIRECTORY },
    model: MODEL_A,
  }
}

const location_ = { directory: DIRECTORY }
const client = {
  session: {
    get: async ({ sessionID }: { sessionID: string }) => info(sessionID),
    active: async () => ({}),
    inbox: { list: async () => [] },
  },
  message: {
    // Newest first. `next` (an index) reads the messages before the page, `previous` (`>index`) the ones after it.
    list: async (input: { sessionID: string; limit: number; cursor?: string }) => {
      const messages = sessions.get(input.sessionID)?.messages ?? []
      const after = input.cursor?.startsWith(">") ? Number(input.cursor.slice(1)) : undefined
      const end =
        after !== undefined ? Math.min(messages.length, after + input.limit) : Number(input.cursor ?? messages.length)
      const start = after ?? Math.max(0, end - input.limit)
      return {
        data: messages.slice(start, end).toReversed(),
        cursor: { next: start > 0 ? String(start) : null, previous: `>${end}` },
      }
    },
  },
  provider: {
    list: async () => ({
      location: location_,
      data: [{ id: ACCOUNT_A.providerID, name: "ChatGPT (개인 Pro)", activation: "enabled", package: "openai" }],
    }),
  },
  model: {
    list: async () => ({
      location: location_,
      data: [{ id: "gpt-5.6-sol", providerID: ACCOUNT_A.providerID, name: "GPT-5.6 Sol" }],
    }),
  },
  location: { get: async () => location_ },
  vcs: { get: async () => ({ location: location_, data: undefined }) },
  project: { list: async () => [] },
  shell: { output: async () => ({ output: "", truncated: false }) },
  rpc: { call: async () => ({ output: {} }) },
}
// SAFETY: the transcript and the stores reach only the members defined above.
const api = client as unknown as OpenCodeClient

const bus = createEventBus()
const connection = { status: () => "connected" as const, attempt: () => 0, error: () => undefined }
const data = createData({
  api: () => api,
  directory: DIRECTORY,
  initialMessageLimit: () => initialLimit,
  event: { on: bus.on, listen: (handler) => bus.listen((event) => handler({ name: event.type, details: event })) },
  connection,
})
const rpc = createOwnRpc({
  client: () => api,
  routing: { control: async () => DIRECTORY, sessionDirectory: () => DIRECTORY },
  scopes: () => ALL_SCOPES,
})
const own = createOwnStore({ rpc, bus, client: () => api, sessionDirectory: () => DIRECTORY })
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
// SAFETY: `Transcript` only calls `get(serverKey)`.
const layer = { get: () => runtime } as unknown as DataLayer
const router = createMemoryRouter(`own.web.find-harness.${Math.random()}`)
const sessionID = () => {
  const route = router.route()
  return route.name === "session" ? route.sessionID : undefined
}

let eventSeq = 0
function publish(type: string, payload: Record<string, unknown>) {
  // SAFETY: fixture events in the wire shape createData consumes.
  bus.publish({ id: `evt_f${eventSeq++}`, created: Date.now(), type, data: payload } as unknown as OpenCodeEvent)
}

function Scheme() {
  const theme = useTheme()
  Object.assign(window, { __scheme: (scheme: "dark" | "light") => theme.setColorScheme(scheme) })
  return null
}

// Dark by default, as the app seeds it before the theme provider starts (src/app.tsx).
seedColorScheme()
render(
  () => (
    <ThemeProvider>
      <Scheme />
      <I18nProvider value={createI18n("ko")}>
        <DataProvider value={layer}>
          <RouterProvider value={router}>
            <ShortcutProvider value={createShortcutRegistry()}>
              <main
                class="own-app"
                data-tier="wide"
                style={{ height: "100vh", display: "flex", "flex-direction": "column" }}
              >
                <section class="own-session relative" data-testid="session-view">
                  <Transcript serverKey={() => "local"} sessionID={sessionID} />
                  <textarea
                    data-testid="harness-input"
                    rows={2}
                    style={{ "flex-shrink": "0", margin: "8px 24px 16px", "min-height": "48px", "font-size": "14px" }}
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
  __find: {
    open: (id: string) => router.navigate({ name: "session", serverKey: "local", sessionID: id }),
    home: () => router.navigate({ name: "home" }),
    loaded: (id: string) => data.session.message.list(id).length,
    /** Streams a short answer containing `text` into `id` (the live-update path of the index). */
    async stream(input: { sessionID: string; text: string }) {
      const assistantMessageID = `msg_zz_find_${eventSeq}`
      publish("session.execution.started", { sessionID: input.sessionID })
      publish("session.step.started", {
        sessionID: input.sessionID,
        assistantMessageID,
        agent: "build",
        model: MODEL_A,
        started: Date.now(),
      })
      publish("session.text.started", { sessionID: input.sessionID, assistantMessageID, ordinal: 0 })
      for (const word of input.text.split(" ")) {
        publish("session.text.delta", { sessionID: input.sessionID, assistantMessageID, ordinal: 0, delta: `${word} ` })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      publish("session.step.ended", {
        sessionID: input.sessionID,
        assistantMessageID,
        finish: "stop",
        cost: 0,
        tokens: { input: 900, output: 40, reasoning: 0, cache: { read: 60_000, write: 0 } },
      })
      publish("session.execution.succeeded", { sessionID: input.sessionID })
    },
  },
})
