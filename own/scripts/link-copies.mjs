#!/usr/bin/env node
// link-copies: replaces the symbolic links Git for Windows wrote as text files with copies of their targets.
//
//   node own/scripts/link-copies.mjs          # from the repository root, after a clone without core.symlinks=true
//
// Without Developer Mode (or `git clone -c core.symlinks=true`), Git writes each symbolic link of the tree as a small
// text file holding the target path. Icons then break and `@opencode/desktop`'s typecheck fails on
// packages/app/src/custom-elements.d.ts. For each link that is such a text file, this copies the target over it and
// marks the path `--skip-worktree`, so `git status` stays clean (own/FORK.md, "심볼릭 링크"). Real links are left
// alone. Run it again after a pull that changes a link's target. Node 22, no dependencies.
import { execFileSync } from "node:child_process"
import { copyFileSync, lstatSync, readFileSync } from "node:fs"
import path from "node:path"

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
const links = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\0")
  .filter((line) => line.startsWith("120000 "))
  .map((line) => line.slice(line.indexOf("\t") + 1))

const copied = links.filter((file) => {
  const full = path.join(root, file)
  const stat = lstatSync(full, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink()) return false
  const target = readFileSync(full, "utf8")
  const source = path.join(path.dirname(full), target)
  // A copy made earlier is no longer the link text; leave it.
  if (target.includes("\n") || target.length > 512 || !lstatSync(source, { throwIfNoEntry: false })?.isFile()) return false
  copyFileSync(source, full)
  return true
})
if (copied.length) execFileSync("git", ["update-index", "--skip-worktree", "--", ...copied], { cwd: root })
console.log(`link-copies: ${links.length} links, ${copied.length} copied, ${links.length - copied.length} already fine`)
