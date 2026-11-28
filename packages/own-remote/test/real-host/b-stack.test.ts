// Real-host phase B (04 §20.3 RG1, RG4 with the real broker, RG6, RG7 (b) local half, RG9, RG10, RG17 in the three
// project states of 04 §5.6, RG20 served Codex rows on the host, 10 §6.14): this PC's release service with own-accounts (local) and own-remote (see stack.ts), the
// phase A host and its running service.
// Fake providers only; the remote service's https egress goes to this PC's sink. Opt-in: OWN_REAL_HOST=dev-host.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import * as Env from "./env.js"
import * as Stack from "./stack.js"
import { phase } from "./isolate.js"

const GRACE_SECONDS = 45
const CLIENT = "real-host-b"

type Json = Record<string, any>

const isModelCall = (request: { path: string }) => request.path.startsWith("/v1/chat/completions")

/** RG17's scripted reads by session key: the tool call a session's first model request is answered with. */
const rg17Reads = new Map<string, { calls: number; name: string; input: Record<string, unknown> }>()
/**
 * The fake provider's script for RG17: a request that names a key and offers the key's tool gets that tool call once,
 * later requests of the key a text. Every other request of the phase falls through to the fake's own answers.
 */
const rg17Responder = (request: { readonly body: string }) => {
  const key = [...rg17Reads.keys()].find((candidate) => request.body.includes(candidate))
  if (key === undefined) return undefined
  const plan = rg17Reads.get(key)!
  // A request without the tool (a title, a summary) is not the session's turn.
  if (!request.body.includes(`"name":"${plan.name}"`)) return undefined
  plan.calls += 1
  if (plan.calls === 1) return { type: "tool-call" as const, name: plan.name, input: plan.input }
  return { type: "text" as const, text: `rg17 answer ${plan.calls}` }
}
const bodyText = (request: { body: string }) => request.body

phase("b-stack", `real host ${Env.ALIAS}: full stack (phase B)`, () => {
  const state = {} as {
    stack: Stack.Stack
    uid: string
    project: string
    resolved: Json
    direct: ReturnType<typeof Env.forwardProcess> | undefined
    alpha: Json
    bravo: Json
    linkedAccount: Json
    sessionID: string
    outputs: string[]
    linkedHash: string
    linkedMtime: number
  }
  state.outputs = []

  const host = async () => {
    const listed = await state.stack.local("own.remote", "hosts.list")
    return (listed.hosts as Json[]).find((item) => item.id === state.stack.hostId)!
  }
  const connect = async () => {
    await state.stack.local("own.remote", "connect", { hostId: state.stack.hostId, clientId: CLIENT })
    return Stack.until(async () => {
      const view = await host()
      return view.stage === "ready" || view.paused ? view : undefined
    }, 240_000, 500)
  }
  const resolve = async () => {
    state.resolved = await state.stack.local("own.remote", "resolve", { hostId: state.stack.hostId })
    return state.resolved
  }
  /** Remote API through the tunnel, or `direct` through this suite's own `-L` (works while own-remote is disconnected). */
  const remote = async (method: string, route: string, options: { body?: unknown; directory?: string; via?: "tunnel" | "direct" } = {}) => {
    const client = Stack.remoteClient({ url: state.resolved.url, token: state.resolved.token, direct: directURL })
    const result = await client(method, route, { directory: state.project, ...options })
    state.outputs.push(JSON.stringify(result.body ?? null))
    return result
  }
  let directURL = ""
  const remoteRpc = (method: string, input: unknown, directory = state.resolved.controlDir, via?: "tunnel" | "direct") =>
    remote("POST", `/api/rpc/${OwnAccounts.ID}/${method}`, { body: { input }, directory, ...(via ? { via } : {}) })
  const prompt = async (sessionID: string, text: string, via: "tunnel" | "direct" = "tunnel", directory = state.project) => {
    const admitted = await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text }, via, directory })
    if (admitted.status !== 200) throw new Error(`prompt: ${admitted.status} ${JSON.stringify(admitted.body)}`)
  }
  const waitIdle = (sessionID: string, via: "tunnel" | "direct" = "tunnel", directory = state.project) =>
    remote("POST", `/api/experimental/session/${sessionID}/wait`, { via, directory })
  /** drain now (stop), then wait until the operation released the host and the service is gone. */
  const drain = async () => {
    const plan = await state.stack.local("own.remote", "drain.plan", { hostId: state.stack.hostId, action: "stop" })
    await state.stack.local("own.remote", "drain.execute", { nonce: plan.nonce, mode: "now" })
    await Stack.until(async () => {
      const view = await host()
      return view.stage === "disconnected" && view.paused ? view : undefined
    }, 120_000, 1_000)
    // The tunnel closes before the remote stop step runs: wait until the operation released the host (a plan has no
    // side effects), then check the service is really gone on the host.
    await Stack.until(
      async () =>
        (await state.stack.localRaw("own.remote", "drain.plan", { hostId: state.stack.hostId, action: "stop" }))
          .status === 200,
      120_000,
      1_000,
    )
    const check =
      await Env.hostSh(String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$XDG_STATE_HOME/opencode/service-own.json" 2>/dev/null | head -n 1)
[ -n "$pid" ] && [ -d "/proc/$pid" ] && echo RUNNING=1 || echo RUNNING=0`)
    expect(Env.kv(check.stdout).get("RUNNING")).toBe("0")
  }

  beforeAll(async () => {
    state.stack = await Stack.startStack({ responder: rg17Responder })
    state.uid = Env.kv((await Env.hostSh("echo UID=$(id -u)")).stdout).get("UID")!
    state.project = `${Env.hostRun().root}/tmp/rh-project`
    const made = await Env.hostSh(String.raw`set -u
umask 077; mkdir -p "${state.project}" && printf '# real-host project\n\nremote project of the own real-host suite\n' > "${state.project}/README.md"
echo "FORWARD=$(ss -Htln | awk '{print $4}' | grep -cE '^127.0.0.1:(${(await Env.ports()).provider}|${(await Env.ports()).sink})$')"`)
    expect(made.code).toBe(0)
    // The helper -R forwards come up within a few seconds.
    await Stack.until(async () => {
      const check = await Env.hostSh(`ss -Htln | awk '{print $4}' | grep -cE '^127.0.0.1:(${(await Env.ports()).provider}|${(await Env.ports()).sink})$'`)
      return check.stdout.trim() === "2"
    }, 60_000, 1_000)
    const file = state.stack.linked.authPath
    state.linkedHash = createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    state.linkedMtime = fs.statSync(file).mtimeMs
  }, 400_000)

  afterAll(async () => {
    Env.evidence("b-sink.txt", state.stack?.sink.lines.join("\n") ?? "")
    Env.evidence(
      "b-provider-requests.json",
      (state.stack?.chat.requests ?? []).map((request) => ({
        at: request.at,
        path: request.path,
        status: request.status,
        identity: request.identity,
        auth: request.headers.authorization ?? null,
        cache: request.cache,
      })),
    )
    state.direct?.stop()
    if (state.stack) {
      await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId }).catch(() => {})
      fs.writeFileSync(path.join(Env.EVIDENCE, "b-local-server.log"), state.stack.server.logs())
      await state.stack.stop()
    }
  }, 120_000)

  test("the release service runs own-accounts (local) and own-remote; the phase A host is listed paused", async () => {
    const health = await state.stack.local(OwnAccounts.ID, "health")
    expect(health).toMatchObject({ guard: "ok", mode: "local" })
    const view = await host()
    expect(view).toMatchObject({ alias: Env.ALIAS, paused: true })
  }, 120_000)

  test("accounts exist on this PC only: two fake compat keys, one linked Codex login (fake, 6 minutes left)", async () => {
    state.alpha = await Stack.ensureCompat(state.stack, "Alpha")
    state.bravo = await Stack.ensureCompat(state.stack, "Bravo")
    const plan = await state.stack.local(OwnAccounts.ID, "accounts.import.codex.plan", { profileID: "07", mode: "linked" })
    const imported = await state.stack.local(OwnAccounts.ID, "accounts.import.codex.execute", { nonce: plan.nonce, label: "Linked" })
    state.linkedAccount = imported.account
    expect(imported.mode).toBe("linked")
    await state.stack.local("own.remote", "hosts.update", { hostId: state.stack.hostId, failClosedGraceSeconds: GRACE_SECONDS })
  }, 120_000)

  test("connect: real broker over the -R stream socket in normal mode; the remote mirrors the registry; clock skew measured", async () => {
    const view = await connect()
    expect(view.stage).toBe("ready")
    await resolve()
    let last: unknown
    const remoteHealth = await Stack.until(async () => {
      const result = await remoteRpc("health", {})
      last = result
      const output = result.body?.output as Json | undefined
      return output?.broker?.state === "connected" && output.mirror?.revision !== null ? output : undefined
    }, 120_000, 1_000).catch((error: unknown) => {
      throw new Error(`${String(error)}; last: ${JSON.stringify(last)}`)
    })
    const connected = await Stack.until(async () => {
      const current = await host()
      return current.broker.state === "connected" && current.broker.clockSkewMs !== null ? current : undefined
    }, 60_000, 1_000)
    // RG5 firewall: every listener of this PC's service and of its ssh.exe children is loopback (no inbound rule, no
    // Windows firewall prompt).
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true }).stdout
    const children = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${state.stack.server.pid}" | Select-Object -ExpandProperty ProcessId`],
      { encoding: "utf8", windowsHide: true },
    ).stdout.split(/\s+/).filter(Boolean)
    const pids = new Set([String(state.stack.server.pid), ...children])
    const listeners = netstat
      .split(/\r?\n/)
      .filter((line) => /LISTENING/.test(line) && pids.has(line.trim().split(/\s+/).at(-1)!))
      .map((line) => line.trim().split(/\s+/)[1]!)
    Env.evidence("b-connect.json", { view: connected, remoteHealth, listeners })
    expect(listeners.length).toBeGreaterThan(0)
    expect(listeners.every((address) => address.startsWith("127."))).toBe(true)
    expect(remoteHealth).toMatchObject({ guard: "ok", mode: "remote" })
    expect(connected.broker).toMatchObject({ state: "connected", mode: "normal" })
    expect(Math.abs(connected.broker.clockSkewMs)).toBeLessThan(5_000)
    // Account changes are refused on the remote (04 §16.5).
    const refused = await remoteRpc("accounts.add.key", { kind: "compat", label: "X", key: "sk-never-stored-remotely-0000000000" })
    expect(refused.body).toMatchObject({ type: "remote_managed" })
  }, 300_000)

  test("RG9: the remote registers the same slots and limits as this PC (limit.input = local ctx_eff)", async () => {
    // The first snapshot of a fresh Location may precede plugin settlement (e2e kit): wait for the slots first.
    await state.stack.server.waitForModels(
      [state.alpha.providerID, state.bravo.providerID].map((providerID) => ({ providerID, id: Stack.MODEL })),
      60_000,
    )
    const localModels = ((await state.stack.server.call("GET", "/api/model")) as Json).data as Json[]
    const remoteModels = await Stack.until(async () => {
      const listed = await remote("GET", "/api/model")
      const data = (listed.body?.data ?? []) as Json[]
      return data.filter((model) => [state.alpha.providerID, state.bravo.providerID].includes(model.providerID)).length === 2
        ? data
        : undefined
    }, 60_000, 1_000)
    const pick = (list: Json[], providerID: string) => list.find((model) => model.providerID === providerID && model.id === Stack.MODEL)
    const pairs = [state.alpha.providerID, state.bravo.providerID, state.linkedAccount.providerID].map((providerID) => ({
      providerID,
      local: pick(localModels, providerID) ?? localModels.find((model) => model.providerID === providerID),
      remote: pick(remoteModels, providerID) ?? remoteModels.find((model) => model.providerID === providerID),
    }))
    Env.evidence("rg9-models.json", pairs.map((pair) => ({ providerID: pair.providerID, local: pair.local?.limit, remote: pair.remote?.limit, localId: pair.local?.id, remoteId: pair.remote?.id })))
    for (const pair of pairs) {
      expect(pair.remote).toBeDefined()
      expect(pair.remote!.limit).toEqual(pair.local!.limit)
    }
  }, 120_000)

  test("a remote session uses Alpha through a lease: the fake provider (behind -R) saw Alpha's credential", async () => {
    state.stack.chat.reset()
    const created = await remote("POST", "/api/session", {
      body: { title: "real host", model: { providerID: state.alpha.providerID, id: Stack.MODEL }, location: { directory: state.project } },
    })
    expect(created.status).toBe(200)
    state.sessionID = created.body.data.id
    state.stack.chat.enqueue({ type: "text", text: "answer from the fake provider, via the real host" })
    await prompt(state.sessionID, "RG9-R-1 first question on the real host")
    await waitIdle(state.sessionID)
    const calls = await state.stack.chat.waitForRequests(1, { filter: isModelCall, timeoutMs: 60_000 })
    expect(calls.every((call) => call.identity === "alpha")).toBe(true)
    const messages = await remote("GET", `/api/session/${state.sessionID}/message`)
    expect(JSON.stringify(messages.body.data)).toContain("answer from the fake provider, via the real host")
    const steps = await Stack.until(async () => {
      const result = await state.stack.local(OwnAccounts.ID, "ledger.session", { sessionID: state.sessionID, server: state.stack.hostId })
      return (result.steps as Json[]).some((line) => line.kind === "primary") ? result.steps : undefined
    }, 60_000, 1_000)
    Env.evidence("b-ledger.json", steps)
    expect((steps as Json[]).every((line) => line.server === state.stack.hostId)).toBe(true)
  }, 180_000)

  test("RG9: cache and request shape are the same for a remote session and a local session of the same account", async () => {
    const turns = ["second question", "third question"]
    for (const [index, text] of turns.entries()) {
      await prompt(state.sessionID, `RG9-R-${index + 2} ${text}`)
      await waitIdle(state.sessionID)
    }
    const local = await state.stack.server.createSession({ title: "local twin", model: { providerID: state.alpha.providerID, id: Stack.MODEL } })
    for (const [index, text] of ["first question on this PC", ...turns].entries()) {
      await state.stack.server.prompt(local.id, `RG9-L-${index + 1} ${text}`)
      await state.stack.server.waitIdle(local.id)
    }
    const primary = (marker: string) =>
      state.stack.chat.requests.filter((request) => isModelCall(request) && bodyText(request).includes(marker) && request.status === 200)
    // The primary request of turn N: carries marker N but not N+1; the largest of those (a title request is smaller).
    const series = (prefix: string) =>
      [1, 2, 3].map(
        (turn) =>
          primary(`${prefix}-${turn} `)
            .filter((request) => !bodyText(request).includes(`${prefix}-${turn + 1} `))
            .toSorted((a, b) => (b.cache?.promptTokens ?? 0) - (a.cache?.promptTokens ?? 0))[0]!,
      )
    const remoteSeries = series("RG9-R")
    const localSeries = series("RG9-L")
    const summary = (list: typeof remoteSeries) =>
      list.map((request) => ({ prompt: request.cache?.promptTokens, cached: request.cache?.cachedTokens, identity: request.identity }))
    const strip = (headers: Readonly<Record<string, string>>) =>
      Object.fromEntries(Object.entries(headers).filter(([name]) => !["authorization", "content-length", "host"].includes(name)))
    const headerDiff = (() => {
      const a = strip(remoteSeries[0]!.headers)
      const b = strip(localSeries[0]!.headers)
      const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      return names.filter((name) => a[name] !== b[name]).map((name) => ({ name, remote: a[name] ?? null, local: b[name] ?? null }))
    })()
    Env.evidence("rg9-cache.json", {
      remote: summary(remoteSeries),
      local: summary(localSeries),
      headerNamesRemote: Object.keys(strip(remoteSeries[0]!.headers)).sort(),
      headerNamesLocal: Object.keys(strip(localSeries[0]!.headers)).sort(),
      headerDiff,
    })
    for (const list of [remoteSeries, localSeries])
      for (let turn = 1; turn < list.length; turn++)
        expect(list[turn]!.cache!.cachedTokens).toBeGreaterThanOrEqual(Math.floor(0.9 * list[turn - 1]!.cache!.promptTokens))
    expect(Object.keys(strip(remoteSeries[0]!.headers)).sort()).toEqual(Object.keys(strip(localSeries[0]!.headers)).sort())
  }, 300_000)

  test("RG21 (곁질문, 02 §9.7): a side question in the host conversation is answered on the host while its turn runs, reads the conversation's prefix and never enters it", async () => {
    // The main turn's answer waits 15 s at the fake provider; the side request gets the fake's own answer at once.
    state.stack.chat.enqueue({ type: "text", text: "RG21 slow main answer", delayMs: 15_000 })
    await prompt(state.sessionID, "RG21-main a slow fourth question")
    // The count is of the filtered requests: the main turn's first request has reached the fake.
    await state.stack.chat.waitForRequests(1, {
      filter: (request) => isModelCall(request) && bodyText(request).includes("RG21-main"),
      timeoutMs: 60_000,
    })
    const startedAt = Date.now()
    const asked = await remoteRpc("side.ask", { sessionID: state.sessionID, question: "RG21-side which project is this?" }, state.project)
    expect(asked.status).toBe(200)
    const threadID = asked.body.output.thread.id as string
    const turn = await Stack.until(async () => {
      const got = await remoteRpc("side.get", { sessionID: state.sessionID, threadID }, state.project)
      const last = (got.body.output.thread.turns as Json[]).at(-1)!
      return last.status === "running" ? undefined : last
    }, 60_000, 250)
    const sideSeconds = (Date.now() - startedAt) / 1000
    const messagesDuring = await remote("GET", `/api/session/${state.sessionID}/message`)
    const mainDone = JSON.stringify(messagesDuring.body.data).includes("RG21 slow main answer")
    await waitIdle(state.sessionID)
    const messages = JSON.stringify((await remote("GET", `/api/session/${state.sessionID}/message`)).body.data)
    const side = state.stack.chat.requests.filter((request) => isModelCall(request) && bodyText(request).includes("RG21-side"))
    const largest = (marker: string, not: string) =>
      state.stack.chat.requests
        .filter((request) => isModelCall(request) && bodyText(request).includes(marker) && !bodyText(request).includes(not))
        .toSorted((a, b) => (b.cache?.promptTokens ?? 0) - (a.cache?.promptTokens ?? 0))[0]
    // The main turn's own request (still waiting for its answer) and the last finished turn's: the side request repeats
    // the prefix of both; the finished one is surely in the fake's cache.
    const main = largest("RG21-main", "RG21-side")
    const previous = largest("RG9-R-3", "RG21")
    const ledger = await Stack.until(async () => {
      const result = await state.stack.local(OwnAccounts.ID, "ledger.session", { sessionID: state.sessionID, server: state.stack.hostId })
      return (result.steps as Json[]).some((line) => line.kind === "side") ? result : undefined
    }, 60_000, 1_000)
    Env.evidence("rg21-side.json", {
      sideSeconds,
      mainDoneWhenSideEnded: mainDone,
      turn: { status: turn.status, finish: turn.finish, tokens: turn.tokens, answer: String(turn.answer).slice(0, 200) },
      sideRequests: side.map((request) => ({ identity: request.identity, cache: request.cache })),
      mainRequest: main?.cache,
      previousPrimary: previous?.cache,
      ledgerSide: (ledger.steps as Json[]).filter((line) => line.kind === "side"),
      totalsSide: ledger.totals.side ?? null,
    })
    expect(turn.status).toBe("done")
    // Answered while the main turn still waited for its answer.
    expect(mainDone).toBe(false)
    expect(side).toHaveLength(1)
    expect(side[0]!.identity).toBe("alpha")
    expect(bodyText(side[0]!)).toContain("<side-question>")
    expect(side[0]!.cache!.cachedTokens).toBeGreaterThanOrEqual(Math.floor(0.9 * previous!.cache!.promptTokens))
    // Nothing of the side question reached the conversation; its usage reached this PC's ledger as a side line.
    expect(messages).toContain("RG21 slow main answer")
    expect(messages).not.toContain("RG21-side")
    expect(messages).not.toContain("<side-question>")
    expect(ledger.totals.side.requests).toBe(1)
  }, 240_000)

  test("RG20 (10 §6.14): the PC's served Codex rows reach the host, whose codex harness runs a model from them", async () => {
    // A served row for the fake model, as this PC's own-accounts keeps it after a Codex model list fetch: written the
    // way the fetch writes it (temp → rename), so the PC's store watcher takes it and the broker announces the view.
    const marker = `OWN-RG20-SERVED-ROW-${Date.now()}`
    const row = {
      slug: Stack.MODEL,
      description: "real-host served row",
      visibility: "list",
      priority: 1,
      tool_mode: null,
      use_responses_lite: false,
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "bytes", limit: 10_000 },
      default_reasoning_summary: "none",
      model_messages: { instructions_template: `You are Codex, run from the PC's served row. ${marker}` },
    }
    const file = path.join(Env.OWN_HOME, "codex-meta.json")
    const stored = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Json) : { version: 1, kinds: {} }
    const snapshot = { source: "backend", fetchedAt: Date.now(), rows: 5, models: [], harness: [row] }
    fs.writeFileSync(`${file}.rg20`, JSON.stringify({ ...stored, kinds: { ...stored.kinds, codex: snapshot } }))
    fs.renameSync(`${file}.rg20`, file)
    // The host's own-accounts holds the row in its own codex-meta.json; it fetched no model list (no Codex egress).
    const held = await Stack.until(
      async () => {
        const read = await Env.hostSh(
          String.raw`grep -c '${marker}' "$XDG_DATA_HOME/own-open-code/codex-meta.json" 2>/dev/null || echo 0`,
        )
        return Number(read.stdout.trim()) > 0 ? read.stdout.trim() : undefined
      },
      90_000,
      1_000,
    )
    expect(Number(held)).toBeGreaterThan(0)
    // A host session on the codex harness: its request carries the row's instructions.
    const created = await remote("POST", "/api/session", {
      body: {
        title: "rg20 served row",
        model: { providerID: state.alpha.providerID, id: Stack.MODEL },
        location: { directory: state.project },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value("codex") },
      },
    })
    expect(created.status).toBe(200)
    const before = state.stack.chat.requests.length
    state.stack.chat.enqueue({ type: "text", text: "rg20 answer" })
    await prompt(created.body.data.id, "RG20 a question on the host")
    await waitIdle(created.body.data.id)
    const mine = state.stack.chat.requests.slice(before).filter((request) => isModelCall(request) && bodyText(request).includes("RG20 a question"))
    Env.evidence("rg20-served-row.json", {
      held: Number(held),
      requests: mine.length,
      instructions: mine.map((request) => bodyText(request).includes(marker)),
      sink: state.stack.sink.lines.filter((line) => /chatgpt|openai/i.test(line)),
    })
    expect(mine.length).toBeGreaterThan(0)
    expect(bodyText(mine[0]!)).toContain(marker)
    expect(state.stack.sink.lines.filter((line) => /chatgpt|openai/i.test(line))).toEqual([])
  }, 240_000)

  test("RG6: disconnect → the lease runs out → fail closed (no request leaves the host) → the turn stops after the grace", async () => {
    // This suite's own -L to the remote service (like a TUI on the host) works while own-remote's tunnel is down.
    const view = await host()
    const localPort = await Env.freeLocalPort(40_000, 49_999)
    const remotePort = await remoteServicePort()
    state.direct = Env.forwardProcess(["-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`])
    directURL = `http://127.0.0.1:${localPort}`
    await Stack.until(async () => (await fetch(`${directURL}/api/info`, { headers: { authorization: `Basic ${btoa(`opencode:${state.resolved.token}`)}` } }).catch(() => undefined))?.ok, 30_000, 500)
    expect(view.stage).toBe("ready")
    await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId })
    await Stack.until(async () => (await host()).broker.state !== "connected", 30_000, 250)
    await Bun.sleep(Stack.LEASE_MS + 1_000)
    const before = state.stack.chat.requests.filter(isModelCall).length
    const sinkBefore = state.stack.sink.lines.length
    const started = Date.now()
    await prompt(state.sessionID, "RG6 a question while the PC is unreachable", "direct")
    await waitIdle(state.sessionID, "direct")
    const took = Date.now() - started
    const messages = await remote("GET", `/api/session/${state.sessionID}/message`, { via: "direct" })
    Env.evidence("rg6-fail-closed.json", {
      tookMs: took,
      graceSeconds: GRACE_SECONDS,
      providerRequestsDuring: state.stack.chat.requests.filter(isModelCall).length - before,
      sinkLinesDuring: state.stack.sink.lines.slice(sinkBefore),
      last: messages.body.data[0],
    })
    expect(took).toBeLessThan((GRACE_SECONDS + 25) * 1000)
    expect(took).toBeGreaterThanOrEqual((GRACE_SECONDS - 10) * 1000)
    expect(state.stack.chat.requests.filter(isModelCall).length).toBe(before)
    expect(state.stack.sink.lines.length).toBe(sinkBefore)
    expect(messages.body.data[0]).toMatchObject({ type: "idle", outcome: "failed" })
  }, 240_000)

  test("RG6: a turn waiting within the grace resumes on reconnect and carries the leased key; no duplicate request", async () => {
    const before = state.stack.chat.requests.filter(isModelCall).length
    state.stack.chat.enqueue({ type: "text", text: "resumed after the reconnect on the real host" })
    await prompt(state.sessionID, "RG6 continue once the PC is back", "direct")
    await Bun.sleep(Stack.BROKER_WAIT_MS + 3_000)
    expect(state.stack.chat.requests.filter(isModelCall)).toHaveLength(before)
    const ready = await connect()
    expect(ready.stage).toBe("ready")
    await waitIdle(state.sessionID, "direct")
    const calls = state.stack.chat.requests.filter(isModelCall).slice(before)
    const messages = await remote("GET", `/api/session/${state.sessionID}/message`, { via: "direct" })
    Env.evidence("rg6-resume.json", { calls: calls.map((call) => ({ status: call.status, identity: call.identity })), last: messages.body.data[0] })
    expect(calls.filter((call) => bodyText(call).includes("RG6 continue once the PC is back"))).toHaveLength(1)
    expect(calls.at(-1)!.identity).toBe("alpha")
    expect(JSON.stringify(messages.body.data)).toContain("resumed after the reconnect on the real host")
    expect((await host()).broker.state).toBe("connected")
    await resolve()
  }, 300_000)

  test("RG4 (real broker): a drop without FIN → new epoch; the old session's SIGHUP later leaves the new broker stream connected", async () => {
    const old = await host()
    const frozen = await Env.freezeKeep()
    Env.evidence("rg4-freeze-real-broker.txt", frozen.stdout)
    const sshd = Env.kv(frozen.stdout).get("SSHD")!
    expect(Env.kv(frozen.stdout).get("STOPPED")).toBe("1")
    const started = Date.now()
    try {
      const next = await Stack.until(async () => {
        const current = await host()
        return current.stage === "ready" && current.epoch > old.epoch && current.broker.state === "connected" ? current : undefined
      }, 240_000, 1_000)
      const recoveredMs = Date.now() - started
      await Stack.until(
        async () => {
          const check = await Env.hostSh(`ps --ppid ${sshd} -o args= | grep -c '^sh -s' || true`)
          return check.stdout.trim() === "0"
        },
        60_000,
        2_000,
      )
      const hup = await Env.hostSh(String.raw`rh_session -CONT ${sshd}; rh_session -HUP ${sshd}; sleep 2
[ -d /proc/${sshd} ] && echo OLD_ALIVE=1 || echo OLD_ALIVE=0
echo "NEW_SOCK=$(stat -c '%F' "$XDG_DATA_HOME/own-open-code/run/broker-${next.epoch}.sock" 2>&1)"`)
      await Bun.sleep(10_000)
      await resolve()
      const remoteHealth = (await remoteRpc("health", {})).body?.output
      const after = await host()
      Env.evidence("rg4-drop-real-broker.json", { old: old.epoch, next: next.epoch, recoveredMs, hup: hup.stdout, remoteBroker: remoteHealth?.broker, localBroker: after.broker })
      expect(Env.kv(hup.stdout).get("OLD_ALIVE")).toBe("0")
      expect(Env.kv(hup.stdout).get("NEW_SOCK")).toBe("socket")
      expect(after.broker.state).toBe("connected")
      expect(remoteHealth?.broker).toMatchObject({ state: "connected", epoch: next.epoch })
    } finally {
      await Env.hostSh(`rh_session -CONT ${sshd} 2>/dev/null; rh_session -HUP ${sshd} 2>/dev/null; true`)
    }
  }, 420_000)

  test("RG10: no fake key or token on the remote disk, service env/argv, ps, logs; the mirror carries no identifiers", async () => {
    const tokens = JSON.parse(fs.readFileSync(state.stack.linked.authPath, "utf8")).tokens as Json
    const needles = [Stack.KEYS.Alpha, Stack.KEYS.Bravo, tokens.access_token, tokens.refresh_token, tokens.id_token].filter(Boolean) as string[]
    const quoted = needles.map((value) => `'${value}'`).join(" ")
    const result = await Env.hostSh(String.raw`set -u
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$XDG_STATE_HOME/opencode/service-own.json" | head -n 1)
for needle in ${quoted}; do
  c=$(grep -rlaF -- "$needle" "$XDG_DATA_HOME/own-open-code" "$XDG_CONFIG_HOME/own-open-code" "$XDG_CONFIG_HOME/opencode" \
      "$XDG_STATE_HOME/opencode" "$XDG_DATA_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$OWN_RH_ROOT/tmp" 2>/dev/null | wc -l)
  e=$(tr '\0' '\n' < /proc/$pid/environ | grep -cF -- "$needle")
  a=$(tr '\0' ' ' < /proc/$pid/cmdline | grep -cF -- "$needle")
  p=$(ps -eo args | grep -v grep | grep -cF -- "$needle")
  echo "HITS=$c/$e/$a/$p"
done
echo "MIRROR_FILES=$(ls "$XDG_DATA_HOME/own-open-code" | tr '\n' ' ')"
echo "MIRROR_KEYHINT=$(grep -c 'keyHint' "$XDG_DATA_HOME/own-open-code/accounts.json" 2>/dev/null)"
echo "DB=$(ls -la "$XDG_DATA_HOME/opencode/" | awk 'NR>1{print $NF}' | tr '\n' ' ')"`)
    Env.evidence(
      "rg10-keys.txt",
      result.stdout.replaceAll(/HITS=.*/g, (line) => line),
    )
    const hits = result.stdout.split("\n").filter((line) => line.startsWith("HITS="))
    expect(hits).toHaveLength(needles.length)
    for (const line of hits) expect(line).toBe("HITS=0/0/0/0")
    for (const needle of needles) expect(result.stdout).not.toContain(needle)
    expect(Env.kv(result.stdout).get("MIRROR_KEYHINT")).toBe("0")
    for (const output of state.outputs) for (const needle of needles) expect(output).not.toContain(needle)
  }, 120_000)

  test("RG7 (b), local half: the linked login is mirrored as a slot, never refreshed, its source untouched; no Codex egress", async () => {
    const view = await host()
    const refreshes = state.stack.codex.refreshCount(Stack.LINKED.accountID)
    const file = state.stack.linked.authPath
    Env.evidence("rg7-linked.json", {
      sourceStale: view.broker.sourceStale,
      refreshes,
      codexRequests: state.stack.codex.requests.map((request) => request.path),
      sameHash: createHash("sha256").update(fs.readFileSync(file)).digest("hex") === state.linkedHash,
      sameMtime: fs.statSync(file).mtimeMs === state.linkedMtime,
      sink: state.stack.sink.lines,
    })
    expect(refreshes).toBe(0)
    expect(state.stack.codex.requests.filter((request) => request.path.includes("/oauth/token"))).toEqual([])
    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(state.linkedHash)
    expect(fs.statSync(file).mtimeMs).toBe(state.linkedMtime)
    expect(state.stack.sink.lines.filter((line) => /chatgpt|openai/i.test(line))).toEqual([])
  }, 60_000)

  // RG17 (04 §20.3) in the three project states of a host (04 §5.6). Each test builds its own repository under
  // `<run root>/tmp/rh-rg17` and removes it; the two that change the state restore the host to `instructions`, the
  // default it was added with, by another drain and restart.
  const rg17Dir = () => `${Env.hostRun().root}/tmp/rh-rg17`
  /**
   * The repository: AGENTS.md at its root and in `sub/`, a project skill, a project config naming one more instruction
   * file, and a plugin that records that it loaded and what it saw of every model request.
   */
  const rg17Repository = async () => {
    const dir = rg17Dir()
    const made = await Env.hostSh(String.raw`set -u
umask 077; rm -rf "${dir}"; mkdir -p "${dir}/.opencode/plugins" "${dir}/.opencode/skills/rg17-skill" "${dir}/sub"
printf 'OWN-RG17-AGENTS-MARKER: follow the project rules.\n' > "${dir}/AGENTS.md"
printf 'OWN-RG17-SUB-AGENTS-MARKER: rules of the sub folder.\n' > "${dir}/sub/AGENTS.md"
printf 'OWN-RG17-NOTE-CONTENT\n' > "${dir}/sub/note.txt"
printf 'OWN-RG17-CONFIG-INSTRUCTIONS-MARKER\n' > "${dir}/RG17-EXTRA.md"
printf '{ "instructions": ["RG17-EXTRA.md"] }\n' > "${dir}/opencode.json"
printf -- '---\nname: rg17-skill\ndescription: OWN-RG17-SKILL-MARKER skill\n---\n\nOWN-RG17-SKILL-BODY\n' > "${dir}/.opencode/skills/rg17-skill/SKILL.md"
cat > "${dir}/.opencode/plugins/probe.ts" <<'PLUGIN'
import fs from "node:fs"
const log = (entry: unknown) => fs.appendFileSync("${dir}/probe.log", JSON.stringify(entry) + "\n")
export default {
  id: "rg17-probe",
  setup: async (ctx: any) => {
    log({ event: "loaded", location: ctx.location?.directory, globals: Object.getOwnPropertySymbols(globalThis).map(String).filter((name) => /own/i.test(name)) })
    await ctx.session.hook("http.request", async (event: any) => {
      const body = await event.request.clone().text().catch(() => "")
      log({ event: "http.request", url: String(event.request.url).replace(/\?.*/, ""), headers: [...event.request.headers.keys()], auth: event.request.headers.has("authorization"), agents: body.includes("OWN-RG17-AGENTS-MARKER") })
    })
  },
}
PLUGIN
echo OK=1`)
    expect(Env.kv(made.stdout).get("OK")).toBe("1")
    return dir
  }
  const rg17Remove = () => Env.hostSh(`rm -rf "${rg17Dir()}"; echo OK=1`)
  /** The two project variables of the running remote service, from its `/proc/<pid>/environ`: `[DISABLE, INSTRUCTIONS]`. */
  const rg17ServiceEnv = async () => {
    const env =
      await Env.hostSh(String.raw`pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$XDG_STATE_HOME/opencode/service-own.json" | head -n 1)
echo "PROJECT_DISABLE=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^OPENCODE_CONFIG_PROJECT_DISABLE=//p')"
echo "PROJECT_INSTRUCTIONS=$(tr '\0' '\n' < /proc/$pid/environ | sed -n 's/^OPENCODE_CONFIG_PROJECT_INSTRUCTIONS=//p')"`)
    const facts = Env.kv(env.stdout)
    return [facts.get("PROJECT_DISABLE") ?? "", facts.get("PROJECT_INSTRUCTIONS") ?? ""]
  }
  /**
   * One session of `harness` in the repository on Alpha: a prompt whose first model request is answered with a read of
   * `sub/note.txt` (the responder given to the stack), then a second prompt. Returns what the provider and the host saw.
   */
  const rg17Session = async (harness: OwnHarness.HarnessID, tag: string) => {
    const dir = rg17Dir()
    const key = `RG17KEY-${tag}-${harness}-x`
    rg17Reads.set(key, {
      calls: 0,
      name: "read",
      input: { path: `${dir}/sub/note.txt` },
    })
    const created = await remote("POST", "/api/session", {
      body: {
        title: `rg17 ${tag} ${harness}`,
        model: { providerID: state.alpha.providerID, id: Stack.MODEL },
        location: { directory: dir },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value(harness) },
        permissions: [{ action: "read", resource: "**", effect: "allow" }],
      },
      directory: dir,
    })
    expect(created.status).toBe(200)
    const before = state.stack.chat.requests.length
    const sinkBefore = state.stack.sink.lines.length
    await prompt(created.body.data.id, `${key} first: read the note`, "tunnel", dir)
    await waitIdle(created.body.data.id, "tunnel", dir)
    await prompt(created.body.data.id, `${key} second: anything else`, "tunnel", dir)
    await waitIdle(created.body.data.id, "tunnel", dir)
    const requests = state.stack.chat.requests.slice(before).filter(isModelCall)
    const mine = requests.filter((request) => bodyText(request).includes(key))
    const all = mine.map(bodyText).join("\n")
    return {
      harness,
      requests: requests.map((request) => ({ status: request.status, identity: request.identity, auth: request.headers.authorization ?? null })),
      mine: mine.length,
      readRan: all.includes("OWN-RG17-NOTE-CONTENT"),
      agents: (mine[0] ? bodyText(mine[0]) : "").includes("OWN-RG17-AGENTS-MARKER"),
      subAgents: all.includes("OWN-RG17-SUB-AGENTS-MARKER"),
      skill: all.includes("OWN-RG17-SKILL-MARKER") || all.includes("rg17-skill"),
      configInstructions: all.includes("OWN-RG17-CONFIG-INSTRUCTIONS-MARKER"),
      sink: state.stack.sink.lines.slice(sinkBefore),
    }
  }
  const rg17Probe = async () => {
    const probe = await Env.hostSh(`cat "${rg17Dir()}/probe.log" 2>/dev/null || echo NO_PROBE_LOG`)
    return probe.stdout.trim()
  }
  /** `hosts.update{projectConfig}` → pending → drain → reconnect: the next service runs in `projectConfig`. */
  const rg17Apply = async (projectConfig: "disabled" | "instructions" | "trusted") => {
    const updated = await state.stack.local("own.remote", "hosts.update", { hostId: state.stack.hostId, projectConfig })
    if ((await host()).projectConfig !== projectConfig) throw new Error(`projectConfig is not ${projectConfig}`)
    if (!updated.pendingSettings) return updated
    await drain()
    expect((await connect()).stage).toBe("ready")
    await resolve()
    await Stack.until(async () => {
      const listed = await remote("GET", "/api/model", { directory: rg17Dir() })
      return ((listed.body?.data ?? []) as Json[]).some((model) => model.providerID === state.alpha.providerID)
    }, 60_000, 1_000)
    return updated
  }

  test("RG17 instructions (the default of a new host): the repository's AGENTS.md is read; its plugin, skills and config are not, and nothing of the lease reaches repository code", async () => {
    const dir = await rg17Repository()
    try {
      // The host was added by phase A with the default, and its service started with it: no restart needed.
      expect((await host()).projectConfig).toBe("instructions")
      expect(await rg17ServiceEnv()).toEqual(["1", "1"])
      // core's read (opencode) adds the sub folder's AGENTS.md after the read; pi reads with its own tool.
      const opencode = await rg17Session("opencode", "instructions")
      const pi = await rg17Session("pi", "instructions")
      const probe = await rg17Probe()
      const health = (await remoteRpc("health", {}, dir)).body?.output
      Env.evidence("rg17-instructions.json", { opencode, pi, probe, warnings: health?.warnings })
      expect(probe).toBe("NO_PROBE_LOG")
      for (const run of [opencode, pi]) {
        expect([run.harness, run.mine >= 2, run.readRan]).toEqual([run.harness, true, true])
        // Every request went out on the lease of this PC's account.
        expect(run.requests.every((request) => request.identity === "alpha" && request.status === 200)).toBe(true)
        expect([run.harness, run.agents, run.skill, run.configInstructions]).toEqual([run.harness, true, false, false])
      }
      expect([opencode.subAgents, pi.subAgents]).toEqual([true, false])
      expect(((health?.warnings ?? []) as string[]).filter((warning) => warning.startsWith("untrusted_plugin"))).toEqual([])
    } finally {
      await rg17Remove()
    }
  }, 300_000)

  test("RG17 disabled (applied by drain + restart): nothing of the repository is read, not even a sub folder's AGENTS.md after a read there", async () => {
    const dir = await rg17Repository()
    try {
      const updated = await rg17Apply("disabled")
      expect(updated.pendingSettings).toBe(true)
      expect(await rg17ServiceEnv()).toEqual(["1", ""])
      const opencode = await rg17Session("opencode", "disabled")
      const pi = await rg17Session("pi", "disabled")
      const probe = await rg17Probe()
      const health = (await remoteRpc("health", {}, dir)).body?.output
      Env.evidence("rg17-disabled.json", { opencode, pi, probe, warnings: health?.warnings })
      expect(probe).toBe("NO_PROBE_LOG")
      for (const run of [opencode, pi]) {
        expect([run.harness, run.mine >= 2, run.readRan]).toEqual([run.harness, true, true])
        expect(run.requests.every((request) => request.identity === "alpha" && request.status === 200)).toBe(true)
        expect([run.harness, run.agents, run.subAgents, run.skill, run.configInstructions]).toEqual([run.harness, false, false, false, false])
      }
      expect(((health?.warnings ?? []) as string[]).filter((warning) => warning.startsWith("untrusted_plugin"))).toEqual([])
    } finally {
      await rg17Apply("instructions")
      await rg17Remove()
    }
  }, 600_000)

  test("RG17 trusted (applied by drain + restart), plugin not approved → it loads, but own requests in that Location carry no credential", async () => {
    const dir = await rg17Repository()
    try {
      const updated = await rg17Apply("trusted")
      expect(updated.pendingSettings).toBe(true)
      expect(await rg17ServiceEnv()).toEqual(["", ""])
      const created = await remote("POST", "/api/session", {
        body: { title: "rg17 trusted", model: { providerID: state.alpha.providerID, id: Stack.MODEL }, location: { directory: dir } },
        directory: dir,
      })
      expect(created.status).toBe(200)
      const before = state.stack.chat.requests.length
      const sinkBefore = state.stack.sink.lines.length
      await prompt(created.body.data.id, "RG17-TRUSTED hello", "tunnel", dir)
      await waitIdle(created.body.data.id, "tunnel", dir)
      const requests = state.stack.chat.requests.slice(before).filter(isModelCall)
      const probe = await Env.hostSh(`cat "${dir}/probe.log" 2>/dev/null || echo NO_PROBE_LOG`)
      const health = (await remoteRpc("health", {}, dir)).body?.output
      const entries = probe.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Json)
      Env.evidence("rg17-trusted.json", {
        probe: entries,
        requests: requests.map((request) => ({ status: request.status, identity: request.identity, auth: request.headers.authorization ?? null })),
        agentsMarkerInRequest: requests.some((request) => bodyText(request).includes("OWN-RG17-AGENTS-MARKER")),
        // What the loaded plugin saw of the request it was shown (the call itself goes to the sink).
        agentsSeenByPlugin: entries.filter((entry) => entry.event === "http.request").some((entry) => entry.agents === true),
        warnings: health?.warnings,
        sink: state.stack.sink.lines.slice(sinkBefore),
        turn: ((await remote("GET", `/api/session/${created.body.data.id}/message`, { directory: dir })).body?.data ?? [])
          .slice(0, 2)
          .map((message: Json) => ({ type: message.type, outcome: message.outcome, error: message.error })),
      })
      expect(entries.some((entry) => entry.event === "loaded")).toBe(true)
      // Nothing with a credential reached the provider (the remote gate sends the blocked Location's call to its sink).
      expect(requests.every((request) => request.headers.authorization === undefined && request.identity === undefined)).toBe(true)
      expect(entries.filter((entry) => entry.event === "http.request").every((entry) => entry.auth === false)).toBe(true)
      expect((health?.warnings ?? []) as string[]).toContain(`untrusted_plugin:${dir}`)
    } finally {
      await rg17Apply("instructions")
      await rg17Remove()
    }
  }, 600_000)

  test("RG3: shell mode login-interactive (drain + restart) → agent.probe runs with the .bashrc-only PATH entries", async () => {
    const before = await state.stack.local("own.remote", "diagnostics", { hostId: state.stack.hostId })
    // The shell environments inspect measured (phase A's first contact; a reconnect skips inspect, so this process's
    // diagnostics may not carry them).
    const measured = JSON.parse(fs.readFileSync(path.join(Env.EVIDENCE, "inspect.json"), "utf8")) as Json
    const login = String(measured.env.LOGIN.PATH ?? "").split(":")
    const interactiveOnly = String(measured.env.INTERACTIVE.PATH ?? "")
      .split(":")
      .filter((entry) => entry && !login.includes(entry))
    await state.stack.local("own.remote", "hosts.update", { hostId: state.stack.hostId, shellEnv: "login-interactive" })
    await drain()
    try {
      expect((await connect()).stage).toBe("ready")
      const after = await Stack.until(async () => {
        const current = await state.stack.local("own.remote", "diagnostics", { hostId: state.stack.hostId })
        return current.shellEnv.mode === "login-interactive" && current.probe ? current : undefined
      }, 60_000, 1_000)
      Env.evidence("rg3-shell-modes.json", {
        pathLogin: measured.env.LOGIN.PATH,
        pathInteractive: measured.env.INTERACTIVE.PATH,
        interactiveOnly,
        probeLogin: before.probe,
        probeInteractive: after.probe,
        linger: before.linger,
        killUserProcesses: before.killUserProcesses,
      })
      expect(interactiveOnly.length).toBeGreaterThan(0)
      for (const entry of interactiveOnly) {
        expect(String(after.probe.path)).toContain(entry)
        if (before.probe) expect(String(before.probe.path)).not.toContain(entry)
      }
    } finally {
      await state.stack.local("own.remote", "hosts.update", { hostId: state.stack.hostId, shellEnv: "login" })
      await drain()
      expect((await connect()).stage).toBe("ready")
      await resolve()
    }
  }, 600_000)

  test("RG1: TerminateProcess of the local service → its ssh.exe exits within 60 s; the next start has nothing to clean", async () => {
    const view = await host()
    const netstat = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true }).stdout
    const line = netstat.split(/\r?\n/).find((item) => item.includes(`${view.loopback}:${view.localPort}`) && /LISTENING/.test(item))!
    const sshPid = Number(line.trim().split(/\s+/).at(-1))
    const serverPid = state.stack.server.pid
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(sshPid)).toBe(true)
    const pidFile = path.join(Env.OWN_HOME, "remote", state.stack.hostId, "tunnel.pid")
    expect(fs.existsSync(pidFile)).toBe(true)
    const killed = Date.now()
    spawnSync("taskkill", ["/PID", String(serverPid), "/F"], { windowsHide: true })
    const goneMs = await Stack.until(() => (!alive(sshPid) ? Date.now() - killed : undefined), 60_000, 250)
    // The tunnel's keep part (an "sh -s" with a "cat" child) ended on stdin EOF too.
    const left = await Env.hostSh(String.raw`n=0
for p in $(ps -u "$(id -u)" -o pid=,args= | awk '$2=="sh" && $3=="-s" && NF==3 {print $1}'); do
  [ "$p" = "$$" ] && continue
  ps --ppid "$p" -o comm= | grep -qx cat && n=$((n+1))
done
echo "$n"`)
    await state.stack.restart()
    await Stack.until(async () => (await state.stack.localRaw("own.remote", "hosts.list")).status === 200, 60_000, 500)
    Env.evidence("rg1.json", { serverPid, sshPid, sshGoneMs: goneMs, pidFileAfterRestart: fs.existsSync(pidFile), remoteShellsLeft: left.stdout.trim() })
    expect(goneMs).toBeLessThan(60_000)
    expect(fs.existsSync(pidFile)).toBe(false)
    expect(left.stdout.trim()).toBe("0")
  }, 300_000)

  async function remoteServicePort() {
    const record = JSON.parse(fs.readFileSync(path.join(Env.OWN_HOME, "remote", "hosts.json"), "utf8")) as Json
    return (record.hosts as Json[]).find((item) => item.id === state.stack.hostId)!.remotePort as number
  }
})
