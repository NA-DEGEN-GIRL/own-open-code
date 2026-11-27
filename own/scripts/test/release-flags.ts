// Set by the e2e kit's server boot (own-web's backends and dev services and the live kit start through it), and
// preloaded by the own packages' tests (their bunfig.toml `[test]`) and by the other Bun processes started from
// packages/own-web (its top-level `preload`). Not by heavy.ts: core's own suite, which it
// also runs, tests the flags at upstream's defaults. Since upstream v2.2.6 (66b25c2bfc) core's feature flags are on by
// default for the `local` and `dev` channels, which source and test runs use, and off for every other channel, such as
// own's release channel `own` (build-own.ps1, build-remote.ps1). So a source run would test flags such as blob media,
// artifacts, model speeds or full Code Mode, none of which a release has. This keeps them off unless the run sets
// OPENCODE_FLAGS itself (`all`, `todo`, ...). packages/own-accounts/test/release-flags.test.ts checks the list against
// core's registry. Since upstream v2.3.1 background compaction (`compaction.background`) and automations (`automations`)
// are config settings, on by default in every build, a release too, so they are not flags here.

/** Every flag of core's registry (`ConfigFlag.registry`), off, as OPENCODE_FLAGS writes it. */
export const RELEASE_FLAGS = [
  "-todo",
  "-media_blob",
  "-artifacts",
  "-console_watches",
  "-recommended_api",
  "-model_speeds",
  "-full_codemode",
  "-machines",
  "-home_memory",
  "-project_overlay",
  "-opencode_api",
  "-sqlite_fts",
].join(",")

process.env.OPENCODE_FLAGS ??= RELEASE_FLAGS
// own's services read no CLAUDE.md (the launcher and own-remote set it since the v2.4.1 sync, decisions MR18): tests run
// the same way.
process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT ??= "1"
