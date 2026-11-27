# own-team architecture (`@own/team`, plugin id and RPC id `own.team`)

Specs: `own/docs/06-team-worktrees.md` (team mode; §2 architecture, §2.4 data model, §2.6 placement, §2.7 RPC, §2.8
tools, §8.5 ops), `own/docs/07-presets.md` (area presets, team-wide R4), `own/FORK.md` §7 (`Portable.definition`).
Plugin order: third, `[own.accounts, own.remote, own.team, claude-auth slot, own.telemetry, own.computer-use]`.

## Role

Team mode: one project split into a few areas, each a worktree with its own owner conversation, coordinated by a team
main. own.team is the deterministic part (06 T-D3): the registry, the outbox, ops, reports and waking the main. The
LLM only judges (a one-off `session.generate` on the main session). It never picks models or accounts (the user does,
07), never compacts or rotates conversations by size (U6), and never sets or forwards computer use.

## Layers

```
src/index.ts         guard 1 → Runtime.acquire({role: "own.team"}) → Singleton.acquire → controller.attach
                     → RPC own.team (leader-only events) → tools + agent denies → hooks → event intake
  rpc/handlers.ts    the 36 methods from the group files (every method has its group since T2); FEATURES for
                     `health`; nothing throws
  tools/index.ts     the 8 team tools (Code Mode, namespace `team`, JSON Schema) + the agent-wide denies
  hooks/index.ts     session `prompt`, permission `evaluate` (tighten only), tool `execute.before/after`
  intake.ts          this Location's core events → controller hub (once per event id)
        ▼
src/singleton.ts     the controller per process and build: globalThis Symbol.for("own-open-code.team-controller/<buildId>"),
                     references, 30 s linger, OWN_HOME\locks\team-controller.lock
src/controller.ts    Controller.Service: Services.Base (registry, journal, steps, runner, hub, notices, http, accounts,
                     locate, per-team mutex) and the feature services (Services.Features)
        ▼
registry/            KV records (06 §2.4): team, area, dispatch; keys.ts is the only key list
ops/                 journal (op records), steps (step-kind registry), runner (observe → act → verify, confirms),
                     confirm (10-minute nonce bound to the manifest), undo and area-create (feature services)
sessions/            http (self-HTTP), accounts-rpc (own.accounts through ctx.rpc), locate (registry roles),
                     main / owner / safe-point / rotate / team-context / area-main (feature services)
dispatch/            admit (outbox, one request at a time), pause (Main 멈춤)
report/              events (reports, catch-up), digest (team updates, team_status, 충돌 예상), wake (waking the main)
docs/                handoff documents, decision records (T2)
git/                 the git execution core (T1.03) and inventory/measure (T1.04)
integrate/           integration steps 0-7 (op, merge, verify), 8-9 (advance), undo, push (T2)
reconcile/           area reconcile: following branches and folders changed outside own (T2)
reorg/               reorganization (T3): plan (V-rules, skip rules), propose (팀 구성 다시 보기), remove (8.6), retire
                     (끝내기, 끝낼 수 있음), split, merge, convert, rehome (대화 옮기기)
assets/              need_paths, the write guard and after-tool fix, release, drift, link copies, Bun cache, shared
                     folders (T3), the `.assets` check folder (T3)
remote/              remote team mode (T3): env (tools PATH, health mode), lfs (`lfs-remote` step, `RemoteLfs.plan`)
```

## Controller and instances

- One plugin instance per Location; the controller is shared by every instance of the build and outlives a single
  Location (06 §2.6). It has no `ctx` of its own: KV access, own.accounts calls and session permission writes use a
  live instance's `ctx` (`Base.instance(directory)`: the instance at that folder, else the control location's, else the
  leader, else any). With no instance left, work stops and `resume` continues it with the next one.
- Only the controller writes KV, one team at a time (`Base.write(teamID, section)`), and only after it holds the
  controller lock; an overlapping older build waits for the lock file to go away. The holder touches the lock file
  every 15 s and a file untouched for 60 s is stale whatever its pid (Windows reuses pids); a failed lock write is
  logged and retried. Hooks never wait for the lock: the `prompt` hook records direct talk detached, and the tool hooks
  skip cone changes until `Base.started()` and hold a call at most 30 s.
- `Runtime.acquire({role: "own.team", preferLeader: control})` elects the leader among own.team's instances; only the
  leader emits `rpc.own.team.*`, each event with a fresh ULID `eventId` and `origin: "global"`.
- Every attach runs `Controller.resume`: running ops first (06 §8.5), then each feature's `resume` (catch-up from the
  session logs, timers recomputed from KV, waiting requests sent again).

## Services and features (`src/services.ts`)

`Services.Context` = `Base` + `features()`. Each feature module exports `create(services)` with its final signature
(`Services.Factories`); T1.05 ships neutral bodies (they answer `unsupported`, or do nothing), and later waves fill the
bodies. T2 added five features (additive, no T1 contract changed), composed from their modules in `controller.ts`; T3
adds `shared` and `reorg` the same way.
Features subscribe to core events with `services.hub.on` in `create`, and register their op step kinds with
`services.steps.register`. Step kinds that take a feature's callbacks (integration, undo and push: `Advance.Deps`;
reconcile's `reconcile-move`) are registered by the feature's `register()`, which the RPC groups (`rpc/integrate.ts`,
`rpc/adopt.ts`) call while the plugin sets up, before the controller's first resume continues an op, and which the
feature calls again before it starts an op itself. A test controller (`test/support/context.ts`) thus registers a
module's kinds with callbacks of its own.

| Feature (`services.features().x`) | File                     | Filled by            |
| --------------------------------- | ------------------------ | -------------------- |
| `main`                            | `sessions/main.ts`       | T1.14 (`model` live) |
| `owner`                           | `sessions/owner.ts`      | T1.14, T2 (`attach`) |
| `areas`                           | `ops/area-create.ts`     | T1.14                |
| `safePoint`                       | `sessions/safe-point.ts` | T1.15                |
| `rotate`                          | `sessions/rotate.ts`     | T1.24                |
| `teamContext`, `areaMain`         | `sessions/*.ts`          | T1.25                |
| `admit`, `pause`                  | `dispatch/*.ts`          | T1.15                |
| `events`, `digest`, `wake`        | `report/*.ts`            | T1.16                |
| `handoff`                         | `docs/handoff.ts`        | T1.24                |
| `undo`                            | `ops/undo.ts`            | T1.13                |
| `adopt`                           | `ops/adopt.ts`           | T2.04, T2.14         |
| `reconcile`                       | `reconcile/area.ts`      | T2.05, T2.14         |
| `integrate`                       | `integrate/*.ts`         | T2.07, T2.08, T2.14  |
| `decisions`                       | `docs/decisions.ts`      | T2.06, T2.14         |
| `drift`                           | `assets/drift.ts`        | T2.09                |
| `shared`                          | `assets/shared.ts`       | T3.07, T3.15         |
| `reorg`                           | `controller.ts`          | T3.15                |

Triggers (`controller.ts`, 06 §8.8, §7.2, §4.7–4.8):

- `reconcile`: once when the controller starts (every team that is on, read in `Controller.start` before its first
  write), after an `enable` op ends, and after an owner's run ends (its area may be at a safe point). A team's runs never overlap; triggers that come meanwhile make one more
  run. Session reads use the home as the location, so an idle area Location is never woken.
- `integrate`: one op of steps 0-9 per integration (`integrate-start`, `-merge`, `-refs`, `-verify`, `-assets`,
  `-advance`, `-after`; `mergeLocal: "ask"` makes the advance a confirm step that also syncs). A waiting integration
  ended its op and is tried again by `area.integrate`, when a team update wakes the main (`report/wake.ts`), and, one
  that waits for a git operation in progress, every 30 s once its marker is gone. After the target advanced: the
  `반영함` line in the next team update, the cone drift (4.8) and the link copies again (4.12) at the area's safe point,
  then the automatic release (4.7, an op of its own). An integration that ends `done` clears the area's candidate and
  `반영 준비됨` (`ReportEvents.integrated`); one that is undone gets its `반영 되돌림` line. A killed verify resumes from
  `verify/<K>.json` (06 §2.6 (d)). `Verify.execute` (checks, setup and the `.assets` check) waits `FAILED_GRACE_MS`
  (2 s) before a non-zero exit counts, so a command killed together with the service leaves no result and runs again
  on resume (T3 wave 4, TG11). A stop or the time limit ends the command's whole process tree (see Status (EXT
  wave 1)).
- `drift`: the cone check after every run that ends, at the area's safe point (and on resume).
- Release after `done`: `team_report{done}` asks for the automatic release at the area's next extended safe point
  (`Release.onDone`; Main 멈춤 skips it, TI-13).
- New areas (`ops/area-create.ts`): `worktree-create` writes the link copies when the home keeps copies
  (`team.env.symlinkFix`, detected by enable with `Symlinks.detect`), `area-record` records their hashes
  (`area.linkCopies`), and `setup-run` installs with `BunCache.env` (`team.env.bunCache`, 4.12). T3: `link-shared`
  right after `area-record` when the team has shared folders (4.11), and on an SSH host `lfs-remote` first while the
  repository's filter is not the bundled git-lfs (`lfs_missing` without the tool, 4.13).
- `shared` (T3, 4.11): after every run that ends and on resume, each active area whose links are missing (or whose
  `link.blocked` notices changed) is linked again at its safe point, one pass at a time, never over a real folder or a
  foreign link (`Shared.create`).
- `reorg` (T3, 8.1): git's facts of `끝낼 수 있음` (`Retire.facts`) are read by the first `team.get` after the controller
  starts and again once they are a day old (`RETIRE_SCAN_MS`; no timer, so an idle controller reads no area folder);
  `team.get` words `AreaView.retirable{since}` from them with the area record and the clock of the moment
  (`Retire.retirable`). A reorganization (`reorg`) or 끝내기 op that ends or waits for its confirms adds team
  notes for the actions skipped for their area and the main requests it cancelled (`Digest.reorganized`, no wake); the
  first `op.done` of the op does, never after a confirm was answered. 끝난 영역 정리하고 끄기 turns the team off once its
  retirement op ended (`Disable.after`, also on resume).
- `.assets` first creation (T3, 4.10, 0.3): `integrate.start` predicts step 7 (`AssetsVerify.needed` with the merge
  base, the folder missing, `AssetsVerify.creation` over the limits). Such an integration runs steps 0-6 in an op of
  their own, because a confirm step does not hold back the auto steps after it; when that op ended (`op.done`, and on
  resume) the next op is step 7 as a confirm (asked again with the real K) or step 7 and 8-9 as auto steps, then 8-9
  after a confirmed check; 두기 ends the integration `failed` (`assets`) with its markers removed and a team note.
  The `.assets` lease is the folder's in-process queue (`assets/verify.ts`); a resumed op takes it again.

Results: `Services.Result<T>` = `{ok: true, …T}` or a `Services.Failure` typed by the own.team error schemas
(`OwnTeam.errors`); RPC groups return it with `RpcFailure.fail` (an undeclared error becomes `internal_error`),
tools word it with `MainTools.answer`.

## Ops (`ops/`)

- An op (`op:<teamID>:<opID>`) is the ordered steps `{id, kind, args, mode, state}` and the user's confirms, never an
  event log. A team has one active (`running` or `waiting`) op; another start is `busy`.
- The runner walks the steps: an `auto` step is observe → act → verify through its registered kind (`Steps.Kind`;
  `Steps.define` makes one whose `args`, read back from KV, are decoded in every phase);
  observing an effect that is already there marks the step `done` without acting, which is how a restart resumes
  (TI-11). A `confirm` step gets a nonce (10 minutes, `op.confirm` event) and waits while the later auto steps go on;
  the op ends `waiting` while confirms remain, `done` or `failed` otherwise (`op.done`).
- `op.confirm`: a wrong or used nonce is `nonce_invalid`; an expired one is issued again; a removal's nonce is bound to
  the list it showed (`manifest`): a different list right before the step is asked again (06 §8.6). `skip` = 두기.
- Every state change is written before the next step; closing the controller aborts running steps and leaves the op
  `running` for the next controller.

## Tools and visibility (`tools/`)

- Eleven tools registered once per instance in one transform: `status`, `integrate`, `area` (main and owners);
  `dispatch`, `reorganize`, `decide`, `control` (main); `report`, `need_paths`, `handoff`, `message` (owners; peers use
  `report`, `need_paths` and `message`). `area` and `control` are the buttons told in plain language (V, 2026-10-09,
  below); `message` is area-to-area talk (2026-10-16, below). Code Mode only, plain JSON Schema inputs and
  outputs (`{ok, text, …}`); pinned: `dispatch` and `report`. `integrate` and `decide` work since T2 with their T1 input
  schemas; their descriptions say what they do since design choice (e) (2026-10-03), the T2 upgrade's one catalog
  change. The T3 upgrade has one catalog change too (`test/plugin/t2-tools.test.ts` `CATALOG_SNAPSHOT`): the
  `team_reorganize` description names the T3 actions, and `team_report` takes `assets` (with `ready`: the change needs
  an engine run, recorded as `Area.candidate.assets`, so the integration runs the `.assets` check without a heavy
  change, 4.10) with its description saying so (both approved; the flag on 2026-10-05).
  The 2.2.6-own.3 upgrade (2026-11-14) is one delta per role again: the main's `team_area` (`role {role}`, resume
  hands back direct work) and `team_reorganize` (`userMade?` on `new`); owners' and peers' `team_area`,
  `team_report` (text 20,000 and its description), `team_message` (text 20,000, "your role", limits line) and
  `team_need_paths` (dirs 64). `CATALOG_SNAPSHOT` `2fcba3e98a6e…` (was `ac2b9170c92f1776…`); see the last status.
  The 2.2.6-own.6 upgrade (2026-11-17, SK) is one more delta for the main and the owners: `team_area` `keep` and
  `unkeep`, `team_reorganize` `rename{goal?, userMade?}`. `CATALOG_SNAPSHOT` `fe8024be1ca8…`.
- `team_integrate`: the main names any area (op by `main`); an owner only its own, and its call first does the
  `ready` clean check and records the candidate without waking the main (`ReportEvents.ready`, op by `auto`).
  `team_decide`: a decision record (source `main`), with the commit instruction when `commitDecisions` is on.
- Visibility: three permission actions, `team.main`, `team.owner` and `team.member` (the tools both roles use). One
  tool has one action, so a third action is the only way to give `team_status`/`team_integrate`/`team_area` to both roles without
  showing each the other's tools (spec addition to 06 §2.8). Every agent gets `{action, resource:"*", deny}` for the
  three, from the setup transform and from a late transform registered again after each local `plugin.updated` (the
  config's agents are folded after every configured plugin; approved late re-registration). The main and owners carry
  `Permissions.rules(role)` allows from `session.create`.
- Authority: the registry. `MainTools.check` / `OwnerTools.check` find the caller by session id
  (`Locate.session`): children, previous owners and other sessions get a sentence back, never an exception.
- `Permissions.write` (adopt, unadopt, undo): read-merge-write of exactly the team rules, then own.accounts
  `session.approval.set{sessionID, mode}` with the mode read before the write (skipped for `custom`), never with
  `computerUse`; own-accounts' read-merge-write keeps an existing `{computer, *, allow}`.

## RPC (`rpc/`)

`ctx.rpc.register(Portable.definition(OwnTeam.Definition), handlers)`. Implemented in T1.05: `health`, `diagnostics`
(basic), `team.list`, `team.get` (a folder's team: its home or area, else the team of its git common dir), `op.get`,
`op.confirm`, `op.undo` (delegates to the undo service), `settings.get`, `settings.set`. The group files of later
features delegate to their services and list their `FEATURES` for `health`. T2 groups: `rpc/adopt.ts` (`area.adopt`,
`area.unadopt`; feature `adopt`), `rpc/integrate.ts` (`area.integrate`, `integration.get|undo|push.plan|push.execute`;
`integrate`, `push`) and `rpc/decisions.ts` (`decisions.list|add`; `decisions`, through the `decisions` feature as
`team_decide`). `rpc/fail.ts` (`RpcFailure`) keeps `fail` (a service failure as the method's declared error).
Since T3 no method answers `unsupported` for a missing build part: `rpc/reorg.ts` registers the reorganization kinds
while the plugin sets up (`Services.Reorg.register`) and answers `reorg.propose` (the judge call, `reorg/propose.ts`)
and every `reorg.apply` action (features `reorg.split|merge|retire|convert|move`); `rpc/team.ts` answers
`disable{cleanup}` (`cleanup`), words `AreaView.retirable` in `team.get` and lists `shared`; `rpc/integrate.ts`
lists `assets`. `integration.get` answers the checks' log text (last 64 KB) in `verify.*.log`, where KV keeps its path in the team records folder; a stopped git operation in the area folder
answers `area.integrate` with `in_use`. Guard failures register `health` only; a remote service (`mode: "remote"` +
`OWN_REMOTE=1`) loads in full with `<OWN_HOME>/tools/git-lfs/current` first on the PATH of own's git (`remote/env.ts`,
06 §4.13).

## Self-HTTP (`sessions/http.ts`)

Session list/get/active/create/prompt/synthetic/generate/interrupt/log/message(s)/metadata, inbox list/cancel/update,
permission/form/shell/pty lists, instruction entries, worktree refresh. The target is an `@own/runtime`
`ServiceTarget.Source`: the channel's registration file, or the plugin option `service:{url, password}` (loopback
`http:` only). `location[directory]` on every call about a folder; one retry after a 401; narrow decoded views; never
`session.compact`.

## Files

| Path                 | Contents                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `src/index.ts`       | `Plugin.define({id: "own.team"})`, the wiring above                                        |
| `src/build.ts`       | release defines, `PLUGIN_ID`, env markers, `NAMESPACE`, linger                             |
| `src/options.ts`     | `mode`, `home`, `buildId`, `service`, `lingerSeconds`, `logLevel`                          |
| `src/log.ts`         | redacting JSON logger                                                                      |
| `src/singleton.ts`   | process controller slot, references, linger, controller lock                               |
| `src/controller.ts`  | `Controller.Service`, `FACTORIES`                                                          |
| `src/services.ts`    | `Clock`, `Result`/`Failure`, `Base`, `Context`, feature contracts                          |
| `src/hub.ts`         | `Hub.Bus`: own.team events out, core events in                                             |
| `src/intake.ts`      | per-instance event stream, `Dedup`                                                         |
| `src/notices.ts`     | `notice` events; open notices in KV `notices:<teamID>` (`team.get` `notices`)              |
| `src/registry/*.ts`  | keys, team (`Teams.id` = `tm_` + hash12), area, dispatch                                   |
| `src/ops/*.ts`       | journal, steps, runner, confirm, undo, area-create, enable, disable, home, reorg, adopt, paths, settings |
| `src/sessions/*.ts`  | http, accounts-rpc, locate, main, owner, peer, seat, instructions (role texts, 팀 지시문), safe-point, rotate, team-context, area-main |
| `src/dispatch/*.ts`  | admit, pause, hold, talk, direct (direct work: `live`, `kept`, `serving`, `pass`, `handed`, `end`, `sweep`) |
| `src/report/*.ts`    | events, digest, wake, fold, cursor, texts (whole reports, relays and stretches per area in KV) |
| `src/docs/*.ts`      | handoff documents, decision records                                                        |
| `src/integrate/*.ts` | op (steps 0-7), merge, verify, advance (8-9), undo, push                                   |
| `src/reconcile/*.ts` | area reconcile (8.8)                                                                       |
| `src/reorg/*.ts`     | plan, propose, remove (8.6), retire, split, merge, convert, rehome (T3)                    |
| `src/remote/*.ts`    | remote team mode: env (tools PATH, health mode), lfs (`lfs-remote` step, `RemoteLfs.plan`) |
| `src/assets/*.ts`    | need-paths, guard, release, drift, symlinks (link copies), bun-cache, shared, verify       |
| `src/rpc/*.ts`       | handlers and the method groups (`project.ts`: `project.gitInit*`, 06 §3.0)                 |
| `src/git/init.ts`    | making a folder a Git repository (06 §3.0): read-only plan, `init -b main`, first commit   |
| `src/tools/*.ts`     | registration, main/owner checks, permissions, one file per tool, voice plans, voice targets |
| `src/hooks/*.ts`     | prompt, permission, tool hooks                                                             |
| `test/support/*.ts`  | fake PluginContext and world, manual clock, fake loopback service                          |
| `test/*.test.ts`     | skeleton, registry, ops, tools-visibility (plus one folder per module group)               |
| `test/plugin/*.ts`   | T2 and T3 wiring: the RPC groups, the tools, the controller triggers, resume (TI-11)       |

## Status (T1, 2026-10-02, build 2.0.18-own.6)

Every feature row of the table above is filled (T1 waves 1–5). What T1 does, by 06 section:

- Enable / disable / `team.home` / undo (3.1–3.8): inventory, the LLM judge on the team main's one-off
  `session.generate` (V1–V13, one retry, rule-based fallback), new areas in the sibling `<home>-team` folder, code-only
  worktrees, `worktree.refresh`, summary card and undo. Adoption of existing worktrees is T2.
- Main requests (5.1–5.3): outbox, one request per idle folder, Main 멈춤 (`area.pause`, `team.pause`), hold refs, and
  `source: "own.team"` (`OwnTeam.PROMPT_SOURCE`) on every prompt and synthetic message own.team sends.
- Reports, digest and wake-ups (5.4–5.7): reports, direct-talk records from the `prompt` hook (synthetic input never
  passes it), debounced and rate-limited team updates (`wake.limited`), catch-up from the session logs plus the live
  durable events (the local service keeps no event rows), a 60 s retry when a wake-up cannot be sent.
- Rotation and handoff (6.1–6.5): `rotate.*` steps (safe point, warm handoff turn or program handoff, new owner with
  the area preset and the old approval mode, swap, archive), `main.rotate`; an empty conversation hands over without a
  turn; waits re-check every 30 s (`RECHECK_MS`); a failed automatic rotation is not retried within 60 s (`RETRY_MS`).
- Area mains, area presets and the team-wide R4 (10.1): `area.main`, `area.preset`, team context pushed into every
  binding (`session.preset.apply{team}`) with repair notices; `team.account` (`account-*` steps: wait for the whole
  team on two subscriptions of one company, else the team main first and each area at its own safe point). In
  멈추고 바꾸기, or when the old account is out of its limit, the stopped owner's queue keeps its prompts and does not
  hold the move (`SafePoint.check{parked}` from `rotate.begin`). An `area.preset` chosen while the owner still waits for
  its move to another group is only recorded; the new owner is bound to it.
- Assets (4.6–4.9): `team_need_paths`, manual release (`paths-release`), the write guard before writes and the
  after-tool fix (both pulled into T1 from T2).
- Ops: `Runner.resume` starts running ops without awaiting them, so a waiting step never holds back the features'
  resumes (catch-up, timers, the outbox resend).
- Tools: all eight registered (`team_integrate`, `team_decide` answer "not available yet" until T2).
- Gateway (own-remote, T1.18): an `own.team` branch by `OwnTeam` scope, `local` refused; own.computer's rule unchanged.
- Computer use (06 §2.6, cu-review): own.team never sets or forwards `computerUse`; new owners and mains get the old
  approval mode only, and its `session.approval.set{sessionID, mode}` keeps an existing allow. own.computer-use refuses
  computer calls in turns own.team started (`team_turn`).
- Not in T1: adoption, integration and push, decisions, automatic release, HEAD-change reconcile, link copies, Bun
  cache (T2); reorg split/merge/retire/convert/move, `.assets`, shared folders, remote teams (T3).
- Upstream contracts this package relies on are in `own/upstream-surface.json`: `service-session-http-api` (+
  `-permission`), `session-instruction-entries-endpoint`, `session-active-endpoint`, `service-config-channel`,
  `worktree-remove-ignored-files`, and the T1 entries `team-session-*`, `team-synthetic-no-prompt-hook`,
  `team-worktree-refresh`, `team-tool-namespace`, `session-child-inherits`, `instruction-entry-rendering`,
  `hook-scope-filter`, `permission-evaluate-hook`.

## Status (T2, 2026-10-02, build 2.0.18-own.7)

What T2 adds, by 06 section (the T2 waves; wiring in T2.14):

- Adoption (3.6–3.7, 8.2): enable adopts folders that are already there (locks, keep refs, naming a detached HEAD, the
  owner registered without touching its conversation, the team-wide R4 decided up front); 팀에 넣기 / 빼기
  (`area.adopt`, `area.unadopt`); the role, the team allows and the preset attach at the first main request.
- Area reconcile (8.8): at start, after enable and after owners' runs.
- Integration (7.1–7.5): `area.integrate`, `team_integrate`, steps 0-9 in one op, waiting and retries, undo, push and
  review requests (`local`); `.assets` checks record `skipped` (T3).
- Decision records (6.6): `team_decide`, `decisions.list|add`, titles in the enable judge's input.
- Assets (4.7–4.8, 4.12): automatic release after `done`, an integration and a rotation; the cone follows HEAD; link
  copies in new areas and the verify folder; own's Bun cache for the installs own runs.
- `health.features` adds `adopt`, `integrate`, `push`, `decisions`.
- Left for T3 then (see Status (T3)): reorg split/merge/retire/convert/move and `reorg.propose`, cleanup on disable,
  `.assets`, shared folders, remote teams.
- Upstream contracts T2 adds to `own/upstream-surface.json`: `team-session-permissions-write` and
  `team-session-permissions-replace` (adopted owners get and lose their team allows through `ctx.session.update`), and
  the test-only `codemode-catalog-update-message` (the e2e counts core's catalog-update message for TG16).
- Fixed by the T2 gate suites (wave 4, `own/reports/team-t2-gates.md` §2):
  - `NeedPaths.apply` applies the area's link copies again right after the cone widens (`Symlinks.refresh`, loaded
    lazily: a static import cycle between the two modules broke TG1 `leader.e2e`), so links inside a fetched heavy
    folder become copies (4.12); `controller.ts` uses the same function after an integration, which also keeps the
    `link.copy.dirty` notice open.
  - The integration's fast-forward of the folder that has the target and the area sync check the overlap (B..K paths
    against the folder's changed and untracked files) before `merge --ff-only`: in a code-only folder Git 2.55
    overwrites an untracked file at a path K brings, with exit 0. W waits `dirty`; the area sync sends the owner a
    `sync` request instead.
  - 팀에 넣기 takes the folder out of `team.external` and 팀에서 빼기 lists it again as `left` (unless own still locks
    it for a nested area), without waiting for the next reconcile (8.2, 9.4).

## Status (T3, 2026-10-04, review fixes 2026-10-05; the exit build 2.0.18-own.7 waits for the remote bundle's git-lfs)

What T3 adds, by 06 section (the modules in waves 1–2, their wiring in T3.15):

- Reorganization (8.1–8.8): `reorg/plan.ts` (the V-rules of a reorganization, the TI-9/TI-13 skip and wait rules) and
  `reorg/propose.ts` (`reorg.propose`: one judge call on the team main, one retry, the rule-based fallback; stored for 7
  days), over the action modules and their step kinds:
  - 끝내기 (`reorg/retire.ts`): the user's `retire.begin` (waits for the area's safe point, TI-9), `retire.keep`,
    `retire.check`, `retire.outbox`, `retire.archive`, `retire.mark`, then the removal `retire-remove`
    (`reorg/remove.ts`, 8.6: a confirm whose nonce is bound to the listed files, ignored files that cannot be made again
    flagged `irreplaceable`, the unapplied save points counted at plan time in its `unapplied` arg; a folder it will not
    remove is not asked; own's links deleted unfollowed first, the shared-folder links through `Shared.unlink`); `Retire.retirable` is
    `AreaView.retirable` (끝낼 수 있음, a signal only).
  - 나누기 (`reorg/split.ts`): `split-begin`, `split-handoff`, AreaCreate's kinds, `session-create`.
  - 묶기 (`reorg/merge.ts`): `merge-begin`, `merge-into`, `drift`/`link-fix`, `merge-handoff`, `merge-attach`,
    `outbox-migrate`, `merge-archive`, `merge-retire`, `retire-remove`; `merge-begin` asks B's owner for one commit
    turn (`AreaSplit.requestTurn`) when B has uncommitted changes and fails if they stay; `wip-commit` (8.7) for an
    adopted B without an owner conversation; its undo `merge-undo`, `merge-undo-area`, `wip-undo`.
  - 변환 (`reorg/convert.ts`): a confirm op asks first (`convert-confirm`, a holding confirm), then `convert-to-code`
    after the owner's `rotate.*` steps or `convert-to-full`.
  - 대화 옮기기 (`reorg/rehome.ts`): `session-move`, the user's action only; it waits for the safe point.
  - Waiting (`reorg/settle.ts`): a user's action waits for the area's safe point, rechecking every 30 seconds and on
    folder and session events, and says why through `op.progress`.
  - Runner (`ops/runner.ts`, `ops/steps.ts`): a kind may hold back the later steps (`holds`: 두기 skips the same area's
    pending steps); a confirm with nothing to ask runs as an auto step (`Prepared.auto`); a failed step leaves the op
    `waiting` while other confirms remain; a reorganization's `undo.available` comes from its done steps whose kind
    `reverses`; an answer that arrives while the op stops records nothing.
  - `op.undo` of a `reorg` op (`ops/undo.ts`) reverses it by what it did, whatever its `undo.available` says: moved
    back, converted back, the merge undone while A is still at K (else `conflict`: only 'B 다시 만들기' is left), the
    split's new area retired, new areas removed while untouched, 팀에 넣기 taken back, renames named back.
  - 다시 만들기 (8.2, 8.8, approved 2026-10-05): a new area from an area's old branch, `reorg.apply` with
    `ops:[{op:"new", from:<area>}]` (AreaCreate's kinds, a new branch `<slug>-2` at that branch's tip). `from` may name
    a stopped area (a missing folder) or a finished one (B after a merge whose undo is no longer possible, or whose
    folder is gone); a branch that is gone refuses the item. The old record stays as it is (a missing area ends by
    끝내기).
- 끝난 영역 정리하고 끄기 (3.8): `disable{cleanup}` retires every finished area in one op (`disable.cleanup` and the
  retirements, every removal asked at once), then the disable op turns the team off (`Disable.after`).
- Shared folders (4.11, `assets/shared.ts`): enable plans `protect-shared` (a confirm: read-only by a deny ACE or
  `chmod -R a-w`, the record, the `/<name>` line through Symlinks' `info/exclude` writer, links in every area) for each
  folder the judge picked, instead of a `skipped` line; new areas get `link-shared`; the feature links again at safe
  points; enable's undo starts with `undo.shared`; removals and undo delete own's links unfollowed. Protecting records
  the folder's prior state (`records/shared/<sha16>`: the explicit deny ACEs, or the read-only entries) and undo
  restores exactly that.
- `.assets` (4.10, `assets/verify.ts`): integrate step 7 in a detached full worktree under a lease; its first creation
  over the limits asks (see the triggers above).
- Remote teams (4.13, `remote/*`): the full plugin on an SSH host's service (`OWN_REMOTE=1`); `lfs-remote` before
  anything makes an area or owner there (enable 3.6 (5), new areas); `lfs_missing` until own-remote uploaded the tool;
  `Team.env.lfs` from `Lfs.env`. `lfs-remote` saves the repository's previous `filter.lfs.*` once (the
  `own-team-lfs.*` config section) and lists the repository in `<OWN_HOME>/tools/git-lfs/repos`; `lfs-restore` (undo,
  disable) and own-remote's uninstall put them back. The controller holds the remote tools path itself
  (`Controller.Input.tools`), so it outlives a plugin copy leaving.
- Disable releases the check and `.assets` folders' locks (`release:verify`, `release:assets`).
- The T3 catalog change recorded in `CATALOG_SNAPSHOT` (`team_reorganize` and `team_report{assets}`, see the tools
  above).
- `health.features` adds `reorg.split`, `reorg.merge`, `reorg.retire`, `reorg.convert`, `reorg.move`, `cleanup`,
  `assets` and `shared`.

## Status (EXT wave 1, 2026-10-05)

From the external repository research (`own/reports/external-repos-2026-10-05.md` P1-14a):

- Commands own.team runs in a folder end as a whole tree. `Verify.execute` (`integrate/verify.ts`: the checks, the
  setup of the verify folder and the `.assets` check) and `runSetup` (`ops/area-create.ts`, the `setup-run` step of new
  areas) no longer hand `signal` to `Bun.spawn`, which ended only `cmd.exe` and left the build it started running in
  the folder. They spawn with `ProcessTree.SPAWN` and wait with `ProcessTree.exited` (`@own/runtime`): the controller's
  signal or the time limit ends the whole tree (`taskkill /pid <pid> /T /F`, hidden, while the root still runs on
  Windows; `SIGKILL` to the child's own process group on POSIX).
- Timeouts are recorded. A command over its limit (`COMMAND_TIMEOUT_MS` and `SETUP_TIMEOUT_MS`, 30 minutes each;
  tests pass a shorter `timeoutMs` to `execute`) writes `[timed out after N min]` to its log and counts as a failed
  run; a stop through the signal still returns `undefined` and records nothing, so the next controller runs the
  command again.
- Tests: `test/integrate/verify.test.ts` runs a sleeping script under the shell string and checks that the time limit
  and a stop both leave no process behind, and that only the time limit is a run noted in the log.
  `test/e2e/tools-cache.e2e.test.ts` also asserts no `toolset_changed` across 팀에 넣기, the attach, 빼기 and 되돌리기
  (own-accounts' D10 detector compares every primary request; its positive control is own-accounts PG4).

## Status (EXT waves 2–4, 2026-10-06)

From the same research, decision D8 (가) (P2-18b, approved 2026-10-05; the `after:` dispatch of P2-18a was not
approved, so `team_dispatch` and the tool catalog are unchanged):

- 충돌 예상 (06 §5.6): the team update and `team_status` get one `반영 때 충돌 예상: <A> ↔ <B>(<경로> 외 n개) · …`
  line for pairs of areas whose branches would conflict when both are integrated (`report/digest.ts` `conflicts`, read
  by `Digest.gather`). `Merge.ahead` (`integrate/merge.ts`) lists the areas' branches that have commits the target
  lacks (`for-each-ref --no-merged=<target>`); `Merge.predict` runs step 4's merge-tree over each pair's tips
  (`git merge-tree --write-tree -z --name-only`, with the target's commit as `--attr-source`).
- Answers are kept in process memory per repository, attributes commit and unordered SHA pair (the oldest of
  `PREDICTED_MAX`, 512, goes first; a failure is asked again), so with unchanged branches a text costs the target's
  lookup and one `for-each-ref`. One text asks at most `NEW_PAIRS` (6) new pairs (four areas ahead are six pairs), and
  later texts ask the rest. The line names five pairs and counts the rest (`외 n쌍`); an owner's view checks only the
  pairs with its own area.
- A conflict with the target is left to the integration (7.3), and when git cannot answer there is no line. The line
  is worded from git when a text is made and never folded, so it never wakes the main; it changes no ref, index or
  file (merge-tree's objects are left to git's gc). It has no leading `- `, so `OwnTeamText.countOf` counts no area
  for it.
- Tests: `test/report/digest.test.ts` (one line in the update and `team_status` with nothing written or woken, an
  owner's view, a new commit asked again, an area the target caught up with dropping out, the new-pair budget and the
  five named pairs).
- Team tools run only inside Code Mode programs, so own-accounts' repeated identical tool-call reminder (decision D4,
  own slots only) never counts them; it counts the `execute` call that runs the program.
- Test helpers: `test/e2e/inspect.ts` `toolsHash` is `Prefix.section(json, "tools")` of `@own/runtime` (EXT wave 4,
  P0-2b): one hash of the tool definitions in canonical form, so object key order and cache hints never count, while
  the order of the tools does. TG1's `leader.e2e` waits for `op.done` before it checks that every enable step was
  announced once: the op's record is written before its last steps are announced.

## Status (area peers 동료, 2026-10-09)

The minimal variant the user approved ("agents와 상의해서 도움이 될것같다면 추가"; 06 §1.2, §2.4, §2.7, §2.8, §5.1,
§5.4–5.6, §9.4–9.5, §12.1):

- Registry: `Area.peers[]` (`OwnTeam.Peer {key, sessionID, label, role ≤ 1 KB (1,024 characters since 2026-11-14, `PEER_ROLE_MAX`), attached, origin, at, direct?}`, at most
  four per area), `Dispatch.to` and `DispatchMeta.to`; all optional, no migration. `Locate.session` answers `peer` by
  session id (never metadata; areas that are not retired). Code name `peer`, never `member` (`team.member` is a
  permission action).
- `sessions/peer.ts` (feature `peers`): `add` (register a root conversation of the area folder: the R4 check
  `Outbox.rival`, the record and its log cursor at the watermark, nothing written to the conversation; or `create` a
  new one: the record first, then `session.create` with the owner's allows, approval, the area preset with the team
  context and `own.team.peer.role`), `edit` (the role entry again when attached), `remove` (detach, the waiting
  requests for it cancelled with a team note), `attach` (the owner's allows and the peer role at the first request of a
  registered peer) and `detach` (all attached peers of an area: `adopt.detach`, `disable.peers`). `rpc/peer.ts`:
  `area.peer.add|edit|remove` (admin), the same calls a voice tool will make.
- Outbox (`dispatch/dispatch.ts`): one FIFO per area; the queued check reads the owner's and every peer's inbox, so the
  folder takes one main request at a time; a request with `to` checks R4 every time (refused and cancelled, the main
  woken by a `refused` entry; never rotated), attaches a registered peer, and goes in with `to="<key>"` in the envelope
  and the metadata (an owner's envelope is unchanged). The hold ref counts a peer's direct talk too. Main 멈춤: a peer's
  user stop turns it on, the parked-queue wake takes one conversation (the owner first), 모두 멈추기 interrupts peers.
- Tools: peers carry the owner's allows (`Permissions.rules("owner")`), so the catalog is the owners'. `team_report`
  (progress/done/blocked; `ready` refused), `team_need_paths` and `team_status` accept a peer (`OwnerTools.checkArea`);
  `team_integrate` and `team_handoff` refuse one. `team_dispatch` takes `member` (key or label; never with `fresh`) and
  answers `refused`; `team_status{area}` for the main also lists the folder's unregistered conversations. The evaluate
  hook's auto-allow treats a peer like its owner (registry id). The one catalog change is recorded in `CATALOG_SNAPSHOT`
  (`15a9803d4448…`, never shipped); the voice tools of the same release recorded it once more with V and peers together (`463a0573…`, V status below).
- Reports and digest: a peer's log is followed after its own cursor (`foldPeer`: received requests, `끝났지만 보고 없음`,
  failed runs, user stops) and its reports fold under `AreaFold.peers[key]`; the area's status and candidate stay the
  owner's. `blocked` and a failed run wake the main. Team update lines `  · 동료 <label>: …` under the area line
  (`OwnTeamText.peerLine`, not counted as areas); `모두 끝남` counts every peer. The prompt hook records talk in a peer
  conversation as `peer.direct`, never `area.direct` (the mislabel that held the main back from the owner).
- Lifecycle: owner rotation, team account and `main.rotate` leave peers; 팀에서 빼기, 끄기 and 되돌리기 detach them;
  끝내기 and 묶기 drop the records (`Remove.retired`, `merge.retire`); 대화 옮기기 drops a moved peer (`Peers.drop`); the
  area reconcile moves attached peers with the owner (8.8); created peers follow the area preset (`TeamContext` push).
- Tests: `test/sessions/peer.test.ts` (registration and its refusals, R4 at registration and at send, creation, the first
  request's attach and envelope, one at a time across owner and peer, team_dispatch `member`, edit and remove, a peer's
  tools, direct talk, user stop, lifecycle helpers, peer lines, 끝났지만 보고 없음 and 모두 끝남),
  `test/plugin/peers-rpc.test.ts` and `test/e2e/peers.e2e.test.ts` (register, direct talk, main → peer → done →
  owner, the double-send guard on a real server; directive `+member=`).

## Status (V: team actions told in plain language, 2026-10-09)

Feature V of 06 §2.9 (user decisions V-D1, V-D2; design V1–V11; Q1–Q3 decided with the defaults), on the same branch
and in the same release as the area peers, so a team session gets one catalog delta.

- **Plans and approval** (`src/tools/voice.ts`, `VoicePlan`): `issue` answers `{ok, plan: true, token, expiresAt,
  text}` and changes nothing; the plan (one per session, controller memory, replaced by the next) holds the session's
  newest message id, the scope of the button's RPC method (`OwnTeamRouting.MethodScope`) and a `run` closure with the
  targets found when it was made (inner nonces stay in it). `redeem` reads 200 messages: after the anchor the first
  `idle`, then the first `user` message that is not a machine's (`PromptHook.machine`, the prompt hook's rule) is the
  reply R; an `idle` after R is `plan_stale`; R's `own.device` stamp (gateway) must hold the scope, `local` never from
  a device (`needs_pc`); the plan is removed synchronously before `run`. Other refusals: `plan_unknown`,
  `plan_expired` (10 minutes or the wrapped nonce's end), `plan_mismatch`, `needs_user` (also when the read fails).
- **Tools**: `tools/area.ts` (`team_area`: pause, resume, rotate, model, preset, paths, cancel; the main on any area,
  an owner on its own without paths and cancel, a peer refused), `tools/control.ts` (`team_control`: pause_all,
  resume_all, main_rotate, unadopt, disable, home, undo, move, account, push, settings, answer, peer_add, peer_edit,
  peer_remove), `tools/targets.ts` (model refs without throwing, presets by name, conversations by id or title, the
  last done integration, cost lines, op words, confirm sizes, the bounded wait). `team_integrate{tip, token}` plans the
  branch tip bound to its SHA when there is no candidate and no waiting integration; `team_reorganize{token}` plans any
  proposal with `retire`; `team_status{detail}` adds ops, numbered confirms (no nonce), the last undoable op, the
  area's last integration with its log end (2 KB, `Verify.withLog`) and, for the main, accounts, refs and presets.
  Approved plans run by `user`; direct actions by `main` (an owner's by `auto`).
- **Shared entry points** (behaviour unchanged): `ops/paths.ts` `PathsOp.start` (from `rpc/paths.ts`), `ops/settings.ts`
  `TeamSettings.write` (from `rpc/settings.ts`), `integrate/verify.ts` `Verify.withLog` (from `rpc/integrate.ts`),
  `ops/disable.ts` `Disable.finished` and `Disable.start{areas}`, `IntegrateOp.plan{source}` and `Integrate.start{source}`
  (another C answers `conflict{ref, expected, actual}` and starts nothing).
- **Main role** (`sessions/instructions.ts`, `sessions/main.ts`): the role text says to show a tool's plan as it is and
  call again with the token in the turn of the user's next message, to change the area main or preset by `team_area`
  when the user asks, and to use `team_area`/`team_control` for the screen's team buttons (about 1,000 → 1,357 chars).
  The main feature's `resume` writes it once per controller to the main of every team that is on (`RoleInstructions.put`
  skips an equal value; overlapping resumes write once).
- **Catalog** (measured with core's catalog rules: the listing line `  - <signature> // <first description line>`, cost
  `round(chars / 4)`): the team lines of a main go from about 483 to 970 tokens (namespace line 53 → 135), those of an
  owner or a peer from about 497 to 789. The whole summarized catalog of a team main as the model saw it in an e2e probe:
  with the default plugins (opencode and team namespaces) 10/10 shown before and 12/12 after, `team_area` and
  `team_control` inline; with computer use on, 15/29 before (computer 6/19, opencode 4/5, team 5/5) and 14/31 after
  (computer 5/19, opencode 4/5, team 5/7), where `team_area` and `team_control` are not inline. The partial catalog is
  accepted: the namespace line says `7 tools, 5 shown` and its sentences name both tools, so the model finds them with
  `search`. `CATALOG_SNAPSHOT` `463a0573933282d9…` (V and peers together).
- **Tests**: `test/tools/voice.test.ts`, `test/plugin/{v-area, v-control, v-control-ops, v-peer-tools}.test.ts` (with
  `test/support/voice.ts`: a team on a temp git home, a fake own service whose conversations hold turn logs, recorded
  features), `test/integrate/source.test.ts`, the `areas` case in `test/plugin/t3-reorg.test.ts`, the resume rewrite in
  `test/sessions/main.test.ts`, `test/tools-visibility.test.ts` (ten tools, permission table) and the e2e
  `test/e2e/voice.e2e.test.ts` (`bun run test:e2e:v`; directive `[voice <tool> <json> +token=last|<t>]`).

## Status (area-to-area messages, 2026-10-16)

06 §5.8, the user's 2026-10-16 request (resident conversations of different worktrees talk directly when that is
cheaper than through the main; the main still coordinates). Branch `team-talk`; design and two reviews in the round's
`design-by-label.json` (`design:team-message`, `review-code:team-message`, `review-user:team-message`).

- **Tool** (`tools/message.ts`, `team.owner`): `team_message{kind: ask|reply|note|watch, text, to?, member?, id?, on?}`.
  The team main's visible catalog, the namespace description and `team_status`'s description are unchanged (no
  delta for mains); owners and peers get one catalog delta. `CATALOG_SNAPSHOT` `c3275a638e23f3ed…` (was
  `463a0573933282d9…`). Estimated with the listing rule (`  - <signature> // <first line>`, `round(chars / 4)`), the
  team lines of an owner or a peer grow by about 80 tokens (about 789 → 870); not re-measured in an e2e probe.
- **Delivery**: asks and replies are outbox records of the receiving area (`Dispatch.from: "area"`, `sender`,
  `replyTo`) and go by the 5.1 rule unchanged (`dispatch/dispatch.ts`); notices are program records
  (`from: "team"`, `kind: "notice"`). `settledOnly` heads never create, attach or rotate a conversation (`unattached`
  refusal, an audit line, no wake). `solicited` heads (a reply, a notice) pass the user's Main 멈춤 and go first; 모두
  멈추기 holds them. `Outbox.cancel` is the one place every cancel reaches; a cancelled ask sends its asker a notice
  (`Talk.cancelled`, not awaited, so a step never waits for another area's step).
- **Talk state** (`dispatch/talk.ts`, KV `talk:<teamID>`, written only in the team's write section): notes held for a
  conversation (newest 5, 7 days, dedup), watches (one per watcher, area and event, 12 h), open asks with the
  conversation each was delivered in, `limited`, and the audit lines for the main (newest 20, `told` watermark set by
  `wake.ts` once an update carrying them went in). The guards run in `Outbox.record`'s write section: G1 one reply per
  ask, G2 one open ask per pair of conversations (12 h backstop), G3 10 asks per rolling hour for the team (since
  2026-11-14: 10 per asking conversation and 40 for the team, `ASKS_PER_HOUR`/`ASKS_PER_HOUR_TEAM`; replies
  never count); the limit adds an `area-limit` digest entry (wakes) at most once an hour.
- **Notes after the envelope**: `notesFor` writes the chosen note ids on the request's record before the prompt, so a
  resend after a failed answer carries the same ones; `sent()` drops them from the store (the restart path too).
- **Settling** (`report/events.ts`): the receiver's ordered log marks an ask delivered (`session.inbox.delivered` with
  the hashed id) and settles it at that conversation's next run end (succeeded, interrupted, failed without a limit
  block; `Talk.follow`), never by clocks. After the write section `Talk.settle` sends a succeeded run's last answer as
  the reply when none was sent, else a notice. `Fold.requestOf` keeps area messages and notices out of `queued`,
  `received` and `끝났지만 보고 없음`; an owner or peer with an ask out owes no report at its run end.
- **Digest** (`report/digest.ts`): area lines count main requests and area messages apart; the main's view ends with
  `영역 메시지 n건:` (after `할 일:`, so `fit` drops it first); an owner's or a peer's view (`viewer`) adds `다른 영역:`,
  `보낸 물음:`, `지켜보는 영역:` and `받은 쪽지 n개(…)`, none starting with `- `.
- **Roles** (`sessions/instructions.ts`): owner and peer texts gain a receive and a send line (owner about 1,940
  chars, peer about 1,830; the test bound is 2,600). `owner.role` and `peers.role` (optional `Services.Owner.role`,
  `Services.Peers.role`) write the current text once per controller and conversation right before its next request
  (`Outbox.send`), not at controller start, which must wake no area Location (`t2-controller` reconcile test). Area
  edits made since (a new name or goal) come with it. The main role is unchanged.
- **Other callers**: the program handoff lists main requests only (`docs/handoff.ts`); the resume and disable plans
  count main requests; a removed peer's note lists main requests; `reorg/merge.ts` cancels `from !== "main"`; disable
  empties `talk:`; `controller.ts` fires `integrated` watches when an integration ends done.
- **Rollback risk** (accepted, 06 §2.4): an older build cannot decode `from: "area"` records or the new kinds; cancel
  waiting area messages before going back. An older own-web cannot decode `outbox.list` while one waits and labels
  area messages `메인이 보냄` until it reloads.
- **Tests**: `test/dispatch/talk.test.ts` (pure guards, notes, lines, log settling), `test/dispatch/message.test.ts`
  (plugin level over `test/support/core.ts`, the fake core now shared with `dispatch.test.ts`), `test/report/{digest,
  fold, wake}.test.ts`, `test/docs/handoff.test.ts`, `test/plugin/t2-tools.test.ts` (snapshot and the message input),
  `test/tools-visibility.test.ts` (eleven tools), and the e2e `test/e2e/message.e2e.test.ts` (directive
  `[message <kind> <area> +member= +id=last +on= <text>]`).

## Tests

`bun test` and `bun typecheck` from this folder. Fake plugin contexts over one shared "world" (KV, sessions,
own.accounts answers, events), the real `@own/runtime` on a temp OWN_HOME, a manual clock and a fake service on
127.0.0.1. Fake credentials only; no test reads this PC's accounts.

- T3 wiring (`test/plugin/t3-*.test.ts`): `t3-reorg` (each `reorg.apply` action to `op.done`, their undo, 다시 만들기
  of a missing folder's area and of a merged B whose undo answered `conflict`, 끝난 영역 정리하고 끄기 with its
  bundled removal confirm and the expired-nonce and changed-list cases, `끝낼 수 있음` after 7 days
  on the manual clock, the team-update notes, `reorg.propose`, `health.features`), `t3-resume*` (TI-11, one test per
  step and one file per op: every step of
  끝내기, 묶기, 나누기, 변환, `link-shared` and an integration with `.assets` has its result lost once and a second
  controller over the same KV finishes the op with nothing made twice; the first `.assets` confirm across ops and a
  restart between them) and `t3-remote-enable` (remote mode: `lfs_missing` without the bundled tool, `lfs-remote` before
  any worktree, the shared-folder confirm after the areas, `link-shared` for new areas; a stub git-lfs, temp HOME and
  XDG config, `GIT_CONFIG_NOSYSTEM`, no ACL applied).
- `test/e2e/`: a real upstream server with own-accounts and own.team loaded from source, a fake LLM that follows
  directives in the requests (`harness.ts`, `directives.ts`), and the 06 gate scenarios (enable, dispatch, report,
  rotate, account, tools-cache, guard, leader, smoke). The dev service loads own.team third and its self-HTTP reads
  the channel's `service-local.json`. The harness also loads own-computer-use (`driver: "fake"`), fake ChatGPT
  01/02/03, Anthropic and DeepSeek; options `claude: true` (a fake claude-auth shim in slot 4, acknowledged at boot, the
  `anthropic` provider on the fake Anthropic with a fake key), `watchConfig` (slot install/remove), `computerOptions`,
  `importer`, `importOptions` and `importPackage` (own-import loads last with the fixture `roots` the test gives, or a
  built bundle folder, while the server's `CODEX_HOME` and `CLAUDE_CONFIG_DIR` name empty temp folders; own-import's
  and own-web's import e2e use them); helpers for ops, sessions, Locations, presets and alerts; a killed server's dropped calls answer 502. Directives add
  `[propose-areas n +heavy=<dir>]`, `[fail]`, `[slow ms]`, `[computer <tool> <json>]`, and handoff requests are answered
  with `team_handoff`. A full `bun test` (unit and e2e) takes about 20 minutes. own-web's `test:e2e:team` boots its
  backend through this harness and the directive responder (read-only).
- T2 gate suites in `test/e2e/` (06 §11.3, results in `own/reports/team-t2-gates.md`): `adopt` (TG9 adopted, TG10,
  TG15 adopt, TG16 adopted delta, a broken nested area), `integrate` (TG11 without `.assets`: F1 with a check
  script and a bare remote, F2 for the LFS pointer conflict and a code-only verify folder, plus git procedures),
  `release` (TG5), `links` (TG14 on two shallow temp clones of this repository, read only), `record` (TG19:
  need_paths diff, revert, conversion), and the T2 parts of `guard` (the owner's `git merge main`, the cone following
  HEAD) and `tools-cache` (approval tail after adopt, attach, unadopt and undo while the mode changes). Directives
  added for them: `[propose-areas adopt <folder…>]`, `+check`, `[integrate <area>]`, `[decide <title…>]`. TG16's
  "delta 1" is asserted as unchanged tool-definition and system-catalog hashes plus exactly one core catalog-update
  message (`harness.ts` `catalogUpdates`).
- T3 gate suites in `test/e2e/` (06 §11.3, results in `own/reports/team-t3-gates.md`): `reorg` (TG12 on F1 with heavy
  `Assets/` and link copies kept as copies: what 끝내기 keeps, unapplied save points, detached keep refs, a changed list
  asked again with a new nonce, a PowerShell holding the folder, merge into a dirty A with hold refs, Main 멈춤, moves
  proposed by the main and the judge, a user split waiting for a core shell, both conversions, a move and its undo, a
  kill after each split step; and the TG19 record), `assets` (TG11's `.assets` items: skipped, the first-creation
  confirm, `[report ready assets]`, a user commit in `.assets`, a candidate deleting a heavy file, a kill during the
  check) and `shared` (TG18 Windows: before and after the `protect-shared` confirm, `git clean -fdx`, GNU
  `rm -rf data/`, a real folder at the link path, 끝내기, the enable undo removing the deny ACE; ACEs on temp fixtures
  only). Directives added for them: `[propose-reorg <json>]` (the main's `team_reorganize`, or the judge's text answer
  when the request is a judge prompt, marked by `JUDGE`), `[report ready assets …]`, `+shared=<dir,…>` and `+assets`
  (the `bun run build` script as the asset check). Harness helpers: `reorganize`, `confirmOf`, `answer`,
  `startShell`/`stopShell`, `killEachStep` (moved from `enable.e2e`), and `rpc` retries once on `ECONNRESET` (the
  keep-alive socket race after a restart). The T3 suites put the server in their state right after boot, so teardown
  always runs (the T1 and T2 suites still set it at the end of `beforeAll`).
- Scripts: `test:e2e` (all of `test/e2e`, about 27 minutes), `test:e2e:t2` (the T2 suites, about 15 minutes),
  `test:e2e:t3` (the T3 suites, about 9 minutes),
  `test:e2e:bun-install` (TG14's opt-in real `bun install` into a same-volume cache, about 2.5 GB of downloads; run only
  after the user agrees) and `test:real-host` (`test/real-host/run.sh t2`: the git procedures of `release` and
  `integrate` plus `test/git/{cone,refs,worktree}` on the approved host `dev-host` in a temp root that is removed
  at exit; `release.e2e` and `integrate.e2e` import only host-safe modules at the top and load the server harness
  lazily, so they run there without node_modules), and `test:real-host:t3` (`run.sh t3`: the Linux git procedures of
  `test/reorg/{remove,retire,split,merge,convert,rehome}`, `test/git/wip`, `test/assets/shared` and
  `test/remote/{env,lfs}`, bundled here with
  `bun build --target bun` so the host gets the bundles only; a host without bun gets a temporary copy of the verified
  Linux Bun inside the temp root, removed with it (approved by the user on 2026-10-05); HOME, XDG and BUN_INSTALL point
  inside it and Bun's transpiler cache is off).

## Status (team-mode convenience, 2026-10-16)

06 §0.2 TC-D1–TC-D6, §8.1, §5.5, §9.2–9.7; the user's 2026-10-16 request (talk the split over with the main before
areas are made, reorganize existing work folders in plain words, team actions easy to find). Branch `team-talk`, in
the same release as the area-to-area messages; design and two reviews in the round's `design-by-label.json`
(`design:team-convenience`, `review-code:team-convenience`, `review-user:team-convenience`).

- **Preview** (`tools/reorganize.ts`): `team_reorganize{proposal, preview: true}` plans with `ReorgPlan.build` (writes
  nothing) by `main`, or by `user` when the proposal retires an area (what the real call becomes after its plan), and
  answers in plain Korean (`PREVIEW_HEAD`, one line per planned item, `지금 하면 건너뜀: …`, `하지 않음(…)`, suggestions,
  a running op, `PREVIEW_NEXT`). No token, no op, the four lists plus `planned`. An applied answer names each skip
  (`건너뜀 1개('api' 메인 멈춤)`) and ends with `SKIPPED_NEXT` when a skip waits for its area.
- **Plan skips** (`reorg/plan.ts`): `plan.skipped` lists the Main 멈춤 and busy skips of `ops/N` items (the ones the
  user's run would wait out); they stay in `plan.rejected` with their text for older clients. A skipped summary line
  carries its `op`, which own-web's `[다시 하기]` sends back as the user's own one-op proposal.
- **Relay** (`tools/report.ts`, `report/{fold,digest}.ts`): `team_report{kind: "relay"}` (owners and peers) appends a
  waking `relay` digest entry (`Digest.add`), never a report, so status, candidate and the open request's answer stay.
  The text is cut at `Digest.RELAY_TEXT` (1,000, as a report keeps; since 2026-11-14 it is not cut: the whole text goes
  to KV `report:<team>:<area>` `relays`, kept by size, and the digest keeps the 1,000 excerpt ending in `…`). The main's view has a `사용자 부탁 n건:` block right
  after the head (quoted and escaped; `RELAY_QUOTE` full 1,000 / short 300, so `fit` keeps it before every other
  block) and the `할 일:` item `<영역>: 사용자 부탁 처리하기`; area, peer and team notes leave relay entries out, and
  an owner's or a peer's own view has none. `OwnerTools.PEER_REFUSED` names relay.
- **Folders outside the team** (`tools/status.ts`): the main's whole-team `team_status` adds `팀 밖 작업 폴더 n개(…)`
  from `team.external` (why `left`, kept by reconcile; registry only, no git), at most 8; with `detail` one inventory
  read adds each folder's branch, uncommitted changes and commits the target lacks.
- **Roles** (`sessions/instructions.ts`): the main gains the talk-it-over exception, the preview line, the relay line
  and 영역 모델 (1,357 → 1,828 chars); owners and peers gain the relay line, and the peer's 보고는 셋만 becomes 상태
  보고는 셋만 (with an area like `인벤토리 화면` an owner text is about 2,150 chars, a peer's about 2,030; the main's
  test bound is 2,600). No owner or peer `resume` (review-code: `RoleInstructions.put` lists instruction entries through
  the session's own Location, so a resume would load every idle area folder's Location at every controller start).
  The lazy `role` refresh of the area messages (before a request goes) also runs from the prompt hook when the user
  writes in an owner or peer conversation (`hooks/prompt.ts`), where that Location is live anyway; `test/hooks`
  checks that no other area conversation's instructions are read.
- **Judge** (`judge/prompt.ts`): the enable hint never makes a `create` area by itself (`notes` says the main settles
  the split); the reorganization judge follows the user's hint within its rules and may propose actions for busy or
  paused areas (the user's pick waits for them).
- **Glossary of model-facing text**: 영역 모델 (not 영역 메인) in `team_area` plans and answers and the team-account step
  note, `<영역> 모델로` in the preset repair notice, 승인 (not 허락) in plans, 대화 (not 세션) in the tool refusals, and
  the idle word 쉬는 중 (`OwnTeamText.WORDS.idle`; own-web still counts the old 대기 중 as idle, `LEGACY_IDLE`).
- **Catalog**: the main's `team_reorganize` gains the optional `preview` (its property description is inline jsdoc;
  the description's second line is past the inline cut), the owners' and peers' `team_report` gains kind `relay` and a
  `kind` description. Estimated with the listing rule (`  - <signature> // <first line>`, `round(chars / 4)`): about
  +25 tokens on the main's team lines (about 970 → 995) and about +30 on an owner's or a peer's (about 870 → 900); the
  first description lines are unchanged within the 120-character cut. Not re-measured in an e2e probe. With computer
  use on, the team catalog is partial, so the change re-renders the whole catalog once (core `codemode/instructions.ts`
  `update()`, about 2k tokens) instead of one changed line; the prefix stays. `CATALOG_SNAPSHOT` `7024250b6f51afb6…`
  (was `c3275a638e23f3ed…`), computed once for the release with the area messages.
- **Tests**: `test/plugin/v-control-ops.test.ts` (preview, retire preview, named skips with the op, a chosen busy split
  holding the team: main requests `maintaining`, integrations `busy`; folders outside the team), `test/reorg/{plan,
  propose}.test.ts` (`plan.skipped`), `test/report/{digest,fold}.test.ts` (relay), `test/hooks/prompt.test.ts` (role
  refresh), `test/judge/prompt.test.ts`, `test/sessions/{main,owner,peer}.test.ts`, `test/plugin/t2-tools.test.ts`.

## Status (user-made areas, 2026-10-26; area folders inside the home, 2026-10-27)

06 §2.4, §2.7, §2.9 V-b (5), §4.12, §6.2, §6.5, §8.1–8.2, §9.4; decisions TM. Branch `team-manual`. No core file, no
tool description and no role instruction changed (`CATALOG_SNAPSHOT` `7024250b6f51afb6…` stays).

- **Data**: `Area.userMade{at}`; `ReorgOp` `new` gains `main`, `harness` (`OwnTeam.Harness`) and `userMade`,
  `ProposalArea.userMade`; `enable{areaRoot}`. All optional. `judge/validate.ts` keeps the new fields for `by: "user"`
  only.
- **영역 만들기** (`ops/area-create.ts`, `reorg/plan.ts`, `ops/adopt.ts`): `area-record` writes `userMade` and
  `main{model, chosenBy: "user"}` with the ★ preset of that model's group; team R4 is judged at plan time with the new
  area as one more holder (`TeamContext.breaks`), a clash rejects the item (`SAME_COMPANY`). 다시 만들기 keeps the mark.
  The user's adopt row records it too.
- **`area.edit`** (`rpc/area-edit.ts`, feature `area-edit`): role and mark in the team's mutex, no op; a changed role
  rewrites an attached owner's role entry (`Owner.refresh`).
- **V-b (5)** (`tools/reorganize.ts`, `tools/control.ts`): a `team_reorganize` that renames, splits, converts, retires
  or merges (either side) a user-made area is one plan for the whole proposal (action key `apply`, shared with retire),
  run by `user` on approval; `peer_add` without a session on a user-made area plans too.
- **What the main reads** (`report/digest.ts`, `tools/status.ts`): `역할 "…"` (80) and `사용자가 정한 영역` after the
  status word; peers with their roles in the main's area view.
- **에이전트 방식** (`sessions/{main,owner,peer,rotate}.ts`, `reorg/split.ts`): `MainSession.open{harness}` writes
  `own.harness`; owner rotation, a split's A2 owner, created peers and 메인 새 대화 keep the conversation's they follow
  (`MainSession.harnessOf`), a new area's first owner takes the user's choice.
- **Area folders inside the home** (`git/home.ts`, `ops/{enable,home,area-create}.ts`): `Home.worktreeRoot(…, layout)`
  gives `<home>/.worktrees` (`inside`, the default) or `<home>-team` (`beside`); `#` homes keep `<drive>:/own-team/…`.
  `TeamHome.exclude` adds `/.worktrees/` to `<common dir>/info/exclude` (enable's registry step, each new area's
  folder). A new folder may nest only in the worktree that holds the root (`Home.holder`); when the home moved off a
  linked holder, the plan locks it with `own: nested worktrees inside` first. The worktree ceiling and the identity
  check (4.3) keep a nested area whose `.git` file is gone from reaching the home.
- **Tests**: `test/plugin/v-user-made.test.ts`, `test/judge/validate.test.ts`, `test/ops/{area-create,enable}.test.ts`,
  `test/sessions/{peer,rotate}.test.ts`, `test/reorg/split.test.ts`, `test/git/{home,inventory}.test.ts`.

## Status (movable area seat 담당 대화 바꾸기, 2026-11-12)

An area still has one owner seat; the user can move it onto an existing root conversation of the area's folder (06
§6.8, plan and as-built record `own/reports/team-seat-move-plan-2026-11-12.md`, decisions SM in
`own/handoff/decisions-2026-10.md`). Out of scope: moving the team main, several equal owners, a higher `PEER_MAX`.

- Protocol: op kind `seat`, RPC `area.seat {teamID, areaID, sessionID}` (control, `admin`), `OwnerEnded` (rotation
  reasons plus `seat`), `Owner.release?`, `Owner.note?`, `AreaNote.from?: "team"`, area change `seated`, notice
  `seat.moved`, error `seat_invalid{why: child|main|owner|elsewhere|account|unknown|note}` (`account`: no model or
  account to check, `unknown`: the account cannot be read now), `peer_invalid.why` gains `previous` (a previous owner
  asked to be a peer); all optional or added values, no migration.
  Health features `seat` and `owner-note`.
- `sessions/seat.ts` (feature `seat`, `services.features().seat`): `request` checks eligibility in a fixed order (not
  found, child, main, current owner, outside the folder, account unreadable (`unknown`), R4 against the main, no
  account (`account`), R4 across the team) and starts the op. A peer is promoted, a previous owner re-seated, an archived conversation un-archived; a
  paused area and an area without an owner are fine.
- Six resumable steps: `seat.wait` (safe point over the old seat and the target, `also: [target]`; a queue item of the
  target counts only while younger than `SafePoint.WAKE_MS`; no force and no timeout, cancel and `stop-shell` only;
  eligibility again at every check, `seat_invalid{why:"unknown"}` or `internal_error` keeps waiting), `seat.requeue`
  (`Outbox.requeue` for both conversations; a request a conversation took while it was being withdrawn stays `sent` to
  it and fails the op: it is never sent twice), `seat.claim` (waits for a sweep from outside that is in flight on the
  area, then the target into `owner.release` first, the archive flag, preset binding and team context only when they
  differ, the owner allows, the program handoff entry worded for a conversation that was there already, the owner role
  entry last), `seat.settle` (asks delivered to the old seat end `interrupted`, the notice before the Open entry is
  removed; after the claim, so a target that cannot be claimed costs the old seat no ask), `seat.swap` (two phases.
  The registry write: the owner, `previous` with `why: "seat"`, the old seat into `release`, the target left listed in
  `release` as the mark of an unfinished swap, every other owner field kept, `area.main` adopted from the target,
  `area.preset`. Then `complete`, one write lock: the promoted peer leaves the peers and its dispatches, Talk slots,
  watches and notes move to the owner slot, the team note only when a conversation handed the seat and only once, the
  fold-only digest entry `seated` under the key `seat:<areaID>:<to>:<endedAt of the old seat>`, the mark removed last.
  Then the step's summary and notice) and `seat.release` (`Seat.finish`: what a swap left unfinished first, then
  `Outbox.unfresh`, the promoted peer's role entry, the team context, `Seat.sweep`; never fails).
- Standing per step is read from the registry: `moved` (the target owns the seat already), `ready`, `gone` (another
  conversation took it: every step but the release fails with `담당 대화가 그사이 바뀌었어요`). The swap is satisfied
  only when the seat moved and the target is no longer listed in `release`.
- `Seat.sweep` walks `owner.release` by the conversation's current role: the owner or the main keeps everything, a peer
  loses the owner and handoff entries, anything else is stripped (`OwnerSession.strip`, allows, team context). A
  conversation that cannot be reached stays listed (`seat_release_kept`). Callers: the release step and the cancel
  hook, the `op.done` listener, `Seat.resume` at controller start, the prompt hook, unadopt, retire and merge;
  callers outside an op skip an area a running op maintains, run one at a time per area, and finish an unfinished
  swap (`complete`) before they strip anything. Invariant TI-15: a conversation that is not the owner may
  hold owner things only while its id is in `owner.release`.
- The area follows its seat: after a move `area.main` is the target's Ref (`chosenBy: "adopted"`) and `area.preset`
  its preset when that belongs to its model group, else the group's star unless that breaks R4, else the builtin. A
  later rotation opens with those.
- A stop of the old seat while the op maintains the area does not turn Main 멈춤 on (`Pause.stopped` returns early), so
  no pause cause is stored. A pause that was on stays on.
- Instructions: `receive()` says a reply answers an ask sent from this seat, and the owner's handoff line covers a
  conversation that took the seat over; one instruction update per attached owner and peer. The owner note is in no
  role entry.
- Tools: `team_control{action: "seat", area, session or peer}` (plan, admin, `area.seat`; `peer` is a peer's key or
  label, since `team_status` lists a peer without its conversation id); the first description line is exactly
  `DESCRIPTION_LIMIT` long; `CATALOG_SNAPSHOT` `ac2b9170c92f1776…`. `team_status` prints one conversation line
  per area with a peer (`대화: 담당 메모 "…", <label>(<key>) 역할 "…"`, 120 code points each) and lists un-archived
  previous owners among the folder's other conversations. The owner note is on that line only: no digest text has it.
  After the sweep the old seat has no team tool at all; before it the registry check refuses.
- Waiting `fresh` main requests lose the mark when a move finishes; the re-admission of a requeued request under its
  old id relies on core deleting a cancelled inbox row (pinned by tests).
- Accepted limits: a kill between `complete` and the step's summary and notice loses those two (the registry, the
  allows, the role entries, the team note and the digest line are right: `complete` is repeat-safe). A swap that fails
  after `seat.settle` leaves the old seat the owner without the asks that were ended (their askers were told). A
  storage failure after the swap's registry write fails the op although the seat has moved; the sweep that follows
  every op finishes it.
- Open (owner decision O-6 of the plan): the owner note is bound to the seat, so a move keeps it and drops a promoted
  peer's role text.
- **Tests**: `test/sessions/seat.test.ts`, `test/plugin/{seat-rpc,v-seat,t3-resume-seat,v-user-made,t2-tools}.test.ts`,
  `test/e2e/seat.e2e.test.ts`, and cases added to the dispatch, envelope, pause, fold, wake, owner, rotate and
  safe-point tests.

## Status (direct work, areas without a limit, caps: 2.2.6-own.3, 2026-11-14)

Spec 06 §5.9 (direct work), §6.9 (role texts and 팀 지시문), §3.5 V5/V12, §8.1, §2.8–§2.9; decisions DW-1..DW-14,
AL-1..AL-9, CP-1..CP-10 in `own/handoff/decisions-2026-10.md`. No new RPC, event or routing entry; no core patch;
rpcHash unchanged; `packages/client` not regenerated.

- Protocol (all optional, absent = reader default): `Area.directWork {since, at}`, `Policy.directHold` (absent = on),
  `Policy.directTell` (open string; anything but `none`/`always` reads `judge`), `WaitCause.direct`,
  `TeamSettings.instructions`, `SettingsPatch.policy.directHold/directTell` and `instructions`, features `direct` and
  `instructions`. `Policy.maxAreas` stays required, written as 4 and never read (AL-2); `SettingsPatch.policy` no longer
  has it. `PEER_ROLE_BYTES` → `PEER_ROLE_MAX` (1,024 characters), new `OWNER_NOTE_MAX` 1,024 and `PATHS_MAX` 64.
- `dispatch/direct.ts`: `live` (active, `directWork`, Main 멈춤 off), `kept` (Main 멈춤 or held; the TI-13 upkeep rule read
  by release, rotate, heavy, convert, merge, plan, propose, retire, split, the post-integration sync and
  `tools/area.ts`), `serving` (a seat, the owner or a peer, has queued main requests, an unreported received request,
  or a main or program request `sent` to it within `FOLD_LAG_MS` 60 s that is not folded yet; notices and area messages
  never fold, so they do not count), `pass` (solicited items and team requests whose `Dispatch.origin`, the start of
  their integration or op, is inside the stretch), `touched` (latest direct mark of the owner and peers), `handed` (the hand-over
  line), and the service `end`/`sweep`/`spoke`. The prompt hook starts or extends a stretch on a user message in the
  owner conversation when hold is on and the slot is not serving (nor marked `sending`: the outbox's held re-check and
  that mark are one team write, released once the request is recorded `sent`), and records `spoke` for a user message in the main
  conversation before its detached record runs. Peers and third conversations stay information.
- Admission: a held head waits with `why: "paused"`, `cause: {direct: true}` and no retry timer; `Outbox.why`, `wait`,
  `admitted` carry `direct`; `since` resets on a cause change. `release()` (다시 시작) skips held areas; `Pause.stopped`
  does not switch Main 멈춤 on while held. `Pause.area{on:false}` ends direct work first (`handed`, or `taken` for the
  main's own resume), then wakes, retries integrations and drains.
- Reports (`report/events.ts`): `quiet = live && !serving` is decided inside the team write of `report()`,
  `peerReport()` (with the peer's own seat and fold) and the owner's non-quota `failed` fold; quiet entries are stored with `wake: false` and appended to
  the stretch. `Fold.entry` takes `wake?`; new reasons `handed` (wakes), `taken`, `role` (fold only). `AreaFold.ended`
  records the request a run served; `AreaFold.stretch` is a summary only.
- Whole texts (`report/texts.ts`, CP-1..CP-3, DW-14): KV `report:<team>:<area>` (`reports`: newest per seat and kind;
  `relays`: newest first while their summed length is within `RELAY_CHARS` 100,000, the rest counted) and
  `stretch:<team>:<area>` (`STRETCH_CHARS` 100,000 per stretch, overflow counted). Both prefixes are in `ofTeam`, so
  undoing an enable removes them (disable keeps them for a re-enable under the same team id), and `Areas.remove`
  deletes an area's two keys with its record (a freed slug comes back). The digest keeps `Fold.excerpt` (1,000 code points, `…` when cut). An invalid value
  loses only that area's texts (`log.warn`).
- Digest: `team_status` renders without `fit` (core bounds tool output at 50 KiB / 2,000 lines); the focused area's
  role, owner note and peer roles are whole, and a main one-area view adds the newest report of each kind, the relays
  and the current or last stretch, or the excerpt with `(전문 없음)`. The update keeps `fit`, with the `할 일` line
  reserved in the short pass (500 tokens, ` · 외 n개`) and `CUT_NOTE` last when a quote ends in `…`. A live area's line
  prints `직접 작업 중(…부터) · 모아 둔 보고 n개` and no report quote, report notes or to-dos.
- Integrate gate: on a held area an owner integrates at once only in a run the user opened in that conversation
  (`VoicePlan.backed(…, "admin") === "ok"`), else a plan in the area folder (`action: TIP`); the main always gets the
  plan. Waiting integrations created before the stretch and the post-integration fast-forward wait until hand-over.
- Areas (AL): V5 removed (`JudgeValidate.BATCH` 4 is not a limit: a main proposal that creates more new areas plans
  first, `PLAN_MANY`/`PREVIEW_MANY`); enable makes every proposed area. `team_area{action:"role"}` (`tools/area.ts`):
  the main at once in a user-opened run on a main-made unheld area, refused on a held area unless the user wrote to the
  main after the last direct message (`told`), else a plan; an owner at once in a run the user opened there on a
  main-made area, else a plan; peers refused. `area.edit` takes the internal `by` and leaves a `role` entry when the
  owner or the screen changed it. `userMade: true` on a main `new` op is kept (standing areas); `retirable` and
  `retirableOf` skip `userMade` and `directWork`. Roles: 1,000 refused for user/main/owner text (UTF-16 `.length`), the
  judge's clipped with `…`, the reorg judge data clipped at 200 and labelled `역할:`.
- Caps (CP): `team_report.text` and `team_message.text` 20,000; `REPLY_MAX` 20,000 with a cut marker; asks 10 per
  conversation + 40 per team; a pushed-out note is told and a lapsed one leaves an audit line; `team_need_paths` and
  `area.paths{add}` 64.
- Role texts (`sessions/instructions.ts`, DW-9): PROGRAM (per area, `directHold`, `directTell`) + `GUARD` + BEHAVIOUR
  (default or the user's block from KV `instructions:<team>`, 2,000 characters, refused visibly). `main.create` falls
  back to `POLICY` and default blocks before the team record exists; `main.refresh` deletes the `current` key first;
  `TeamSettings.write` compares before/after and runs `direct.sweep`, `main.refresh`, `owner.stale`, `peers.stale` as
  needed; seat verify checks the role entry is present. Sizes: main 2,537 (hold off 2,292, pin < 2,600), owner plain
  2,569, peer plain 2,051.
- Deferred items handled (D7): the quiet seat banner goes once the user writes there; `Peers.write` moves the owner's
  direct mark to a promoted peer; a promoted peer's role becomes the empty 담당 메모; `seat_claim` debug lines.
- Standing areas the team has (SK, 2026-11-17, live case L12): `team_area{keep | unkeep}` (`tools/area.ts` `keep`) sets
  or removes `Area.userMade` through `area.edit` (the menu toggle's record): keep at once by the main in a run the user
  opened (`told`) or by an owner in a run the user opened there, else a plan; unkeep always a plan; a held area takes
  the mark too. `ReorgOp` `rename` gains `goal?` and `userMade?: true` (V-rules keep them for user/main authors, drop
  them for the judge); `area-rename` writes name, role and mark, refreshes an attached owner on a new role, keeps
  `previous{goal, userMade}` so the undo restores all three; a main/judge rename with a role skips a held area
  (`paused`). `PLAN_MANY(names, mine, reused)` counts marked renames apart; their plan lines carry `ROLE` and `MINE`.
  Main role text: one line on standing roles (new/rename `userMade:true`, keep for an area kept as it is, a reused
  area's rename carries its role); main 2,699 (pin < 2,700).
- Downgrade: an older build that rewrites a record drops `directWork`, `directHold`, `directTell`, `ended` and the stretch
  summary (DW-13); the per-area texts and 팀 지시문 stay under their own keys, unused.
