// Skills global first (03 §19.6.1, decisions SG 2026-10-26) on a real upstream server from source with own-accounts
// loaded from its package: a skill in the service's own skills folder (`OPENCODE_CONFIG_DIR\skills`) is used in every
// project; a project switch takes it away in that project only, a scope keeps it in one project, the global switch
// with a project's `on` leaves it in that project only, and after a restart no list of the project it is off in ever
// has it (core's first answer of a Location is empty, then its built-ins, then the folders' skills; own's late
// registration is in before them). Fake folders only; the server binds 127.0.0.1 and everything lives in its temp root.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { opencodeConfig } from "../e2e-kit/harness/config"
import { activating, REPO_ROOT, startOpencodeServer, type OpencodeServer } from "../e2e-kit/harness/opencode-server"
import { removeTree } from "../e2e-kit/harness/remove"

// Real-server steps outrun Bun's 5 s default under load. Set per file: a preload covers only one (e2e-kit README).
setDefaultTimeout(60_000)

const BOOT_TIMEOUT = 180_000
const SKILL = "e2e-notes"

const fixture: { server?: OpencodeServer; root?: string } = {}

function server() {
  if (!fixture.server) throw new Error("server not started")
  return fixture.server
}

const paths = () => {
  const root = fixture.root!
  return {
    skills: path.join(root, "config", "skills"),
    a: path.join(root, "projects", "a"),
    b: path.join(root, "projects", "b"),
  }
}

/** Both boots share one temp root (the database, OWN_HOME and the skills folder), removed after the file. */
function boot(root: string) {
  return startOpencodeServer({
    root,
    // Guard 1 (01 §14.5): without the launcher's marker own-accounts registers `health` only.
    env: { OWN_OPEN_CODE: "1" },
    config: (dirs) =>
      opencodeConfig({
        providers: {},
        plugins: [
          {
            package: path.join(REPO_ROOT, "packages/own-accounts"),
            options: { home: dirs.ownHome, buildId: `skillset-e2e-${process.pid}`, vault: "memory" },
          },
        ],
      }),
  })
}

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
  return body.output as { catalog: { id: string }[]; switches: unknown[]; scopes: unknown[]; off?: { id: string }[] }
}

/** The skill ids core lists in a project (`GET /api/skill`); `undefined` while its plugins still activate. */
async function listed(directory: string) {
  const answer = (await server()
    .call("GET", "/api/skill", { query: { "location[directory]": directory }, directory })
    .catch(activating)) as { data?: { id: string }[] } | undefined
  return answer?.data?.map((skill) => skill.id)
}

/** Polls a project's list until `wanted` holds (a change folds every Location again, a moment later). */
async function settles(directory: string, wanted: (ids: ReadonlyArray<string>) => boolean) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ids = await listed(directory)
    if (ids && wanted(ids)) return ids
    await Bun.sleep(100)
  }
  throw new Error(`${directory}: the skills never settled (last: ${JSON.stringify(await listed(directory))})`)
}

beforeAll(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "own-e2e-skillset-"))
  const dirs = paths()
  await Promise.all([dirs.a, dirs.b].map((directory) => fs.mkdir(directory, { recursive: true })))
  await Bun.write(
    path.join(dirs.skills, SKILL, "SKILL.md"),
    `---\nname: ${SKILL}\ndescription: Notes for the e2e test\n---\n\n# Notes\n`,
  )
  fixture.server = await boot(fixture.root)
}, BOOT_TIMEOUT)

afterAll(async () => {
  await fixture.server?.stop()
  if (fixture.root) await removeTree(fixture.root)
}, 60_000)

describe("skill switches and scopes on a real service", () => {
  test("installed once, used in every project; the catalog is the control Location's", async () => {
    const dirs = paths()
    expect(await settles(dirs.a, (ids) => ids.includes(SKILL))).toContain(SKILL)
    expect(await settles(dirs.b, (ids) => ids.includes(SKILL))).toContain(SKILL)
    const view = await rpc("skillset.view", {})
    expect(view.catalog.map((skill) => skill.id)).toContain(SKILL)
  })

  test("off in A only: gone in A, still in B; the view of A says why", async () => {
    const dirs = paths()
    await settles(dirs.a, (ids) => ids.includes(SKILL))
    await rpc("skillset.switch", { changes: [{ id: SKILL, directory: dirs.a, enabled: false }] })
    // The answer comes once A's open Location folded the change: its next list has it already (core announces a
    // plugin's reload without the Location, so pages read again on the answer or the event, not on core's event).
    expect(await listed(dirs.a)).not.toContain(SKILL)
    expect(await listed(dirs.b)).toContain(SKILL)
    const view = await rpc("skillset.view", { directory: dirs.a })
    expect(view.off).toContainEqual(expect.objectContaining({ id: SKILL, by: "project" }))
  })

  test("a scope to A (이 프로젝트만): in A, gone in B", async () => {
    const dirs = paths()
    await rpc("skillset.switch", {
      changes: [{ id: SKILL, directory: dirs.a, enabled: null }],
      scopes: [{ folder: path.join(dirs.skills, SKILL), directory: dirs.a }],
    })
    await settles(dirs.a, (ids) => ids.includes(SKILL))
    await settles(dirs.b, (ids) => !ids.includes(SKILL))
    expect((await rpc("skillset.view", { directory: dirs.b })).off).toContainEqual(
      expect.objectContaining({ id: SKILL, by: "scope" }),
    )
  })

  test("off everywhere and on in A: only A has it", async () => {
    const dirs = paths()
    await rpc("skillset.switch", {
      changes: [
        { id: SKILL, enabled: false },
        { id: SKILL, directory: dirs.a, enabled: true },
      ],
      scopes: [{ folder: path.join(dirs.skills, SKILL), directory: null }],
    })
    await settles(dirs.b, (ids) => !ids.includes(SKILL))
    await settles(dirs.a, (ids) => ids.includes(SKILL))
  })

  test(
    "after a restart no list of A ever has the skill, while B gains it once its folders are read",
    async () => {
      const dirs = paths()
      // Off in A, on everywhere else.
      await rpc("skillset.switch", {
        changes: [
          { id: SKILL, enabled: null },
          { id: SKILL, directory: dirs.a, enabled: false },
        ],
      })
      await settles(dirs.a, (ids) => !ids.includes(SKILL))
      const root = server().paths.root
      await server().stop()
      fixture.server = await boot(root)
      // Every answer of both Locations from the boot on, as fast as they come (503s while plugins activate are not
      // answers). Core's first answer of a Location is empty (before its built-ins and the folders' skills are in);
      // the folders' skills come with core's `post` plugins, after own-accounts' setup registration.
      const seen: { readonly a: ReadonlyArray<string> | undefined; readonly b: ReadonlyArray<string> | undefined }[] =
        []
      const deadline = Date.now() + 60_000
      const done = () => seen.some((item) => item.b?.includes(SKILL))
      while (!done() && Date.now() < deadline) {
        const [a, b] = await Promise.all([listed(dirs.a), listed(dirs.b)])
        seen.push({ a, b })
      }
      // Two more seconds of A after B has it.
      const after = Date.now() + 2_000
      while (Date.now() < after) seen.push({ a: await listed(dirs.a), b: undefined })
      expect(done()).toBe(true)
      expect(seen.some((item) => item.a?.includes("opencode"))).toBe(true)
      expect(seen.filter((item) => item.a?.includes(SKILL))).toEqual([])
    },
    BOOT_TIMEOUT,
  )
})
