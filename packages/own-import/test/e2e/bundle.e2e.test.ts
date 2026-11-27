import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { plugins } from "../../../own-remote/script/bundle.ts"
import { startTeamServer, type TeamServer } from "../../../own-team/test/e2e/harness.js"
import { fixture, type Fixture } from "../fixtures/make.js"
import { claudeSkill } from "../fixtures/skills.js"
import { removeTree } from "../support/remove.js"
import { call } from "./support.js"

/**
 * own-import as the installed service loads it (09 §5.1, FORK §8.2 step 3): the one-file bundle the release writes with
 * own-remote's `bundle.ts plugins` (build-desktop.ps1), loaded by own-team's harness from a folder
 * that holds only that `index.js`, as an installed plugin folder does (no node_modules beside it). Every package the
 * importer runs is in the file, so `health` and `skills.list` (gray-matter reads a `SKILL.md`, 09 §9.3) answer through
 * it. And a plugin folder that cannot load (here: an import of a package the install lacks, as in a worktree whose
 * `bun install` predates the merge that added a dependency) fails the harness's readiness at once with core's cause,
 * not after the readiness timeout. Run from `packages/own-import`: `bun run test:e2e`.
 */

const BOOT = 300_000
const LONG = 120_000
const MISSING = "own-import-e2e-missing-package"

const state = {} as { fixture: Fixture; dir: string; server: TeamServer }

beforeAll(async () => {
  state.fixture = await fixture({ under: "bundle" })
  state.dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "own-import-bundle-")))
  await claudeSkill(state.fixture.claude, "review")
  // The source server reports app version "local"; the bundle's guard must expect exactly that (or it registers no
  // RPC). `plugins` is what build-desktop.ps1 runs through bundle.ts.
  const built = await plugins({
    out: path.join(state.dir, "plugins"),
    version: "local",
    buildId: "e2ebundle003",
    packages: ["own-import"],
  })
  const folder = path.dirname(built["own-import"]!)
  expect(await fsp.readdir(folder)).toEqual(["index.js"])
  state.server = await startTeamServer({
    name: "import-bundle",
    team: false,
    importer: true,
    importOptions: { roots: { codex: [state.fixture.codex], claude: [state.fixture.claude] } },
    importPackage: folder,
  })
}, BOOT)

afterAll(async () => {
  await state.server?.stop()
  await state.fixture?.cleanup()
  if (state.dir) await removeTree(state.dir)
}, LONG)

describe("own-import's release bundle in the real server", () => {
  test(
    "the bundle activates and answers health and skills.list",
    async () => {
      expect((await call(state.server, "health", {})).features).toContain("skills")
      const listed = await call(state.server, "skills.list", {})
      expect(listed.items.map((row) => [row.origin, row.name, row.format.status])).toEqual([
        ["claude-code", "review", "ok"],
      ])
    },
    LONG,
  )

  test(
    "a plugin folder that cannot load fails readiness with core's cause",
    async () => {
      const folder = path.join(state.dir, "broken-import")
      await fsp.mkdir(folder, { recursive: true })
      await Bun.write(
        path.join(folder, "index.js"),
        `import missing from "${MISSING}"\nexport default { id: "own.import", effect: () => missing }\n`,
      )
      const failure = await startTeamServer({
        name: "import-broken",
        team: false,
        importer: true,
        importOptions: { roots: { codex: [state.fixture.codex], claude: [state.fixture.claude] } },
        importPackage: folder,
      }).then(
        async (server) => {
          await server.stop()
          return "started"
        },
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      // Not `own.import never became active` after `until`'s minute: the failure as soon as core lists it, with the
      // server log line that names the package.
      expect(failure).toContain("own.import failed to load")
      expect(failure).toContain(MISSING)
    },
    BOOT,
  )
})
