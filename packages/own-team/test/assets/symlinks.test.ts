// Link copies (06 §4.12, TG14 parts) on the F1 fixture: core.symlinks=false and three mode-120000 entries made through
// plumbing, so no real symlink and no Developer Mode. Plain areas get copies with skip-worktree as the home, code-only
// areas copies with assume-unchanged that survive sparse-checkout add/reapply/set; a folder copy is excluded so
// `add -A` never turns the link into files; the record makes edited copies visible to the one clean check; a new apply
// never overwrites a changed copy; every cone change in these tests checks Cone.endangered first.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Symlinks } from "../../src/assets/symlinks.js"
import { Cone } from "../../src/git/cone.js"
import type { Identity } from "../../src/git/identity.js"
import { F1_LINKS, f1, git, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"

const box = temp("own-team-links-")
afterAll(() => box.dispose())

/** Git process starts are slow on Windows. */
const SLOW = 180_000
const LINKS = Object.keys(F1_LINKS).toSorted()
const CODE_CONE = ["docs", "src"]

let count = 0

/** A fresh F1 home; `extra` adds more link entries (path → link text) before the first area is made. */
function home(extra: Readonly<Record<string, string>> = {}) {
  const made = f1(path.join(box.root, `r${++count}`))
  if (Object.keys(extra).length === 0) return made
  for (const [link, target] of Object.entries(extra)) {
    const oid = git(made.home, ["hash-object", "-w", "--stdin"], { stdin: target }).trim()
    git(made.home, ["update-index", "--add", "--cacheinfo", `120000,${oid},${link}`])
  }
  git(made.home, ["commit", "-q", "-m", "more links"])
  git(made.home, ["reset", "-q", "--hard"])
  return made
}

type Shape = OwnTeam.Area["shape"]

/** An area worktree of `repo`: plain (a normal checkout) or code-only (`cone`, through Cone.set + read-tree). */
async function makeArea(repo: { readonly home: string }, shape: Shape, cone: ReadonlyArray<string> = CODE_CONE) {
  const slug = `a${++count}`
  const directory = path.join(path.dirname(repo.home), slug)
  if (shape !== "code") git(repo.home, ["worktree", "add", "-q", "-b", slug, directory, "HEAD"])
  if (shape === "code") git(repo.home, ["worktree", "add", "-q", "--no-checkout", "-b", slug, directory, "HEAD"])
  const gitDir = git(directory, ["rev-parse", "--absolute-git-dir"]).trim()
  const target: Identity.Record = { directory, gitDir }
  if (shape === "code") {
    const set = await Cone.set(target, cone)
    if (!set.ok) throw new Error(set.message)
    git(directory, ["read-tree", "-mu", "HEAD"])
  }
  return { directory, gitDir, shape, target }
}

type Area = Awaited<ReturnType<typeof makeArea>>

async function apply(area: Area, fix: Symlinks.Fix = "skip-worktree", linkCopies?: Record<string, string>) {
  const applied = await Symlinks.apply({ area: { ...area, ...(linkCopies ? { linkCopies } : {}) }, fix })
  if (!applied.ok) throw new Error(applied.message)
  return applied
}

function read(directory: string, file: string) {
  return fs.readFileSync(path.join(directory, ...file.split("/")), "utf8")
}

/** `ls-files -v` tags of the F1 links (`S` skip-worktree, `h` assume-unchanged). */
function tags(directory: string, files: ReadonlyArray<string> = LINKS) {
  return Object.fromEntries(
    git(directory, ["-c", "advice.sparseIndexExpanded=false", "ls-files", "-v", "-z", "--", ...files])
      .split("\0")
      .filter(Boolean)
      .map((line) => [line.slice(2), line[0]]),
  )
}

function status(directory: string) {
  return git(directory, ["-c", "advice.sparseIndexExpanded=false", "status", "--porcelain=v2", "-z", "-uall"])
}

/** What `git add -A` would stage, without staging it. */
function addAll(directory: string) {
  return git(directory, ["-c", "advice.sparseIndexExpanded=false", "add", "-A", "--dry-run"])
}

function copiesIntact(directory: string) {
  expect(read(directory, "README-link.md")).toBe("# F1\n")
  expect(read(directory, "docs/guide-link.md")).toBe("guide\n")
  expect(read(directory, "src/app/lib/util.ts")).toBe("export const util = 2\n")
}

/** A cone change the way own makes one: only when Cone.endangered finds nothing (06 §4.9, T1 review #12). */
async function guarded(area: Area, next: ReadonlyArray<string>, change: () => Promise<Cone.Changed>) {
  const risky = await Cone.endangered(area.directory, next)
  if (!risky.ok) throw new Error(risky.message)
  if (risky.dirs.length > 0) return { ran: false as const, endangered: risky.dirs }
  const changed = await change()
  if (!changed.ok) throw new Error(changed.message)
  return { ran: true as const }
}

describe("Symlinks.detect (06 §3.2, §4.12)", () => {
  test(
    "git's link files are `none`; the home's copies give their flag",
    async () => {
      const repo = home()
      expect(await Symlinks.detect(repo.home)).toEqual({ ok: true, fix: "none" })
      // As this user's home: the targets copied over the links, marked skip-worktree (FORK §11).
      fs.rmSync(path.join(repo.home, "src", "app", "lib"))
      fs.cpSync(path.join(repo.home, "src", "lib"), path.join(repo.home, "src", "app", "lib"), { recursive: true })
      fs.copyFileSync(path.join(repo.home, "README.md"), path.join(repo.home, "README-link.md"))
      git(repo.home, ["update-index", "--skip-worktree", ...LINKS])
      expect(await Symlinks.detect(repo.home)).toEqual({ ok: true, fix: "skip-worktree" })
      git(repo.home, ["update-index", "--no-skip-worktree", ...LINKS])
      git(repo.home, ["update-index", "--assume-unchanged", ...LINKS])
      expect(await Symlinks.detect(repo.home)).toEqual({ ok: true, fix: "assume-unchanged" })
      const plain = home({})
      git(plain.home, ["rm", "-q", "--cached", ...LINKS])
      git(plain.home, ["commit", "-q", "-m", "no links"])
      expect(await Symlinks.detect(plain.home)).toEqual({ ok: true, fix: "none" })
    },
    SLOW,
  )

  test("the flag of an area: plain as the home, code-only always assume-unchanged, none without copies", () => {
    expect(Symlinks.flag("plain", "skip-worktree")).toBe("skip-worktree")
    expect(Symlinks.flag("full", "assume-unchanged")).toBe("assume-unchanged")
    expect(Symlinks.flag("code", "skip-worktree")).toBe("assume-unchanged")
    expect(Symlinks.flag("plain", "none")).toBeUndefined()
    expect(Symlinks.flag("code", "symlinks")).toBeUndefined()
  })
})

describe("Symlinks.apply on a plain area", () => {
  test(
    "copies with skip-worktree, recorded; status is empty and add -A stages nothing (no type change)",
    async () => {
      const repo = home()
      const area = await makeArea(repo, "plain")
      expect(read(area.directory, "README-link.md")).toBe("README.md")

      const applied = await apply(area)

      expect(applied).toMatchObject({ written: LINKS, kept: [], skipped: [] })
      copiesIntact(area.directory)
      expect(tags(area.directory)).toEqual(Object.fromEntries(LINKS.map((file) => [file, "S"])))
      expect(status(area.directory)).toBe("")
      expect(addAll(area.directory)).toBe("")
      git(area.directory, ["add", "-A"])
      expect(git(area.directory, ["diff", "--cached", "--name-status"])).toBe("")
      expect(applied.linkCopies["README-link.md"]).toBe(git(area.directory, ["hash-object", "README-link.md"]).trim())
      expect(applied.linkCopies["docs/guide-link.md"]).toBe(
        git(area.directory, ["hash-object", "docs/guide-link.md"]).trim(),
      )
      expect(applied.linkCopies["src/app/lib"]).toMatch(/^[0-9a-f]{40}$/)
      expect(await Symlinks.dirtyCopies({ directory: area.directory, linkCopies: applied.linkCopies })).toEqual([])

      // The folder copy is excluded once, in the common dir, under own's header.
      const exclude = fs.readFileSync(path.join(repo.home, ".git", "info", "exclude"), "utf8")
      expect(exclude.split("\n").filter((line) => line === "/src/app/lib/")).toHaveLength(1)
      expect(exclude).toContain(Symlinks.EXCLUDE_HEADER)
      const again = await apply(area, "skip-worktree", { ...applied.linkCopies })
      expect(again).toMatchObject({ written: [], kept: [], skipped: [], linkCopies: applied.linkCopies })
      expect(fs.readFileSync(path.join(repo.home, ".git", "info", "exclude"), "utf8")).toBe(exclude)
    },
    SLOW,
  )

  test(
    "dirtyCopies sees what status cannot: an edited copy, a new file in a folder copy, a removed copy",
    async () => {
      const area = await makeArea(home(), "plain")
      const applied = await apply(area)
      const copies = { directory: area.directory, linkCopies: applied.linkCopies }
      write(area.directory, { "README-link.md": "edited copy\n", "src/app/lib/new.ts": "agent work\n" })
      // The flags and the exclude blind git (06 §4.12, [R-review] e1).
      expect(status(area.directory)).toBe("")

      expect(await Symlinks.dirtyCopies(copies)).toEqual([
        { path: "README-link.md", why: "changed" },
        { path: "src/app/lib", why: "changed" },
      ])
      expect(await Symlinks.dirtyCopies(copies, ["src"])).toEqual([{ path: "src/app/lib", why: "changed" }])
      expect(await Symlinks.dirtyCopies(copies, ["tools"])).toEqual([])
      fs.rmSync(path.join(area.directory, "docs", "guide-link.md"))
      expect(await Symlinks.dirtyCopies(copies, ["docs"])).toEqual([{ path: "docs/guide-link.md", why: "gone" }])
      expect(await Symlinks.files(area.directory, ["README-link.md", "src/app/lib", "docs/guide-link.md"])).toEqual([
        "README-link.md",
        "src/app/lib/new.ts",
        "src/app/lib/util.ts",
      ])
    },
    SLOW,
  )

  test(
    "applying again never overwrites a changed copy; a clean copy follows its target after a sync",
    async () => {
      const area = await makeArea(home(), "plain")
      const first = await apply(area)
      write(area.directory, { "README-link.md": "my edit\n", "docs/guide.md": "guide v2\n" })
      git(area.directory, ["commit", "-q", "-am", "sync: a new guide"])

      const second = await apply(area, "skip-worktree", { ...first.linkCopies })

      expect(second).toMatchObject({ written: ["docs/guide-link.md"], kept: ["README-link.md"], skipped: [] })
      expect(read(area.directory, "README-link.md")).toBe("my edit\n")
      expect(read(area.directory, "docs/guide-link.md")).toBe("guide v2\n")
      // The changed copy keeps the old record, so it stays dirty for every clean check.
      expect(second.linkCopies["README-link.md"]).toBe(first.linkCopies["README-link.md"])
      expect(second.linkCopies["docs/guide-link.md"]).not.toBe(first.linkCopies["docs/guide-link.md"])
      expect(await Symlinks.dirtyCopies({ directory: area.directory, linkCopies: second.linkCopies })).toEqual([
        { path: "README-link.md", why: "changed" },
      ])
      expect(status(area.directory)).toBe("")
    },
    SLOW,
  )

  test(
    "a copy the user made already (equal to its target) is adopted, not written; other content is kept as dirty",
    async () => {
      const area = await makeArea(home(), "plain")
      fs.copyFileSync(path.join(area.directory, "README.md"), path.join(area.directory, "README-link.md"))
      write(area.directory, { "docs/guide-link.md": "someone's notes\n" })
      git(area.directory, ["update-index", "--skip-worktree", "docs/guide-link.md"])

      const applied = await apply(area)

      expect(applied).toMatchObject({ written: ["src/app/lib"], kept: ["docs/guide-link.md"] })
      expect(read(area.directory, "docs/guide-link.md")).toBe("someone's notes\n")
      // Never written by own: recorded with the link blob, so it counts as dirty until someone looks at it.
      expect(applied.linkCopies["docs/guide-link.md"]).toBe(
        git(area.directory, ["rev-parse", "HEAD:docs/guide-link.md"]).trim(),
      )
      expect(tags(area.directory, ["README-link.md"])).toEqual({ "README-link.md": "S" })
      expect(
        (await Symlinks.dirtyCopies({ directory: area.directory, linkCopies: applied.linkCopies })).map(
          (item) => item.path,
        ),
      ).toEqual(["docs/guide-link.md"])
    },
    SLOW,
  )

  test(
    "the identity check runs first: a folder that is not the recorded worktree is refused, nothing is written",
    async () => {
      const repo = home()
      const area = await makeArea(repo, "plain")
      const other = await makeArea(repo, "plain")
      const refused = await Symlinks.apply({ area: { ...area, gitDir: other.gitDir }, fix: "skip-worktree" })
      expect(refused).toMatchObject({ ok: false, error: "broken", broken: "identity" })
      expect(read(area.directory, "README-link.md")).toBe("README.md")
      expect(tags(area.directory)).toEqual(Object.fromEntries(LINKS.map((file) => [file, "H"])))
    },
    SLOW,
  )

  test(
    "a home without copies (none) or with real links (symlinks): nothing is written",
    async () => {
      const area = await makeArea(home(), "plain")
      for (const fix of ["none", "symlinks"] as const)
        expect(await Symlinks.apply({ area, fix })).toEqual({
          ok: true,
          linkCopies: {},
          written: [],
          kept: [],
          skipped: [],
        })
      expect(read(area.directory, "README-link.md")).toBe("README.md")
    },
    SLOW,
  )
})

describe("Symlinks.apply on a code-only area", () => {
  test(
    "copies with assume-unchanged survive sparse-checkout add, reapply and set; status stays empty",
    async () => {
      const area = await makeArea(home(), "code")
      expect(fs.existsSync(path.join(area.directory, "tools"))).toBe(false)
      const applied = await apply(area, "skip-worktree")
      expect(applied).toMatchObject({ written: LINKS, kept: [], skipped: [] })

      const check = async () => {
        copiesIntact(area.directory)
        expect(tags(area.directory)).toEqual(Object.fromEntries(LINKS.map((file) => [file, "h"])))
        expect(status(area.directory)).toBe("")
        expect(addAll(area.directory)).toBe("")
        expect(await Symlinks.dirtyCopies({ directory: area.directory, linkCopies: applied.linkCopies })).toEqual([])
      }
      await check()
      expect(await guarded(area, [...CODE_CONE, "tools"], () => Cone.add(area.target, ["tools"]))).toEqual({
        ran: true,
      })
      expect(fs.existsSync(path.join(area.directory, "tools", "build.ts"))).toBe(true)
      await check()
      expect(await guarded(area, [...CODE_CONE, "tools"], () => Cone.reapply(area.target))).toEqual({ ran: true })
      await check()
      expect(await guarded(area, CODE_CONE, () => Cone.set(area.target, CODE_CONE))).toEqual({ ran: true })
      expect(fs.existsSync(path.join(area.directory, "tools"))).toBe(false)
      await check()
      git(area.directory, ["add", "-A"])
      expect(git(area.directory, ["diff", "--cached", "--name-status"])).toBe("")
    },
    SLOW,
  )

  test(
    "no cone change runs while Cone.endangered lists a folder; the copies and the ignored output stay",
    async () => {
      const repo = home()
      const area = await makeArea(repo, "code")
      await apply(area)
      fs.appendFileSync(path.join(repo.home, ".git", "info", "exclude"), "*.log\n")
      // A build output in a folder the cone folds: git would delete the folder on the next cone change.
      write(area.directory, { "tools/out.log": "build output\n" })

      const refused = await guarded(area, [...CODE_CONE, "-dash"], () => Cone.add(area.target, ["-dash"]))

      expect(refused).toEqual({ ran: false, endangered: ["tools"] })
      expect(read(area.directory, "tools/out.log")).toBe("build output\n")
      expect(await Cone.list(area.directory)).toEqual({ ok: true, dirs: CODE_CONE })
      copiesIntact(area.directory)
    },
    SLOW,
  )

  test(
    "links leaving the repository, into other links, or to folders outside the cone get no copy",
    async () => {
      const repo = home({
        "docs/escape.md": "../../outside.md",
        "docs/chain.md": "guide-link.md",
        "src/tool.ts": "../tools/build.ts",
        "docs/self": "../docs",
      })
      const code = await makeArea(repo, "code")
      const applied = await apply(code)
      expect(applied.written).toEqual(LINKS)
      expect(applied.skipped.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "docs/chain.md", why: "chain" },
        { path: "docs/escape.md", why: "outside" },
        { path: "docs/self", why: "chain" },
        { path: "src/tool.ts", why: "target-missing" },
      ])
      expect(read(code.directory, "src/tool.ts")).toBe("../tools/build.ts")
      expect(status(code.directory)).toBe("")
      // In a plain area the target is on disk.
      const plain = await makeArea(repo, "plain")
      const all = await apply(plain)
      expect(all.written).toContain("src/tool.ts")
      expect(read(plain.directory, "src/tool.ts")).toBe("export {}\n")
      expect(status(plain.directory)).toBe("")
    },
    SLOW,
  )
})

describe("the link-fix step", () => {
  const h = controller(new World(), { directory: box.root, clock: manual() })
  afterAll(() => h.close())

  test(
    "records the copies in the area and keeps a link.copy.dirty notice open while a copy is kept",
    async () => {
      const repo = home()
      const made = await makeArea(repo, "plain")
      Symlinks.register(h.services)
      const record: OwnTeam.Area = { ...area({ slug: "links", directory: made.directory }), gitDir: made.gitDir }
      await h.services.write(TEAM_ID, async () => {
        await h.services.registry.teams.put({
          ...team({ home: repo.home }),
          env: { symlinkFix: "skip-worktree", bunCache: "unused", lfs: "unused" },
        })
        await h.services.registry.areas.put(record)
      })
      const run = async () => {
        const started = await h.services.runner.start({
          teamID: TEAM_ID,
          kind: "paths",
          by: "auto",
          areaID: record.id,
          steps: [Symlinks.spec({ areaID: record.id })],
        })
        if (!started.ok) throw new Error("busy")
        await h.services.runner.settled(started.op.id)
        return (await h.services.journal.get(TEAM_ID, started.op.id))!
      }
      const open = async () =>
        (await h.services.notices.open(TEAM_ID)).filter((item) => item.kind === "link.copy.dirty")

      expect((await run()).state).toBe("done")
      const stored = (await h.services.registry.areas.get(TEAM_ID, record.id))!
      expect(Object.keys(stored.linkCopies ?? {}).toSorted()).toEqual(LINKS)
      copiesIntact(made.directory)
      expect(await open()).toEqual([])

      write(made.directory, { "README-link.md": "edited\n" })
      expect((await run()).state).toBe("done")
      expect(read(made.directory, "README-link.md")).toBe("edited\n")
      expect(await open()).toMatchObject([{ areaID: record.id, data: { count: 1, paths: "README-link.md" } }])
      expect(h.published.some((event) => event.name === "notice" && event.data.kind === "link.copy.dirty")).toBe(true)

      // Put back as the target: the copy is own's again and the notice closes.
      fs.copyFileSync(path.join(made.directory, "README.md"), path.join(made.directory, "README-link.md"))
      expect((await run()).state).toBe("done")
      expect(await open()).toEqual([])
    },
    SLOW,
  )
})
