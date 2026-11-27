// MCP servers global first (03 §18.14, decisions SG 2026-10-26) on a real upstream server from source with own-accounts
// loaded from its package, starting from an `mcp.json` an earlier version wrote (version 1: switches per project only):
// it folds as it did (off in A, on in B), it is read as version 2 (B's `on`, a no-op then, goes, SG-17) and the first
// write writes it so, and the global switch then reaches B while A's `on` exception keeps the server in A. The server is the e2e kit's fake stdio server;
// fake folders only, the service binds 127.0.0.1 and everything lives in its temp root.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OwnMcp } from "@own/protocol"
import { FAKE_MCP_STDIO } from "../e2e-kit/fakes/mcp-stdio.js"
import { opencodeConfig } from "../e2e-kit/harness/config"
import { activating, REPO_ROOT, startOpencodeServer, type OpencodeServer } from "../e2e-kit/harness/opencode-server"
import { removeTree } from "../e2e-kit/harness/remove"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000

const fixture: { server?: OpencodeServer; root?: string } = {}

function server() {
  if (!fixture.server) throw new Error("server not started")
  return fixture.server
}

const projects = () => ({ a: path.join(fixture.root!, "projects", "a"), b: path.join(fixture.root!, "projects", "b") })

async function rpc(method: string, input: unknown) {
  const current = server()
  const control = path.join(current.paths.ownHome, "control")
  await fs.mkdir(control, { recursive: true })
  const response = await current.request("POST", `/api/rpc/own.accounts/${method}`, {
    body: { input },
    query: { "location[directory]": control },
    directory: control,
  })
  const body = (await response.json()) as Record<string, unknown>
  if (response.status !== 200) throw new Error(`${method}: ${response.status} ${JSON.stringify(body)}`)
  return body.output as { overrides: OwnMcp.Override[] }
}

/** The status core gives own's server in a project (`GET /api/mcp`); `undefined` while it is not listed yet. */
async function status(directory: string) {
  const answer = (await server()
    .call("GET", "/api/mcp", { query: { "location[directory]": directory }, directory })
    .catch(activating)) as { data?: { name: string; status: { status: string } }[] } | undefined
  return answer?.data?.find((item) => item.name === "files")?.status.status
}

async function settles(directory: string, wanted: string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if ((await status(directory)) === wanted) return
    await Bun.sleep(150)
  }
  throw new Error(`${directory}: files never became ${wanted} (last: ${await status(directory)})`)
}

beforeAll(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-mcp-global-"))
  const dirs = projects()
  await Promise.all([dirs.a, dirs.b].map((directory) => fs.mkdir(directory, { recursive: true })))
  const ownHome = path.join(fixture.root, "own-home")
  await Bun.write(
    path.join(ownHome, "mcp.json"),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: OwnMcp.ID.create(),
          name: "files",
          scope: { type: "global" },
          transport: { type: "local", command: process.execPath, args: [FAKE_MCP_STDIO], env: [] },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      overrides: [
        { directory: dirs.a, name: "files", enabled: false },
        { directory: dirs.b, name: "files", enabled: true },
      ],
    }),
  )
  fixture.server = await startOpencodeServer({
    root: fixture.root,
    env: { OWN_OPEN_CODE: "1" },
    config: (paths) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: { home: paths.ownHome, buildId: `mcp-global-e2e-${process.pid}`, vault: "memory" },
          },
        ],
      }),
  })
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.server?.stop()
  if (fixture.root) await removeTree(fixture.root)
}, 60_000)

describe("an earlier version's mcp.json on a real service", () => {
  test("read as it was: off in A, on in B", async () => {
    const dirs = projects()
    await settles(dirs.a, "disabled")
    await settles(dirs.b, "connected")
  })

  test("the first write upgrades it; the global switch then reaches B, A's own on keeps it in A", async () => {
    const dirs = projects()
    await rpc("mcp.enable", { directory: dirs.a, name: "files", enabled: true })
    const file = JSON.parse(await Bun.file(path.join(server().paths.ownHome, "mcp.json")).text()) as {
      version: number
      overrides: OwnMcp.Override[]
    }
    // A's off became on (an exception of A's now that nothing is off above it: not stored); B's on was a no-op.
    expect(file).toMatchObject({ version: 2, overrides: [] })
    const view = await rpc("mcp.enable", { name: "files", enabled: false })
    expect(view.overrides).toEqual([{ name: "files", enabled: false }])
    await settles(dirs.b, "disabled")
    await settles(dirs.a, "disabled")
    const only = await rpc("mcp.enable", { directory: dirs.a, name: "files", enabled: true })
    expect(only.overrides).toEqual([
      { name: "files", enabled: false },
      { directory: dirs.a, name: "files", enabled: true },
    ])
    await settles(dirs.a, "connected")
    expect(await status(dirs.b)).toBe("disabled")
  })
})
