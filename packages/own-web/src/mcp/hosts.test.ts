// 설정 > MCP 서버 `SSH 호스트에서 쓰기` (04 §13 "MCP", MH 2026-11-26): the row states per host (installed, PC와 다름,
// what installing would take, an older host, offline), the servers the PC no longer has, the direct install with host
// values, the config files' servers as sources, the install job, the host conversation's dismissal key, and the start
// intent's metadata merge. Pure; the analysis itself is own-protocol's (mcp-host-rules.test.ts).
import { describe, expect, test } from "bun:test"
import type { ConfigEntry } from "@opencode/client"
import type { OwnMcp } from "@own/protocol"
import { McpHostRules } from "@own/protocol/mcp-host-rules"
import { withStartMetadata } from "@/composer/start-intent"
import { mcpHostsEn, mcpHostsKo } from "./hosts-strings"
import {
  direct,
  fileSources,
  job,
  missingKey,
  orphans,
  ownSource,
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

  test("the AI's job names the PC's key, hash and value names; a remote server has none", () => {
    expect(job(sources[1]!)).toEqual({ key: sources[1]!.key, hash: McpHostRules.hash(sources[1]!), name: "github", env: ["GITHUB_TOKEN"] })
    const remote = ownSource(
      own("mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W6G", "ctx", { type: "remote", url: "https://mcp.example.test/mcp", query: true, headers: [], oauth: false }),
    )
    expect(job(remote)).toBeUndefined()
    expect(shown(remote)).toBe("https://mcp.example.test/mcp?…")
  })

  test("the host conversation's dismissal follows the set of servers the host lacks", () => {
    const list = rows(sources, ready(), [], { home: HOME, hostId: HOST })
    expect(missingKey(list)).toBe([sources[1]!.key, sources[0]!.key].toSorted().join("|"))
    expect(missingKey(rows(sources, ready([installed(sources[0]!), installed(sources[1]!, { id: "mcp_01JBX7Q8ZJ4M2N6P8R0T2V4W8Z" })]), [], { home: HOME, hostId: HOST }))).toBe("")
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
