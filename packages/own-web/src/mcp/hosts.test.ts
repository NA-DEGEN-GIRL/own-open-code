// 설정 > MCP 서버 `SSH 호스트에서 쓰기` (04 §13 "MCP", MH 2026-11-26): the row states per host (installed, PC와 다름,
// what installing would take, an older host, offline), the servers the PC no longer has, the direct install with host
// values, the config files' servers as sources, the install job and start intent, an installed row's one state from
// the host's definition and last test (the llm-router report of 2.4.1-own.5), the host conversation's dismissal key,
// and the start intent's metadata merge. Pure; the analysis itself is own-protocol's (mcp-host-rules.test.ts).
import { describe, expect, test } from "bun:test"
import type { ConfigEntry } from "@opencode/client"
import type { OwnMcp } from "@own/protocol"
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { withStartMetadata } from "@/composer/start-intent"
import { mcpHostsEn, mcpHostsKo } from "./hosts-strings"
import {
  assistIntent,
  direct,
  fileSources,
  hostShown,
  hostValues,
  job,
  keepHostValues,
  live,
  missingKey,
  nextStep,
  orphans,
  ownSource,
  reasonsOf,
  rows,
  shown,
  summary,
  type HostData,
  type HostServer,
  type Send,
} from "./hosts-model"

const HOME = "C:\\Users\\demo"
const HOST = "h-build01"
const probe: McpHostRules.Probe = {
  at: 1,
  os: "linux 6.8",
  arch: "x64",
  home: "/home/build",
  runtimes: { node: {}, npx: {} },
  binaries: {},
}

function own(id: string, name: string, transport: OwnMcp.Transport): OwnMcp.Server {
  return { id: id as OwnMcp.ID, name, scope: { type: "global" }, transport, createdAt: 1, updatedAt: 1 }
}

const memory = own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6A", "memory", {
  type: "local",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  env: [],
})
const github = own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6B", "github", {
  type: "local",
  command: "npx",
  args: ["-y", "@example/github-mcp"],
  env: [{ name: "GITHUB_TOKEN", hint: "…9fQ2" }],
})
const fetcher = own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6C", "fetch", { type: "local", command: "uvx", args: ["mcp-server-fetch"], env: [] })
const windows = own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6D", "win", { type: "local", command: "C:\\Tools\\win.exe", args: [], env: [] })
const files = own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6E", "files", {
  type: "local",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "E:\\shared"],
  env: [],
})

const sources = [memory, github, fetcher, windows, files].map(ownSource)

function installed(source: McpHostRules.Source, patch: Partial<HostServer> = {}): HostServer {
  return {
    id: "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W7Z",
    name: source.name,
    transport: { type: "local", command: "npx", args: [], env: [] },
    pc: { key: source.key, hash: McpHostRules.hash(source), at: 1 },
    values: "none",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

const ready = (servers: HostServer[] = []): HostData => ({ status: "ready", view: { servers, home: "/home/build" }, probe })
const states = (data: HostData, sends: Send[] = []) =>
  Object.fromEntries(rows(sources, data, sends, { home: HOME, hostId: HOST }).map((row) => [row.source.name, row.state]))

describe("row states per host", () => {
  test("what installing would take, against the host's probe", () => {
    expect(states(ready())).toEqual({ memory: "ready", github: "ready", fetch: "prepare", win: "pc-only", files: "assist" })
  })

  test("installed from this PC's key; PC와 다름 when the definition or own's values changed since", () => {
    const server = installed(sources[0]!)
    expect(states(ready([server])).memory).toBe("installed")
    const stale = installed(sources[0]!, { pc: { key: sources[0]!.key, hash: "0000000000000000", at: 1 } })
    const row = rows(sources, ready([stale]), [], { home: HOME, hostId: HOST })[0]!
    expect(row).toMatchObject({ state: "differs", changed: { definition: true, values: false } })
    const token = installed(sources[1]!, { id: "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W8Z", values: "ready" })
    const send: Send = { hostId: HOST, server: token.id, names: ["GITHUB_TOKEN"], source: { type: "own", id: github.id }, at: 1, differs: true }
    const values = rows(sources, ready([token]), [send], { home: HOME, hostId: HOST })[1]!
    expect(values).toMatchObject({ state: "differs", changed: { definition: false, values: true }, send })
    // Another host's record does not count.
    expect(rows(sources, ready([token]), [{ ...send, hostId: "h-other01" }], { home: HOME, hostId: HOST })[1]!.state).toBe(
      "installed",
    )
  })

  test("an older host and an offline one; this PC's own programs stay `pc-only` everywhere", () => {
    expect(states({ status: "old" })).toEqual({ memory: "old", github: "old", fetch: "old", win: "pc-only", files: "old" })
    expect(states({ status: "offline" })).toEqual({
      memory: "offline",
      github: "offline",
      fetch: "offline",
      win: "pc-only",
      files: "offline",
    })
  })

  test("the summary counts each state; servers gone from the PC are named apart", () => {
    const gone = installed({ ...sources[0]!, key: "own:mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W9Z" }, { id: "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W9Y", name: "old" })
    const data = ready([installed(sources[0]!), gone])
    expect(summary(rows(sources, data, [], { home: HOME, hostId: HOST }))).toEqual([
      { state: "installed", count: 1 },
      { state: "ready", count: 1 },
      { state: "prepare", count: 1 },
      { state: "assist", count: 1 },
      { state: "pc-only", count: 1 },
    ])
    expect(orphans(sources, data).map((server) => server.name)).toEqual(["old"])
    expect(orphans(sources, { status: "offline" })).toEqual([])
  })
})

describe("installing", () => {
  test("an `assist` row of host values only installs directly once they are filled", () => {
    const row = rows(sources, ready(), [], { home: HOME, hostId: HOST })[4]!
    expect(row.state).toBe("assist")
    expect(direct(row)).toBe(false)
    expect(direct(row, { 2: "/srv/shared" })).toBe(true)
    // A script of this PC needs the AI whatever is filled in.
    const script = rows(
      [ownSource(own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6F", "py", { type: "local", command: "python", args: ["C:\\mcp\\s.py"], env: [] }))],
      ready(),
      [],
      { home: HOME, hostId: HOST },
    )[0]!
    expect(direct(script, { 0: "/home/build/s.py" })).toBe(false)
  })

  test("the AI's job names the PC's key, hash, value names and which are secrets; a remote server has none", () => {
    const github = rows(sources, ready(), [], { home: HOME, hostId: HOST })[1]!
    expect(job(github.source, github.analysis)).toEqual({
      key: sources[1]!.key,
      hash: McpHostRules.hash(sources[1]!),
      name: "github",
      env: ["GITHUB_TOKEN"],
      secrets: ["GITHUB_TOKEN"],
    })
    const remote = ownSource(
      own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6G", "ctx", { type: "remote", url: "https://mcp.example.test/mcp", query: true, headers: [], oauth: false }),
    )
    expect(job(remote, McpHostRules.analyze(remote, { home: HOME }))).toBeUndefined()
    expect(shown(remote)).toBe("https://mcp.example.test/mcp?…")
  })

  test("the AI's start intent: the brief, the job in `own`, and the install tool allowed in that conversation only", () => {
    const row = rows(sources, ready(), [], { home: HOME, hostId: HOST })[4]!
    expect(assistIntent(HOST, row, "brief")).toEqual({
      serverKey: HOST,
      text: "brief",
      metadata: { own: { mcpInstall: job(row.source, row.analysis)! } },
      permissions: [{ action: McpHostRules.TOOL, resource: "*", effect: "allow" }],
    })
  })

  test("the host conversation's dismissal follows the set of servers the host lacks", () => {
    const list = rows(sources, ready(), [], { home: HOME, hostId: HOST })
    expect(missingKey(list)).toBe([sources[1]!.key, sources[0]!.key].toSorted().join("|"))
    expect(missingKey(rows(sources, ready([installed(sources[0]!), installed(sources[1]!, { id: "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W8Z" })]), [], { home: HOME, hostId: HOST }))).toBe("")
  })
})

// 2.4.1-own.5's report: `llm-router` (a node script of this PC, one value LLM_ROUTER_MCP_STATE_DIR) installed on
// build-host by the AI. The card showed `설치됨`, `값을 보내기 전에는 꺼져 있어요`, this PC's path and script reasons, the
// unchecked value with `이 키를 보내기`, and `연결됐어요 · 도구 12개` at once. An installed row now reads the host's definition.
describe("an installed server shows what its host runs (llm-router)", () => {
  const router = ownSource(
    own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6H", "llm-router", {
      type: "local",
      command: "node",
      args: ["D:\\projects\\llm-router-mcp\\bin\\llm-router-mcp.js"],
      env: [{ name: "LLM_ROUTER_MCP_STATE_DIR" }],
    }),
  )
  const SCRIPT = "/home/dev/llm-router-mcp/bin/llm-router-mcp.js"
  const twelve = Array.from({ length: 12 }, (_, index) => ({ name: `route_${index}` }))
  const tested = { at: 2, ok: true, tools: twelve }
  const rowOf = (server: HostServer, sends: Send[] = []) =>
    rows([router], ready([server]), sends, { home: HOME, hostId: HOST })[0]!

  test("before the install it needs the AI: this PC's script and path, one value that is not a secret", () => {
    const row = rows([router], ready(), [], { home: HOME, hostId: HOST })[0]!
    expect(row.state).toBe("assist")
    expect(reasonsOf(row)).toBe(row.analysis.reasons)
    expect(reasonsOf(row).map((reason) => reason.code)).toEqual(expect.arrayContaining(["host_value", "values", "script"]))
    expect(row.analysis.values).toEqual([{ name: "LLM_ROUTER_MCP_STATE_DIR", kind: "env", secret: false }])
    expect(nextStep(row)).toBe("assist")
  })

  test("the host waits for the PC's value: off, whatever an older test said; no reason about this PC; the AI sets it", () => {
    const row = rowOf(
      installed(router, {
        transport: { type: "local", command: "node", args: [SCRIPT], env: ["LLM_ROUTER_MCP_STATE_DIR"] },
        values: "missing",
        check: tested,
      }),
    )
    expect(row.state).toBe("installed")
    expect(live(row)).toEqual({ kind: "off", waiting: ["LLM_ROUTER_MCP_STATE_DIR"] })
    expect(reasonsOf(row)).toEqual([])
    expect(hostValues(row)).toEqual([{ name: "LLM_ROUTER_MCP_STATE_DIR", secret: false, from: "pc", sent: false }])
    expect(hostShown(row.installed!)).toBe(`node ${SCRIPT}`)
    // Not a secret, and the PC's copy is this PC's path: the AI sets it for the host.
    expect(nextStep(row)).toBe("assist")
  })

  test("the AI set the value on the host: it runs, the value shows as the host's, nothing waits for the PC", () => {
    const row = rowOf(
      installed(router, {
        transport: {
          type: "local",
          command: "node",
          args: [SCRIPT],
          env: [],
          fixed: { LLM_ROUTER_MCP_STATE_DIR: "/home/dev/.local/state/llm-router" },
        },
        values: "none",
        check: tested,
      }),
    )
    expect(row.state).toBe("installed")
    expect(live(row)).toEqual({ kind: "connected", tools: 12 })
    expect(hostValues(row)).toEqual([
      { name: "LLM_ROUTER_MCP_STATE_DIR", secret: false, from: "host", value: "/home/dev/.local/state/llm-router" },
    ])
    expect(reasonsOf(row)).toEqual([])
    expect(nextStep(row)).toBeUndefined()
    // A later update from this PC keeps what the host set.
    const update = keepHostValues({ type: "local", command: "node", args: [SCRIPT], env: ["LLM_ROUTER_MCP_STATE_DIR"] }, row)
    expect(update).toEqual({
      type: "local",
      command: "node",
      args: [SCRIPT],
      env: [],
      fixed: { LLM_ROUTER_MCP_STATE_DIR: "/home/dev/.local/state/llm-router" },
    })
  })

  test("a secret the host waits for is the user's send, not the AI's; sent, the last test counts again", () => {
    const token = installed(sources[1]!, {
      id: "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W8Z",
      transport: { type: "local", command: "npx", args: ["-y", "@example/github-mcp"], env: ["GITHUB_TOKEN"] },
      values: "missing",
      check: tested,
    })
    const off = rows(sources, ready([token]), [], { home: HOME, hostId: HOST })[1]!
    expect(live(off)).toEqual({ kind: "off", waiting: ["GITHUB_TOKEN"] })
    expect(nextStep(off)).toBeUndefined()
    const send: Send = { hostId: HOST, server: token.id, names: ["GITHUB_TOKEN"], source: { type: "own", id: github.id }, at: 1 }
    const on = rows(sources, ready([{ ...token, values: "ready" }]), [send], { home: HOME, hostId: HOST })[1]!
    expect(live(on)).toEqual({ kind: "connected", tools: 12 })
    expect(hostValues(on)).toEqual([{ name: "GITHUB_TOKEN", secret: true, from: "pc", sent: true }])
    expect(live(rows(sources, ready([{ ...token, values: "ready", check: undefined }]), [send], { home: HOME, hostId: HOST })[1]!)).toEqual({
      kind: "untested",
    })
  })

  test("an update whose PC definition no longer installs by itself goes to the AI, not over the host's command", () => {
    const stale = installed(router, {
      transport: { type: "local", command: "node", args: [SCRIPT], env: [] },
      pc: { key: router.key, hash: "0000000000000000", at: 1 },
    })
    const row = rowOf(stale)
    expect(row.state).toBe("differs")
    expect(nextStep(row)).toBe("assist")
    const memory = rows(
      sources,
      ready([installed(sources[0]!, { pc: { key: sources[0]!.key, hash: "0000000000000000", at: 1 } })]),
      [],
      { home: HOME, hostId: HOST },
    )[0]!
    expect(nextStep(memory)).toBe("update")
  })
})

describe("config files' servers as sources", () => {
  test("names of values only; own's server of the same name replaces one; the address's parts as flags", () => {
    const entries = [
      {
        type: "document",
        path: "C:\\Users\\demo\\.config\\opencode\\opencode.json",
        info: {
          mcp: {
            servers: {
              docs: { type: "local", command: ["uvx", "docs-mcp"], environment: { DOCS_KEY: "fake-docs-key-0000" } },
              github: { type: "local", command: ["gh-mcp"] },
              ctx: { type: "remote", url: "https://mcp.example.test/mcp?key=fake-query-key-0000", headers: { Authorization: "x" }, disabled: true },
            },
          },
        },
      },
    ] as unknown as ConfigEntry[]
    const found = fileSources(entries, [github])
    expect(found).toEqual([
      { key: "file:docs", name: "docs", origin: "file", transport: { type: "local", command: "uvx", args: ["docs-mcp"], env: ["DOCS_KEY"] } },
      {
        key: "file:ctx",
        name: "ctx",
        origin: "file",
        disabled: true,
        transport: { type: "remote", url: "https://mcp.example.test/mcp", query: true, headers: ["Authorization"], oauth: true },
      },
    ])
    expect(JSON.stringify(found)).not.toContain("fake-")
  })
})

describe("the start intent of the AI's conversation", () => {
  test("its metadata merges into the harness's, `own` objects together", () => {
    const intent = {
      serverKey: HOST,
      text: "brief",
      metadata: { own: { mcpInstall: { key: "own:x" } } },
      permissions: [{ action: McpHostRules.TOOL, resource: "*", effect: "allow" as const }],
    }
    expect(withStartMetadata({ own: { harness: "codex" }, other: 1 }, intent)).toEqual({
      own: { harness: "codex", mcpInstall: { key: "own:x" } },
      other: 1,
    })
    expect(withStartMetadata(undefined, intent)).toEqual({ own: { mcpInstall: { key: "own:x" } } })
    expect(withStartMetadata({ a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

test("every host string has its English", () => {
  expect(Object.keys(mcpHostsEn).toSorted()).toEqual(Object.keys(mcpHostsKo).toSorted())
})
