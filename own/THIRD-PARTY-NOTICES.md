# Third-party code in own-open-code

The repository root `LICENSE` is the MIT licence with two copyright lines: upstream OpenCode's (Copyright (c) 2025
opencode) and this fork's (Copyright (c) 2026 NA-DEGEN-GIRL). It covers the upstream code this fork is built on and the
code the fork adds (`own/`, `packages/own-*`). The parts listed below come from other projects and keep their own
licences; the licence text and notices sit next to each part. When you copy or redistribute one of these parts, keep
its notices.

## Not MIT

| Path | Origin | Licence | Notes |
|---|---|---|---|
| `own/vendor/oh-my-opencode/` | [oh-my-opencode](https://github.com/code-yeongyu/oh-my-openagent) by YeonGyu Kim, tag `v5.1.50` | Sustainable Use License 1.0 (`LICENSE.md`), third-party parts under their own licences (`THIRD-PARTY-NOTICES.md`) | Source-available, **not open source**: use and modification only for internal business, non-commercial or personal purposes, and distribution only free of charge for non-commercial purposes. Own changes are listed in `MODIFICATIONS.md`. The bundle built from it (`packages/own-omo`) carries the same notices. |
| `packages/own-harness/codex-data/` | [OpenAI Codex](https://github.com/openai/codex) | Apache License 2.0 (`LICENSE`, `NOTICE`) | Prompts, tool definitions and data files the `codex` harness ports. |
| `packages/own-accounts/src/image/skill/` | The `imagegen` skill bundled with OpenAI Codex | Apache License 2.0 (`LICENSE.txt`) | Changes listed in `MODIFICATIONS.md`. |

## MIT, other copyright holders

| Path | Origin | Notes |
|---|---|---|
| `packages/own-harness/pi-data/` | [Pi coding agent](https://github.com/earendil-works/pi), Copyright (c) 2025 Mario Zechner | `LICENSE`, `NOTICE`, ported files in `source.json` |
| `packages/own-harness/dsh-data/` | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), Copyright (c) 2026 DeepSeek | `LICENSE`, `NOTICE`, ported files in `source.json` |
| `packages/own-web/src/vendor/`, files listed in `own/ledger/vendored.yaml` | Upstream OpenCode files copied into own packages | Same MIT licence as upstream; each copy names its source in its first line |

## Fetched at build time, not stored here

| What | Licence | Where it is pinned |
|---|---|---|
| `opencode-claude-auth-v2` (third-party Claude subscription plugin, plugin id `heymaaz.claude-auth-v2`) | MIT (its own `LICENSE`) | `own/vendor/claude-auth/package-lock.json`, patched by `own/vendor/claude-auth/patches/` |
| npm, Cargo and Gradle dependencies | Their own licences | `bun.lock`, `own/native/*/Cargo.lock` (see `own/native/own-vault/THIRD_PARTY.md`), `packages/own-android/build.gradle.kts` |
| `@anthropic-ai/claude-agent-sdk` (an upstream dependency of `packages/core`) | Anthropic's own terms, not open source | `packages/core/package.json` |
| `com.google.android.gms:play-services-code-scanner` (Android pairing QR scanner) | Google's Android SDK and Play services terms | `packages/own-android/build.gradle.kts` |

## Own code

The fork's own code (`own/`, `packages/own-*`, whose `package.json` files say `"license": "MIT"`) is under the MIT
licence in the root `LICENSE`, except the parts listed above.
