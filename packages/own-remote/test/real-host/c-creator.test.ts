// Real-host phase C, creator items (own/docs/17 §10, decisions CRM-23–CRM-31): own.creator's extensions on the phase A
// host, driven from this PC's release service (stack.ts with the release's own-creator last) through own-remote's
// tunnel. Opt-in: OWN_REAL_HOST=dev-host. Written for the next release chain (run after c-team, before d-claude);
// not run when written (no SSH in that session).
//
// Everything the items make on the host lives in one temp root /tmp/own-<uid>-creator-<rand> (the scope's host folder)
// or in the install's OWN_HOME (`creator/`, the read-only mirror; z-cleanup removes the install). This PC's store gets
// its extensions as creator mode writes them (the store and the staging, in this process, on this PC's OWN_HOME), and
// afterAll removes them so later phases see an empty store. Model traffic only to the fake chat model on this PC (the
// compat account Alpha through the broker).
//
// Items: the managed config names own-creator last in remote mode and the archive carried its QuickJS engine; a
// fragment, a deny rule and a command tool apply in a host conversation inside the host folder of the scope, the tool
// on the host's bash; a C2 server's version reaches the host only when its files hash as the PC's, the host's staging
// runs in the host's sandbox, and a host conversation's call is asked on the host (the confirmation stays there); a C3
// version without that host's allowance never reaches it (no files, no config entry, no trust approval); the host
// cannot change this PC's store (no own.creator there, a copy changed on the host is fetched again); an update and a
// rollback on this PC follow in the host's conversations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import { Staging } from "../../../own-creator/src/staging.js"
import { CreatorStore } from "../../../own-creator/src/store.js"
import { mcpManifest, pluginManifest } from "../../../own-creator/test/unit/fixtures.js"
import { afterToolResult, lastUserText, toolOutputs, type RecordedRequest } from "../../../own-accounts/test/e2e-kit"
import { ALIAS, OWN_HOME, VERSION, enabled, evidence, hostSh, kv } from "./env.js"
import { MODEL, ensureCompat, startStack, until, type Stack } from "./stack.js"
import { local, remoteFetch, remoteSession, type Endpoint } from "./team-fixture.js"

const run = enabled ? describe : describe.skip
const CLIENT = "real-host-c-creator"
const OP_MS = 240_000
const FULL = [
  { action: "edit", resource: "**", effect: "allow" },
  { action: "shell", resource: "**", effect: "allow" },
]

type Json = Record<string, any>

/** The house extension: a fragment, a direct command tool on the host's shell, a deny rule for a word. */
function house(rule: string) {
  return {
    format: "own.ext/1",
    id: "rh-house",
    title: "Real host house rules",
    items: [
      { type: "prompt.fragment", id: "style", text: rule },
      {
        type: "tool.command",
        name: "rh_say",
        description: "Says a word on the host's shell",
        command: "echo said-{{word}} on $(uname -s)",
        params: { word: { type: "string", description: "The word" } },
        direct: true,
      },
      {
        type: "tool.rule",
        rules: [{ permission: "shell", pattern: "*forbidden*", effect: "deny", reason: "no forbidden words" }],
      },
    ],
  }
}

/** The fake chat model: `[say <word>]` calls the command tool, `[words]` the C2 server through Code Mode. */
function reply(request: RecordedRequest) {
  const text = lastUserText(request)
  if (!text.includes("[say ") && !text.includes("[words]")) return undefined
  if (afterToolResult(request)) return { type: "text" as const, text: "끝났어요." }
  const say = /\[say (\w+)\]/.exec(text)
  if (say) return { type: "tool-call" as const, name: "ext_rh_say", input: { word: say[1] } }
  return {
    type: "tool-call" as const,
    name: "execute",
    input: { code: 'return await tools["creator-rh-words-words"].count_words({ text: "a b c" })' },
  }
}

run(`real host ${ALIAS}: creator extensions (phase C)`, () => {
  const state = {} as {
    stack: Stack
    hostId: string
    endpoint: Endpoint
    ownHome: string
    root: string
    store: CreatorStore.Store
    model: { readonly providerID: string; readonly id: string }
  }

  const creatorList = () => state.stack.local("own.creator", "list", {})
  /** The host's line on this PC's card once it reports `status` for version `n`. */
  const applied = (id: string, n: number, status = "active") =>
    until(
      async () => {
        const listed = await creatorList()
        const line = ((listed.extensions as Json[]).find((item) => item.id === id)?.remote as Json[] | undefined)?.find(
          (item) => item.host === state.hostId,
        )
        return line?.state?.n === n && line.state.status === status ? line : undefined
      },
      OP_MS,
      1_000,
    )
  /** One host turn, answering its permission requests once; the chat requests it sent. */
  const turn = async (sessionID: string, text: string) => {
    const from = state.stack.chat.requests.length
    const asked: Json[] = []
    const done = { value: false }
    const answering = (async () => {
      while (!done.value) {
        const listed = await remoteFetch(state.endpoint, "GET", `/api/session/${sessionID}/permission`)
        for (const request of ((listed.body as Json | undefined)?.data ?? []) as Json[]) {
          asked.push(request)
          await remoteFetch(state.endpoint, "POST", `/api/session/${sessionID}/permission/${String(request.id)}/reply`, {
            body: { decision: "once" },
          })
        }
        await Bun.sleep(300)
      }
    })()
    const admitted = await remoteFetch(state.endpoint, "POST", `/api/session/${sessionID}/prompt`, {
      body: { text },
      directory: state.root,
    })
    expect(admitted.status).toBe(200)
    await remoteFetch(state.endpoint, "POST", `/api/experimental/session/${sessionID}/wait`).finally(() => {
      done.value = true
    })
    await answering
    return { requests: state.stack.chat.requests.slice(from).filter((request) => request.method === "POST"), asked }
  }
  const toolText = (request: RecordedRequest) => request.body
  const session = (title: string) => remoteSession(state.endpoint, { directory: state.root, title, model: state.model })
  /**
   * A host conversation under 전체 허용 (as own-creator's fake-SSH e2e): there a C2 version's first call still asks
   * (17 §11.5), while a conversation on the host's default rules runs it without asking (RL4-T1).
   */
  const fullSession = async (title: string) => {
    const created = await remoteFetch(state.endpoint, "POST", "/api/session", {
      body: { title, model: state.model, location: { directory: state.root }, permissions: FULL },
      directory: state.root,
    })
    expect(created.status).toBe(200)
    return String((created.body as Json).data.id)
  }
  /** A host file's text (`file` may name `$HOME`: it is expanded by the host's shell). */
  const hostFile = async (file: string) => (await hostSh(`cat -- "${file}" 2>/dev/null || true`)).stdout

  beforeAll(async () => {
    state.stack = await startStack({ responder: reply, creator: true })
    state.hostId = state.stack.hostId
    const alpha = await ensureCompat(state.stack, "Alpha")
    state.model = { providerID: String(alpha.providerID), id: MODEL }
    await local(state.stack, "connect", { hostId: state.hostId, clientId: CLIENT })
    await until(
      async () => {
        const listed = await local(state.stack, "hosts.list", {})
        const found = listed.hosts.find((item) => item.id === state.hostId)
        return found?.stage === "ready" ? found : undefined
      },
      OP_MS,
      1_000,
    )
    const resolved = await local(state.stack, "resolve", { hostId: state.hostId })
    if (resolved.url === null) throw new Error(`host not ready: ${resolved.stage}`)
    state.endpoint = { url: resolved.url, token: resolved.token, controlDir: resolved.controlDir }
    state.ownHome = `${resolved.home}/.local/share/own-open-code`
    const made = await hostSh(`root=$(mktemp -d "/tmp/own-$(id -u)-creator-XXXXXX") && echo "ROOT=$root"`)
    state.root = kv(made.stdout).get("ROOT")!
    state.store = new CreatorStore.Store(OWN_HOME, { app: VERSION })
    await until(
      async () => {
        const listed = await local(state.stack, "hosts.list", {})
        return listed.hosts.find((item) => item.id === state.hostId)?.broker?.state === "connected"
      },
      120_000,
      1_000,
    )
  }, 600_000)

  afterAll(async () => {
    for (const id of ["rh-house", "rh-words", "rh-brief"]) await state.store?.remove(id).catch(() => undefined)
    await state.store?.settings({ plugins: false }).catch(() => undefined)
    if (state.root) await hostSh(`rm -rf -- '${state.root}'`)
    await state.stack?.stop()
  }, 300_000)

  test("the managed config names own-creator last in remote mode; the install carries its QuickJS engine", async () => {
    const config = JSON.parse(await hostFile("$HOME/.config/own-open-code/opencode.json")) as {
      plugins: Array<{ package: string; options?: Json }>
    }
    expect(config.plugins.at(-1)?.package).toEndWith("/own-creator")
    expect(config.plugins.at(-1)?.options).toEqual({ home: state.ownHome, mode: "remote" })
    const engine = await hostSh(
      `cd '${state.ownHome}/app/current/plugins/own-creator' && ls quickjs/core/index.mjs quickjs/variant/index.mjs quickjs/variant/emscripten-module.wasm && echo "N=$(ls quickjs/variant/*.wasm | wc -l)"`,
    )
    expect(kv(engine.stdout).get("N")).toBe("1")
    evidence("c-creator-config.json", { plugins: config.plugins })
  }, 120_000)

  test("a fragment, a rule and a command tool apply in a host conversation; the tool runs on the host's bash", async () => {
    expect((await state.store.create(house("RH-HOUSE-ONE: answer like a pirate."), "model")).ok).toBe(true)
    const scoped = await state.store.scope("rh-house", [], "user", undefined, [{ host: state.hostId, directory: state.root }])
    expect(scoped.ok).toBe(true)
    await applied("rh-house", 1)
    const sessionID = await session("creator house on the host")
    const said = await turn(sessionID, "[say hello]")
    expect(said.requests[0]!.body).toContain("RH-HOUSE-ONE: answer like a pirate.")
    expect(toolText(said.requests.at(-1)!)).toContain("said-hello on Linux")
    const blocked = await turn(sessionID, "[say forbidden]")
    expect(toolText(blocked.requests.at(-1)!)).toContain("Blocked by extension 'rh-house'")
    // The mirror on the host: the PC's version, the host folder as its scope.
    const store = JSON.parse(await hostFile(`${state.ownHome}/creator/store.json`)) as { extensions: Json[] }
    expect(store.extensions.find((item) => item.id === "rh-house")?.projects).toEqual([state.root])
    evidence("c-creator-house.json", { store })
  }, OP_MS)

  test("C2: the host checks the hash, stages in its own sandbox, and asks the call in the host's conversation", async () => {
    const manifest = mcpManifest("rh-words")
    const checked = CreatorStore.checkManifest(manifest)
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
    const staged = await Staging.run(state.store, checked.extension, { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    expect((await state.store.create(manifest, "model", {}, undefined, staged.staged)).ok).toBe(true)
    await applied("rh-words", 1)
    const log = await hostFile(`${state.ownHome}/creator/logs/rh-words.log`)
    expect(log).toContain("host staging words: host smoke ok")
    const sessionID = await fullSession("creator words on the host")
    const called = await turn(sessionID, "[words]")
    // 전체 허용 still asks a version's first call, in the host's conversation.
    expect(called.asked.map((item) => item.action), toolOutputs(called.requests.at(-1)!).join(" | ")).toEqual([
      "creator-rh-words-words_count_words",
    ])
    expect(toolText(called.requests.at(-1)!)).toContain("words: 3")
    const mirrored = JSON.parse(await hostFile(`${state.ownHome}/creator/store.json`)) as { extensions: Json[] }
    expect(mirrored.extensions.find((item) => item.id === "rh-words")?.confirmed).toEqual([1])
    expect((await state.store.read()).file.extensions.find((item) => item.id === "rh-words")?.confirmed).toEqual([])
    evidence("c-creator-words.json", { log: log.split("\n").filter((line) => line.includes("host staging")) })
  }, OP_MS)

  test("C3 without this host's allowance never reaches it", async () => {
    expect((await state.store.settings({ plugins: true })).ok).toBe(true)
    const manifest = pluginManifest("rh-brief")
    const checked = CreatorStore.checkManifest(manifest)
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems))
    const staged = await Staging.run(state.store, checked.extension, { bun: process.execPath })
    if (!staged.ok) throw new Error(JSON.stringify(staged.checks))
    expect((await state.store.create(manifest, "model", {}, undefined, staged.staged)).ok).toBe(true)
    const line = await until(async () => {
      const listed = await creatorList()
      return ((listed.extensions as Json[]).find((item) => item.id === "rh-brief")?.remote as Json[] | undefined)?.find(
        (item) => item.host === state.hostId,
      )
    }, 60_000)
    expect(line).toEqual({ host: state.hostId, reach: "pc_only" })
    const facts = await hostSh(
      `[ -e '${state.ownHome}/creator/ext/rh-brief' ] && echo EXT=1 || echo EXT=0
grep -c '/creator/ext/' "$HOME/.config/own-open-code/opencode.jsonc" 2>/dev/null | sed 's/^/ENTRY=/' || echo ENTRY=0
grep -c 'rh-brief' '${state.ownHome}/trust.json' 2>/dev/null | sed 's/^/TRUST=/' || echo TRUST=0`,
    )
    const values = kv(facts.stdout)
    expect(values.get("EXT")).toBe("0")
    expect(values.get("ENTRY") ?? "0").toBe("0")
    expect(values.get("TRUST") ?? "0").toBe("0")
  }, OP_MS)

  test("the host cannot change this PC's store; a copy changed on the host is fetched again", async () => {
    const before = fs.readFileSync(state.store.file, "utf8")
    const write = await remoteFetch(state.endpoint, "POST", "/api/rpc/own.creator/enabled.set", {
      body: { input: { id: "rh-house", enabled: false } },
      directory: state.endpoint.controlDir,
    })
    expect(write.status).not.toBe(200)
    const copy = `${state.ownHome}/creator/ext/rh-house/v1/extension.json`
    await hostSh(`sed -i 's/RH-HOUSE-ONE/RH-HOUSE-EVIL/' '${copy}'`)
    const sessionID = await session("tampered copy")
    const tampered = await turn(sessionID, "[say again]")
    expect(tampered.requests[0]!.body).not.toContain("RH-HOUSE-EVIL")
    expect(fs.readFileSync(state.store.file, "utf8")).toBe(before)
    expect((await state.store.hosts("rh-house", { mode: "all", ids: [] })).ok).toBe(true)
    await until(async () => (await hostFile(copy)).includes("RH-HOUSE-ONE"), 120_000, 1_000)
  }, OP_MS)

  test("an update and a rollback on this PC follow in the host's conversations", async () => {
    expect((await state.store.update(house("RH-HOUSE-TWO: answer in Korean."), "model")).ok).toBe(true)
    await applied("rh-house", 2)
    const v2 = await turn(await session("house v2"), "[say two]")
    expect(v2.requests[0]!.body).toContain("RH-HOUSE-TWO")
    expect((await state.store.rollback("rh-house", 1, "user")).ok).toBe(true)
    await applied("rh-house", 1)
    const v1 = await turn(await session("house rolled back"), "[say one]")
    expect(v1.requests[0]!.body).toContain("RH-HOUSE-ONE")
    expect(v1.requests[0]!.body).not.toContain("RH-HOUSE-TWO")
    const gone = await hostSh(`[ -e '${state.ownHome}/creator/ext/rh-house/v2' ] && echo V2=1 || echo V2=0`)
    expect(kv(gone.stdout).get("V2")).toBe("0")
  }, OP_MS)
})
