# Modifications

This is a modified copy of oh-my-opencode (SUL-1.0) by YeonGyu Kim; own-open-code changed it as listed below.

- Upstream: https://github.com/code-yeongyu/oh-my-openagent, tag `v5.1.50` (tag object `fc005a310a54d1e161133d382321a593205741c0`,
  commit `d4d2204e075b17945d6899c6a6bc76e67ab7abea`). `pin.json` and `source.json` in this folder pin every vendored file.
- License: the Sustainable Use License 1.0 in `LICENSE.md`; third-party components keep their own licenses
  (`THIRD-PARTY-NOTICES.md`). own-open-code uses and distributes this part only free of charge and for non-commercial
  purposes; it is not distributed commercially. Every copy of the modified software (the `omo-runtime.js` bundle) carries `LICENSE.md`,
  `THIRD-PARTY-NOTICES.md` and this file, and its first line names the license and this file.
- Who: own-open-code (the OpenCode 2 fork this folder is part of), 2026-10-28.

## Source changes (`patches/v5.1.50.json`, applied when the bundle is built)

The files under `src/` are the upstream bytes. The build applies these edits to a staged copy; nothing is edited in
place. Each edited line carries an `own-open-code (OMO-Pn)` comment. All nine only act under own's environment
variables (`OMO_OWN_HOST=1`, `OMO_OWN_DATA_HOME`, `OMO_OWN_CACHE_HOME`, `OMO_OWN_CONFIG_DIR`, `OMO_OWN_STATE_HOME`,
`OMO_OWN_PROJECT_SKILLS`), which only own-omo sets; without them the code behaves as upstream's.

| Id     | File                                                                                                                                                                      | Change                                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OMO-P1 | `packages/omo-opencode/src/shared/opencode-storage-detection.ts`                                                                                                          | `isSqliteBackend()` answers `true`, so every message read and write goes through the host's client and never through OpenCode 1's JSON storage. |
| OMO-P2 | `packages/utils/src/xdg-data-dir.ts`, `packages/omo-opencode/src/shared/data-path.ts`                                                                                     | The data and cache folders come from `OMO_OWN_DATA_HOME` and `OMO_OWN_CACHE_HOME` (`<OWN_HOME>/thirdparty/omo/{data,cache}`).                    |
| OMO-P3 | `packages/omo-opencode/src/features/background-agent/process-cleanup.ts`                                                                                                  | No process signal, `exit`, `uncaughtException` or `unhandledRejection` handlers (they could end the host process); the host disposes instead.   |
| OMO-P4 | `packages/omo-opencode/src/shared/opencode-config-dir.ts`, `packages/skills-loader-core/src/shared/opencode-config-dir.ts`, `packages/claude-code-compat-core/src/shared/opencode-config-dir.ts` | The OpenCode config folder is own's (`OMO_OWN_CONFIG_DIR`), never the user's `~/.config/opencode`.                                               |
| OMO-P5 | `packages/omo-opencode/src/plugin/tool-registry-core-tools.ts` | `task` uses the config the host started omo with instead of reading omo's config files again per call, so own's categories (all on the parent's model) apply and no category is refused for lacking omo's preferred model. |
| OMO-P6 | `packages/omo-opencode/src/features/run-continuation-state/storage.ts` | A project's continuation markers live under own's home (`OMO_OWN_STATE_HOME`: `<OWN_HOME>/thirdparty/omo/projects/<folder>-<sha256 of the project path, 12>/run-continuation/`) instead of the project's `.omo/run-continuation/`. |
| OMO-P7 | `packages/omo-opencode/src/tools/delegate-task/tools.ts` | A `task`'s model is its parent's (the model own runs every child on), so omo builds the child's prompt for it and its result names it instead of the category's configured model. |
| OMO-P8 | `packages/omo-opencode/src/plugin/command-execute-before.ts` | The command `resume-continuation` (own's `/resume-continuation`) clears the stop `/stop-continuation` set, without a restart. |
| OMO-P9 | `packages/skills-loader-core/src/features/opencode-skill-loader/loader.ts`, `packages/skills-loader-core/src/features/opencode-skill-loader/opencode-config-skills-reader.ts` | A project's skills (`.opencode/skills`, `.claude/skills`, `.agents/skills`, and the skill folders its `.opencode/opencode.json` names) are found only when the host says its service reads project config (`OMO_OWN_PROJECT_SKILLS=1`); otherwise omo listed and loaded them on a service started with project config off. |

## Build-time replacements (no source edit; `packages/own-omo/script/resolve.ts`)

- `@opencode-ai/plugin`: own's stand-in. `tool()` returns its definition and `tool.schema` is zod.
- `@opencode-ai/sdk`, `posthog-node`, `sharp`: a stub that throws when used. omo gets own's client instead, its
  telemetry is off and its image tools are not registered.
- `packages/omo-opencode/src/shared/posthog.ts`: own's no-op `recordPluginTelemetry`, so no telemetry client, key or
  host is in the bundle.
- `signal-exit` (loaded by `proper-lockfile`, which omo's skill MCP grant store uses): a no-op, so loading the runtime
  adds no listener to the host process's signals.
- The runtime entry (`packages/own-omo/src/runtime-entry.ts`) exports only what the host calls.

## Behaviour the host (own-omo) changes

own-omo runs omo as an OpenCode 1 plugin inside OpenCode 2 and changes what omo can do:

- omo runs only in sessions bound to the `omo` harness. Its tools, agents and hooks do nothing anywhere else, and its
  tools are listed only in those sessions.
- Child sessions omo starts are never deleted (`session.delete` does nothing), so the user can still open them.
- Project skills follow the host's project config: own-omo sets `OMO_OWN_PROJECT_SKILLS=1` only when the service reads
  project config (not on an SSH host whose project settings are off or instruction files only, nor in the PC's
  untrusted mode), and OMO-P9 makes omo's project skill discovery return nothing without it.
- Models: every omo agent and category runs on the parent session's current model (policy `inherit`); omo's model
  choices, fallback chains and per-prompt model or variant changes are not applied, and a top-level session's model
  is never switched.
- omo's `default_agent` and its global `permission` settings are never applied; a child session keeps its parent's
  rules plus omo's denials.
- Turned off by own's baseline config: telemetry, auto update, model and runtime fallback, hashline edits, the new task
  system, team mode, tmux, monitor, goals, the TUI sidebar, all Claude Code compatibility loaders, the websearch,
  context7, grep_app and lsp MCPs, the agents hephaestus, prometheus, atlas, metis, momus, multimodal-looker, athena,
  athena-junior and council-member, every command except `stop-continuation`, the tools grep, glob, session_*,
  look_at, skill, skill_mcp and interactive_bash, the keywords team, hyperplan and hyperplan-ultrawork, and every
  internal hook except keyword-detector, todo-continuation-enforcer, stop-continuation-guard, background-notification,
  agent-usage-reminder, delegate-task-retry, empty-task-response-detector, task-resume-info, todo-description-override,
  tasks-todowrite-disabler, write-existing-file-guard and edit-error-recovery.
- Startup: no process sweep, legacy migration, duplicate-plugin or skill-plugin detection, server-auth injection,
  live server route, OpenClaw, tmux check or agent sort shim; the version check reads OpenCode 1.18.31 (the API omo
  was built for) and the log goes to `<OWN_HOME>/thirdparty/omo/logs/omo.log` (10 MB). own's environment variables
  are set before the runtime is imported, because omo resolves some folders while it loads (its storage folder and the
  update checker's cache root), so OMO-P2 covers those too.
- Toasts are written to own's log (`<OWN_HOME>/logs/own-omo.log`) instead of a terminal UI; a `Skill load error` for a
  skill folder that does not exist is left out.
- A context reset (own's `/reset-context`) reaches omo as a compaction, so nothing is continued into the emptied
  context; user and synthetic messages reach omo as OpenCode 1's `message.updated` and `message.part.updated`.
- A manual compaction reaches omo as OpenCode 1's compaction user message when it starts, which ends a running
  continuation countdown, and a failed compaction reads as OpenCode 1's compaction pair with the error on its summary
  message, so omo continues after neither.
- A failed `edit` whose reason edit-error-recovery knows reaches `tool.execute.after` with OpenCode 1's text for it,
  and omo's reminder is appended to the error the model gets.
- own adds the command `/resume-continuation` (see OMO-P8).

## Re-pins

| Date       | Tag     | Notes         |
| ---------- | ------- | ------------- |
| 2026-10-28 | v5.1.50 | First vendor. |
| 2026-10-29 | v5.1.50 | OMO-P6, OMO-P7 and OMO-P8 added. |
