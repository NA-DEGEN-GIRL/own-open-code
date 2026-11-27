// Git 저장소로 만들기 (06 §3.0) over temp folders: the plan reads without writing, `git init -b main` keeps the project id
// in `.git/opencode`, the first commit takes the proposed `.gitignore` and leaves out large and binary files unless
// picked and repositories inside always, an identity is never made up, and a failed commit takes back what the call
// made. The RPC group runs against a fake own service (self-HTTP `location.get` before and after, `evict` between).
// git's global settings point at a temp file and the system file is hidden, so this PC's configuration changes nothing.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { GitInit } from "../../src/git/init.js"
import { ProjectRpc } from "../../src/rpc/project.js"
import { SessionHttp } from "../../src/sessions/http.js"
import type { Services } from "../../src/services.js"
import { git, init, temp } from "../fixtures/repo.js"
import { start, type FakeService } from "../support/service.js"

// Each case starts a dozen git processes (slow to start on Windows).
setDefaultTimeout(30_000)

const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM }
const box = temp("own-git-init-")
const config = path.join(box.root, "gitconfig")
const OWN_HOME = path.join(box.root, "own-home")
const IDENTITY = "[user]\n\tname = Init Test\n\temail = init@example.invalid\n"

beforeAll(() => {
  fs.mkdirSync(OWN_HOME)
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = "1"
})
afterAll(() => {
  restore("GIT_CONFIG_GLOBAL", saved.global)
  restore("GIT_CONFIG_NOSYSTEM", saved.nosystem)
  box.dispose()
})

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

let counter = 0
/** A project folder that is not a repository: code, a dependency folder, a large and a binary file, a repo inside. */
function project() {
  fs.writeFileSync(config, IDENTITY + "[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n")
  const dir = path.join(box.root, `project-${++counter}`)
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n")
  fs.writeFileSync(path.join(dir, "src", "main.c"), "int main(void) { return 0; }\n")
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true })
  fs.writeFileSync(path.join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
  fs.mkdirSync(path.join(dir, "bios"))
  // Large: 11 MB of text. Binary: 1.5 MB with NUL bytes (a BIOS image of this user's kind, smaller).
  fs.writeFileSync(path.join(dir, "bios", "notes.txt"), "a".repeat(11 * 1024 * 1024))
  fs.writeFileSync(path.join(dir, "bios", "BOARD.CAP"), Buffer.alloc(1536 * 1024, 0))
  init(path.join(dir, "tools", "UEFITool"))
  fs.writeFileSync(path.join(dir, "tools", "UEFITool", "x.txt"), "x\n")
  return dir
}

const listing = (dir: string) =>
  fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((item) => item.replaceAll("\\", "/"))
    .sort()

const tree = (dir: string) => git(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n").filter(Boolean)

describe("plan", () => {
  test("reads the folder, git's identity, the proposal and what a first commit would take; writes nothing", async () => {
    const dir = project()
    const before = listing(dir)
    const planned = await GitInit.plan({ directory: dir, home: OWN_HOME })
    if (!planned.ok) throw new Error(planned.message)
    const plan = planned.plan
    expect(plan).toMatchObject({
      directory: dir,
      state: "none",
      branch: "main",
      identity: { name: "Init Test", email: "init@example.invalid" },
      gitignore: { exists: false, proposal: GitInit.PROPOSAL },
      limits: { largeBytes: GitInit.LARGE_BYTES, binaryBytes: GitInit.BINARY_BYTES },
    })
    if (plan.files.kind !== "listed") throw new Error("expected a listing")
    // README, main.c and the two bios files; node_modules is the proposal's; the repository inside is listed apart.
    expect(plan.files.total.count).toBe(4)
    expect(plan.files.proposal).toEqual({ count: 1, bytes: "module.exports = 1\n".length })
    expect(plan.files.proposalRequired).toBe(false)
    expect(plan.files.nested).toEqual(["tools/UEFITool/"])
    expect(plan.files.flagged.map((item) => [item.path, item.binary])).toEqual([
      ["bios/BOARD.CAP", true],
      ["bios/notes.txt", false],
    ])
    expect(plan.files.largest[0]).toMatchObject({ path: "bios/notes.txt", bytes: 11 * 1024 * 1024, ignored: false })
    expect(plan.files.largest.find((item) => item.path.startsWith("node_modules/"))?.ignored).toBe(true)
    expect(listing(dir)).toEqual(before)
  })

  test("a folder with its own .gitignore: the proposal is not applied", async () => {
    const dir = project()
    fs.writeFileSync(path.join(dir, ".gitignore"), "bios/\n")
    const planned = await GitInit.plan({ directory: dir, home: OWN_HOME })
    if (!planned.ok || planned.plan.files.kind !== "listed") throw new Error("expected a listing")
    expect(planned.plan.gitignore.exists).toBe(true)
    // README, main.c, .gitignore and node_modules/left-pad/index.js.
    expect(planned.plan.files.total.count).toBe(4)
    expect(planned.plan.files.proposal).toEqual({ count: 0, bytes: 0 })
    expect(planned.plan.files.flagged).toEqual([])
  })

  test("no identity: both null, never made up", async () => {
    const dir = project()
    fs.writeFileSync(config, "")
    const planned = await GitInit.plan({ directory: dir, home: OWN_HOME })
    if (!planned.ok) throw new Error(planned.message)
    expect(planned.plan.identity).toEqual({ name: null, email: null })
  })
})

describe("refusals", () => {
  test("a repository with commits, a folder inside another repository (its top level), a system folder", async () => {
    const repo = init(path.join(box.root, `repo-${++counter}`))
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n")
    git(repo, ["add", "a.txt"])
    git(repo, ["commit", "-q", "-m", "a"])
    const inner = path.join(repo, "inner")
    fs.mkdirSync(inner)
    const refusal = async (directory: string) => {
      const planned = await GitInit.plan({ directory, home: OWN_HOME })
      return planned.ok ? undefined : planned.data
    }
    expect(await refusal(repo)).toEqual({ why: "exists", parent: null })
    const inside = await refusal(inner)
    expect(inside).toMatchObject({ why: "inside" })
    expect(path.resolve((inside as { parent: string }).parent)).toBe(path.resolve(repo))
    expect(await refusal(os.homedir())).toEqual({ why: "system", parent: null })
    expect(await refusal(path.parse(box.root).root)).toEqual({ why: "system", parent: null })
    expect(await refusal(OWN_HOME)).toEqual({ why: "system", parent: null })
    expect(await refusal(path.join(box.root, "missing"))).toEqual({
      what: "directory",
      id: path.join(box.root, "missing"),
    })
    // Nothing was written into the refused folders.
    expect(fs.existsSync(path.join(inner, ".git"))).toBe(false)
    expect(fs.existsSync(path.join(OWN_HOME, ".git"))).toBe(false)
  })

  test("system(): roots, the home folder and above, the OS folders; an ordinary folder is not", () => {
    expect(GitInit.system(os.homedir())).toBe(true)
    expect(GitInit.system(path.dirname(os.homedir()))).toBe(true)
    expect(GitInit.system(path.parse(box.root).root)).toBe(true)
    expect(GitInit.system(os.tmpdir())).toBe(true)
    if (process.platform === "win32") {
      expect(GitInit.system(path.join(process.env.SystemRoot ?? "C:\\Windows", "x"))).toBe(true)
      expect(GitInit.system(path.join(os.homedir(), "AppData"))).toBe(true)
    } else {
      expect(GitInit.system("/usr/lib/x")).toBe(true)
      expect(GitInit.system("/var")).toBe(true)
      expect(GitInit.system("/var/www/site")).toBe(false)
    }
    expect(GitInit.system(path.join(box.root, "project"))).toBe(false)
  })
})

describe("run", () => {
  test("init only: .git on branch main with the project id kept; no file changed, no commit", async () => {
    const dir = project()
    const before = listing(dir)
    const ran = await GitInit.run({ directory: dir, home: OWN_HOME, project: async () => "prj_dir_hash" })
    if (!ran.ok) throw new Error(ran.message)
    expect(ran.result).toEqual({
      directory: dir,
      branch: "main",
      commit: null,
      committed: null,
      excluded: 0,
      gitignore: "none",
    })
    expect(git(dir, ["symbolic-ref", "HEAD"]).trim()).toBe("refs/heads/main")
    expect(fs.readFileSync(path.join(dir, ".git", "opencode"), "utf8")).toBe("prj_dir_hash")
    expect(listing(dir).filter((item) => item !== ".git" && !item.startsWith(".git/"))).toEqual(before)
    // A second init is refused; the repository without a commit can still get its first one (`unborn`).
    const again = await GitInit.run({ directory: dir, home: OWN_HOME })
    expect(again.ok ? undefined : again.data).toEqual({ why: "exists", parent: null })
    const planned = await GitInit.plan({ directory: dir, home: OWN_HOME })
    expect(planned.ok && planned.plan.state).toBe("unborn")
    const committed = await GitInit.run({
      directory: dir,
      home: OWN_HOME,
      firstCommit: { gitignore: true, include: [] },
    })
    if (!committed.ok) throw new Error(committed.message)
    expect(committed.result.commit).toMatch(/^[0-9a-f]{40,64}$/)
  })

  test("the `global` id is never kept", async () => {
    const dir = project()
    const ran = await GitInit.run({ directory: dir, home: OWN_HOME, project: async () => "global" })
    expect(ran.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, ".git", "opencode"))).toBe(false)
  })

  test("first commit: the proposed .gitignore, flagged files only when picked, never a repository inside", async () => {
    const dir = project()
    const ran = await GitInit.run({
      directory: dir,
      home: OWN_HOME,
      firstCommit: { gitignore: true, include: ["bios/BOARD.CAP"] },
    })
    if (!ran.ok) throw new Error(ran.message)
    expect(ran.result).toMatchObject({ branch: "main", gitignore: "written", excluded: 2 })
    expect(ran.result.committed?.count).toBe(4)
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(GitInit.PROPOSAL)
    expect(tree(dir).sort()).toEqual([".gitignore", "README.md", "bios/BOARD.CAP", "src/main.c"])
    expect(git(dir, ["log", "-1", "--format=%an <%ae>|%s"]).trim()).toBe(
      "Init Test <init@example.invalid>|Initial commit",
    )
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main")
    // The large file stays in the folder, untracked; the repository inside is untouched.
    expect(fs.statSync(path.join(dir, "bios", "notes.txt")).size).toBe(11 * 1024 * 1024)
    expect(git(path.join(dir, "tools", "UEFITool"), ["status", "--porcelain"]).trim()).toBe("?? x.txt")
  })

  test("an existing .gitignore is kept as it is", async () => {
    const dir = project()
    fs.writeFileSync(path.join(dir, ".gitignore"), "bios/\nnode_modules/\n")
    const ran = await GitInit.run({ directory: dir, home: OWN_HOME, firstCommit: { gitignore: true, include: [] } })
    if (!ran.ok) throw new Error(ran.message)
    expect(ran.result.gitignore).toBe("kept")
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("bios/\nnode_modules/\n")
    expect(tree(dir).sort()).toEqual([".gitignore", "README.md", "src/main.c"])
  })

  test("missing identity: refused before anything is written; a typed one goes into this repository only", async () => {
    const dir = project()
    fs.writeFileSync(config, "")
    const refused = await GitInit.run({
      directory: dir,
      home: OWN_HOME,
      firstCommit: { gitignore: false, include: [] },
    })
    expect(refused.ok ? undefined : refused.error).toBe("identity_missing")
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false)
    const ran = await GitInit.run({
      directory: dir,
      home: OWN_HOME,
      firstCommit: { gitignore: false, include: [], identity: { name: "나 데모", email: "demo@example.invalid" } },
    })
    if (!ran.ok) throw new Error(ran.message)
    expect(git(dir, ["config", "--local", "user.name"]).trim()).toBe("나 데모")
    expect(git(dir, ["log", "-1", "--format=%ae"]).trim()).toBe("demo@example.invalid")
    expect(fs.readFileSync(config, "utf8")).toBe("")
    // Without the proposal node_modules is committed; the flagged files still are not.
    expect(tree(dir)).toContain("node_modules/left-pad/index.js")
    expect(tree(dir)).not.toContain("bios/notes.txt")
  })

  test("a failed commit takes back the new .git and the written .gitignore; the files stay as they were", async () => {
    const dir = project()
    const hooks = path.join(box.root, `hooks-${counter}`)
    fs.mkdirSync(hooks)
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\necho refused by hook >&2\nexit 1\n", { mode: 0o755 })
    fs.appendFileSync(config, `[core]\n\thooksPath = ${hooks.replaceAll("\\", "/")}\n`)
    const before = listing(dir)
    const ran = await GitInit.run({ directory: dir, home: OWN_HOME, firstCommit: { gitignore: true, include: [] } })
    expect(ran.ok ? undefined : { error: ran.error, step: (ran.data as { step: string }).step }).toEqual({
      error: "git_failed",
      step: "commit",
    })
    expect(listing(dir)).toEqual(before)
  })
})

describe("RPC project.gitInit* (fake own service)", () => {
  let service: FakeService
  beforeAll(() => {
    service = start()
  })
  afterAll(() => service.stop())

  function rpc() {
    const services: Pick<Services.Context, "home" | "http"> = {
      home: OWN_HOME,
      http: SessionHttp.create({ source: service.source }),
    }
    // SAFETY (test): each handler takes its method's input and `{signal, error}`; `error` returns what it answers.
    const loose = ProjectRpc.handlers(services) as unknown as Record<
      string,
      (input: unknown, context: unknown) => Promise<unknown>
    >
    return (method: ProjectRpc.Methods, input: unknown) =>
      loose[method]!(input, {
        signal: new AbortController().signal,
        error: (type: string, message: string, data: unknown) => ({ type, message, data }),
      })
  }

  test("reads the project before init, keeps it, then drops and reads the folder's Location again", async () => {
    const dir = project()
    service.requests.length = 0
    const ids = ["prj_markerless", "prj_markerless"]
    service.routes.set("GET /api/location", (request) =>
      Response.json({ directory: request.query["location[directory]"], project: { id: ids.shift() } }),
    )
    service.routes.set("DELETE /api/debug/location", () => new Response(null, { status: 204 }))
    const result = (await rpc()("project.gitInit", { directory: dir })) as OwnTeam.GitInitResult
    expect(result).toMatchObject({ branch: "main", commit: null, projectID: "prj_markerless" })
    expect(fs.readFileSync(path.join(dir, ".git", "opencode"), "utf8")).toBe("prj_markerless")
    expect(service.requests.map((item) => `${item.method} ${item.path} ${item.query["location[directory]"]}`)).toEqual([
      `GET /api/location ${dir}`,
      `DELETE /api/debug/location ${dir}`,
      `GET /api/location ${dir}`,
    ])
  })

  test("a refused folder is never made a Location; a service that cannot answer leaves projectID null", async () => {
    service.requests.length = 0
    const refused = await rpc()("project.gitInit", { directory: os.homedir() })
    expect(refused).toMatchObject({ type: "git_init_refused", data: { why: "system" } })
    expect(service.requests).toEqual([])
    service.routes.delete("GET /api/location")
    const dir = project()
    const result = (await rpc()("project.gitInit", { directory: dir })) as OwnTeam.GitInitResult
    expect(result.projectID).toBeNull()
    expect(fs.existsSync(path.join(dir, ".git", "opencode"))).toBe(false)
  })

  test("the plan answers the same refusals as declared errors", async () => {
    const planned = await rpc()("project.gitInit.plan", { directory: path.join(box.root, "nowhere") })
    expect(planned).toMatchObject({ type: "not_found", data: { what: "directory" } })
  })
})
