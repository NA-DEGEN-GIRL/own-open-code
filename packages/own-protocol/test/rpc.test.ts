import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Rpc } from "@opencode/schema/rpc"
import { Account, OwnAccounts, Portable, Preset, SearchKey } from "../src/index.js"
import {
  accountsList,
  ANTH_ACCOUNT,
  cacheState,
  claudeAuthStatus,
  CODEX_ACCOUNT,
  estimate,
  health,
  ledgerLine,
  limitWindow,
  policyFile,
  ratecardsFile,
  roundTrip,
  SESSION,
  SESSION_2,
  sessionBinding,
  trustList,
} from "./fixtures.js"

const Definition = OwnAccounts.Definition
type Definition = OwnAccounts.Definition
type MethodName = keyof Definition["methods"]

/** 02 §9.2, in document order. */
const SPEC_METHODS = [
  "health",
  "accounts.list",
  "quota.snapshot",
  "session.binding",
  "cache.state",
  "ledger.session",
  "accounts.usage",
  // BRW: 내 브라우저 사용's status and setting.
  "browse.set",
  "browse.status",
  "plugin.claudeAuth.status",
  "cache.setTtlMode",
  "switch.estimate",
  "switch.apply",
  "switch.schedule",
  "switch.cancel",
  "switch.undo",
  "switch.state",
  "switch.waitReset",
  "switch.setConfirmOverride",
  "compaction.setSession",
  "session.approval.get",
  "session.approval.set",
  "accounts.add.key",
  // 02 §3.3a (LMT): the local model form's server read.
  "accounts.local.detect",
  "accounts.add.chatgpt.start",
  "accounts.add.chatgpt.status",
  "accounts.add.chatgpt.complete",
  "accounts.add.chatgpt.cancel",
  "accounts.test",
  "accounts.update",
  "accounts.remove.plan",
  "accounts.remove.execute",
  "policy.get",
  "policy.set",
  "ratecards.get",
  "ratecards.set",
  "plugin.claudeAuth.ack",
  "plugin.claudeAuth.install.plan",
  "plugin.claudeAuth.install.execute",
  "plugin.claudeAuth.uninstall.plan",
  "plugin.claudeAuth.uninstall.execute",
  "plugin.claudeAuth.changeSource.plan",
  "plugin.claudeAuth.changeSource.execute",
  "plugin.claudeAuth.importSubscription",
  "plugin.trust.list",
  "plugin.trust.approve.plan",
  "plugin.trust.approve.execute",
  "plugin.trust.revoke",
  "diagnostics.selfTest",
]
/** 07 §8.1, the T0 part (new-session default model). */
const PRESET_METHODS = ["presets.list", "presets.defaults.set"]
/** 07 §8.1, the T1 part: stored presets, and the session's preset, ultra, caps and paid-use consent. */
const PRESET_T1_METHODS = [
  "presets.suggest",
  "presets.set",
  "presets.remove",
  "session.preset.get",
  "session.preset.apply",
  "session.ultra.set",
  "session.preset.raiseOnce",
  "session.preset.consent",
]
/** 02 §4.8: a root session's speed (Fast, Ultrafast), never stored in a preset. */
const SPEED_METHODS = ["session.speed.get", "session.speed.set", "speed.offers"]
/** 06 §10.4 #5: the read the own-web cleanup dialog needs (TG13). */
const WORKTREE_METHODS = ["worktree.inspect"]
/** 09 §5.6: the request price own.import's `migrate.plan` asks for. */
const ESTIMATE_METHODS = ["estimate.request"]
/** 02 §3.9: voice input. */
const VOICE_METHODS = ["voice.get", "voice.set", "voice.key.set", "voice.transcribe"]
/** 03 §18.2: the server's web search service, chosen once in settings instead of in the middle of a task. */
const WEBSEARCH_METHODS = ["websearch.get", "websearch.set"]
/** 02 §9.2 (SP): the web search services' own keys (Brave), in own's vault. */
const SEARCH_KEY_METHODS = ["websearch.key.get", "websearch.key.set"]

/** 04 §8.11.12: the remote Claude relay's consent, per-host switch and the PC-recorded Fast consent (local). */
const CLAUDE_REMOTE_METHODS = [
  "plugin.claudeAuth.remote.ack",
  "plugin.claudeAuth.remote.set",
  "plugin.claudeAuth.fastAck",
]
/** 02 §8.2 step 2a, §8.7 (2026-10-10): the local patch and several Claude accounts. */
const CLAUDE_ACCOUNT_METHODS: ReadonlyArray<MethodName> = [
  "plugin.claudeAuth.patch.plan",
  "plugin.claudeAuth.patch.execute",
  "plugin.claudeAuth.accounts.add.plan",
  "plugin.claudeAuth.accounts.add.execute",
  "plugin.claudeAuth.accounts.add.status",
  "plugin.claudeAuth.accounts.detect",
  "plugin.claudeAuth.accounts.remove.plan",
  "plugin.claudeAuth.accounts.remove.execute",
  "plugin.claudeAuth.default.set",
]
const CLAUDE_SESSION_METHODS: ReadonlyArray<MethodName> = [
  "plugin.claudeAuth.session.get",
  "plugin.claudeAuth.session.set",
]
/** 02 §8.10 (CAG): the Claude Agent route; phase 2 adds the conversation's account, the default and the folder split. */
const CLAUDE_AGENT_METHODS: ReadonlyArray<MethodName> = [
  "claudeAgent.status",
  "claudeAgent.setup",
  "claudeAgent.login",
  "claudeAgent.remove",
  "claudeAgent.limits.refresh",
  "claudeAgent.default.set",
  "claudeAgent.pool.set",
  "claudeAgent.folders.list",
  "claudeAgent.folders.assign",
]
/** 02 §8.10 phase 2: a conversation's Claude Agent account, read and moved in the session's Location. */
const CLAUDE_AGENT_SESSION_METHODS: ReadonlyArray<MethodName> = ["claudeAgent.session.get", "claudeAgent.session.set"]
/** P0-3a (02 §7.8): the opt-in wire evidence capture. */
const CAPTURE_METHODS: ReadonlyArray<MethodName> = [
  "diagnostics.capture.start",
  "diagnostics.capture.stop",
  "diagnostics.capture.status",
]
/** 02 §9.2 "워크스페이스 노트": the workspace notes tab's notes, kept on this PC. */
const NOTES_METHODS: ReadonlyArray<MethodName> = ["notes.list", "notes.get", "notes.put", "notes.remove"]
/** 02 §9.2 "아이디어 노트": the global sticky notes, kept on this PC. */
const IDEAS_METHODS: ReadonlyArray<MethodName> = ["ideas.list", "ideas.put", "ideas.remove"]
/** 02 §9.7 곁질문: side questions about a conversation, answered where it runs. */
const SIDE_METHODS: ReadonlyArray<MethodName> = ["side.ask", "side.get", "side.list", "side.cancel", "side.remove"]
/** 03 §5.1 "기본 대화 폴더": every service's folder for conversations started without a project. */
const CONVERSATION_FOLDER_METHODS: ReadonlyArray<MethodName> = [
  "conversationFolder.get",
  "conversationFolder.set",
  "conversationFolder.ensure",
  "folderPicker.get",
  "folderPicker.set",
  "folderPicker.list",
  "folderPicker.create",
]
/** 03 §4.3 "프로젝트 순서와 고정": every service's own list. */
const PROJECT_LIST_METHODS: ReadonlyArray<MethodName> = ["projectList.get", "projectList.set"]
/** 01 §13 에이전트가 못 여는 파일·폴더 (PP): every service's built-in and user protected paths. */
const PROTECTED_PATH_METHODS: ReadonlyArray<MethodName> = [
  "protectedPaths.get",
  "protectedPaths.add",
  "protectedPaths.remove",
  "protectedPaths.suggest",
  "protectedPaths.patterns",
]
/** 07 §4.5 (CA): the Codex version the ChatGPT accounts' model lists are asked as, and the setting. */
const CODEX_MODELS_METHODS: ReadonlyArray<MethodName> = ["codexModels.get", "codexModels.set", "codexModels.rows"]
/** 02 §7.1.1 리셋권: a ChatGPT account's usage-limit reset credits, read and redeemed after the user confirms. */
const RESET_CREDIT_METHODS: ReadonlyArray<MethodName> = [
  "quota.resetCredits.list",
  "quota.resetCredits.redeem.plan",
  "quota.resetCredits.redeem.execute",
]
/** 02 §4.7.7 (CC-14): the user is looking at the session, which holds idle compaction back. */
const PRESENCE_METHODS: ReadonlyArray<MethodName> = ["session.presence"]
/**
 * 03 §18.14 (SM): the MCP servers own adds, the list's kept switches, the connection test, the import, the read-only
 * summary of the list's source line and 찾아서 설치 (the MCP Registry).
 */
const MCP_METHODS: ReadonlyArray<MethodName> = [
  "mcp.list",
  "mcp.save",
  "mcp.remove",
  "mcp.enable",
  "mcp.test",
  "mcp.import.scan",
  "mcp.import.apply",
  "mcp.summary",
  "mcp.registry.search",
  // 04 §13 (MH): this PC's records of values sent to hosts (a host refuses them, `remote_managed`).
  "mcp.hosts.send",
  "mcp.hosts.unsend",
  "mcp.hosts.view",
]
/** 04 §13 (MH): an SSH host's installed servers; this PC's service answers `mcp_host_only`. */
const MCP_HOST_METHODS: ReadonlyArray<MethodName> = [
  "mcp.host.view",
  "mcp.host.probe",
  "mcp.host.save",
  "mcp.host.remove",
  "mcp.host.test",
  "mcp.host.prefetch",
]
/** 03 §19.6.1 (SG 2026-10-26): the skill switches and scopes (skills global first, per-project exceptions). */
const SKILLSET_METHODS: ReadonlyArray<MethodName> = ["skillset.view", "skillset.switch"]
/** 16 (GH): the GitHub connection's accounts, choices, settings and browser login. */
const GITHUB_METHODS: ReadonlyArray<MethodName> = [
  "github.view",
  "github.add.token",
  "github.device.start",
  "github.device.status",
  "github.device.cancel",
  "github.update",
  "github.remove",
  "github.bind",
  "github.settings.set",
  "github.test",
]
/** 05 §20 (UPD): 설정 > 업데이트, the programs own runs on this PC that the user installs and updates. */
const TOOL_METHODS: ReadonlyArray<MethodName> = [
  "tools.view",
  "tools.settings.set",
  "tools.update.plan",
  "tools.update.execute",
  "tools.update.status",
]
const IMPORT_METHODS = [
  "accounts.import.codex.list",
  "accounts.import.codex.plan",
  "accounts.import.codex.execute",
  "accounts.import.keys.list",
  "accounts.import.keys.plan",
  "accounts.import.keys.execute",
]

/** 02 §9.3. */
const SPEC_EVENTS = [
  "accounts.changed",
  "quota.updated",
  "account.status",
  "cache.state",
  "compaction.due",
  "approval.changed",
  "binding.changed",
  "switch.recorded",
  "switch.scheduled",
  "switch.state",
  "switch.suggested",
  "ledger.step",
  "alert",
  "plugin.status",
  "plugin.trust.changed",
  "presets.changed",
  "session.preset.changed",
  "session.speed.changed",
  "notes.changed",
  "ideas.changed",
  "conversationFolder.changed",
  "folderPicker.changed",
  "projectList.changed",
  "protectedPaths.changed",
  "codexModels.changed",
  "mcp.changed",
  "skillset.changed",
  "claudeAgent.pool",
  "github.changed",
  "side.delta",
  "side.ended",
]

/** Explicit rows of the 02 §9.4 table: error type → methods that must declare it. */
const SPEC_ERRORS: Record<string, ReadonlyArray<MethodName>> = {
  slot_misconfigured: ["switch.estimate", "switch.apply"],
  session_busy: ["plugin.claudeAuth.changeSource.execute", "plugin.claudeAuth.patch.execute"],
  claude_account_unavailable: [
    "plugin.claudeAuth.accounts.add.plan",
    "plugin.claudeAuth.accounts.add.execute",
    "plugin.claudeAuth.changeSource.plan",
    "plugin.claudeAuth.changeSource.execute",
  ],
  estimate_expired: ["switch.apply"],
  no_eligible_target: ["switch.estimate"],
  needs_reauth: ["accounts.test", "switch.apply"],
  probe_failed: ["accounts.add.key", "accounts.test"],
  duplicate_account: ["accounts.add.key"],
  ack_required: [
    "plugin.claudeAuth.install.plan",
    "plugin.claudeAuth.importSubscription",
    "plugin.claudeAuth.ack",
    "plugin.claudeAuth.remote.ack",
    "plugin.claudeAuth.remote.set",
  ],
  policy_denied: ["policy.set", "accounts.update"],
  trust_hash_mismatch: ["plugin.trust.approve.execute"],
  undo_window_closed: ["switch.undo"],
  unsupported_strategy: ["switch.apply", "cache.setTtlMode"],
  invalid_schedule: ["switch.schedule"],
  plugin_not_installed: [
    "plugin.claudeAuth.uninstall.plan",
    "plugin.claudeAuth.uninstall.execute",
    "plugin.claudeAuth.changeSource.plan",
    "plugin.claudeAuth.changeSource.execute",
    "plugin.claudeAuth.importSubscription",
    "plugin.claudeAuth.remote.set",
  ],
  template_unavailable: ["accounts.add.key", "accounts.add.chatgpt.complete", "accounts.update"],
  vault_unavailable: ["accounts.add.key", "accounts.update", "accounts.add.chatgpt.complete", "accounts.test"],
  setting_out_of_range: [
    "compaction.setSession",
    "accounts.update",
    "policy.set",
    "plugin.claudeAuth.changeSource.plan",
  ],
  revert_staged: ["switch.apply"],
  // 07 §8.1
  team_switch_required: ["switch.estimate", "switch.apply"],
  same_company_subscription: ["presets.set", "session.preset.apply"],
  preset_not_found: ["presets.set", "presets.remove", "session.preset.apply"],
  preset_wrong_group: ["presets.set", "session.preset.apply"],
  preset_target_unavailable: ["presets.set", "session.preset.apply"],
  preset_builtin_locked: ["presets.set", "presets.remove"],
  preset_budget_exhausted: ["session.preset.consent"],
  remote_managed: [
    "presets.suggest",
    "presets.set",
    "presets.remove",
    "presets.defaults.set",
    "notes.list",
    "notes.get",
    "notes.put",
    "notes.remove",
    "ideas.list",
    "ideas.put",
    "ideas.remove",
    "codexModels.get",
    "codexModels.set",
    ...MCP_METHODS,
    ...RESET_CREDIT_METHODS,
    ...SKILLSET_METHODS,
  ],
  skillset_invalid: ["skillset.switch"],
  // 16 (GH)
  github_not_found: ["github.update", "github.remove", "github.test"],
  github_token_invalid: ["github.add.token", "github.update"],
  github_unavailable: ["github.add.token", "github.device.start", "github.update"],
  github_invalid: ["github.add.token", "github.device.start", "github.update", "github.bind", "github.settings.set"],
  mcp_name_taken: ["mcp.save", "mcp.import.apply", "mcp.host.save"],
  mcp_not_found: [
    "mcp.save",
    "mcp.remove",
    "mcp.test",
    "mcp.host.save",
    "mcp.host.remove",
    "mcp.host.test",
    "mcp.host.prefetch",
    "mcp.hosts.send",
  ],
  mcp_secret_missing: ["mcp.save", "mcp.test", "mcp.hosts.send"],
  mcp_registry_unavailable: ["mcp.registry.search"],
  mcp_host_only: [
    "mcp.host.view",
    "mcp.host.probe",
    "mcp.host.save",
    "mcp.host.remove",
    "mcp.host.test",
    "mcp.host.prefetch",
  ],
  note_not_found: ["notes.get"],
  note_conflict: ["notes.put", "notes.remove"],
  notes_limit: ["notes.put"],
  idea_conflict: ["ideas.put", "ideas.remove"],
  ideas_limit: ["ideas.put"],
  websearch_unavailable: ["websearch.get", "websearch.set"],
  conversation_folder_unavailable: ["conversationFolder.set", "conversationFolder.ensure"],
  folder_picker_unavailable: ["folderPicker.set"],
  folder_list_unavailable: ["folderPicker.list"],
  folder_create_unavailable: ["folderPicker.create"],
  protected_path_invalid: ["protectedPaths.add"],
  // 02 §7.1.1 리셋권
  not_supported: RESET_CREDIT_METHODS,
  credential_not_ready: RESET_CREDIT_METHODS,
  limit_reset_failed: ["quota.resetCredits.list", "quota.resetCredits.redeem.execute"],
}

const methodNames = Object.keys(Definition.methods) as ReadonlyArray<MethodName>
const errorsOf = (name: MethodName): ReadonlyArray<string> => Object.keys(Definition.methods[name].errors)

describe("own.accounts definition", () => {
  test("has the single RPC id own.accounts", () => {
    expect(Definition.id).toBe("own.accounts")
    expect(OwnAccounts.ID).toBe("own.accounts")
  })

  test("declares exactly the 02 §9.2 methods, the 07 §8.1 preset methods, worktree.inspect, estimate.request, the import extensions, the capture methods, the notes and idea methods, voice input, the web search service, the default conversation folder, the Codex model list version and session presence", () => {
    expect<ReadonlyArray<string>>([...methodNames].sort()).toEqual(
      [
        ...SPEC_METHODS,
        ...PRESET_METHODS,
        ...PRESET_T1_METHODS,
        ...SPEED_METHODS,
        ...WORKTREE_METHODS,
        ...ESTIMATE_METHODS,
        ...IMPORT_METHODS,
        ...CAPTURE_METHODS,
        ...NOTES_METHODS,
        ...IDEAS_METHODS,
        ...SIDE_METHODS,
        ...VOICE_METHODS,
        ...WEBSEARCH_METHODS,
        "image.get",
        "image.clear",
        ...SEARCH_KEY_METHODS,
        ...CONVERSATION_FOLDER_METHODS,
        ...PROJECT_LIST_METHODS,
        ...PROTECTED_PATH_METHODS,
        ...CODEX_MODELS_METHODS,
        ...PRESENCE_METHODS,
        ...RESET_CREDIT_METHODS,
        ...MCP_METHODS,
        ...MCP_HOST_METHODS,
        ...SKILLSET_METHODS,
        ...GITHUB_METHODS,
        ...TOOL_METHODS,
        ...CLAUDE_REMOTE_METHODS,
        ...CLAUDE_ACCOUNT_METHODS,
        ...CLAUDE_SESSION_METHODS,
        ...CLAUDE_AGENT_METHODS,
        ...CLAUDE_AGENT_SESSION_METHODS,
      ].sort(),
    )
  })

  test("declares exactly the 02 §9.3 events, presets.changed and session.preset.changed (07 §8.1)", () => {
    expect(Object.keys(Definition.events).sort()).toEqual([...SPEC_EVENTS].sort())
  })

  test("every method declares internal_error and never an rpc.* error", () => {
    for (const name of methodNames) {
      expect(errorsOf(name)).toContain("internal_error")
      expect(errorsOf(name).some((error) => error.startsWith("rpc."))).toBe(false)
    }
  })

  test("every *.execute method declares nonce_invalid", () => {
    for (const name of methodNames.filter((name) => name.endsWith(".execute")))
      expect(errorsOf(name)).toContain("nonce_invalid")
  })

  test("declares the errors listed in 02 §9.4", () => {
    for (const [error, methods] of Object.entries(SPEC_ERRORS))
      for (const method of methods)
        expect({ method, errors: errorsOf(method) }).toEqual({ method, errors: expect.arrayContaining([error]) })
  })

  test("error data schemas follow 02 §9.4", () => {
    const errors = Definition.methods["policy.set"].errors
    expect(roundTrip(errors.policy_denied, { field: "autoSwitch.subscriptionToApi" })).toEqual({
      field: "autoSwitch.subscriptionToApi",
    })
    const ack = Definition.methods["plugin.claudeAuth.ack"].errors.ack_required
    expect(roundTrip(ack, { reason: "stale" })).toEqual({ reason: "stale" })
    expect(() => Schema.decodeUnknownSync(ack)({ reason: "old" })).toThrow()
    expect(roundTrip(Definition.methods["switch.undo"].errors.undo_window_closed, {})).toEqual({})
  })

  test("every schema is portable (Standard Schema) and still an Effect schema", () => {
    const schemas = [
      ...methodNames.flatMap((name) => {
        const method = Definition.methods[name]
        return [method.input, method.output, ...Object.values(method.errors)]
      }),
      ...Object.values(Definition.events).map((event) => event.schema),
    ]
    for (const schema of schemas) {
      expect(Schema.isSchema(schema)).toBe(true)
      expect(typeof schema["~standard"].validate).toBe("function")
    }
    const validated = Definition.methods.health.output["~standard"].validate(health)
    expect<unknown>(validated).toEqual({ value: health })
    const rejected = Definition.methods.health.output["~standard"].validate({ ...health, guard: "bad" })
    expect("issues" in rejected && rejected.issues !== undefined).toBe(true)
  })

  test("is assignable to Rpc.PortableDefinition with typed inputs, outputs and events", () => {
    const portable: Rpc.PortableDefinition = Definition
    expect(portable.id).toBe("own.accounts")
    const input: Rpc.Input<Definition["methods"]["accounts.import.codex.plan"]["input"]> = { profileID: "p1" }
    const uninstall: Rpc.Input<Definition["methods"]["plugin.claudeAuth.uninstall.execute"]["input"]> = {
      nonce: "0123456789ABCDEFGHJK",
    }
    const handlerInput: Rpc.Output<Definition["methods"]["accounts.import.codex.plan"]["input"]>["mode"] = "linked"
    const code: Rpc.EventData<Definition["events"]["alert"]["schema"]>["code"] = "codex_source_stale"
    expect([input.profileID, uninstall.nonce, handlerInput, code]).toEqual([
      "p1",
      "0123456789ABCDEFGHJK",
      "linked",
      "codex_source_stale",
    ])
  })
})

describe("method examples from 02 §9.2", () => {
  const output = (name: MethodName) => Definition.methods[name].output
  const input = (name: MethodName) => Definition.methods[name].input

  test("read methods", () => {
    expect(roundTrip(output("health"), health)).toEqual(health)
    expect(roundTrip(output("health"), { version: "2.0.18-own.1", buildId: "b7e2c91a", guard: "skew" })).toEqual({
      version: "2.0.18-own.1",
      buildId: "b7e2c91a",
      guard: "skew",
    })
    expect(roundTrip(output("accounts.list"), accountsList)).toEqual(accountsList)
    expect(roundTrip(output("session.binding"), sessionBinding)).toEqual(sessionBinding)
    expect(roundTrip(output("cache.state"), cacheState)).toEqual(cacheState)
    expect(roundTrip(output("plugin.claudeAuth.status"), claudeAuthStatus)).toEqual(claudeAuthStatus)
    expect(roundTrip(output("plugin.trust.list"), trustList)).toEqual(trustList)
    expect(roundTrip(output("quota.snapshot"), { windows: [limitWindow] })).toEqual({
      windows: [limitWindow],
    })
    const exhausted = [
      { accountID: limitWindow.accountID, reason: "subscription_sharing_usage_limit_exceeded", until: 1790003060000 },
    ]
    expect(roundTrip(output("quota.snapshot"), { windows: [], exhausted })).toEqual({ windows: [], exhausted })
    const ledger = {
      steps: [ledgerLine],
      totals: {
        byAccount: {
          [CODEX_ACCOUNT]: {
            requests: 1,
            tokens: { input: 2890, cacheRead: 149120, cacheWrite: 0, output: 812, reasoning: 1204 },
            cost: [{ unit: "credits", amount: 2.39 }],
            hitRate: 0.981,
          },
        },
      },
      switchCount: 0,
    }
    expect(roundTrip(output("ledger.session"), ledger)).toEqual(ledger)
    expect(roundTrip(input("accounts.usage"), { from: 0, to: 1790001234567, groupBy: "hour" })).toEqual({
      from: 0,
      to: 1790001234567,
      groupBy: "hour",
    })
    expect(() => Schema.decodeUnknownSync(input("ledger.session"))({ sessionID: SESSION, limit: 0 })).toThrow()
  })

  test("switch methods", () => {
    const target = { providerID: "own-codex-p1q2", id: "gpt-5.5", variant: "high" }
    expect(roundTrip(output("switch.estimate"), estimate)).toEqual(estimate)
    const apply = {
      sessionID: SESSION,
      estimateID: estimate.estimateID,
      target,
      strategy: "now",
      reason: "manual",
    }
    expect(roundTrip(input("switch.apply"), apply)).toEqual(apply)
    const applied = { state: "COMPACTING", clientAction: { type: "compact", sessionID: SESSION } }
    expect(roundTrip(output("switch.apply"), applied)).toEqual(applied)
    const scheduled = {
      state: "SCHEDULED",
      trigger: "either",
      idleMinutes: 60,
      uncertain: true,
      deadline: 1790008500000,
    }
    expect(roundTrip(output("switch.schedule"), scheduled)).toEqual(scheduled)
    expect(roundTrip(output("switch.waitReset"), { state: "BLOCKED", resumeAt: 1790004120000 })).toEqual({
      state: "BLOCKED",
      resumeAt: 1790004120000,
    })
    expect(roundTrip(input("switch.setConfirmOverride"), { sessionID: SESSION, silentBelowTokens: null })).toEqual({
      sessionID: SESSION,
      silentBelowTokens: null,
    })
    expect(() => Schema.decodeUnknownSync(input("switch.apply"))({ ...apply, strategy: "later" })).toThrow()
    expect(() => Schema.decodeUnknownSync(input("switch.apply"))({ ...apply, reason: "external" })).toThrow()
  })

  test("account management methods", () => {
    const addKey = {
      kind: "anth",
      label: "회사 · prod",
      key: "sk-ant-fake-key",
      color: "teal",
      options: { workspaceName: "prod" },
    }
    expect(roundTrip(input("accounts.add.key"), addKey)).toEqual(addKey)
    expect(() => Schema.decodeUnknownSync(input("accounts.add.key"))({ ...addKey, kind: "codex" })).toThrow()
    expect(() => Schema.decodeUnknownSync(input("accounts.add.key"))({ ...addKey, key: "" })).toThrow()
    const added = {
      account: { id: ANTH_ACCOUNT, providerID: "own-anth-w3p8", status: "ready" },
      test: { ok: true, detected: { workspaceId: "wrkspc_3kd", organizationId: null } },
      sameDomainCandidates: [],
    }
    expect(roundTrip(output("accounts.add.key"), added)).toEqual(added)
    const device = {
      attemptID: "att_01JB0000000000000000000000",
      method: "device",
      verificationURL: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      expiresAt: 1790001900000,
    }
    expect(roundTrip(output("accounts.add.chatgpt.start"), device)).toEqual(device)
    const browser = {
      attemptID: "att_01JB0000000000000000000001",
      method: "browser",
      authorizeURL: "https://auth.openai.com/oauth/authorize?x=1",
    }
    expect(roundTrip(output("accounts.add.chatgpt.start"), browser)).toEqual(browser)
    const siwc = {
      attemptID: "att_01JB0000000000000000000002",
      method: "siwc",
      authorizeURL: "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client",
      expiresAt: 1790001900000,
    }
    expect(roundTrip(output("accounts.add.chatgpt.start"), siwc)).toEqual(siwc)
    expect(OwnAccounts.LoginStart.guards.siwc(Schema.decodeUnknownSync(OwnAccounts.LoginStart)(siwc))).toBe(true)
    expect(() =>
      Schema.decodeUnknownSync(output("accounts.add.chatgpt.start"))({ ...siwc, authorizeURL: undefined }),
    ).toThrow()
    for (const start of [
      { method: "device" },
      { method: "siwc" },
      { method: "siwc", accountID: CODEX_ACCOUNT },
      { method: "siwc", accountID: CODEX_ACCOUNT, consent: true },
      { method: "siwc", consent: true, retryOf: "att_01JB0000000000000000000002" },
    ])
      expect(roundTrip(input("accounts.add.chatgpt.start"), start)).toEqual(start)
    expect(() => Schema.decodeUnknownSync(input("accounts.add.chatgpt.start"))({ method: "sharing" })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(input("accounts.add.chatgpt.start"))({ method: "siwc", consent: "yes" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(input("accounts.add.chatgpt.start"))({ method: "siwc", retryOf: "not-an-attempt" }),
    ).toThrow()
    const denied = { phase: "failed", error: "token_sharing_not_granted" }
    expect(roundTrip(output("accounts.add.chatgpt.status"), denied)).toEqual(denied)
    const status = {
      phase: "authorized",
      identity: { emailMasked: "na***@gmail.com", plan: "plus" },
      duplicateOf: CODEX_ACCOUNT,
    }
    expect(roundTrip(output("accounts.add.chatgpt.status"), status)).toEqual(status)
    const remove = {
      nonce: "0123456789ABCDEFGHJK",
      expiresAt: 1790001420000,
      affectedSessions: [SESSION],
      willShredVault: true,
    }
    expect(roundTrip(output("accounts.remove.plan"), remove)).toEqual(remove)
    const update = { accountID: CODEX_ACCOUNT, pollBalance: false, budget: null }
    expect(roundTrip(input("accounts.update"), update)).toEqual(update)
  })

  test("compat image input and tools: per model on add, per model later, as listed (02 §3.3)", () => {
    const add = {
      kind: "compat",
      label: "Local",
      key: "sk-local-0001",
      options: {
        baseURL: "http://127.0.0.1:11434/v1",
        models: [
          { id: "qwen2.5vl:7b", contextLimit: 32_768, image: "on", tools: "auto" },
          { id: "gemma3:1b", contextLimit: 32_768, tools: "off" },
        ],
      },
    }
    expect(roundTrip(input("accounts.add.key"), add)).toEqual(add)
    const settings = [
      { id: "qwen2.5vl:7b", image: "auto" },
      { id: "gemma3:1b", image: "off", tools: "on" },
    ]
    const update = { accountID: CODEX_ACCOUNT, compatCapabilities: settings }
    expect(roundTrip(input("accounts.update"), update)).toEqual(update)
    expect(() =>
      Schema.decodeUnknownSync(input("accounts.update"))({
        accountID: CODEX_ACCOUNT,
        compatCapabilities: [{ id: "m", image: "yes" }],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(input("accounts.update"))({
        accountID: CODEX_ACCOUNT,
        compatCapabilities: [{ id: "" }],
      }),
    ).toThrow()
    const stored: Account.Compat = {
      outputs: { "qwen2.5vl:7b": { tokens: 8_192, source: "server" } },
      capabilities: {
        "qwen2.5vl:7b": { detected: { image: true, tools: true } },
        "gemma3:1b": { detected: {}, tools: "off" },
      },
    }
    expect(Schema.decodeUnknownSync(Account.Compat)(stored)).toEqual(stored)
    const view: Account.CompatView = {
      models: [
        {
          id: "qwen2.5vl:7b",
          image: { on: true, setting: "auto", detected: true },
          tools: { on: true, setting: "auto", detected: true },
        },
        { id: "gemma3:1b", image: { on: false, setting: "auto" }, tools: { on: false, setting: "off" } },
      ],
    }
    expect(Schema.decodeUnknownSync(Account.CompatView)(view)).toEqual(view)
  })

  test("codex-multi-provider import methods", () => {
    const plan = Schema.decodeUnknownSync(input("accounts.import.codex.plan"))({ profileID: "a1a1a1a1" })
    expect(plan).toEqual({ profileID: "a1a1a1a1", mode: "linked" })
    expect(Schema.decodeUnknownSync(input("accounts.import.codex.plan"))({ profileID: "p", mode: "takeover" })).toEqual(
      {
        profileID: "p",
        mode: "takeover",
      },
    )
    expect(() =>
      Schema.decodeUnknownSync(input("accounts.import.codex.plan"))({ profileID: "p", mode: "copy" }),
    ).toThrow()
    // The server joins the id into a path: anything but a plain directory name is refused at decode.
    for (const profileID of ["..", "a/../b", "a\\b", "", ".hidden"])
      expect(() => Schema.decodeUnknownSync(input("accounts.import.codex.plan"))({ profileID })).toThrow()
    for (const method of ["accounts.import.codex.execute", "accounts.remove.execute"] as const)
      expect(errorsOf(method)).toContain("account_not_found")
    const list = {
      available: true,
      sources: [
        {
          profileID: "a1a1a1a1-0000-4000-8000-000000000001",
          alias: "personal",
          importable: true,
          identity: { emailMasked: "na***@gmail.com", plan: "pro" },
          lastRefresh: "2026-09-26T10:11:12.123456789Z",
          importedAs: null,
        },
        { profileID: "b2b2b2b2", alias: null, importable: false, problem: "missing_tokens" },
      ],
    }
    expect(roundTrip(output("accounts.import.codex.list"), list)).toEqual(list)
    const planned = {
      nonce: "0123456789ABCDEFGHJK",
      expiresAt: 1790001420000,
      profileID: "a1a1a1a1",
      alias: "personal",
      mode: "takeover",
      identity: { emailMasked: "na***@gmail.com" },
      duplicateOf: CODEX_ACCOUNT,
      warnings: ["takeover_supersedes_source"],
    }
    expect(roundTrip(output("accounts.import.codex.plan"), planned)).toEqual(planned)
    const executed = {
      account: {
        ...accountsList.accounts[0],
        connection: {
          type: "oauth",
          method: "codex-takeover",
          source: {
            app: "codex-multi-provider",
            profileID: "a1a1a1a1",
            alias: "personal",
            mode: "takeover",
            superseded: true,
          },
        },
      },
      mode: "takeover",
      reauthenticated: true,
    }
    expect(roundTrip(output("accounts.import.codex.execute"), executed)).toEqual(executed)
    const invalid = Definition.methods["accounts.import.codex.execute"].errors.source_invalid
    expect(roundTrip(invalid, { profileID: "p", reason: "not_chatgpt" })).toEqual({
      profileID: "p",
      reason: "not_chatgpt",
    })
  })

  test("codex-multi-provider saved API key methods (02 §3.2b)", () => {
    const list = {
      available: true,
      keys: [
        {
          providerRef: "legacy:deepseek",
          name: "DeepSeek",
          kind: "ds",
          baseURL: "https://api.deepseek.com",
          models: ["deepseek-flash"],
          keySaved: true,
          importable: true,
          importedAs: null,
        },
        {
          providerRef: "dpapi:207a1ccd-b02d-42f3-b559-8c577bf22e9c",
          name: "Lab",
          kind: null,
          baseURL: "https://lab.example.test/v1",
          models: [],
          keySaved: false,
          importable: false,
          problem: "unsupported_provider",
        },
      ],
    }
    expect(roundTrip(output("accounts.import.keys.list"), list)).toEqual(list)
    // No path and no key on the wire: the server derives the file from the old app's credential ref.
    expect(Schema.decodeUnknownSync(input("accounts.import.keys.plan"))({ providerRef: "legacy:deepseek" })).toEqual({
      providerRef: "legacy:deepseek",
    })
    for (const providerRef of ["", "legacy:../x", "dpapi:C:\\x", "D:\\#Projects\\codex-multi-provider\\profiles"])
      expect(() => Schema.decodeUnknownSync(input("accounts.import.keys.plan"))({ providerRef })).toThrow()
    const planned = {
      nonce: "0123456789ABCDEFGHJK",
      expiresAt: 1790001420000,
      providerRef: "legacy:deepseek",
      name: "DeepSeek",
      kind: "ds",
      label: "DeepSeek (이전 앱)",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-flash",
      keyHint: "sk-…9fQ2",
      duplicateOf: null,
      warnings: ["linked_key_depends_on_source"],
    }
    expect(roundTrip(output("accounts.import.keys.plan"), planned)).toEqual(planned)
    const execute = { nonce: "0123456789ABCDEFGHJK", label: "DeepSeek (이전 앱)", dryRun: true }
    expect(roundTrip(input("accounts.import.keys.execute"), execute)).toEqual(execute)
    const dry = { account: null, dryRun: true, keyHint: "sk-…9fQ2", test: { ok: false, skipped: true } }
    expect(roundTrip(output("accounts.import.keys.execute"), dry)).toEqual(dry)
    const linked = {
      account: {
        ...accountsList.accounts[0],
        kind: "ds",
        providerID: "own-ds-k3y9",
        billing: "prepaid",
        connection: {
          type: "key",
          method: "legacy-key-linked",
          legacyKey: { app: "codex-multi-provider", providerRef: "legacy:deepseek", name: "DeepSeek" },
        },
      },
      dryRun: false,
      keyHint: "sk-…9fQ2",
      test: { ok: true, skipped: false, detected: {} },
    }
    expect(roundTrip(output("accounts.import.keys.execute"), linked)).toEqual(linked)
    const errors = Definition.methods["accounts.import.keys.execute"].errors
    expect(roundTrip(errors.legacy_key_invalid, { providerRef: "legacy:deepseek", reason: "decrypt_failed" })).toEqual({
      providerRef: "legacy:deepseek",
      reason: "decrypt_failed",
    })
    expect(() =>
      Schema.decodeUnknownSync(errors.legacy_key_invalid)({ providerRef: "legacy:deepseek", reason: "nope" }),
    ).toThrow()
    for (const error of ["probe_failed", "duplicate_account", "legacy_key_not_found", "vault_unavailable"])
      expect(errorsOf("accounts.import.keys.execute")).toContain(error)
    for (const method of ["accounts.import.keys.list", "accounts.import.keys.plan", "accounts.import.keys.execute"])
      expect(OwnAccounts.MethodScope[method as MethodName]).toBe("local")
  })

  test("policy, rate cards and plugin methods", () => {
    const compactionDefaults = { codex: { triggerPercent: 90, maxTriggerTokens: null, minReserveTokens: 0 } }
    expect(roundTrip(output("policy.get"), { policy: policyFile, compactionDefaults })).toEqual({
      policy: policyFile,
      compactionDefaults,
    })
    expect(roundTrip(output("ratecards.get"), ratecardsFile)).toEqual(ratecardsFile)
    expect(
      Schema.decodeUnknownSync(input("plugin.claudeAuth.uninstall.execute"))({ nonce: "0123456789ABCDEFGHJK" }),
    ).toEqual({
      nonce: "0123456789ABCDEFGHJK",
      deleteCredential: true,
    })
    expect(
      Schema.decodeUnknownSync(input("plugin.claudeAuth.uninstall.execute"))({
        nonce: "0123456789ABCDEFGHJK",
        deleteCredential: false,
      }),
    ).toEqual({ nonce: "0123456789ABCDEFGHJK", deleteCredential: false })
    expect(() => Schema.decodeUnknownSync(input("plugin.claudeAuth.install.execute"))({ nonce: "short" })).toThrow()
    const restart = { clientAction: { type: "restart-service" } }
    expect(roundTrip(output("plugin.claudeAuth.changeSource.execute"), restart)).toEqual(restart)
    // v0.4: `null` goes back to the default source.
    expect(roundTrip(input("plugin.claudeAuth.changeSource.plan"), { configDir: null })).toEqual({ configDir: null })
    // 02 §8.7 CS: leaving an own login folder for the source is asked for in so many words; a move into another Claude
    // account than the shared one is `mismatch`.
    const leave = { configDir: "C:\\cc", leaveOwnLogin: true }
    expect(roundTrip(input("plugin.claudeAuth.changeSource.plan"), leave)).toEqual(leave)
    const ownLogin = Definition.methods["plugin.claudeAuth.changeSource.execute"].errors.claude_account_unavailable
    expect(roundTrip(ownLogin, { reason: "own_login" })).toEqual({ reason: "own_login" })
    const mismatch = { state: "mismatch", accountID: "acc_claude_slot" }
    expect(roundTrip(output("plugin.claudeAuth.accounts.add.status"), mismatch)).toEqual(mismatch)
    const job = {
      ok: false,
      steps: [
        { name: "download", ok: true },
        { name: "verify", ok: false, error: "integrity mismatch" },
      ],
    }
    expect(roundTrip(output("plugin.claudeAuth.install.execute"), job)).toEqual(job)
    const selfTest = {
      slots: [{ providerID: "own-codex-7k2m", ok: true, problems: [], authSwap: "ok" }],
      secretScan: { ok: true, findings: [] },
      defaultModel: { ok: false, warning: "default_model_own_slot" },
      surface: { ok: true, changed: [] },
    }
    expect(roundTrip(output("diagnostics.selfTest"), selfTest)).toEqual(selfTest)
  })

  test("diagnostics.selfTest agentModels (07 §5.4) passes the portable definition with and without the field", () => {
    const portable = Portable.definition(Definition).methods["diagnostics.selfTest"].output
    const validate = (value: object) => portable["~standard"].validate(value)
    const before = {
      slots: [{ providerID: "own-codex-7k2m", ok: true, problems: [], authSwap: "ok" }],
      secretScan: { ok: true, findings: [] },
      defaultModel: { ok: true },
      surface: { ok: true, changed: [] },
    }
    const removed = {
      ...before,
      agentModels: {
        ok: false,
        removed: [{ agent: "title", model: { providerID: "own-codex-p1q2", id: "gpt-6-luna" } }],
      },
    }
    const clean = { ...before, agentModels: { ok: true, removed: [] } }
    for (const value of [before, removed, clean]) {
      expect<unknown>(validate(value)).toEqual({ value })
      expect(roundTrip(output("diagnostics.selfTest"), value)).toEqual(value)
    }
    const broken = validate({
      ...before,
      agentModels: { ok: true, removed: [{ agent: "title", model: "gpt-6-luna" }] },
    })
    expect("issues" in broken && broken.issues !== undefined).toBe(true)
  })

  test("worktree.inspect (06 §10.4 #5): input, result and its own errors pass the portable definition", () => {
    const method = Portable.definition(Definition).methods["worktree.inspect"]
    const request = {
      projectID: "prj_1",
      root: "D:\\own-open-code",
      directory: "D:\\own-open-code\\.worktrees\\cl-perf",
    }
    expect(roundTrip(input("worktree.inspect"), request)).toEqual(request)
    expect<unknown>(method.input["~standard"].validate(request)).toEqual({ value: request })
    const unscoped = { root: "D:\\r", directory: "D:\\r\\w" }
    for (const broken of [{ ...request, root: "" }, { projectID: "prj_1", root: "D:\\r" }, unscoped])
      expect(() => Schema.decodeUnknownSync(input("worktree.inspect"))(broken)).toThrow()

    const nested = {
      nested: [
        { path: "D:\\own-open-code\\.worktrees\\outer\\.worktrees\\inner", kind: "worktree" },
        { path: "D:\\own-open-code\\.worktrees\\outer\\vendor\\lib", kind: "repository" },
      ],
      scan: "complete",
      lock: null,
      ownLock: false,
      ignored: { entries: [{ path: "vendor/", bytes: 0 }], count: 1, bytes: 0, truncated: false },
    }
    const locked = {
      nested: [],
      scan: "partial",
      lock: { reason: "own.team area:ar_x" },
      ownLock: true,
      ignored: {
        entries: [
          { path: "node_modules/", bytes: 2_987_540_436 },
          { path: ".env.local", bytes: 120 },
        ],
        count: 25,
        bytes: 2_987_541_000,
        truncated: true,
      },
    }
    for (const value of [nested, locked]) {
      expect(roundTrip(output("worktree.inspect"), value)).toEqual(value)
      expect<unknown>(method.output["~standard"].validate(value)).toEqual({ value })
    }
    const wrong = method.output["~standard"].validate({ ...nested, nested: [{ path: "x", kind: "submodule" }] })
    expect("issues" in wrong && wrong.issues !== undefined).toBe(true)

    expect([...errorsOf("worktree.inspect")].sort()).toEqual(["internal_error", "not_found", "not_git"])
    const errors = Definition.methods["worktree.inspect"].errors
    expect(roundTrip(errors.not_found, { directory: request.directory })).toEqual({ directory: request.directory })
    expect(roundTrip(errors.not_git, { directory: request.root })).toEqual({ directory: request.root })
    expect(OwnAccounts.MethodScope["worktree.inspect"]).toBe("read")
    expect(OwnAccounts.MethodLocation["worktree.inspect"]).toBe("control")
  })
})

describe("07 §8.1 preset methods (T1)", () => {
  const output = (name: MethodName) => Definition.methods[name].output
  const input = (name: MethodName) => Definition.methods[name].input
  const SAVED = "pr_01JB0000000000000000000000"
  const ref = { providerID: "own-codex-7k2m", id: "gpt-6-astra", variant: "high" }
  const info = {
    id: SAVED,
    name: "다른 회사 리뷰",
    group: "codex",
    workers: {
      mode: "by-role",
      roles: {
        "own-review": {
          targets: [{ pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } }],
          effort: "inherit",
        },
      },
    },
    delegation: "when-useful",
    caps: { concurrent: 3, perMessage: 6, perSession: 100 },
    ultraCaps: null,
    revision: 2,
  }
  const resolution = {
    main: ref,
    roles: {
      explore: { targets: [], use: ref, fallback: false },
      "own-review": {
        targets: [
          {
            target: { pin: { account: "acc_claude_slot", model: "claude-opus-5-5" } },
            ref: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
          },
        ],
        use: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" },
        fallback: false,
      },
    },
  }
  const binding = {
    presetID: SAVED,
    group: "codex",
    revision: 2,
    appliedAt: 1790000000000,
    entryHash: "fnv1a64:0123456789abcdef",
    team: { teamID: "tm_3f9a0c1b2d4e", role: "owner", accounts: [CODEX_ACCOUNT], pinned: [] },
  }

  test("presets.list, presets.suggest, presets.set, presets.remove, presets.defaults.set", () => {
    const list = {
      groups: [
        {
          group: "codex",
          defaultModel: { id: "gpt-6-astra", variant: "high", source: "auto", basis: "codex-config" },
          presets: [{ ...info, status: "ok" }],
          star: SAVED,
          lighter: { "gpt-6-astra": { model: "gpt-6-luna", source: "auto" } },
          status: "ok",
          label: "codex-config",
        },
      ],
      newSession: "star",
      recent: [SAVED],
      ultraCaps: "recommended",
    }
    expect(roundTrip(output("presets.list"), list)).toEqual(list)
    expect(roundTrip(input("presets.suggest"), { group: "codex", template: "cross-review" })).toEqual({
      group: "codex",
      template: "cross-review",
    })
    expect(() => Schema.decodeUnknownSync(input("presets.suggest"))({ group: "codex", template: "x" })).toThrow()
    const { id: _id, revision: _revision, ...save } = info
    expect(roundTrip(input("presets.set"), { preset: save, dryRun: true })).toEqual({ preset: save, dryRun: true })
    expect(roundTrip(input("presets.set"), { preset: { ...save, id: SAVED } })).toEqual({
      preset: { ...save, id: SAVED },
    })
    expect(() => Schema.decodeUnknownSync(input("presets.set"))({ preset: { ...save, name: "" } })).toThrow()
    const saved = { preset: info, resolution, warnings: [{ code: "paid", place: "own-review" }], dryRun: false }
    expect(roundTrip(output("presets.set"), saved)).toEqual(saved)
    expect(roundTrip(output("presets.remove"), { presetID: SAVED, group: "codex", star: "builtin:codex" })).toEqual({
      presetID: SAVED,
      group: "codex",
      star: "builtin:codex",
    })
    const defaults = {
      group: "codex",
      star: SAVED,
      lighter: { mainModelID: "gpt-6-astra", model: "gpt-6-luna" },
      newSession: "last-light",
      ultraCaps: { concurrent: 10, perMessage: 30, perSession: 300 },
    }
    expect(roundTrip(input("presets.defaults.set"), defaults)).toEqual(defaults)
    expect(roundTrip(input("presets.defaults.set"), { group: "codex", ultraCaps: "large" })).toEqual({
      group: "codex",
      ultraCaps: "large",
    })
    expect(() =>
      Schema.decodeUnknownSync(input("presets.defaults.set"))({
        group: "codex",
        ultraCaps: { concurrent: 0, perMessage: 1, perSession: 1 },
      }),
    ).toThrow()
  })

  test("T4 model pool fields: refreshCards, pool spots, suggest.pool and Resolution.pool are optional additions", () => {
    const { id: _id, revision: _revision, ...save } = info
    const pooled = {
      ...save,
      workers: {
        mode: "same",
        roles: {},
        pool: [
          { key: "gpt-6-luna", model: "gpt-6-luna", card: { name: "GPT-6 Luna", window: 872000, at: 1 } },
          { key: "claude-opus-5-5", model: "claude-opus-5-5", account: "acc_claude_slot", effort: "high" },
        ],
      },
    }
    const set = { preset: pooled, refreshCards: true, repairOf: { model: "gpt-5.5", place: "pool:gpt-5-5" } }
    expect(roundTrip(input("presets.set"), set)).toEqual(set)
    const withPool = {
      ...resolution,
      pool: {
        main: { runs: "main", company: "openai", price: 2, local: false },
        entries: [
          { key: "gpt-6-luna", ref: { providerID: "own-codex-aaaa", id: "gpt-6-luna" }, runs: "main", price: 0.1 },
          { key: "claude-opus-5-5", skip: "unavailable", runs: "subscription", company: "anthropic" },
        ],
      },
    }
    const saved = {
      preset: { ...info, workers: pooled.workers },
      resolution: withPool,
      warnings: [{ code: "paid", place: "pool:deepseek-v4-pro" }],
      dryRun: false,
    }
    expect(roundTrip(output("presets.set"), saved)).toEqual(saved)
    const suggestion = Schema.decodeUnknownSync(Preset.Suggestion)({
      draft: { ...save, name: "" },
      rows: {},
      starters: [],
      pool: {
        candidates: [
          { key: "gpt-6-luna", model: "gpt-6-luna", card: { at: 1 }, runs: "main", company: "openai", released: 1 },
        ],
        recommended: ["gpt-6-luna"],
      },
    })
    expect(suggestion.pool?.recommended).toEqual(["gpt-6-luna"])
    // An older service answers no pool at all.
    const older = { draft: { ...save, name: "" }, rows: {}, starters: [] }
    expect(roundTrip(output("presets.suggest"), older)).toEqual(older)
    expect(Schema.decodeUnknownSync(Preset.Suggestion)(older).pool).toBeUndefined()
    expect(() =>
      Schema.decodeUnknownSync(input("presets.set"))({ preset: save, repairOf: { model: "x", place: "pool" } }),
    ).toThrow()
  })

  test("session.preset.get, session.preset.apply, session.ultra.set, raiseOnce and consent", () => {
    const view = {
      binding,
      preset: info,
      resolution,
      caps: { concurrent: 3, perMessage: 6, perSession: 100 },
      counts: { running: 2, message: 5, session: 17 },
      spend: 0.42,
    }
    expect(roundTrip(output("session.preset.get"), view)).toEqual(view)
    const fresh = {
      binding: null,
      preset: null,
      resolution: null,
      caps: view.caps,
      counts: { running: 0, message: 0, session: 0 },
      spend: 0,
    }
    expect(roundTrip(output("session.preset.get"), fresh)).toEqual(fresh)
    const apply = { sessionID: SESSION, presetID: SAVED, team: binding.team, dryRun: true }
    expect(roundTrip(input("session.preset.apply"), apply)).toEqual(apply)
    expect(roundTrip(input("session.preset.apply"), { sessionID: SESSION, presetID: SAVED, team: null })).toEqual({
      sessionID: SESSION,
      presetID: SAVED,
      team: null,
    })
    const applied = { binding, resolution: null, entry: "written", dryRun: false }
    expect(roundTrip(output("session.preset.apply"), applied)).toEqual(applied)
    expect(
      roundTrip(input("session.ultra.set"), { sessionID: SESSION, on: true, raiseClaude: true, dryRun: true }),
    ).toEqual({ sessionID: SESSION, on: true, raiseClaude: true, dryRun: true })
    const ultra = { on: true, variant: { from: "high", to: "max" }, estimate, dryRun: true }
    expect(roundTrip(output("session.ultra.set"), ultra)).toEqual(ultra)
    const done = {
      on: false,
      variant: { from: "max", to: "high" },
      estimate: null,
      switch: { state: "STEADY" },
      dryRun: false,
    }
    expect(roundTrip(output("session.ultra.set"), done)).toEqual(done)
    expect(roundTrip(input("session.preset.raiseOnce"), { sessionID: SESSION })).toEqual({ sessionID: SESSION })
    expect(roundTrip(output("session.preset.raiseOnce"), { perMessage: 12 })).toEqual({ perMessage: 12 })
    const consent = { sessionID: SESSION, accountID: ANTH_ACCOUNT, allow: true }
    expect(roundTrip(input("session.preset.consent"), consent)).toEqual(consent)
    expect(roundTrip(output("session.preset.consent"), { accountID: ANTH_ACCOUNT, allow: false })).toEqual({
      accountID: ANTH_ACCOUNT,
      allow: false,
    })
  })

  test("02 §4.8: session.speed.get and session.speed.set{dryRun, consent} round-trip; Standard sends no tier", () => {
    const view = {
      sessionID: SESSION,
      root: SESSION,
      choice: "ultrafast",
      effective: "fast",
      tier: "priority",
      offers: [
        {
          choice: "fast",
          tier: "priority",
          wire: "service_tier",
          basis: "account",
          status: "available",
          name: "Fast",
          billing: { type: "plan", included: 2.5, credits: 2 },
        },
        {
          choice: "ultrafast",
          tier: "ultrafast",
          wire: "service_tier",
          basis: "account",
          status: "unavailable",
          reason: "status_400",
        },
      ],
      beta: false,
      served: { requested: "priority", served: "default", downgraded: true, at: 1790000000000 },
    }
    expect(roundTrip(output("session.speed.get"), view)).toEqual(view)
    const claude = {
      sessionID: SESSION,
      root: SESSION,
      choice: "standard",
      effective: "standard",
      tier: null,
      offers: [
        {
          choice: "fast",
          tier: "fast",
          wire: "speed",
          basis: "catalog",
          status: "cooldown",
          until: 1790000060000,
          reason: "status_429",
          billing: { type: "extra", input: 8, output: 40 },
        },
      ],
      consent: "needed",
      beta: true,
    }
    expect(roundTrip(output("session.speed.get"), claude)).toEqual(claude)
    const set = { sessionID: SESSION, speed: "fast", dryRun: true, consent: true }
    expect(roundTrip(input("session.speed.set"), set)).toEqual(set)
    const change = {
      from: "standard",
      to: "fast",
      P: 120_000,
      unit: "USD",
      delta: { lo: 0.02, hi: 0.66, unit: "USD" },
      factor: 2,
      cache: "unknown",
      basis: "rule",
      warnings: ["cache_unverified"],
    }
    const result = { view: claude, change, dryRun: true }
    expect(roundTrip(output("session.speed.set"), result)).toEqual(result)
    expect(roundTrip(output("session.speed.set"), { view, change: null, dryRun: false })).toEqual({
      view,
      change: null,
      dryRun: false,
    })
    expect(() => Schema.decodeUnknownSync(input("session.speed.set"))({ sessionID: SESSION, speed: "turbo" })).toThrow()
    expect([...errorsOf("session.speed.set")].sort()).toEqual(
      ["internal_error", "speed_consent_required", "speed_unavailable"].sort(),
    )
  })

  test("2026-10-10: speed.offers names a main's offers before a session exists, or why it has none", () => {
    const codex = {
      providerID: "own-codex-p1q2",
      modelID: "gpt-6-astra",
      offers: [
        {
          choice: "fast",
          tier: "priority",
          wire: "service_tier",
          basis: "account",
          status: "available",
          billing: { type: "plan", included: 2.5, credits: 2 },
        },
      ],
    }
    expect(roundTrip(input("speed.offers"), { providerID: "own-codex-p1q2", modelID: "gpt-6-astra" })).toEqual({
      providerID: "own-codex-p1q2",
      modelID: "gpt-6-astra",
    })
    expect(roundTrip(output("speed.offers"), codex)).toEqual(codex)
    const deepseek = { providerID: "own-ds-d1", modelID: "deepseek-flash", offers: [], none: "kind" }
    expect(roundTrip(output("speed.offers"), deepseek)).toEqual(deepseek)
    const claude = { providerID: "anthropic", modelID: "claude-opus-5-5", offers: [], consent: "needed", none: "model" }
    expect(roundTrip(output("speed.offers"), claude)).toEqual(claude)
    expect(() => Schema.decodeUnknownSync(output("speed.offers"))({ ...deepseek, none: "plan" })).toThrow()
    // A session the service does not know yet says so, and an older service's view without `none` still decodes.
    const early = {
      sessionID: SESSION,
      root: SESSION,
      choice: "standard",
      effective: "standard",
      tier: null,
      offers: [],
      beta: false,
      none: "session",
    }
    expect(roundTrip(output("session.speed.get"), early)).toEqual(early)
  })

  test("switch.estimate/apply: teamOp and children; busyChildren; team_switch_required", () => {
    const target = { providerID: "own-codex-p1q2", id: "gpt-5.5", variant: "high" }
    const apply = {
      sessionID: SESSION,
      target,
      strategy: "now",
      reason: "manual",
      teamOp: "op_01JB0000000000000000000000",
      children: "after-idle",
    }
    expect(roundTrip(input("switch.apply"), apply)).toEqual(apply)
    expect(roundTrip(input("switch.estimate"), { sessionID: SESSION, target, children: "stop" })).toEqual({
      sessionID: SESSION,
      target,
      children: "stop",
    })
    expect(() => Schema.decodeUnknownSync(input("switch.apply"))({ ...apply, teamOp: "tm_x" })).toThrow()
    expect(() => Schema.decodeUnknownSync(input("switch.apply"))({ ...apply, children: "later" })).toThrow()
    const busy = { ...estimate, busyChildren: { count: 2, accountID: CODEX_ACCOUNT } }
    expect(roundTrip(output("switch.estimate"), busy)).toEqual(busy)
    expect(roundTrip(output("switch.estimate"), { ...estimate, busyChildren: null })).toEqual({
      ...estimate,
      busyChildren: null,
    })
    for (const name of ["switch.estimate", "switch.apply"] as const)
      expect(roundTrip(Definition.methods[name].errors.team_switch_required, { teamID: "tm_3f9a0c1b2d4e" })).toEqual({
        teamID: "tm_3f9a0c1b2d4e",
      })
  })

  test("preset error data (07 §8.1)", () => {
    const set = Definition.methods["presets.set"].errors
    expect(roundTrip(set.same_company_subscription, { accountID: CODEX_ACCOUNT })).toEqual({ accountID: CODEX_ACCOUNT })
    expect(roundTrip(set.preset_not_found, { presetID: SAVED })).toEqual({ presetID: SAVED })
    expect(roundTrip(set.preset_wrong_group, { group: "claude-sub" })).toEqual({ group: "claude-sub" })
    expect(roundTrip(set.preset_target_unavailable, { role: "single" })).toEqual({ role: "single" })
    expect(roundTrip(set.preset_builtin_locked, { presetID: "builtin:codex" })).toEqual({ presetID: "builtin:codex" })
    expect(() => Schema.decodeUnknownSync(set.preset_target_unavailable)({ role: "review" })).toThrow()
    const consent = Definition.methods["session.preset.consent"].errors
    expect(roundTrip(consent.preset_budget_exhausted, { accountID: ANTH_ACCOUNT })).toEqual({ accountID: ANTH_ACCOUNT })
  })

  test("accounts: the login key, compat output caps and server family, and local running windows", () => {
    const view = {
      ...accountsList.accounts[0],
      identity: { ...accountsList.accounts[0]?.identity, login: "sha256:5c1e00" },
      compat: {
        server: { family: "ollama", overflowClassified: false },
        models: [
          {
            id: "qwen3-coder",
            output: { tokens: 32000, source: "fallback" },
            localWindow: { runtime: 4096, needed: 24000, status: "unverified" },
          },
          {
            id: "llama-4",
            output: { tokens: 8192, source: "server" },
            localWindow: { runtime: null, needed: 24000, status: "unknown" },
          },
        ],
      },
    }
    expect(roundTrip(output("accounts.list"), { revision: 1, accounts: [view] })).toEqual({
      revision: 1,
      accounts: [view],
    })
    const addKey = {
      kind: "compat",
      label: "로컬 서버",
      key: "sk-fake",
      options: {
        baseURL: "http://127.0.0.1:11434/v1",
        models: [{ id: "qwen3-coder", contextLimit: 131072, outputLimit: 16384 }],
      },
    }
    expect(roundTrip(input("accounts.add.key"), addKey)).toEqual(addKey)
    expect(() =>
      Schema.decodeUnknownSync(output("accounts.list"))({
        revision: 1,
        accounts: [{ ...view, compat: { ...view.compat, server: { family: "tgi", overflowClassified: true } } }],
      }),
    ).toThrow()
  })

  test("alert codes of 07 §8.1 and 07 §6.2 #8", () => {
    const alert = Definition.events.alert.schema
    for (const code of [
      "preset_needs_repair",
      "preset_entry_dropped",
      "group_default_model_missing",
      "local_window_unverified",
    ]) {
      const data = { eventId: "01JB0000000000000000000000", origin: "global", code, severity: "warning", message: "x" }
      expect(roundTrip(alert, data)).toEqual(data)
    }
  })
})

describe("07 T2 fields: optional, so T1 clients and services keep decoding", () => {
  const output = (name: MethodName) => Definition.methods[name].output
  const input = (name: MethodName) => Definition.methods[name].input
  const SAVED = "pr_01JB0000000000000000000000"

  test("presets.list: one repair notice per gone model, the groups' repair history and retirement dates", () => {
    const list = {
      groups: [
        {
          group: "claude-sub",
          defaultModel: { id: "claude-opus-5-5", source: "auto", basis: "newest" },
          status: "needs_repair",
          history: [
            {
              at: 1790000000000,
              presetID: SAVED,
              place: "own-review",
              from: "gpt-5.5",
              to: { pin: { account: CODEX_ACCOUNT, model: "gpt-6-sol" } },
            },
          ],
          retirements: { "gpt-5.5": 1791936000000 },
        },
      ],
      repairs: [
        {
          model: "gpt-5.5",
          uses: [
            {
              kind: "pin",
              group: "claude-sub",
              presetID: SAVED,
              place: "own-review",
              account: CODEX_ACCOUNT,
              suggestion: "gpt-6-sol",
            },
            { kind: "default", group: "codex", suggestion: "gpt-6-astra" },
          ],
        },
      ],
    }
    expect(roundTrip(output("presets.list"), list)).toEqual(list)
    const t1 = { groups: [{ group: "codex", defaultModel: null }] }
    expect(roundTrip(output("presets.list"), t1)).toEqual(t1)
    expect(() =>
      Schema.decodeUnknownSync(output("presets.list"))({ ...list, repairs: [{ model: "gpt-5.5", uses: [] }] }),
    ).toThrow()
  })

  test("presets.set repairOf records a fix; without it the T1 input stands", () => {
    const save = {
      name: "다른 회사 리뷰",
      group: "claude-sub",
      workers: {
        mode: "by-role",
        roles: {
          "own-review": { targets: [{ pin: { account: CODEX_ACCOUNT, model: "gpt-6-sol" } }], effort: "inherit" },
        },
      },
      delegation: "when-useful",
      caps: { concurrent: 3, perMessage: 6, perSession: 100 },
      ultraCaps: null,
      id: SAVED,
    }
    const fix = { preset: save, repairOf: { model: "gpt-5.5", place: "own-review" } }
    expect(roundTrip(input("presets.set"), fix)).toEqual(fix)
    expect(roundTrip(input("presets.set"), { preset: save })).toEqual({ preset: save })
    expect(() =>
      Schema.decodeUnknownSync(input("presets.set"))({ ...fix, repairOf: { model: "gpt-5.5", place: "review" } }),
    ).toThrow()
  })

  test("session.preset.get main.missing and suggestion", () => {
    const view = {
      binding: null,
      preset: null,
      resolution: null,
      caps: { concurrent: 3, perMessage: 6, perSession: 100 },
      counts: { running: 0, message: 0, session: 0 },
      spend: 0,
    }
    for (const main of [
      { missing: "model", suggestion: { id: "gpt-6-sol", variant: "high" } },
      { missing: "variant", suggestion: { id: "gpt-6-astra", variant: "max" } },
    ])
      expect(roundTrip(output("session.preset.get"), { ...view, main })).toEqual({ ...view, main })
    expect(roundTrip(output("session.preset.get"), view)).toEqual(view)
  })

  test("accounts.list: the template update waiting for refreshCatalog, and the models' addedAt and upstream", () => {
    const view = {
      ...accountsList.accounts[0],
      identity: { ...accountsList.accounts[0]?.identity, login: "sha256:5c1e00" },
      templateUpdate: { detectedAt: "2026-10-02T03:04:05Z", fields: ["variants", "capabilities"] },
      models: [
        { id: "gpt-6.1-sol", addedAt: "2026-10-01T09:00:00Z" },
        { id: "gpt-5.5", upstream: "missing" },
      ],
    }
    expect(roundTrip(output("accounts.list"), { revision: 1, accounts: [view] })).toEqual({
      revision: 1,
      accounts: [view],
    })
    expect(roundTrip(output("accounts.list"), accountsList)).toEqual(accountsList)
    expect(() =>
      Schema.decodeUnknownSync(output("accounts.list"))({
        revision: 1,
        accounts: [{ ...view, models: [{ id: "gpt-5.5", upstream: "renamed" }] }],
      }),
    ).toThrow()
  })

  test("alert codes of the T2 catalog changes", () => {
    const alert = Definition.events.alert.schema
    for (const [code, severity, where] of [
      ["effort_update_drift", "info", { origin: "global" }],
      ["template_update_available", "info", { origin: "global", accountID: CODEX_ACCOUNT }],
      ["session_model_unavailable", "warning", { origin: "session", sessionID: SESSION }],
      ["session_variant_unavailable", "warning", { origin: "session", sessionID: SESSION }],
      ["codex_meta_unavailable", "info", { origin: "global" }],
    ] as const) {
      const data = { eventId: "01JB0000000000000000000000", code, severity, ...where, message: "x" }
      expect(roundTrip(alert, data)).toEqual(data)
    }
  })
})

describe("events from 02 §9.3", () => {
  const eventId = "01JB0000000000000000000000"
  const target = { providerID: "own-codex-p1q2", id: "gpt-5.5", variant: "high" }
  const samples: Record<string, object> = {
    "accounts.changed": { revision: 43 },
    "quota.updated": { accountID: CODEX_ACCOUNT, windows: [limitWindow] },
    "account.status": { accountID: null, attemptID: "att_01JB0000000000000000000000", phase: "awaiting_user" },
    "cache.state": cacheState,
    "compaction.due": {
      sessionID: SESSION,
      inputID: "msg_0123456789abcdef",
      P: 201000,
      triggerTokens: 200000,
      epoch: 2,
    },
    "approval.changed": { sessionID: SESSION, mode: "read-only", patched: [SESSION, SESSION_2] },
    "binding.changed": {
      sessionID: SESSION,
      model: target,
      previous: { providerID: "own-codex-7k2m", id: "gpt-5.5", variant: "high" },
      accountID: CODEX_ACCOUNT,
      reason: "external",
      external: true,
    },
    "switch.recorded": {
      sessionID: SESSION,
      from: null,
      to: target,
      strategy: "now",
      reason: "manual",
      estimate: { lo: 13.5, hi: 13.5, unit: "credits" },
      actual: { cold: 14.1, unit: "credits" },
    },
    "switch.scheduled": {
      sessionID: SESSION,
      target,
      trigger: "compaction",
      idleMinutes: 60,
      uncertain: true,
      deadline: 1790008500000,
    },
    "switch.state": {
      sessionID: SESSION,
      state: "WAIT_SAFE",
      detail: { state: "WAIT_SAFE", target, strategy: "now", reason: "manual" },
    },
    "switch.suggested": {
      sessionID: SESSION,
      reason: "hard",
      candidates: [{ providerID: "own-oai-q9x1", score: 1.2, deltaNow: null, perRequest: 0.02, headroom: 0.8 }],
      continue: true,
    },
    "ledger.step": { line: ledgerLine },
    alert: { code: "flap", severity: "warning", sessionID: SESSION, message: "자동 전환이 너무 잦습니다" },
    "plugin.status": { plugin: "claudeAuth", phase: "installing", step: "verify", ok: true },
    "plugin.trust.changed": { directory: "D:\\tmp\\cloned", status: "blocked_by_plugin", pending: 1 },
    "presets.changed": { removed: ["builtin:codex"] },
    "session.preset.changed": {
      sessionID: SESSION,
      binding: { presetID: "builtin:codex", group: "codex", revision: 0, appliedAt: 1790000000000, entryHash: null },
    },
    "session.speed.changed": {
      sessionID: SESSION,
      choice: "ultrafast",
      effective: "fast",
      tier: "priority",
      reason: "fallback",
    },
    "notes.changed": { workspace: "local:d:\\work\\repo", id: "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f", rev: null },
    "ideas.changed": { id: "6f1c2b8e-0d4a-4f7e-9c1d-2a3b4c5d6e7f", rev: 2 },
    "side.delta": { sessionID: "ses_1", threadID: "side_01JB0000000000000000000000", turn: 0, offset: 12, text: "답의 다음 부분" },
    "side.ended": {
      sessionID: "ses_1",
      threadID: "side_01JB0000000000000000000000",
      index: 1,
      turn: {
        question: "이 함수는 어디서 불려?",
        answer: "`run.ts`에서만 불려요.",
        status: "done",
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_004_000,
        finish: "stop",
        model: { providerID: "own-codex-p1q2", id: "gpt-5.5" },
        tokens: { input: 900, cacheRead: 41_000, cacheWrite: 0, cacheWrite1h: null, output: 120, reasoning: 0 },
        cost: { unit: "credits", amount: 0.4, source: "ratecard" },
      },
    },
    "conversationFolder.changed": {
      folder: {
        path: "D:\\chats",
        defaultPath: "C:\\Users\\me\\Documents\\Own OpenCode",
        custom: true,
        exists: true,
      },
    },
    "folderPicker.changed": { picker: { start: "D:\\projects", home: "C:\\Users\\me" } },
    "projectList.changed": { list: { pinned: ["proj_a"], order: ["proj_b"], orderedAt: 1_790_000_000_000 } },
    "protectedPaths.changed": {
      paths: {
        home: "C:\\Users\\me",
        builtIn: [{ id: "ssh", group: "keys", paths: ["~\\.ssh"], reason: "SSH 개인 키가 있어요" }],
        user: [{ path: "~\\wallet-backups", resolved: "C:\\Users\\me\\wallet-backups" }],
      },
    },
    "codexModels.changed": {
      view: {
        autoVersion: true,
        version: "0.165.0",
        build: "0.164.0",
        latest: { version: "0.165.0", fetchedAt: 1_790_000_000_000 },
        fetchedAt: 1_790_000_000_500,
        rejected: 1,
        accounts: { acc_chatgpt01: 1, acc_chatgpt02: 0 },
      },
    },
    "claudeAgent.pool": {
      pool: { live: 8, cap: 8, over: 0, spares: 0, waiting: [{ sessionID: "ses_waiting", since: 1_790_000_000_000 }] },
    },
  }

  test("every event carries eventId and origin and round-trips", () => {
    for (const name of SPEC_EVENTS) {
      const schema = Definition.events[name as keyof Definition["events"]].schema
      const data = {
        eventId,
        origin:
          name.startsWith("switch.") || name.startsWith("session.") || name.startsWith("side.") || name === "ledger.step"
            ? "session"
            : "global",
        ...samples[name],
      }
      expect(roundTrip(schema, data)).toEqual(data)
      expect(() => Schema.decodeUnknownSync(schema)(samples[name])).toThrow()
    }
  })

  test("alert codes are closed", () => {
    const alert = Definition.events.alert.schema
    expect(() =>
      Schema.decodeUnknownSync(alert)({
        eventId,
        origin: "global",
        code: "mystery",
        severity: "warning",
        message: "x",
      }),
    ).toThrow()
  })

  test("alert codes include the 07 §5.4 subagent gate codes and keep subagent_model_overridden", () => {
    const alert = Definition.events.alert.schema
    const session = { origin: "session", sessionID: SESSION }
    for (const [code, severity, where] of [
      ["subagent_rejected", "info", session],
      ["internal_agent_model_removed", "warning", { origin: "global" }],
      ["subagent_model_overridden", "warning", session],
    ] as const) {
      const data = { eventId, code, severity, ...where, message: "x" }
      expect(roundTrip(alert, data)).toEqual(data)
    }
  })
})

describe("v0.3/v0.4 methods (02 §9.2, §9.5)", () => {
  const output = (name: MethodName) => Definition.methods[name].output
  const input = (name: MethodName) => Definition.methods[name].input

  test("compaction settings: accounts.update, policy.set, compaction.setSession", () => {
    const update = {
      accountID: CODEX_ACCOUNT,
      compaction: { triggerPercent: 60, maxTriggerTokens: null, models: { "gpt-5.5": { minReserveTokens: 32000 } } },
      dryRun: true,
    }
    expect(roundTrip(input("accounts.update"), update)).toEqual(update)
    // Out-of-range values reach the handler (setting_out_of_range), they are not refused at decode.
    expect(
      roundTrip(input("accounts.update"), { accountID: CODEX_ACCOUNT, compaction: { triggerPercent: 95 } }),
    ).toEqual({ accountID: CODEX_ACCOUNT, compaction: { triggerPercent: 95 } })
    expect(roundTrip(input("accounts.update"), { accountID: CODEX_ACCOUNT, compaction: null })).toEqual({
      accountID: CODEX_ACCOUNT,
      compaction: null,
    })
    const impact = {
      sessions: [{ sessionID: SESSION, P: 230000, triggerTokens: 200000, truncates: true, revertStaged: true }],
    }
    const updated = { account: accountsList.accounts[0], compactionImpact: impact }
    expect(roundTrip(output("accounts.update"), updated)).toEqual(updated)

    const patch = {
      patch: {
        compaction: { byKind: { ds: { triggerPercent: 50 }, compat: null, "claude-sub": {} }, keepTokens: 12000 },
      },
      dryRun: true,
    }
    expect(roundTrip(input("policy.set"), patch)).toEqual(patch)
    expect(roundTrip(output("policy.set"), { policy: policyFile, compactionImpact: impact })).toEqual({
      policy: policyFile,
      compactionImpact: impact,
    })

    expect(roundTrip(input("compaction.setSession"), { sessionID: SESSION, triggerTokens: 200000 })).toEqual({
      sessionID: SESSION,
      triggerTokens: 200000,
    })
    expect(roundTrip(input("compaction.setSession"), { sessionID: SESSION, triggerTokens: null })).toEqual({
      sessionID: SESSION,
      triggerTokens: null,
    })
    const view = { compaction: cacheState.compaction }
    expect(roundTrip(output("compaction.setSession"), view)).toEqual(view)
    expect(roundTrip(output("compaction.setSession"), { compaction: null })).toEqual({ compaction: null })
    const range = Definition.methods["compaction.setSession"].errors.setting_out_of_range
    expect(roundTrip(range, { field: "triggerTokens", min: 63000, max: 244799 })).toEqual({
      field: "triggerTokens",
      min: 63000,
      max: 244799,
    })
    expect(roundTrip(Definition.methods["switch.apply"].errors.revert_staged, { sessionID: SESSION })).toEqual({
      sessionID: SESSION,
    })
  })

  test("session approval", () => {
    const state = {
      mode: "read-only",
      rules: [{ action: "edit", resource: "**", effect: "deny" }],
      children: { open: 1 },
    }
    expect(roundTrip(output("session.approval.get"), state)).toEqual(state)
    expect(roundTrip(input("session.approval.set"), { sessionID: SESSION, mode: "full" })).toEqual({
      sessionID: SESSION,
      mode: "full",
    })
    expect(() =>
      Schema.decodeUnknownSync(input("session.approval.set"))({ sessionID: SESSION, mode: "custom" }),
    ).toThrow()
    expect(roundTrip(output("session.approval.set"), { mode: "ask", patched: [SESSION] })).toEqual({
      mode: "ask",
      patched: [SESSION],
    })
  })

  test("session approval: computer use on/off", () => {
    expect(roundTrip(input("session.approval.set"), { sessionID: SESSION, mode: "ask", computerUse: "on" })).toEqual({
      sessionID: SESSION,
      mode: "ask",
      computerUse: "on",
    })
    expect(() =>
      Schema.decodeUnknownSync(input("session.approval.set"))({ sessionID: SESSION, mode: "ask", computerUse: "yes" }),
    ).toThrow()
    const state = {
      mode: "ask",
      rules: [{ action: "computer", resource: "*", effect: "allow" }],
      children: { open: 0 },
      browserTool: "on",
      computerUse: "on",
    }
    expect(roundTrip(output("session.approval.get"), state)).toEqual(state)
    expect(roundTrip(output("session.approval.set"), { mode: "ask", patched: [SESSION], computerUse: "off" })).toEqual({
      mode: "ask",
      patched: [SESSION],
      computerUse: "off",
    })
  })
})

describe("estimate.request (09 §5.6)", () => {
  const method = Definition.methods["estimate.request"]
  const portable = Portable.definition(Definition).methods["estimate.request"]
  const target = { providerID: "own-codex-7k2m", id: "gpt-6-astra", variant: "high" }
  const request = {
    target,
    requests: [
      { prompt: 152_000, output: 12_000 },
      { prompt: 164_000, output: 2_000, cachedPrefix: 152_000 },
    ],
  }
  const measured = {
    unit: "credits",
    delta: { lo: 0.8, hi: 1.1, unit: "credits" },
    quota: { window: "codex.primary", percent: { lo: 2, hi: 4 }, state: "partial" },
    remaining: { fiveHour: 61.5, weekly: null },
    Z: 13_250.5,
    zSource: "measured",
    exchange: 3_400,
    window: 272_000,
    ceiling: 244_800,
  }
  /** A local model: no rate, no limit windows, no catalog limit. */
  const unknown = {
    unit: "USD",
    delta: null,
    quota: null,
    remaining: null,
    Z: 12_000,
    zSource: "default",
    exchange: 3_000,
    window: null,
    ceiling: null,
  }

  test("input and output pass the portable definition unchanged", () => {
    expect(roundTrip(method.input, request)).toEqual(request)
    expect<unknown>(portable.input["~standard"].validate(request)).toEqual({ value: request })
    expect(roundTrip(method.input, { target, requests: [] })).toEqual({ target, requests: [] })
    // own.import's picked account (09 §4.5, the fifth limits review): optional, an account id.
    const picked = {
      target: { providerID: "anthropic", id: "claude-opus-5-5" },
      requests: [],
      accountID: "acc_claude_two",
    }
    expect(roundTrip(method.input, picked)).toEqual(picked)
    expect<unknown>(portable.input["~standard"].validate(picked)).toEqual({ value: picked })
    for (const value of [measured, unknown]) {
      expect(roundTrip(method.output, value)).toEqual(value)
      expect<unknown>(portable.output["~standard"].validate(value)).toEqual({ value })
    }
  })

  test("rejects negative or fractional token counts, a missing target and more than 64 requests", () => {
    const decode = Schema.decodeUnknownSync(method.input)
    for (const broken of [
      { target, requests: [{ prompt: -1, output: 0 }] },
      { target, requests: [{ prompt: 1.5, output: 0 }] },
      { target, requests: [{ prompt: 1, output: 0, cachedPrefix: -2 }] },
      { requests: [] },
      { target, requests: Array.from({ length: 65 }, () => ({ prompt: 1, output: 1 })) },
      { target, requests: [], accountID: "claude-two" },
    ])
      expect(() => decode(broken)).toThrow()
    const encode = Schema.encodeUnknownSync(method.output)
    expect(() => encode({ ...measured, zSource: "guessed" })).toThrow()
    expect(() => encode({ ...measured, window: 0 })).toThrow()
  })

  test("declares account_not_found and slot_misconfigured; read at the control location", () => {
    expect([...errorsOf("estimate.request")].sort()).toEqual([
      "account_not_found",
      "internal_error",
      "slot_misconfigured",
    ])
    expect(
      roundTrip(method.errors.slot_misconfigured, { providerID: target.providerID, problems: ["no_template"] }),
    ).toEqual({ providerID: target.providerID, problems: ["no_template"] })
    expect([OwnAccounts.MethodScope["estimate.request"], OwnAccounts.MethodLocation["estimate.request"]]).toEqual([
      "read",
      "control",
    ])
  })
})

describe("routing tables (02 §9.1)", () => {
  test("every method has a scope; the counts follow the 02 §9.1 table", () => {
    const scopes = OwnAccounts.MethodScope
    expect(Object.keys(scopes).sort()).toEqual([...methodNames].sort())
    const count = (scope: OwnAccounts.Scope) => Object.values(scopes).filter((value) => value === scope).length
    // 07 §8.1 adds `presets.list` (read) and `presets.defaults.set` (admin, so a phone can set it too); 06 §10.4 #5
    // adds `worktree.inspect` (read).
    // T1 (07 §8.1): presets.suggest and session.preset.get (read), session.preset.apply / session.ultra.set /
    // session.preset.consent (switch), presets.set / presets.remove (admin), session.preset.raiseOnce (prompt).
    // P0-3a (02 §7.8): diagnostics.capture.{start,stop,status} (local).
    // 02 §4.8: session.speed.get (read), session.speed.set (switch, like ultra); speed.offers (read, 2026-10-10).
    // 09 §5.6: estimate.request (read).
    // 02 §9.2 notes: notes.list and notes.get (read), notes.put and notes.remove (prompt).
    // 02 §9.2 아이디어 노트: ideas.list (read), ideas.put and ideas.remove (prompt).
    // 02 §3.9: voice.get (read), voice.set (admin), voice.key.set (local), voice.transcribe (prompt: paid minutes).
    // 04 §8.11.12: plugin.claudeAuth.remote.{ack,set} and plugin.claudeAuth.fastAck (local).
    // 03 §18.2: websearch.get (read), websearch.set (admin: it sends the agent's queries to a third party).
    // 02 §8.7 (2026-10-10): the patch and Claude account methods (local), session.get (read), session.set (switch).
    // 03 §5.1: conversationFolder.get (read), set (admin, like the voice settings), ensure (prompt: a new conversation);
    // 03 §18.3: folderPicker.get (read), set (admin); list and create (prompt: steps of opening a folder to talk in;
    // core's own listing needs the device scope `files`, so not `read`).
    // 07 §4.5 (CA): codexModels.get (read), set (admin, like the voice settings); rows (local: own.harness's catalog
    // in this process, 10 §6.14).
    // 02 §9.2 (SP): websearch.key.get (read), websearch.key.set (local: a key goes into the vault from this PC only).
    // 02 §4.7.7 (CC-14): session.presence (read: it only holds idle compaction back).
    // 03 §18.14 (SM): mcp.enable (admin, like the web search choice), mcp.summary (read: names and scopes only), the
    // other seven mcp.* methods (local). 04 §13 (MH): mcp.host.view and mcp.hosts.view (read: names, states, ids), the
    // other seven (local: they install, start, fetch or send values; never from a phone or another PC).
    // 02 §7.1.1 리셋권: quota.resetCredits.list (admin: a request with the account's login, like accounts.test), the
    // redeem plan and execute (local: a credit is spent for good, so never from a phone or another PC).
    // 03 §19.6.1 (SG): skillset.view (read: ids, names and folders, like the skills list), skillset.switch (admin, like
    // the MCP list's switch).
    // 02 §8.10 (CAG): claudeAgent.status and limits.refresh (read), setup, login and remove (local); phase 2:
    // claudeAgent.session.get and folders.list (read), session.set and default.set (switch, like the Claude slot's),
    // folders.assign (local: it moves login folders on this PC); phase 3: pool.set (admin, a setting like the policy).
    // 16 (GH): github.view (read: names, logins and folders, never a token), github.bind (admin, like the MCP list's
    // switch), the other eight github.* methods (local: tokens, the write switch and the program own starts).
    // 02 §3.3a (LMT): accounts.local.detect (local: it may carry a key typed in the add form).
    // 02 §9.6 (IM): image.get (read: labels, used-up marks and limits, never a key), image.clear (admin, a setting).
    // 05 §20 (UPD): the five tools.* methods (local: this PC's program paths, and an update runs a program here).
    // 01 §13 (PP): protectedPaths.get and patterns (read), add, remove and suggest (local, like "항상 허용").
    // BRW: browse.status (read: a path, never the browser) and browse.set (local: the program runs on this PC).
    // 02 §9.7 곁질문: side.get and side.list (read: the conversation's own text), side.ask, side.cancel and side.remove
    // (prompt: asking spends the conversation's account like a prompt).
    // 03 §4.3: projectList.get (read, like the session list), projectList.set (prompt, like pinning a conversation).
    expect([count("read"), count("switch"), count("admin"), count("local"), count("prompt")]).toEqual([
      47, 17, 19, 80, 13,
    ])
    expect(methodNames).toHaveLength(176)
    expect(SIDE_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["prompt", "session"],
      ["read", "session"],
      ["read", "session"],
      ["prompt", "session"],
      ["prompt", "session"],
    ])
    expect([OwnAccounts.EventOrigin["side.delta"], OwnAccounts.EventOrigin["side.ended"]]).toEqual(["session", "session"])
    expect(PROTECTED_PATH_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "control"],
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
      ["read", "control"],
    ])
    expect(OwnAccounts.EventOrigin["protectedPaths.changed"]).toBe("global")
    expect(
      (["image.get", "image.clear"] as const).map((name) => [scopes[name], OwnAccounts.MethodLocation[name]]),
    ).toEqual([
      ["read", "control"],
      ["admin", "control"],
    ])
    expect(CLAUDE_AGENT_METHODS.map((name) => OwnAccounts.MethodLocation[name])).toEqual(
      CLAUDE_AGENT_METHODS.map(() => "control"),
    )
    expect(CLAUDE_AGENT_SESSION_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "session"],
      ["switch", "session"],
    ])
    expect(RESET_CREDIT_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["admin", "control"],
      ["local", "control"],
      ["local", "control"],
    ])
    expect(SKILLSET_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "control"],
      ["admin", "control"],
    ])
    expect(OwnAccounts.EventOrigin["skillset.changed"]).toBe("global")
    expect(MCP_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
      ["admin", "control"],
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
      ["read", "control"],
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
      ["read", "control"],
    ])
    expect(MCP_HOST_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "control"],
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
      ["local", "control"],
    ])
    expect(OwnAccounts.EventOrigin["mcp.changed"]).toBe("global")
    expect([scopes["session.presence"], OwnAccounts.MethodLocation["session.presence"]]).toEqual(["read", "session"])
    expect([scopes["websearch.get"], scopes["websearch.set"]]).toEqual(["read", "admin"])
    expect(
      SEARCH_KEY_METHODS.map((name) => [scopes[name as MethodName], OwnAccounts.MethodLocation[name as MethodName]]),
    ).toEqual([
      ["read", "control"],
      ["local", "control"],
    ])
    expect(CONVERSATION_FOLDER_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "control"],
      ["admin", "control"],
      ["prompt", "control"],
      ["read", "control"],
      ["admin", "control"],
      ["prompt", "control"],
      ["prompt", "control"],
    ])
    expect(OwnAccounts.EventOrigin["conversationFolder.changed"]).toBe("global")
    expect(OwnAccounts.EventOrigin["folderPicker.changed"]).toBe("global")
    expect(PROJECT_LIST_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "control"],
      ["prompt", "control"],
    ])
    expect(OwnAccounts.EventOrigin["projectList.changed"]).toBe("global")
    expect(CODEX_MODELS_METHODS.map((name) => [scopes[name], OwnAccounts.MethodLocation[name]])).toEqual([
      ["read", "control"],
      ["admin", "control"],
      ["local", "control"],
    ])
    expect(OwnAccounts.EventOrigin["codexModels.changed"]).toBe("global")
    for (const name of CLAUDE_ACCOUNT_METHODS)
      expect(scopes[name]).toBe(name === "plugin.claudeAuth.default.set" ? "switch" : "local")
    expect(scopes["plugin.claudeAuth.session.get"]).toBe("read")
    expect(scopes["plugin.claudeAuth.session.set"]).toBe("switch")
    expect([scopes["voice.get"], scopes["voice.set"], scopes["voice.key.set"], scopes["voice.transcribe"]]).toEqual([
      "read",
      "admin",
      "local",
      "prompt",
    ])
    for (const name of CLAUDE_REMOTE_METHODS) expect(scopes[name as MethodName]).toBe("local")
    expect(scopes["estimate.request"]).toBe("read")
    expect(scopes["session.speed.get"]).toBe("read")
    expect(scopes["speed.offers"]).toBe("read")
    expect(scopes["session.speed.set"]).toBe("switch")
    for (const name of CAPTURE_METHODS) expect(scopes[name]).toBe("local")
    expect(scopes["presets.defaults.set"]).toBe("admin")
    // `switch.estimate` has side effects (PLANNED, secret prefetch), so it is not a read.
    expect(scopes["switch.estimate"]).toBe("switch")
    // By design (05 §13.5, 02 §4.7.2): own.accounts admits these compactions itself, so a device with `switch` but
    // without `prompt` can cause one through them; HTTP `POST /compact` stays `prompt`.
    expect(scopes["switch.apply"]).toBe("switch")
    expect(scopes["compaction.setSession"]).toBe("switch")
    expect(scopes["accounts.update"]).toBe("local")
    expect(scopes["accounts.test"]).toBe("admin")
  })

  test("session methods go to the session's directory, everything else to the control location", () => {
    const locations = OwnAccounts.MethodLocation
    expect(Object.keys(locations).sort()).toEqual([...methodNames].sort())
    const session: ReadonlyArray<string> = methodNames.filter((name) => locations[name] === "session").sort()
    expect(session).toEqual(
      [
        "session.binding",
        "cache.state",
        "cache.setTtlMode",
        "ledger.session",
        "switch.estimate",
        "switch.apply",
        "switch.schedule",
        "switch.cancel",
        "switch.undo",
        "switch.state",
        "switch.waitReset",
        "switch.setConfirmOverride",
        "compaction.setSession",
        "session.presence",
        "session.approval.get",
        "session.approval.set",
        "session.preset.get",
        "session.preset.apply",
        "session.ultra.set",
        "session.preset.raiseOnce",
        "session.preset.consent",
        "session.speed.get",
        "session.speed.set",
        ...SIDE_METHODS,
        ...CLAUDE_SESSION_METHODS,
        ...CLAUDE_AGENT_SESSION_METHODS,
      ].sort(),
    )
    const control = methodNames.filter((name) => locations[name] === "control")
    for (const name of control) expect(name.startsWith("switch.") || name.startsWith("session.")).toBe(false)
  })

  test("event origins match 02 §9.3", () => {
    expect(Object.keys(OwnAccounts.EventOrigin).sort()).toEqual(Object.keys(Definition.events).sort())
    expect(OwnAccounts.EventOrigin["accounts.changed"]).toBe("global")
    expect(OwnAccounts.EventOrigin["compaction.due"]).toBe("session")
    expect(OwnAccounts.EventOrigin["presets.changed"]).toBe("global")
    expect(OwnAccounts.EventOrigin["session.preset.changed"]).toBe("session")
  })

  test("07 §8.1: every T1 preset method and event has its scope, location and origin", () => {
    const table = Object.fromEntries(
      PRESET_T1_METHODS.map((name) => [
        name,
        [OwnAccounts.MethodScope[name as MethodName], OwnAccounts.MethodLocation[name as MethodName]],
      ]),
    )
    expect(table).toEqual({
      "presets.suggest": ["read", "control"],
      "presets.set": ["admin", "control"],
      "presets.remove": ["admin", "control"],
      "session.preset.get": ["read", "session"],
      "session.preset.apply": ["switch", "session"],
      "session.ultra.set": ["switch", "session"],
      "session.preset.raiseOnce": ["prompt", "session"],
      "session.preset.consent": ["switch", "session"],
    })
    expect([OwnAccounts.MethodScope["presets.list"], OwnAccounts.MethodLocation["presets.list"]]).toEqual([
      "read",
      "control",
    ])
    expect([
      OwnAccounts.MethodScope["presets.defaults.set"],
      OwnAccounts.MethodLocation["presets.defaults.set"],
    ]).toEqual(["admin", "control"])
  })
})

describe("03 §18.2 여러 서비스 함께 (MS): the multi choice and the selection", () => {
  const output = (name: MethodName) => Definition.methods[name].output
  const input = (name: MethodName) => Definition.methods[name].input

  test("websearch.set takes multi with or without services; websearch.get carries the selection", () => {
    const choice = { choice: { type: "multi", services: ["own-chatgpt", "exa"] } }
    expect(roundTrip(input("websearch.set"), choice)).toEqual(choice)
    expect(roundTrip(input("websearch.set"), { choice: { type: "multi" } })).toEqual({ choice: { type: "multi" } })
    for (const services of [[], [""], Array.from({ length: 33 }, (_, index) => `s${index}`)])
      expect(() => Schema.decodeUnknownSync(input("websearch.set"))({ choice: { type: "multi", services } })).toThrow()
    const state = {
      choice: { type: "multi" },
      keys: { exa: "key" },
      multi: { services: ["own-chatgpt", "parallel"], custom: true },
    }
    expect(roundTrip(output("websearch.get"), state)).toEqual(state)
    expect(roundTrip(output("websearch.set"), { keys: {} })).toEqual({ keys: {} })
  })
})

describe("02 §9.2 search keys in own's vault (SP, SK): Brave and core's five keyless services", () => {
  const output = (name: MethodName) => Definition.methods[name].output
  const input = (name: MethodName) => Definition.methods[name].input

  test("websearch.key.set takes every service's key or null; websearch.key.get lists every service", () => {
    for (const service of SearchKey.Service.literals) {
      const set = { service, key: `fake-${service}-key-0001` }
      expect(roundTrip(input("websearch.key.set"), set)).toEqual(set)
      expect(roundTrip(input("websearch.key.set"), { service, key: null })).toEqual({ service, key: null })
    }
    for (const bad of [
      { service: "serper", key: "fake" },
      { service: "exa", key: "" },
      { service: "exa", key: "k".repeat(SearchKey.MAX_KEY_CHARS + 1) },
      { service: "exa" },
    ])
      expect(() => Schema.decodeUnknownSync(input("websearch.key.set"))(bad)).toThrow()
    const view = {
      keys: SearchKey.Service.literals.map((service) =>
        service === "exa" ? { service, configured: true, keyHint: "…a1B2" } : { service, configured: false },
      ),
      vault: "ok",
    }
    expect(roundTrip(output("websearch.key.get"), view)).toEqual(view)
    expect(roundTrip(output("websearch.key.set"), { keys: [], vault: "unavailable" })).toEqual({
      keys: [],
      vault: "unavailable",
    })
  })

  test("the keyed variants: core's five keyless services under own's ids, Brave under its own; vault items", () => {
    expect(SearchKey.Service.literals).toEqual(["brave", "exa", "firecrawl", "parallel", "tavily", "tinyfish"])
    expect(SearchKey.KEYED.map(SearchKey.providerID)).toEqual([
      "own-exa",
      "own-firecrawl",
      "own-parallel",
      "own-tavily",
      "own-tinyfish",
    ])
    expect(SearchKey.providerID("brave")).toBe("brave")
    expect(SearchKey.Service.literals.map(SearchKey.keyID)).toEqual([
      "websearch-brave",
      "websearch-exa",
      "websearch-firecrawl",
      "websearch-parallel",
      "websearch-tavily",
      "websearch-tinyfish",
    ])
    expect(SearchKey.isKeyed("exa")).toBe(true)
    expect(SearchKey.isKeyed("brave")).toBe(false)
    expect(SearchKey.isKeyed("own-exa")).toBe(false)
  })
})

describe("scopeOf: what one call needs with its input (MUX 2026-11-06)", () => {
  test("session.approval.set picks any mode with prompt (MUX-15), the browser tool on too (MBR); the rest stays admin", () => {
    expect(OwnAccounts.MethodScope["session.approval.set"]).toBe("admin")
    const set = (input: unknown) => OwnAccounts.scopeOf("session.approval.set", input)
    expect(set({ sessionID: "ses_1", mode: "ask" })).toBe("prompt")
    expect(set({ sessionID: "ses_1", mode: "read-only" })).toBe("prompt")
    expect(set({ sessionID: "ses_1", mode: "full" })).toBe("prompt")
    expect(set({ sessionID: "ses_1", mode: "ask", browserTool: "on" })).toBe("prompt")
    expect(set({ sessionID: "ses_1", mode: "full", browserTool: "on" })).toBe("prompt")
    expect(set({ sessionID: "ses_1", mode: "ask", browserTool: "off" })).toBe("admin")
    expect(set({ sessionID: "ses_1", mode: "ask", browserTool: "on", computerUse: "on" })).toBe("admin")
    expect(set({ sessionID: "ses_1", mode: "ask", browserTool: "on", browse: "on" })).toBe("local")
    expect(set({ sessionID: "ses_1", mode: "custom", browserTool: "on" })).toBe("admin")
    expect(set({ sessionID: "ses_1", mode: "ask", computerUse: "off" })).toBe("admin")
    expect(set({ sessionID: "ses_1", mode: "custom" })).toBe("admin")
    expect(set(undefined)).toBe("admin")
    expect(set("ask")).toBe("admin")
  })

  test("other methods keep their table scope", () => {
    expect(OwnAccounts.scopeOf("switch.apply", { sessionID: "ses_1", mode: "ask" })).toBe("switch")
    expect(OwnAccounts.scopeOf("policy.set", {})).toBe("admin")
  })
})
