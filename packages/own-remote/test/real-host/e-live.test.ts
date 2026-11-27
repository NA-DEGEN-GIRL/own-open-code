// Real-host phase E (live): the harnesses and team mode on the approved SSH host with real models (user request,
// 2026-10-14). Opt-in twice: OWN_REAL_HOST=<alias> like the other phases, and OWN_REAL_HOST_LIVE=1 because it spends the
// user's API credit. Needs phase A's install (a-transport); run it before z-cleanup.
//
// Model traffic: the Claude account (`기타 OpenAI 호환`) calls http://127.0.0.1:<F>/... on the host, an `ssh -R` to this
// PC's live forwarder (own-harness script/live/forwarder.ts): it stands in for a cloud API the host reaches by itself,
// with a fake key the forwarder replaces. The local stand-in is a `로컬 모델` account without a key whose base URL is the
// forwarder on this PC's 127.0.0.1 (SLM 2026-11-22, 04 §8.14): the host reaches it only through this PC's relay, the
// product path of the user's own local model (before, it was a `기타 OpenAI 호환` account through the same test-only
// -R, which never exercised that path). OWN_REAL_HOST_E_STANDIN_KIND=compat goes back to that on purpose only. The forwarder drops the fake key the account carries, adds
// the real one (DPAPI, this PC only) and forwards to api.anthropic.com (OpenAI-compatible chat) or, for the stand-in
// model, to the user's local model server on this PC (`/local/v1`, no key; OWN_LIVE_LOCAL_URL and OWN_LIVE_LOCAL_MODEL as
// in own-harness' live kit) only. No real credential reaches the host or the remote service. The stand-in was the
// DeepSeek API until 2026-11-14; the user asked for the local server instead (2026-11-12), so a request body never
// leaves their machines. OWN_REAL_HOST_E_STANDIN=deepseek names the API again, on purpose only: with the local server
// off the phase fails at its start and never falls back by itself.
//
// Everything on the host lives in one temp root /tmp/own-<uid>-team-<rand> (makeRoot), removed in afterAll.
//   1. each harness (codex, pi, opencode, omo) fixes the seeded bugs of a JavaScript repository (`node --test`) on
//      the stand-in model. omo runs the host's own-omo (15 §1): the host offers it in that folder, omo's log on the host shows its
//      plugin starting, and the check waits until nothing runs in that folder (omo continues open todos)
//   2. the codex session goes on after a switch to Claude and a compaction
//   3. team mode on the host: the main splits the work into areas after the user agrees, each pinned to a model and a harness, a model change
//      and a compaction inside the areas, integration into the target, `node --test` in the main folder. Round 1 sends
//      one `fresh` request to an owner pinned to another harness than the default whose switch notice still waits in its
//      queue (RH-15, RH-20, RH-36; `e-team-fresh-before.json`): its rotation must end, the new owner keeps the pinned
//      model and harness, and the request reaches it (`e-team-fresh.json`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { OwnTeam } from "@own/protocol"
import { startForwarder, type Forwarder } from "../../../own-harness/script/live/forwarder.js"
import { ALIAS, evidence, forwardProcess, freeLocalPort, heavyHost, hostSh, kv } from "./env.js"
import { startStack, until, type Stack } from "./stack.js"
import { local, makeRoot, remoteFetch, remoteSession, remoteTeam, removeRoot, type Endpoint } from "./team-fixture.js"

const run = heavyHost && process.env.OWN_REAL_HOST_LIVE === "1" ? describe : describe.skip
const CLIENT = "real-host-e"
const FIXTURE = path.join(import.meta.dir, "live", "bugfix")
/** Runs on real models: a step may take minutes. */
const TURN_MS = 20 * 60_000
const ROUND_MS = 50 * 60_000
/**
 * A team wait fails once nothing of the team moved for this long (`OWN_REAL_HOST_E_STALL_MS`): RH-8 and RH-15 hung with
 * nothing moving and were reported only at ROUND_MS, 50 min later. Longer than any quiet model turn seen (RH-3: 229 s).
 */
const STALL_MS = Number(process.env.OWN_REAL_HOST_E_STALL_MS ?? 10 * 60_000)
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]
const BUGFIX =
  "The test suite of this repository fails. Find and fix the bugs in `src/` so that `node --test` passes. " +
  "Do not change anything under `test/`. When you are done, reply with one line per bug you fixed."
/** The harnesses of the bugfix test: own.harness' three and omo (원본) through own-omo (15 §1, 2026-10-29). */
const BUGFIX_HARNESSES = ["codex", "pi", "opencode", "omo"] as const
/** How long nothing may run in the omo bugfix folder before its check: omo continues open todos 2 s after an idle. */
const REST_MS = 15_000

/** The PC's compat accounts: fake keys (the forwarder replaces them), the forwarded host port as their base URL. */
const LOCAL_URL = (process.env.OWN_LIVE_LOCAL_URL ?? "http://localhost:64644/v1").replace(/\/+$/, "")
const DEEPSEEK = process.env.OWN_REAL_HOST_E_STANDIN === "deepseek"
/**
 * The keyless `로컬 모델` stand-in served by DeepSeek's API through the forwarder's local route
 * (OWN_LIVE_LOCAL_UPSTREAM=deepseek): the relay path of a local model without the user's local model server (decisions
 * MR18, the v2.4.1 release's chain).
 */
const LOCAL_DEEPSEEK = process.env.OWN_LIVE_LOCAL_UPSTREAM === "deepseek"
/** The local stand-in as the app's local model form adds it (04 §8.14), unless asked otherwise or on DeepSeek. */
const STANDIN_LOCAL = !DEEPSEEK && process.env.OWN_REAL_HOST_E_STANDIN_KIND !== "compat"
const ACCOUNTS = {
  standin: DEEPSEEK
    ? {
        label: "Live DeepSeek",
        key: "sk-ownRealHostLiveDeepSeekFake000001",
        route: "deepseek/v1",
        model: "deepseek-v4-pro",
        context: 128_000,
      }
    : {
        label: "Live local",
        key: "sk-ownRealHostLiveLocalFake000000001",
        route: "local/v1",
        model: process.env.OWN_LIVE_LOCAL_MODEL ?? (LOCAL_DEEPSEEK ? "deepseek-v4-pro" : "local-flash-model-q4-0001"),
        context: LOCAL_DEEPSEEK ? 128_000 : 1_048_576,
      },
  claude: {
    label: "Live Claude",
    key: "sk-ownRealHostLiveClaudeFake0000001",
    route: "anthropic/v1",
    model: "claude-opus-5-5",
    context: 200_000,
  },
}
type Live = keyof typeof ACCOUNTS

/** git commands the test refuses when a team conversation asks (06 4.9: the guard asks even in full approval). */
const DESTRUCTIVE =
  /\bgit\b[^\n]*\b(push|reset\s+--hard|clean|restore|stash|worktree|branch\s+-D|checkout\s+(--|-f|\.))/
type Ref = { readonly providerID: string; readonly id: string }

run(`real host ${ALIAS}: live harnesses and team (phase E)`, () => {
  const state = {} as {
    stack: Stack
    hostId: string
    endpoint: Endpoint
    forwarder: Forwarder
    tunnel: ReturnType<typeof forwardProcess>
    root: string
    models: Record<Live, Ref>
    codex?: { readonly sessionID: string; readonly directory: string }
    teamID?: OwnTeam.TeamID
    /** The team test's main folder and conversation, and whether it got to its end (e-team.json). */
    team?: { readonly home: string; readonly main: string; done: boolean }
    watcher?: { stop(): void }
  }
  const team = remoteTeam(() => state.endpoint)
  const call = async (method: string, route: string, directory: string, body?: unknown, timeoutMs?: number) => {
    const send = () =>
      remoteFetch(state.endpoint, method, route, {
        directory,
        ...(body === undefined ? {} : { body }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })
    // A Location first named here (an area's new worktree) boots before its plugins load, and the server never waits
    // for them (upstream #62796, AGENTS.md "Plugin Loading"): an own RPC answers `rpc.unavailable` until they have.
    // Asked again within 10 s, as own-remote's client does (2.4.1-own.3 chain 3: own.harness 1 ms after the boot).
    const deadline = Date.now() + 10_000
    let answer = await send()
    while (
      route.startsWith("/api/rpc/") &&
      answer.status === 400 &&
      (answer.body as { type?: string } | undefined)?.type === "rpc.unavailable" &&
      Date.now() < deadline
    ) {
      await Bun.sleep(250)
      answer = await send()
    }
    // `wait` answers 204 when the session is idle.
    if (answer.status < 200 || answer.status > 299)
      throw new Error(`${method} ${route}: HTTP ${answer.status} ${JSON.stringify(answer.body)}`)
    return answer.body as { data?: unknown; output?: unknown }
  }
  /** Whether the remote service runs `sessionID` now (`/api/session/active` covers every Location of the process). */
  const busy = async (sessionID: string, directory: string) => {
    const active = await call("GET", "/api/session/active", directory)
    return Object.keys((active.data as Record<string, unknown> | undefined) ?? {}).includes(sessionID)
  }
  /** own.harness' harness switch notices (metadata `own.harness.switch`) still waiting in the session's queue. */
  const switchNotices = async (sessionID: string, directory: string) => {
    const listed = await call("GET", `/api/session/${sessionID}/inbox`, directory)
    const items = (listed.data ?? []) as ReadonlyArray<{
      readonly type?: string
      readonly payload?: { readonly metadata?: Readonly<Record<string, { readonly switch?: unknown } | undefined>> }
    }>
    return items.filter(
      (item) => item.type === "synthetic" && item.payload?.metadata?.[OwnHarness.META_KEY]?.switch !== undefined,
    )
  }
  /** The phase's steps with their start and length, rewritten to e-steps.json after each one ends. */
  const steps: Array<{ step: string; at: string; seconds?: number; error?: string }> = []
  /** Runs `run` as the step `name`: recorded in e-steps.json, and a failure says which step it was. */
  const step = async <T>(name: string, run: () => Promise<T>) => {
    const entry: (typeof steps)[number] = { step: name, at: new Date().toISOString() }
    steps.push(entry)
    const started = Date.now()
    const end = (error?: unknown) => {
      entry.seconds = Math.round((Date.now() - started) / 1000)
      if (error !== undefined) entry.error = String(error).slice(0, 600)
      evidence("e-steps.json", steps)
    }
    return run().then(
      (value) => {
        end()
        return value
      },
      (error: unknown) => {
        end(error)
        throw new Error(`step ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      },
    )
  }
  /**
   * One prompt and the wait for the session's idle (TURN_MS). On a failed wait the error says whether the session still
   * ran then (the turn outgrew the budget) or was idle (the wait missed the end).
   */
  const turn = (label: string, sessionID: string, directory: string, text: string) =>
    step(label, async () => {
      await call("POST", `/api/session/${sessionID}/prompt`, directory, { text })
      await call("POST", `/api/experimental/session/${sessionID}/wait`, directory, undefined, TURN_MS).catch(
        async (error: unknown) => {
          const running = await busy(sessionID, directory).catch(() => undefined)
          const seen = running === undefined ? "unknown" : running ? "still running" : "idle"
          throw new Error(`${error instanceof Error ? error.message : String(error)}; session ${sessionID} ${seen}`, {
            cause: error,
          })
        },
      )
    })
  /** `node --test` in `directory` on the host: its `# pass N` and `# fail N` summary lines. */
  const nodeTest = async (directory: string) => {
    const ran = await hostSh(`cd '${directory}' && node --test 2>&1 | grep -E '^# (pass|fail) '`, 300_000)
    const count = (name: string) => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(ran.stdout)?.[1] ?? 0)
    return { pass: count("pass"), fail: count("fail") }
  }
  /**
   * own.harness on the host offers omo in `directory` (it lists omo only where own-omo's tools are registered, 15 §3.7),
   * within a minute of that folder's first request (its Location starts the plugins then).
   */
  const omoOffered = async (directory: string) => {
    const seen = { output: undefined as unknown }
    await until(
      async () => {
        const listed = await call("POST", `/api/rpc/${OwnHarness.ID}/list`, directory, { input: {} })
        seen.output = listed.output
        return (listed.output as { readonly harnesses?: ReadonlyArray<string> } | undefined)?.harnesses?.includes("omo")
          ? true
          : undefined
      },
      60_000,
      2_000,
    ).catch(() => {
      throw new Error(`the host does not offer omo in ${directory}: ${JSON.stringify(seen.output)}`)
    })
  }
  /** Nothing runs in `directory` (a session or one of its children) for {@link REST_MS}. */
  const rested = (directory: string) => {
    const idle = { since: 0 }
    return until(
      async () => {
        const active = await call("GET", "/api/session/active", directory)
        const placed = await Promise.all(
          Object.keys((active.data as Record<string, unknown> | undefined) ?? {}).map((id) =>
            call("GET", `/api/session/${id}`, directory).then(
              (got) => (got.data as { readonly location?: { readonly directory?: string } }).location?.directory,
              () => undefined,
            ),
          ),
        )
        if (placed.includes(directory)) {
          idle.since = 0
          return undefined
        }
        idle.since ||= Date.now()
        return Date.now() - idle.since >= REST_MS ? true : undefined
      },
      TURN_MS,
      2_000,
    )
  }
  /** The starts of omo's plugin entry in omo's log on the host (`<OWN_HOME>/thirdparty/omo/logs/omo.log`, 15 §3.2). */
  const omoStarts = async () => {
    const ran = await hostSh(
      `f="$HOME/.local/share/own-open-code/thirdparty/omo/logs/omo.log"; echo "STARTS=$(grep -c 'ENTRY - plugin loading' "$f" 2>/dev/null)"`,
    )
    return Number(kv(ran.stdout).get("STARTS") ?? 0)
  }
  /** Tool calls and answer models of a remote conversation, written to the evidence folder. */
  const summary = async (sessionID: string, directory: string) => {
    const listed = await call("GET", `/api/session/${sessionID}/message?limit=200&order=asc`, directory)
    const messages = (listed.data as Array<Record<string, unknown>>) ?? []
    evidence(`e-${sessionID}.json`, messages)
    const tools: Record<string, number> = {}
    messages.forEach((message) =>
      ((message.content as Array<Record<string, unknown>> | undefined) ?? [])
        .filter((part) => part.type === "tool")
        .forEach((part) => (tools[String(part.name)] = (tools[String(part.name)] ?? 0) + 1)),
    )
    const models = messages.flatMap((message) =>
      message.type === "assistant" ? [String((message.model as { id?: string } | undefined)?.id)] : [],
    )
    return {
      tools,
      models: models.filter((model, index) => model !== models[index - 1]),
      compactions: messages.filter((message) => message.type === "compaction").length,
    }
  }

  beforeAll(async () => {
    if (!DEEPSEEK && !LOCAL_DEEPSEEK) {
      const listed = await fetch(`${LOCAL_URL}/models`, { signal: AbortSignal.timeout(10_000) })
        .then((response) => response.json() as Promise<{ data?: ReadonlyArray<{ id?: string }> }>)
        .catch(() => undefined)
      if (!listed?.data?.some((item) => item.id === ACCOUNTS.standin.model))
        throw new Error(`the local model server at ${LOCAL_URL} is off or does not serve ${ACCOUNTS.standin.model}`)
    }
    state.stack = await startStack()
    state.hostId = state.stack.hostId
    // The forwarder on a port the host does not use; the -R gives the host's 127.0.0.1 the same number.
    const port = await freeLocalPort()
    state.forwarder = startForwarder(path.join(evidenceDir(), "e-forwarder.jsonl"), {}, port)
    state.tunnel = forwardProcess(["-R", `127.0.0.1:${port}:127.0.0.1:${port}`])
    state.models = {
      standin: await compat(state.stack, "standin", port),
      claude: await compat(state.stack, "claude", port),
    }
    await local(state.stack, "connect", { hostId: state.hostId, clientId: CLIENT })
    await until(
      async () => {
        const listed = await local(state.stack, "hosts.list", {})
        const found = listed.hosts.find((item) => item.id === state.hostId)
        return found?.stage === "ready" ? found : undefined
      },
      240_000,
      500,
    )
    const resolved = await local(state.stack, "resolve", { hostId: state.hostId })
    if (resolved.url === null) throw new Error(`host not ready: ${resolved.stage}`)
    state.endpoint = { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
    await until(
      async () => (await hostSh(`ss -Htln | awk '{print $4}' | grep -c '^127.0.0.1:${port}$'`)).stdout.trim() === "1",
      60_000,
      1_000,
    )
    state.root = await makeRoot()
  }, 600_000)

  afterAll(async () => {
    if (!state.stack) return
    state.watcher?.stop()
    // A failed team test still leaves the main's and the owners' conversations (the host's copy goes with z-cleanup).
    const kept = state.team
    // The host service's logs go with z-cleanup too (RH-10: the second round's stop could only be inferred): the
    // server's (`~/.local/share/opencode/log`) and own's plugin logs, read only, as `e-host-logs.tgz`.
    if (kept && !kept.done)
      await hostSh(
        `cd "$HOME/.local/share" && tar -czf - opencode/log own-open-code/logs 2>/dev/null | base64 -w 0`,
        180_000,
      )
        .then((got) => fs.writeFileSync(path.join(evidenceDir(), "e-host-logs.tgz"), Buffer.from(got.stdout, "base64")))
        .catch(() => undefined)
    // RH-20: own.team's own log (`own-team.log*`, its op steps, waits and warnings) always, a pass included.
    if (kept)
      await hostSh(
        `cd "$HOME/.local/share/own-open-code/logs" && tar -czf - own-team.log* 2>/dev/null | base64 -w 0`,
        180_000,
      )
        .then((got) =>
          fs.writeFileSync(path.join(evidenceDir(), "e-host-team-log.tgz"), Buffer.from(got.stdout, "base64")),
        )
        .catch(() => undefined)
    if (kept && !kept.done)
      await team
        .call("team.get", { directory: kept.home })
        .then((got) =>
          Promise.all([
            summary(kept.main, kept.home),
            ...got.areas.flatMap((area) =>
              area.owner.sessionID ? [summary(area.owner.sessionID, area.directory)] : [],
            ),
          ]),
        )
        .catch(() => undefined)
    if (state.teamID) {
      const answer = await team.raw("disable", { teamID: state.teamID }).catch(() => undefined)
      const opID = answer?.status === 200 ? (answer.body as { output?: { opID?: string } }).output?.opID : undefined
      if (opID) await team.opEnd(opID, { timeoutMs: 120_000, waiting: true }).catch(() => undefined)
    }
    const removed = state.root ? await removeRoot(state.root).catch(() => false) : true
    evidence("e-cleanup.json", { rootRemoved: removed, root: state.root })
    evidence("e-sink.txt", state.stack.sink.lines.join("\n"))
    await local(state.stack, "disconnect", { hostId: state.hostId }).catch(() => undefined)
    evidence("e-local-server.log", state.stack.server.logs())
    state.tunnel?.stop()
    await state.forwarder?.stop()
    await state.stack.stop()
    expect(removed).toBe(true)
  }, 600_000)

  test(
    "each harness fixes the seeded bugs on the host (the stand-in model through the PC's forwarder)",
    async () => {
      const results = await Promise.all(
        BUGFIX_HARNESSES.map(async (harness) => {
          const directory = `${state.root}/bugfix-${harness}`
          await upload(directory)
          // An omo session runs `opencode` where own-omo is not loaded: the host must offer omo in this folder.
          if (harness === "omo") await omoOffered(directory)
          const created = await call("POST", "/api/session", directory, {
            title: `live bugfix ${harness}`,
            model: state.models.standin,
            location: { directory },
            permissions: FULL,
            metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
          })
          const sessionID = (created.data as { id: string }).id
          const started = Date.now()
          await turn(`bugfix-${harness}`, sessionID, directory, BUGFIX)
          if (harness === "omo") await step("bugfix-omo-rest", () => rested(directory))
          const tests = await nodeTest(directory)
          const untouched =
            kv(
              (await hostSh(`cd '${directory}' && git diff --quiet HEAD -- test && echo SAME=1 || echo SAME=0`)).stdout,
            ).get("SAME") === "1"
          if (harness === "codex") state.codex = { sessionID, directory }
          return {
            harness,
            seconds: Math.round((Date.now() - started) / 1000),
            tests,
            untouched,
            ...(await summary(sessionID, directory)),
            ...(harness === "omo" ? { omoStarts: await omoStarts() } : {}),
          }
        }),
      )
      evidence("e-bugfix.json", results)
      console.table(
        results.map((item) => ({
          ...item,
          tests: `${item.tests.pass}/${item.tests.pass + item.tests.fail}`,
          tools: JSON.stringify(item.tools),
        })),
      )
      for (const item of results) {
        expect(item.tests).toEqual({ pass: 16, fail: 0 })
        expect(item.untouched).toBe(true)
      }
      // omo's runtime started on the host (its plugin entry's first log line in OWN_HOME's omo log).
      expect(results.find((item) => item.harness === "omo")?.omoStarts).toBeGreaterThan(0)
    },
    // omo's folder may rest up to another TURN_MS after its turn.
    TURN_MS * 3,
  )

  test(
    "the codex session goes on after a switch to Claude and a compaction",
    async () => {
      const session = state.codex
      if (!session) throw new Error("the codex session of the previous test is missing")
      await call("POST", `/api/session/${session.sessionID}/model`, session.directory, { model: state.models.claude })
      await turn(
        "switch-claude",
        session.sessionID,
        session.directory,
        "Add `test/extra.test.js` (node:test) with two more cases for addBusinessDays: Sunday + 1 is Monday, and a fractional count is a RangeError. Make `node --test` pass; fix src if needed.",
      )
      await step("switch-compact", async () => {
        await call("POST", `/api/session/${session.sessionID}/compact`, session.directory, {})
        await call("POST", `/api/experimental/session/${session.sessionID}/wait`, session.directory, undefined, TURN_MS)
      })
      await turn(
        "switch-readme",
        session.sessionID,
        session.directory,
        "Which bugs did you fix in this repository so far, and which test file did you add? Then add a `README.md` with one line per module in src/.",
      )
      const tests = await nodeTest(session.directory)
      const readme = kv(
        (await hostSh(`cd '${session.directory}' && [ -f README.md ] && echo README=1 || echo README=0`)).stdout,
      ).get("README")
      const result = { tests, readme, ...(await summary(session.sessionID, session.directory)) }
      evidence("e-switch.json", result)
      console.log(JSON.stringify(result))
      expect(tests.fail).toBe(0)
      expect(tests.pass).toBeGreaterThanOrEqual(18)
      expect(result.models).toEqual([ACCOUNTS.standin.model, ACCOUNTS.claude.model])
      expect(result.compactions).toBeGreaterThanOrEqual(1)
      expect(readme).toBe("1")
    },
    TURN_MS * 3,
  )

  test(
    "team mode on the host: areas the main makes once the user agrees, pinned to models and harnesses, a model change and a compaction, integration",
    async () => {
      const home = `${state.root}/textkit`
      await textkit(home)
      // The conversation the user enables from; the team opens its own main conversation on that model (06 3.2).
      const viewed = await remoteSession(state.endpoint, {
        directory: home,
        title: "live team",
        model: state.models.standin,
      })
      const view = await step("enable", async () => {
        const started = await team.call("enable", { directory: home, sessionID: viewed, hint: HINT })
        evidence("e-team-enable.json", await team.opEnd(started.opID, { timeoutMs: 15 * 60_000 }))
        return team.call("team.get", { directory: home })
      })
      if (!view.team) throw new Error("the team was not enabled")
      const teamID = view.team.id
      state.teamID = teamID
      // 직접 작업 (2026-11-14) is on by default: the steps below talk to owners in their conversations as the user, and
      // none is about direct work, so the hold would keep the main's requests waiting. Off right after enable.
      await team.call("settings.set", { teamID, patch: { policy: { directHold: false } } })
      const main = view.team.main.sessionID
      state.team = { home, main, done: false }
      await call("POST", `/api/rpc/own.accounts/session.approval.set`, home, {
        input: { sessionID: main, mode: "full" },
      })
      const plan: ReadonlyArray<{ model: Live; harness: OwnHarness.HarnessID; then: Live }> = [
        { model: "standin", harness: "codex", then: "claude" },
        { model: "claude", harness: "pi", then: "standin" },
        { model: "standin", harness: "opencode", then: "claude" },
      ]
      const areas = () =>
        team.call("team.get", { directory: home }).then((got) => got.areas.filter((area) => area.state === "active"))
      // Answers permission asks and confirms from the start: once the main makes the areas their owners start working.
      const watcher = watch(home, main)
      state.watcher = watcher
      /**
       * What moves while the team works: its op and steps, the areas' statuses and owners, the busy conversations, the
       * newest message of the main, of each owner and of their sub-agents, and the asks the watcher answered. A read
       * that fails is part of the signature: a stack that stopped answering is a stall too.
       */
      const progress = async () => {
        const seen = await team.call("team.get", { directory: home })
        const roots = [
          { id: main, directory: home },
          ...seen.areas.flatMap((area) =>
            area.owner.sessionID ? [{ id: area.owner.sessionID, directory: area.directory }] : [],
          ),
        ]
        const children = await Promise.all(
          roots.map(async (root) =>
            (
              ((await call("GET", `/api/session?parentID=${root.id}&limit=50`, root.directory)).data ?? []) as Array<{
                readonly id: string
              }>
            ).map((child) => ({ id: child.id, directory: root.directory })),
          ),
        )
        const newest = await Promise.all(
          [...roots, ...children.flat()].map(
            async (session) =>
              (await call("GET", `/api/session/${session.id}/message?limit=1&order=desc`, session.directory)).data,
          ),
        )
        const active = (await call("GET", "/api/session/active", home)).data as Record<string, unknown> | undefined
        return JSON.stringify({
          op: seen.op,
          waiting: seen.waiting,
          areas: seen.areas.map((area) => [area.id, area.state, area.status, area.owner.sessionID]),
          active: Object.keys(active ?? {}).toSorted(),
          newest,
          asked: watcher.asked.length,
        })
      }
      /**
       * `read` until it answers, failing at `timeoutMs` or once `progress` (checked every minute) stayed the same for
       * STALL_MS. On either, what the team looked like then (the host's logs go with z-cleanup): the areas, the team's
       * running or waiting op with its steps and each area's outbox (RH-15: a rotation op that never left its first step
       * could only be inferred). A read that fails is recorded as its error: an empty list there read like an empty team
       * in RH-10.
       */
      const waitFor = <T>(label: string, read: () => Promise<T | undefined>, timeoutMs: number, stepMs: number) => {
        const deadline = Date.now() + timeoutMs
        const moved = { at: Date.now(), checked: 0, last: "" }
        const poll = async (): Promise<T> => {
          const value = await read().catch(() => undefined)
          if (value) return value
          if (Date.now() > deadline) throw new Error(`${label}: timeout after ${Math.round(timeoutMs / 60_000)} min`)
          if (Date.now() - moved.checked >= 60_000) {
            moved.checked = Date.now()
            const now = await progress().catch((error: unknown) => `unreadable: ${String(error).slice(0, 300)}`)
            if (now !== moved.last) Object.assign(moved, { at: Date.now(), last: now })
            if (Date.now() - moved.at >= STALL_MS)
              throw new Error(
                `${label}: stalled, nothing moved for ${Math.round((Date.now() - moved.at) / 60_000)} min`,
              )
          }
          await Bun.sleep(stepMs)
          return poll()
        }
        return poll().catch(async (error: unknown) => {
          const failed = (reason: unknown) => ({ error: String(reason).slice(0, 300) })
          const seen = await team.call("team.get", { directory: home }).catch(failed)
          evidence(`e-team-stuck-${label}.json`, {
            areas:
              "error" in seen
                ? seen
                : seen.areas
                    .filter((area) => area.state === "active")
                    .map((area) => ({ name: area.name, status: area.status, owner: area.owner.sessionID })),
            op: "error" in seen ? seen : seen.op,
            waiting: "error" in seen ? seen : seen.waiting,
            active: await call("GET", "/api/session/active", home).then((got) => got.data, failed),
            main: await call("GET", `/api/session/${main}/message?limit=8`, home).then((got) => got.data, failed),
            asked: watcher.asked,
            failure: String(error),
          })
          throw error
        })
      }
      // The main may rotate the new areas by itself right after the split (a `fresh` request to each, RL8): a pin that
      // meets such an op is refused as `busy`, and waits for that op to end before it asks again, as a user would.
      const pinWhenFree = async (area: OwnTeam.AreaView, model: Live) => {
        for (let tries = 0; ; tries++) {
          const answer = await team
            .call("area.main", { teamID, areaID: area.id, model: state.models[model], now: true })
            .then(
              (set) => ({ set }),
              (error: unknown) => ({ error }),
            )
          if ("set" in answer) return answer.set
          const busy = /"type":"busy".*?"opID":"(op_\w+)"/.exec(String(answer.error))
          if (!busy || tries >= 10) throw answer.error
          await team.opEnd(busy[1]!, { timeoutMs: 10 * 60_000 })
        }
      }
      const pin = (area: OwnTeam.AreaView, model: Live, harness: OwnHarness.HarnessID) =>
        step(`pin-${area.name}-${model}-${harness}`, async () => {
          const set = await pinWhenFree(area, model)
          if (set.opID) await team.opEnd(set.opID, { timeoutMs: 10 * 60_000 })
          const current = (await areas()).find((item) => item.id === area.id)!
          const owner = current.owner.sessionID!
          // A harness switches only between runs: a new area's owner may still run its first turn (session_busy).
          await waitFor(
            `pin-${area.name}`,
            async () => (!(await busy(owner, home)) ? true : undefined),
            ROUND_MS,
            5_000,
          )
          await call("POST", `/api/rpc/${OwnHarness.ID}/session.set`, current.directory, {
            input: { sessionID: owner, harness },
          })
          await call("POST", `/api/rpc/own.accounts/session.approval.set`, current.directory, {
            input: { sessionID: owner, mode: "full" },
          })
        })
      // Since 2026-10-16 `enable` makes no area from the goal alone (06 §3.4): the user sends the enable dialog's
      // discussion draft (own-web `own.team.enable.draft`) and agrees to the main's split, which makes the areas.
      await turn(
        "split-ask",
        main,
        home,
        `${HINT}

이 일을 팀에서 어떻게 나눌지 먼저 같이 정하자. 나누는 안을 보여 줘.`,
      )
      await turn("split-agree", main, home, "좋아요, 그 안대로 영역을 만들어 주세요.")
      if ((await areas()).length === 0) await turn("split-proceed", main, home, "네, 진행해 주세요.")
      await step("split", () =>
        waitFor("split", async () => ((await areas()).length > 0 ? true : undefined), 15 * 60_000, 10_000),
      )
      const listed = await areas()
      for (const [index, area] of listed.entries())
        await pin(area, plan[index % plan.length]!.model, plan[index % plan.length]!.harness)
      // RH-15 / RH-20: round 1 sends one `fresh` request to an owner pinned to a harness other than the default (its
      // switch notice waits in the owner's queue), so the rotation's safe point meets that notice on the host. The
      // user's prompt names the area, so it does not rest on the model choosing `fresh` by itself. RH-36: the area is
      // one whose owner still holds that notice right before round 1 (as `rotate-pinned.e2e` checks first), so the
      // run proves the parked-notice path was there to meet; none holding it fails here, before any round.
      const current = await areas()
      const parked = await Promise.all(
        listed.map(async (area, index) => {
          const owner = current.find((item) => item.id === area.id)?.owner.sessionID ?? undefined
          if (!owner || plan[index % plan.length]!.harness === "codex") return { area: area.name, owner, notices: 0 }
          return { area: area.name, owner, notices: (await switchNotices(owner, area.directory)).length }
        }),
      )
      evidence("e-team-fresh-before.json", parked)
      const freshIndex = parked.findIndex((item) => item.notices > 0)
      const fresh = listed[freshIndex]
      if (!fresh)
        throw new Error(`no owner pinned to another harness keeps its switch notice: ${JSON.stringify(parked)}`)
      const freshPin = plan[freshIndex % plan.length]!
      const before = parked[freshIndex]!.owner!

      const round = async (done: (list: ReadonlyArray<OwnTeam.AreaView>) => Promise<boolean>) =>
        waitFor(
          "round",
          async () => ((await done(await areas())) && !(await busy(main, home)) ? true : undefined),
          ROUND_MS,
          15_000,
        )
      /**
       * Every area has commits of its own and all of them are in the target (`main`) of the main folder. Read from git:
       * an integration clears the area's candidate when it goes in (own-team report/events.ts `integrated`).
       */
      const integrated = async (list: ReadonlyArray<OwnTeam.AreaView>) => {
        // An owner syncs its branch with `git merge main` after each integration (06 §7.2 step 9). When it already had
        // its next commit, that merge commit stays on the branch and never enters main, though everything it carries
        // has (2.4.1-own.3 chain 4: csv 8337ab2 integrated, its branch two sync merges ahead): only the area's own
        // commits must be in main.
        const lines = list.map(
          (area) =>
            `test -z "$(git rev-list --no-merges main..'${area.branch}')" || echo MISSING=${area.id}; ` +
            `test "$(git rev-list --count ${area.base.sha}..'${area.branch}')" -gt 0 || echo EMPTY=${area.id}`,
        )
        const checked = await hostSh(`cd '${home}' && ${lines.join("; ")}; echo CHECKED=1`)
        return (
          kv(checked.stdout).get("CHECKED") === "1" &&
          !checked.stdout.includes("MISSING=") &&
          !checked.stdout.includes("EMPTY=")
        )
      }

      await step("round-1", async () => {
        await call("POST", `/api/session/${main}/prompt`, home, { text: round1(fresh.name) })
        // A main may integrate in round 1 against the prompt (2026-10-26: DeepSeek V4 Pro did, every area went from
        // ready to idle, and the wait for ready timed out with the work done); that ends the round too.
        await round(async (list) => list.every((area) => area.status.kind === "ready") || (await integrated(list)))
      })
      await step("round-1-fresh", async () => {
        // The rotation ran and ended: the old owner is in `previous` for `fresh`, and the area has a new owner.
        const now = (await areas()).find((item) => item.id === fresh.id)
        const replaced = now?.owner.previous.find((item) => item.sessionID === before)
        const next = now?.owner.sessionID ?? undefined
        const view = next
          ? ((await call("GET", `/api/session/${next}`, now!.directory)).data as {
              readonly model?: Ref
              readonly metadata?: Record<string, unknown>
            })
          : undefined
        // The request reached the new owner: a main request (`own.dispatch`) among its messages.
        const messages = next
          ? (((await call("GET", `/api/session/${next}/message?limit=50`, now!.directory)).data ?? []) as Array<{
              readonly type?: string
              readonly metadata?: Record<string, unknown>
            }>)
          : []
        const reached = messages.some((item) => item.type === "user" && item.metadata?.["own.dispatch"] !== undefined)
        const seen = {
          area: fresh.name,
          before,
          after: next,
          replaced,
          model: view?.model,
          harness: OwnHarness.bound(view?.metadata),
          reached,
          // The notice the rotation passed: still in the old conversation, or delivered by a warm handoff turn.
          left: await switchNotices(before, fresh.directory).then(
            (items) => items.length,
            (error: unknown) => String(error).slice(0, 200),
          ),
        }
        evidence("e-team-fresh.json", seen)
        expect(replaced?.why).toBe("fresh")
        expect(next).not.toBe(before)
        expect(seen.model).toMatchObject(state.models[freshPin.model])
        expect(seen.harness).toBe(freshPin.harness)
        expect(reached).toBe(true)
      })
      for (const [index, area] of (await areas()).entries()) {
        const owner = area.owner.sessionID!
        await step(`compact-${area.name}`, async () => {
          await call("POST", `/api/session/${owner}/compact`, area.directory, {})
          await call("POST", `/api/experimental/session/${owner}/wait`, area.directory, undefined, TURN_MS)
        })
        await pin(area, plan[index % plan.length]!.then, plan[index % plan.length]!.harness)
      }
      // Round 2 ends when every area's newest candidate went into the target; a timeout still reports what happened.
      const finished = await step("round-2", async () => {
        await call("POST", `/api/session/${main}/prompt`, home, { text: ROUND_2 })
        return round(integrated).then(
          () => true,
          () => false,
        )
      })
      const tests = await nodeTest(home)
      const gitLog = (await hostSh(`cd '${home}' && git log --oneline --graph -20`)).stdout
      const owners = await Promise.all(
        (await areas()).map(async (area) => ({
          area: area.name,
          ...(await summary(area.owner.sessionID!, area.directory)),
        })),
      )
      watcher.stop()
      const result = { finished, tests, gitLog, owners, main: await summary(main, home), asked: watcher.asked }
      evidence("e-team.json", result)
      state.team.done = true
      console.log(gitLog)
      console.table(owners.map((owner) => ({ ...owner, tools: JSON.stringify(owner.tools) })))
      expect(finished).toBe(true)
      expect(tests.fail).toBe(0)
      expect(tests.pass).toBeGreaterThan(1)
    },
    ROUND_MS * 2 + TURN_MS,
  )

  /**
   * Every 5 s, what a user at the app would answer: the permission asks of the team's conversations and their
   * sub-agents (git-destructive ones rejected, the rest once) and questions (cancelled with the `AWAY` message), as the local
   * live team test. Since upstream v2.4 a dismissal without a message ends the asking step (core's question tool): an
   * owner that asked stopped without a report and the main waited for it until the stall check (2.4.1-own.2). With a
   * message the model reads it and goes on.
   */
  function watch(home: string, main: string) {
    const AWAY =
      "The user is away and cannot answer now. Choose what you would recommend, say so in your report, and go on."

    const watched = { stopped: false, asked: [] as Array<Record<string, unknown>> }
    const send = (method: string, route: string, directory: string, body?: unknown) =>
      remoteFetch(state.endpoint, method, route, { directory, ...(body === undefined ? {} : { body }) })
    const data = <T>(answer: { readonly body: unknown }) => (answer.body as { data?: Array<T> } | undefined)?.data ?? []
    const tick = async () => {
      const areas = (await team.call("team.get", { directory: home })).areas
      const roots = [
        { id: main, directory: home },
        ...areas.flatMap((area) =>
          area.owner.sessionID ? [{ id: area.owner.sessionID, directory: area.directory }] : [],
        ),
      ]
      const children = await Promise.all(
        roots.map(async (root) =>
          data<{ id: string }>(await send("GET", `/api/session?parentID=${root.id}&limit=50`, root.directory)).map(
            (child) => ({ id: child.id, directory: root.directory }),
          ),
        ),
      )
      for (const session of [...roots, ...children.flat()]) {
        const asks = data<{ id: string; action: string; resources: Array<string> }>(
          await send("GET", `/api/session/${session.id}/permission`, session.directory),
        )
        for (const ask of asks) {
          const decision = DESTRUCTIVE.test(ask.resources.join("\n")) ? "reject" : "once"
          await send("POST", `/api/session/${session.id}/permission/${ask.id}/reply`, session.directory, { decision })
          watched.asked.push({
            at: new Date().toISOString(),
            session: session.id,
            action: ask.action,
            resources: ask.resources.slice(0, 3),
            decision,
          })
        }
        for (const form of data<{ id: string }>(
          await send("GET", `/api/session/${session.id}/form`, session.directory),
        )) {
          await send(
            "DELETE",
            `/api/session/${session.id}/form/${form.id}?message=${encodeURIComponent(AWAY)}`,
            session.directory,
          )
          watched.asked.push({ at: new Date().toISOString(), session: session.id, form: form.id })
        }
      }
    }
    void (async () => {
      while (!watched.stopped) {
        await tick().catch((error: unknown) =>
          watched.asked.push({ at: new Date().toISOString(), watchError: String(error).slice(0, 200) }),
        )
        await Bun.sleep(5_000)
      }
    })()
    return { asked: watched.asked, stop: () => void (watched.stopped = true) }
  }

  /** Copies the bugfix fixture (`*.txt`, the extension dropped) to `directory` on the host and commits it. */
  async function upload(directory: string) {
    const files = fs
      .readdirSync(FIXTURE, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".txt"))
      .map((name) => ({
        name: name.replaceAll("\\", "/").slice(0, -".txt".length),
        text: fs.readFileSync(path.join(FIXTURE, name), "utf8"),
      }))
    await write(directory, [
      ...files,
      { name: "package.json", text: '{ "type": "module", "scripts": { "test": "node --test" } }\n' },
    ])
  }

  /** textkit for the team, as the local live team test (own-harness script/live/team.ts) but with `node --test`. */
  async function textkit(home: string) {
    await write(home, [
      { name: "package.json", text: '{ "name": "textkit", "type": "module", "scripts": { "test": "node --test" } }\n' },
      {
        name: "README.md",
        text: "# textkit\n\nSmall text utilities in JavaScript (ES modules), no dependencies. Planned modules:\n\n- `src/csv.js`: CSV parsing and writing (RFC 4180)\n- `src/dates.js`: business-day arithmetic on `YYYY-MM-DD` strings\n- `src/stats.js`: statistics over arrays of numbers\n\nEach module has its tests in `test/<module>.test.js` (node:test). `node --test` runs them all.\n",
      },
      {
        name: "AGENTS.md",
        text: "- JavaScript ES modules, no dependencies.\n- Tests use node:test and node:assert/strict in `test/`. Run `node --test` before you report.\n- Throw `RangeError` for invalid arguments.\n",
      },
      { name: "src/index.js", text: 'export const version = "0.1.0"\n' },
      {
        name: "test/smoke.test.js",
        text: 'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { version } from "../src/index.js"\n\ntest("version", () => assert.equal(version, "0.1.0"))\n',
      },
    ])
  }

  /** Writes the files under `directory` on the host and commits them on `main` with the fixture identity. */
  async function write(directory: string, files: ReadonlyArray<{ readonly name: string; readonly text: string }>) {
    const script = [
      `set -e`,
      `mkdir -p '${directory}' && cd '${directory}'`,
      ...files.map(
        (file) =>
          `mkdir -p "$(dirname -- '${file.name}')" && printf '%s' '${Buffer.from(file.text).toString("base64")}' | base64 -d > '${file.name}'`,
      ),
      `git init -q -b main && git -c user.name=fixture -c user.email=fixture@example.test add -A`,
      `git -c user.name=fixture -c user.email=fixture@example.test commit -qm fixture && echo DONE=1`,
    ].join("\n")
    const made = await hostSh(script)
    if (kv(made.stdout).get("DONE") !== "1") throw new Error(`fixture in ${directory} failed: ${made.stderr}`)
  }
})

const HINT =
  "textkit gets three independent modules, one area each: csv (src/csv.js with test/csv.test.js), dates " +
  "(src/dates.js with test/dates.test.js) and stats (src/stats.js with test/stats.test.js). The main folder only " +
  "integrates. `node --test` checks everything."

/**
 * Round 1. RH-15 / RH-20: the area `fresh` names (pinned to another harness than the default) gets its request with
 * `fresh: true`, so its owner continues in a new conversation first; the user says so, the model does not choose it.
 */
function round1(fresh: string) {
  return [
    ...ROUND_1,
    `Send the request for the area "${fresh}" with fresh: true (tools.team.dispatch with fresh: true), so that its owner`,
    "starts it in a new conversation; send the other areas their requests without fresh.",
  ].join("\n")
}

const ROUND_1 = [
  "You lead this team. Build the three modules README.md plans, one per area (csv, dates, stats); read README.md and",
  "call tools.team.status inside `execute` to see the areas.",
  "Send each area one request with tools.team.dispatch. Each request must say:",
  "- what to build: csv → parseCsv(text) returning string[][] (RFC 4180: quoted fields, doubled quotes, CRLF, no",
  "  trailing empty row); dates → addBusinessDays(iso, n) on YYYY-MM-DD strings, weekends skipped, RangeError for a",
  "  negative or fractional n; stats → mean, median and mode of a number array, RangeError on an empty array",
  "- that the owner hands part of the work (for example the tests) to a sub-agent and checks what comes back",
  "- to run `node --test`, commit on the area's branch, and report `ready` with tools.team.report",
  "Do not write the modules yourself and do not integrate yet. After dispatching, wait for the reports.",
]

const ROUND_2 = [
  "Second round. Send each area one more request with tools.team.dispatch:",
  "- csv: stringifyCsv(rows), the inverse of parseCsv, with round-trip tests",
  "- dates: businessDaysBetween(a, b), RangeError when b is before a",
  "- stats: percentile(xs, p) with linear interpolation, RangeError for an empty array or p outside 0..100",
  "Same rules as before: part of the work to a sub-agent, `node --test`, commit, report `ready`.",
  "When every area reported ready, integrate each area into the target with tools.team.integrate, then tell me what",
  "went in and whether the checks passed.",
].join("\n")

/** This PC's compat account `which` (fake key) on the forwarded port; added once per local OWN_HOME, updated after. */
async function compat(stack: Stack, which: Live, port: number): Promise<Ref> {
  const account = ACCOUNTS[which]
  const baseURL = `http://127.0.0.1:${port}/${account.route}`
  if (which === "standin" && STANDIN_LOCAL) return localModel(stack, baseURL)
  const listed = (await stack.local("own.accounts", "accounts.list")).accounts as Array<Record<string, unknown>>
  const existing = listed.find(
    (item) => item.kind === "compat" && item.label === account.label && item.status !== "retired",
  )
  const models = [{ id: account.model, contextLimit: account.context }]
  if (existing) {
    await stack.local("own.accounts", "accounts.update", {
      accountID: existing.id,
      replaceKey: account.key,
      options: { baseURL, models },
    })
    return { providerID: String(existing.providerID), id: account.model }
  }
  const added = await stack.local("own.accounts", "accounts.add.key", {
    kind: "compat",
    label: account.label,
    key: account.key,
    options: { baseURL, models },
  })
  return { providerID: String((added.account as Record<string, unknown>).providerID), id: account.model }
}

/** The local stand-in as the app's local model form adds it: `options.local`, no key, the forwarder on this PC. */
async function localModel(stack: Stack, baseURL: string): Promise<Ref> {
  const account = ACCOUNTS.standin
  const label = `${account.label} (로컬 모델)`
  const models = [{ id: account.model, contextLimit: account.context }]
  const listed = (await stack.local("own.accounts", "accounts.list")).accounts as Array<Record<string, unknown>>
  const existing = listed.find((item) => item.kind === "compat" && item.label === label && item.status !== "retired")
  if (existing) {
    await stack.local("own.accounts", "accounts.update", { accountID: existing.id, options: { baseURL, models } })
    return { providerID: String(existing.providerID), id: account.model }
  }
  const added = await stack.local("own.accounts", "accounts.add.key", {
    kind: "compat",
    label,
    options: { baseURL, local: { format: "chat" }, models },
  })
  return { providerID: String((added.account as Record<string, unknown>).providerID), id: account.model }
}

function evidenceDir() {
  const dir = path.join(process.env.TEMP ?? "/tmp", "own-real-host", "evidence")
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
