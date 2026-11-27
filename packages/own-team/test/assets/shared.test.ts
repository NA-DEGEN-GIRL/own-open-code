// Shared untracked folders (06 §4.11, TG18 Windows half) on the F1 fixture with ignored `weights/`, `data/` and
// `node_modules/`: junctions made with Bun fs from this process (no administrator, no Developer Mode), the `/weights`
// line through the same serialized info/exclude writer as link copies, the protect step that only a confirm runs (the
// deny ACE goes on temp fixture folders only and comes off in teardown with `icacls /remove:d`), relinking only where
// lstat says ENOENT, the lasting link.blocked notice, and unlink that never follows a link. The Linux branch (symlink,
// chmod -R a-w) runs on dev-host (T3.17) and is skipped elsewhere.

import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { OwnTeam } from "@own/protocol"
import { Shared } from "../../src/assets/shared.js"
import { Symlinks } from "../../src/assets/symlinks.js"
import type { Steps } from "../../src/ops/steps.js"
import { f1, files, git, status, temp, write } from "../fixtures/repo.js"
import { manual } from "../support/clock.js"
import { TEAM_ID, World, area, controller, team } from "../support/context.js"

const box = temp("own-team-shared-")
/** Every original a test protected: its protection comes off before the temp folder goes. */
const guarded = new Set<string>()
afterAll(async () => {
  await Promise.all([...guarded].map((target) => Shared.unprotect(target, Shared.PROTECT)))
  box.dispose()
})

/** Git process starts and icacls are slow on Windows. */
const SLOW = 180_000
const WINDOWS = process.platform === "win32"
const LINUX = process.platform === "linux"
const ORIGINAL = ["model.bin", "sub/more.bin"]

let count = 0

/** F1 with ignored `weights/`, `data/`, `node_modules/` (the trailing `/` a user writes) and their folders on disk. */
function makeHome() {
  const made = f1(path.join(box.root, `r${++count}`))
  write(made.home, { ".gitignore": "weights/\ndata/\nnode_modules/\n" })
  git(made.home, ["add", ".gitignore"])
  git(made.home, ["commit", "-q", "-m", "ignore"])
  write(made.home, {
    "weights/model.bin": "W1",
    "weights/sub/more.bin": "W2",
    "data/set/a.csv": "a\n",
    "node_modules/x/index.js": "x\n",
  })
  return made.home
}

/** A plain area worktree of `home` and its record (the recorded git dir is the identity, 06 §4.3). */
function makeArea(home: string): OwnTeam.Area {
  const slug = `a${++count}`
  const directory = path.join(path.dirname(home), slug)
  git(home, ["worktree", "add", "-q", "-b", slug, directory, "HEAD"])
  return { ...area({ slug, directory }), gitDir: git(directory, ["rev-parse", "--absolute-git-dir"]).trim() }
}

/** A controller of its own (the registry and notices start empty). */
function harness() {
  return controller(new World(), { directory: box.root, clock: manual() })
}

type Harness = ReturnType<typeof harness>

async function setup(
  h: Harness,
  input: {
    readonly home: string
    readonly areas: ReadonlyArray<OwnTeam.Area>
    readonly shared?: ReadonlyArray<OwnTeam.Shared>
  },
) {
  Shared.register(h.services)
  await h.services.write(TEAM_ID, async () => {
    await h.services.registry.teams.put({ ...team({ home: input.home }), shared: [...(input.shared ?? [])] })
    await Promise.all(input.areas.map((item) => h.services.registry.areas.put(item)))
  })
}

/** A recorded share whose protection the test does not need (relinking never looks at it). */
function record(home: string, name = "weights"): OwnTeam.Shared {
  return { name, target: path.join(home, ...name.split("/")), protect: Shared.PROTECT }
}

async function start(h: Harness, steps: ReadonlyArray<Steps.Spec>) {
  const started = await h.services.runner.start({ teamID: TEAM_ID, kind: "reorg", by: "user", steps })
  if (!started.ok) throw new Error("busy")
  await h.services.runner.settled(started.op.id)
  return (await h.services.journal.get(TEAM_ID, started.op.id))!
}

async function answer(h: Harness, op: OwnTeam.Op, stepID: string, choice: "do" | "skip") {
  const nonce = op.steps.find((item) => item.id === stepID)?.confirm?.nonce
  if (!nonce) throw new Error(`step ${stepID} does not wait for a confirm`)
  const answered = await h.services.runner.confirm({ opID: op.id, stepID, choice, nonce })
  if (!answered.ok) throw new Error(answered.message)
  await h.services.runner.settled(op.id)
  return (await h.services.journal.get(TEAM_ID, op.id))!
}

function stepOf(op: OwnTeam.Op, id: string) {
  return op.steps.find((item) => item.id === id)
}

function relink(h: Harness, item: OwnTeam.Area) {
  return Shared.relink(h.services, { teamID: TEAM_ID, areaID: item.id })
}

async function blockedNotices(h: Harness) {
  return (await h.services.notices.open(TEAM_ID)).filter((item) => item.kind === "link.blocked")
}

function published(h: Harness) {
  return h.published.filter((event) => event.name === "notice" && event.data.kind === "link.blocked").length
}

function excludeText(home: string) {
  return fs.readFileSync(path.join(home, ".git", "info", "exclude"), "utf8")
}

function same(a: string, b: string) {
  return WINDOWS ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
}

function isLink(at: string) {
  return fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() === true
}

/** Git for Windows' bash next to the git on PATH (never WSL's `bash.exe`); `undefined` elsewhere or when missing. */
function gitBash() {
  if (!WINDOWS) return undefined
  const candidate = path.resolve(git(box.root, ["--exec-path"]).trim(), "..", "..", "..", "usr", "bin", "bash.exe")
  return fs.existsSync(candidate) ? candidate : undefined
}

/** `rm -rf <name>/`: with the trailing `/` it follows the link into the original (06 §4.11 위험). */
function rmThroughLink(directory: string, name: string) {
  const bash = LINUX ? "bash" : gitBash()
  if (!bash) return false
  Bun.spawnSync([bash, "-c", `${LINUX ? "rm" : "/usr/bin/rm"} -rf ${name}/`], {
    cwd: directory,
    stdout: "ignore",
    stderr: "ignore",
  })
  return true
}

describe("Shared.check (V8 again, right before linking)", () => {
  test(
    "an ignored untracked folder of the main folder passes; tracked, not ignored, tool caches, bad paths and links do not",
    async () => {
      const home = makeHome()
      write(home, { "scratch/x.txt": "x" })
      expect(await Shared.check({ home, name: "weights" })).toEqual({
        ok: true,
        name: "weights",
        target: path.join(home, "weights"),
      })
      expect(await Shared.check({ home, name: "./data/set/" })).toMatchObject({ ok: true, name: "data/set" })
      const why = async (name: string) => {
        const checked = await Shared.check({ home, name })
        return checked.ok ? "ok" : checked.why
      }
      expect(await why("src")).toBe("tracked")
      expect(await why("scratch")).toBe("not-ignored")
      expect(await why("node_modules")).toBe("cache")
      expect(await why("data/missing")).toBe("missing")
      expect(await why("../weights")).toBe("path")
      expect(await why("C:/elsewhere/weights")).toBe("path")
      expect(await why(".git")).toBe("path")
      // An original that is a link itself is not shared.
      fs.symlinkSync(path.join(home, "weights"), path.join(home, "data", "alias"), WINDOWS ? "junction" : "dir")
      expect(await why("data/alias")).toBe("missing")
    },
    SLOW,
  )
})

describe("info/exclude through the one serialized writer", () => {
  test(
    "link copies and shared lines written at once lose no line; shared lines sit under their own header",
    async () => {
      const home = makeHome()
      const item = makeArea(home)
      const commonDir = path.join(home, ".git")
      const names = Array.from({ length: 12 }, (_, index) => `w${index}`)
      const [applied] = await Promise.all([
        // A plain area with the home's skip-worktree copies: the folder copy adds `/src/app/lib/`.
        Symlinks.apply({ area: { ...item, shape: "plain" }, fix: "skip-worktree" }),
        ...names.map((name) => Shared.exclude(commonDir, [name])),
        ...names.map((name) => Symlinks.rewrite(commonDir, (text) => `${text}# user ${name}\n`)),
      ])
      expect(applied.ok).toBe(true)
      const lines = excludeText(home).split("\n")
      expect(lines).toContain("/src/app/lib/")
      expect(lines.filter((line) => line === Symlinks.EXCLUDE_HEADER)).toHaveLength(1)
      expect(lines.filter((line) => line === Shared.EXCLUDE_HEADER)).toHaveLength(1)
      for (const name of names) {
        expect(lines).toContain(`/${name}`)
        expect(lines).toContain(`# user ${name}`)
      }
      // Each shared line went right under its header, so they stay one block.
      const header = lines.indexOf(Shared.EXCLUDE_HEADER)
      expect(lines.slice(header + 1, header + 1 + names.length).toSorted()).toEqual(
        names.map((name) => `/${name}`).toSorted(),
      )
      // Once more changes nothing.
      const before = excludeText(home)
      await Shared.exclude(commonDir, names)
      expect(excludeText(home)).toBe(before)
    },
    SLOW,
  )

  test(
    "unexclude takes only own's shared lines out, and the header once its block is empty",
    async () => {
      const home = makeHome()
      const commonDir = path.join(home, ".git")
      const file = path.join(commonDir, "info", "exclude")
      fs.writeFileSync(file, "# user\n/weights\n")
      await Shared.exclude(commonDir, ["weights", "data/set"])
      expect(fs.readFileSync(file, "utf8")).toBe(`# user\n/weights\n${Shared.EXCLUDE_HEADER}\n/data/set\n`)
      await Shared.exclude(commonDir, ["more"])
      await Shared.unexclude(commonDir, ["data/set"])
      expect(fs.readFileSync(file, "utf8")).toBe(`# user\n/weights\n${Shared.EXCLUDE_HEADER}\n/more\n`)
      await Shared.unexclude(commonDir, ["more", "weights"])
      // The user's own `/weights` line (above own's header) stays.
      expect(fs.readFileSync(file, "utf8")).toBe("# user\n/weights\n")
    },
    SLOW,
  )
})

describe("relink and unlink (06 §4.11)", () => {
  test(
    "a link where nothing is; git clean -fdx removes the link and leaves the original; relink makes it again",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        const shared = [record(home)]
        await setup(h, { home, areas: [item], shared })
        const link = path.join(item.directory, "weights")
        expect(await relink(h, item)).toEqual({
          ok: true,
          items: [{ name: "weights", state: "linked" }],
          created: ["weights"],
        })
        expect(isLink(link)).toBe(true)
        expect(same(fs.readlinkSync(link), path.join(home, "weights"))).toBe(true)
        expect(files(link)).toEqual(ORIGINAL)
        expect(excludeText(home)).toContain(`${Shared.EXCLUDE_HEADER}\n/weights\n`)
        // Ignored: nothing for `add -A`, the area stays clean.
        expect(status(item.directory)).toBe("")
        expect(git(item.directory, ["add", "-A", "--dry-run"])).toBe("")
        // A second relink makes nothing.
        expect(await relink(h, item)).toMatchObject({ ok: true, created: [] })

        git(item.directory, ["clean", "-fdx"])
        expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
        expect(files(path.join(home, "weights"))).toEqual(ORIGINAL)
        expect(await relink(h, item)).toMatchObject({ ok: true, created: ["weights"] })
        expect(isLink(link)).toBe(true)

        // unlink removes the link only.
        expect(await Shared.unlink({ directory: item.directory, shared })).toEqual({
          ok: true,
          removed: ["weights"],
          left: [],
        })
        expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
        expect(files(path.join(home, "weights"))).toEqual(ORIGINAL)
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "a real folder at the link path stays untouched with a lasting link.blocked notice until it is gone",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        const shared = [record(home)]
        await setup(h, { home, areas: [item], shared })
        write(item.directory, { "weights/mine.bin": "mine" })
        const blocked = await relink(h, item)
        expect(blocked).toEqual({ ok: true, items: [{ name: "weights", state: "folder" }], created: [] })
        expect(fs.readFileSync(path.join(item.directory, "weights", "mine.bin"), "utf8")).toBe("mine")
        expect(await blockedNotices(h)).toMatchObject([
          { areaID: item.id, data: { area: item.name, dir: "weights", why: "folder" } },
        ])
        expect(published(h)).toBe(1)
        // Still there: the notice stays open and is not published again.
        await relink(h, item)
        expect(await blockedNotices(h)).toHaveLength(1)
        expect(published(h)).toBe(1)
        // unlink leaves a real folder alone.
        expect(await Shared.unlink({ directory: item.directory, shared })).toEqual({
          ok: true,
          removed: [],
          left: [{ name: "weights", why: "folder" }],
        })
        expect(files(path.join(item.directory, "weights"))).toEqual(["mine.bin"])

        // The user moved it away: the link comes and the notice closes.
        fs.rmSync(path.join(item.directory, "weights"), { recursive: true })
        expect(await relink(h, item)).toMatchObject({ ok: true, created: ["weights"] })
        expect(await blockedNotices(h)).toEqual([])
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "a link to somewhere else is never replaced or removed",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        const shared = [record(home)]
        await setup(h, { home, areas: [item], shared })
        const elsewhere = path.join(box.root, `elsewhere${++count}`)
        write(elsewhere, { "theirs.bin": "theirs" })
        const link = path.join(item.directory, "weights")
        fs.symlinkSync(elsewhere, link, WINDOWS ? "junction" : "dir")
        expect(await relink(h, item)).toEqual({ ok: true, items: [{ name: "weights", state: "link" }], created: [] })
        expect(same(fs.readlinkSync(link), elsewhere)).toBe(true)
        expect(await blockedNotices(h)).toMatchObject([{ areaID: item.id, data: { why: "link" } }])
        expect(await Shared.unlink({ directory: item.directory, shared })).toEqual({
          ok: true,
          removed: [],
          left: [{ name: "weights", why: "link" }],
        })
        expect(isLink(link)).toBe(true)
        expect(files(elsewhere)).toEqual(["theirs.bin"])
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "no link without the folder's identity, inside a missing parent, or to an original that fails its check",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        const wrong = { ...makeArea(home), gitDir: item.gitDir }
        await setup(h, { home, areas: [item, wrong], shared: [record(home), record(home, "data/set")] })
        // TI-14: a folder that is not the recorded worktree.
        expect(await relink(h, wrong)).toMatchObject({ ok: false, broken: "identity" })
        expect(fs.existsSync(path.join(wrong.directory, "weights"))).toBe(false)
        // `data/` is not in the area: no folder is made for the nested link.
        expect(await relink(h, item)).toEqual({
          ok: true,
          items: [
            { name: "weights", state: "linked" },
            { name: "data/set", state: "no-parent" },
          ],
          created: ["weights"],
        })
        expect(fs.existsSync(path.join(item.directory, "data"))).toBe(false)
        // The original became tracked: refused, nothing linked.
        fs.rmSync(path.join(item.directory, "weights"))
        git(home, ["add", "-f", "weights/model.bin"])
        expect(await relink(h, item)).toEqual({
          ok: true,
          items: [
            { name: "weights", state: "refused" },
            { name: "data/set", state: "no-parent" },
          ],
          created: [],
        })
        expect(fs.lstatSync(path.join(item.directory, "weights"), { throwIfNoEntry: false })).toBeUndefined()
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "the link-shared step links an area, and is done at once when every link is there",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        await setup(h, { home, areas: [item], shared: [record(home)] })
        const first = await start(h, [{ ...Shared.linkSpec({ areaID: item.id }), id: "link" }])
        expect(first.state).toBe("done")
        expect(stepOf(first, "link")).toMatchObject({ state: "done", note: "연결됨 1개" })
        expect(isLink(path.join(item.directory, "weights"))).toBe(true)
        const second = await start(h, [{ ...Shared.linkSpec({ areaID: item.id }), id: "link" }])
        expect(stepOf(second, "link")).toEqual({
          id: "link",
          kind: Shared.KIND.link,
          args: { areaID: item.id },
          mode: "auto",
          state: "done",
        })
      } finally {
        await h.close()
      }
    },
    SLOW,
  )
})

describe("protect-shared (confirm only)", () => {
  test(
    "declining leaves the folder unshared; confirming protects the original, records it, excludes it and links every area",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const [one, two] = [makeArea(home), makeArea(home)]
        await setup(h, { home, areas: [one, two] })
        const target = path.join(home, "weights")
        // ACLs and chmod only ever touch temp fixture folders.
        expect(target.startsWith(box.root)).toBe(true)
        const steps = [
          { ...Shared.protectSpec({ name: "weights/" }), id: "protect" },
          { ...Shared.linkSpec({ areaID: one.id }), id: "link" },
        ]

        const first = await start(h, steps)
        expect(first.state).toBe("waiting")
        // Later auto steps go on while the confirm waits: nothing is recorded yet, so nothing is linked.
        expect(stepOf(first, "link")).toMatchObject({ state: "done", note: "공유하는 폴더가 없어요" })
        const confirm = stepOf(first, "protect")?.confirm
        // One sentence (06 §9.7): own-web shows what changes and the undo command under 자세히.
        expect(confirm?.text).toContain("'weights' 폴더")
        expect(confirm?.text).not.toContain(WINDOWS ? "/remove:d" : "chmod -R u+w")
        expect(stepOf(first, "protect")?.args).toEqual({ name: "weights" })
        const declined = await answer(h, first, "protect", "skip")
        expect(declined.state).toBe("done")
        expect(stepOf(declined, "protect")?.state).toBe("skipped")
        expect((await h.services.registry.teams.get(TEAM_ID))?.shared).toEqual([])
        expect(await Shared.protection(target, Shared.PROTECT)).toEqual({ ok: true, on: false })
        expect(fs.existsSync(path.join(one.directory, "weights"))).toBe(false)

        const second = await start(h, steps.slice(0, 1))
        guarded.add(target)
        const confirmed = await answer(h, second, "protect", "do")
        expect(confirmed.state).toBe("done")
        expect(stepOf(confirmed, "protect")?.note).toBe("읽기 전용으로 바꾸고 기록했어요 · 영역 2개에 연결 2개")
        expect((await h.services.registry.teams.get(TEAM_ID))?.shared).toEqual([
          { name: "weights", target, protect: Shared.PROTECT },
        ])
        expect(h.published.some((event) => event.name === "team.changed")).toBe(true)
        expect(await Shared.protection(target, Shared.PROTECT)).toEqual({ ok: true, on: true })
        expect(excludeText(home)).toContain(`${Shared.EXCLUDE_HEADER}\n/weights\n`)
        for (const item of [one, two]) {
          const link = path.join(item.directory, "weights")
          expect(isLink(link)).toBe(true)
          expect(same(fs.readlinkSync(link), target)).toBe(true)
          expect(status(item.directory)).toBe("")
        }

        // Read-only: reading goes on through the link; writing and deleting do not.
        const link = path.join(one.directory, "weights")
        expect(fs.readFileSync(path.join(link, "sub", "more.bin"), "utf8")).toBe("W2")
        expect(files(link)).toEqual(ORIGINAL)
        expect(() => fs.writeFileSync(path.join(link, "new.bin"), "x")).toThrow()
        expect(() => fs.rmSync(path.join(link, "model.bin"))).toThrow()
        // `rm -rf weights/` follows the link; the protection keeps the original.
        const ran = rmThroughLink(one.directory, "weights")
        if (!ran) console.warn("no Git for Windows bash next to git: the rm -rf check was skipped")
        expect(files(target)).toEqual(ORIGINAL)
        // git clean -fdx deletes the link without following it; relink makes it again.
        git(one.directory, ["clean", "-fdx"])
        expect(isLink(link)).toBe(false)
        expect(files(target)).toEqual(ORIGINAL)
        expect(await relink(h, one)).toMatchObject({ ok: true, created: ["weights"] })

        // Done: observing finds the effect, so a new step is done without acting (no second confirm needed).
        const again = await start(h, steps.slice(0, 1))
        expect(again.state).toBe("waiting")
        const resumed = await answer(h, again, "protect", "do")
        expect(stepOf(resumed, "protect")).toMatchObject({ state: "done" })
        expect(stepOf(resumed, "protect")?.note).toBeUndefined()

        // Taking the protection off again (the 되돌림 command).
        expect(await Shared.unprotect(target, Shared.PROTECT)).toEqual({ ok: true })
        expect(await Shared.protection(target, Shared.PROTECT)).toEqual({ ok: true, on: false })
        fs.writeFileSync(path.join(target, "after.bin"), "writable again")
        fs.rmSync(path.join(target, "after.bin"))
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "never without the user's confirm: a protect step run as auto fails and changes nothing",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        await setup(h, { home, areas: [item] })
        const target = path.join(home, "weights")
        expect(target.startsWith(box.root)).toBe(true)
        guarded.add(target)
        const op = await start(h, [{ ...Shared.protectSpec({ name: "weights" }), id: "protect", mode: "auto" }])
        expect(op.state).toBe("failed")
        expect(stepOf(op, "protect")?.note).toContain("사용자가 확인한 뒤에만")
        expect(await Shared.protection(target, Shared.PROTECT)).toEqual({ ok: true, on: false })
        expect((await h.services.registry.teams.get(TEAM_ID))?.shared).toEqual([])
        expect(fs.existsSync(path.join(item.directory, "weights"))).toBe(false)
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test(
    "an original that fails its check is not shared: the confirmed step is skipped",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        await setup(h, { home, areas: [] })
        const op = await start(h, [{ ...Shared.protectSpec({ name: "node_modules" }), id: "protect" }])
        const answered = await answer(h, op, "protect", "do")
        expect(stepOf(answered, "protect")).toMatchObject({ state: "skipped" })
        expect(stepOf(answered, "protect")?.note).toContain("도구가 만드는 폴더")
        expect((await h.services.registry.teams.get(TEAM_ID))?.shared).toEqual([])
      } finally {
        await h.close()
      }
    },
    SLOW,
  )

  test.skipIf(!WINDOWS && !LINUX)(
    "undoing gives back what the folder had: the user's own deny entry (Windows), its read-only entries (Linux)",
    async () => {
      const home = makeHome()
      const target = path.join(home, "weights")
      expect(target.startsWith(box.root)).toBe(true)
      guarded.add(target)
      const state = path.join(box.root, `records${++count}`, "weights")
      const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe")
      const whoami = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe")
      const sid = WINDOWS
        ? (/"(S-1-[0-9-]+)"/.exec(Bun.spawnSync([whoami, "/user", "/fo", "csv", "/nh"]).stdout.toString())?.[1] ?? "")
        : ""
      const acl = () => {
        const file = path.join(box.root, `acl${++count}.txt`)
        Bun.spawnSync([icacls, target, "/save", file])
        return new TextDecoder("utf-16le").decode(fs.readFileSync(file))
      }
      // The user's own protection from before: a deny of writing attributes, or one read-only file.
      if (WINDOWS) expect(Bun.spawnSync([icacls, target, "/deny", `*${sid}:(OI)(CI)(WA)`]).exitCode).toBe(0)
      else fs.chmodSync(path.join(target, "model.bin"), 0o444)
      try {
        expect(await Shared.protect(target, Shared.PROTECT, undefined, state)).toEqual({ ok: true })
        expect(await Shared.protection(target, Shared.PROTECT)).toEqual({ ok: true, on: true })

        expect(await Shared.unprotect(target, Shared.PROTECT, undefined, state)).toEqual({ ok: true })
        expect(await Shared.protection(target, Shared.PROTECT)).toEqual({ ok: true, on: false })
        if (WINDOWS) {
          // Own's entry is gone and the user's is back as it was; writing files works again.
          expect(acl()).toContain(`(D;OICI;CR;;;${sid})`)
          fs.writeFileSync(path.join(target, "after.bin"), "writable again")
          fs.rmSync(path.join(target, "after.bin"))
        } else {
          expect(fs.statSync(path.join(target, "model.bin")).mode & 0o200).toBe(0)
          expect(fs.statSync(path.join(target, "sub", "more.bin")).mode & 0o200).toBe(0o200)
        }
        // Once more (a resumed undo): it changes nothing.
        expect(await Shared.unprotect(target, Shared.PROTECT, undefined, state)).toEqual({ ok: true })
        if (WINDOWS) expect(acl()).toContain(`(D;OICI;CR;;;${sid})`)
        else expect(fs.statSync(path.join(target, "model.bin")).mode & 0o200).toBe(0)
      } finally {
        if (WINDOWS) Bun.spawnSync([icacls, target, "/remove:d", `*${sid}`])
        else fs.chmodSync(path.join(target, "model.bin"), 0o644)
      }
    },
    SLOW,
  )

  test.skipIf(!LINUX)(
    "Linux: a symlink and chmod -R a-w; rm -rf <name>/ leaves the original",
    async () => {
      const h = harness()
      try {
        const home = makeHome()
        const item = makeArea(home)
        await setup(h, { home, areas: [item] })
        const target = path.join(home, "weights")
        expect(target.startsWith(box.root)).toBe(true)
        guarded.add(target)
        const op = await start(h, [{ ...Shared.protectSpec({ name: "weights" }), id: "protect" }])
        expect((await answer(h, op, "protect", "do")).state).toBe("done")
        expect(Shared.PROTECT).toBe("chmod")
        expect(fs.statSync(target).mode & 0o222).toBe(0)
        expect(fs.statSync(path.join(target, "sub", "more.bin")).mode & 0o222).toBe(0)
        expect(isLink(path.join(item.directory, "weights"))).toBe(true)
        expect(excludeText(home)).toContain("\n/weights\n")
        expect(git(item.directory, ["add", "-A", "--dry-run"])).toBe("")
        expect(rmThroughLink(item.directory, "weights")).toBe(true)
        expect(files(target)).toEqual(ORIGINAL)
      } finally {
        await h.close()
      }
    },
    SLOW,
  )
})

describe("the feature", () => {
  test("create registers both step kinds once and close stops listening", async () => {
    const h = harness()
    try {
      const api = Shared.create(h.services)
      Shared.register(h.services)
      expect(h.services.steps.get(Shared.KIND.link)).toBeDefined()
      expect(h.services.steps.get(Shared.KIND.protect)?.prepare).toBeDefined()
      await api.close?.()
    } finally {
      await h.close()
    }
  })
})
