export * as Register from "./register.js"

import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/schema/rpc"
import { OwnAccounts, Portable } from "@own/protocol"
import { Build } from "../build.js"
import type { Deps } from "../deps.js"
import type { Guard } from "../health/guard.js"
import type { Modules } from "../modules.js"
import { AccountsRpc } from "./accounts.js"
import { ClaudeRpc } from "./claude.js"
import { ClaudeAgentRpc } from "./claude-agent.js"
import { CodexModelsRpc } from "./codex-models.js"
import { ConversationFolderRpc } from "./conversation-folder.js"
import { BrowseRpc } from "./browse.js"
import { DiagnosticsRpc } from "./diagnostics.js"
import { EstimateRpc } from "./estimate.js"
import { GitHubRpc } from "./github.js"
import { HealthRpc } from "./health.js"
import { IdeasRpc } from "./ideas.js"
import { ImageRpc } from "./image.js"
import { LimitResetRpc } from "./limit-reset.js"
import { LoginsRpc } from "./logins.js"
import { McpRpc } from "./mcp.js"
import { NotesRpc } from "./notes.js"
import { PluginsRpc } from "./plugins.js"
import { PresetsRpc } from "./presets.js"
import { ProjectListRpc } from "./project-list.js"
import { ProtectedPathsRpc } from "./protected-paths.js"
import { SwitchRpc } from "./switch.js"
import { SessionPresetRpc } from "./session-preset.js"
import { SideRpc } from "./side.js"
import { SpeedRpc } from "./speed.js"
import { SearchKeyRpc } from "./search-key.js"
import { SkillsetRpc } from "./skillset.js"
import { ToolUpdatesRpc } from "./tool-updates.js"
import type { RpcTypes } from "./types.js"
import { UsageRpc } from "./usage.js"
import { VoiceRpc } from "./voice.js"
import { WebSearchRpc } from "./websearch.js"
import { WorktreeRpc } from "./worktree.js"

/**
 * Every method of `OwnAccounts.Definition`, assembled from the group files. The return type makes a missing method
 * a compile error; adding a method to the protocol means adding it to exactly one group.
 */
export function handlers(modules: Modules.All, deps: Deps): RpcTypes.Handlers {
  return {
    ...HealthRpc.handlers(modules),
    ...DiagnosticsRpc.handlers(modules),
    ...AccountsRpc.handlers(modules),
    ...LoginsRpc.handlers(modules),
    ...SwitchRpc.handlers(modules),
    ...EstimateRpc.handlers(modules),
    ...UsageRpc.handlers(modules),
    ...LimitResetRpc.handlers(modules),
    ...PluginsRpc.handlers(modules),
    ...ClaudeRpc.handlers(modules, deps),
    ...ClaudeAgentRpc.handlers(modules),
    ...PresetsRpc.handlers(modules),
    ...SessionPresetRpc.handlers(modules),
    ...SpeedRpc.handlers(modules),
    ...WorktreeRpc.handlers(deps),
    ...NotesRpc.handlers(deps),
    ...IdeasRpc.handlers(deps),
    ...VoiceRpc.handlers(deps),
    ...WebSearchRpc.handlers(deps),
    ...ImageRpc.handlers(modules, deps),
    ...BrowseRpc.handlers(deps),
    ...SearchKeyRpc.handlers(deps),
    ...ConversationFolderRpc.handlers(deps),
    ...ProjectListRpc.handlers(deps),
    ...ProtectedPathsRpc.handlers(modules, deps),
    ...CodexModelsRpc.handlers(modules),
    ...McpRpc.handlers(deps),
    ...SkillsetRpc.handlers(deps),
    ...GitHubRpc.handlers(deps),
    ...ToolUpdatesRpc.handlers(deps),
    ...SideRpc.handlers(modules),
  }
}

/**
 * Methods a remote service answers with `remote_managed` (04 §16.5): accounts, policy, rate cards, presets and the
 * Claude slot are managed on the local PC and reach the host through the mirror. Presets arrive with it since T3
 * (07 §8.1 원격): a remote service lists and applies the mirrored ones, but suggesting, saving and removing presets
 * and changing their defaults stay the local PC's. Codex and old-app key imports read local files, so they are
 * refused too (04 §8.10). The workspace notes live on this PC whatever server the project is on (02 §9.2), so a
 * remote service refuses them as well, like the idea notes, which belong to no project at all. Voice input (02 §3.9) is this PC's too: its keys are in this PC's vault and the
 * gateway never relays it to a host. So are the web search services' keys (02 §9.2). A remote service fetches no Codex
 * model list, so the Codex version setting (07 §4.5, CA) is this PC's as well, and so are ChatGPT's reset credits
 * (02 §7.1.1): a host neither reads nor redeems them.
 */
export const REMOTE_MANAGED = [
  "accounts.add.key",
  "accounts.local.detect",
  // BRW: the program runs on this PC and drives its browser; a host's service never runs it.
  "browse.set",
  "accounts.add.chatgpt.start",
  "accounts.add.chatgpt.status",
  "accounts.add.chatgpt.complete",
  "accounts.add.chatgpt.cancel",
  "accounts.import.codex.list",
  "accounts.import.codex.plan",
  "accounts.import.codex.execute",
  "accounts.import.keys.list",
  "accounts.import.keys.plan",
  "accounts.import.keys.execute",
  "accounts.test",
  "accounts.update",
  "accounts.remove.plan",
  "accounts.remove.execute",
  "policy.set",
  "ratecards.set",
  "presets.suggest",
  "presets.set",
  "presets.remove",
  "presets.defaults.set",
  "plugin.claudeAuth.status",
  "plugin.claudeAuth.ack",
  "plugin.claudeAuth.install.plan",
  "plugin.claudeAuth.install.execute",
  "plugin.claudeAuth.uninstall.plan",
  "plugin.claudeAuth.uninstall.execute",
  "plugin.claudeAuth.changeSource.plan",
  "plugin.claudeAuth.changeSource.execute",
  "plugin.claudeAuth.importSubscription",
  // 02 §8.10 (CAG): the Claude Agent accounts, their folders and login windows are this PC's. A host binds its own
  // conversations and keeps its own default for new ones (`session.*`, `default.set`, 02 §8.10.13).
  "claudeAgent.status",
  "claudeAgent.setup",
  "claudeAgent.login",
  "claudeAgent.remove",
  "claudeAgent.limits.refresh",
  "claudeAgent.pool.set",
  "claudeAgent.folders.list",
  "claudeAgent.folders.assign",
  "notes.list",
  "notes.get",
  "notes.put",
  "notes.remove",
  "ideas.list",
  "ideas.put",
  "ideas.remove",
  "voice.get",
  "voice.set",
  "voice.key.set",
  "voice.transcribe",
  "websearch.key.get",
  "websearch.key.set",
  // 04 §8.11.12: the remote relay's consent, host switches and the Fast consent are recorded on the PC only.
  "plugin.claudeAuth.remote.ack",
  "plugin.claudeAuth.remote.set",
  "plugin.claudeAuth.fastAck",
  // 02 §8.7: the patch, logins and Claude login folders are this PC's; a host binds its own sessions (session.*).
  "plugin.claudeAuth.patch.plan",
  "plugin.claudeAuth.patch.execute",
  "plugin.claudeAuth.accounts.add.plan",
  "plugin.claudeAuth.accounts.add.execute",
  "plugin.claudeAuth.accounts.add.status",
  "plugin.claudeAuth.accounts.detect",
  "plugin.claudeAuth.accounts.remove.plan",
  "plugin.claudeAuth.accounts.remove.execute",
  "plugin.claudeAuth.default.set",
  // 07 §4.5 (CA): the Codex model lists are fetched on the PC only.
  "codexModels.get",
  "codexModels.set",
  // 02 §7.1.1 리셋권: the ChatGPT logins are this PC's, and a host never redeems a reset credit by itself.
  "quota.resetCredits.list",
  "quota.resetCredits.redeem.plan",
  "quota.resetCredits.redeem.execute",
  // 03 §18.14 (SM): the MCP servers own adds are this PC's; an SSH host runs the servers of its own config.
  "mcp.list",
  "mcp.save",
  "mcp.remove",
  "mcp.enable",
  "mcp.test",
  "mcp.import.scan",
  "mcp.import.apply",
  "mcp.summary",
  "mcp.registry.search",
  // 04 §13 (MH): the records of values sent to hosts are this PC's; a host gets the values over the broker.
  "mcp.hosts.send",
  "mcp.hosts.unsend",
  "mcp.hosts.view",
  // 16 (GH): the GitHub accounts and their tokens are this PC's; a host gets no GitHub connection (16 §8).
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
  // 03 §19.6.1 (SG): the skill switches and scopes are this PC's; an SSH host loads the skills of its own folders.
  "skillset.view",
  "skillset.switch",
  // 05 §20 (UPD): 설정 > 업데이트 is about this PC's programs; an SSH host's parts update through own.remote.
  "tools.view",
  "tools.settings.set",
  "tools.update.plan",
  "tools.update.execute",
  "tools.update.status",
] as const satisfies ReadonlyArray<RpcTypes.MethodName>

/** The handlers of a remote service: {@link REMOTE_MANAGED} methods answer the declared `remote_managed` error. */
export function remoteHandlers(all: RpcTypes.Handlers): RpcTypes.Handlers {
  const refused = Object.fromEntries(
    REMOTE_MANAGED.map((method) => [
      method,
      async (
        _input: unknown,
        context: { readonly error: (type: "remote_managed", message: string, data: { method: string }) => unknown },
      ) => context.error("remote_managed", `${method} is managed on the local PC`, { method }),
    ]),
  )
  // SAFETY: every listed method declares `remote_managed` (own-protocol), so these handlers fit their signatures.
  return { ...all, ...refused } as unknown as RpcTypes.Handlers
}

/**
 * Registers RPC id `own.accounts` (own-accounts is its only registrant and event publisher, 02 §9.1) and binds the
 * emitter to the registration.
 */
export async function register(deps: Deps, modules: Modules.All) {
  const all = handlers(modules, deps)
  // Portable (Standard Schema) definitions: a release bundle has its own `effect`, which the host cannot run
  // (own-protocol portable.ts).
  const registration = await deps.ctx.rpc.register(portableDefinition(), deps.remote ? remoteHandlers(all) : all)
  deps.emitter.bind(registration)
  return registration
}

let portable: typeof OwnAccounts.Definition | undefined
function portableDefinition() {
  return (portable ??= Portable.definition(OwnAccounts.Definition))
}

/** Only `health`, used when guard 1 fails (01 §5.4): other methods answer `rpc.method_not_found`. */
export const HealthOnly = Rpc.define({
  id: OwnAccounts.ID,
  methods: { health: OwnAccounts.Definition.methods.health },
  events: {},
})

export function registerDegraded(
  ctx: Plugin.Context,
  input: { readonly guard: Guard.Result; readonly buildId: string; readonly mode?: "local" | "remote" },
) {
  return ctx.rpc.register(Portable.definition(HealthOnly), {
    health: async () => ({
      version: Build.PLUGIN_VERSION,
      buildId: input.buildId,
      guard: input.guard.guard,
      warnings: input.guard.reason ? [input.guard.reason] : [],
      ...(input.mode ? { mode: input.mode } : {}),
    }),
  })
}
