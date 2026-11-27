# Claude subscription plugin input (02 §8.2, 01 §9.2)

The pinned third-party Claude subscription plugin `opencode-claude-auth-v2` (plugin id `heymaaz.claude-auth-v2`, MIT)
ships inside the app and is always on (user decision 2026-10-18 "넣고 항상 켜기", CB). This directory is the input of
that build step; nothing is installed here, and nothing is downloaded, installed or patched on a user's PC. It is not
shipped to SSH remote hosts: remote sessions use the slot through this PC's egress relay (04 §8.11).

| File                 | Purpose                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `package.json`       | Exact version `0.4.0-beta.5`, `"type": "module"`, `overrides["@opencode/plugin"]` = `2.0.24` (see below) |
| `package-lock.json`  | Pins the version and integrity (`sha512-dVA2AY58…`) and every transitive dependency                      |
| `server.js`          | `export { default } from "opencode-claude-auth-v2"` (entry `server` of a directory plugin)               |
| `patches/<ver>.json` | own's patch of exactly that version: `{file, preSha256, postSha256, edits:[{find, replace}]}` per file   |
| `README.md`          | This file                                                                                                |

## The build step

`bun own/scripts/claude-auth-bundle.ts --out <dir> [--build-id <id>] [--keep]` (step 3a of `build-desktop.ps1`, which
passes `--out <app>\plugins\claude-auth --build-id <release build id>`):

1. `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline` in a temp copy of `package.json` and the lock (from
   the npm cache when it holds the tarballs; npm checks every tarball against the lock's integrity).
2. The installed package and npm's hidden lockfile must name this lock's version and integrity.
3. `patches/<version>.json` is applied as plain text replacement: every file must still have its `preSha256`, every
   `find` must occur exactly once in what the edits before it left, and every result must have its `postSha256`.
4. `bun build` turns the patched package into one ESM file (`dist/index.js`, about 86 KB, not minified). The host's
   `@opencode/plugin` and `effect` stay external; the package's modules may import only their own files, `node:`
   built-ins and those two, so no other package's code is in the file and the package's MIT `LICENSE` covers it.
5. The bundle must load (with a stub host module) and carry the plugin id, the patch marker `OWN_MULTI_ACCOUNT` and
   every export own-accounts calls.
6. The output folder (about 93 KB instead of the former 132–171 MB `node_modules`):

   ```
   server.js                                export { default } from "opencode-claude-auth-v2"
   package.json                             {"private": true, "type": "module"}
   own-bundle.json                          {schema: 1, package, version, integrity, patchSha256, buildId, files: {path: sha256}}
   node_modules\opencode-claude-auth-v2\    the published package.json, index.js and LICENSE, and the patched dist\index.js
   ```

Any difference fails the build before anything is written to `--out`. The package sits under `node_modules` because
the upstream plugin loader evaluates a local plugin's own files again for every Location but keeps files under
`node_modules` in the module cache: the plugin keeps its accounts in module state that every Location and own's
egress relay share.

own-accounts (`packages/own-accounts/src/plugins/bundle.ts`) checks `own-bundle.json` and every file's hash at start
and on every `plugin.updated`; the patch state is `patched` by construction and `modified` once a file differs or the
loaded claude-auth is not the app's bundle. In a source run the bundle script's default output `own/.out/claude-auth`
is trusted the same way (`ClaudeBundle.devDir`). The plugin's state (own's account list `claude-accounts.json` and the
per-account `claude-auth-state\`) lives outside the versioned folder in `<OWN_HOME>\thirdparty\claude-auth`, which own
names to the loaded module (`ownUseStateDir`).

## The patch

`patches/0.4.0-beta.5.json` turns the pinned plugin into several Claude accounts (one per Claude Code config folder
listed in own's `claude-accounts.json`), signs each conversation with the account own bound it to, removes token
borrowing between accounts, never adopts `%USERPROFILE%\.claude` by itself (no account, nothing sent, until one is
connected), refreshes the `anthropic` connection credential from its own account's login folder only (never over the
network, never failing other accounts' requests), refreshes an account with Claude Code 2.1.282's own request (its
token endpoint, its headers with `User-Agent: axios/1.15.2`, its JSON body with the login's stored scopes or Claude
Code's defaults, one POST) and reads the answer as Claude Code does (a missing refresh token keeps the current one; the
granted scopes and the refresh token's expiry are written back), treats the token endpoint's 400, 401 and 403 as final
(no wait, `[다시 로그인]`) and a 429, a 5xx or no answer as passing, never runs `claude -p`, tells own every refresh
(`ownOnRefresh`: started, ok or failed, never a token) and lists each account's last failed refresh in `ownAccounts()`
(CR 2026-10-26), only reads an account own's list marks `readOnly` (Claude Code's own login: `%USERPROFILE%\.claude` or the account
source's folder, decided by own by realpath and credentials file id; never refreshed, written or `claude -p`d, so
Claude Code's refresh token is never rotated by own; a credentials file that does not parse is read once more after
150 ms; CS 2026-10-22) and, whatever the list says, `%USERPROFILE%\.claude` and its own `CLAUDE_CONFIG_DIR` (by
realpath, the credentials file's realpath and file id), every folder outside `<OWN_HOME>\claude-accounts` while the
list is not `version: 2` (an older own's list on the first start after an update; CS re-review 2026-10-23) and an
account without a folder (fail closed: its refresh would fall back to Claude Code's folder; CS second review), and
words its refusals in Korean with the account's name and its remedy (`[다시 로그인]`, `[own 전용 로그인으로 바꾸기]`
for Claude Code's own login, or what the token endpoint said and when the next request refreshes again when it is only
down for now). Since 2026-10-30 (CV) it also names Claude Code 2.1.308 instead of 2.1.280 (`ccVersion` in
`dist/model-config.js`: the User-Agent `claude-cli/2.1.308 (external, sdk-cli)` and the billing header's
`cc_version=2.1.308.<suffix>`), strips the effort only for Haiku 4.5 (the override key `haiku-4`; Claude Haiku 5.5 keeps
`output_config.effort`), and answers Anthropic's `claude_code_version_too_old` 400 with a Korean message and its remedy
(status, error type and details unchanged). 02 §8.2 lists every change.

## Upstream status and the Claude Code version

- The package is an OpenCode 2 fork of `griffinmartin/opencode-claude-auth`. Its author retired it on 2026-10-16: every
  version is deprecated on npm in favour of `opencode-claude-auth@3.0.0` or newer (`npm ci` prints that warning; the
  lock and integrity are unchanged, so the build goes on). own stays on `0.4.0-beta.5` with its patch and adopts neither
  `0.4.0-beta.6` (its one change, a `User-Agent` on the token refresh, is covered by own's Claude Code refresh) nor the
  successor 3.0.0 (still `ccVersion` 2.1.280, a new plugin id `griffinmartin.claude-auth`, and a new version and
  integrity would ask for the remote-use consent again). Decision CV, 02 §8.1.
- The Claude Code version the patch names is the npm `@anthropic-ai/claude-code` `stable` tag of the day (2.1.308 on
  2026-10-30), after checking in that release that the billing salt `59cf53e54c78`, the suffix indices 4, 7 and 20 and
  the identity line are unchanged. To move it, change `ccVersion` in an edited copy and rebuild the manifest (below).
  A new version changes `system[0]`, so each Claude-slot conversation reads no cache once after the update (02 §8.6;
  say so in the release notes). The remote-use consent stays valid: it pins the version and integrity, not the patch.
- The OAuth refresh shape (token endpoint, `axios/1.15.2` User-Agent, JSON body, default scopes) was re-checked against
  Claude Code 2.1.312 on 2026-10-30 and is unchanged.

A version bump needs a manifest for the new version (the build fails without one). To rebuild one, edit a copy of the
pristine package and run
`bun own/scripts/claude-auth-patch.ts <pristine package dir> <edited package dir> own/vendor/claude-auth/patches/<ver>.json`;
the script checks that the edits reproduce the edited copy exactly. The tests
`packages/own-accounts/test/plugins/patched-plugin.test.ts` and `test/claude/bundle-binding.test.ts` run the real,
patched bundle (`OWN_CLAUDE_AUTH_BUNDLE_DIR`, else `own/.out/claude-auth`; build it first with
`bun own/scripts/claude-auth-bundle.ts --out own/.out/claude-auth`, otherwise they are skipped) against fakes.

## Regenerating the lock

The override `@opencode/plugin` = `2.0.24` is kept on purpose although the fork has moved on to v2.0.32: the bundle
keeps `@opencode/plugin` (and `effect`) external, so at runtime the plugin imports the module the host service hands
it, which is always the fork's own release, and the 2.0.24 copy that `npm ci` installs is never bundled or shipped. The
plugin API only gained additions from 2.0.24 to 2.0.32 (SYNC_LOG v2.0.28 and v2.0.32), so raising the override would
only regenerate the lock. Raise it when the build itself needs a newer release, then regenerate the lock as below and
check G9 again.

The lock includes the plugin's `@opencode/plugin` dependency, pinned by that override, and its complete dependency
graph. A partial lock can make `npm ci` succeed without installing the SDK, leaving the plugin unable to load. To
regenerate the graph from registry metadata, start without the old lock; `--package-lock-only` by itself can preserve
an incomplete lock:

```powershell
cd own\vendor\claude-auth
Remove-Item -LiteralPath package-lock.json
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

Then check that `packages["node_modules/opencode-claude-auth-v2"].integrity` still equals the value in 02 §8.1, commit
the file and run the bundle script (it fails if the lock, the package or the patch disagree). Bumping the plugin
version is an explicit release step (new lock, new patch manifest, release notes); never use `@latest`. A new version
asks for the remote-use consent again (its pin changes, 02 §8.4a); there is no local consent.
