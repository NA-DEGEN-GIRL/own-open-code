import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Rpc } from "@opencode/schema/rpc"
import { OwnTeam } from "../src/index.js"
import { Portable } from "../src/portable.js"
import { OwnHarnessRouting } from "../src/rpc-harness-routing.js"
import { OwnTeamRouting } from "../src/rpc-team-routing.js"
import { OwnTeamText } from "../src/rpc-team-text.js"
import { CODEX_ACCOUNT, roundTrip, SESSION, SESSION_2 } from "./fixtures.js"

const Definition = OwnTeam.Definition
type MethodName = OwnTeam.MethodName
type EventName = OwnTeam.EventName
type ErrorName = OwnTeam.ErrorName

const methodNames = Object.keys(Definition.methods) as ReadonlyArray<MethodName>
const eventNames = Object.keys(Definition.events) as ReadonlyArray<EventName>
const errorsOf = (name: MethodName): ReadonlyArray<string> => Object.keys(Definition.methods[name].errors)
const codec = (schema: unknown) => schema as Schema.Codec<unknown, unknown>

/** 06 §2.7, in table order. */
const SPEC_METHODS = [
  "health",
  "team.get",
  "team.list",
  "enable",
  "disable",
  "team.home",
  "team.pause",
  "area.pause",
  "op.get",
  "op.confirm",
  "op.undo",
  // RH-20 (2026-10-29): 취소 and 바로 진행 of an op that waits.
  "op.cancel",
  "op.force",
  "area.adopt",
  "area.unadopt",
  "outbox.list",
  "outbox.cancel",
  "area.rotate",
  // 담당 대화 바꾸기 (2026-11-12): the owner seat moves onto an existing conversation of the folder.
  "area.seat",
  "main.rotate",
  "area.main",
  "team.account",
  "area.preset",
  "area.paths",
  // 사용자가 정하는 영역 (2026-10-26): the role text and the user-made mark; 2026-10-27: 영역 만들기's `만들 곳`.
  "area.edit",
  "area.create.check",
  // 동료 (2026-10-09, 06 §2.7): registering, editing and removing area peers.
  "area.peer.add",
  "area.peer.edit",
  "area.peer.remove",
  "area.integrate",
  "integration.get",
  "integration.undo",
  // RH-42 (2026-10-29): 되돌리기 취소 of an undo that waits outside its op.
  "integration.undo.cancel",
  "integration.push.plan",
  "integration.push.execute",
  "reorg.propose",
  "reorg.apply",
  "decisions.list",
  "decisions.add",
  "settings.get",
  "settings.set",
  "diagnostics",
  // Git 저장소로 만들기 (2026-10-11, 06 §3.0).
  "project.gitInit.plan",
  "project.gitInit",
  "worktreeChat.list",
]

const SPEC_EVENTS = [
  "team.changed",
  "area.changed",
  "outbox.changed",
  "integration.changed",
  "op.progress",
  "op.done",
  "op.confirm",
  "notice",
  "worktreeChat.changed",
]

const SPEC_ERRORS = [
  "internal_error",
  "not_found",
  "not_git",
  "git_too_old",
  "lfs_missing",
  "team_off",
  "busy",
  "not_safe_point",
  "invalid_proposal",
  "nonce_invalid",
  "path_forbidden",
  "dirty",
  "conflict",
  "in_use",
  "broken",
  "remote_rejected",
  "unsupported",
  "same_company_subscription",
  "preset_wrong_group",
  // 동료 (2026-10-09).
  "peer_invalid",
  // 담당 대화 바꾸기 (2026-11-12).
  "seat_invalid",
  // Git 저장소로 만들기 (2026-10-11).
  "git_init_refused",
  "identity_missing",
  "git_failed",
  // RH-20 (2026-10-29): a write the controller lock still holds back gives up after ~10 s.
  "unavailable",
]

const SPEC_NOTICES = [
  "account.waiting",
  "account.moved",
  "preset.repair",
  "paths.added",
  "paths.kept",
  "drift.repaired",
  "rotation.done",
  "lfs.installed",
  "external.found",
  "area.broken",
  "branch.followed",
  "link.blocked",
  "link.copy.dirty",
  "reorg.skipped",
  "detached.kept",
  "wake.limited",
  // T2: the notices 06 §8.8 (폴더가 옮겨져 따라갔습니다), §7.2 (기다리며 알림) and §7.4 (keep ref를 만들고 알린다) name.
  "folder.followed",
  "integration.waiting",
  "undo.kept",
  // 2026-10-09: the heavy-folder list follows the project (06 §4.4) and large ignored folders are named (06 §4.11).
  "heavy.grew",
  "disk.ignored",
  // RH-20 (2026-10-29): a team op that waits more than 5 minutes (06 §8.9).
  "op.stalled",
  // 담당 대화 바꾸기 (2026-11-12).
  "seat.moved",
]

/** 06 §2.7 scope column; everything else is `read`. */
const SPEC_SCOPES = {
  local: [
    "op.confirm",
    "integration.push.plan",
    "integration.push.execute",
    "settings.set",
    "project.gitInit.plan",
    "project.gitInit",
  ],
  prompt: [
    "team.pause",
    "area.pause",
    "op.cancel",
    "outbox.cancel",
    "integration.undo.cancel",
    "area.rotate",
    "main.rotate",
    "area.paths",
    "decisions.add",
  ],
  switch: ["area.main", "area.preset", "team.account"],
  admin: [
    "enable",
    "disable",
    "team.home",
    "op.undo",
    "op.force",
    "area.adopt",
    "area.unadopt",
    "area.edit",
    "area.seat",
    "area.create.check",
    "area.peer.add",
    "area.peer.edit",
    "area.peer.remove",
    "area.integrate",
    "integration.undo",
    "reorg.propose",
    "reorg.apply",
  ],
}

// ---------------------------------------------------------------------------------------------------------------
// Samples

const TEAM = "tm_0123456789ab"
const AREA = "ar_inventory-ui"
const AREA_2 = "ar_save-v3"
const OP = "op_01JB0000000000000000000000"
const OP_2 = "op_01JB0000000000000000000001"
const DISPATCH = "dp_01JB0000000000000000000002"
const INTEGRATION = "ig_01JB0000000000000000000003"
const PROPOSAL = "rp_01JB0000000000000000000004"
const EVENT = "01JB0000000000000000000005"
const NONCE = "0123456789ABCDEFGHJK"
const SHA = "a".repeat(40)
const SHA_2 = "b".repeat(64)
const REF = { providerID: "own-codex-p1q2", id: "gpt-6-astra", variant: "high" }
const PRESET = "pr_01JB0000000000000000000006"

const team = {
  id: TEAM,
  projectID: "prj_own",
  commonDir: "D:/#Projects/own-open-code/.git",
  target: "main",
  state: "on",
  rev: 7,
  home: { directory: "D:/own-open-code", linked: true, chosenBy: "session" },
  main: { sessionID: SESSION, previous: [SESSION_2] },
  worktreeRoot: "D:/own-open-code-team",
  heavy: { dirs: ["Assets/Textures"], measuredAt: SHA, forcedBytes: 4_096 },
  shared: [{ name: "datasets", target: "D:/own-open-code/datasets", protect: "acl" }],
  commands: {
    setup: { argv: ["bun", "install"] },
    code: [{ argv: ["bun", "run", "typecheck"] }],
    assets: [{ shell: "make assets && make check" }],
  },
  env: { symlinkFix: "skip-worktree", bunCache: "other-volume", lfs: "system" },
  external: [
    { directory: "D:/#Projects/own-open-code", why: "primary" },
    { directory: "D:/own-open-code/.claude/worktrees/x", why: "other-tool" },
  ],
  policy: OwnTeam.POLICY,
  patterns: ["/.cursor/worktrees/"],
}

const area = {
  id: AREA,
  teamID: TEAM,
  name: "inventory-ui",
  subtitle: "인벤토리 화면",
  goal: "정렬 버그와 UI",
  origin: "created",
  state: "active",
  branch: "inventory-ui",
  gitDir: "D:/#Projects/own-open-code/.git/worktrees/inventory-ui",
  base: { sha: SHA, at: 1 },
  directory: "D:/own-open-code-team/inventory-ui",
  shape: "code",
  cone: {
    extra: { "Assets/Textures/UI": { reason: "auto", at: 2, bytes: 120 } },
    kept: { "Assets/Audio": "변경 있음" },
  },
  owner: { sessionID: SESSION_2, previous: [{ sessionID: SESSION, endedAt: 3, why: "fresh" }], attached: true },
  main: { model: REF, chosenBy: "user" },
  preset: PRESET,
  paused: false,
  status: { kind: "busy", at: 4, text: "작업 중" },
  candidate: { sha: SHA, at: 5, text: "정렬 수정과 테스트 3개" },
  handoff: { file: "areas/inventory-ui/handoff.md", hash: "c0ffee", at: 6 },
  linkCopies: { "packages/web/link": SHA },
  peers: [
    {
      key: "reviewer",
      sessionID: SESSION,
      label: "리뷰어",
      role: "변경을 읽고 위험한 곳을 짚는다",
      attached: true,
      origin: "registered",
      at: 7,
      direct: { at: 8 },
    },
  ],
}

const peer = {
  key: "sim",
  sessionID: SESSION_2,
  label: "시뮬레이터",
  role: "밸런스 시뮬레이션을 돌린다",
  attached: true,
  origin: "created",
  at: 9,
}

/** An adopted area without a conversation yet, paused by 모두 멈추기 and waiting for a quota reset. */
const adopted = {
  id: AREA_2,
  teamID: TEAM,
  name: "save-v3",
  goal: "",
  origin: "adopted",
  state: "broken",
  broken: { why: "identity", at: 7 },
  branch: "save-v3",
  gitDir: "D:/#Projects/own-open-code/.git/worktrees/save-v3",
  base: { sha: SHA_2, at: 1 },
  directory: "D:/own-open-code/.worktrees/save-v3",
  shape: "plain",
  cone: { extra: {}, kept: {} },
  owner: { sessionID: null, pending: SESSION, previous: [], attached: false },
  preset: "builtin:codex",
  paused: "all",
  direct: { at: 8, sessionID: SESSION_2 },
  status: { kind: "waiting-quota", at: 9, text: "한도 대기", until: 1_790_004_120_000 },
  handoff: null,
}

const dispatch = {
  id: DISPATCH,
  teamID: TEAM,
  areaID: AREA,
  seq: 3,
  from: "main",
  kind: "task",
  task: "정렬 버그",
  text: "인벤토리 정렬이 아이템 희귀도를 무시합니다.",
  fresh: true,
  state: "sent",
  sentTo: { sessionID: SESSION_2, msgID: "msg_01JB0000000000000000000000", at: 10 },
  movedFrom: AREA_2,
  createdAt: 9,
}

const suggestion = { kind: "convert", worktree: "D:/own-open-code/.worktrees/old-full", why: "코드 전용이면 9 GB 절약" }

const summary = {
  lines: [
    { kind: "area", areaID: AREA, change: "created" },
    { kind: "area", areaID: AREA_2, change: "split", from: AREA },
    { kind: "unadopted", directory: "D:/own-open-code/.worktrees/cl-x", changes: 4, ahead: 2 },
    { kind: "r4", areaID: AREA_2, accountID: CODEX_ACCOUNT },
    { kind: "suggest", suggestion },
    { kind: "notes", text: "작은 일 하나뿐이면 대화 하나로 충분합니다." },
    { kind: "prepare", bytes: 2_500_000_000 },
    { kind: "home-changes", count: 2 },
    { kind: "old-git", version: "2.41.0" },
    { kind: "skipped", item: "ops/1", areaID: AREA_2, why: "paused" },
    { kind: "cancelled", areaID: AREA, dispatchID: DISPATCH },
    { kind: "queued", areaID: AREA, sessionID: SESSION_2, count: 1 },
    { kind: "lock-kept", directory: "D:/own-open-code" },
    { kind: "ref", ref: `refs/own/keep/${SHA}`, sha: SHA, bytes: 1_024 },
    { kind: "paths", areaID: AREA, change: "added", dirs: ["Assets/Textures/UI"], bytes: 125_829_120 },
    { kind: "account", model: REF, areas: 3 },
    { kind: "integrated", areaID: AREA, integrationID: INTEGRATION, newerSkipped: 2 },
    { kind: "heavy", dirs: ["Assets/Textures", "Assets/Audio", "Assets/Models"], bytes: 15_783_627_571 },
    { kind: "pushed", areaID: AREA, integrationID: INTEGRATION, remote: "origin", ref: "main" },
  ],
}

const stepConfirm = {
  nonce: NONCE,
  expiresAt: 1_790_000_600_000,
  text: "'cl-perf' 폴더를 지울까요?",
  bytes: 2_684_354_560,
  files: [{ path: "node_modules", bytes: 2_684_354_560 }],
  manifest: "f00d",
}

const op = {
  id: OP,
  teamID: TEAM,
  kind: "enable",
  by: "user",
  state: "waiting",
  createdAt: 11,
  summary,
  undo: { available: true },
  steps: [
    { id: "s1", kind: "keep-ref", args: { sha: SHA }, mode: "auto", state: "done" },
    {
      id: "s2",
      kind: "worktree-create",
      args: { slug: "inventory-ui", nested: { cone: ["src"] } },
      mode: "auto",
      state: "done",
      note: "1.8초",
    },
    { id: "s3", kind: "retire-remove", args: {}, mode: "confirm", state: "needs_confirm", confirm: stepConfirm },
  ],
}

/** RH-20: a rotation whose first step waits for commands left running in the area folder. */
const waitingOp = {
  id: OP,
  teamID: TEAM,
  kind: "rotate",
  by: "main",
  state: "running",
  areaID: AREA,
  createdAt: 11,
  steps: [
    {
      id: "s1",
      kind: "rotate.begin",
      args: { areaID: AREA },
      mode: "auto",
      state: "pending",
      startedAt: 12,
      wait: {
        why: "safe-point",
        detail: "shell",
        text: "인벤토리 UI: 실행 중인 명령이 끝나기를 기다려요: 'bun run dev'",
        since: 12,
        sessionIDs: [SESSION_2],
        shells: [{ id: "sh_01", command: "bun run dev", sessionID: SESSION_2, kind: "shell", directory: "D:/x" }],
        actions: ["cancel", "force", "stop-shell"],
      },
    },
    { id: "s2", kind: "rotate.handoff", args: {}, mode: "auto", state: "pending" },
    {
      id: "s3",
      kind: "retire-remove",
      args: {},
      mode: "confirm",
      state: "needs_confirm",
      confirm: stepConfirm,
      answer: { choice: "do", at: 13 },
    },
  ],
}

const undoOp = {
  id: OP_2,
  teamID: TEAM,
  kind: "undo",
  by: "user",
  state: "done",
  areaID: AREA,
  createdAt: 12,
  undo: { available: false, of: OP },
  steps: [],
}

const confirm = { teamID: TEAM, opID: OP, stepID: "s3", kind: "retire-remove", areaID: AREA, ...stepConfirm }

const integration = {
  id: INTEGRATION,
  teamID: TEAM,
  areaID: AREA,
  state: "done",
  target: "main",
  source: SHA,
  base: SHA_2,
  candidate: SHA,
  how: "merge",
  newerSkipped: 2,
  conflicts: [],
  verify: {
    code: { ok: true, ms: 134_000, log: "integrations/ig.log" },
    assets: "skipped",
    cone: { ok: true, missing: [] },
  },
  advanced: { how: "ff-in-worktree", at: 13, directory: "D:/own-open-code" },
  pushed: { at: 14, remote: "origin", ref: "main", pr: "https://example.invalid/pr/1" },
  createdAt: 12,
}

/** 06 §3.4's example plus every reorganization action. */
const proposal = {
  version: 1,
  target: "main",
  heavy: [{ dir: "Assets/Textures", why: "LFS 그림 9.2 GB" }],
  shared: [{ dir: "datasets", why: "읽기 전용 학습 데이터 40 GB" }],
  areas: [
    {
      slug: "inventory-ui",
      name: "인벤토리 화면",
      goal: "정렬 버그와 UI",
      shape: "code",
      needs: ["Assets/Textures/UI"],
      adopt: { worktree: "D:/own-open-code/.worktrees/x", branch: "x", owner: SESSION },
      create: null,
    },
    { slug: "docs", name: "문서", create: { from: "main" } },
  ],
  leave: [{ worktree: "D:/own-open-code/.worktrees/local-model", why: "main과 같은 위치, 변경 없음" }],
  suggest: [suggestion],
  ops: [
    { op: "new", slug: "payments-ui", name: "결제 화면", goal: "새 결제 흐름", needs: [], from: "main", why: "새 일" },
    { op: "rename", area: "inventory-ui", name: "인벤토리", subtitle: null },
    { op: "retire", area: "docs" },
    { op: "split", area: "payments", slug: "payments-server", name: "결제 서버" },
    { op: "merge", area: "payments", from: "payments-server" },
    { op: "convert", area: "inventory-ui", shape: "code" },
    { op: "move", sessionID: SESSION_2, area: "inventory-ui" },
  ],
  commands: { setup: "bun install", code: ["bun run typecheck"], assets: [] },
  notes: "사용자에게 보일 한두 문장",
}

const plan = {
  steps: [
    { item: "ops/0", kind: "branch-create", mode: "auto" },
    { item: "ops/2", kind: "retire-remove", mode: "confirm", areaID: AREA_2 },
  ],
  rejected: [{ item: "ops/6", why: "V11" }],
}

const health = {
  version: "2.0.18-own.6",
  buildId: "0123456789ab",
  guard: "ok",
  mode: "local",
  git: { path: "C:/Program Files/Git/cmd/git.exe", version: "2.55.0", ok: true },
  lfs: { version: "3.7.1" },
  leader: true,
  features: ["enable", "pause", "outbox", "rotate", "area-main", "area-preset", "team-account", "paths", "settings"],
}

const settings = { policy: OwnTeam.POLICY, commands: team.commands, patterns: team.patterns }

const samples: { readonly [M in MethodName]: { readonly input: unknown; readonly output: unknown } } = {
  health: { input: {}, output: health },
  "team.get": {
    input: { directory: "D:/own-open-code" },
    output: { team, areas: [area, adopted], waiting: { [AREA]: 0, [AREA_2]: 2 }, op, pending: [confirm] },
  },
  "team.list": {
    input: {},
    output: { teams: [{ id: TEAM, projectID: "prj_own", home: "D:/own-open-code", state: "on", areas: 2 }] },
  },
  enable: { input: { directory: "D:/own-open-code", sessionID: SESSION, hint: "인벤토리 일" }, output: { opID: OP } },
  disable: { input: { teamID: TEAM, cleanup: false }, output: { opID: OP } },
  "team.home": { input: { teamID: TEAM, directory: "D:/own-open-code" }, output: { opID: OP } },
  "team.pause": { input: { teamID: TEAM, on: true }, output: { team } },
  "area.pause": { input: { teamID: TEAM, areaID: AREA, on: false }, output: { area } },
  "op.get": { input: { opID: OP }, output: { op: undoOp } },
  "op.confirm": { input: { opID: OP, stepID: "s3", choice: "skip", nonce: NONCE }, output: { op } },
  "op.undo": { input: { opID: OP }, output: { opID: OP_2 } },
  "op.cancel": { input: { opID: OP }, output: { op: { ...waitingOp, state: "cancelled" } } },
  "op.force": { input: { opID: OP, action: "stop-shell" }, output: { op: waitingOp } },
  "area.adopt": { input: { teamID: TEAM, directory: "D:/own-open-code/.worktrees/cl-x" }, output: { opID: OP } },
  "area.unadopt": { input: { teamID: TEAM, areaID: AREA_2 }, output: { opID: OP } },
  "outbox.list": {
    input: { teamID: TEAM, areaID: AREA },
    output: {
      items: [dispatch],
      why: "maintaining",
      since: 13,
      cause: { opID: OP, kind: "rotate", failure: "새 대화로 바꾸지 못했어요", at: 14, retryAt: 44 },
    },
  },
  "outbox.cancel": { input: { teamID: TEAM, areaID: AREA, dispatchID: DISPATCH }, output: {} },
  "area.rotate": { input: { teamID: TEAM, areaID: AREA }, output: { opID: OP } },
  "area.seat": { input: { teamID: TEAM, areaID: AREA, sessionID: SESSION }, output: { opID: OP } },
  "main.rotate": { input: { teamID: TEAM }, output: { opID: OP } },
  "area.main": { input: { teamID: TEAM, areaID: AREA, model: REF, now: true }, output: { area, opID: OP } },
  "team.account": {
    input: { teamID: TEAM, target: REF, mode: "after-idle", dryRun: true },
    output: {
      plan: {
        areas: [{ areaID: AREA, rotate: true, busy: true }],
        busy: { sessions: 2, children: 1 },
        estimate: null,
        r4: [{ areaID: AREA, presetID: PRESET, accountID: CODEX_ACCOUNT, roles: ["own-review"] }],
      },
    },
  },
  "area.preset": { input: { teamID: TEAM, areaID: AREA, presetID: "builtin:claude-sub" }, output: { area: adopted } },
  "area.paths": {
    input: { teamID: TEAM, areaID: AREA, add: ["Assets/Textures/UI"], release: ["Assets/Audio"], reason: "UI 그림" },
    output: { opID: OP },
  },
  "area.peer.add": {
    input: { teamID: TEAM, areaID: AREA, create: { label: "시뮬레이터", role: "밸런스 시뮬레이션을 돌린다" } },
    output: { area, peer },
  },
  "area.peer.edit": {
    input: { teamID: TEAM, areaID: AREA, key: "reviewer", role: "보안 위주로 읽는다" },
    output: { area },
  },
  "area.peer.remove": { input: { teamID: TEAM, areaID: AREA, key: "reviewer" }, output: { area } },
  "area.edit": {
    input: { teamID: TEAM, areaID: AREA, goal: "몬스터 그림과 스프라이트를 만든다", userMade: true },
    output: { area: { ...area, userMade: { at: 1_790_000_000_000 } } },
  },
  "area.create.check": {
    input: { teamID: TEAM, slug: "main" },
    output: { slug: "main-2", directory: "D:/quest/.worktrees/main-2", taken: "branch" },
  },
  "area.integrate": { input: { teamID: TEAM, areaID: AREA }, output: { opID: OP, integrationID: INTEGRATION } },
  "integration.get": { input: { integrationID: INTEGRATION }, output: { integration } },
  "integration.undo": { input: { integrationID: INTEGRATION }, output: { opID: OP } },
  "integration.undo.cancel": { input: { integrationID: INTEGRATION }, output: { integration } },
  "integration.push.plan": {
    input: { integrationID: INTEGRATION, pr: true },
    output: {
      nonce: NONCE,
      expiresAt: 1_790_000_600_000,
      remote: "origin",
      ref: "main",
      commands: ["git lfs push origin main", "git push origin main"],
    },
  },
  "integration.push.execute": { input: { nonce: NONCE }, output: { opID: OP } },
  "reorg.propose": { input: { teamID: TEAM, hint: "결제를 나누기" }, output: { proposalID: PROPOSAL, proposal, plan } },
  "reorg.apply": { input: { teamID: TEAM, proposal }, output: { opID: OP } },
  "decisions.list": {
    input: { teamID: TEAM },
    output: {
      items: [
        { number: 1, title: "결제 API", file: "decisions/0001-payments-api.md", at: 15, source: "main", areas: [AREA] },
      ],
    },
  },
  "decisions.add": {
    input: { teamID: TEAM, title: "결제 API", body: "REST로 간다" },
    output: { number: 2, file: "decisions/0002-x.md" },
  },
  "settings.get": { input: { teamID: TEAM }, output: settings },
  "settings.set": {
    input: { teamID: TEAM, patch: { policy: { autoAllow: false, askDiskBytes: 1 }, patterns: [] } },
    output: { team },
  },
  "worktreeChat.list": {
    input: { sessionID: "ses_parent" },
    output: {
      items: [
        {
          sessionID: "ses_child",
          parentID: "ses_parent",
          name: "login-form",
          title: "로그인 화면",
          directory: "D:/projects/app/.worktrees/login-form",
          branch: "login-form",
          base: { branch: "main", commit: SHA },
          state: "done",
          summary: "로그인 화면을 만들고 커밋했어요.",
          created: 10,
          updated: 20,
          integrated: { before: SHA, after: SHA, at: 30, how: "ff" },
        },
      ],
      parent: { sessionID: "ses_grand", title: "앱" },
    },
  },
  diagnostics: {
    input: { teamID: TEAM },
    output: {
      inventory: [
        {
          directory: "D:/own-open-code",
          head: SHA,
          branch: "main",
          locked: "own.team home",
          class: "home",
          nested: false,
        },
        {
          directory: "D:/own-open-code/.worktrees/save-v3",
          head: null,
          branch: null,
          locked: null,
          class: "area",
          nested: true,
          areaID: AREA_2,
        },
      ],
      versions: { git: health.git, lfs: null },
      locks: [{ directory: "D:/own-open-code", reason: "own.team home" }],
      cones: [{ areaID: AREA, shape: "code", patterns: ["src", "docs"] }],
      lastErrors: [{ at: 16, opID: OP, stepID: "s2", message: "exit 128" }],
    },
  },
  "project.gitInit.plan": {
    input: { directory: "D:/projects/binary-assets" },
    output: {
      directory: "D:/projects/binary-assets",
      state: "none",
      branch: "main",
      identity: { name: "Demo User", email: null },
      gitignore: { exists: false, proposal: "node_modules/\n" },
      files: {
        kind: "listed",
        total: { count: 12, bytes: 33_554_944 },
        proposal: { count: 0, bytes: 0 },
        proposalRequired: false,
        largest: [{ path: "bios/BOARD.CAP", bytes: 33_554_432, binary: true, ignored: false }],
        flagged: [{ path: "bios/BOARD.CAP", bytes: 33_554_432, binary: true, ignored: false }],
        flaggedMore: 0,
        nested: ["tools/UEFITool/"],
      },
      limits: { largeBytes: 10_485_760, binaryBytes: 1_048_576 },
    },
  },
  "project.gitInit": {
    input: {
      directory: "D:/projects/binary-assets",
      firstCommit: {
        gitignore: true,
        include: [],
        identity: { name: "Demo User", email: "demo@example.invalid" },
      },
    },
    output: {
      directory: "D:/projects/binary-assets",
      branch: "main",
      commit: SHA,
      committed: { count: 11, bytes: 512 },
      excluded: 2,
      gitignore: "written",
      projectID: "prj_0123",
    },
  },
}

const errorSamples: { readonly [E in ErrorName]: unknown } = {
  internal_error: {},
  not_found: { what: "area", id: AREA },
  not_git: { directory: "D:/not-a-repo" },
  git_too_old: { version: "2.39.0", minimum: "2.40.0" },
  lfs_missing: { tool: "git-lfs", version: null },
  team_off: { teamID: TEAM },
  busy: { teamID: TEAM, opID: OP, kind: "integrate", waitingFor: "wait", since: 15 },
  unavailable: { why: "controller_lock", pid: 4321 },
  not_safe_point: { areaID: AREA, why: "pty", sessionIDs: [SESSION_2] },
  invalid_proposal: { rejected: [{ item: "areas/0", why: "V2" }] },
  nonce_invalid: {},
  path_forbidden: { path: "D:/#Projects/own-open-code-team/x", why: "hash" },
  dirty: { directory: "D:/own-open-code", count: 2, paths: ["src/a.ts", "src/b.ts"] },
  conflict: { ref: "refs/heads/main", expected: SHA, actual: SHA_2 },
  in_use: { branch: "main", directory: "D:/own-open-code" },
  broken: { areaID: AREA, why: "missing" },
  remote_rejected: { remote: "origin", message: "non-fast-forward" },
  unsupported: { feature: "adopt" },
  same_company_subscription: { accountID: CODEX_ACCOUNT },
  preset_wrong_group: { group: "claude-sub" },
  peer_invalid: { why: "elsewhere" },
  seat_invalid: { why: "elsewhere" },
  git_init_refused: { why: "inside", parent: "D:/projects" },
  identity_missing: {},
  git_failed: { step: "commit", message: "pre-commit hook failed" },
}

const envelope = { eventId: EVENT, origin: "global" }
const eventSamples: { readonly [E in EventName]: unknown } = {
  "team.changed": { ...envelope, teamID: TEAM, rev: 8 },
  "area.changed": { ...envelope, teamID: TEAM, areaID: AREA, rev: 8, status: adopted.status, paused: "user" },
  "outbox.changed": { ...envelope, teamID: TEAM, areaID: AREA, waiting: 2 },
  "integration.changed": { ...envelope, teamID: TEAM, areaID: AREA, integrationID: INTEGRATION, state: "waiting" },
  "op.progress": { ...envelope, teamID: TEAM, opID: OP, stepID: "s2", state: "done", text: "영역 2개를 준비하는 중…" },
  "op.done": { ...envelope, teamID: TEAM, opID: OP, state: "waiting", summary, undoable: true, pending: 1 },
  "op.confirm": { ...envelope, ...confirm },
  notice: {
    ...envelope,
    teamID: TEAM,
    areaID: AREA,
    kind: "preset.repair",
    text: "'다른 회사 리뷰'가 ChatGPT 03을 써서 inventory-ui 리뷰를 메인 모델로 돌립니다",
    data: { presetID: PRESET, accountID: CODEX_ACCOUNT, bytes: 0, fixable: true },
  },
  "worktreeChat.changed": { ...envelope, parentID: "ses_parent" },
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

type Standard = {
  "~standard": { validate: (value: unknown) => { value?: unknown; issues?: ReadonlyArray<{ message: string }> } }
}
const validate = (schema: unknown, value: unknown) => (schema as Standard)["~standard"].validate(value)

/** Property names of a schema graph, following unions, arrays, records and optional-key encodings. */
function propertyNames(node: unknown, seen = new Set<unknown>()): ReadonlyArray<string> {
  if (typeof node !== "object" || node === null || seen.has(node)) return []
  seen.add(node)
  const ast = node as {
    propertySignatures?: ReadonlyArray<{ name: PropertyKey; type: unknown }>
    indexSignatures?: ReadonlyArray<{ type: unknown }>
    types?: ReadonlyArray<unknown>
    elements?: ReadonlyArray<unknown>
    rest?: ReadonlyArray<unknown>
    encoding?: ReadonlyArray<{ to: unknown }>
  }
  return [
    ...(ast.propertySignatures ?? []).flatMap((property) => [
      String(property.name),
      ...propertyNames(property.type, seen),
    ]),
    ...[
      ...(ast.indexSignatures ?? []).map((index) => index.type),
      ...(ast.types ?? []),
      ...(ast.elements ?? []),
      ...(ast.rest ?? []),
      ...(ast.encoding ?? []).map((link) => link.to),
    ].flatMap((child) => propertyNames(child, seen)),
  ]
}

const astOf = (schema: unknown) => (schema as Schema.Top).ast
const definitionSchemas = [
  ...methodNames.flatMap((name) => {
    const method = Definition.methods[name]
    return [method.input, method.output, ...Object.values(method.errors)]
  }),
  ...eventNames.map((name) => Definition.events[name].schema),
]

// ---------------------------------------------------------------------------------------------------------------

describe("own.team definition", () => {
  test("has the RPC id own.team and the prompt source own.team", () => {
    expect(Definition.id).toBe("own.team")
    expect<string>(OwnTeam.ID).toBe("own.team")
    expect<string>(OwnTeamRouting.ID).toBe("own.team")
    expect<string>(OwnTeam.PROMPT_SOURCE).toBe("own.team")
  })

  test("declares exactly the 06 §2.7 methods, T2 and T3 ones included", () => {
    expect<ReadonlyArray<string>>([...methodNames].sort()).toEqual([...SPEC_METHODS].sort())
  })

  test("declares exactly the 06 §2.7 events", () => {
    expect<ReadonlyArray<string>>([...eventNames].sort()).toEqual([...SPEC_EVENTS].sort())
  })

  test("declares exactly the 06 §2.7 error names, internal_error on every method and never an rpc.* name", () => {
    expect([...new Set(methodNames.flatMap(errorsOf))].sort()).toEqual([...SPEC_ERRORS].sort())
    expect(Object.keys(OwnTeam.errors).sort()).toEqual([...SPEC_ERRORS].sort())
    for (const name of methodNames) {
      expect(errorsOf(name)).toContain("internal_error")
      expect(errorsOf(name).filter((error) => error.startsWith("rpc."))).toEqual([])
    }
  })

  test("every method can answer unsupported, so a build without a feature never throws", () => {
    for (const name of methodNames) expect(errorsOf(name)).toContain("unsupported")
  })

  test("every method can answer unavailable while the controller lock is held (RH-20, 06 §8.9)", () => {
    for (const name of methodNames) expect(errorsOf(name)).toContain("unavailable")
  })

  test("R4 and preset errors sit on the methods 06 §2.7 names", () => {
    for (const name of ["area.main", "area.preset", "team.account"] as const)
      expect(errorsOf(name)).toContain("same_company_subscription")
    expect(errorsOf("area.preset")).toContain("preset_wrong_group")
    expect(errorsOf("op.confirm")).toContain("nonce_invalid")
    expect(errorsOf("integration.push.execute")).toEqual(expect.arrayContaining(["nonce_invalid", "remote_rejected"]))
  })

  test("notice kinds are exactly the 06 §2.7 list", () => {
    expect<ReadonlyArray<string>>([...OwnTeam.NoticeKind.literals]).toEqual(SPEC_NOTICES)
  })

  test("every schema is portable (Standard Schema) and still an Effect schema", () => {
    for (const schema of definitionSchemas) {
      expect(Schema.isSchema(schema)).toBe(true)
      expect(typeof (schema as unknown as Standard)["~standard"].validate).toBe("function")
    }
    const portable: Rpc.PortableDefinition = Definition
    expect(portable.id).toBe(OwnTeam.ID)
  })

  test("is typed for handlers and clients", () => {
    const input: Rpc.Input<OwnTeam.Definition["methods"]["area.pause"]["input"]> = {
      teamID: TEAM,
      areaID: AREA,
      on: true,
    }
    const kind: Rpc.EventData<OwnTeam.Definition["events"]["notice"]["schema"]>["kind"] = "rotation.done"
    expect([input.on, kind]).toEqual([true, "rotation.done"])
  })

  test("schema identifiers are namespaced and unique", () => {
    const identifiers = Object.values(OwnTeam).flatMap((value) => {
      if (!Schema.isSchema(value)) return []
      const identifier = value.ast.annotations?.identifier
      return typeof identifier === "string" ? [identifier] : []
    })
    expect(identifiers.length).toBeGreaterThan(40)
    expect(identifiers.filter((identifier) => !identifier.startsWith("OwnTeam."))).toEqual([])
    expect(identifiers.filter((identifier, index) => identifiers.indexOf(identifier) !== index)).toEqual([])
  })
})

describe("routing (06 §2.7)", () => {
  test("every method has a scope and the control location; every event is global", () => {
    expect(Object.keys(OwnTeam.MethodScope).sort()).toEqual([...methodNames].sort())
    expect(Object.keys(OwnTeam.MethodLocation).sort()).toEqual([...methodNames].sort())
    expect(new Set(Object.values(OwnTeam.MethodLocation))).toEqual(new Set(["control"]))
    expect(Object.keys(OwnTeam.EventOrigin).sort()).toEqual([...eventNames].sort())
    expect(new Set(Object.values(OwnTeam.EventOrigin))).toEqual(new Set(["global"]))
  })

  test("scopes follow the 06 §2.7 table", () => {
    const byScope = (scope: OwnTeam.Scope) =>
      Object.entries(OwnTeam.MethodScope)
        .filter(([, value]) => value === scope)
        .map(([name]) => name)
        .sort()
    for (const [scope, names] of Object.entries(SPEC_SCOPES))
      expect({ scope, names: byScope(scope as OwnTeam.Scope) }).toEqual({ scope, names: [...names].sort() })
    const named = new Set(Object.values(SPEC_SCOPES).flat())
    expect(byScope("read")).toEqual(methodNames.filter((name) => !named.has(name)).sort())
  })

  test("the schema module re-exports the plain tables", () => {
    expect(OwnTeam.MethodScope).toBe(OwnTeamRouting.MethodScope)
    expect(OwnTeam.MethodLocation).toBe(OwnTeamRouting.MethodLocation)
    expect(OwnTeam.EventOrigin).toBe(OwnTeamRouting.EventOrigin)
  })

  test("rpc-team-routing.ts has no runtime import (no effect, no schema modules)", async () => {
    const source = await Bun.file(new URL("../src/rpc-team-routing.ts", import.meta.url)).text()
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source).map((entry) => entry.path)
    // Only its own namespace self-export remains once type-only imports are erased.
    expect(imports).toEqual(["./rpc-team-routing.js"])
    expect(source).toContain('import type { OwnTeam } from "./rpc-team.js"')
  })
})

describe("Portable round trip (06 TG1: rpc.invalid_output 0)", () => {
  const portable = Portable.definition(Definition)

  test("there is a sample for every method", () => {
    expect(Object.keys(samples).sort()).toEqual([...methodNames].sort())
  })

  test.each([...methodNames])("%s: input decodes and output encodes unchanged", (name) => {
    const sample = samples[name]
    const method = portable.methods[name]
    expect(Schema.isSchema(method.input)).toBe(false)
    expect(validate(method.input, sample.input)).toEqual({ value: sample.input })
    expect(validate(method.output, sample.output)).toEqual({ value: sample.output })
    expect(roundTrip(codec(Definition.methods[name].input), sample.input)).toEqual(sample.input)
    expect(roundTrip(codec(Definition.methods[name].output), sample.output)).toEqual(sample.output)
  })

  test("declared error data encodes unchanged", () => {
    for (const name of methodNames)
      for (const [error, schema] of Object.entries(portable.methods[name].errors))
        expect({ name, error, result: validate(schema, errorSamples[error as ErrorName]) }).toEqual({
          name,
          error,
          result: { value: errorSamples[error as ErrorName] },
        })
  })

  test("every event encodes unchanged with eventId and origin global", () => {
    expect(Object.keys(eventSamples).sort()).toEqual([...eventNames].sort())
    for (const name of eventNames) {
      const sample = eventSamples[name]
      expect({ name, result: validate(portable.events[name].schema, sample) }).toEqual({
        name,
        result: { value: sample },
      })
      expect(validate(portable.events[name].schema, { ...(sample as object), origin: "session" }).issues).toBeDefined()
      const { eventId: _, ...withoutId } = sample as { eventId: string }
      expect(validate(portable.events[name].schema, withoutId).issues).toBeDefined()
    }
  })

  test("other method shapes: the team.account start, reorg.apply by proposal id, a guard failure", () => {
    const account = portable.methods["team.account"]
    expect(validate(account.output, { opID: OP })).toEqual({ value: { opID: OP } })
    const apply = portable.methods["reorg.apply"]
    expect(validate(apply.input, { teamID: TEAM, proposalID: PROPOSAL })).toEqual({
      value: { teamID: TEAM, proposalID: PROPOSAL },
    })
    const unmanaged = { version: "2.0.18-own.6", buildId: "dev", guard: "unmanaged", features: [] }
    expect(validate(portable.methods.health.output, unmanaged)).toEqual({ value: unmanaged })
    expect(validate(portable.methods["area.main"].input, { teamID: TEAM, areaID: AREA, model: null })).toEqual({
      value: { teamID: TEAM, areaID: AREA, model: null },
    })
  })
})

describe("schemas (06 §2.4, §3.4)", () => {
  const input = (name: MethodName) => codec(Definition.methods[name].input)
  const rejects = (schema: Schema.Codec<unknown, unknown>, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()

  test("ids: tm_<12 hex>, ar_<slug>, dp_/op_/ig_/rp_<ulid>", () => {
    expect(Schema.is(OwnTeam.TeamID)(TEAM)).toBe(true)
    expect(Schema.is(OwnTeam.TeamID)("tm_0123456789AB")).toBe(false)
    expect(Schema.is(OwnTeam.TeamID)("tm_0123456789a")).toBe(false)
    expect(Schema.is(OwnTeam.AreaID)(AREA)).toBe(true)
    expect(Schema.is(OwnTeam.AreaID)("ar_-x")).toBe(false)
    expect(Schema.is(OwnTeam.AreaID)("ar_Inventory")).toBe(false)
    expect(Schema.is(OwnTeam.AreaID)(`ar_${"a".repeat(33)}`)).toBe(false)
    expect(Schema.is(OwnTeam.Slug)("inventory-ui")).toBe(true)
    for (const id of [OwnTeam.DispatchID, OwnTeam.OpID, OwnTeam.IntegrationID, OwnTeam.ProposalID]) {
      const created = id.create()
      expect(Schema.is(id)(created)).toBe(true)
      expect(Schema.is(id)(`${created.slice(0, 3)}01JB000000000000000000000I`)).toBe(false)
    }
    expect(OwnTeam.OpID.create()).toStartWith("op_")
    expect(Schema.is(OwnTeam.OpID)(DISPATCH)).toBe(false)
    expect(Schema.is(OwnTeam.Sha)(SHA.slice(1))).toBe(false)
  })

  test("Team.policy has the eight settings and no window, compaction, token or rotation values (U6)", () => {
    expect(Object.keys(OwnTeam.Policy.fields).sort()).toEqual(
      [
        "askDiskBytes",
        "askDownloadBytes",
        "autoAllow",
        "commitDecisions",
        "directHold",
        "directTell",
        "maxAreas",
        "mergeLocal",
      ].sort(),
    )
    expect(OwnTeam.POLICY).toEqual({
      maxAreas: 4,
      askDownloadBytes: 500 * 1024 ** 2,
      askDiskBytes: 2 * 1024 ** 3,
      mergeLocal: "auto",
      commitDecisions: false,
      autoAllow: true,
    })
    const names = [OwnTeam.Team, OwnTeam.TeamSettings, OwnTeam.SettingsPatch].flatMap((schema) =>
      propertyNames(schema.ast),
    )
    expect(names).toContain("autoAllow")
    expect(names.filter((name) => /token|window|compact|rotat/i.test(name))).toEqual([])
    rejects(codec(OwnTeam.Policy), { ...OwnTeam.POLICY, maxAreas: 7 })
    // No area limit (2026-11-14): `maxAreas` is no patch key, so an older client's patch decodes without it.
    expect(propertyNames(OwnTeam.SettingsPatch.ast)).not.toContain("maxAreas")
    expect(
      Schema.decodeUnknownSync(input("settings.set"))({ teamID: TEAM, patch: { policy: { maxAreas: 0 } } }),
    ).toEqual({ teamID: TEAM, patch: { policy: {} } })
  })

  test("no own.team input or output has a computer-use field", () => {
    const names = definitionSchemas.flatMap((schema) => propertyNames(astOf(schema)))
    // The walk reaches nested and optional fields.
    expect(names).toEqual(expect.arrayContaining(["worktreeRoot", "linkCopies", "manifest", "newerSkipped", "roles"]))
    expect(names.filter((name) => /computer/i.test(name))).toEqual([])
  })

  test("areas: Main 멈춤 values, area main and preset", () => {
    rejects(codec(OwnTeam.Paused), true)
    rejects(codec(OwnTeam.Area), { ...area, paused: "auto" })
    rejects(codec(OwnTeam.Area), { ...area, preset: "codex" })
    rejects(codec(OwnTeam.Area), { ...area, status: { ...area.status, kind: "working" } })
    expect(roundTrip(codec(OwnTeam.Area), adopted)).toEqual(adopted)
    expect(OwnTeam.StatusKind.literals).toEqual([
      "idle",
      "preparing",
      "busy",
      "asking",
      "blocked",
      "waiting-quota",
      "ready",
      "failed",
      "broken",
      "retired",
    ])
  })

  test("ops include team-account, rotate and paths; confirms carry nonce, expiry and optional manifest", () => {
    expect(OwnTeam.OpKind.literals).toEqual(expect.arrayContaining(["team-account", "rotate", "paths"]))
    expect(OwnTeam.StepMode.literals).toEqual(["auto", "confirm"])
    rejects(codec(OwnTeam.StepConfirm), { ...stepConfirm, nonce: "short" })
    expect(
      roundTrip(codec(OwnTeam.Confirm), {
        teamID: TEAM,
        opID: OP,
        stepID: "s1",
        kind: "cone-add",
        nonce: NONCE,
        expiresAt: 1,
        text: "",
      }),
    ).toEqual({
      teamID: TEAM,
      opID: OP,
      stepID: "s1",
      kind: "cone-add",
      nonce: NONCE,
      expiresAt: 1,
      text: "",
    })
  })

  test("proposals: the 06 §3.4 example decodes, items stay lenient for the V-rules", () => {
    expect(roundTrip(codec(OwnTeam.Proposal), proposal)).toEqual(proposal)
    // V6 and V12 fix or truncate instead of failing the decode.
    const loose = { version: 1, areas: [{ slug: "Bad Slug!", name: "x".repeat(300) }] }
    expect(roundTrip(codec(OwnTeam.Proposal), loose)).toEqual(loose)
    rejects(codec(OwnTeam.Proposal), { version: 2 })
    rejects(codec(OwnTeam.Proposal), { version: 1, ops: [{ op: "delete", area: "x" }] })
    rejects(codec(OwnTeam.Proposal), { version: 1, ops: [{ op: "convert", area: "x", shape: "plain" }] })
  })

  test("method input bounds", () => {
    rejects(input("area.paths"), {
      teamID: TEAM,
      areaID: AREA,
      // 64 since 2026-11-14 (was 8).
      add: Array.from({ length: OwnTeam.PATHS_MAX + 1 }, (_, index) => `d${index}`),
    })
    rejects(input("area.paths"), { teamID: TEAM, areaID: AREA, reason: "x".repeat(201) })
    rejects(input("decisions.add"), { teamID: TEAM, title: "", body: "" })
    rejects(input("op.confirm"), { opID: OP, stepID: "s1", choice: "maybe", nonce: NONCE })
    rejects(input("team.account"), { teamID: TEAM, target: REF, mode: "later" })
    rejects(input("area.pause"), { areaID: AREA, on: true })
  })

  test("message metadata keys and shapes (5.1, 5.6, 6.2)", () => {
    expect([OwnTeam.DISPATCH_META, OwnTeam.UPDATE_META, OwnTeam.SESSION_META]).toEqual([
      "own.dispatch",
      "own.team.update",
      "own.team",
    ])
    const meta = { id: DISPATCH, from: "team", teamID: TEAM, areaID: AREA, task: "정렬 버그" }
    expect(roundTrip(codec(OwnTeam.DispatchMeta), meta)).toEqual(meta)
    expect(roundTrip(codec(OwnTeam.UpdateMeta), { seq: 42, reasons: ["ready"] })).toEqual({
      seq: 42,
      reasons: ["ready"],
    })
    expect(roundTrip(codec(OwnTeam.SessionMeta), { role: "main", teamID: TEAM })).toEqual({
      role: "main",
      teamID: TEAM,
    })
    rejects(codec(OwnTeam.SessionMeta), { role: "child", teamID: TEAM })
  })
})

describe("T2 contract (06 §2.7, §7, §9.3): what the adopt, integrate and decision work builds on", () => {
  const portable = Portable.definition(Definition)
  /** Validates through the portable schema and round-trips through the Effect schema. */
  const passes = (schema: unknown, effect: unknown, value: unknown) => {
    expect(validate(schema, value)).toEqual({ value })
    expect(roundTrip(codec(effect), value)).toEqual(value)
  }
  const output = (name: MethodName, value: unknown) =>
    passes(portable.methods[name].output, Definition.methods[name].output, value)
  const input = (name: MethodName, value: unknown) =>
    passes(portable.methods[name].input, Definition.methods[name].input, value)
  const rejects = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()

  test("the heavy card line names the folders and their bytes (큰 파일 폴더 n개(size))", () => {
    const heavy = { kind: "heavy", dirs: ["Assets/Textures", "Assets/Audio", "Assets/Models"], bytes: 15_783_627_571 }
    output("op.get", { op: { ...op, summary: { lines: [{ kind: "area", areaID: AREA, change: "adopted" }, heavy] } } })
    passes(portable.events["op.done"].schema, Definition.events["op.done"].schema, {
      ...envelope,
      teamID: TEAM,
      opID: OP,
      state: "done",
      summary: { lines: [heavy] },
      undoable: true,
      pending: 0,
    })
    rejects(OwnTeam.SummaryLine, { ...heavy, bytes: -1 })
    rejects(OwnTeam.SummaryLine, { kind: "heavy", bytes: 1 })
    rejects(OwnTeam.SummaryLine, { ...heavy, dirs: [""] })
  })

  test("the push line carries the remote, the record name and the review request's page", () => {
    const pushed = { kind: "pushed", areaID: AREA, integrationID: INTEGRATION, remote: "origin", ref: "main" }
    for (const line of [pushed, { ...pushed, pr: "https://example.invalid/pr/7" }])
      output("op.get", { op: { ...undoOp, kind: "integrate", summary: { lines: [line] } } })
    rejects(OwnTeam.SummaryLine, { ...pushed, remote: "" })
  })

  const base = { id: INTEGRATION, teamID: TEAM, areaID: AREA, target: "main", source: SHA, createdAt: 12 }
  const merged = { ...base, base: SHA_2, candidate: SHA, how: "merge" }
  /** One integration per state of 06 §7 and §9.7 (진행, 기다림, 충돌, 실패, 끝, 되돌림). */
  const integrations = [
    { ...merged, state: "running", verify: {}, checks: { current: 1, total: 2 } },
    {
      ...merged,
      state: "waiting",
      verify: { code: { ok: true, ms: 134_000 }, assets: "skipped", cone: { ok: true, missing: [] } },
      waiting: { why: "dirty", directory: "D:/own-open-code", paths: ["src/a.ts", "src/b.ts"] },
    },
    {
      ...merged,
      state: "waiting",
      verify: {},
      waiting: { why: "outside", directory: "D:/#Projects/own-open-code" },
    },
    { ...base, base: SHA_2, state: "conflict", verify: {}, conflicts: ["src/inventory/sort.ts"] },
    { ...base, base: SHA_2, state: "failed", verify: {}, conflicts: ["src/inventory/sort.ts"], failure: "conflict" },
    {
      ...merged,
      state: "failed",
      verify: { code: { ok: false, ms: 5_000, failed: "bun run typecheck", log: "integrations/ig.log" } },
      failure: "verify",
    },
    { ...merged, state: "failed", verify: { cone: { ok: false, missing: ["tools"] } }, failure: "cone" },
    { ...merged, state: "failed", verify: { code: { ok: true, ms: 1 } }, failure: "moved" },
    { ...base, state: "failed", verify: {}, failure: "rewritten" },
    { ...base, base: SHA, state: "done", verify: {} },
    integration,
    {
      ...merged,
      state: "undone",
      verify: { code: { ok: true, ms: 1 }, assets: "skipped" },
      advanced: { how: "update-ref", at: 13 },
      undone: { at: 14, opID: OP_2 },
    },
  ]

  test("integrations in every state go through integration.get and integration.changed", () => {
    expect(new Set(integrations.map((item) => item.state))).toEqual(new Set(OwnTeam.IntegrationState.literals))
    for (const item of integrations) {
      output("integration.get", { integration: item })
      passes(portable.events["integration.changed"].schema, Definition.events["integration.changed"].schema, {
        ...envelope,
        teamID: TEAM,
        areaID: AREA,
        integrationID: INTEGRATION,
        state: item.state,
      })
    }
  })

  test("check progress counts from one, and failures are the 7.1–7.3 and 4.10 reasons", () => {
    expect(OwnTeam.IntegrationFailure.literals).toEqual([
      "verify",
      "assets",
      "cone",
      "conflict",
      "moved",
      "rewritten",
      "heavy",
      "broken",
      "error",
    ])
    const running = integrations[0]
    rejects(OwnTeam.Integration, { ...running, checks: { current: 0, total: 2 } })
    rejects(OwnTeam.Integration, { ...running, checks: { current: 1, total: 0 } })
    rejects(OwnTeam.Integration, { ...running, state: "failed", failure: "timeout" })
  })

  /** 06 §2.7: the scope and the declared errors besides internal_error and unsupported. */
  const T2_METHODS: ReadonlyArray<readonly [MethodName, OwnTeam.Scope, ReadonlyArray<ErrorName>]> = [
    ["area.adopt", "admin", ["not_found", "not_git", "team_off", "busy", "path_forbidden", "broken"]],
    ["area.unadopt", "admin", ["not_found", "team_off", "busy", "not_safe_point"]],
    ["area.integrate", "admin", ["not_found", "team_off", "busy", "broken", "dirty", "in_use"]],
    ["integration.get", "read", ["not_found"]],
    ["integration.undo", "admin", ["not_found", "team_off", "busy", "not_safe_point", "conflict", "in_use"]],
    ["integration.undo.cancel", "prompt", ["not_found", "team_off", "busy"]],
    ["integration.push.plan", "local", ["not_found", "team_off", "lfs_missing"]],
    ["integration.push.execute", "local", ["nonce_invalid", "busy", "lfs_missing", "remote_rejected"]],
    ["decisions.list", "read", ["not_found"]],
    ["decisions.add", "prompt", ["not_found", "team_off"]],
  ]

  test("the T2 methods keep their scope, the control location and their declared errors", () => {
    for (const [name, scope, errors] of T2_METHODS) {
      expect({ name, scope: OwnTeam.MethodScope[name], location: OwnTeam.MethodLocation[name] }).toEqual({
        name,
        scope,
        location: "control",
      })
      expect({ name, errors: [...errorsOf(name)].sort() }).toEqual({
        name,
        errors: [...errors, "internal_error", "unsupported", "unavailable"].sort(),
      })
    }
  })

  test("adopt, integrate, push and decision inputs and outputs round-trip", () => {
    input("area.adopt", { teamID: TEAM, directory: "D:/own-open-code/.worktrees/cl-cu" })
    output("area.adopt", { opID: OP })
    input("area.unadopt", { teamID: TEAM, areaID: AREA })
    input("area.integrate", { teamID: TEAM, areaID: AREA })
    output("area.integrate", { opID: OP, integrationID: INTEGRATION })
    input("integration.undo", { integrationID: INTEGRATION })
    output("integration.undo", { opID: OP_2 })
    input("integration.undo.cancel", { integrationID: INTEGRATION })
    expect(OwnTeam.Feature.literals).toContain("undo-cancel")
    input("integration.push.plan", { integrationID: INTEGRATION })
    output("integration.push.plan", {
      nonce: NONCE,
      expiresAt: 1_790_000_600_000,
      remote: "origin",
      ref: "inventory-ui",
      commands: ["git push origin main", "gh pr create --base main --head inventory-ui"],
    })
    input("integration.push.execute", { nonce: NONCE })
    output("integration.push.execute", { opID: OP })
    input("decisions.add", { teamID: TEAM, title: "필드 이름은 snake_case", body: "" })
    output("decisions.add", { number: 4, file: "decisions/0004-field-names.md" })
    output("decisions.list", {
      items: [
        { number: 1, title: "결제 API", file: "decisions/0001-payments-api.md", at: 15, source: "main", areas: [AREA] },
        { number: 2, title: "필드 이름", file: "decisions/0002-field-names.md", at: 16, source: "user", areas: [] },
      ],
    })
    rejects(Definition.methods["decisions.add"].input, { teamID: TEAM, title: "x".repeat(201), body: "" })
    rejects(Definition.methods["integration.push.execute"].input, { nonce: "short" })
  })

  test("the T2 notices travel as events and stay open in team.get", () => {
    const notices = [
      { kind: "folder.followed", data: { from: "D:/old/cl-cu", directory: "D:/new/cl-cu" } },
      { kind: "integration.waiting", data: { why: "outside", folder: "own-open-code" } },
      { kind: "undo.kept", data: { sha: SHA } },
    ]
    for (const notice of notices)
      passes(portable.events.notice.schema, Definition.events.notice.schema, {
        ...envelope,
        teamID: TEAM,
        areaID: AREA,
        text: "server text",
        ...notice,
      })
    output("team.get", {
      team,
      areas: [area],
      waiting: {},
      op: null,
      pending: [],
      notices: [{ id: "n1", at: 17, areaID: AREA, kind: "integration.waiting", text: "x", data: { folder: "own" } }],
    })
  })
})

describe("T3 contract (06 §2.4, §4.10, §8.1): the additive fields reorganization and the .assets check build on", () => {
  const portable = Portable.definition(Definition)
  const output = (name: MethodName, value: unknown) => {
    expect(validate(portable.methods[name].output, value)).toEqual({ value })
    expect(roundTrip(codec(Definition.methods[name].output), value)).toEqual(value)
  }
  const rejects = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()
  const got = (areas: ReadonlyArray<unknown>) => ({ team, areas, waiting: {}, op: null, pending: [] })

  test("an area view may carry the retire signal (끝낼 수 있음); the stored area never does", () => {
    const retirable = { ...area, retirable: { since: 1_790_000_000_000 } }
    output("team.get", got([retirable, adopted]))
    output("team.get", got([area, adopted]))
    output("area.pause", { area: retirable })
    output("area.main", { area: retirable, opID: OP })
    expect(OwnTeam.AreaView.fields).toHaveProperty("retirable")
    expect(OwnTeam.Area.fields).not.toHaveProperty("retirable")
    rejects(OwnTeam.AreaView, { ...area, retirable: {} })
    rejects(OwnTeam.AreaView, { ...area, retirable: { since: -1 } })
  })

  test("a candidate may ask for an engine run (4.10); T2 records without it still decode", () => {
    const asks = { ...area, candidate: { ...area.candidate, assets: true } }
    expect(roundTrip(codec(OwnTeam.Area), asks)).toEqual(asks)
    expect(roundTrip(codec(OwnTeam.Area), area)).toEqual(area)
    expect(Schema.decodeUnknownSync(OwnTeam.Area)(area).candidate?.assets).toBeUndefined()
    output("team.get", got([asks]))
    rejects(OwnTeam.Area, { ...area, candidate: { ...area.candidate, assets: "yes" } })
  })

  test("the .assets result is skipped, a T2 verify result, or the check with K, its hold ref and keep refs", () => {
    const checked = {
      ok: true,
      ms: 61_000,
      log: "integrations/ig.log",
      sha: SHA,
      heldRef: `refs/own/hold/assets/${OP}`,
      keptRefs: [`refs/own/keep/${SHA_2}`],
    }
    const failed = { ok: false, ms: 5_000, failed: "make assets", sha: SHA_2, keptRefs: [] }
    for (const assets of ["skipped", { ok: true, ms: 1 }, checked, failed])
      output("integration.get", { integration: { ...integration, verify: { ...integration.verify, assets } } })
    output("integration.get", {
      integration: { ...integration, state: "failed", verify: { assets: failed }, failure: "assets" },
    })
    rejects(OwnTeam.Integration, { ...integration, verify: { assets: { ...checked, sha: "nope" } } })
    rejects(OwnTeam.Integration, { ...integration, verify: { assets: { ...checked, heldRef: "" } } })
    rejects(OwnTeam.Integration, { ...integration, verify: { assets: { ...checked, keptRefs: [""] } } })
    rejects(OwnTeam.Integration, { ...integration, verify: { assets: "later" } })
    // The code check keeps the plain verify result.
    expect(Object.keys(OwnTeam.VerifyResult.fields).sort()).toEqual(["failed", "log", "ms", "ok"])
  })

  test("the T3 work answers through the T2 surface (later additions are in the SPEC lists)", () => {
    expect<ReadonlyArray<string>>([...methodNames].sort()).toEqual([...SPEC_METHODS].sort())
    expect<ReadonlyArray<string>>([...eventNames].sort()).toEqual([...SPEC_EVENTS].sort())
    expect(Object.keys(OwnTeam.errors).sort()).toEqual([...SPEC_ERRORS].sort())
    for (const name of ["op.confirm", "integration.push.plan", "integration.push.execute", "settings.set"] as const)
      expect(OwnTeam.MethodScope[name]).toBe("local")
    expect(errorSamples.lfs_missing).toEqual({ tool: "git-lfs", version: null })
  })
})

describe("area peers (동료, 2026-10-09, 06 §1.2, §2.4, §2.7)", () => {
  const portable = Portable.definition(Definition)
  const reject = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()

  test("an area without peers is a record of before; a peer has a slug key, a label and a role of at most 1 KB", () => {
    const { peers: _peers, ...before } = area
    expect(roundTrip(codec(OwnTeam.Area), before)).toEqual(before)
    expect(roundTrip(codec(OwnTeam.Area), area)).toEqual(area)
    expect(roundTrip(codec(OwnTeam.Peer), peer)).toEqual(peer)
    reject(OwnTeam.Peer, { ...peer, key: "Reviewer" })
    reject(OwnTeam.Peer, { ...peer, label: "" })
    reject(OwnTeam.Peer, { ...peer, label: "가".repeat(OwnTeam.PEER_LABEL_MAX + 1) })
    reject(OwnTeam.Peer, { ...peer, role: "x".repeat(OwnTeam.PEER_ROLE_MAX + 1) })
    // Characters, not UTF-8 bytes (2026-11-14): 1,024 Hangul fit.
    const hangul = { ...peer, role: "가".repeat(OwnTeam.PEER_ROLE_MAX) }
    expect(roundTrip(codec(OwnTeam.Peer), hangul)).toEqual(hangul)
    reject(OwnTeam.Peer, { ...peer, origin: "adopted" })
  })

  test("a main request and its metadata may name the peer it goes to; the owner's have no `to`", () => {
    const to = { ...dispatch, fresh: undefined, to: "reviewer" }
    const { fresh: _fresh, ...plain } = to
    expect(roundTrip(codec(OwnTeam.Dispatch), plain)).toEqual(plain)
    expect(roundTrip(codec(OwnTeam.Dispatch), dispatch)).toEqual(dispatch)
    const meta = { id: DISPATCH, from: "main", teamID: TEAM, areaID: AREA, to: "reviewer" }
    expect(roundTrip(codec(OwnTeam.DispatchMeta), meta)).toEqual(meta)
    reject(OwnTeam.DispatchMeta, { ...meta, to: "Not A Slug" })
    expect(roundTrip(codec(OwnTeam.SessionMeta), { role: "peer", teamID: TEAM, areaID: AREA })).toEqual({
      role: "peer",
      teamID: TEAM,
      areaID: AREA,
    })
  })

  test("the peer methods are admin on the control location with their declared errors", () => {
    const declared = {
      "area.peer.add": ["not_found", "team_off", "broken", "same_company_subscription", "peer_invalid"],
      "area.peer.edit": ["not_found", "team_off", "peer_invalid"],
      "area.peer.remove": ["not_found", "team_off"],
    } as const
    for (const [name, errors] of Object.entries(declared) as Array<[MethodName, ReadonlyArray<ErrorName>]>) {
      expect({ name, scope: OwnTeam.MethodScope[name], location: OwnTeam.MethodLocation[name] }).toEqual({
        name,
        scope: "admin",
        location: "control",
      })
      expect([...errorsOf(name)].sort()).toEqual([...errors, "internal_error", "unsupported", "unavailable"].sort())
    }
    expect(OwnTeam.Feature.literals).toContain("peers")
  })

  test("`area.peer.add` takes an existing conversation with a label and role, or a new one to create", () => {
    const add = portable.methods["area.peer.add"].input
    const existing = { teamID: TEAM, areaID: AREA, sessionID: SESSION, label: "리뷰어", role: "읽고 짚는다" }
    expect(validate(add, existing)).toEqual({ value: existing })
    expect(validate(add, { teamID: TEAM, areaID: AREA, sessionID: SESSION }).issues).toBeDefined()
    expect(validate(add, { teamID: TEAM, areaID: AREA, create: { label: "", role: "" } }).issues).toBeDefined()
    const edit = portable.methods["area.peer.edit"].input
    expect(validate(edit, { teamID: TEAM, areaID: AREA, key: "sim" })).toEqual({
      value: { teamID: TEAM, areaID: AREA, key: "sim" },
    })
    expect(validate(edit, { teamID: TEAM, areaID: AREA, key: "sim", label: "" }).issues).toBeDefined()
  })
})

describe("사용자가 정하는 영역 (2026-10-26, 06 §2.4, §2.7)", () => {
  const portable = Portable.definition(Definition)
  const reject = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()
  const refuse = (schema: unknown, value: unknown) => expect(validate(schema, value).issues).toBeDefined()

  test("an area without the mark is a record of before; the mark is the time the user set it up", () => {
    expect(roundTrip(codec(OwnTeam.Area), area)).toEqual(area)
    const made = { ...area, userMade: { at: 1_790_000_000_000 } }
    expect(roundTrip(codec(OwnTeam.Area), made)).toEqual(made)
    expect(roundTrip(codec(OwnTeam.AreaView), made)).toEqual(made)
    reject(OwnTeam.Area, { ...area, userMade: true })
  })

  test("a new area may carry its model, its 에이전트 방식 and the mark; an adopt row the mark", () => {
    const op = {
      op: "new",
      slug: "monster-assets",
      name: "몬스터 에셋",
      goal: "몬스터 그림",
      from: "main",
      main: REF,
      harness: { id: "codex", prompt: "own" },
      userMade: true,
    }
    expect(roundTrip(codec(OwnTeam.ReorgOp), op)).toEqual(op)
    const { main: _main, harness: _harness, userMade: _made, ...plain } = op
    expect(roundTrip(codec(OwnTeam.ReorgOp), plain)).toEqual(plain)
    reject(OwnTeam.ReorgOp, { ...op, harness: { id: "nope", prompt: "own" } })
    reject(OwnTeam.ReorgOp, { ...op, userMade: false })
    const row = { slug: "x", name: "x", adopt: { worktree: "D:/w/x" }, userMade: true }
    expect(roundTrip(codec(OwnTeam.ProposalArea), row)).toEqual(row)
    expect(OwnTeam.Harness.fields.id.literals).toEqual(OwnHarnessRouting.IDS)
  })

  test("area.edit is admin on the control location; the role text is bounded, the mark a boolean", () => {
    expect({ scope: OwnTeam.MethodScope["area.edit"], location: OwnTeam.MethodLocation["area.edit"] }).toEqual({
      scope: "admin",
      location: "control",
    })
    expect([...errorsOf("area.edit")].sort()).toEqual(
      ["not_found", "team_off", "broken", "seat_invalid", "internal_error", "unsupported", "unavailable"].sort(),
    )
    const edit = portable.methods["area.edit"].input
    expect(validate(edit, { teamID: TEAM, areaID: AREA, userMade: false })).toEqual({
      value: { teamID: TEAM, areaID: AREA, userMade: false },
    })
    refuse(edit, { teamID: TEAM, areaID: AREA, goal: "x".repeat(1_001) })
    refuse(edit, { teamID: TEAM, areaID: AREA, userMade: "yes" })
    expect(OwnTeam.Feature.literals).toContain("area-edit")
  })

  test("area.create.check (2026-10-27) is admin on the control location: a V6 slug in, the real name and folder out", () => {
    expect({
      scope: OwnTeam.MethodScope["area.create.check"],
      location: OwnTeam.MethodLocation["area.create.check"],
    }).toEqual({ scope: "admin", location: "control" })
    expect([...errorsOf("area.create.check")].sort()).toEqual(
      [
        "not_found",
        "team_off",
        "not_git",
        "path_forbidden",
        "invalid_proposal",
        "internal_error",
        "unsupported",
        "unavailable",
      ].sort(),
    )
    const check = portable.methods["area.create.check"]
    expect(validate(check.input, { teamID: TEAM, slug: "monster-assets" })).toEqual({
      value: { teamID: TEAM, slug: "monster-assets" },
    })
    refuse(check.input, { teamID: TEAM, slug: "Monster Assets" })
    expect(validate(check.output, { slug: "x-2", directory: "D:/q/.worktrees/x-2" })).toEqual({
      value: { slug: "x-2", directory: "D:/q/.worktrees/x-2" },
    })
    refuse(check.output, { slug: "x", directory: "D:/q/x", taken: "session" })
  })

  test("enable may say where a new team keeps its area folders (06 §4.12, 2026-10-27); absent is as before", () => {
    const enable = portable.methods.enable.input
    for (const areaRoot of ["inside", "beside"])
      expect(validate(enable, { directory: "D:/quest", areaRoot })).toEqual({
        value: { directory: "D:/quest", areaRoot },
      })
    expect(validate(enable, { directory: "D:/quest" })).toEqual({ value: { directory: "D:/quest" } })
    refuse(enable, { directory: "D:/quest", areaRoot: "elsewhere" })
    expect(OwnTeam.AreaRoot.literals).toEqual(["inside", "beside"])
  })

  test("reorg.apply runs the chosen items of a stored proposal by id (2026-10-27); a bare id and a proposal as before", () => {
    const apply = portable.methods["reorg.apply"].input
    const chosen = { teamID: TEAM, proposalID: PROPOSAL, items: ["ops/0", "areas/12"] }
    expect(validate(apply, chosen)).toEqual({ value: chosen })
    expect(roundTrip(codec(Definition.methods["reorg.apply"].input), chosen)).toEqual(chosen)
    expect(validate(apply, { teamID: TEAM, proposalID: PROPOSAL, items: [] })).toEqual({
      value: { teamID: TEAM, proposalID: PROPOSAL, items: [] },
    })
    for (const item of ["ops/01", "suggest/0", "ops/-1", "ops", "areas/1/needs/0", "ops/10000"])
      refuse(apply, { teamID: TEAM, proposalID: PROPOSAL, items: [item] })
    refuse(apply, { teamID: TEAM, proposalID: PROPOSAL, items: Array.from({ length: 257 }, () => "ops/0") })
    expect(validate(apply, { teamID: TEAM, proposalID: PROPOSAL })).toEqual({
      value: { teamID: TEAM, proposalID: PROPOSAL },
    })
    const own = { teamID: TEAM, proposal: { version: 1, ops: [{ op: "new", slug: "x", name: "x", userMade: true }] } }
    expect(validate(apply, own)).toEqual({ value: own })
  })
})

describe("Git 저장소로 만들기 (2026-10-11, 06 §3.0)", () => {
  const portable = Portable.definition(Definition)
  const reject = (schema: unknown, value: unknown) => expect(validate(schema, value).issues).toBeDefined()

  test("both methods are local (never a gateway device) on the control location with their declared errors", () => {
    const declared = {
      "project.gitInit.plan": ["not_found", "git_too_old", "git_init_refused"],
      "project.gitInit": ["not_found", "git_too_old", "git_init_refused", "identity_missing", "git_failed"],
    } as const
    for (const [name, errors] of Object.entries(declared) as Array<[MethodName, ReadonlyArray<ErrorName>]>) {
      expect({ name, scope: OwnTeam.MethodScope[name], location: OwnTeam.MethodLocation[name] }).toEqual({
        name,
        scope: "local",
        location: "control",
      })
      expect([...errorsOf(name)].sort()).toEqual([...errors, "internal_error", "unsupported", "unavailable"].sort())
    }
    expect(OwnTeam.Feature.literals).toContain("git-init")
  })

  test("init without a first commit; an identity line is one non-empty line", () => {
    const init = portable.methods["project.gitInit"].input
    expect(validate(init, { directory: "D:/x" })).toEqual({ value: { directory: "D:/x" } })
    const commit = (identity: unknown) => ({
      directory: "D:/x",
      firstCommit: { gitignore: false, include: [], identity },
    })
    reject(init, commit({ name: "a\nb", email: "e@x" }))
    reject(init, commit({ name: " ", email: "e@x" }))
    reject(init, commit({ name: "a", email: "" }))
    expect(validate(init, commit({ name: "나 데겐", email: "e@x" })).issues).toBeUndefined()
  })

  test("a folder with too many files has no listing; not_git may say the repository has no commit yet", () => {
    const plan = portable.methods["project.gitInit.plan"].output
    const many = {
      ...(samples["project.gitInit.plan"].output as object),
      files: { kind: "too_many", count: 120_000, limit: 20_000 },
    }
    expect(validate(plan, many)).toEqual({ value: many })
    expect(validate(OwnTeam.errors.not_git, { directory: "D:/x", unborn: true })).toEqual({
      value: { directory: "D:/x", unborn: true },
    })
  })
})

describe("area messages (영역 메시지, 06 §5.8, 2026-10-16)", () => {
  const reject = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()
  const sender = { areaID: AREA_2, area: "세이브 v3" }
  const peerSender = { ...sender, peer: { key: "reviewer", label: "리뷰어" } }
  const ASK = "dp_01JB0000000000000000000005"
  const NOTE = "an_01JB0000000000000000000006"

  test("an ask, a reply and a notice round-trip as records and metadata; a main request decodes as before", () => {
    const { fresh: _fresh, movedFrom: _moved, ...base } = dispatch
    const ask = { ...base, id: ASK, from: "area", kind: "ask", sender }
    const reply = { ...base, from: "area", kind: "reply", sender: peerSender, replyTo: ASK, notes: [NOTE] }
    const notice = { ...base, from: "team", kind: "notice" }
    for (const value of [ask, reply, notice, dispatch]) expect(roundTrip(codec(OwnTeam.Dispatch), value)).toEqual(value)
    // A program request names when its integration or op started (2026-11-15).
    const conflict = { ...base, from: "team", kind: "conflict", origin: 8 }
    expect(roundTrip(codec(OwnTeam.Dispatch), conflict)).toEqual(conflict)
    const meta = { id: DISPATCH, from: "area", teamID: TEAM, areaID: AREA, kind: "reply", sender, replyTo: ASK }
    expect(roundTrip(codec(OwnTeam.DispatchMeta), meta)).toEqual(meta)
    const main = { id: DISPATCH, from: "main", teamID: TEAM, areaID: AREA }
    expect(roundTrip(codec(OwnTeam.DispatchMeta), main)).toEqual(main)
    reject(OwnTeam.Sender, { ...sender, peer: { key: "Not A Slug", label: "x" } })
    reject(OwnTeam.Dispatch, { ...ask, kind: "chat" })
    reject(OwnTeam.Dispatch, { ...ask, notes: ["nt_x"] })
  })

  test("a note round-trips and its id has the an_ prefix", () => {
    const note = { id: NOTE, areaID: AREA, to: "reviewer", sender, text: "ItemStack.count를 그대로 둡니다", at: 12 }
    expect(roundTrip(codec(OwnTeam.AreaNote), note)).toEqual(note)
    expect(String(OwnTeam.AreaNoteID.create())).toMatch(/^an_[0-9A-HJKMNP-TV-Z]{26}$/)
    reject(OwnTeam.AreaNote, { ...note, id: "dp_01JB0000000000000000000006" })
  })

  test("outbox.list may carry the held notes; an older service's answer without them still decodes", () => {
    const output = Portable.definition(Definition).methods["outbox.list"].output
    const without = { items: [dispatch] }
    expect(validate(output, without)).toEqual({ value: without })
    const note = { id: NOTE, areaID: AREA, sender, text: "쪽지", at: 12 }
    const held = { items: [], notes: [note] }
    expect(validate(output, held)).toEqual({ value: held })
  })
})

describe("team-mode convenience (2026-10-16, 06 §8.1)", () => {
  const plan = { steps: [{ item: "ops/0", kind: "split-begin", mode: "auto" }], rejected: [] }

  test("a plan without skips decodes as before; one with skips round-trips and keeps only waiting reasons", () => {
    expect(roundTrip(codec(OwnTeam.Plan), plan)).toEqual(plan)
    const skipped = { ...plan, skipped: [{ item: "ops/1", areaID: AREA, why: "paused" }] }
    expect(roundTrip(codec(OwnTeam.Plan), skipped)).toEqual(skipped)
    expect(() =>
      Schema.decodeUnknownSync(codec(OwnTeam.Plan))({
        ...plan,
        skipped: [{ item: "ops/1", areaID: AREA, why: "invalid" }],
      }),
    ).toThrow()
  })

  test("a skipped card line may carry the op it skipped; one without it decodes as before", () => {
    const line = { kind: "skipped", item: "ops/0", areaID: AREA, why: "busy" }
    expect(roundTrip(codec(OwnTeam.SummaryLine), line)).toEqual(line)
    const withOp = { ...line, op: { op: "split", area: "api", slug: "api-two", name: "둘" } }
    expect(roundTrip(codec(OwnTeam.SummaryLine), withOp)).toEqual(withOp)
  })

  test("the idle word is 쉬는 중 for areas and peers alike (03 §14)", () => {
    expect(OwnTeamText.WORDS.idle).toBe("쉬는 중")
    expect(OwnTeamText.PEER_WORDS.idle).toBe("쉬는 중")
  })
})

describe("담당 대화 바꾸기 (2026-11-12): the owner seat moves onto an existing conversation", () => {
  const portable = Portable.definition(Definition)
  const reject = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()

  test("an owner of before decodes as it was; a moved seat keeps who left it, who is still to strip and its note", () => {
    expect(roundTrip(codec(OwnTeam.Owner), area.owner)).toEqual(area.owner)
    const moved = {
      sessionID: SESSION,
      previous: [
        { sessionID: SESSION_2, endedAt: 3, why: "fresh" },
        { sessionID: SESSION_2, endedAt: 9, why: "seat" },
      ],
      attached: true,
      release: [SESSION_2],
      note: "저장 형식을 맡는다",
    }
    expect(roundTrip(codec(OwnTeam.Owner), moved)).toEqual(moved)
    expect(roundTrip(codec(OwnTeam.Area), { ...area, owner: moved })).toEqual({ ...area, owner: moved })
    reject(OwnTeam.Owner, { ...moved, previous: [{ sessionID: SESSION_2, endedAt: 9, why: "moved" }] })
    reject(OwnTeam.Owner, { ...moved, release: ["not a session"] })
  })

  test("a rotation never has the reason seat; an ended owner has every rotation reason and seat", () => {
    expect<ReadonlyArray<string>>(OwnTeam.RotationReason.literals).not.toContain("seat")
    expect<ReadonlyArray<string>>(OwnTeam.OwnerEnded.literals).toEqual([...OwnTeam.RotationReason.literals, "seat"])
  })

  test("area.seat is admin on the control location, takes the conversation and starts an op", () => {
    expect({ scope: OwnTeam.MethodScope["area.seat"], location: OwnTeam.MethodLocation["area.seat"] }).toEqual({
      scope: "admin",
      location: "control",
    })
    expect([...errorsOf("area.seat")].sort()).toEqual(
      [
        "not_found",
        "team_off",
        "busy",
        "broken",
        "same_company_subscription",
        "seat_invalid",
        "internal_error",
        "unsupported",
        "unavailable",
      ].sort(),
    )
    const seat = portable.methods["area.seat"]
    expect(validate(seat.input, { teamID: TEAM, areaID: AREA }).issues).toBeDefined()
    expect(validate(seat.input, { teamID: TEAM, areaID: AREA, sessionID: "nope" }).issues).toBeDefined()
    expect(validate(seat.output, { opID: OP })).toEqual({ value: { opID: OP } })
    for (const why of ["child", "main", "owner", "elsewhere", "account", "unknown", "note"])
      expect(validate(seat.errors.seat_invalid, { why })).toEqual({ value: { why } })
    expect(validate(seat.errors.seat_invalid, { why: "peer" }).issues).toBeDefined()
    // A conversation that was an owner before is refused as a peer under a reason of its own.
    expect(validate(portable.methods["area.peer.add"].errors.peer_invalid, { why: "previous" })).toEqual({
      value: { why: "previous" },
    })
  })

  test("the op kind, the card line, the notice and the features are declared", () => {
    expect<ReadonlyArray<string>>(OwnTeam.OpKind.literals).toContain("seat")
    const line = { kind: "area", areaID: AREA, change: "seated" }
    expect(roundTrip(codec(OwnTeam.SummaryLine), line)).toEqual(line)
    expect<ReadonlyArray<string>>(OwnTeam.NoticeKind.literals).toContain("seat.moved")
    expect<ReadonlyArray<string>>(OwnTeam.Feature.literals).toEqual(expect.arrayContaining(["seat", "owner-note"]))
    const notice = { id: "n1", at: 1, areaID: AREA, kind: "seat.moved", text: "x", data: { sessionID: SESSION } }
    expect(roundTrip(codec(OwnTeam.OpenNotice), notice)).toEqual(notice)
  })

  test("area.edit takes the owner note; a note of before has no sender mark and a team note has one", () => {
    const edit = portable.methods["area.edit"].input
    for (const note of ["저장 형식을 맡는다", ""])
      expect(validate(edit, { teamID: TEAM, areaID: AREA, note })).toEqual({
        value: { teamID: TEAM, areaID: AREA, note },
      })
    expect(validate(edit, { teamID: TEAM, areaID: AREA, note: 1 }).issues).toBeDefined()
    const sender = { areaID: AREA, area: "인벤토리 화면" }
    const before = { id: "an_01JB0000000000000000000006", areaID: AREA, sender, text: "쪽지", at: 12 }
    expect(roundTrip(codec(OwnTeam.AreaNote), before)).toEqual(before)
    const fromTeam = { ...before, from: "team" }
    expect(roundTrip(codec(OwnTeam.AreaNote), fromTeam)).toEqual(fromTeam)
    reject(OwnTeam.AreaNote, { ...before, from: "main" })
    expect(OwnTeamText.noteFrom(before)).toBe("인벤토리 화면")
    expect(OwnTeamText.noteFrom({ sender, from: "team" })).toBe("팀")
  })
})

describe("direct work, team instructions and caps (2.2.6-own.3, 2026-11-14)", () => {
  const portable = Portable.definition(Definition)
  const reject = (schema: unknown, value: unknown) =>
    expect(() => Schema.decodeUnknownSync(codec(schema))(value)).toThrow()
  const takes = (method: MethodName, value: unknown) =>
    validate(portable.methods[method].input, value).issues === undefined

  test("the features are declared", () => {
    expect<ReadonlyArray<string>>(OwnTeam.Feature.literals).toEqual(expect.arrayContaining(["direct", "instructions"]))
  })

  test("an area with or without direct work decodes; a wait may say it is direct work", () => {
    const held = { ...area, directWork: { since: 10, at: 12 } }
    expect(roundTrip(codec(OwnTeam.Area), held)).toEqual(held)
    expect(roundTrip(codec(OwnTeam.Area), area)).toEqual(area)
    reject(OwnTeam.Area, { ...area, directWork: { since: 10 } })
    const cause = { direct: true }
    expect(roundTrip(codec(OwnTeam.WaitCause), cause)).toEqual(cause)
    expect(roundTrip(codec(OwnTeam.WaitCause), {})).toEqual({})
  })

  test("the hold and tell settings are optional; an unknown tell value still decodes, but a patch writes only the three", () => {
    expect(OwnTeam.POLICY).not.toHaveProperty("directHold")
    expect(OwnTeam.POLICY).not.toHaveProperty("directTell")
    const set = { ...team, policy: { ...OwnTeam.POLICY, directHold: false, directTell: "always" } }
    expect(roundTrip(codec(OwnTeam.Team), set)).toEqual(set)
    const later = { ...team, policy: { ...OwnTeam.POLICY, directTell: "sometimes" } }
    expect(roundTrip(codec(OwnTeam.Team), later)).toEqual(later)
    expect(OwnTeam.DirectTell.literals).toEqual(["none", "judge", "always"])
    for (const directTell of OwnTeam.DirectTell.literals)
      expect(takes("settings.set", { teamID: TEAM, patch: { policy: { directTell, directHold: true } } })).toBe(true)
    expect(takes("settings.set", { teamID: TEAM, patch: { policy: { directTell: "sometimes" } } })).toBe(false)
    expect(takes("settings.set", { teamID: TEAM, patch: { policy: { directHold: "yes" } } })).toBe(false)
  })

  test("team instructions: null resets a role, 2,000 characters fit and 2,001 do not, breaker lines are refused", () => {
    const patch = (instructions: unknown) => ({ teamID: TEAM, patch: { instructions } })
    for (const role of ["main", "owner", "peer"]) {
      expect(takes("settings.set", patch({ [role]: null }))).toBe(true)
      expect(takes("settings.set", patch({ [role]: "" }))).toBe(true)
      expect(takes("settings.set", patch({ [role]: "x".repeat(OwnTeam.INSTRUCTIONS_MAX) }))).toBe(true)
      expect(takes("settings.set", patch({ [role]: "x".repeat(OwnTeam.INSTRUCTIONS_MAX + 1) }))).toBe(false)
    }
    expect(OwnTeam.INSTRUCTIONS_MAX).toBe(2_000)
    expect(takes("settings.set", patch({ main: "- 작은 일은 직접 한다.\n- 큰 일은 나눈다." }))).toBe(true)
    for (const breaker of OwnTeam.INSTRUCTION_BREAKERS) {
      expect(takes("settings.set", patch({ owner: `${breaker}x` })), breaker).toBe(false)
      expect(takes("settings.set", patch({ owner: `- 일하는 방식\n${breaker}x` })), breaker).toBe(false)
      expect(takes("settings.set", patch({ owner: `- 일하는 방식\r\n${breaker}x` })), breaker).toBe(false)
      // Inside a line it is text.
      expect(takes("settings.set", patch({ owner: `- 이 줄의 ${breaker}는 글이다` })), breaker).toBe(true)
    }
    const role = { program: "# 팀 메인 역할", guard: "- 아래는 일하는 방식이다.", standard: "- 기본" }
    const settings = {
      policy: OwnTeam.POLICY,
      commands: team.commands,
      patterns: [],
      instructions: { limit: 2_000, main: role, owner: { ...role, custom: "- 내 방식" }, peer: role },
    }
    expect(roundTrip(codec(OwnTeam.TeamSettings), settings)).toEqual(settings)
    const { instructions: _instructions, ...older } = settings
    expect(roundTrip(codec(OwnTeam.TeamSettings), older)).toEqual(older)
  })

  test("caps: 64 large-file folders a call, a role of 1,000 characters, a note and a peer role of 1,024", () => {
    const ids = { teamID: TEAM, areaID: AREA }
    const dirs = (n: number) => Array.from({ length: n }, (_, index) => `Assets/Dir${index}`)
    expect(OwnTeam.PATHS_MAX).toBe(64)
    expect(takes("area.paths", { ...ids, add: dirs(OwnTeam.PATHS_MAX) })).toBe(true)
    expect(takes("area.paths", { ...ids, add: dirs(OwnTeam.PATHS_MAX + 1) })).toBe(false)
    expect(takes("area.paths", { ...ids, release: dirs(OwnTeam.PATHS_MAX) })).toBe(true)
    expect(takes("area.paths", { ...ids, release: dirs(OwnTeam.PATHS_MAX + 1) })).toBe(false)
    expect(takes("area.edit", { ...ids, goal: "가".repeat(1_000) })).toBe(true)
    expect(takes("area.edit", { ...ids, goal: "가".repeat(1_001) })).toBe(false)
    expect(OwnTeam.PEER_ROLE_MAX).toBe(1_024)
    expect(OwnTeam.OWNER_NOTE_MAX).toBe(1_024)
  })
})
