// Live test of 내 브라우저 사용 (decisions BRW) against the user's real browser: a source server with own.accounts and
// own.harness (own-team's e2e harness without own.team), ChatGPT 01 through the forwarder on the Codex harness, and
// the user's installed Browse (`%USERPROFILE%\.local\bin\browse.exe`, its paired extension and running relay).
//
//   bun script/live/browse.ts [--out <dir>]     (TEMP under C:\t\<prefix>; a path without '#')
//
// The browser is the user's real profile. Every browse call keeps to tabs this run opens on the page it serves on
// 127.0.0.1 (browse-guard/server.ts: allowedOrigins, one group, no tab listing or relay status), and the run closes
// that group at the end. The server's environment is cut to the allow-list (team-kit `localEnv`); request bodies go
// to `<out>/bodies` and are checked for this PC's user, home paths, the user's email and tabs the user lent.
//
// Cases: B1 the setting finds the program; B2 the tools stay hidden until the conversation's switch; B3 전체 허용
// opens, reads and acts; B4 묻기 reads without asking and asks before actions (one approved, one rejected); B5 읽기
// 전용 reads and refuses actions; B6 the read-only `explore` role cannot act; B7 the setting off removes the tools.
import fs from "node:fs"
import path from "node:path"
import { OwnBrowse } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { Browse } from "../../../own-accounts/src/browse/browse.js"
import { REPO_ROOT } from "../../../own-accounts/test/e2e-kit"
import { startTeamFakes, startTeamServer } from "../../../own-team/test/e2e/harness.ts"
import { MODELS, cloudForwarder, gitFixture, localEnv } from "./team-kit.js"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const OUT = path.resolve(option("out") ?? path.join(process.env.TEMP ?? "/tmp", `own-live-browse-${Date.now()}`))
const GROUP = "own-live-test"
const PHASE_TIMEOUT = 12 * 60_000
const MODEL = MODELS.gpt

type Decision = "once" | "reject"
type Part = Record<string, unknown>

const log: Array<Record<string, unknown>> = []
const note = (entry: Record<string, unknown>) => {
  const line = { at: new Date().toISOString(), ...entry }
  log.push(line)
  console.log(JSON.stringify(line))
}

async function main() {
  fs.mkdirSync(path.join(OUT, "bodies"), { recursive: true })
  const tabsBefore = tabCount()
  process.env.OWN_LIVE_BODIES = path.join(OUT, "bodies")
  const page = testPage()
  note({ step: "page", origin: page.origin })
  const forwarder = await cloudForwarder(OUT)
  const fakes = startTeamFakes()
  const team = await startTeamServer({
    name: "browse",
    team: false,
    project: (base) => gitFixture(base, "browse-test", { "README.md": "# browse test\n" }),
    fakes,
    codexTransport: "http",
    accountsOptions: {
      endpoints: {
        codex: `${forwarder.url}/chatgpt-team`,
        anthropic: `${forwarder.url}/anthropic/v1`,
        deepseek: `${forwarder.url}/deepseek/v1`,
        oauthIssuer: fakes.codex.url,
        chatgpt: `${fakes.codex.url}/backend-api`,
        openai: `${fakes.codex.url}/v1`,
        xai: `${fakes.codex.url}/v1`,
        openrouter: `${fakes.codex.url}/v1`,
        deepgram: fakes.codex.url,
      },
    },
    // A relay `browse mcp` would start with the wrong folders must never update itself (browse-guard sets them).
    env: { ...localEnv(OUT), OPENCODE_BROWSER_AUTO_UPDATE: "off" },
    plugins: [
      { package: path.join(REPO_ROOT, "packages/own-harness"), options: {} },
      {
        package: path.join(import.meta.dirname, "browse-guard"),
        options: { origin: page.origin, group: GROUP, marker: path.join(OUT, "guard"), home: process.env.USERPROFILE },
      },
    ],
  })
  const project = team.project!
  note({ step: "server", root: team.root })
  const policy: { decide: (action: string, input: unknown) => Decision } = { decide: () => "reject" }
  const asks: Array<{ sessionID: string; action: string; decision: Decision }> = []
  const stopWatch = watchAsks(team, project, policy, asks)
  const results: Record<string, unknown> = {}

  const status = async () => (await team.accounts("browse.status", {})) as unknown as OwnBrowse.Status
  const set = async (input: OwnBrowse.Setting) =>
    (await team.accounts("browse.set", input)) as unknown as OwnBrowse.Status
  const approval = (sessionID: string, input: Record<string, unknown>) =>
    team.accounts("session.approval.set", { sessionID, ...input }, project)
  const conversation = async (title: string, mode: "full" | "ask" | "read-only", harness: "codex" | "opencode") => {
    const sessionID = await team.createSession({ model: MODEL, title, directory: project })
    const bound = await team.rpc(OwnHarness.ID, "session.set", { sessionID, harness }, project)
    await approval(sessionID, { mode })
    note({ step: "conversation", title, sessionID, mode, harness, bound: bound.status })
    return sessionID
  }
  const turn = async (sessionID: string, name: string, text: string) => {
    const begun = Date.now()
    const start = (await history(team, sessionID, project)).length
    await team.server.prompt(sessionID, text)
    await idle(team, sessionID, begun + PHASE_TIMEOUT)
    const messages = await history(team, sessionID, project)
    const last = messages.findLast((message) => message.type === "assistant")
    const answer = ((last?.content as Part[] | undefined) ?? [])
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join("\n")
    const calls = toolCalls(messages.slice(start))
    // Codex's Code Mode runs browse calls inside `exec`: their results are in its output, so checks read the whole text.
    const trace = JSON.stringify(toolParts(messages.slice(start)))
    const bodies = bodiesSince(begun)
    note({ step: name, seconds: Math.round((Date.now() - begun) / 1000), answer: answer.slice(0, 800), calls })
    return { answer, calls, trace, bodies, messages }
  }
  const mcpState = async () => {
    const listed = (await team.server.call("GET", "/api/mcp", { directory: project })) as {
      data: Array<{ name: string; status?: unknown }>
    }
    return listed.data.find((server) => server.name === OwnBrowse.SERVER)
  }

  try {
    // B1: off by default; on with no path in this run's own profile finds nothing; the path given finds it; and the
    // install place this PC really has is what the default lookup finds.
    const before = await status()
    const onlyOn = await set({ enabled: true })
    const given = await set({ command: path.join(process.env.USERPROFILE ?? "", ".local", "bin", "browse.exe") })
    const real = await Browse.locate({})
    const connected = await until(async () => {
      const state = await mcpState()
      return JSON.stringify(state?.status ?? "").includes("connected") ? state : undefined
    }, 120_000)
    // The guard's folders reached the project's `browse` server only when its last pass came after own.accounts' fold.
    const guarded = await until(async () => (guardReached(project) ? true : undefined), 60_000)
    if (guarded !== true) throw new Error("browse-guard did not reach the browse server")
    results.B1 = {
      ok:
        !before.enabled &&
        !before.active &&
        onlyOn.enabled &&
        onlyOn.source === "missing" &&
        given.active &&
        given.source === "setting" &&
        real.source === "install",
      before: pick(before),
      onlyOn: pick(onlyOn),
      given: pick(given),
      defaultLookup: real.source,
      mcp: connected?.status,
    }
    note({ step: "B1", ...(results.B1 as object) })

    // B2: a conversation without its switch lists no browse tool; its switch lists them.
    const full = await conversation("browse full", "full", "codex")
    const hidden = await turn(
      full,
      "B2-hidden",
      "Without calling any tool: list the names of the tools you have whose names start with `browse`, or say `none`.",
    )
    const switched = await approval(full, { mode: "full", browse: "on" })
    const got = await team.accounts("session.approval.get", { sessionID: full }, project)
    results.B2 = {
      ok: hidden.bodies.every((body) => browseTools(body).length === 0) && got.browse === "on",
      hiddenTools: hidden.bodies.map(browseTools),
      answer: hidden.answer.slice(0, 200),
      set: switched.browse,
      get: got.browse,
    }
    note({ step: "B2", ...(results.B2 as object) })

    // B3: 전체 허용 opens, reads and acts without asking.
    policy.decide = () => "reject"
    const asked3 = asks.length
    page.secret = secretWord()
    const acted = await turn(
      full,
      "B3-full",
      [
        `Use the browse tools on a test page this test serves: open ${page.origin}/ in a new tab with navigate,`,
        `passing allowedOrigins ["${page.origin}"] and group "${GROUP}". Then take a snapshot and tell me the secret`,
        `word on the page. Then fill the Name field with "Ada", click Submit, take another snapshot and tell me the`,
        "result line. Use only the tab you opened; do not list tabs and do not use the shell or files. Keep the tab open",
        "and tell me its tab id.",
      ].join(" "),
    )
    const tab = /\\*"tab\\*"\s*:\s*(\d+)/.exec(acted.trace)?.[1]
    results.B3 = {
      ok:
        acted.answer.includes(page.secret) &&
        page.events.some((event) => event.type === "submit" && event.name === "Ada") &&
        asks.length === asked3 &&
        browseTools(acted.bodies[0] ?? {}).length > 0,
      secret: acted.answer.includes(page.secret),
      submitted: page.events.filter((event) => event.type === "submit").map((event) => event.name),
      asked: asks.length - asked3,
      tools: names(acted.calls),
      catalog: browseTools(acted.bodies[0] ?? {}).length,
      tab,
    }
    note({ step: "B3", ...(results.B3 as object) })

    // B4: 묻기 reads without asking and asks before each action: the opening and the first action are approved, the
    // next action is rejected.
    const ask = await conversation("browse ask", "ask", "codex")
    await approval(ask, { mode: "ask", browse: "on" })
    const seen = { acts: 0 }
    policy.decide = (action) => {
      if (action === "browse_navigate" || action === "browse_tabs") return "once"
      seen.acts += 1
      return seen.acts === 1 ? "once" : "reject"
    }
    const asked4 = asks.length
    page.secret = secretWord()
    const pings4 = page.events.filter((event) => event.type === "ping").length
    const asking = await turn(
      ask,
      "B4-ask",
      [
        `Use the browse tools on a test page this test serves: open ${page.origin}/ in a new tab with navigate,`,
        `passing allowedOrigins ["${page.origin}"] and group "${GROUP}". Take a snapshot and tell me the secret word.`,
        `Then click the Ping button once. After that, fill the Name field with "Bob" and click Submit. Some actions may`,
        "be refused: if one is, stop and tell me which. Use only the tab you opened; do not list tabs and do not use",
        "the shell or files.",
      ].join(" "),
    )
    const askedNow = asks.slice(asked4)
    results.B4 = {
      ok:
        asking.answer.includes(page.secret) &&
        !askedNow.some((item) => item.action === "browse_snapshot") &&
        askedNow.some((item) => item.decision === "once" && item.action !== "browse_navigate") &&
        askedNow.some((item) => item.decision === "reject") &&
        page.events.filter((event) => event.type === "ping").length === pings4 + 1 &&
        !page.events.some((event) => event.type === "submit" && event.name === "Bob"),
      secret: asking.answer.includes(page.secret),
      asks: askedNow.map((item) => `${item.action}:${item.decision}`),
      pings: page.events.filter((event) => event.type === "ping").length - pings4,
      bob: page.events.some((event) => event.type === "submit" && event.name === "Bob"),
      tools: names(asking.calls),
      answer: asking.answer.slice(0, 300),
    }
    note({ step: "B4", ...(results.B4 as object) })

    // B5: 읽기 전용 in the same conversation: the tab it opened can be read, every action is refused, nothing asks.
    await approval(ask, { mode: "read-only" })
    const kept = await team.accounts("session.approval.get", { sessionID: ask }, project)
    policy.decide = () => "reject"
    const asked5 = asks.length
    const pings5 = page.events.filter((event) => event.type === "ping").length
    const reading = await turn(
      ask,
      "B5-read-only",
      [
        "In the same tab you opened, take a snapshot and tell me the secret word again, then click the Ping button.",
        "If the click is refused, tell me the refusal's words. Do not list tabs and do not use the shell or files.",
      ].join(" "),
    )
    results.B5 = {
      ok:
        kept.mode === "read-only" &&
        kept.browse === "on" &&
        reading.answer.includes(page.secret) &&
        reading.trace.includes(Browse.MESSAGE.readOnly.slice(0, 60)) &&
        asks.length === asked5 &&
        page.events.filter((event) => event.type === "ping").length === pings5,
      mode: kept.mode,
      browse: kept.browse,
      secret: reading.answer.includes(page.secret),
      refusal: reading.trace.includes(Browse.MESSAGE.readOnly.slice(0, 60)),
      tools: names(reading.calls),
      pings: page.events.filter((event) => event.type === "ping").length - pings5,
      asked: asks.length - asked5,
    }
    note({ step: "B5", ...(results.B5 as object) })

    // B6: in 전체 허용, the read-only `explore` role reads the tab but cannot act in it.
    // Codex's own agent tools take no role (`agent_type` is not applied), so the role runs under core's `subagent` in
    // an OpenCode 기본 conversation.
    const roles = await conversation("browse explore", "full", "opencode")
    await approval(roles, { mode: "full", browse: "on" })
    const pings6 = page.events.filter((event) => event.type === "ping").length
    const delegated = await turn(
      roles,
      "B6-explore",
      [
        "Use the explore sub-agent (the `subagent` tool with agent `explore`) for this, and do not call any browse tool",
        `yourself: tell it to use the browse tools on tab ${tab ?? "unknown"} (a browse tab this test opened), take a`,
        "snapshot of it, report the page's heading, and then click the Ping button once and report what happened.",
        "Reply with what the sub-agent reported, including any refusal's words.",
      ].join(" "),
    )
    const children = await childCalls(team, roles, project)
    results.B6 = {
      ok:
        children.calls.length > 0 &&
        children.trace.includes("may not act in the user's browser") &&
        page.events.filter((event) => event.type === "ping").length === pings6,
      childTools: names(children.calls),
      refusal: children.trace.includes("may not act in the user's browser"),
      pings: page.events.filter((event) => event.type === "ping").length - pings6,
      parentTools: names(delegated.calls),
    }
    note({ step: "B6", ...(results.B6 as object) })

    // B7: the setting off takes the server and the tools away from every conversation.
    const off = await set({ enabled: false })
    const gone = await until(async () => ((await mcpState()) === undefined ? true : undefined), 60_000)
    const after = await turn(
      full,
      "B7-off",
      "Without calling any tool: do you still have tools whose names start with `browse`? Answer yes or no.",
    )
    results.B7 = {
      ok: !off.enabled && !off.active && gone === true && after.bodies.every((body) => browseTools(body).length === 0),
      status: pick(off),
      mcpGone: gone === true,
      tools: after.bodies.map(browseTools),
      answer: after.answer.slice(0, 120),
    }
    note({ step: "B7", ...(results.B7 as object) })
  } catch (error) {
    note({ step: "error", error: String(error).slice(0, 2000) })
  } finally {
    stopWatch()
    await set({ enabled: false }).catch(() => undefined)
    results.closed = attempt(closeGroup)
    results.tabs = { before: tabsBefore, after: attempt(tabCount) }
    // A second relay of the run's own folders would have made them.
    results.strayBrowseFolders = ["xdg-data", "xdg-state", "xdg-config", "home"].filter((folder) =>
      fs.existsSync(path.join(team.root, folder, folder === "home" ? ".local" : "browse")),
    )
    results.privacy = attempt(() => privacy(page.origin))
    results.events = page.events
    results.asks = asks
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2))
    fs.writeFileSync(path.join(OUT, "log.json"), JSON.stringify(log, null, 2))
    note({ step: "end", out: OUT, privacy: results.privacy, closed: results.closed })
    await team.stop()
    await fakes.stop()
    await forwarder.stop()
    page.stop()
  }
}

/** Whether browse-guard's last pass at `directory` found the `browse` server (its marker files, one per Location). */
function guardReached(directory: string) {
  return fs
    .readdirSync(OUT)
    .filter((file) => file.startsWith("guard-") && file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(path.join(OUT, file), "utf8")) as { directory: string; applied: boolean })
    .some(
      (entry) => path.resolve(entry.directory).toLowerCase() === path.resolve(directory).toLowerCase() && entry.applied,
    )
}

/** A clean-up step's result, or its error: one failing step must not skip the rest. */
function attempt<T>(step: () => T) {
  try {
    return step()
  } catch (error) {
    return { error: String(error).slice(0, 300) }
  }
}

/** The test page: a secret word to read, a Ping button and a Name form, both recorded here, not by the model's word. */
function testPage() {
  const events: Array<{ at: number; type: string; name?: string }> = []
  const state = { secret: secretWord() }
  const html = (body: string) =>
    new Response(
      `<!doctype html><html><head><meta charset="utf-8"><title>own browse test</title></head><body>${body}</body></html>`,
      {
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    )
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/ping") {
        events.push({ at: Date.now(), type: "ping" })
        return Response.json({ pings: events.filter((event) => event.type === "ping").length })
      }
      if (request.method === "POST" && url.pathname === "/submit") {
        const name = String((await request.formData()).get("name") ?? "")
        events.push({ at: Date.now(), type: "submit", name })
        return html(`<h1>Browse live test</h1><p id="result">Thanks, ${escape(name)}. Your form was received.</p>`)
      }
      if (request.method === "GET" && url.pathname === "/") {
        events.push({ at: Date.now(), type: "open" })
        return html(
          [
            "<h1>Browse live test</h1>",
            `<p>The secret word is <b>${state.secret}</b>.</p>`,
            '<p><button id="ping" type="button">Ping</button> <span id="pinged">Not pinged yet.</span></p>',
            '<form method="post" action="/submit"><label>Name <input name="name" type="text"></label>',
            '<button type="submit">Submit</button></form>',
            "<script>document.getElementById('ping').onclick=()=>fetch('/ping',{method:'POST'}).then(r=>r.json())",
            ".then(j=>{document.getElementById('pinged').textContent='Pinged '+j.pings+' times.'})</script>",
          ].join(""),
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    events,
    get secret() {
      return state.secret
    },
    set secret(value: string) {
      state.secret = value
    },
    stop: () => void server.stop(true),
  }
}

function secretWord() {
  return `LANTERN-${Math.floor(Math.random() * 90_000 + 10_000)}`
}

function escape(text: string) {
  return text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
}

/** Answers every permission ask of the project's conversations by `policy`, and keeps what was asked. */
function watchAsks(
  team: Awaited<ReturnType<typeof startTeamServer>>,
  directory: string,
  policy: { decide: (action: string, input: unknown) => Decision },
  asks: Array<{ sessionID: string; action: string; decision: Decision }>,
) {
  const state = { stopped: false }
  const loop = async () => {
    while (!state.stopped) {
      const pending = (await team.server
        .call("GET", "/api/permission/request", { directory })
        .catch(() => ({ data: [] }))) as {
        data: Array<{ id: string; sessionID: string; action: string; metadata?: { input?: unknown } }>
      }
      for (const request of pending.data) {
        const decision = request.action.startsWith("browse_")
          ? policy.decide(request.action, request.metadata?.input)
          : "reject"
        await team.server
          .call("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, { body: { decision } })
          .catch(() => undefined)
        asks.push({ sessionID: request.sessionID, action: request.action, decision })
        note({ step: "permission", action: request.action, decision })
      }
      await Bun.sleep(1_000)
    }
  }
  void loop()
  return () => void (state.stopped = true)
}

async function idle(team: Awaited<ReturnType<typeof startTeamServer>>, sessionID: string, deadline: number) {
  const done = await team.server.waitIdle(sessionID).then(
    () => true,
    (error: unknown) => {
      if (Date.now() > deadline || !/timed out/i.test(String(error))) throw error
      return false
    },
  )
  if (!done) await idle(team, sessionID, deadline)
}

async function history(team: Awaited<ReturnType<typeof startTeamServer>>, sessionID: string, directory: string) {
  const pages: Array<Record<string, unknown>> = []
  const next = async (cursor: string | undefined): Promise<void> => {
    const page = (await team.server.call("GET", `/api/session/${sessionID}/message`, {
      query: cursor === undefined ? { limit: "200", order: "asc" } : { limit: "200", cursor },
      directory,
    })) as { data: Array<Record<string, unknown>>; cursor: { next?: string } }
    pages.push(...page.data)
    if (page.data.length > 0 && page.cursor.next !== undefined) await next(page.cursor.next)
  }
  await next(undefined)
  return pages
}

/** The tool parts of the messages as they are. */
function toolParts(messages: ReadonlyArray<Record<string, unknown>>) {
  return messages.flatMap((message) =>
    ((message.content as Part[] | undefined) ?? []).filter((part) => part.type === "tool"),
  )
}

/** Every tool call of the messages: name, status, the start of its input and of its output or error. */
function toolCalls(messages: ReadonlyArray<Record<string, unknown>>) {
  return messages.flatMap((message) =>
    ((message.content as Part[] | undefined) ?? [])
      .filter((part) => part.type === "tool")
      .map((part) => {
        const state = (part.state ?? {}) as Record<string, unknown>
        return {
          name: String(part.name),
          status: String(state.status),
          input: JSON.stringify(state.input ?? "").slice(0, 200),
          output: JSON.stringify(state.output ?? state.error ?? state.content ?? "").slice(0, 400),
        }
      }),
  )
}

async function childCalls(team: Awaited<ReturnType<typeof startTeamServer>>, parentID: string, directory: string) {
  const children = (await team.server.call("GET", "/api/session", {
    query: { parentID, limit: "50" },
    directory,
  })) as { data: Array<{ id: string; agent?: string }> }
  const messages = (await Promise.all(children.data.map((child) => history(team, child.id, directory)))).flat()
  note({ step: "children", agents: children.data.map((child) => child.agent) })
  return { calls: toolCalls(messages), trace: JSON.stringify(toolParts(messages)) }
}

function names(calls: ReadonlyArray<{ name: string; status: string }>) {
  return calls.map((call) => `${call.name}:${call.status}`)
}

function pick(status: OwnBrowse.Status) {
  return { enabled: status.enabled, source: status.source, given: status.given, active: status.active }
}

async function until<T>(check: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(1_000)
  }
  return undefined
}

/** The model request bodies the forwarder kept since `begun` (file names start with the request's time). */
function bodiesSince(begun: number) {
  const folder = path.join(OUT, "bodies")
  return fs
    .readdirSync(folder)
    .filter((file) => Number(file.split("-")[0]) >= begun && file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(folder, file), "utf8")) as Record<string, unknown>)
}

/**
 * The browse tools a request offered the model: under `tools` or Responses Lite's `additional_tools` item, as direct
 * tools (`browse_<tool>`) or nested in Codex's `exec` (`mcp__browse__<tool>`).
 */
function browseTools(body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  const tools = JSON.stringify([body.tools ?? [], input.filter((item) => item.type === "additional_tools")])
  return [
    ...new Set(
      [...tools.matchAll(/mcp__browse__([a-z_]+)|"name":"browse_([a-z_]+)"/g)].map((match) => match[1] ?? match[2]),
    ),
  ]
}

/**
 * What the request bodies say about personal data: the forwarder's redactions (this PC's user name or the user's
 * email went out replaced), Windows profile paths, a tab the user lent (`"lent":true` in a tab listing), and web
 * addresses in tool results other than the test page. Counts only: an address that is not the test's is not written.
 */
function privacy(origin: string) {
  const folder = path.join(OUT, "bodies")
  const files = fs.readdirSync(folder).filter((file) => file.endsWith(".json"))
  const texts = files.map((file) => fs.readFileSync(path.join(folder, file), "utf8"))
  const forwarded = fs
    .readFileSync(path.join(OUT, "forwarder.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { redacted?: boolean })
  const outputs = texts.flatMap((text) => {
    const body = JSON.parse(text) as { input?: Array<Record<string, unknown>> }
    return (body.input ?? [])
      .filter((item) => String(item.type).endsWith("_output"))
      .map((item) => JSON.stringify(item.output))
  })
  // Browse's own tool descriptions give `localhost:3000` and `app.example.com` as examples (an `ALL_TOOLS` listing).
  const foreign = outputs.flatMap((output) =>
    [...output.matchAll(/https?:\/\/[^\s"'\\<>)]+/g)].filter(
      (match) => !match[0].startsWith(origin) && !EXAMPLE_HOST.test(match[0]),
    ),
  )
  return {
    bodies: files.length,
    redacted: forwarded.filter((entry) => entry.redacted === true).length,
    profilePaths: texts.filter((text) => /[A-Za-z]:(\\\\|\/)Users(\\\\|\/)/i.test(text)).length,
    exampleEmail: texts.filter((text) => text.includes("user@example.invalid")).length,
    lentTabs: texts.filter((text) => /\\?"lent\\?":\s*true/.test(text)).length,
    foreignAddressesInToolResults: foreign.length,
    toolResults: outputs.length,
  }
}

/** How many tabs Browse knows (agent and lent ones), from its own status; nothing else of them is read. */
function tabCount() {
  const program = path.join(process.env.USERPROFILE ?? "", ".local", "bin", "browse.exe")
  const run = Bun.spawnSync([program, "status", "--json"], {
    env: { ...process.env, OPENCODE_BROWSER_AUTO_UPDATE: "off" },
    stdout: "pipe",
    stderr: "ignore",
  })
  const status = JSON.parse(run.stdout.toString()) as { tabs?: unknown[]; connected?: boolean }
  return { tabs: status.tabs?.length, connected: status.connected }
}

const EXAMPLE_HOST = /^https?:\/\/(localhost:3000|([a-z0-9-]+\.)*example\.(com|org|net))(?=[/:?#,]|$)/

/** Closes the run's tab group through the user's Browse CLI (its own token; nothing else is listed or touched). */
function closeGroup() {
  const program = path.join(process.env.USERPROFILE ?? "", ".local", "bin", "browse.exe")
  const run = Bun.spawnSync([program, "tabs", "--json", JSON.stringify({ action: "close", group: GROUP })], {
    env: { ...process.env, OPENCODE_BROWSER_AUTO_UPDATE: "off" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = `${run.stdout.toString()}${run.stderr.toString()}`
  return {
    exit: run.exitCode,
    closed: /"closed"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1]?.split(",").filter(Boolean).length,
  }
}

await main()
