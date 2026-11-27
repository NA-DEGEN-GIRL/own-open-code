import { afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Test preload (bunfig.toml): every own-import test process starts with `CODEX_HOME` and `CLAUDE_CONFIG_DIR` pointing
 * at one empty temp folder and `OWN_HOME` at another, so a test that forgets its fixture roots or `home` reads nothing
 * and writes only there, never the user's `~/.codex`, `~/.claude` or real OWN_HOME (09 §7.3). Tests that need roots
 * write synthetic ones with `test/fixtures/make.ts` and pass them as the plugin option `roots`. `OPENCODE_CONFIG_DIR`
 * points at the empty folder too.
 */
const empty = mkdtempSync(path.join(os.tmpdir(), "own-import-empty-"))
const home = mkdtempSync(path.join(os.tmpdir(), "own-import-home-"))

process.env.CODEX_HOME = empty
process.env.CLAUDE_CONFIG_DIR = empty
process.env.OWN_HOME = home
// own's skills folder (09 §9.4) defaults to `%OPENCODE_CONFIG_DIR%\skills`: an empty temp folder, never the user's.
process.env.OPENCODE_CONFIG_DIR = empty
// Core's home (`Global.Path.home`), which the skills list's known folders come from (SK2): never the user's.
process.env.OPENCODE_TEST_HOME = empty

// A lifecycle hook in a preload file runs once after all test files.
afterAll(() => {
  rmSync(empty, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})
