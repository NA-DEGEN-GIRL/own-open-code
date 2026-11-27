// Preloaded by the tests of the own packages that run git (their bunfig.toml). In a linked worktree, `git bisect run`
// (and git hooks) hand their command GIT_DIR=<this repository>; a fixture's `git init --bare <dir>` under it
// re-initialised this repository as bare instead of making the fixture (2026-10-15). Tests run git on their own temp
// repositories only, so the variables that pick a repository go before any test starts. own.team's `Git.run` drops
// the same ones for the product (packages/own-team/src/git/run.ts `INHERITED`).
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
])
  delete process.env[key]
