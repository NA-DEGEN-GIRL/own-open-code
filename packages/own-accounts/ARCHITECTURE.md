# own-accounts architecture (`@own/accounts`, plugin id `own.accounts`)

Specs: `own/docs/01-architecture.md` §4, §8, §13, §14 and `own/docs/02-accounts-providers-cache.md` (the main spec).
Contracts already implemented: `packages/own-protocol` (RPC `own.accounts`, schemas) and `packages/own-runtime`
(process singleton). When the spec and the protocol disagree, the protocol wins until the protocol owner changes it
(see "Pending protocol changes").

## 1. Shape

One plugin instance per Location (the plugin module is re-imported per Location and on reload). Process-wide state
lives only in the `@own/runtime` singleton (`Runtime.acquire({ buildId })`): stores, vault credentials (headers only,
no raw secret getter), limits, the session → slot index (`sessions`, `state\sessions.json`), ledger writer,
lastResponse, and `broadcast` (process-wide topics between instances and between own-accounts and own-telemetry).
Like the broker objects of §13, the wire evidence capture's window (EXT wave 2, §11) has a `globalThis` slot per
build of its own.

Setup (`src/index.ts`), in this order (02 §3.8):

1. `Options.decode(ctx.options)` (throws on invalid options; options never carry secrets).
2. Guard 1 (`health/guard.ts`, 01 §5.4): app version must equal the build's expected version (`"local"` for source
   runs) and `OWN_OPEN_CODE=1` must be set. On failure: register only `health` (`Register.HealthOnly`) reporting
   `skew`/`unmanaged`; no runtime, no slots, no hooks. Fail closed.
3. `Runtime.acquire` (`buildId`, `home`, vault, `preferLeader` = this is the control location).
4. `Modules.create(deps)` then `Modules.start` in `Modules.ORDER` (slots first: the registry is in memory before
   any fold or hook can run).
5. `Hooks.register`: provider/model/agent/skill transforms, every session hook and the tool hooks, once, unscoped.
6. `Register.register`: RPC `own.accounts` with all 80 handlers; binds the emitter. The definition is registered through
   `Portable.definition` (`@own/protocol`): Standard Schema objects run in the bundle's own `effect`, because the host
   cannot run an Effect schema built by another copy (2.0.18-own.1 release smoke: every integer field failed with
   `rpc.invalid_output` inside `opencode.exe`).
7. `Events.start`: the single `ctx.event.subscribe` loop.
8. Background `health.check()` (startup self-check, 02 §4.2).

Cleanup is the reverse (an `AsyncDisposableStack`): stop events → `Modules.stop` (reverse order) → unbind emitter →
`runtime.release()`. Hook and RPC registrations belong to the plugin scope and are disposed by the host.

## 2. File map and ownership

Lead-owned files are the shared skeleton. Module agents do not edit them; ask the lead (or add a TODO in your
report) when a shared contract must change. Each module agent owns its folder, its `src/rpc/<group>.ts`, and its
tests under `test/<module>/`.

| Path | Owner | Contents |
|---|---|---|
| `server.ts` | LEAD | Dev entry for `{ "package": "<repo>/packages/own-accounts" }` |
| `src/index.ts` | LEAD | `Plugin.define` entry, setup/cleanup order |
| `src/build.ts` | LEAD | Build-time constants (`BUILD_ID`, `EXPECTED_APP_VERSION`, `PLUGIN_VERSION`, `ENV_MARKER`) |
| `src/options.ts` | LEAD | Plugin options schema (`home`, `buildId`, `vault`, `endpoints`, `codexImportRoot`, `codexHome`, `secretCacheSeconds`, `ratecardsSeed`, `logLevel`) |
| `src/endpoints.ts` | LEAD | Production endpoints + test overrides |
| `src/deps.ts` | LEAD | `Deps` passed to every module |
| `src/module.ts` | LEAD | `Lifecycle`, `Peers`, `OpenCodeEvent`, `EventMeta` |
| `src/modules.ts` | LEAD | Module registry: `All`, factories, start/stop order, event order |
| `src/hooks.ts` | LEAD | Registers transforms and session hooks, dispatches to modules, never throws |
| `src/skills.ts` | LEAD | `Skills.transform`, the `skill.transform` fold over core's two built-in skills: appends an own section to `opencode` naming this service's global config dir (`OPENCODE_CONFIG_DIR`, read once at registration) as the meaning of every `~/.config/opencode` path in it; in `report` writes the home directory as `~` and appends one sentence that keeps issues off `anomalyco/opencode` (decision D5 (d)); names and descriptions unchanged, so no session gets a skill-list delta; each edit skipped (debug log) when its skill is missing, the `opencode` section also when the variable is unset |
| `src/guard/repeat.ts` | LEAD | `Repeat`, the repeated identical tool-call reminder that `hooks.ts` runs on the session and tool hooks (decision D4 (A), §4, §11 "EXT waves 2–4") |
| `src/events.ts` | LEAD | Event subscription loop, `Places` (`deps.places`: session → this Location, learned from located events and from modules' session lookups; location-less session events inherit it), `local` flag, resubscribe |
| `src/emitter.ts` | LEAD | `Emitter.Publisher`: RPC events with `eventId`/`origin`, leader rule |
| `src/logger.ts`, `src/clock.ts`, `src/location.ts`, `src/nonces.ts` | LEAD | Redacting logger, clock/timers (`Clock.manual` for tests), path compare, plan/execute nonces |
| `src/rpc/types.ts`, `src/rpc/register.ts` | LEAD | Handler types; the single place that registers all handlers |
| `test/support/deps.ts`, `test/skeleton.test.ts`, `test/plugin.test.ts` | LEAD | Unit-test `Deps` (real runtime, memory vault, manual clock, strict fake ctx); wiring tests; real-server boot test |
| `test/e2e-kit/**` | LEAD (shared, append-only for module agents: add fakes/fixtures, do not change existing behavior) | Fakes, server harness (`harness/events.ts`: SSE event recorder), fixtures |
| `test/integration/**` | LEAD | Phase 2 integration E2E: both plugins, providers only from own.accounts RPCs, switching across accounts and kinds |
| `src/slots/**`, `src/rpc/accounts.ts`, `src/rpc/codex-models.ts`, `templates/**` | SLOTS | Registry memory, provider/model registration (compaction windows via `Compaction.resolve`), templates, reconcile, account RPCs, core config reader (`core-config.ts`). T2: the Codex metadata module (`codex-meta.ts`, `CodexMeta`, 07 §4.5: the backend model list fetched with etag into `OWN_HOME\codex-meta.json`, the Codex CLI's `config.toml`/`models_cache.json` read only as the fallback), the pinned-template diff (`template-diff.ts`, `TemplateDiff`, 07 §4.4) and the live limit/cost/status/release date over pinned fields (`Templates.live`, `Registration.current`) |
| `src/presets/**`, `src/rpc/presets.ts`, `src/rpc/session-preset.ts` | PRESETS | `presets.json` (07 §8.1; T0: each provider group's new-session default model, 07 §2.2, and the root session's first preset binding (`binding.ts`, KV `sess:<root>:preset`, 07 §5.1)); the subagent gate (`access.ts`, `gate.ts`), the `opencode_models` filter (`models-filter.ts`) and hidden agents' configured models plus the own role agents (`agents.ts`), assembled in `presets.ts` (07 §5.4). T1: `presets.set/remove/suggest` (`store.ts`, `suggest.ts`, `starters.ts`), the resolver and lighter pairs (`resolve.ts`, `lighter.ts`), `session.preset.apply/get` (`apply.ts`) with the `own.preset` guidance entry (`guidance.ts`), ultra (`ultra.ts`), caps and reservations (`usage.ts`), budgets and paid consent (`budget.ts`, `consent.ts`), the role fallback order (`fallback.ts`), the read-only roles' tighten-only `evaluate` hook (`readonly.ts`), local running windows (`local-window.ts`). T2: repair notices and the gone-main guard (`repair.ts`, `PresetRepair`, 07 §4.3) over the store's presence check (`store.ts` `repairs()`, `Preset.presence`), the repair history (`presets.set{repairOf}`). T4 모델 묶음 (07 §3.3): frozen pool cards (`cards.ts`, `PresetCards`), pool facts in the resolution (`resolve.ts`), per-entry load cleanup, pool save checks and `poolHistory` (`store.ts`), the pool branch of the gate with the default rule and `Fallback.poolNotice` (`gate.ts`, `access.ts` `Plan.pool`), the pool guidance block (`guidance.ts` `pool`) and the pool editor offer (`suggest.ts`) |
| `src/speed/**`, `src/rpc/speed.ts` | SPEED | A root session's speed (02 §4.8, user decisions of 2026-10-06): KV `sess:<root>:speed` and `ack:claudeFast`, the offers of a main (`offers.ts`: a Codex account's own list from `codex-meta.json` `accounts`, a Sign in with ChatGPT catalog's tiers in `runtime.speed`, the catalog's mode entries for API keys and the Claude subscription slot), the request edits (`wire.ts`: `serviceTier` for the OpenAI family, `speed` and the fast-mode beta for Anthropic in `http.request`, the beta kept on the conversation), the refusal verdicts and cooldowns (`refusal.ts`), the speed-only estimate (`estimate.ts`), the served tier and the retention measure, `session.speed.get/set` |
| `src/notes/**`, `src/rpc/notes.ts` | NOTES | Stateless workspace notes (02 §9.2 "워크스페이스 노트", 05 §8.8): `NoteStore` keeps one index row per workspace (`Kv.notesIndex`, titles and revisions in creation order) and one text row per note (`Kv.noteText`) under the hash of the canonical workspace key (`Notes.workspaceKey`); a save needs the stored revision (`note_conflict` otherwise), a workspace holds 200 notes, and every write runs under the runtime's `notes` mutex; `notes.changed` without content; no module |
| `src/ideas/**`, `src/rpc/ideas.ts` | IDEAS | Stateless global idea notes (02 §9.2 "아이디어 노트", 03 §4.4.1): `IdeaStore` keeps one row per idea (`Kv.idea`, listed by a `Kv.ideasPrefix` scan); a save needs the stored revision (`idea_conflict` otherwise), a create needs text and may carry `createdAt` (an undone removal), 1,000 ideas (`ideas_limit`), writes under the runtime's `notes` mutex; `ideas.changed` without content; no module |
| `src/voice/**`, `src/rpc/voice.ts` | VOICE | Voice input (02 §3.9): `voice.get/set/key.set/transcribe`; settings and minutes in `voice.json` (`runtime.voice`), voice-only keys as vault items `voice-<provider>` through `Credentials.*FeatureKey`/`featureHeaders` (never an account, never `headersFor`), one `@opencode/ai` Transcription per call (`openai-transcription` `gpt-transcribe`, `deepgram-transcription` `nova-3`, `Auth.headers`, `RequestExecutor.fetchLayer`, 90 s); no module, never reads the registry; audio and text are never logged or stored |
| `src/worktree/**`, `src/rpc/worktree.ts` | WORKTREE | Stateless `worktree.inspect` (06 §10.4 #5, TG13): only folders in the project's worktree table (`ctx.worktree.list`), never a UNC or device path; `git worktree list`/`status` via argv; a bounded link-free walk in two passes (breadth-first search for `.git`, then the ignored files' sizes); no module |
| `src/auth/**` | AUTH | `model.request` injection, context/compaction/generate shaping (`codex`/`oai` slots drop `maxTokens`; `siwc` slots drop effort markers; a `ds` slot's `none` variant gets 65,536 when none is set), the D10 `toolset_changed` detection (`toolset.ts` fingerprints), the prefix watch's calls (`PrefixWatch` lives in `telemetry/`; auth creates it because only auth sees the shaped request and then its kind), auth-swap and strip checks |
| `src/credentials/**`, `src/rpc/logins.ts` | CREDENTIALS | API keys, ChatGPT login + refresher, codex import, linked old-app API keys (`legacy.ts`, 02 §3.2b), account guard, Claude subscription import |
| `src/switching/**`, `src/rpc/switch.ts`, `src/rpc/estimate.ts` | SWITCHING | State machine, estimator/planner, bindings, pending switches, compaction orchestration, policy (compaction defaults), session index writes, session compaction value and `compaction.due` (`compaction.ts`), approval bundles (`approval.ts`); IMPORT: `estimate.request` (`rpc/estimate.ts` → `switching.estimateRequest`) and the slot medians of the tracker (`Tracker.slotMeasure`) |
| `src/telemetry/**`, `src/rpc/usage.ts`, `src/rpc/diagnostics.ts` | TELEMETRY | Limits capture, retry classification, ledger (lines of a card with peak windows priced at the request time, D3), cache state, alerts, pollers, usage RPCs; the opt-in wire evidence capture (`capture.ts`, RPC group `rpc/diagnostics.ts`) and the prefix watch (`prefix-watch.ts`, run by auth) |
| `src/plugins/**`, `src/rpc/plugins.ts` | PLUGINS | Claude slot (detect, verify the bundled plugin, changeSource, remote consent), project plugin trust/allowlist (`inventory.ts` `OWN_PACKAGES`: the own bundle folder names in activation order, own-import last since IMPORT, own-harness last since 10 H0). Since 2026-10-18 the Claude plugin ships inside the app (`bundle.ts` `ClaudeBundle`: `app\<ver>\plugins\claude-auth` with its `own-bundle.json`, read and hash-checked; its state folder `<OWN_HOME>\thirdparty\claude-auth`; 02 §8.2); `install.*`, `uninstall.*`, `patch.*` refuse with `internal_error` "built_in" (`rpc/plugins.ts` `builtIn`) and `ack` stores nothing. The former `installer.ts`, `patch.ts` and `config.ts` are gone |
| `src/health/health.ts`, `src/rpc/health.ts` (+ may refine `src/health/guard.ts`) | HEALTH | `health`, startup self-check, `diagnostics.selfTest` |
| `packages/own-telemetry/**` | TELEMETRY-PLUGIN | See its `ARCHITECTURE.md` |

Rules for every module:

- `create(deps, peers)` must not call `peers()`; use it from methods, `start`, or later.
- Hooks and `onEvent` never throw (the dispatcher also catches and logs `hook_failed`/`event_handler_failed`).
- Mutating hooks first check `peers().slots.slot(event.model.providerID)` and return untouched otherwise
  (`anthropic` included, 02 §4.6, I5). Observation hooks are read-only.
- Transforms (`transformProviders`/`transformModels`) do no I/O (02 §3.8); read memory only.
- Never log, return, or emit a secret. Log ids and `Hash.short` values; `deps.log` redacts as a safety net.
- Tests use fake credentials only and never read `D:\#Projects\codex-multi-provider\…` (use
  `test/e2e-kit/fixtures/codex-multi-provider.ts` in a temp dir and the `codexImportRoot` option; for the old app's
  saved API keys `test/e2e-kit/fixtures/legacy-keys.ts`, whose `<tmp>\codex-multi-provider\work\control-center` is
  that option too). They never read this PC's `%USERPROFILE%\.codex` either: Codex files are fixtures in a temp
  folder passed as `codexHome`.
- Session events and session work run only where `meta.local` is true; global events go through
  `deps.emitter.global` (leader only).
- Never call `credential.activate` or any upstream path that flips the global active credential (C4).

## 3. Module contracts (APIs)

Every module implements `Module.Lifecycle` (`start`, `stop`, optional `onEvent`). Public APIs (see the files):

| Module (namespace) | Hot-path / internal API | RPC functions (handler-shaped) |
|---|---|---|
| `Slots` (`slots/slots.ts`) | `slot(providerID)`, `account(id)`, `snapshot()`, `mutate(change)`, `createAccount(NewAccount)`, `transformProviders(editor)`, `transformModels(editor)`, `reload()`, `compaction(providerID, modelID, window?)` (T_slot), `core()`/`refreshCore()` (own global config keep/auto/buffer/model), `model(providerID, modelID)` and `models(providerID)` (a slot's models as they register now: pinned template with the live limit, cost, status and release date, 07 §4.4), `catalog(source)` (the fold's catalog provider, forcing one fold), `impact(ImpactInput)`, `windows(kind)` | `list` (`lastUsedAt` from `ledger.line`, `sessions` and `compaction`), `update` (`compaction`, `dryRun`), `removePlan` (`affectedSessions` from the session index), `removeExecute` |
| `Logins` (`credentials/logins.ts`) | `headers(account, sessionID)`, `refresher(account)`, `unauthorized(account)`, `replaceKey(account, key)`, `forget(account, {shred})` | `addKey`, `chatgptStart/Status/Complete/Cancel`, `codexList/Plan/Execute`, `keysList/Plan/Execute`, `test`, `claudeImport` |
| `Auth` (`auth/auth.ts`) | `settle(event)` (the D10 and prefix-watch comparisons of the request just shaped; `hooks.ts` runs it before the injection in a guard of its own), `onModelRequest(event)` (the credential injection), `onRequestShape(event, hook)` (`hook`: `context`, `compaction` or `generate`; hands the shaped request to the prefix watch last), `onHttpResponse(event)`, `onWsHandshake(event)`, `onWsReceive(event)`, `authSwap(providerID)` (process-wide selfTest verdict), `toolsetChangedAt(sessionID)` (when D10 last saw the session's tools or system change), `onEvent` (`compaction.ended` clears strips; `revert.committed` drops the session's D10 baselines; those two and `instructions.updated` also move the prefix watch's epochs) | – |
| `Switching` (`switching/switching.ts`) | `onPrompt(event)`, `onRetry(event, verdict)`, `isBusy(sessionID)`, `coldExpected(sessionID, providerID)` (ledger `coldExpected`), `compactionView(sessionID)` (`cache.state.compaction`), `onEvent` | `binding`, `estimate`, `estimateRequest` (IMPORT), `apply`, `schedule`, `cancel`, `undo`, `state`, `waitReset`, `setConfirmOverride`, `policyGet`, `policySet`, `compactionSet`, `approvalGet`, `approvalSet` |
| `Telemetry` (`telemetry/telemetry.ts`) | `onModelRequest(event)`, `onHttpResponse(event)`, `onWsReceive(event)`, `onRetry(event) → Verdict`, `alert(input)` (optional `fields` go to the `events.jsonl` line and the log, never to the RPC event or the de-duplication key), `flush()` (queued ledger/cache/stream work, capture reads and writes included), `refreshCacheState(sessionID)`, `onEvent` (revert committed → epoch + cache re-baseline), `capture` (`Capture.Api`, EXT wave 2: `onHttpResponse`, `onWsHandshake`, `onWsReceive`, `onRetry(event, verdict)`, read-only and one property read while no window runs; `recording(sessionID, providerID)` for the prefix watch; `maintain()` from the leader's ledger maintenance, `close()` in `stop`) | `quotaSnapshot`, `ledgerSession`, `usage`, `cacheState`, `cacheSetTtlMode`, `ratecardsGet`, `ratecardsSet`; `capture.start`, `capture.stop`, `capture.status` |
| `Plugins` (`plugins/plugins.ts`) | `claudeSlot()`, `trustStatus()`, `trustSettled()` (waits ≤10 s for the first allowlist check after boot), `locations()`, `claudeOrder()`, `onEvent` | `claudeAuthStatus`, `claudeAuthAck` (stores nothing), `changeSourcePlan/Execute`, `claudeRemoteAck`, `claudeRemoteSet`, `trustList`, `trustApprovePlan/Execute`, `trustRevoke` |
| `Health` (`health/health.ts`) | `check()`; `Guard.check` (pure) | `health`, `selfTest` |
| `SessionSpeed` (`speed/speed.ts`) | `onRequestShape(event, hook)` (context/compaction: `options.serviceTier` on `codex`/`siwc`/`oai`), `onHttpRequest(event)` (Anthropic `speed` + beta on `anth` and the Claude slot, 02 §8.3 I5a), `onHttpResponse`/`onWsReceive` (the error head for the retry, else the served tier, only after a tier was sent), `onRetry(event)` (a refused tier: mark in `runtime.speed`, `decision {retry:true, delay:0}`, `speed_fallback`, `session.speed.changed`), `step({sessionID, providerID, endedAt, tokens})` (the ledger's `speed`, the retention measure), `price`/`credits` (a tier's mode price, a plan's credits multiple), `sharing(accountID, models)` (a siwc catalog's tiers) | `get`, `set` |
| `CodexMeta` (`slots/codex-meta.ts`, T2) | `refresh()` (fetch the Codex model list now, joining one already running; never throws; answers `updated`/`not-modified`/`failed`/`no-slot`/`skipped`), and as functions `current()` (the newest started instance's snapshot in memory, what the fold reads: `Templates.codexLimit`), `snapshot(deps)`, `model(deps, slug)`, `hints(deps)` (the ChatGPT group default's ① config and ② priorities), `load(deps)` (the stored snapshot, else this PC's `models_cache.json`), `file(layout)`, `fetchList(input)` (one GET of `BACKEND`, the single block of endpoint assumptions, ⚠PG7 (나)). CA (2026-10-19, 07 §4.5): `view()` and `setAutoVersion(on)` (the setting `Codex 최신 모델 자동 확인`, the version asked, the registry's newest release, the rows left out), and as functions `fetchLatest(input)` (one GET of `LATEST`, `@openai/codex`'s `latest` on the npm registry: only `accept` and a fixed `user-agent`, only `version` read), `release(value)`, `newer(a, b)`, `clientVersion(stored)` (the newer of `BACKEND.clientVersion` and the stored release while on, never lower). The control Location reads the registry at most once a day, only while a ready codex account exists, before the start's fetch and from a daily timer; a changed version asks every list again in full | `codexModels.get`, `codexModels.set` (`src/rpc/codex-models.ts`) |
| `Presets` (`presets/presets.ts` over `PresetStore`, `presets/store.ts`) | `onToolBefore(event)` (subagent gate), `onToolAfter(event)` (`opencode_models` filter), `transformAgents(editor)`, `removedAgentModels()` (every live instance's, through `agents.removed.query`), `recheckAgents()` (the Claude slot changed: reload the agents when a judgement differs), `groupOf(providerID)` (the gate's group mapping, also for the binding), `star(group)`, `preset(id, group)`, `defaultFor({kind, providerID})` (the model and effort a new session on that account starts with; decides the group's `auto` value in memory the first time), `known(group)` (the group default as known now; never decides), `onEvent` (after `provider.updated` settles, the leader writes the `auto` value of every group that has accounts but no default: the T0 migration and a group's first account). T2: `repairs()` (`PresetStore.Api`: one `Preset.Repair` per gone model across every group, with each use and its suggestion; reads only), `repair.main(ref)` (a root's main model or level gone, with the switch to offer: `session.preset.get` `main`) and `repair.check()` (run the presence check now; otherwise it runs `SETTLE_MS` after `models-dev.refreshed`, a local provider refold and a `presets.json` change). T4: `resolver.localWindow(providerID, modelID)` (a local model's running window for a pool card) | `list` (never writes; T2 adds `repairs`, each group's `history` and `retirements`; T4 `poolHistory`), `set` (T2 `repairOf`: records the fix in `groups[g].history` when the stored preset had that model pinned in that place; T4: a model pool is checked (`pool_invalid`), stored with mode `same` and frozen cards (`refreshCards` freezes them again), and a `pool:<key>` fix goes to `groups[g].poolHistory`), `defaultsSet`, `suggest` (T4 `pool`: candidates and `추천 묶음`) |

Cross-module calls (who calls whom):

- `auth` → `slots.slot`, `plugins.trustStatus`/`trustSettled`, `logins.headers`, `telemetry.alert`
  (`toolset_changed`, `sharing_unsupported_input`, and the prefix watch's `prefix_diverged`),
  `telemetry.capture.recording` (the prefix watch:
  whether a capture window records the session and slot); writes the prefix watch's `prefix` lines through
  `runtime.ledger.event`; reads `runtime.lastResponse` for strip patterns.
- `switching` (planner) → `auth.toolsetChangedAt` (the estimator's `Context.toolsetAt`, D10 `W = 0`).
- `telemetry` (capture) → `runtime.broadcast` `ledger.line` (a running window's `steps`), `telemetry.alert`
  (`capture_empty`).
- `hooks.ts` (`Repeat`) → `slots.slot` (whether a primary request's provider is an own slot), `runtime.policy.cached()`
  (`repeatReminderExclude`, read at every call).
- `telemetry` → `slots.slot/account`, `slots.model` (catalog price of an own slot model), `logins.unauthorized` (401), `switching.coldExpected` (read in `onEvent` before switching settles the step), `runtime.limits/ledger/lastResponse/broadcast`.
- `switching` → `PresetBinding.ensure` (root `session.created`, in the session's `run(sessionID)` queue after
  `setHome`/`pin()`; writes `{presetID: ★ ?? builtin:<group>, group, revision: 0, appliedAt, entryHash: null}` only
  when `sess:<root>:preset` is absent, 07 §5.1, §3.3), with `presets.groupOf` and `presets.star`.
- `plugins` → `presets.recheckAgents` (`setSlot`: the Claude slot's detection decides whether `anthropic` is a
  subscription slot for the hidden agents' check).
- `presets` (gate, models filter, agents; 07 §5.4) → `runtime.sessions` (root lookup), `ctx.session.get`,
  `ctx.agent.get`, `ctx.agent.transform/reload`, `slots.slot/account`, `plugins.claudeSlot`, `runtime.limits` (`Planner.usability`),
  `telemetry.quotaSnapshot` (budget window) and `telemetry.alert` (`subagent_rejected`, `subagent_model_overridden`,
  `internal_agent_model_removed`).
- `switching` → `presets.defaultFor` (`pin()` of a session created without a model, 07 §2.2), `presets.known` (the
  planner's fallback target model), `slots.model` (the planner's target window and price), `plugins.claudeSlot`.
- `presets` → `slots.snapshot/models/catalog`, `plugins.claudeSlot`, `runtime.presets`.
- `presets` (repair, T2) → `presets.repairs` (the presence check), `presets.resolver.main/inventory`,
  `presets.defaultFor`, `CodexMeta.snapshot` (successors from `upgrade.model`, levels in Codex's order),
  `ctx.session.get` (a local user prompt's root), `telemetry.alert` (`preset_needs_repair`,
  `group_default_model_missing` once per model event, leader only; `session_model_unavailable`,
  `session_variant_unavailable`), `deps.emitter.global("presets.changed")` when the standing notices change.
- `codexMeta` (T2) → `slots.snapshot` (ready `codex` slots), `logins.headers` (the fetch's auth, never logged),
  `slots.reload` (a changed snapshot), `telemetry.alert` (`effort_update_drift`, once per model, leader only),
  `deps.emitter.global("codexModels.changed")` (CA, control Location only, when its view changed). `slots`
  (the template diff, control Location only) → `telemetry.alert` (`template_update_available`, once per change).
- `health` → `Templates.unverifiedCodex` over `slots.snapshot` (`codex_window_unverified`, one alert per model).
- `switching` → `slots` (targets, bindings, `compaction`, `core`, `impact`, `windows`), `telemetry` (via runtime
  limits/ledger and `Verdict`; `refreshCacheState`), `logins` (prefetch on estimate/apply),
  `ctx.session.get/wait/switchModel/prompt/update` (the waitReset resume prompt carries
  `metadata: {source: "own.accounts"}`, 06 §10.4 #2), `runtime.sessions` (writes the index for its Location's sessions).
- `telemetry` → `switching.compactionView` (`cache.state.compaction`).
- `health` → `slots.refreshCore` (`compaction_buffer_set`/`compaction_auto_off` warnings).
- `slots` → `logins.replaceKey/forget` (update/remove), `plugins.claudeSlot` (anthropic activation in the fold).
- `logins` → `slots.createAccount/mutate/account`, `plugins.claudeSlot` (ack before `claudeImport`).
- `health` → `slots`, `plugins`, `auth.authSwap`, `telemetry.alert`.
- `speed` (02 §4.8) → `slots.slot/model/models/catalog/account`, `plugins.claudeSlot`, `logins.headers` (a siwc catalog read), `telemetry.alert` (`speed_fallback`, `speed_downgraded`), `runtime.speed` (marks, siwc lists, retention), `runtime.sessions` (root and main), `runtime.ratecards` (`speed` cards, else the seed's), `CodexMeta.accountModel`/`model`; `telemetry` → `speed.step/price/credits` (ledger lines); `logins` → `speed.sharing` (`accounts.test` of a siwc account); `codexMeta` → `runtime.speed.clear` (an account's list read again).
- Everyone → `telemetry.alert(...)` to raise alerts; → `deps.emitter` for their own events.

Every RPC function and hook is implemented (Phase 2). `plugins.trustStatus()` fails closed (`blocked_by_plugin`)
until this Location's plugin list has been checked; `model.request` waits for that first check through
`plugins.trustSettled()` (bounded) instead of sending the first request after boot without a credential.

## 4. Hook dispatch (`src/hooks.ts`)

| Hook (registered once, unscoped) | Dispatch order | Notes |
|---|---|---|
| `provider.transform` | `slots.transformProviders` | slot registration (3.6), catalog snapshot (3.6a), `anthropic` activation (8.4), `hideBuiltinProviders`; T2: the pinned-template diff checked in the fold and written after it by the control Location (07 §4.4), Codex windows from the in-memory metadata (`CodexMeta.current()`) |
| `model.transform` | `slots.transformModels` | reserved |
| `skill.transform` | `Skills.transform` (`src/skills.ts`) | the built-in `opencode` skill's own section (content only); no I/O in the fold |
| session `model.request` | `Repeat.onModelRequest` → `auth.settle` → `auth.onModelRequest` → `telemetry.onModelRequest` | a primary request tells the reminder whether its (session, agent) is on an own slot; D10 and the prefix watch settled here, because only this hook carries the kind (in a guard of its own, so a failing alert or ledger write never keeps the credential off the request); auth headers (waits for the first allowlist check after boot, `plugins.trustSettled`); kind/provider correlation for the ledger |
| session `context`, `compaction`, `generate` | `auth.onRequestShape` → `speed.onRequestShape` (context, compaction) | same deterministic transform (D1, D2, D9, 4.4, 4.5; on `context` and `compaction` only, `codex`/`oai` slots drop `maxTokens` and a `ds` slot's `none` variant gets 65,536 when none is set; a `generate` caller's limit stays), then leaves the request's D10 fingerprint for `model.request`; last, the prefix watch's blocks while a capture window records the session and slot |
| session `prompt` | `Repeat.onPrompt` → `switching.onPrompt` | user input resets every reminder chain of the session; `delivery → "queue"` for busy sessions with a pending switch; no `switchModel` before AC-P26 |
| session `http.request` (02 §4.8; on a remote service also the sink) | `speed.onHttpRequest` → `remote.onHttpRequest` | registered on this PC too since the speed: an Anthropic request of a session that turned Fast on (or already sent the beta) gets `speed` and the fast-mode beta; every other request passes untouched without its body read |
| session `http.response` | `telemetry.capture.onHttpResponse` → `telemetry.onHttpResponse` → `auth.onHttpResponse` → `speed.onHttpResponse` | read-only (the capture's header census, error-body shape and background stream read while a window runs; auth swap check, strip patterns) |
| `agent.transform` | `presets.transformAgents` | setup fold: the own role agents `own-review`/`own-quick`/`own-deep` (hidden, T1) and hidden agents' subscription-slot models removed (07 §5.4); the presets module registers the model check again after each local `plugin.updated` so it runs after core's `ConfigAgentPlugin` |
| tool `execute.before` | `presets.onToolBefore` → `Repeat.before` | subagent gate (07 §5.4, replaces 02 §5.11 rule 2): T1 maps roles to targets within the allowed set, falls back along the role row, checks budgets, paid consent and the caps (synchronous reservations in `@own/runtime`); T4 maps a model pool's names (or the default rule) to Refs, a pick that cannot run now going to the agent's default with a notice; never writes session state. The reminder notes a running Code Mode `execute` call, whose program's calls it does not count |
| tool `execute.after` | `Gate.after` → `presets.onToolAfter` → `Repeat.after` | settles the call's reservation; `opencode_models` filter to the allowed providers (07 §5.4); last, on an own slot, the 3rd, 5th and 8th identical call in a row gets the reminder before its result text (D4, never blocks) |
| permission `evaluate` (T1, registered last) | `ReadOnly` (`presets/readonly.ts`) | `explore` (edit, shell, computer) and `own-review` (edit, computer) sessions are turned back to `deny`, whatever the parent's approval mode; tighten only, an incoming `deny` is never changed (07 §2.4, PG10) |
| `experimental.ws.handshake` | `auth.onWsHandshake` → `telemetry.capture.onWsHandshake` | read-only auth swap check for WebSocket slots (codex); the capture's handshake header names |
| `experimental.ws.receive` | `telemetry.capture.onWsReceive` → `telemetry.onWsReceive` → `auth.onWsReceive` → `speed.onWsReceive` | read-only, substring prefilters (limits frames; error frames for strip patterns); the capture's frame structures and counts |
| session `retry` | `telemetry.onRetry` → `switching.onRetry(event, verdict)` → `speed.onRetry(event)` → `telemetry.capture.onRetry(event, verdict)` | classification then (Phase 3) failover; the capture's line last, so it has the decision core gets |

Event dispatch (`src/events.ts`): every event goes to `onEvent` in `Modules.EVENT_ORDER` = telemetry, switching,
plugins, slots, codexMeta, logins, auth, speed, health, presets, with `meta.local`. `Modules.ORDER` (start; stop in reverse)
is slots, codexMeta (the snapshot is in memory before the first fold reads it), presets, logins, plugins, telemetry,
switching, auth, health.

## 5. Runtime broadcast topics (`@own/runtime` `Broadcast.Topics`)

| Topic | Emitted by | Listened by |
|---|---|---|
| `store.changed{store, origin}` | slots (`accounts`), switching (`policy`), telemetry (`ratecards`), plugins (`trust`), presets (`presets`), codexMeta (`codex-meta`, T2: a fetch wrote the snapshot); the leader's fs watcher (`slots/watch.ts`) for `origin:"external"` | slots (reload providers, refresh memory), logins (`policy.secretCacheSeconds` → `runtime.credentials.configure`), switching (policy), telemetry (ratecards), plugins (trust → re-check allowlist), presets (re-read; the leader emits `presets.changed`; no provider reload; the repair check runs after it settles), codexMeta (`codex-meta`: re-read the snapshot, reload providers only when its models changed; `accounts`: a newly captured codex template makes the control Location fetch) |
| `claudeSlot.changed` | plugins | slots (provider reload in every Location) |
| `limits.updated{windows}` | telemetry, own-telemetry | telemetry (leader emits `quota.updated`) |
| `exhausted{exhaustion, providerID, sessionID?}` | telemetry, own-telemetry | switching (T-HARD/T-AUTH, local sessions), telemetry (leader emits `account.status`) |
| `alert{…}` | own-telemetry (`claude_extra_usage`) | telemetry (re-emits `alert`; session alerts from the session's Location instance) |
| `ledger.line{eid, line}` | telemetry | switching (`switch.recorded.actual`), slots (`accounts.list` `lastUsedAt`), telemetry's capture (a running window's `steps`, counted in the instance that started it) |
| `location.state` (Location allowlist state) | plugins (each instance, its own Location) | plugins leader (`plugin.trust.changed`, `untrusted_plugin`) |
| `location.query{reply}` (synchronous) | plugins (`locations()`: health, `plugin.trust.list`) | every live plugins instance replies with its state |
| `auth.swap{providerID, verdict}` | auth (on a changed verdict) | auth (every instance keeps the process-wide latest; `diagnostics.selfTest` runs in control) |
| `agents.removed.query{reply}` (synchronous) | presets (`removedAgentModels()`: `diagnostics.selfTest.agentModels`) | every live presets instance replies with what its agent folds removed (a project config is folded only in its Location) |

## 6. RPC method → group file → module function (all 80 methods of `OwnAccounts.Definition`, EXT wave 2, the speed, IMPORT, the workspace notes, VOICE and the remote Claude relay)

Scopes and locations per method are exported by the protocol: `OwnAccounts.MethodScope` (`read|prompt|switch|admin|local`,
02 §9.1) and `OwnAccounts.MethodLocation` (`control|session`); `OwnAccounts.EventOrigin` names each event's publisher.

| Method | Group file (owner) | Module function |
|---|---|---|
| `health` | `rpc/health.ts` (HEALTH) | `health.health` |
| `diagnostics.selfTest` | `rpc/health.ts` (HEALTH) | `health.selfTest` |
| `diagnostics.capture.start`, `diagnostics.capture.stop`, `diagnostics.capture.status` (EXT wave 2) | `rpc/diagnostics.ts` (TELEMETRY) | `telemetry.capture.start`, `telemetry.capture.stop`, `telemetry.capture.status` |
| `accounts.list` | `rpc/accounts.ts` (SLOTS) | `slots.list` |
| `accounts.update` | `rpc/accounts.ts` (SLOTS) | `slots.update` (→ `logins.replaceKey` for `replaceKey`) |
| `accounts.remove.plan` | `rpc/accounts.ts` (SLOTS) | `slots.removePlan` |
| `accounts.remove.execute` | `rpc/accounts.ts` (SLOTS) | `slots.removeExecute` (→ `logins.forget`) |
| `accounts.add.key` | `rpc/logins.ts` (CREDENTIALS) | `logins.addKey` |
| `accounts.add.chatgpt.start` | `rpc/logins.ts` (CREDENTIALS) | `logins.chatgptStart` |
| `accounts.add.chatgpt.status` | `rpc/logins.ts` (CREDENTIALS) | `logins.chatgptStatus` |
| `accounts.add.chatgpt.complete` | `rpc/logins.ts` (CREDENTIALS) | `logins.chatgptComplete` |
| `accounts.add.chatgpt.cancel` | `rpc/logins.ts` (CREDENTIALS) | `logins.chatgptCancel` |
| `accounts.import.codex.list` | `rpc/logins.ts` (CREDENTIALS) | `logins.codexList` |
| `accounts.import.codex.plan` | `rpc/logins.ts` (CREDENTIALS) | `logins.codexPlan` |
| `accounts.import.codex.execute` | `rpc/logins.ts` (CREDENTIALS) | `logins.codexExecute` |
| `accounts.import.keys.list` | `rpc/logins.ts` (CREDENTIALS) | `logins.keysList` |
| `accounts.import.keys.plan` | `rpc/logins.ts` (CREDENTIALS) | `logins.keysPlan` |
| `accounts.import.keys.execute` | `rpc/logins.ts` (CREDENTIALS) | `logins.keysExecute` |
| `accounts.test` | `rpc/logins.ts` (CREDENTIALS) | `logins.test` |
| `plugin.claudeAuth.importSubscription` | `rpc/logins.ts` (CREDENTIALS) | `logins.claudeImport` |
| `session.binding` | `rpc/switch.ts` (SWITCHING) | `switching.binding` |
| `switch.estimate` | `rpc/switch.ts` (SWITCHING) | `switching.estimate` |
| `estimate.request` (IMPORT, 09 §5.6) | `rpc/estimate.ts` (SWITCHING) | `switching.estimateRequest` |
| `switch.apply` | `rpc/switch.ts` (SWITCHING) | `switching.apply` |
| `switch.schedule` | `rpc/switch.ts` (SWITCHING) | `switching.schedule` |
| `switch.cancel` | `rpc/switch.ts` (SWITCHING) | `switching.cancel` |
| `switch.undo` | `rpc/switch.ts` (SWITCHING) | `switching.undo` |
| `switch.state` | `rpc/switch.ts` (SWITCHING) | `switching.state` |
| `switch.waitReset` | `rpc/switch.ts` (SWITCHING) | `switching.waitReset` |
| `switch.setConfirmOverride` | `rpc/switch.ts` (SWITCHING) | `switching.setConfirmOverride` |
| `policy.get` | `rpc/switch.ts` (SWITCHING) | `switching.policyGet` |
| `policy.set` | `rpc/switch.ts` (SWITCHING) | `switching.policySet` |
| `compaction.setSession` | `rpc/switch.ts` (SWITCHING) | `switching.compactionSet` |
| `session.approval.get` | `rpc/switch.ts` (SWITCHING) | `switching.approvalGet` |
| `session.approval.set` | `rpc/switch.ts` (SWITCHING) | `switching.approvalSet` |
| `quota.snapshot` | `rpc/usage.ts` (TELEMETRY) | `telemetry.quotaSnapshot` |
| `ledger.session` | `rpc/usage.ts` (TELEMETRY) | `telemetry.ledgerSession` |
| `accounts.usage` | `rpc/usage.ts` (TELEMETRY) | `telemetry.usage` |
| `cache.state` | `rpc/usage.ts` (TELEMETRY) | `telemetry.cacheState` |
| `cache.setTtlMode` | `rpc/usage.ts` (TELEMETRY) | `telemetry.cacheSetTtlMode` (MVP: `unsupported_strategy`) |
| `ratecards.get` | `rpc/usage.ts` (TELEMETRY) | `telemetry.ratecardsGet` |
| `ratecards.set` | `rpc/usage.ts` (TELEMETRY) | `telemetry.ratecardsSet` |
| `plugin.claudeAuth.status` | `rpc/plugins.ts` (PLUGINS) | `plugins.claudeAuthStatus` |
| `plugin.claudeAuth.ack` | `rpc/plugins.ts` (PLUGINS) | `plugins.claudeAuthAck` |
| `plugin.claudeAuth.install.plan` | `rpc/plugins.ts` (PLUGINS) | `builtIn` (refuses, 2026-10-18) |
| `plugin.claudeAuth.install.execute` | `rpc/plugins.ts` (PLUGINS) | `builtIn` (refuses, 2026-10-18) |
| `plugin.claudeAuth.uninstall.plan` | `rpc/plugins.ts` (PLUGINS) | `builtIn` (refuses, 2026-10-18) |
| `plugin.claudeAuth.uninstall.execute` | `rpc/plugins.ts` (PLUGINS) | `builtIn` (refuses, 2026-10-18) |
| `plugin.claudeAuth.changeSource.plan` | `rpc/plugins.ts` (PLUGINS) | `plugins.changeSourcePlan` |
| `plugin.claudeAuth.changeSource.execute` | `rpc/plugins.ts` (PLUGINS) | `plugins.changeSourceExecute` |
| `plugin.trust.list` | `rpc/plugins.ts` (PLUGINS) | `plugins.trustList` |
| `plugin.trust.approve.plan` | `rpc/plugins.ts` (PLUGINS) | `plugins.trustApprovePlan` |
| `plugin.trust.approve.execute` | `rpc/plugins.ts` (PLUGINS) | `plugins.trustApproveExecute` |
| `plugin.trust.revoke` | `rpc/plugins.ts` (PLUGINS) | `plugins.trustRevoke` |
| `presets.list` | `rpc/presets.ts` (PRESETS) | `presets.list` |
| `presets.defaults.set` | `rpc/presets.ts` (PRESETS) | `presets.defaultsSet` (remote: `remote_managed`) |
| `presets.suggest`, `presets.set`, `presets.remove` (T1) | `rpc/presets.ts` (PRESETS) | `presets.suggest`, `presets.set`, `presets.remove` (remote: `remote_managed`) |
| `session.preset.get`, `session.preset.apply`, `session.ultra.set`, `session.preset.raiseOnce`, `session.preset.consent` (T1) | `rpc/session-preset.ts` (PRESETS) | `presets.sessionGet`, `presets.sessionApply`, `presets.ultraSet`, `presets.raiseOnce`, `presets.consent` |
| `session.speed.get`, `session.speed.set` (02 §4.8) | `rpc/speed.ts` (SPEED) | `speed.get`, `speed.set` |
| `notes.list`, `notes.get`, `notes.put`, `notes.remove` (02 §9.2) | `rpc/notes.ts` (NOTES) | `NoteStore.list`, `NoteStore.get`, `NoteStore.put`, `NoteStore.remove` (remote: `remote_managed`, the notes live on this PC) |
| `ideas.list`, `ideas.put`, `ideas.remove` (02 §9.2) | `rpc/ideas.ts` (IDEAS) | `IdeaStore.list`, `IdeaStore.put`, `IdeaStore.remove` (remote: `remote_managed`, the ideas live on this PC) |
| `voice.get`, `voice.set`, `voice.key.set`, `voice.transcribe` (VOICE) | `rpc/voice.ts` (VOICE) | `VoiceInput.create(deps)`: `get`, `set`, `setKey`, `transcribe` (`src/voice/voice.ts`); all four in `REMOTE_MANAGED` |
| `worktree.inspect` | `rpc/worktree.ts` (WORKTREE) | `WorktreeInspect.inspect` after both folders are found in the project's worktree table (`ctx.worktree.list`); also answered on a remote service, not in `REMOTE_MANAGED` |

`Register.handlers` is typed `RpcTypes.Handlers`, so a protocol method without a handler fails the typecheck, and
`test/skeleton.test.ts` checks that every method sits in exactly one group. Handlers return declared errors with
`context.error(type, message, data)`; a throw becomes HTTP 500 `rpc.internal`. Plan/execute pairs keep their
payload in a module-local `Nonces.Scope<T>` (5 min, one-time).

## 7. Events → publisher

| Event (`rpc.own.accounts.*`) | Kind | Publisher module |
|---|---|---|
| `accounts.changed` | global | slots (`mutate`) |
| `quota.updated` | global | telemetry (own slots + own-telemetry's `limits.updated`) |
| `account.status` | global | logins (login progress, refresh, `needs_reauth`, `codex_source_stale`), telemetry (exhaustion, auth failure) |
| `cache.state`, `ledger.step` | session | telemetry |
| `binding.changed`, `switch.recorded`, `switch.scheduled`, `switch.state`, `switch.suggested` | session | switching |
| `compaction.due`, `approval.changed` | session | switching |
| `alert` | session or global | telemetry (`alert(input)`; everyone raises through it) |
| `plugin.status`, `plugin.trust.changed` | global | plugins |
| `presets.changed` | global | presets (`store.changed{store:"presets"}`; `removed` for deleted presets, T1; T2: also when the standing repair notices change while `presets.json` stays the same, so clients read `presets.list` again) |
| `session.preset.changed` (T1) | session | presets (binding writes: `session.preset.apply`, ultra, a ★ rebind after a removal) |
| `session.speed.changed` (02 §4.8) | session | speed (`session.speed.set`, a refused tier, a cooldown and its end, a downgrade) |
| `ideas.changed` (02 §9.2) | global | ideas (`rpc/ideas.ts` after a saved `ideas.put` or an `ideas.remove` that removed) |
| `notes.changed` (02 §9.2) | global | notes (`rpc/notes.ts` after a saved `notes.put` or a `notes.remove` that removed; the calls arrive at the control Location, which leads) |

## 8. KV keys (`ctx.storage`, own-accounts namespace, `Kv` in `@own/protocol`)

| Key | Owner |
|---|---|
| `sess:<sid>:switch`, `sess:<sid>:home`, `sess:<sid>:confirmOverride` | switching |
| `sess:<sid>:compaction`, `sess:<sid>:compactionDue`, `sess:<sid>:children` | switching |
| `sess:<sid>:preset` (root sessions only) | presets (`binding.ts`, written from switching's `session.created`; T1 `apply.ts`, `ultra.ts`) |
| `sess:<sid>:presetUsage`, `sess:<sid>:presetConsent` (root sessions only, T1) | presets (`usage.ts`, `consent.ts`) |
| `sess:<sid>:strip` | auth |
| `sess:<sid>:cache:<pid>`, `sess:<sid>:epoch`, `sess:<sid>:ttlMode:<pid>` | telemetry (auth reads `ttlMode` and the watermark) |
| `ack:claudeAuth` (neither read nor written since 2026-10-18), `ack:claudeRemote` | plugins |
| `sess:<sid>:speed` (a root's choice; any session's Anthropic beta), `ack:claudeFast` | speed |
| `notes:<workspace hash>`, `notes:<workspace hash>:<note id>` | notes (`notes/store.ts`) |
| `ideas:<idea id>` | ideas (`ideas/store.ts`) |

## 9. Plugin options and endpoints

`src/options.ts` (validated once in setup). Test-only: `vault: "memory"`, `buildId` (give own-telemetry the same),
`endpoints: { codex, openai, anthropic, deepseek, xai, openrouter, oauthIssuer, chatgpt }`, `codexImportRoot`,
`codexHome` (`test/support/deps.ts` and the e2e server's `CODEX_HOME` point at an empty temp folder).
`Endpoints.resolve` gives `url` (override or production default) and `overrides`; overridden provider URLs are also
the slot's static `settings.baseURL` (codex always writes `url.codex`). The fake Codex server maps to
`{ codex: fake.baseURL, oauthIssuer: fake.url }`. Guard 1 needs `OWN_OPEN_CODE=1` in the server env.

## 10. Testing

- Unit: `test/support/deps.ts` (`testDeps({ ctx: { … } })`) gives a real runtime on a temp home with the memory vault,
  a manual clock, and a strict fake context (touching a member the test did not provide throws). Use
  `modules({ slots: fakeFactory })` to replace peers. Put module tests in `test/<module>/`.
- E2E: `test/e2e-kit` (fakes + `startOpencodeServer`); `test/plugin.test.ts` shows loading both plugins. The presets rig
  (`startPresetRig`: linked ChatGPT accounts on one fake Codex backend, registry-only `siwc` accounts, the
  `service-local.json` registration the `own.preset` writer reads) carries the 07 gate suites
  `test/presets/pg{2,4,10,11}.e2e.test.ts` (T1) and the PG3 delegation A/B runner `test/pg3/` (`--fake` in
  `bun test test/pg3`; `--real` only when the user runs it, see the file header). T2 adds to the rig a catalog variant
  (`catalog`: `bundledCatalog()` + `catalogVariant(base, edits)`, `OPENCODE_MODELS_PATH`,
  `test/e2e-kit/fixtures/catalog-variants/README.md`), Codex metadata in `OWN_HOME` (`codexMeta`, `setCodexMeta`,
  `codexMetaFixture()`), the control Location with client-style routing (`control`), and `restart` on the same temp root;
  they carry `test/presets/pg5.e2e.test.ts` (PG5 catalog changes) and `pg6.e2e.test.ts` (PG6's T2 thresholds).
- The PG7 (나) probe of the Codex model list is `own/scripts/codex-meta-probe.ts` (repository scripts): `--self-test`
  against a local fake; `--yes` against the real backend only when the user runs it.
- EXT wave 1: the e2e-kit fakes take wire faults (`WireFault`: reset before headers, a drop after N deltas or right
  after a tool-call delta, EOF without the terminal event, a malformed chunk, a Codex WebSocket close, a delayed
  listen; `test/e2e-kit/README.md`), driven over four own slots by `test/switching/wire-failures.e2e.test.ts`;
  `test/presets/pg4.e2e.test.ts` ends with the `toolset_changed` positive control (a custom agent added mid-session,
  one alert); the telemetry seeds leave `pollBalance` off, and the balance-poller test opts in against the loopback
  fake, so no test calls the real DeepSeek API.
- EXT waves 2–4: `test/telemetry/capture.test.ts` (off by default, both modes, the window's filters, a window started
  in the control instance recording another Location's hooks, its end and `capture_empty`, retention),
  `test/auth/output-limit.test.ts` (D2), `test/skills.test.ts` (the `report` edit, D5), `test/switching/rates.test.ts`
  (peak windows, estimator rates at the planner clock, ds ledger costs at the step's request time, D3),
  `test/guard/repeat.test.ts` (D4, also through `hooks.ts`) and `test/telemetry/prefix-watch.test.ts` (each cause, off
  without a window). `test/presets/pg4.e2e.test.ts` runs a `hash` capture window for the whole file: every own-slot
  primary request gets a `prefix` line that is `first` or `append`, none is `unexplained`, no `prefix_diverged` is
  raised, and the `toolset_changed` control's request is `toolset` at `tools`; it compares tool and instruction
  sections with `Prefix.section` (`@own/runtime`).
- Repository scripts that drive real accounts (EXT wave 2): `own/scripts/ds-probe.ts` (DeepSeek cache warm window,
  thinking-history acceptance, opt-in `max_tokens` pre-allocation) and the gates `own/scripts/gates/g7.ts`, `g8.ts`
  (over the capture). They print the plan by default, `--self-test` runs them against the e2e-kit fakes on 127.0.0.1,
  and `--yes` (g8 also `--watch`/`--collect`) only when the user runs them.
- Run from `packages/own-accounts`: `bun run typecheck`, `bun test`.

## 11. Protocol changes (spec 02 v0.3/v0.4)

Landed in Phase 2 integration (additive): alert codes `compaction_threshold_mismatch`, `toolset_changed`,
`generate_usage_missing` (telemetry raises the last one; auth raises `toolset_changed` since EXT wave 1, below);
`Estimate.Warning` `target_compacts_soon`, `compaction_may_truncate` (the estimator no longer filters them);
`Ledger.Line.usageSource` and `purpose` (telemetry writes `usageSource`); `probe_failed` on `accounts.update`
(`replaceKey`).

Landed in Phase 3 (backend for the UI of 03):

- Auto-compaction (02 §4.7): `Compaction` namespace (`Setting`/`SettingInput`, `Source`, `Effective`, `View`,
  `Impact`, `ByKind`, `defaults`, pure `chain`/`resolve`/`withSession`/`check`/`cycleCost`/`truncates`); slot models
  register `limit.input = ctx_eff` from the full chain (kind constant → `policy.compaction.byKind` → kind×model →
  account → account×model) with `K` from the own global config (SLOTS, `core-config.ts`);
  `accounts.update{compaction, dryRun}` + `compactionImpact` and `accounts.list.compaction` (SLOTS);
  `policy.get.compactionDefaults`, `policy.set{patch.compaction.{byKind,keepTokens}, dryRun}` (SWITCHING; keep is
  written to `%OPENCODE_CONFIG_DIR%\opencode.jsonc`, never to policy.json); `compaction.setSession`,
  `compaction.due` on `step.ended`, `cache.state.compaction`, staged-revert guard (`revert_staged` on
  `switch.apply`, `available:false, reason:"revert_staged"` in `switch.estimate`) (SWITCHING, `compaction.ts`);
  revert committed → epoch + cache re-baseline (TELEMETRY); `switch.estimate.target.compactAt` (planner).
- `Account.Info.method` (`chatgpt-device`/`chatgpt-browser`/`api-key`; imports keep deriving
  `codex-linked`/`codex-takeover` from `credential`), shown as `accounts.list` `connection.method`.
- Session → slot index (`@own/runtime` `Sessions.Index`, `state\sessions.json`, leader saves every 30 s and on
  release): `accounts.list.sessions{running,total}`, `accounts.remove.plan.affectedSessions`, `compactionImpact`.
  Written by the instance of each session's Location from its events; sessions not seen since the index existed
  appear after their next event or lookup.
- `OwnAccounts.MethodScope` (`read|prompt|switch|admin|local`, the 02 §9.1 table: T1 17/1/12/8/25 = 63 methods),
  `OwnAccounts.MethodLocation` (`control|session`), `OwnAccounts.EventOrigin`.
- `session.approval.get/set` + `approval.changed` (v0.4, 03 §18.8): bundles built here (`approval.ts`), protected
  paths appended last in every mode, read-merge-write of parent and unfinished children (KV `sess:<sid>:children`).
- v0.4 small ones: `RestartService` without `configDir` (`changeSource.execute` writes `OWN_HOME\claude-auth.json`),
  `changeSource.plan{configDir: null}` (+ `setting_out_of_range` for a relative path), `Switch.ChildPolicy`,
  alert `subagent_model_overridden`, errors `setting_out_of_range`/`revert_staged`, KV keys `compaction`,
  `compactionDue`, `children`, `childPolicy`.
- The switching module no longer keeps its own location-less event workaround: `events.ts` `Places` decides
  `meta.local` for everyone (lookups in `current()`, `rearm` and the prompt hook teach it).

Landed in T0 (06 §10.4, 07 §8.3 T0; listed in 02 §9.5 "T0 변경"):

- Subagent gate (02 §5.11 rule 2 → 07 §5.4): `execute.before` on `subagent` (`presets/{access,gate}.ts`),
  `execute.after` on `opencode_models` (`presets/models-filter.ts`), hidden agents' subscription-slot models
  (`presets/agents.ts`, setup plus late registration), assembled in `presets/presets.ts`. Alerts `subagent_rejected`,
  `internal_agent_model_removed`; `subagent_model_overridden` now means a configured subscription-slot `agent.model`
  ran on the parent's Ref; `diagnostics.selfTest.agentModels`. The upstream behavior it relies on is registered in
  `own/upstream-surface.json` (`subagent-*`, `opencode-models-tool`, `tool-effective-name`, `tool-hook-order`,
  `tool-hook-shapes`, `tool-called-input-pre-hook`, `builtin-plugin-placement`, `plugin-updated-after-activation`,
  `agent-title-model-fallback`, `agent-hidden-callable`).
- `Preset` module (`@own/protocol` `preset.ts`), `presets.json` with each group's new-session default model,
  `presets.list` + `presets.defaults.set` + `presets.changed`, KV `sess:<root>:preset` (`presets/binding.ts`).
- `worktree.inspect` (`worktree/inspect.ts`, `rpc/worktree.ts`) with its method-only errors `not_found`/`not_git`.
- Removed: alert `compact_advice`, the advice thresholds and `compactAdviceUsedPercent`, `policy.defaults.global`;
  registry `slots[].defaultModel` is no longer read or written.

Landed in T1 (07 §8.3 T1; listed in 02 §9.5 "T1 변경"):

- Presets: `presets.set/remove/suggest`, `session.preset.get/apply`, `session.ultra.set`, `session.preset.raiseOnce`,
  `session.preset.consent` (spec addition), `session.preset.changed`; starters, lighter pairs, ★ and the new-session
  start preset; the `own.preset` guidance entry written over self-HTTP (`ServiceTarget`), skipped when its hash is the
  binding's. `session.preset.apply` with a new `team` for the preset the session is already bound to is accepted when
  only that preset's own pinned targets break R4 with that team (`apply.ts`; the gate routes those roles, own.team posts
  the repair notice, 06 §10.1); a team context that breaks R4 by itself and every new preset choice are still refused.
- Gate T1 (07 §5.4): role targets within the allowed set, the fallback order, budgets, paid consent, caps and
  reservations, the read-only roles' tighten-only `evaluate` hook (`computer` included), R4 with one ChatGPT login's
  `codex`/`siwc` counted once (for the main's company only the main account itself is a target).
- Switching (07 §5.5): the session-tree wait (`Estimate.busyChildren`, `switch.apply{children}`), the team filter
  (`switching/targets.ts`, `switch.suggested`), `teamOp` (`switch.apply` checks it is own.team's running
  `team-account` op of the session's team through `ctx.rpc` own.team `op.get`) and `team_switch_required` (also for
  `switch.schedule`), `childPolicy` `keep` only for a child slot inside the allowed set.
- Computer use (cu-review): `session.approval.set{computerUse}` writes the allow into children only with own.computer's
  `policy.allowSubagents`; an allow core copied into a new child is removed otherwise (`switching.ts`
  `inheritedComputer`). Calls without `computerUse` (own.team's) keep an existing allow.
- Compat and local windows (07 §6.2 #2, #7, #8): server family probe, output caps with their source, Ollama and
  LM Studio running windows, `local_window_unverified`.
- Upstream contracts added to `own/upstream-surface.json`: `instruction-entry-rendering`, `session-child-inherits`, and
  the evaluate-hook order in `hook-scope-filter`.

Landed in T2 (07 §8.3 T2, implemented):

- Codex metadata, the second layer of model facts (07 §4.5, `slots/codex-meta.ts`): the control Location fetches the
  Codex backend's model list with a ready `codex` slot's headers and the stored etag (on start and when the codex
  template is captured again), keeps it in `OWN_HOME\codex-meta.json` (`Store.codexMeta`, watched like the other stores)
  and in memory for the fold; a failed fetch keeps the last snapshot, and before the first one the Codex CLI's
  `models_cache.json` on this PC is read. It gives the Codex window (`max_context_window`, 07 §6.2 #4), ultra's effort
  and the level order (07 §2.9, §2.3), the ChatGPT group default's ② (07 §2.2), price ranking's priority (07 §3.4),
  retirement dates and successors (07 §4.3), and `effort_update_drift`. `codex` only: `siwc` never reads it. The
  endpoint and `client_version` are one constant block (`BACKEND`, ⚠PG7 (나)), documented in
  `own/upstream-surface.json` `codex-model-metadata-endpoint` and probed live by `own/scripts/codex-meta-probe.ts`.
- The pinned-template diff (07 §4.4, `slots/template-diff.ts`): new model ids added at once with `addedAt` (the `새`
  tag), vanished ids kept and marked `upstream: "missing"` (registered disabled), `limit`/`cost`/`status`/release date
  read live, fixed-field changes flagged as `templateUpdate` (`template_update_available`) until the user's
  `accounts.update{refreshCatalog}`; `accounts.list` shows `templateUpdate` and the marked `models`.
- Repair notices (07 §4.3, `presets/repair.ts` `PresetRepair`): the presence check of pinned targets, lighter pairs and
  group defaults (`PresetStore.Api.repairs()`), one notice per model event (`preset_needs_repair`,
  `group_default_model_missing`) with successor suggestions, `presets.list` `repairs`/`history`/`retirements`,
  `presets.set{repairOf}` → `groups[g].history`, a running root's gone main or level (`session.preset.get` `main`,
  `session_model_unavailable`/`session_variant_unavailable`, never switched by itself). Nothing is rewritten by a
  catalog change (U3).
- Gates with fakes on a real server: PG5 (`test/presets/pg5.e2e.test.ts`) and PG6's T2 value
  (`test/presets/pg6.e2e.test.ts`: gpt-6.1-sol 784,800 once the metadata is there, 829,800 before it).

Landed in EXT wave 1 (external repository research `own/reports/external-repos-2026-10-05.md`, 2026-10-05):

- `toolset_changed` detection (02 §4.3 D10, §7.7): `onRequestShape` fingerprints each own slot request after own's
  shaping (`auth/toolset.ts`: `Hash.stable` of the tools as name → `{description, input}` and of the system texts;
  cache hints and tool order are not part of it), and the `model.request` that follows settles it by kind. Only a
  `primary` request compares, with the baseline of the same session, slot, model and agent; a change raises
  `toolset_changed` (info, session, `fields` `{providerID, modelID, agent, changed}` with `tools`, `system` or both).
  A `compaction` request (the instruction epoch moves) and `session.revert.committed` drop the session's baselines.
  Baselines live in memory only, bounded by `MEMORY_KEYS`; the first primary request after a restart only sets one.
  The planner passes `auth.toolsetChangedAt(sessionID)` as `Estimator.Context.toolsetAt`, and a slot cache entry
  written before it counts as cold (`W = 0`). No model-visible byte changes.
- Output limit (upstream d9987ef9c8 hazard): `onRequestShape` deletes `options.maxTokens` on the `context` and
  `compaction` requests of a `codex` or `oai` slot (`NO_OUTPUT_LIMIT`), mirroring upstream `plugin/provider/openai.ts`
  `omitOutputLimit` on the same two hooks (the ChatGPT backend rejects a requested output limit, OpenAI counts it); a
  limit a `generate` caller set stays; `siwc` keeps `Shape.stripSharingOptions`, other
  kinds are untouched. A no-op on the current base, where nothing sets `maxTokens`; `own/FORK.md` lists it in the
  checklist for merging d9987ef9c8, which adds a default output limit to primary and compaction requests.
- Step-outcome alerts (P2-16, 02 §7.7): `@own/protocol` `Alert.Code` gains `output_truncated` (an own slot's
  `session.step.ended` with finish `length`) and `empty_completion` (finish `stop` with zero output tokens, reasoning
  not counted, and some input: all-zero usage means the provider reported none). Raised by telemetry
  (`judgeOutcome`), info, session, once per session and code within `ALERT_DEDUPE_MS`, `fields`
  `{providerID, modelID, finish}`; compaction and generate never reach it. Recorded through the usual alert path
  (`events.jsonl` and the `alert` RPC event); own-web lists no alerts, so it has no strings for them.
- The built-in `opencode` skill's own section (P0-1): `src/skills.ts` through `ctx.skill.transform` (§2, §4), local
  and remote; `own/upstream-surface.json` `builtin-skill-ids` and `builtin-skill-ids-opencode-md` watch the skill ids
  and the `opencode.md` paragraph it maps.
- DeepSeek balance (P1-11, 02 §7.3): `Windows.deepseekBalance` adds `ds.balance.granted` (`ds.balance.<cur>.granted`
  for a second currency; `Limit.WindowIDs` has the id) labelled 보너스, `status:"ok"`, only while `granted_balance > 0`.
  `ds.balance` (`total_balance`) alone decides `exhausted`, and `topped_up_balance` makes no window, so nothing is
  counted twice. The poller passes the account's previous windows, so a bonus that is gone is published once at 0 (own-web
  keeps no 보너스 window at 0, its `limits/windows.ts` `kept`). New
  `ds`, `or` and `xai` accounts start with `pollBalance` on (`slots.ts` `POLL_BALANCE`; only `ds` is polled). The
  ratecard rows follow the official prices (`own/config/ratecards.default.json`; flash matches `deepseek-flash`); the
  top-up and usage links and the `status_402` session banner are own-web's.
- Plugin installer (P1-14a, P2-32; removed 2026-10-18 with the bundled Claude plugin, 02 §8.2): `Installer.run`
  spawned `npm ci` with `ProcessTree.SPAWN` and ended the whole tree at its 15-minute limit. The build's
  `own/scripts/claude-auth-bundle.ts` now runs the only `npm ci`, on the build PC.

Landed in EXT waves 2–4 (same research; decisions D2–D5 approved 2026-10-05, all with the recommended option):

- Wire evidence capture (WP15, P0-3a, 02 §7.8): `@own/protocol` gains `CaptureMode` (`hash`|`shape`), `CaptureEnd`,
  `CaptureWindow`, `CaptureStatus`, `CAPTURE_DEFAULT_MINUTES` (30) and `CAPTURE_MAX_MINUTES` (1,440), the methods
  `diagnostics.capture.{start,stop,status}` (scope `local`, control location; `MethodScope` is now 17/1/12/8/28 = 66)
  and the global alert `capture_empty`. `telemetry/capture.ts` rides on the read-only hooks of §4 and registers none of
  its own: with no window it reads one field and returns, and never clones a body. A window (at most a day; a new
  `start` ends the running one as `replaced`) records own-slot traffic of its session and slots only: every response
  header name (the census `LastResponse` cannot give) and, in `shape` mode, the values of limit-like headers; the shape
  or hash of error bodies (the first 64 KB), stream events and WebSocket frames (each structure once, error, limit and
  usage ones every time); handshake header names; the retry verdicts with core's decision. The pure helpers are
  `Wiretap` (`@own/runtime`). Lines pass `Redact.value` into
  `<OWN_HOME>\diagnostics\captures\<YYYY-MM-DD>\<sessionID>.jsonl` (owner-only, at most 5,000 per window, kept 7 days),
  each window's summary into that day's `windows.jsonl`. Hooks run in every Location's instance and the RPC in the
  control location, so the window lives in a build-wide process singleton
  (`Symbol.for("own-open-code.accounts-capture/<buildId>")`); the instance that started it owns its timer and step
  count and ends it as `shutdown` when it stops (no alert). A window that ends with nothing recorded raises
  `capture_empty` (warning when own-slot steps ran in it unseen, else info).
- DeepSeek output limit with thinking off (D2 (C), P0-4): `onRequestShape` sets `options.maxTokens` to
  `DS_THINKING_OFF_OUTPUT` (65,536, DeepSeek's thinking-on default) on a `ds` slot's request with the `none` variant
  (the server default there is 8K, which ends long answers silently) when nothing set a limit, on `context` and
  `compaction` only. A limit already set, such as core's own after upstream d9987ef9c8, wins. A generation option only:
  no prompt byte changes.
- The built-in `report` skill (D5 (d), SEC-5): `Skills.transform` writes every path that starts at the home directory
  as `~` (on Windows case-insensitive and with either separator; the match must end the home directory's last name, so
  `C:\Users\dev2` stays) and appends one sentence: this is a private fork, so never file an issue at
  `anomalyco/opencode`, publish only to a repository the user names (`gh issue create --repo`), else give the user the
  title and body. Names and descriptions stay, so no session gets a skills delta.
- DeepSeek price by time of day (D3 (2), P1-3c, 02 §2.4.4, §6.2, §7.5): `@own/protocol` `Ratecard.Card.peak` (optional
  `PeakWindow`s: UTC `days`, `from`–`to`, never across midnight) and `Ratecard.multiplier(card, at)`: outside every
  window each rate is multiplied by `offPeakMul`. A card without windows, as in any `ratecards.json` written before the
  field, prices the same at any time. The seed's two ds cards are peak on weekdays 01–04 and 06–10 UTC (10–13 and 15–19
  KST) with `offPeakMul` 0.5. Telemetry prices a ledger line at its step's request time (`requestedAt`, the step's
  start), and a card with peak windows wins over core's catalog USD (`source: "ratecard"`; core's amount stays in
  `costUSDOpenCode` for comparison); the planner prices a `switch.estimate` target at its clock (`Rates.resolve{at}`).
  own-web's transcript counts that amount for the step instead of core's.
- Repeated identical tool-call reminder (D4 (A), P1-1): `src/guard/repeat.ts` (`Repeat`; own code after the idea of
  dsh's `repeat-tool-reminder`, MIT, nothing copied), wired in `hooks.ts` (§4). It counts only a (session, agent) whose
  last primary request went to an own slot. A call is its tool name plus its arguments with keys sorted at every depth
  (kept as a hash); identical calls in a row count up, any other call starts at 1, and user input resets every chain of
  the session. At the 3rd, 5th and 8th call a fixed `<system-reminder>` note goes before the result text (core's
  truncation keeps the head of a long result), or before the message of a failure that has no cause. The call is never
  blocked and nothing is dropped. Tools matching `policy.json` `repeatReminderExclude` (`*` wildcard; absent:
  `Repeat.EXCLUDE`, `computer_*`) and the calls a Code Mode program makes neither count nor break a chain; the
  `execute` call itself counts. `@own/protocol` `Policy.File.repeatReminderExclude` is optional and set by editing the
  file (`policy.set` keeps it). The note is inside a tool result at the end of the conversation, so no cached prefix
  changes. Its memory is bounded like the module's others (`Repeat.MEMORY_KEYS` sessions and unfinished Code Mode
  calls, oldest first); the upstream contract it relies on for programs is `codemode-nested-call-id`.
- Prefix watch (WP17, P0-2b, 02 §7.8.1): `@own/runtime` `Prefix` splits a request into blocks in cache order (the tools
  as one block, each system part, each message), hashes each in a canonical form (sorted keys; the cache hints `cache`
  and `cache_control` dropped by name; 64-bit wyhash, compared in memory only) and finds the longest common prefix;
  `Prefix.section(json, kind)` hashes one section of a request body as sent. `telemetry/prefix-watch.ts`
  (`PrefixWatch`, run by auth) is off unless a capture window records the session and slot. Then the
  `context`/`compaction`/`generate` hook keeps the request's blocks after own's shaping, and the `model.request` that
  follows compares a primary request with the previous primary request of its session and slot (a compaction request
  moves the session's compaction epoch; generate and title requests are not compared). The first block that differs
  gets a cause, in this order: `compaction`, `revert`, `model` (or variant), `agent`, `toolset` (tools or system; D10
  alerts it), and for a message `strip`, `image-trim` (core's `boundImages` cut after the hooks, mirrored with its 25
  and 15 MiB constants; surface `request-image-bound`) or `instructions`; anything else is `unexplained`. Each primary
  request writes one `prefix` line to `events.jsonl` (`Ledger.Prefix`: `cause`, `lcp`, `previous`, `blocks`, `at`,
  model, variant, agent, `ms`; counts only, never content or hashes), and only `unexplained` raises `prefix_diverged`
  (info, session). Fingerprints stay in memory (`PrefixWatch.MEMORY_KEYS` = 256); a request outside a window forgets
  its slot's last one, so two windows are never compared. `@own/protocol` gains `Ledger.PrefixBlock`,
  `Ledger.PrefixCause`, `Ledger.Prefix` and the alert code.
- Core patches that change how core compacts own-slot sessions (no own-accounts code; `own/ledger/core-patches.yaml`,
  02 §4.7.1): P-016 makes `Token.estimate` script-aware (Hangul and CJK at a provisional 0.6 tokens per character, the
  rest length/4). P-017 lets core take its measured token anchor from another provider of the same catalog model id.
  Each own slot is its own providerID, so before it a switch between two slots of one model re-estimated the whole
  history from text. Now the next check starts from the previous slot's last measured step plus the new tail, unless a
  newer completed compaction or a native checkpoint in this model's history rules the shared count out.

Landed with the speed (02 §4.8, user decisions of 2026-10-06):

- A new module `speed` (`src/speed/`, `SessionSpeed`) and `@own/protocol` `Speed` (pure: choice, offers, resolve with the
  Ultrafast → Fast → Standard fallback, `inherit` for subagents, `modeOf`, `downgraded`). `@own/runtime` gains
  `SpeedMarks` on `Runtime.Services.speed`: refusals until the account's list is read again, Anthropic cooldowns with
  their strikes, siwc tier lists, tier-change retention counts (memory only).
- Codex metadata asks every ready codex account (its own token and etag) and keeps each list in `codex-meta.json`
  `accounts`; the kind snapshot stays the first account's. `CodexModels.Model` keeps `service_tiers`,
  `default_service_tier` and `additional_speed_tiers` (a malformed tier drops only itself).
- Ledger lines carry `speed: {requested, served}`; a tier sent and not downgraded bills plan credits times the speed
  card's `credits` (`ratecards.json` `speed`, else the seed's) or the catalog's mode price (API kinds, and the Claude
  slot's usage credits). Alerts `speed_fallback`, `speed_downgraded`.
- `http.request` is registered on this PC too (speed first, then the remote sink); the Claude subscription slot's
  requests are edited only by the documented exception 02 §8.3 I5a.
- Tests: `test/speed/{wire,speed}.test.ts`, `test/speed/speed.e2e.test.ts` (fake Codex and Anthropic on a real
  server), `test/telemetry/speed.test.ts`, the per-account part of `test/slots/codex-meta.test.ts`. The e2e-kit fakes
  echo the requested tier (`servedTier`, `servedSpeed` to downgrade) and the preset rig takes `codexAccounts`.

Landed with IMPORT (other tools' conversations, `own/docs/09-session-import.md`, 2026-10-08):

- `estimate.request` (09 §5.6, 02 §9.2; scope `read`, control location; the 69th method, so `MethodScope` is now
  19/1/13/8/28 = 69): own-import's `migrate.plan`
  calls it over loopback to price requests on a slot no session runs on yet. `switching.estimateRequest` resolves the
  target like the planner (`account_not_found`, `slot_misconfigured`), prices the requests with the 02 §6 estimator and
  the slot's rates (`delta`, `null` when a rate is unknown; `quota` for subscriptions), gives the account's remaining
  5-hour and weekly percent (`remaining`, from `runtime.limits`), the window the slot registers (`ctx_eff` once its
  threshold moved, else the template window, 01 R16) and its `Compaction.ceiling`, and the slot's `Z`, `zSource` and
  `exchange` from `Tracker.slotMeasure`. It reads only: no PLANNED state, no secret prefetch, no ledger line; any other
  failure is `internal_error`, never a throw.
- Slot medians (`switching/tracker.ts`): per providerID, the first-step Z and the step δ of recent **root** sessions
  own.import did not write (a subagent runs another agent's system and tools); none yet → `Tracker.DEFAULTS.Z`
  (`zSource: "default"`) and `DEFAULTS.delta`. The samples live in the process singleton (`runtime.samples`,
  own-runtime `SlotSamples`, memory only), not in one instance's tracker: each instance adds the samples of its own
  Location's sessions, so `estimate.request` at the control Location (where no session runs) sizes the slot from every
  Location of the process (IMPORT review fix, 2026-10-09).
- Measurement exclusion (09 §4.2): a session whose `session.created` metadata carries `own.import`
  (`OwnImportRouting.marked`: an imported conversation or a hidden summary helper) never sets `firstL`/Z and never
  enters the slot medians (its first step carries the imported history); `Z(sessionID)` falls back to its slot's Z.
  `presets/local-window.ts` does not learn a local model's request size from such a session. Normal sessions are
  unchanged. A helper's compaction usage still lands as `UsageRecorded{source:"compaction"}` on the target account.
- `plugins/inventory.ts` `OWN_PACKAGES` lists `own-import` (last): without it every Location that loads the own-import
  bundle (or `packages/own-import` in a source run) is `blocked_by_plugin` and gets no credentials (06 §10.4 #3).
- The configured plugin order in comments (`src/hooks.ts`, `@own/protocol` `plugin.ts` `ClaudeAuthOrder`) ends with
  `own.import`; the Claude slot checks (`before_own_team`, `after_own_telemetry`) are unchanged because own-import sits
  after them.
- Tests: `test/switching/estimate-request.test.ts` (pricing, quota, remaining, window and ceiling, measured and default
  Z, errors), `test/switching/tracker-import.test.ts` (imported and helper sessions skipped, normal sessions unchanged,
  the helper's compaction usage pinned), the local-window case in `test/presets/local-window.test.ts`, and own-import's
  `migrate.e2e.test.ts` (on a real server an imported conversation's first follow-up leaves its slot's Z unmeasured).

Still pending:

- (Landed with the SSH remote work, see §13: `health.mode`/`broker`/`mirror`, the mirror registry, `remote_managed`,
  `Ledger.Line.server`/`remoteAt`, `Limit.Window.origin`, `Account.Info.remote`, the six remote alert codes.)
- T2.21 (blocked: no PG7 (나) evidence is recorded): deleting the stand-in window list `CODEX_LONG_CONTEXT`
  (`slots/templates.ts`) once the user ran the PG7 (나) probe against a real Plus/Pro login and approved its findings
  (endpoint, `client_version`, etag). A dry run of the deletion (T2 wave 5) showed the same step must also change six
  tests that rely on the list's 872k for a Codex model without metadata (`test/health/health.test.ts`,
  `test/presets/pg6.e2e.test.ts`, `test/slots/{registration,slots,template-diff}.test.ts`,
  `test/switching/compaction.test.ts`: expect the catalog window, 922k → 829,800, or seed a metadata row), drop the
  stand-in check of `own/scripts/codex-meta-probe.ts --self-test` (vacuously true without a list), and update the
  docs that call the list the fallback (07 §4.5, §6.2 #4, §8.3, §8.4; 02 §3.6 codex 모델 규칙 (3)).
- PG8 (should): the `claude-sub` group's `auto` default keeps its interim rule (newest, the higher price on a tie,
  ⚠PG8) until the user records Claude Code's default model on their plan; `Preset.defaultModel` changes only on that
  evidence.
- (Landed in T3, see §13 "Presets on a remote service": the remote mirror's `presets.json`, its revision and the
  paid accounts' budget verdicts; a remote service had only `평소대로` before.)
- (`toolset_changed` detection with `W = 0` landed in EXT wave 1, above.) The other half of 02 §4.3 D10 is not built:
  only the prefix watch reads `session.instructions.updated` (to explain a rewrite while a capture window runs), so a
  Code Mode catalog delta is not added to the next request's `δ` (length/4); the estimator's `δ` stays the tracked
  median.
- WP18 of the external research (golden fixtures from real captures): not started. It needs the user's G7/G8 capture
  runs, so the e2e-kit fakes keep their estimated error and frame shapes (`test/e2e-kit/README.md` ⚠ 추정 모양).
- P-016's 0.6 tokens per Hangul or CJK character is provisional: `own/scripts/db-stats.ts` (read-only) found no Hangul
  in the database on 2026-10-06; it is measured again once Korean sessions exist (the ledger entry's `verify`).
- 4.7.2 (d) in-service compaction (loopback `POST /compact` without a client, Q31): not adopted; the session value
  needs a connected client.

## 12. Deviations from the spec (intentional, small)

- Catalog snapshots (3.6a) are kept per instance in the slots module, not in `own-runtime`: every Location's fold
  captures the same built-in catalog, and RPCs run in the instance whose fold captured it.
- Session timers (5.4 waitReset/schedule) live in the switching module of the session's Location instance and are
  cancelled in `stop`, instead of a runtime-level per-session timer table.
- Process-wide notifications use the new `Broadcast.Hub` on `Runtime.Services.broadcast` (added in this step).
- Allowlist paths (`plugins/inventory.ts` `contains`) compare real paths: the host lists a local plugin by its resolved
  entry file (`app\2.0.18-own.1\plugins\own-accounts\index.js`). Found by the 2.0.18-own.1 release smoke (installed
  layout, then configured through an `app\current` junction): before, the own bundles were `blocked_by_plugin` and
  `model.request` sent no auth header (every turn 401).
- No junction since 2.0.18-own.3 (launcher 0.4.0): on some Windows 11 builds files under %LOCALAPPDATA% cannot be
  opened through a junction. The installed version is `OWN_HOME\app\current.json` (`Home.installed`/`Home.layout` in
  `@own/runtime`, an older launcher's `app\current` read as a link only), opencode.jsonc names the version folder's
  bundles (the launcher rewrites those entries on every switch), and `Inventory.ownRoots(layout)` lists
  `app\<version>\plugins` of the installed version, of the pointer's `previous`, and of the version this bundle was
  loaded from when that is a version folder of the same OWN_HOME.

## 13. SSH remote: the credential broker and `mode:"remote"` (04 §8–§11)

Owner: BROKER/REMOTE (this work). Folders `src/broker/**` and `src/remote/**`; small hooks elsewhere (listed below).
Transport (ssh, epochs, keys, arm, tunnels) belongs to own-remote; the run-time contract is `src/broker/contract.ts`
(a copy of own-remote's `src/protocol/broker.ts` shapes; `test/broker/contract.test.ts` checks both). Wire schemas and
constants are `@own/protocol` `Broker`.

| Mode | Where | What own-accounts adds |
|---|---|---|
| `local` (default) | this PC | `BrokerHost` (`src/broker/host.ts`): one `LocalBroker` per build and process, published at `Symbol.for("own-open-code.remote-broker/<buildId>")` for own-remote. Serves from the runtime and the first attached instance's `logins.headers`/`refresher`/`test` and `telemetry.alert` (control location first). |
| `remote` | remote service on an SSH host (`OWN_REMOTE=1`) | `RemoteHost` (`src/remote/host.ts`): the broker client published at `Symbol.for("own-open-code.remote-broker-client/<buildId>")` for own-remote's `agent.broker.arm`, leases in memory, the mirror, the spool, the fail-closed sink. No vault (`src/remote/novault.ts`), guard 1 also needs `OWN_REMOTE=1`, an `accounts.json` that is not a mirror of this schema is set aside at setup. |

| File | Role |
|---|---|
| `src/broker/wire.ts` | framing (4-byte BE length + JSON, 1 MiB), HMAC proofs, a framed channel that queues early frames |
| `src/broker/server.ts` | `LocalBroker`: per-host loopback listeners, handshake, normal/drain/skew, 5 failures/min, request dispatch, pushes (`mirror.changed`, `quota.updated`, `account.status`, `revoke`), status for own-remote, 1-min stale release sweep, 5-min lease audit (`remote.lease.issued`, `leases.json`) |
| `src/broker/lease.ts` | `headers.get`: rate limit 30/s burst 60, scope/`remote:"deny"`, ttl rules, vault refresh before a short lease, linked `source_stale` per host (never a refresh, never `reader.reject()`), invalidate throttle |
| `src/broker/mirror.ts` | the registry view without identifiers/secrets/credential refs/budgets/Claude slot; templates by hash; T3: this PC's `presets.json`, `presetsRevision` (`revisionOf`, a content hash) and `presetsBudget` (`{exhausted}` per account of `paid(registry, scope)`: not retired, in the host's scope, metered or prepaid; budget values never travel) |
| `src/broker/observe.ts` | `observe.push` ingestion: ack, skew normalization, validation, `accountID` recomputed, `server`/`origin` tags |
| `src/remote/client.ts` | broker client: arm rules, key only in a closure, reconnect loop, `req`/`res`, pushes |
| `src/remote/host.ts` | leases (deadline from receive time − RTT/2, 30 s tail, 80 % refresh), marks per session, sink redirect, grace, invalidate + one retry, push handling, spool flush, ping |
| `src/remote/mirror.ts`, `spool.ts`, `sink.ts`, `grace.ts`, `ledger.ts`, `dial.ts` | mirror files + host-scoped overrides; bounded spool with gaps; 401 sink (HTTP + WS); grace math; ledger wrapper that spools new lines/events; socket or TCP dial (a test-only placeholder dial for the fake-SSH harness) |

Hooks outside the two folders (all no-ops in `local` mode unless noted):

- `index.ts`: mode, remote guard, `NoVault`, `RemoteHost.acquire`/`wrap` (the runtime handle's `ledger` spools) and
  `attach`; `BrokerHost.attach` in `local` mode. `deps.ts`: optional `remote`. `options.ts`: `mode`, test-only `broker`.
- `hooks.ts`: after `model.request` the remote host notes whether the own-slot request carries a credential;
  `http.request` (registered only in remote mode) and `ws.handshake` redirect credential-less requests to the sink;
  `http.response` skips sink answers; `retry` asks the remote host first (sink attempts: grace or stop, no telemetry
  classification) and after (one immediate retry once a rejected lease was invalidated).
- `credentials/logins.ts`: `headers`/`unauthorized` delegate to the remote host; `replaceKey` and a ChatGPT re-login
  broadcast `credential.replaced` (the broker revokes host leases).
- `emitter.ts`: no global events in remote mode. `rpc/register.ts`: `REMOTE_MANAGED` methods answer `remote_managed`.
  `health/health.ts`: `mode`, `broker`, `mirror`; no vault/telemetry warnings remotely. `telemetry/telemetry.ts`: no
  balance poller remotely, `ledger.session{server}`; `telemetry/totals.ts`: `groupBy:"server"` and row `servers`.

Deviations (see the work report): the remote keeps writing its own ledger copy (its sessions' estimator and
`ledger.session` read it) while the local ledger is the one of record; `registry.get` sends templates by hash and
`template.get` fetches them; the mirror keeps `cacheDomain`/`quotaDomain` ids (the file schema needs them, without
`externalId`); API-key auth failures reported by a host get one `accounts.test` locally; `calibration.updated` (R2)
is not sent; a proto-previous adapter does not exist (only proto 1).

Tests: `test/broker/*` (units), `test/remote/*.test.ts` (units + an in-process broker ↔ remote integration over
loopback), `test/remote/e2e/fake-ssh.test.ts` (local server + own-remote + the fake-SSH harness + a real remote server
booted from source by `test/remote/e2e/real-service.ts`).

### Presets on a remote service (T3, 07 §8.1 원격, 04 §9.2)

The remote gate uses this PC's presets read-only. All fields are optional, so PROTO and `MIRROR_SCHEMA_VERSION` stay;
a view of an older build decodes and leaves the host with each group's `평소대로` only. The three view fields are spec
addition (2) of 06 T3 (user confirmation pending).

- **View (local, `broker/host.ts`, `broker/mirror.ts`).** `Mirror.build` gets the raw `presets.json` (when it cannot
  be read, the last file this process read, or nothing; the registry mirror is never blocked), `presetsRevision` and `presetsBudget` from
  `PresetBudget.mirror()` (the ledger through `quota.snapshot`; an unreadable ledger gives `exhausted: true`).
  `broker/host.ts` is outside the T3.12 file list; it was edited under the wave-2 note that gives `broker/*` to it.
- **Pushes (`broker/server.ts`).** `store.changed{presets}` → `server.presetsChanged()` sends `mirror.changed` to every
  connected host. A `ledger.line` of a paid account with a monthly budget (this PC's or a host's `observe.push`) →
  `server.budgetChanged()`, which pushes only when the verdict hash differs from what that host last fetched (recorded
  at `registry.get`); the once-a-minute sweep runs the same check (a new month). Drain sessions are untouched.
- **Mirror (remote, `remote/mirror.ts`).** A new `presetsRevision` writes `presets.json` atomically
  (`Fsx.writeAtomic`) before `accounts.json`, whose meta (`MirrorMeta.presetsRevision`) names the revision, then emits
  `store.changed{presets}`. The same revision writes nothing. A budget-only change stays in memory
  (`Mirror.presetsBudget()`, `RemoteHost.Api.presetsBudget()`); after a restart without the broker there is no budget
  state, so every paid target is refused until a view arrives. A view without presets but with `presetsBudget` comes
  from a current build that could not read its file: the mirror keeps the revision it has (`kept`, log
  `mirror_presets_kept`), so a passing read error never resets a remote binding.
- **Store (`presets/store.ts`).** On a remote service it reads `presets.json` only while the stored mirror meta names a
  `presetsRevision`, else `평소대로` only (an older view, no view yet, a stray file); a file it cannot read keeps the
  presets it loaded before. It reloads on
  `store.changed{presets}`, never writes the file (`auto` decisions stay in memory), re-checks R4 on load with the
  mirror's lookup (no identities: one login's `codex` and `siwc` accounts are two subscriptions, fail closed), lists no
  `repairs` (the local PC owns them) and has `budgets()` (`{}` before any view; `undefined` on this PC). Local reload
  stays synchronous.
- **Money (`presets/budget.ts`, `consent.ts`).** `PresetBudget.exhausted` uses the mirrored verdict on a remote
  service, and an account the mirror does not name counts as used up; on this PC it uses `spent()` (the old ledger
  logic). The gate, `Access.admit`, `plan` and `session.preset.consent` (now `PresetBudget.paid` + `exhausted`, so a
  remote `allow:true` for a used-up paid account answers `preset_budget_exhausted`) follow without further edits.
  Budgets gate subagent targets only: the broker never refuses a lease for budget, as on this PC (choice (a) of the
  T3 user question, chosen 2026-10-05; (b) would refuse every remote request of an over-budget paid account). The
  only stale window is the one push round trip after a crossing, and the remote gate fails closed meanwhile.
- **Bindings (`presets/presets.ts`).** The `deps.remote` exclusions are gone: remote sessions follow mirrored
  `presets.json` changes (a session bound to a preset removed on this PC goes to its group's ★, the `own.preset`
  guidance entry follows edits). `session.preset.apply{team}` stores the binding for a remote team area (06 §4.13).
- **Read-only.** `presets.set`, `presets.remove`, `presets.defaults.set` and `presets.suggest` still answer
  `remote_managed` (`rpc/register.ts` `REMOTE_MANAGED`; `gate.ts` and `register.ts` changed in comments only).
- **Not carried.** Codex metadata stays on this PC (06 T3 spec addition (4), default): a remote resolve uses the
  no-metadata effort order and ultra rule.
- Tests: `test/broker/mirror.test.ts` (the view fields, `paid()`, a real broker over loopback with a hand-rolled host:
  a `presets.json` change, a budget crossing and a new month push `mirror.changed`, a non-crossing ledger line does
  not), `test/remote/mirror.test.ts` (write order, `store.changed` order, same revision, budget in memory, views
  without presets, presets appearing and going), `test/remote/presets.test.ts` (remote mode with a fake broker: PG2
  (가) (라) (바), R4 on a remote service, money refused when exhausted, missing or before any state,
  `session.preset.apply{team}`, no repairs, `remote_managed`).

Landed with VOICE (voice input, `own/docs/02-accounts-providers-cache.md` §3.9, 2026-10-09):

- `voice.get` (read), `voice.set` (admin), `voice.key.set` (local) and `voice.transcribe` (prompt), all at the control
  location, so with the workspace notes `MethodScope` is now 22/4/13/9/29 = 77. RPC host: `own.accounts` methods
  rather than a sixth RPC id, for the vault access in `own-runtime`, the gateway's `OwnAccounts.MethodScope`, the
  control routing, `remote_managed` and own-web's existing client.
- Keys: OpenAI and Deepgram keys are voice-only vault items (`voice-openai`, `voice-deepgram`, `Voice.keyID`), stored and
  read through `Credentials.storeFeatureKey`, `featureHeaders`, `inspectFeatureKey` and `removeFeatureKey`. Account ids
  are `acc_…` and `headersFor` takes accounts only, so a model request never gets a voice key and transcription never
  gets an account's key or a ChatGPT token: with no voice key, `voice_unavailable{reason:"key_missing"}` and nothing
  is sent.
- `voice.transcribe` decodes the base64 recording (≤ 4 MiB, ≤ 180 s), builds the upstream route
  (`OpenAITranscription.model`/`DeepgramTranscription.model` with `Auth.headers` and the `openai`/`deepgram`
  endpoints, overridable for the fakes), runs `Transcription.generate` with `Effect.timeout(90 s)` and the RPC signal,
  maps an `AIError` reason to `voice_failed{reason, status?, retryable}` (never the service's body), and adds the
  seconds to `voice.json` `usage`. Logs carry the service, bytes, seconds and ms only.
- Tests: `test/voice/voice.test.ts` with the fake services `test/e2e-kit/fakes/transcription.ts`; `test/skeleton.test.ts`
  counts 77 methods.
