// Real-host phase G (04 §8.14, SLM 2026-11-22): this PC's local models in a conversation on the phase A host, on the
// product path only. The user works over SSH with a `로컬 모델` account whose server listens on this PC's loopback; a
// host conversation on it ended at once with `own_broker_unavailable` (own.15). Phase E never saw that: its accounts
// are `기타 OpenAI 호환` ones with keys whose base URL is the host's own 127.0.0.1, reached through a test-only `ssh -R`.
//
//   host core ─▶ remote own-accounts stub ─▶ egress-<epoch>.sock ─ sshd -R ─▶ ssh.exe ─▶ PC relay 127.0.0.1:E_h
//     ─▶ /local/<accountID>: the account's own server on this PC (a FAKE OpenAI-compatible one on a random test port)
//
// The two accounts are added the way the app's local model form adds them (`accounts.add.key` with `options.local`):
// one without a key (the user's case), one with a FAKE key. The fake server's port is forwarded nowhere: the stack's
// helper ssh carries only the phase B fakes, and the host is checked to have nothing listening on it. Never the user's
// local model server (127.0.0.1:64644): the fake's port is random and refused if it were that one. Opt-in:
// OWN_REAL_HOST=build-host (heavy host only, like D); run after a and before z-cleanup.
//
//   G1  a keyless local model answers `git init` through this PC: the fake sees no credential, the PC's relay carried it
//       (in flight 0 after, no refusal), and the host has nothing on the fake's port
//   G2  the keyed account: the FAKE key is added on this PC, the same prefix is a cache hit on the second turn, and the
//       key is nowhere on the host (files under own's roots, the service's env and argv)
//   G3  a stream of OWN_REAL_HOST_G_LONG_MS (default 4 min) with a delta every 15 s and one 45 s pause (longer than the
//       relay listener's idle timeout) reaches the host whole
//   G4  interrupting a turn mid-stream closes the relayed request within 5 s
//   G5  same-uid requests to the egress socket and the stub without a proof, or with one of another path: all 401 `mac`,
//       nothing reaches the fake server
//   G6  ssh.exe killed mid-stream: the relayed request ends, the step fails with its partial output; a turn during the
//       break never reaches the fake (the sink says `unavailable`); after reconnecting, a turn is answered again
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { OwnAccounts } from "@own/protocol"
import { OwnHarness } from "@own/protocol/rpc-harness"
import { hashSecret, startFakeOpenAIChat, type FakeOpenAIChat } from "../../../own-accounts/test/e2e-kit"
import * as Env from "./env.js"
import * as Stack from "./stack.js"

const run = Env.heavyHost ? describe : describe.skip
const CLIENT = "real-host-g"
const MODEL = "tf-local-real-host"
/** FAKE key of the keyed local model (never a real credential); G2 scans the host for it. */
const KEY = "sk-ownRealHostLocalModelFakeKey00000001"
/** The user's own local model server: never used, and the fake never takes its port. */
const USER_MODEL_PORT = 64644
const LONG_MS = Number(process.env.OWN_REAL_HOST_G_LONG_MS ?? 240_000)
const PAUSE_MS = 45_000

type Json = Record<string, any>

run("real host G: this PC's local models through this PC", () => {
  const state = {} as {
    stack: Stack.Stack
    fake: FakeOpenAIChat
    port: number
    resolved: Json
    project: string
    keyless: { providerID: string; accountID: string }
    keyed: { providerID: string; accountID: string }
    main: string
    outputs: string[]
    directURL?: string
    direct?: ReturnType<typeof Env.forwardProcess>
  }
  state.outputs = []

  const local = (method: string, input: unknown = {}) => state.stack.local(OwnAccounts.ID, method, input)
  const host = async () => {
    const listed = await state.stack.local("own.remote", "hosts.list")
    return (listed.hosts as Json[]).find((item) => item.id === state.stack.hostId)!
  }
  const connect = async () => {
    await state.stack.local("own.remote", "connect", { hostId: state.stack.hostId, clientId: CLIENT })
    const view = await Stack.until(
      async () => {
        const current = await host()
        return current.stage === "ready" || current.paused ? current : undefined
      },
      240_000,
      500,
    )
    state.resolved = await state.stack.local("own.remote", "resolve", { hostId: state.stack.hostId })
    return view
  }
  const remote = async (method: string, route: string, options: { body?: unknown; directory?: string } = {}) => {
    const direct = state.directURL
    const client = Stack.remoteClient({ url: state.resolved.url, token: state.resolved.token, direct })
    const result = await client(method, route, {
      directory: state.project,
      ...(direct ? { via: "direct" as const } : {}),
      ...options,
    })
    state.outputs.push(JSON.stringify(result.body ?? null))
    return result
  }
  /** The app's local model form (`local-model-form.tsx`): a `compat` account with `options.local`, the key optional. */
  const addLocal = async (label: string, key?: string) => {
    const added = await local("accounts.add.key", {
      kind: "compat",
      label,
      ...(key === undefined ? {} : { key }),
      color: "teal",
      options: {
        baseURL: state.fake.baseURL,
        local: { format: "chat" },
        models: [{ id: MODEL, contextLimit: 131_072, outputLimit: 8_192 }],
      },
    })
    return { providerID: String(added.account.providerID), accountID: String(added.account.id) }
  }
  const session = async (title: string, providerID: string) => {
    const created = await remote("POST", "/api/session", {
      body: {
        title,
        model: { providerID, id: MODEL },
        location: { directory: state.project },
        metadata: { [OwnHarness.META_KEY]: OwnHarness.value("opencode") },
      },
    })
    if (created.status !== 200) throw new Error(`session: ${created.status} ${JSON.stringify(created.body)}`)
    return created.body.data.id as string
  }
  const prompt = async (sessionID: string, text: string) => {
    const admitted = await remote("POST", `/api/session/${sessionID}/prompt`, { body: { text } })
    if (admitted.status !== 200) throw new Error(`prompt: ${admitted.status} ${JSON.stringify(admitted.body)}`)
  }
  const waitIdle = async (sessionID: string, timeoutMs = 600_000) => {
    const response = await fetch(
      new URL(`/api/experimental/session/${sessionID}/wait`, state.directURL ?? state.resolved.url),
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`opencode:${state.resolved.token}`)}`,
          "x-opencode-directory": encodeURIComponent(state.project),
        },
        signal: AbortSignal.timeout(timeoutMs),
        timeout: false,
      },
    ).catch(() => undefined)
    if (!response) return false
    await response.text()
    return true
  }
  const messages = async (sessionID: string) =>
    ((await remote("GET", `/api/session/${sessionID}/message`)).body?.data ?? []) as Json[]
  const interrupt = (sessionID: string) => remote("POST", `/api/session/${sessionID}/interrupt`, { body: {} })
  const relay = async () => (await host()).broker.local as { inflight: number; lastError: string | null } | undefined
  const chats = (from: number) => state.fake.requests.slice(from).filter((item) => item.path === "/v1/chat/completions")
  /** The ssh.exe tunnel of the host (a child of this PC's service with -R forwards): its pid and the -R specs. */
  const tunnel = () => {
    const listed = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name='ssh.exe' AND ParentProcessId=${state.stack.server.pid}" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).stdout
    const line = listed
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => / -R /.test(` ${item.split("\t")[1] ?? ""} `))
    if (!line) return undefined
    const [pid, command] = line.split("\t") as [string, string]
    const tokens = command.split(/\s+/)
    const remotes = tokens.flatMap((token, index) =>
      token === "-R" && tokens[index + 1] ? [tokens[index + 1]!.replace(/^"|"$/g, "")] : [],
    )
    return { pid: Number(pid), remotes }
  }
  const egressSocket = () => {
    const spec = tunnel()?.remotes.find((item) => /\/egress-\d+\.sock:/.test(item))
    if (!spec) return undefined
    const socket = spec.slice(0, spec.indexOf(".sock:") + ".sock".length)
    return { socket, epoch: Number(/egress-(\d+)\.sock$/.exec(socket)![1]) }
  }

  beforeAll(async () => {
    state.port = await Env.freeLocalPort(41_000, 47_999)
    if (state.port === USER_MODEL_PORT) throw new Error("the fake must never take the user's local model port")
    state.fake = startFakeOpenAIChat({
      port: state.port,
      models: [MODEL],
      anonymous: true,
      credentials: { [KEY]: { domain: "keyed" } },
    })
    state.stack = await Stack.startStack()
    const uid = (await Env.hostSh("id -u")).stdout.trim()
    state.project = `/tmp/own-${uid}-rh-local`
    const made = await Env.hostSh(
      `set -u; umask 077; rm -rf "${state.project}"; mkdir -p "${state.project}" && printf '# real-host local model project\\n' > "${state.project}/README.md" && echo OK=1`,
    )
    expect(Env.kv(made.stdout).get("OK")).toBe("1")
    state.keyless = await addLocal("내 로컬 모델 (real host)")
    state.keyed = await addLocal("키 있는 로컬 모델 (real host)", KEY)
    const view = await connect()
    expect(view.stage).toBe("ready")
    await Stack.until(
      async () => {
        const models = ((await remote("GET", "/api/model")).body?.data ?? []) as Json[]
        return [state.keyless, state.keyed].every((item) =>
          models.some((model) => model.providerID === item.providerID && model.id === MODEL),
        )
      },
      120_000,
      1_000,
    )
    state.main = await session("local via pc", state.keyless.providerID)
    Env.evidence("g-connect.json", { remotes: tunnel()?.remotes, port: state.port, local: (await host()).broker.local })
  }, 900_000)

  afterAll(async () => {
    Env.evidence(
      "g-fake-requests.json",
      state.fake?.requests.map((item) => ({
        at: item.at,
        path: item.path,
        identity: item.identity,
        status: item.status,
        cache: item.cache,
        authorization: item.headers.authorization === undefined ? null : "<hashed>",
      })) ?? [],
    )
    state.direct?.stop()
    if (state.stack) {
      // The PC service's log: the relay's `local_relay_failed` lines tell an unreachable server from a cancelled request.
      fs.writeFileSync(path.join(Env.EVIDENCE, "g-local-server.log"), state.stack.server.logs())
      await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId }).catch(() => undefined)
      await state.stack.stop()
    }
    if (state.project) await Env.hostSh(`rm -rf "${state.project}"`).catch(() => undefined)
    await state.fake?.stop()
  }, 120_000)

  test("G1: a keyless local model answers `git init` through this PC; the host has nothing on the model's port", async () => {
    const from = state.fake.requests.length
    state.fake.enqueue({ type: "text", text: "g1 answer from the PC's local model" })
    const started = Date.now()
    await prompt(state.main, "git init")
    expect(await waitIdle(state.main)).toBe(true)
    const list = await messages(state.main)
    const listening = await Env.hostSh(`ss -Htln | awk '{print $4}' | grep -c ':${state.port}$' || true`)
    const reach = await Env.hostSh(
      `curl -sS -o /dev/null -w 'CODE=%{http_code}' --max-time 5 http://127.0.0.1:${state.port}/v1/models 2>/dev/null; echo`,
    )
    Env.evidence("g1-keyless.json", {
      ms: Date.now() - started,
      list: list.slice(0, 3),
      listening: listening.stdout,
      reach: reach.stdout,
      relay: await relay(),
    })
    expect(JSON.stringify(list)).toContain("g1 answer from the PC's local model")
    expect(JSON.stringify(list)).not.toContain("own_broker_unavailable")
    const seen = chats(from)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]!.identity).toBe("anonymous")
    expect(seen[0]!.headers.authorization).toBeUndefined()
    expect(await relay()).toEqual({ inflight: 0, lastError: null })
    // No tunnel to the model: the host's own 127.0.0.1 has nothing on that port.
    expect(listening.stdout.trim()).toBe("0")
    expect(Env.kv(reach.stdout).get("CODE")).toBe("000")
  }, 300_000)

  test("G2: the keyed account's FAKE key is added on this PC, the prefix is cached on the next turn, the key is not on the host", async () => {
    const sessionID = await session("keyed local via pc", state.keyed.providerID)
    state.fake.enqueue({ type: "text", text: "g2 first" }, { type: "text", text: "g2 second" })
    const from = state.fake.requests.length
    await prompt(sessionID, "first question on the keyed model")
    await waitIdle(sessionID)
    await prompt(sessionID, "second question on the keyed model")
    await waitIdle(sessionID)
    const seen = chats(from)
    const scan = await Env.hostSh(String.raw`set -u
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
roots="$HOME/.local/share/own-open-code $HOME/.config/own-open-code $HOME/.local/state/own-open-code $HOME/.config/opencode $HOME/.local/state/opencode $HOME/.local/share/opencode $HOME/.cache/opencode"
c=$(grep -rlaF -- '${KEY}' $roots /tmp/own-$(id -u)* 2>/dev/null | wc -l)
e=$(tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -cF -- '${KEY}')
a=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -cF -- '${KEY}')
echo "HITS=$c/$e/$a"`)
    Env.evidence("g2-keyed.json", {
      seen: seen.map((item) => ({ identity: item.identity, cache: item.cache })),
      scan: scan.stdout,
    })
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every((item) => item.identity === "keyed")).toBe(true)
    expect(seen.at(-1)!.headers.authorization).toBe(hashSecret(`Bearer ${KEY}`))
    expect(seen.at(-1)!.cache?.cachedTokens ?? 0).toBeGreaterThan(0)
    expect(Env.kv(scan.stdout).get("HITS")).toBe("0/0/0")
    for (const output of state.outputs) expect(output).not.toContain(KEY)
  }, 300_000)

  test("G3: a long stream with a 45 s pause reaches the host whole", async () => {
    const deltas = Math.max(4, Math.ceil(LONG_MS / 15_000))
    // One pause longer than the relay listener's idle timeout, then a delta every 15 s.
    // One word per delta: the fake splits the text into at most as many deltas as it has characters.
    state.fake.enqueue({ type: "text", text: "g3 ".repeat(deltas), delayMs: PAUSE_MS, deltas, eventDelayMs: 15_000 })
    const started = Date.now()
    // The relay's state each time it changes while the stream runs: when a `lastError` appears, and what was in flight.
    const changes: Array<{ readonly ms: number; readonly relay: unknown }> = []
    const sampler = setInterval(
      () =>
        void relay()
          .then((now) => {
            if (JSON.stringify(changes.at(-1)?.relay) !== JSON.stringify(now))
              changes.push({ ms: Date.now() - started, relay: now })
          })
          .catch(() => undefined),
      2_000,
    )
    await prompt(state.main, "[G3] a long answer")
    const idle = await waitIdle(state.main, LONG_MS + 300_000)
    clearInterval(sampler)
    expect(idle).toBe(true)
    const ms = Date.now() - started
    const list = await messages(state.main)
    const last = list.find((message) => message.type === "assistant")
    Env.evidence("g3-long.json", {
      ms,
      deltas,
      finish: last?.finish,
      error: last?.error,
      relay: await relay(),
      changes,
    })
    expect(ms).toBeGreaterThan(PAUSE_MS + (deltas - 1) * 15_000 - 5_000)
    expect(last?.finish).not.toBe("error")
    expect(await relay()).toEqual({ inflight: 0, lastError: null })
  }, 1_800_000)

  test("G4: interrupting a turn mid-stream closes the relayed request within 5 s", async () => {
    state.fake.enqueue({ type: "text", text: "g4 never finished", deltas: 6, eventDelayMs: 30_000 })
    await prompt(state.main, "[G4] a long answer to interrupt")
    await Stack.until(async () => ((await relay())?.inflight === 1 ? true : undefined), 120_000, 250)
    await Bun.sleep(2_000)
    const at = Date.now()
    await interrupt(state.main)
    await Stack.until(async () => ((await relay())?.inflight === 0 ? true : undefined), 30_000, 100)
    const closedMs = Date.now() - at
    Env.evidence("g4-interrupt.json", { closedMs })
    expect(closedMs).toBeLessThan(5_000)
  }, 300_000)

  test("G5: same-uid requests to the egress socket and the stub without a valid proof: 401 mac, nothing reaches the model", async () => {
    const egress = egressSocket()!
    const from = state.fake.requests.length
    const route = `/local/${state.keyless.accountID}/v1/chat/completions`
    const random = Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")
    const probe = await Env.hostSh(String.raw`set -u
command -v curl >/dev/null 2>&1 || { echo NO_CURL=1; exit 0; }
r() {
  curl -sS --max-time 20 $1 -o /dev/null -D - -X POST "$2" -H 'content-type: application/json' ${"$"}{3:+-H "$3"} \
    --data '{"model":"x","stream":true,"messages":[]}' 2>&1 | tr -d '\r' |
    awk 'NR==1{code=$2} tolower($1)=="x-own-local-error:"{err=$2} END{print code" "err}'
}
s="--unix-socket ${egress.socket}"
echo "NONE=$(r "$s" 'http://localhost${route}')"
echo "RANDOM=$(r "$s" 'http://localhost${route}' 'x-own-local: v1.${egress.epoch}.${Math.floor(Math.random() * 1e6) + 5000}.${state.keyless.accountID}.${random}')"
pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
api=$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$HOME/.local/state/opencode/service-own.json" | head -n 1)
for port in $(ss -Htlnp 2>/dev/null | grep "pid=$pid," | awk '{print $4}' | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p'); do
  [ "$port" = "$api" ] && continue
  echo "STUB_$port=$(r "" "http://127.0.0.1:$port${route}")"
done`)
    const result = Env.kv(probe.stdout)
    const stubs = [...result.entries()].filter(([key]) => key.startsWith("STUB_"))
    Env.evidence("g5-mac.json", { probe: probe.stdout, stderr: probe.stderr })
    expect(result.get("NO_CURL")).toBeUndefined()
    expect(result.get("NONE")).toBe("401 mac")
    expect(result.get("RANDOM")).toBe("401 mac")
    expect(stubs.some(([, value]) => value === "401 mac")).toBe(true)
    expect(chats(from)).toHaveLength(0)
    expect((await host()).broker.state).toBe("connected")
  }, 300_000)

  test("G6: ssh.exe killed mid-stream: the step fails with its partial output; a turn in the break never reaches the model; back after reconnecting", async () => {
    const sessionID = await session("local tunnel break", state.keyless.providerID)
    const hostsFile = JSON.parse(await Bun.file(`${Env.OWN_HOME}/remote/hosts.json`).text()) as Json
    const remotePort = (hostsFile.hosts as Json[]).find((item) => item.id === state.stack.hostId)!.remotePort as number
    const localPort = await Env.freeLocalPort(40_000, 40_999)
    // This suite's own -L to the remote service (like a TUI on the host): it stays up while the tunnel is broken.
    state.direct = Env.forwardProcess(["-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`])
    const direct = `http://127.0.0.1:${localPort}`
    await Stack.until(
      async () =>
        (
          await fetch(`${direct}/api/info`, {
            headers: { authorization: `Basic ${btoa(`opencode:${state.resolved.token}`)}` },
          }).catch(() => undefined)
        )?.ok,
      30_000,
      500,
    )
    // Each delta is the whole marker, so the part that arrived before the break holds it.
    state.fake.enqueue({ type: "text", text: "partial g6 output ".repeat(8), deltas: 8, eventDelayMs: 10_000 })
    await prompt(sessionID, "[G6] a long answer")
    await Stack.until(async () => ((await relay())?.inflight === 1 ? true : undefined), 120_000, 250)
    await Bun.sleep(12_000)
    const forwards = tunnel()
    expect(forwards).toBeDefined()
    const killed = Date.now()
    spawnSync("taskkill", ["/PID", String(forwards!.pid), "/F"], { windowsHide: true })
    await state.stack.local("own.remote", "disconnect", { hostId: state.stack.hostId }).catch(() => undefined)
    state.directURL = direct
    await Stack.until(async () => ((await relay())?.inflight ?? 0) === 0, 90_000, 250)
    const endedMs = Date.now() - killed
    const failed = await Stack.until(
      async () => {
        const list = await messages(sessionID)
        const step = list.find((message) => message.type === "assistant")
        return step?.finish === "error" ? list : undefined
      },
      120_000,
      1_000,
    )
    const during = await session("local during the break", state.keyless.providerID)
    const from = state.fake.requests.length
    await prompt(during, "[G6-DURING] while the tunnel is down")
    await Bun.sleep(15_000)
    const duringRequests = chats(from).length
    const duringList = await messages(during)
    await interrupt(during)
    await interrupt(sessionID)
    state.directURL = undefined
    state.direct.stop()
    state.direct = undefined
    await connect()
    state.fake.enqueue({ type: "text", text: "g6 answer after the reconnect" })
    const after = state.fake.requests.length
    await prompt(state.main, "[G6-AFTER] after the reconnect")
    await waitIdle(state.main)
    Env.evidence("g6-tunnel-break.json", {
      endedMs,
      failed: failed.slice(0, 3),
      duringRequests,
      during: duringList.slice(0, 3),
      after: chats(after).length,
    })
    expect(endedMs).toBeLessThan(60_000)
    expect(JSON.stringify(failed)).toContain("partial g6 output")
    expect(duringRequests).toBe(0)
    expect(chats(after).length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(await messages(state.main))).toContain("g6 answer after the reconnect")
  }, 900_000)
})
