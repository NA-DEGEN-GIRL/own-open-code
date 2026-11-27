// Fixture templates (test/fixtures/repo.ts `template`): a template whose `home` lost its repository while its record
// stayed is built again instead of failing every copy with "not a git repository" (an F1 in %TEMP%/own-team-fixtures
// that kept its folders but lost `.git/HEAD` and the work tree's files, 2026-11-07). The template here has its own name,
// so other workers' fixtures are untouched.
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { commit, head, init, temp, template, write } from "./fixtures/repo.js"
import { removeTreeSync } from "./support/remove.js"

// Two builds and two copies: about ten git processes, which a busy PC stretches past bun's 5 s default.
test("a template whose home lost its repository is built again", () => {
  const name = `broken-${process.pid}`
  const templates = path.join(fs.realpathSync.native(os.tmpdir()), "own-team-fixtures")
  const builds: string[] = []
  const build = (root: string) => {
    const home = init(path.join(root, "home"))
    write(home, { "a.txt": `build ${builds.length}\n` })
    builds.push(root)
    return commit(home)
  }
  const first = temp()
  const second = temp()
  try {
    expect(template(name, first.root, build)).toBe(head(path.join(first.root, "home")))
    const dir = fs.readdirSync(templates).find((entry) => entry.startsWith(`${name}-`) && !entry.includes(".broken-"))
    expect(dir).toBeDefined()
    // What the broken template looked like: its record, and a `home` that kept its folders (`.git` too) but no HEAD.
    const home = path.join(templates, dir!, "home")
    for (const entry of fs.readdirSync(home, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) continue
      // git writes its objects read-only, which Windows will not delete.
      fs.chmodSync(path.join(entry.parentPath, entry.name), 0o666)
      fs.rmSync(path.join(entry.parentPath, entry.name))
    }
    expect(fs.existsSync(path.join(home, ".git", "objects"))).toBe(true)
    expect(fs.existsSync(path.join(home, ".git", "HEAD"))).toBe(false)
    expect(fs.existsSync(path.join(templates, dir!, ".template.json"))).toBe(true)

    expect(template(name, second.root, build)).toBe(head(path.join(second.root, "home")))
    expect(builds).toHaveLength(2)
    expect(fs.readFileSync(path.join(second.root, "home", "a.txt"), "utf8")).toBe("build 1\n")
  } finally {
    first.dispose()
    second.dispose()
    for (const entry of fs.readdirSync(templates).filter((item) => item.startsWith(`${name}-`)))
      removeTreeSync(path.join(templates, entry))
  }
}, 60_000)
