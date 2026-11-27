import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Rpc } from "@opencode/schema/rpc"
import { OwnImport } from "../src/index.js"
import { Portable } from "../src/portable.js"
import { OwnImportRouting } from "../src/rpc-import-routing.js"
import { CODEX_ACCOUNT, roundTrip, SESSION, SESSION_2 } from "./fixtures.js"

const Definition = OwnImport.Definition
type MethodName = OwnImport.MethodName
type EventName = OwnImport.EventName
type ErrorName = OwnImport.ErrorName

const methodNames = Object.keys(Definition.methods) as ReadonlyArray<MethodName>
const eventNames = Object.keys(Definition.events) as ReadonlyArray<EventName>
const errorsOf = (name: MethodName): ReadonlyArray<string> => Object.keys(Definition.methods[name].errors)
const codec = (schema: unknown) => schema as Schema.Codec<unknown, unknown>

/** 09 §5.2 in table order: the I1 rows, then the I2 rows; then 09 §9.6 (skills). */
const SPEC_METHODS = [
  "health",
  "sources.list",
  "sources.configure",
  "sessions.list",
  "sessions.read",
  "sessions.search",
  "migrate.plan",
  "migrate.execute",
  "migrate.cancel",
  "jobs.list",
  "skills.list",
  "skills.import",
  "skills.preview",
  "skills.install",
  "skills.updates",
  "skills.remove",
  "skills.detail",
]

/** 09 §5.3. */
const SPEC_EVENTS = ["index.changed", "job.progress", "job.finished"]

/**
 * 09 §5.4: the types and the methods that may answer them (every method has internal_error). The `migrate.*` rows that
 * name a source are the methods that take one (plan, execute); `summary_failed` ends a job and no method answers it.
 */
const SPEC_ERRORS: { readonly [M in MethodName]: ReadonlyArray<string> } = {
  health: [],
  "sources.list": [],
  "sources.configure": [],
  "sessions.list": ["directory_unknown"],
  "sessions.read": ["directory_unknown", "source_not_found", "source_unreadable"],
  "sessions.search": ["directory_unknown", "source_not_found", "source_unreadable"],
  "migrate.plan": [
    "directory_unknown",
    "source_not_found",
    "source_unreadable",
    "target_unavailable",
    "service_unreachable",
  ],
  "migrate.execute": [
    "source_not_found",
    "source_unreadable",
    "source_changed",
    "target_unavailable",
    "nonce_invalid",
    "job_busy",
    "service_unreachable",
  ],
  "migrate.cancel": ["job_not_found", "service_unreachable"],
  "jobs.list": [],
  "skills.list": [],
  "skills.import": ["skills_unconfigured", "skill_not_found", "skill_incompatible", "skill_conflict", "skill_links"],
  "skills.preview": ["skills_unconfigured", "url_invalid", "fetch_failed"],
  "skills.install": [
    "skills_unconfigured",
    "nonce_invalid",
    "skill_not_found",
    "skill_incompatible",
    "skill_conflict",
    "fetch_failed",
  ],
  "skills.updates": [],
  "skills.remove": ["skills_unconfigured", "skill_not_imported"],
  "skills.detail": ["skill_not_found", "skills_unconfigured"],
}

/** 09 §5.2: `reason` and the warnings, in document order. */
const SPEC_REASONS = [
  "fits",
  "does_not_fit",
  "quota_insufficient",
  "native_compaction",
  "same_company_subscription",
  "account_not_ready",
]
const SPEC_WARNINGS = [
  "source_live",
  "source_folder_missing",
  "z_unknown",
  "compaction_may_truncate",
  "images_dropped",
  "unknown_records",
  "cross_company",
  "history_base_partial",
  "quota_insufficient",
  "summarizer_overridden",
  "import_too_large",
  "location_differs",
]

// ---------------------------------------------------------------------------------------------------------------
// Samples (synthetic; no real paths or conversations)

const T = 1_790_000_000_000
const EVENT = "01JB0000000000000000000005"
const CODEX = { kind: "codex", rootID: "codex-default", id: "0199a213-81c0-7800-8aa1-bbab2a035a55" }
const CLAUDE = { kind: "claude-code", rootID: "claude-default", id: "7f0c3a52-0d3b-4e7e-9a55-2f1d1c9b8e10" }
const CHILD = { ...CLAUDE, id: `${CLAUDE.id}:agent-a1b2c3d4` }
const PROJECT = "D:/own-open-code"

const root = {
  rootID: "codex-default",
  kind: "codex",
  label: "Codex",
  directory: "C:/Users/fixture/.codex",
  added: false,
  available: true,
  sessions: 3_217,
}
const addedRoot = {
  rootID: "extra-1",
  kind: "codex",
  label: "profiles/p3",
  directory: "D:/control-center/profiles/p3/codex",
  added: true,
  available: false,
  problem: "missing",
}

const summary = {
  ref: CODEX,
  title: "설치기 정리",
  firstPrompt: "설치기에서 오래된 단계를 지워 줘",
  app: "cli",
  cwd: "\\\\?\\D:\\own-open-code",
  folderExists: true,
  branch: "main",
  models: [{ provider: "openai", id: "gpt-5.5-codex" }],
  versions: ["0.153.0"],
  createdAt: T,
  updatedAt: T + 60_000,
  compactions: 2,
  subagents: 1,
  live: false,
  imported: [{ sessionID: SESSION, mode: "full", importedAt: T + 120_000, newTurns: 3 }],
  readable: true,
  archived: false,
  otherComputer: false,
}

/** A folded Claude Code sub-agent that cannot be read, with no optional field. */
const childSummary = {
  ref: CHILD,
  title: "",
  app: null,
  cwd: "D:/#Projects/own-open-code",
  folderExists: false,
  models: [],
  versions: [],
  createdAt: T,
  updatedAt: T,
  compactions: 0,
  subagents: 0,
  live: true,
  imported: [],
  readable: false,
  problem: "decode_failed",
  parent: CLAUDE,
  archived: false,
  otherComputer: false,
}

const outline = {
  turns: [
    { index: 0, firstLine: "설치기에서 오래된 단계를 지워 줘", time: T },
    { index: 1, firstLine: "테스트도 돌려 줘", time: T + 30_000 },
  ],
  checkpoints: [
    { turn: 1, step: 3, kind: "codex-remote" },
    { turn: 0, step: 0, kind: "foreign" },
  ],
  children: [{ ref: CHILD, title: "탐색", turn: 1 }, { ref: CHILD }],
  rolledBack: 1,
  branches: 2,
  tokens: 182_000,
  unknownRecords: 4,
  base: CLAUDE,
}

/** View messages as the wire carries them (times in epoch milliseconds). */
const messages = [
  { id: "msg_000000000001", type: "user", text: "설치기에서 오래된 단계를 지워 줘", time: { created: T } },
  {
    id: "msg_000000000002",
    type: "assistant",
    agent: "build",
    model: { id: "gpt-5.5-codex", providerID: "codex-cli" },
    content: [
      { type: "reasoning", text: "Reading the installer steps" },
      { type: "text", text: "오래된 단계 둘을 지웠습니다." },
      {
        type: "tool",
        id: "tool-1",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "bun test" },
          content: [{ type: "text", text: "12 pass" }],
          metadata: { exit: 0 },
        },
        time: { created: T + 1, completed: T + 2 },
      },
      {
        type: "tool",
        id: "tool-2",
        name: "exec_command",
        state: {
          status: "error",
          input: { cmd: "rm -rf build" },
          error: { type: "denied", message: "rejected by the user" },
        },
        time: { created: T + 3 },
      },
    ],
    finish: "stop",
    time: { created: T + 1, completed: T + 4 },
  },
  {
    id: "msg_000000000003",
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "The installer lost two steps.",
    // Kept text where core reads it since upstream v2.1 (metadata.recent).
    metadata: { recent: "[User]: 테스트도 돌려 줘" },
    time: { created: T + 5 },
  },
  { id: "msg_000000000004", type: "synthetic", text: "[task] build finished", time: { created: T + 6 } },
]

const TARGET = { providerID: "own-codex-7k2m", id: "gpt-6-astra", variant: "high" }
const JOB = "job_01JB0000000000000000000007"
const NONCE = "0123456789ABCDEFGHJK"
const credits = (lo: number, hi: number) => ({ lo, hi, unit: "credits" })
const send = { now: 0, withFirst: 182_000, accountID: CODEX_ACCOUNT, company: "openai", crossCompany: false }
const quota = { window: "codex.primary", percent: { lo: 2, hi: 4 }, state: "partial" }
const noCost = { summary: null, first: null, perRequest: null, autoCompactSoon: null, quota: null }

/** A Codex conversation past a remote compaction, every optional field set (09 §4.1, §4.3). */
const plan = {
  nonce: NONCE,
  expiresAt: T + 600_000,
  title: "설치기 정리",
  turns: 41,
  location: { directory: PROJECT, branch: "main", differsFromList: true },
  boundary: { at: { turn: 30, step: 2 }, checkpoint: "codex-remote", sourceCompactions: 2 },
  size: {
    visible: 182_000,
    Z: 13_250.5,
    zSource: "measured",
    exchange: 3_400,
    window: 272_000,
    ceiling: 244_800,
    ratio: 0.81,
    capacity: 41_500,
    tail: { fromTurn: 33, tokens: 168_000 },
    old: { turns: 33, tokens: 1_400_000 },
    summaryInput: 380_000,
    chunks: 2,
    omitted: 14,
  },
  summarizer: { model: TARGET, overridden: false },
  modes: [
    {
      mode: "full",
      available: true,
      recommended: true,
      send,
      cost: { summary: null, first: credits(0.9, 1.1), perRequest: credits(0.1, 0.1), autoCompactSoon: null, quota },
    },
    {
      mode: "summary",
      source: "llm",
      available: false,
      recommended: false,
      reason: "quota_insufficient",
      send: { ...send, now: 380_000, withFirst: 175_000 },
      cost: {
        summary: credits(1.2, 1.6),
        first: credits(0.8, 1),
        perRequest: credits(0.1, 0.1),
        autoCompactSoon: credits(0.3, 0.4),
        quota: { window: "codex.primary", percent: { lo: 6, hi: 9, point: 7 }, state: "calibrated" },
      },
    },
    { mode: "summary", source: "brief", available: true, recommended: false, send, cost: noCost },
  ],
  store: { full: true, bytes: 12_582_912, budget: 33_554_432, trimmedTurns: 0 },
  redactions: 3,
  dropped: { encryptedReasoning: 120, remoteCompaction: 2 },
  warnings: ["source_live", "compaction_may_truncate", "location_differs"],
  existing: [{ sessionID: SESSION, mode: "full", importedAt: T + 120_000 }],
}

/** A conversation too big for a local model: no boundary, no summarizer, no optional field, a negative capacity. */
const smallPlan = {
  nonce: NONCE,
  expiresAt: T,
  title: "",
  turns: 0,
  location: { directory: PROJECT, differsFromList: false },
  boundary: { at: null, checkpoint: null, sourceCompactions: 0 },
  size: {
    visible: 0,
    Z: 12_000,
    zSource: "default",
    exchange: 3_000,
    window: 8_192,
    ceiling: 6_144,
    ratio: 1.5,
    capacity: -9_000,
  },
  summarizer: null,
  modes: [
    {
      mode: "full",
      available: false,
      recommended: false,
      reason: "does_not_fit",
      send: { now: 0, withFirst: 0, accountID: null, company: null, crossCompany: true },
      cost: noCost,
    },
  ],
  store: { full: false, bytes: 0, budget: 33_554_432, trimmedTurns: 0 },
  redactions: 0,
  dropped: {},
  warnings: [],
  existing: [],
}

/** `own.import` metadata of a summarized import and of a helper (09 §4.7). */
const importMeta = {
  v: 1,
  kind: "codex",
  sourceID: CODEX.id,
  root: CODEX.rootID,
  path: "C:/Users/fixture/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-0199a213.jsonl",
  title: "설치기 정리",
  cwd: "D:/own-open-code",
  models: [{ provider: "openai", id: "gpt-5.5-codex" }],
  versions: ["0.153.0", "0.154.1"],
  sourceUpdatedAt: T + 60_000,
  sourceBytes: 7_500_000,
  turns: 41,
  contentHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  mode: "summary",
  checkpoint: "llm",
  summarizer: TARGET,
  storedFull: true,
  tailFromTurn: 33,
  redactions: 3,
  dropped: { encryptedReasoning: 120 },
  importedAt: T + 120_000,
}
const helperMeta = { v: 1, helper: true, jobID: JOB }

/** A found skill and a previewed one (09 §9.2, §9.5). */
const SKILL_FORMAT = { status: "converted", problems: [], notes: ["codex_interface"], ignored: [] }
const skillFound = {
  key: "sk-0123456789abcdef",
  origin: "codex",
  rootID: "codex-default",
  name: "release-notes",
  description: "릴리스 노트 쓰기",
  id: "release-notes",
  directory: "C:/Users/fixture/.codex/skills/release-notes",
  system: false,
  files: 3,
  bytes: 4_096,
  scripts: ["scripts/collect.py"],
  format: SKILL_FORMAT,
  imported: { id: "release-notes", changed: true },
  relative: "skills/release-notes",
  real: "C:/Users/fixture/.codex/skills/release-notes",
  modifiedAt: T,
  version: "1.2.0",
  hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  links: [
    { relative: "shared", target: "C:/Users/fixture/.codex/skills/_shared", kind: "folder", scope: "inside", state: "copy" },
    {
      relative: "assets",
      target: "D:/assets/3d",
      kind: "folder",
      scope: "outside",
      state: "approve",
      linkKey: "lk-0123456789abcdef0123",
    },
    { relative: "gone", target: "D:/gone", kind: "folder", state: "refused", reason: "broken" },
  ],
}
const pluginSkill = {
  ...skillFound,
  key: "sk-fedcba9876543210",
  origin: "claude-plugin",
  rootID: "claude-default",
  directory: "C:/Users/fixture/.claude/plugins/cache/market/hookify/1.0.0/skills/writing-rules",
  name: "writing-rules",
  id: "writing-rules",
  plugin: { name: "hookify", marketplace: "market", installed: true },
  scripts: [],
  format: { status: "incompatible", problems: ["skill_variables"], notes: ["allowed_tools"], ignored: ["color"] },
}
const skillImport = {
  id: "release-notes",
  origin: "git",
  name: "release-notes",
  importedAt: T,
  hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  files: 3,
  url: "https://example.test/skills.git",
  ref: "main",
  commit: "0123456789abcdef0123456789abcdef01234567",
  folder: "skills/release-notes",
}
const preview = {
  nonce: NONCE,
  expiresAt: T + 600_000,
  url: "https://example.test/skills.git",
  commit: "0123456789abcdef0123456789abcdef01234567",
  layout: "marketplace",
  items: [
    {
      key: "sk-0011223344556677",
      name: "release-notes",
      id: "release-notes",
      folder: "plugins/docs/skills/release-notes",
      plugin: "docs",
      files: ["SKILL.md", "scripts/collect.py"],
      fileCount: 2,
      scripts: ["scripts/collect.py"],
      format: { status: "ok", problems: [], notes: [], ignored: [] },
      conflict: { replaceable: true },
    },
  ],
  external: [{ plugin: "remote-one", repo: { url: "https://example.test/other.git", folder: "plugins/one" } }],
}

const samples: { readonly [M in MethodName]: { readonly input: unknown; readonly output: unknown } } = {
  health: { input: {}, output: { version: "2.0.24-own.1", features: ["view", "search"], workerReady: false } },
  "sources.list": { input: {}, output: { roots: [root, addedRoot] } },
  "sources.configure": {
    input: { extraRoots: [{ kind: "codex", directory: "D:/control-center/profiles/p3/codex" }] },
    output: { roots: [root, addedRoot] },
  },
  "sessions.list": {
    input: {
      directory: PROJECT,
      scope: "all",
      include: { subagents: true, exec: false, archived: true },
      query: "설치기",
      cursor: "c:50",
      limit: 50,
    },
    output: { items: [summary, childSummary], total: 52, fresh: 41, cursor: "c:100", scanning: true },
  },
  "sessions.read": {
    input: { ref: CODEX, directory: PROJECT, from: 0, count: 20 },
    output: { summary, outline, outlineComplete: false, messages, next: 20 },
  },
  "sessions.search": {
    input: { directory: PROJECT, ref: CLAUDE, scope: "all", query: "installer", cursor: "s:1", limit: 100 },
    output: {
      hits: [{ ref: CLAUDE, turn: 7, snippet: "…the installer step…" }],
      complete: false,
      cursor: "s:2",
    },
  },
  "migrate.plan": {
    input: {
      ref: CODEX,
      directory: PROJECT,
      upToTurn: 40,
      mode: "summary",
      source: "llm",
      target: TARGET,
      accountID: "acc_codex_7k2m",
      location: "D:/#Projects/own-open-code",
      storeFull: false,
      redact: true,
    },
    output: plan,
  },
  "migrate.execute": { input: { nonce: NONCE }, output: { jobID: JOB } },
  "migrate.cancel": { input: { jobID: JOB }, output: { cancelled: false } },
  "jobs.list": {
    input: {},
    output: { jobs: [{ jobID: JOB, ref: CODEX, step: "summarizing", startedAt: T, sessionID: SESSION_2 }] },
  },
  "skills.list": {
    input: { approvedLinks: ["lk-0123456789abcdef0123"], hashes: true },
    output: {
      directory: "C:/Users/fixture/.config/own-open-code/skills",
      roots: [
        { ...root, origin: "default" },
        {
          ...addedRoot,
          origin: "profile",
          account: { app: "codex-multi-provider", id: "p3", alias: "work" },
          sharedWith: "codex-default",
        },
        { ...addedRoot, rootID: "extra-2", origin: "added", skillsTarget: "D:/elsewhere/skills" },
      ],
      items: [
        skillFound,
        pluginSkill,
        {
          ...skillFound,
          key: "sk-0f1e2d3c4b5a6978",
          origin: "claude-code",
          rootID: "claude-default",
          synced: { folder: "org-1_acct-1", org: "org-1", account: "acct-1" },
        },
      ],
      imports: [skillImport],
    },
  },
  "skills.import": {
    input: {
      key: "sk-0123456789abcdef",
      id: "release-notes-codex",
      replace: false,
      approvedLinks: ["lk-0123456789abcdef0123"],
    },
    output: {
      id: "release-notes-codex",
      directory: "C:/Users/fixture/.config/own-open-code/skills/release-notes-codex",
    },
  },
  "skills.preview": {
    input: { url: "https://example.test/skills.git", ref: "main", folder: "plugins/docs" },
    output: preview,
  },
  "skills.install": {
    input: {
      nonce: NONCE,
      keys: ["sk-0011223344556677"],
      renames: [{ key: "sk-0011223344556677", id: "notes" }],
      replace: true,
    },
    output: { installed: [{ id: "notes", directory: "C:/Users/fixture/.config/own-open-code/skills/notes" }] },
  },
  "skills.updates": {
    input: {},
    output: {
      items: [
        { id: "release-notes", state: "changed", commit: "fedcba9876543210fedcba9876543210fedcba98" },
        { id: "writing-rules", state: "same", key: "sk-fedcba9876543210" },
      ],
    },
  },
  "skills.remove": { input: { id: "release-notes" }, output: { id: "release-notes" } },
  "skills.detail": {
    input: { key: "sk-0123456789abcdef", approvedLinks: ["lk-0123456789abcdef0123"] },
    output: {
      name: "release-notes",
      description: "릴리스 노트 쓰기",
      directory: "C:/Users/fixture/.codex/skills/release-notes",
      frontmatter: [
        { key: "name", value: "release-notes" },
        { key: "allowed-tools", value: "Read, Grep" },
      ],
      body: "# Release notes\n",
      truncated: false,
      files: [{ relative: "SKILL.md", size: 120 }],
      fileCount: 1,
      bytes: 120,
      hash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      format: SKILL_FORMAT,
      imported: { record: skillImport, source: "unknown" },
    },
  },
}

const errorSamples: { readonly [E in ErrorName]: unknown } = {
  internal_error: {},
  directory_unknown: { directory: "D:/elsewhere" },
  source_not_found: { ref: CODEX },
  source_unreadable: { ref: CLAUDE, reason: "path_denied" },
  source_changed: { ref: CLAUDE },
  target_unavailable: { model: TARGET, reason: "account_not_ready" },
  nonce_invalid: {},
  job_busy: { jobID: JOB },
  job_not_found: { jobID: JOB },
  summary_failed: { cause: "exhausted" },
  service_unreachable: {},
  skills_unconfigured: {},
  skill_not_found: { key: "sk-0123456789abcdef" },
  skill_incompatible: { key: "sk-0123456789abcdef", problems: ["hooks", "dynamic_context"] },
  skill_conflict: { id: "release-notes", replaceable: false },
  skill_not_imported: { id: "release-notes" },
  skill_links: { key: "sk-0123456789abcdef", linkKeys: ["lk-0123456789abcdef0123"], reason: "changed" },
  url_invalid: {},
  fetch_failed: { reason: "no_partial_clone" },
}

const eventSamples: { readonly [E in EventName]: unknown } = {
  "index.changed": { eventId: EVENT, origin: "global", directories: [PROJECT] },
  "job.progress": { eventId: EVENT, origin: "global", jobID: JOB, step: "summarizing", helperSessionID: SESSION_2 },
  "job.finished": {
    eventId: EVENT,
    origin: "global",
    jobID: JOB,
    outcome: "failed",
    error: { type: "summary_failed", message: "the account's usage limit was reached", cause: "exhausted" },
  },
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

type Standard = {
  "~standard": { validate: (value: unknown) => { value?: unknown; issues?: ReadonlyArray<{ message: string }> } }
}
const validate = (schema: unknown, value: unknown) => (schema as Standard)["~standard"].validate(value)
const decode = (schema: unknown, value: unknown) => Schema.decodeUnknownSync(codec(schema))(value)
const rejects = (schema: unknown, value: unknown) => expect(() => decode(schema, value)).toThrow()

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
const namesOf = (schema: unknown) => propertyNames((schema as Schema.Top).ast)

// ---------------------------------------------------------------------------------------------------------------

describe("own.import definition (09 §5.1–5.4)", () => {
  test("has the RPC id own.import and the metadata key own.import", () => {
    expect(Definition.id).toBe("own.import")
    expect<string>(OwnImport.ID).toBe("own.import")
    expect<string>(OwnImportRouting.ID).toBe("own.import")
    expect<string>(OwnImport.META_KEY).toBe("own.import")
    expect<string>(OwnImportRouting.META_KEY).toBe("own.import")
  })

  test("declares exactly the I1, I2 and skills methods and events", () => {
    expect<ReadonlyArray<string>>([...methodNames].sort()).toEqual([...SPEC_METHODS].sort())
    expect<ReadonlyArray<string>>([...eventNames].sort()).toEqual([...SPEC_EVENTS].sort())
  })

  test("declares the 09 §5.4 errors per method, internal_error everywhere and never an rpc.* name", () => {
    expect(Object.keys(OwnImport.errors).sort()).toEqual(
      [
        "internal_error",
        "directory_unknown",
        "source_not_found",
        "source_unreadable",
        "source_changed",
        "target_unavailable",
        "nonce_invalid",
        "job_busy",
        "job_not_found",
        "summary_failed",
        "service_unreachable",
        "skills_unconfigured",
        "skill_not_found",
        "skill_incompatible",
        "skill_conflict",
        "skill_not_imported",
        "skill_links",
        "url_invalid",
        "fetch_failed",
      ].sort(),
    )
    for (const name of methodNames) {
      expect({ name, errors: [...errorsOf(name)].sort() }).toEqual({
        name,
        errors: [...SPEC_ERRORS[name], "internal_error"].sort(),
      })
      expect(errorsOf(name).filter((error) => error.startsWith("rpc."))).toEqual([])
    }
  })

  test("every schema is portable (Standard Schema) and still an Effect schema", () => {
    const schemas = [
      ...methodNames.flatMap((name) => {
        const method = Definition.methods[name]
        return [method.input, method.output, ...Object.values(method.errors)]
      }),
      ...eventNames.map((name) => Definition.events[name].schema),
    ]
    for (const schema of schemas) {
      expect(Schema.isSchema(schema)).toBe(true)
      expect(typeof (schema as unknown as Standard)["~standard"].validate).toBe("function")
    }
    const portable: Rpc.PortableDefinition = Portable.definition(Definition)
    expect(portable.id).toBe(OwnImport.ID)
  })

  test("is typed for handlers and clients", () => {
    const input: Rpc.Input<OwnImport.Definition["methods"]["sessions.list"]["input"]> = {
      directory: PROJECT,
      limit: 0,
    }
    const reason: Rpc.Output<
      OwnImport.Definition["methods"]["sessions.read"]["errors"]["source_unreadable"]
    >["reason"] = "locked"
    const directories: Rpc.EventData<OwnImport.Definition["events"]["index.changed"]["schema"]>["directories"] = [
      PROJECT,
    ]
    const why: Rpc.Output<OwnImport.Definition["methods"]["migrate.plan"]["output"]>["modes"][number]["reason"] = "fits"
    const outcome: Rpc.EventData<OwnImport.Definition["events"]["job.finished"]["schema"]>["outcome"] = "cancelled"
    const cause: OwnImport.SummaryFailure = "overflow"
    expect([input.limit, reason, directories, why, outcome, cause]).toEqual([
      0,
      "locked",
      [PROJECT],
      "fits",
      "cancelled",
      "overflow",
    ])
  })

  test("schema identifiers are namespaced and unique", () => {
    const identifiers = Object.values(OwnImport).flatMap((value) => {
      if (!Schema.isSchema(value)) return []
      const identifier = value.ast.annotations?.identifier
      return typeof identifier === "string" ? [identifier] : []
    })
    expect(identifiers.length).toBeGreaterThan(20)
    expect(identifiers.filter((identifier) => !identifier.startsWith("OwnImport."))).toEqual([])
    expect(identifiers.filter((identifier, index) => identifiers.indexOf(identifier) !== index)).toEqual([])
  })
})

describe("routing (09 §5.5)", () => {
  test("every method has a scope and the control location; every event is read and global", () => {
    expect(Object.keys(OwnImport.MethodScope).sort()).toEqual([...methodNames].sort())
    expect(Object.keys(OwnImport.MethodLocation).sort()).toEqual([...methodNames].sort())
    expect(new Set(Object.values(OwnImport.MethodLocation))).toEqual(new Set(["control"]))
    expect(Object.keys(OwnImport.EventScope).sort()).toEqual([...eventNames].sort())
    expect(new Set(Object.values(OwnImport.EventScope))).toEqual(new Set(["read"]))
    expect(Object.keys(OwnImport.EventOrigin).sort()).toEqual([...eventNames].sort())
    expect(new Set(Object.values(OwnImport.EventOrigin))).toEqual(new Set(["global"]))
  })

  test("I2 (Q2, decided 2026-10-08): health and the views read, the migration prompt, the roots setting local", () => {
    // The views open to devices because their answers show secrets by name only (own-import, IMP.20); the
    // migration creates a session and uses LLM quota, like sending a message; the roots setting never leaves the PC.
    expect(OwnImport.MethodScope).toEqual({
      health: "read",
      "sources.list": "read",
      "sources.configure": "local",
      "sessions.list": "read",
      "sessions.read": "read",
      "sessions.search": "read",
      "migrate.plan": "prompt",
      "migrate.execute": "prompt",
      "migrate.cancel": "prompt",
      "jobs.list": "read",
      "skills.list": "read",
      "skills.import": "local",
      "skills.preview": "local",
      "skills.install": "local",
      "skills.updates": "local",
      "skills.remove": "local",
      "skills.detail": "read",
    })
  })

  test("skills (09 §9.6): the list reads, copying, previewing, installing and update checks stay on this PC", () => {
    expect(OwnImportRouting.scopeOf("skills.list", {})).toBe("read")
    for (const method of [
      "skills.import",
      "skills.preview",
      "skills.install",
      "skills.updates",
      "skills.remove",
    ] as const)
      expect(OwnImportRouting.scopeOf(method, {})).toBe("local")
  })

  test("a skill id is a safe folder name and a key is a path-free token", () => {
    for (const id of ["release-notes", "a", "x.y_z-1", "A".repeat(64)]) expect(decode(OwnImport.SkillID, id)).toBe(id)
    for (const id of ["", "-x", "a/b", "a\\b", "..", "a.", "con", "NUL.txt", "a b", "A".repeat(65), "한글"])
      rejects(OwnImport.SkillID, id)
    for (const key of ["../x", "C:\\x", "a/b", ""]) rejects(OwnImport.SkillKey, key)
    expect(decode(OwnImport.LinkKey, "lk-0123456789abcdef0123")).toBe("lk-0123456789abcdef0123")
    for (const key of ["lk-0123", "sk-0123456789abcdef0123", "lk-0123456789ABCDEF0123", "C:\\x"])
      rejects(OwnImport.LinkKey, key)
  })

  test("skills.detail (SK2) takes a found key, own-import's copy or a skill core loads, never a bare path", () => {
    const input = codec(Definition.methods["skills.detail"].input)
    for (const value of [
      { key: "sk-0123456789abcdef" },
      { copy: "release-notes" },
      { directory: PROJECT, loaded: "release-notes" },
    ])
      expect(Schema.decodeUnknownSync(input)(value)).toEqual(value)
    for (const value of [{}, { copy: "../x" }, { directory: PROJECT }, { loaded: "x" }, { path: "C:/x/SKILL.md" }])
      expect(() => Schema.decodeUnknownSync(input)(value)).toThrow()
    expect(OwnImportRouting.scopeOf("skills.detail", { key: "sk-0123456789abcdef" })).toBe("read")
  })

  test("approved links (SK2) are this PC's only: skills.list and skills.detail with approvedLinks are local", () => {
    const links = ["lk-0123456789abcdef0123"]
    expect(OwnImportRouting.scopeOf("skills.list", { approvedLinks: links })).toBe("local")
    expect(OwnImportRouting.scopeOf("skills.detail", { key: "sk-0123456789abcdef", approvedLinks: links })).toBe(
      "local",
    )
    // No approval asked: the list and the detail stay readable from a device.
    expect(OwnImportRouting.scopeOf("skills.list", { approvedLinks: [] })).toBe("read")
    expect(OwnImportRouting.scopeOf("skills.list", { hashes: true, directory: PROJECT })).toBe("read")
    expect(OwnImportRouting.scopeOf("skills.detail", { key: "sk-0123456789abcdef", approvedLinks: [] })).toBe("read")
  })

  test("skills.list (SK2) takes a project folder and answers the loaded skills' hashes; a detail entry can be omitted", () => {
    const input = codec(Definition.methods["skills.list"].input)
    expect(Schema.decodeUnknownSync(input)({ directory: PROJECT })).toEqual({ directory: PROJECT })
    expect(() => Schema.decodeUnknownSync(input)({ directory: "" })).toThrow()
    const output = codec(Definition.methods["skills.list"].output)
    const listed = {
      directory: null,
      roots: [],
      items: [],
      imports: [],
      loaded: [{ id: "translate", path: "C:\\own\\skills\\translate\\SKILL.md", hash: "a".repeat(64) }],
    }
    expect(Schema.decodeUnknownSync(output)(listed)).toEqual(listed)
    const detail = codec(OwnImport.SkillDetail)
    const shown = {
      name: "bomb",
      directory: "C:\\x",
      frontmatter: [{ key: "h", value: "", omitted: "aliases" }],
      skillMd: { state: "too_large", size: 2_000_000 },
      truncated: false,
      files: [],
      fileCount: 0,
      bytes: 0,
    }
    expect(Schema.decodeUnknownSync(detail)(shown)).toEqual(shown)
    expect(() =>
      Schema.decodeUnknownSync(detail)({ ...shown, frontmatter: [{ key: "h", value: "", omitted: "other" }] }),
    ).toThrow()
    const format = codec(OwnImport.SkillFormat)
    const large = {
      status: "incompatible",
      problems: ["too_large"],
      notes: [],
      ignored: [],
      large: { skillMd: 1_048_577 },
    }
    expect(Schema.decodeUnknownSync(format)(large)).toEqual(large)
  })

  test("scopeOf: every conversation on the PC and a migration that keeps secrets are local (09 §5.5, IG10)", () => {
    const scopeOf = OwnImportRouting.scopeOf
    expect(scopeOf("sessions.list", { directory: PROJECT })).toBe("read")
    expect(scopeOf("sessions.list", { directory: PROJECT, scope: "folder" })).toBe("read")
    for (const method of ["sessions.list", "sessions.read", "sessions.search", "migrate.plan"] as const)
      expect(scopeOf(method, { directory: PROJECT, scope: "all" })).toBe("local")
    expect(scopeOf("migrate.plan", { ref: CODEX, directory: PROJECT, target: TARGET })).toBe("prompt")
    expect(scopeOf("migrate.plan", { ref: CODEX, directory: PROJECT, target: TARGET, redact: true })).toBe("prompt")
    expect(scopeOf("migrate.plan", { ref: CODEX, directory: PROJECT, target: TARGET, redact: false })).toBe("local")
    expect(scopeOf("sources.configure", { extraRoots: [] })).toBe("local")
    expect(scopeOf("health", undefined)).toBe("read")
  })

  test("scopes are the own.accounts words read, prompt and local", () => {
    expect<ReadonlyArray<string>>([...OwnImport.Scope.literals]).toEqual(["read", "prompt", "local"])
    for (const scope of Object.values(OwnImport.MethodScope)) expect(OwnImport.Scope.literals).toContain(scope)
  })

  test("the tables are typed: a method cannot be left out", () => {
    // @ts-expect-error every method needs a scope
    const missing: typeof OwnImport.MethodScope = { health: "read" }
    // @ts-expect-error only the three scope words exist
    const unknown: typeof OwnImport.MethodScope = { ...OwnImport.MethodScope, health: "admin" }
    expect([missing, unknown]).toHaveLength(2)
  })

  test("the schema module re-exports the plain tables", () => {
    expect(OwnImport.MethodScope).toBe(OwnImportRouting.MethodScope)
    expect(OwnImport.MethodLocation).toBe(OwnImportRouting.MethodLocation)
    expect(OwnImport.EventScope).toBe(OwnImportRouting.EventScope)
    expect(OwnImport.EventOrigin).toBe(OwnImportRouting.EventOrigin)
  })

  test("rpc-import-routing.ts has no runtime import (no effect, no schema modules)", async () => {
    const source = await Bun.file(new URL("../src/rpc-import-routing.ts", import.meta.url)).text()
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source).map((entry) => entry.path)
    // Only its own namespace self-export remains once type-only imports are erased.
    expect(imports).toEqual(["./rpc-import-routing.js"])
    expect(source).toContain('import type { OwnImport } from "./rpc-import.js"')
  })
})

describe("Portable round trip (rpc.invalid_output 0)", () => {
  const portable = Portable.definition(Definition)

  test("there is a sample for every method", () => {
    expect(Object.keys(samples).sort()).toEqual([...methodNames].sort())
  })

  test.each([...methodNames])("%s: input decodes and output encodes unchanged", (name) => {
    const sample = samples[name]
    const method = portable.methods[name]
    expect(Schema.isSchema(method.input)).toBe(false)
    expect(validate(method.input, sample.input)).toEqual({ value: sample.input })
    // A handler returns decoded values (view messages carry DateTime); the host sends their encoding.
    expect(validate(method.output, decode(Definition.methods[name].output, sample.output))).toEqual({
      value: sample.output,
    })
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

  test("job events encode unchanged; a successful end names the session and has no error", () => {
    for (const name of ["job.progress", "job.finished"] as const) {
      const schema = portable.events[name].schema
      const sample = eventSamples[name]
      expect(validate(schema, sample)).toEqual({ value: sample })
      expect(validate(schema, { ...(sample as object), origin: "session" }).issues).toBeDefined()
    }
    const finished = portable.events["job.finished"].schema
    const done = { eventId: EVENT, origin: "global", jobID: JOB, outcome: "succeeded", sessionID: SESSION }
    expect(validate(finished, done)).toEqual({ value: done })
    const cancelled = { eventId: EVENT, origin: "global", jobID: JOB, outcome: "cancelled" }
    expect(validate(finished, cancelled)).toEqual({ value: cancelled })
    expect(validate(finished, { ...cancelled, outcome: "aborted" }).issues).toBeDefined()
    const progress = portable.events["job.progress"].schema
    const reading = { eventId: EVENT, origin: "global", jobID: JOB, step: "reading" }
    expect(validate(progress, reading)).toEqual({ value: reading })
    expect(validate(progress, { ...reading, step: "compacting" }).issues).toBeDefined()
    expect(validate(progress, { ...reading, jobID: "C:/x" }).issues).toBeDefined()
  })

  test("index.changed encodes unchanged with eventId and origin global, with or without directories", () => {
    const schema = portable.events["index.changed"].schema
    const sample = eventSamples["index.changed"]
    expect(validate(schema, sample)).toEqual({ value: sample })
    expect(validate(schema, { eventId: EVENT, origin: "global" })).toEqual({
      value: { eventId: EVENT, origin: "global" },
    })
    expect(validate(schema, { ...(sample as object), origin: "session" }).issues).toBeDefined()
    expect(validate(schema, { origin: "global" }).issues).toBeDefined()
  })
})

describe("schemas (09 §3, §5.2)", () => {
  const input = (name: MethodName) => Definition.methods[name].input
  const output = (name: MethodName) => Definition.methods[name].output

  test("no input has a path field: a conversation is a SourceRef {kind, rootID, id}", () => {
    expect(namesOf(OwnImport.SourceRef)).toEqual(["kind", "rootID", "id"])
    const names = methodNames.flatMap((name) => namesOf(input(name)))
    // The walk reaches nested and optional fields.
    expect(names).toEqual(expect.arrayContaining(["rootID", "subagents", "extraRoots", "cursor"]))
    expect(names.filter((name) => /path|file|rollout/i.test(name))).toEqual([])
  })

  test("source and root ids are tokens, never paths", () => {
    for (const id of [CODEX.id, CLAUDE.id, CHILD.id, "codex-default", "extra-1"])
      expect(decode(OwnImport.SourceID, id)).toBe(id)
    for (const bad of ["", "C:\\Users\\x\\.codex", "../auth.json", "projects/x/a.jsonl", ".hidden", "-x", "a b"]) {
      rejects(OwnImport.SourceID, bad)
      rejects(OwnImport.RootID, bad)
    }
    rejects(OwnImport.RootID, "r".repeat(65))
    // A path sent anyway is dropped at the boundary; the handler never sees it.
    const read = input("sessions.read")
    expect(decode(read, { ref: { ...CODEX, path: "C:/Users/x/.codex/sessions/a.jsonl" }, directory: PROJECT })).toEqual(
      {
        ref: CODEX,
        directory: PROJECT,
      },
    )
    rejects(read, { ref: { ...CODEX, kind: "gemini" }, directory: PROJECT })
    // The folder whose project the conversation must belong to is always named (09 §5.5).
    rejects(read, { ref: CODEX })
    rejects(read, { ref: CODEX, directory: PROJECT, scope: "project" })
  })

  test("Summary has the 09 §5.2 fields and the folding parent link", () => {
    expect(namesOf(OwnImport.Summary)).toEqual(
      expect.arrayContaining([
        "ref",
        "title",
        "firstPrompt",
        "app",
        "cwd",
        "folderExists",
        "branch",
        "models",
        "createdAt",
        "updatedAt",
        "compactions",
        "subagents",
        "live",
        "imported",
        "sessionID",
        "mode",
        "importedAt",
        "newTurns",
        "readable",
        "problem",
        "parent",
      ]),
    )
    expect(decode(OwnImport.Summary, childSummary)).toEqual(childSummary)
    rejects(OwnImport.Summary, { ...summary, imported: [{ ...summary.imported[0], mode: "copy" }] })
    rejects(OwnImport.Summary, { ...summary, imported: [{ ...summary.imported[0], newTurns: 0 }] })
    rejects(OwnImport.Summary, { ...summary, problem: "unknown" })
  })

  test("Outline has turns, checkpoints, children, rolled-back and branch counts", () => {
    expect(namesOf(OwnImport.Outline)).toEqual(
      expect.arrayContaining(["turns", "index", "firstLine", "time", "checkpoints", "turn", "step", "kind"]),
    )
    expect(namesOf(OwnImport.Outline)).toEqual(expect.arrayContaining(["children", "rolledBack", "branches"]))
    rejects(OwnImport.Outline, { ...outline, checkpoints: [{ turn: 0, step: 0, kind: "llm" }] })
  })

  test("sessions.read pages are SessionMessage.Info and may be empty", () => {
    const page = samples["sessions.read"].output
    const decoded = decode(output("sessions.read"), page) as { messages: ReadonlyArray<{ type: string }> }
    expect(decoded.messages.map((message) => message.type)).toEqual(["user", "assistant", "compaction", "synthetic"])
    expect(decode(output("sessions.read"), { summary, outline, outlineComplete: true, messages: [] })).toEqual({
      summary,
      outline,
      outlineComplete: true,
      messages: [],
    })
    rejects(output("sessions.read"), {
      summary,
      outline,
      outlineComplete: true,
      messages: [{ id: "x", type: "user", text: "", time: { created: T } }],
    })
  })

  test("sessions.list: limit 0 for the counts, at most 200, scope and include", () => {
    const list = input("sessions.list")
    expect(decode(list, { directory: PROJECT, limit: 0 })).toEqual({ directory: PROJECT, limit: 0 })
    rejects(list, { directory: PROJECT, limit: 201 })
    rejects(list, { directory: PROJECT, limit: -1 })
    rejects(list, { directory: "" })
    rejects(list, { directory: PROJECT, scope: "project" })
    rejects(list, { directory: PROJECT, include: { subagents: true } })
    const done = { items: [], total: 0, fresh: 0, cursor: null, scanning: false }
    expect(decode(output("sessions.list"), done)).toEqual(done)
  })

  test("sessions.search: the folder's project, or one conversation of it; snippets of at most 160 characters", () => {
    const search = input("sessions.search")
    expect(decode(search, { directory: PROJECT, query: "설치기" })).toEqual({ directory: PROJECT, query: "설치기" })
    expect(decode(search, { directory: PROJECT, ref: CODEX, query: "bun test" })).toEqual({
      directory: PROJECT,
      ref: CODEX,
      query: "bun test",
    })
    rejects(search, { query: "설치기" })
    rejects(search, { ref: CODEX, query: "설치기" })
    rejects(search, { directory: PROJECT, query: "" })
    rejects(search, { directory: PROJECT, query: "q".repeat(201) })
    rejects(search, { directory: PROJECT, query: "q", limit: 0 })
    rejects(search, { directory: PROJECT, query: "q", limit: 101 })
    const hit = { ref: CODEX, turn: 0, snippet: "가".repeat(160) }
    expect(decode(OwnImport.Hit, hit)).toEqual(hit)
    rejects(OwnImport.Hit, { ...hit, snippet: "가".repeat(161) })
    expect(decode(output("sessions.search"), { hits: [], complete: true })).toEqual({ hits: [], complete: true })
  })

  test("sources: added roots replace the list (at most 32), roots name their problem", () => {
    const configure = input("sources.configure")
    expect(decode(configure, { extraRoots: [] })).toEqual({ extraRoots: [] })
    rejects(configure, { extraRoots: [{ kind: "codex", directory: "" }] })
    rejects(configure, { extraRoots: [{ kind: "grok", directory: "D:/x" }] })
    rejects(configure, { extraRoots: Array.from({ length: 33 }, () => ({ kind: "codex", directory: "D:/x" })) })
    rejects(OwnImport.Root, { ...addedRoot, problem: "locked" })
  })

  test("health lists features; migrate is a known feature for I2, skills for 09 §9", () => {
    expect<ReadonlyArray<string>>([...OwnImport.Feature.literals]).toEqual(["view", "search", "migrate", "skills"])
    rejects(output("health"), { version: "dev", features: ["import"], workerReady: true })
  })

  test("events carry no conversation content", () => {
    expect(namesOf(Definition.events["index.changed"].schema)).toEqual(["eventId", "origin", "directories"])
    expect(namesOf(Definition.events["job.progress"].schema)).toEqual([
      "eventId",
      "origin",
      "jobID",
      "step",
      "helperSessionID",
    ])
    // An optional struct is walked through both of its encodings, so names repeat.
    expect([...new Set(namesOf(Definition.events["job.finished"].schema))]).toEqual([
      "eventId",
      "origin",
      "jobID",
      "outcome",
      "sessionID",
      "error",
      "type",
      "message",
      "cause",
    ])
  })

  test("errors carry the ref or folder and the unreadable reason only", () => {
    expect<ReadonlyArray<string>>([...OwnImport.Unreadable.literals]).toEqual([
      "missing",
      "decode_failed",
      "too_large",
      "path_denied",
      "locked",
    ])
    rejects(OwnImport.errors.source_unreadable, { ref: CODEX, reason: "busy" })
    rejects(OwnImport.errors.source_not_found, { ref: { kind: "codex", id: CODEX.id } })
  })

  test("imported sessions reference own session ids", () => {
    const imported = { sessionID: SESSION_2, mode: "summary", importedAt: T }
    expect(decode(OwnImport.Imported, imported)).toEqual(imported)
    rejects(OwnImport.Imported, { ...imported, sessionID: "thread-1" })
  })
})

describe("migration (09 §4, §5.2–5.4)", () => {
  const input = (name: MethodName) => Definition.methods[name].input
  const output = (name: MethodName) => Definition.methods[name].output

  test("Plan has the 09 §5.2 fields, with Estimate deltas and quota impacts in every mode row", () => {
    expect(namesOf(OwnImport.Plan)).toEqual(
      expect.arrayContaining([
        "nonce",
        "expiresAt",
        "title",
        "turns",
        "location",
        "directory",
        "branch",
        "differsFromList",
        "boundary",
        "at",
        "checkpoint",
        "sourceCompactions",
        "size",
        "visible",
        "Z",
        "zSource",
        "exchange",
        "window",
        "ceiling",
        "ratio",
        "capacity",
        "tail",
        "fromTurn",
        "old",
        "summaryInput",
        "chunks",
        "summarizer",
        "overridden",
        "modes",
        "mode",
        "source",
        "available",
        "recommended",
        "reason",
        "send",
        "now",
        "withFirst",
        "accountID",
        "company",
        "crossCompany",
        "cost",
        "summary",
        "first",
        "perRequest",
        "autoCompactSoon",
        "quota",
        "store",
        "full",
        "bytes",
        "budget",
        "trimmedTurns",
        "redactions",
        "dropped",
        "warnings",
        "existing",
      ]),
    )
    // Costs are Estimate deltas in account units.
    rejects(OwnImport.Cost, { ...noCost, first: { lo: 1, hi: 2, unit: "tokens" } })
    rejects(OwnImport.Cost, { ...noCost, quota: { window: "codex.primary", percent: null, state: "unknown" } })
    for (const value of [plan, smallPlan]) expect(roundTrip(codec(output("migrate.plan")), value)).toEqual(value)
  })

  test("reason and warning literals are exactly 09 §5.2's", () => {
    expect<ReadonlyArray<string>>([...OwnImport.Reason.literals]).toEqual(SPEC_REASONS)
    expect<ReadonlyArray<string>>([...OwnImport.Warning.literals]).toEqual(SPEC_WARNINGS)
    const row = plan.modes[1]
    rejects(OwnImport.ModeOption, { ...row, reason: "too_expensive" })
    rejects(OwnImport.ModeOption, { ...row, source: "remote" })
    rejects(OwnImport.Plan, { ...plan, warnings: ["costly"] })
  })

  test("Plan rejects a zero window, an unknown Z source, a negative size and a non-account recipient", () => {
    rejects(OwnImport.Plan, { ...plan, size: { ...plan.size, window: 0 } })
    rejects(OwnImport.Plan, { ...plan, size: { ...plan.size, zSource: "guessed" } })
    rejects(OwnImport.Plan, { ...plan, size: { ...plan.size, visible: -1 } })
    rejects(OwnImport.Plan, { ...plan, size: { ...plan.size, capacity: 1.5 } })
    rejects(OwnImport.Plan, { ...plan, boundary: { ...plan.boundary, checkpoint: "llm" } })
    rejects(OwnImport.Plan, { ...plan, modes: [{ ...plan.modes[0], send: { ...send, accountID: "ChatGPT 01" } }] })
    rejects(OwnImport.Plan, { ...plan, nonce: "short" })
  })

  test("migrate.plan takes a SourceRef, the target Model.Ref and the 09 §5.2 options", () => {
    const plan = input("migrate.plan")
    const minimal = { ref: CLAUDE, directory: PROJECT, target: TARGET }
    expect(decode(plan, minimal)).toEqual(minimal)
    rejects(plan, { ...minimal, target: "gpt-6-astra" })
    rejects(plan, { ...minimal, directory: "" })
    rejects(plan, { ...minimal, upToTurn: -1 })
    rejects(plan, { ...minimal, mode: "copy" })
    rejects(plan, { ...minimal, source: "remote" })
    rejects(plan, { ...minimal, location: "" })
  })

  test("execute takes a nonce and answers a job id; cancel and jobs.list name jobs only", () => {
    rejects(input("migrate.execute"), { nonce: "short" })
    rejects(input("migrate.cancel"), { jobID: "1" })
    rejects(output("migrate.execute"), { jobID: "job 1" })
    expect(decode(output("migrate.cancel"), { cancelled: true })).toEqual({ cancelled: true })
    expect(decode(output("jobs.list"), { jobs: [] })).toEqual({ jobs: [] })
    const job = { jobID: JOB, ref: CODEX, step: "reading", startedAt: T }
    expect(decode(OwnImport.Job, job)).toEqual(job)
    rejects(OwnImport.Job, { ...job, step: "compacting" })
    rejects(OwnImport.Job, { ...job, sessionID: "thread-1" })
    const created = OwnImport.JobID.create()
    expect(decode(OwnImport.JobID, created)).toBe(created)
    expect(created).toMatch(/^job_[0-9A-Z]{26}$/)
  })

  test("I2 errors carry the 09 §5.4 data", () => {
    const errors = OwnImport.errors
    expect<ReadonlyArray<string>>([...OwnImport.TargetProblem.literals]).toEqual([
      "unknown_model",
      "account_not_ready",
      "no_tools",
    ])
    expect<ReadonlyArray<string>>([...OwnImport.SummaryFailure.literals]).toEqual([
      "exhausted",
      "needs_reauth",
      "overflow",
      "interrupted",
      "other",
    ])
    rejects(errors.target_unavailable, { model: TARGET, reason: "busy" })
    rejects(errors.summary_failed, { cause: "timeout" })
    rejects(errors.job_busy, {})
    expect(decode(errors.nonce_invalid, {})).toEqual({})
    expect(decode(errors.service_unreachable, {})).toEqual({})
  })

  test("a failed job ends with a declared error type and summary_failed's cause", () => {
    const types = [...OwnImport.JobError.fields.type.literals]
    expect(types.filter((type) => !Object.hasOwn(OwnImport.errors, type))).toEqual([])
    expect(types).toEqual(expect.arrayContaining(["summary_failed", "source_changed", "service_unreachable"]))
    expect(SPEC_METHODS.filter((name) => errorsOf(name as MethodName).includes("summary_failed"))).toEqual([])
    rejects(OwnImport.JobError, { type: "job_busy", message: "x" })
    rejects(OwnImport.JobError, { type: "summary_failed", message: "x", cause: "timeout" })
    const failed = { type: "source_changed", message: "the source was rewritten" }
    expect(decode(OwnImport.JobError, failed)).toEqual(failed)
  })
})

describe("session metadata own.import (09 §4.7)", () => {
  const meta = (value: unknown) => ({ [OwnImport.META_KEY]: value, "own.team": { role: "main", teamID: "tm_1" } })

  test("the import and helper variants decode from a session's metadata", () => {
    const imported = OwnImport.decodeMetadata(meta(importMeta))
    expect<unknown>(imported).toEqual(importMeta)
    expect(imported && OwnImport.isHelper(imported)).toBe(false)
    const helper = OwnImport.decodeMetadata(meta(helperMeta))
    expect<unknown>(helper).toEqual(helperMeta)
    expect(helper && OwnImport.isHelper(helper)).toBe(true)
    // A full import without a boundary: no summarizer and no tail.
    const full = {
      ...Object.fromEntries(
        Object.entries(importMeta).filter(([key]) => key !== "summarizer" && key !== "tailFromTurn"),
      ),
      mode: "full",
      checkpoint: null,
    }
    expect<unknown>(OwnImport.decodeMetadata(meta(full))).toEqual(full)
  })

  test("is JSON (core stores metadata as Schema.Json) and encodes unchanged", () => {
    for (const value of [importMeta, helperMeta]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value)
      expect(roundTrip(codec(OwnImport.Metadata), value)).toEqual(value)
    }
  })

  test("anything else is undefined, never a throw", () => {
    for (const value of [
      undefined,
      null,
      "own.import",
      { ...importMeta, v: 2 },
      { ...importMeta, root: "C:/Users/fixture/.codex" },
      { ...importMeta, sourceID: "../auth.json" },
      { ...importMeta, contentHash: "abc" },
      { ...importMeta, checkpoint: "remote" },
      { ...importMeta, summarizer: "gpt-6-astra" },
      { v: 1, helper: false, jobID: JOB },
      { v: 1, helper: true },
    ])
      expect(OwnImport.decodeMetadata(meta(value))).toBeUndefined()
    expect(OwnImport.decodeMetadata(undefined)).toBeUndefined()
    expect(OwnImport.decodeMetadata({})).toBeUndefined()
  })

  test("a value marked as a helper is a helper, whatever else it carries", () => {
    const both = OwnImport.decodeMetadata(meta({ ...importMeta, helper: true, jobID: JOB }))
    expect<unknown>(both).toEqual(helperMeta)
  })

  test("marked: the key alone decides, for own.accounts' measurement exclusion (09 §4.2)", () => {
    expect(OwnImport.marked(meta(importMeta))).toBe(true)
    expect(OwnImport.marked(meta(helperMeta))).toBe(true)
    expect(OwnImport.marked(meta({ v: 9 }))).toBe(true)
    expect(OwnImport.marked({ "own.team": { role: "main" } })).toBe(false)
    expect(OwnImport.marked({})).toBe(false)
    expect(OwnImport.marked(undefined)).toBe(false)
    expect(OwnImport.marked).toBe(OwnImportRouting.marked)
  })
})
