import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Cone } from "../../src/git/cone.js"
import { Worktree } from "../../src/git/worktree.js"
import { f1, files, git, temp } from "../fixtures/repo.js"
import { F3_CONE, F3_HEAVY, synthetic } from "../fixtures/synthetic.js"

const box = temp()
afterAll(() => box.dispose())

describe("Cone.complement (06 §4.5)", () => {
  const trees = [
    "Assets",
    "Assets/Audio",
    "Assets/Models",
    "Assets/Scripts",
    "Assets/Scripts/AI",
    "Assets/Textures",
    "Assets/Textures/UI",
    "Content",
    "Content/Maps",
    "docs",
    "src",
    "src/app",
    "tools",
  ]

  test("the spec example: heavy Assets/{Textures,Audio,Models} and Content", () => {
    expect(Cone.complement(trees, ["Assets/Textures", "Assets/Audio", "Assets/Models", "Content"])).toEqual([
      "Assets/Scripts",
      "docs",
      "src",
      "tools",
    ])
  })

  test("descends only into ancestors of heavy folders; missing heavy folders change nothing", () => {
    expect(Cone.complement(trees, ["Assets/Textures/UI"])).toEqual([
      "Assets/Audio",
      "Assets/Models",
      "Assets/Scripts",
      "Content",
      "docs",
      "src",
      "tools",
    ])
    expect(Cone.complement(trees, ["nowhere/at/all"])).toEqual(["Assets", "Content", "docs", "src", "tools"])
    expect(Cone.complement(trees, [])).toEqual(["Assets", "Content", "docs", "src", "tools"])
  })

  test("normalize accepts either separator and strips ./ and slashes", () => {
    expect(Cone.normalize("\\Assets\\Textures\\")).toBe("Assets/Textures")
    expect(Cone.normalize("./-dash/")).toBe("-dash")
    expect(Cone.complement(["a", "a/b", "c"], ["a\\b"])).toEqual(["c"])
  })
})

describe("Cone.matcher / covers", () => {
  const cone = ["Assets/Scripts", "docs", "src", "tools"]
  test("root files and files directly inside an ancestor are forced into the cone", () => {
    const inCone = Cone.matcher(cone)
    expect(inCone("README.md")).toBe(true)
    expect(inCone("Assets/Textures.meta")).toBe(true)
    expect(inCone("Assets/Scripts/AI/brain.cs")).toBe(true)
    expect(inCone("src/app/deep/x.ts")).toBe(true)
    expect(inCone("Assets/Textures/rock.png")).toBe(false)
    expect(inCone("Content/map.bin")).toBe(false)
    expect(Cone.contains(cone, "docs/guide.md")).toBe(true)
  })

  test("covers: a folder entirely inside the cone", () => {
    expect(Cone.covers(cone, "src/app")).toBe(true)
    expect(Cone.covers(cone, "Assets")).toBe(false)
    expect(Cone.covers(cone, "Assets/Textures")).toBe(false)
  })
})

describe("Cone.compute", () => {
  test("from a commit's tree, with extra folders that are not already covered", async () => {
    const f3 = synthetic(path.join(box.root, "f3"), 3_000)
    const plain = await Cone.compute(f3.home, f3.head, [...F3_HEAVY])
    expect(plain.ok && plain.dirs).toEqual([...F3_CONE])
    const extra = await Cone.compute(f3.home, f3.head, [...F3_HEAVY], ["Assets/Textures/d1", "src/m0", "src/m0/"])
    expect(extra.ok && extra.dirs).toEqual(["Assets/Scripts", "Assets/Textures/d1", "docs", "src", "tools"])
  })
})

describe("sparse-checkout wrappers", () => {
  const repo = f1(path.join(box.root, "f1"))
  const directory = path.join(box.root, "areas", "cone-area")
  const heavy = ["tools"]
  let gitDir = ""

  test("set through Worktree.create, with a '-'-leading folder through --stdin", async () => {
    const cone = await Cone.compute(repo.home, repo.head, heavy)
    if (!cone.ok) throw new Error(cone.message)
    expect(cone.dirs).toEqual(["-dash", "docs", "src"])
    const created = await Worktree.create(
      {
        home: repo.home,
        directory,
        branch: "cone-area",
        base: repo.head,
        areaID: "ar_cone-area",
        shape: "code",
        cone: cone.dirs,
        heavy,
      },
      { askDownloadBytes: Number.POSITIVE_INFINITY },
    )
    if (!created.ok || created.state !== "ready") throw new Error(JSON.stringify(created))
    gitDir = created.gitDir
    expect(files(directory)).toContain("-dash/notes.md")
    expect(files(directory).some((file) => file.startsWith("tools/"))).toBe(false)
    const listed = await Cone.list(directory)
    expect(listed.ok && listed.dirs).toEqual(["-dash", "docs", "src"])
  })

  test("check-rules: files in and out of the cone; inside(): whole folders only", async () => {
    const checked = await Cone.check(directory, ["README.md", "src/app/main.ts", "tools/build.ts", "-dash/notes.md"])
    expect(checked.ok && [...checked.inside].toSorted()).toEqual(["-dash/notes.md", "README.md", "src/app/main.ts"])
    const inside = await Cone.inside(directory, ["src", "src/app", "tools", "-dash"])
    expect(inside.ok && inside.dirs).toEqual(["src", "src/app", "-dash"])
  })

  test("add brings a folder in; reapply puts a stray file outside the cone away", async () => {
    const target = { directory, gitDir }
    expect(await Cone.add(target, ["tools"])).toEqual({ ok: true })
    expect(files(directory)).toContain("tools/build.ts")
    expect(git(directory, ["status", "--porcelain"])).toBe("")

    expect(await Cone.set(target, ["-dash", "docs", "src"])).toEqual({ ok: true })
    expect(fs.existsSync(path.join(directory, "tools"))).toBe(false)
    // A tool wrote a tracked file outside the cone (06 §4.9 step 2): status notices it, reapply collapses it again.
    fs.mkdirSync(path.join(directory, "tools"))
    fs.writeFileSync(path.join(directory, "tools", "build.ts"), git(directory, ["show", "HEAD:tools/build.ts"]))
    git(directory, ["status", "--porcelain"])
    expect(await Cone.reapply(target)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(directory, "tools", "build.ts"))).toBe(false)
  })

  test("endangered: a collapsed folder on disk that holds only ignored files, which any cone change deletes", async () => {
    // `tools` left the cone above. A build left output there that the user's exclude file ignores.
    fs.appendFileSync(path.join(repo.home, ".git", "info", "exclude"), "\n*.cache\n")
    fs.mkdirSync(path.join(directory, "tools", "out"), { recursive: true })
    fs.writeFileSync(path.join(directory, "tools", "out", "build.cache"), "output")
    const cone = ["-dash", "docs", "src"]
    expect(await Cone.endangered(directory, cone)).toEqual({ ok: true, dirs: ["tools/out"] })
    // Inside the cone after the change it is safe.
    expect(await Cone.endangered(directory, [...cone, "tools"])).toEqual({ ok: true, dirs: [] })
    // An untracked file beside it makes git keep the folder (with a warning).
    fs.writeFileSync(path.join(directory, "tools", "notes.txt"), "mine")
    expect(await Cone.endangered(directory, cone)).toEqual({ ok: true, dirs: [] })
    fs.rmSync(path.join(directory, "tools", "notes.txt"))
    // What the check prevents: a reapply deletes the ignored output (and the folder).
    expect(await Cone.reapply({ directory, gitDir })).toEqual({ ok: true })
    expect(fs.existsSync(path.join(directory, "tools", "out", "build.cache"))).toBe(false)
  })

  test("a folder name with a line break is refused before git runs", async () => {
    expect(await Cone.add({ directory, gitDir }, ["src\nContent"])).toMatchObject({ ok: false, error: "invalid" })
  })
})
