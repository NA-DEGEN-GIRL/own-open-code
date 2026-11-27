# oh-my-opencode input (own/docs/15)

The pinned third-party OpenCode 1 plugin oh-my-opencode ("omo", by YeonGyu Kim, Sustainable Use License 1.0) that own
runs on OpenCode 2 through own's v1 plugin host `packages/own-omo` (plugin id `own.omo`, harness `omo (원본)`). This
folder is the input of that build step and is never edited in place: own's changes are a patch applied at build time
(`patches/<tag>.json`) and are listed in `MODIFICATIONS.md`. own uses it for its owner's personal, non-commercial use
only (own/FORK.md §8.4, §10); it is never distributed commercially and never sent upstream.

| File                     | Purpose                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `src/packages/<pkg>/…`   | The upstream bytes at the pin: the static import closure of `packages/own-omo/src/runtime-entry.ts` (no tests), each of its packages' `package.json`, the root `package.json` |
| `source.json`            | sha256 of every file under `src/`                                                                                   |
| `pin.json`               | Repository, tag, tag object, commit, date, omo version, the OpenCode 1 API it targets, file count, license hashes; mirrored in `own/ledger/omo-pin.json` |
| `LICENSE.md`             | omo's license, byte for byte (its sha256 is in `pin.json`)                                                          |
| `THIRD-PARTY-NOTICES.md` | omo's third-party notices, byte for byte                                                                            |
| `MODIFICATIONS.md`       | The prominent notice that own modified this software, and every change                                             |
| `patches/<tag>.json`     | own's source changes (OMO-P1…): `[{file, patch, preSha256, postSha256, edits: [{find, replace}]}]`                  |
| `.oxlintrc.json`         | Keeps the upstream sources out of own's lint                                                                        |

Not vendored: the LSP daemon and tools, the comment-checker binaries and the platform launcher packages (MIT, not
used), the Rust crates, omo-codex and senpi (apart from the two senpi files the runtime imports), and CLI-only files.

## The build step

`bun packages/own-omo/script/bundle.ts [--out <dir>]` (default `own/.out/omo`; the release passes
`<app>/plugins/own-omo`) checks `src/` against `source.json`, stages it in `packages/own-omo/.omo-stage/`, applies
`patches/<tag>.json` (every file must have its `preSha256`, every `find` must occur exactly once, every result must
have its `postSha256`), bundles `packages/own-omo/src/runtime-entry.ts` into one minified ESM file `omo-runtime.js`
(about 4–5 MB; own's stand-ins replace `@opencode-ai/plugin`, `@opencode-ai/sdk`, `posthog-node`, `sharp` and omo's
telemetry module) and copies `LICENSE.md`, `THIRD-PARTY-NOTICES.md` and `MODIFICATIONS.md` next to it. The build
fails if the banner is missing, the output names a PostHog host, or it is larger than 6 MB.

## Re-pinning (no automatic updates)

1. `bun own/scripts/omo-vendor.ts --from <omo clone> --tag vX`: reads the clone with git plumbing only (nothing is
   checked out or built there), recomputes the closure, rewrites `src/`, `source.json`, `pin.json`,
   `own/ledger/omo-pin.json` and the license copies, and fails if `LICENSE.md` changed (decide first, then pass
   `--accept-license-change`). Never build in the clone: its path contains `#`, which breaks Bun and Vite.
2. `bun own/scripts/omo-patch.ts rebase --from v5.1.50 --to vX`: re-applies each edit and writes `patches/vX.json`
   with the new hashes; edits that no longer apply are listed. Re-make those from an edited copy with
   `bun own/scripts/omo-patch.ts make <pristine> <edited> patches/vX.json`.
3. Rebuild, run the own-omo unit, vendor, isolation and e2e tests and the unchanged-request goldens, then record the
   re-pin in `MODIFICATIONS.md` and the decisions log.
