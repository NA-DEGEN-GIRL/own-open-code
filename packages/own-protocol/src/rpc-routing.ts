export * as OwnRouting from "./rpc-routing.js"

// Plain routing metadata is shared with the renderer without evaluating the RPC schema graph.
import type { OwnAccounts } from "./rpc.js"

type MethodName = OwnAccounts.MethodName
type EventName = OwnAccounts.EventName
type Scope = OwnAccounts.Scope
type Location = OwnAccounts.Location
type Origin = OwnAccounts.Origin

export const ID = "own.accounts"

export const MethodScope: { readonly [M in MethodName]: Scope } = {
  health: "read",
  "accounts.list": "read",
  "quota.snapshot": "read",
  "session.binding": "read",
  "cache.state": "read",
  "ledger.session": "read",
  "accounts.usage": "read",
  "switch.state": "read",
  "policy.get": "read",
  "ratecards.get": "read",
  "presets.list": "read",
  "presets.suggest": "read",
  "session.preset.get": "read",
  "session.speed.get": "read",
  "speed.offers": "read",
  "session.approval.get": "read",
  "plugin.claudeAuth.status": "read",
  "claudeAgent.status": "read",
  "claudeAgent.limits.refresh": "read",
  "claudeAgent.session.get": "read",
  "claudeAgent.folders.list": "read",
  "plugin.claudeAuth.session.get": "read",
  "plugin.trust.list": "read",
  "worktree.inspect": "read",
  // 09 §5.6: a price of requests on a slot, for own.import's plan; no PLANNED state, unlike `switch.estimate`.
  "estimate.request": "read",
  // 02 §9.2 notes: reading the workspace notes is a read; writing them is user input, like sending a message.
  "notes.list": "read",
  "notes.get": "read",
  // 02 §9.2 아이디어 노트: the global sticky notes, read and written like the workspace notes.
  "ideas.list": "read",
  // 02 §3.9: whether voice input is on and which services have a key (never the key).
  "voice.get": "read",
  // 03 §18.2: which web search service the server uses (never a key).
  "websearch.get": "read",
  // 02 §9.6: the image tool's key chain and subscription accounts (labels and used-up marks, never a key).
  "image.get": "read",
  // BRW: whether 내 브라우저 사용 is on and which program would run (a path, never the browser).
  "browse.status": "read",
  // 03 §5.1 기본 대화 폴더: the folder's path, like the session list's folders.
  "conversationFolder.get": "read",
  // 03 §18.3: where the folder picker starts.
  "folderPicker.get": "read",
  // 03 §4.3: which projects are pinned and in which order (ids), like the session list itself.
  "projectList.get": "read",
  // 01 §13 (PP): the built-in protected paths and the user's list, shown read-only on every device.
  "protectedPaths.get": "read",
  // In-process (own.harness's dsh searches); the same facts as the view.
  "protectedPaths.patterns": "read",
  // 07 §4.5 (CA): the Codex version the model lists are asked as and the rows own left out (no account data).
  "codexModels.get": "read",
  // 03 §18.14 (SM): the names of own's MCP servers, where they are used and come from (no definition, no value), so a
  // phone's list says where a server comes from.
  "mcp.summary": "read",
  "mcp.host.view": "read",
  "mcp.hosts.view": "read",
  // 02 §4.7.7 (CC-14): the user is looking at the session; it only holds idle compaction back.
  "session.presence": "read",
  // 03 §19.6.1 (SG): which skills are off where (ids, names and folders, never content), like the skills list itself.
  "skillset.view": "read",

  "switch.estimate": "switch",
  "switch.apply": "switch",
  "switch.schedule": "switch",
  "switch.cancel": "switch",
  "switch.undo": "switch",
  "switch.waitReset": "switch",
  "switch.setConfirmOverride": "switch",
  "cache.setTtlMode": "switch",
  "compaction.setSession": "switch",
  "session.preset.apply": "switch",
  "session.ultra.set": "switch",
  "session.preset.consent": "switch",
  // 02 §4.8: like ultra, a session switch of how the main runs (its cost shows before it applies).
  "session.speed.set": "switch",
  // 02 §8.7: which Claude account a conversation runs on, like a switch of its account.
  "plugin.claudeAuth.session.set": "switch",
  "plugin.claudeAuth.default.set": "switch",
  // 02 §8.10 (CAG phase 2): a manual move between Claude Agent accounts, like the Claude slot's.
  "claudeAgent.session.set": "switch",
  "claudeAgent.default.set": "switch",

  // 07 §8.1: it changes how many subagents the current user message may start, like sending more work.
  "session.preset.raiseOnce": "prompt",
  "notes.put": "prompt",
  "notes.remove": "prompt",
  "ideas.put": "prompt",
  // 02 §9.7 곁질문: asking spends the conversation's account, like a prompt; reading a thread is reading the conversation.
  "side.ask": "prompt",
  "side.get": "read",
  "side.list": "read",
  "side.cancel": "prompt",
  "side.remove": "prompt",
  "ideas.remove": "prompt",
  // 02 §3.9: a recognition spends the user's paid API minutes, like sending a prompt (05 §13.5).
  "voice.transcribe": "prompt",
  // 03 §5.1: creating the default conversation folder is part of starting a conversation.
  "conversationFolder.ensure": "prompt",
  // 03 §18.3: browsing a service's folders and `새 폴더` there are steps of opening a folder to talk in. Not `read`: core's
  // own listing needs the device scope `files`, and a folder made on the host is a write.
  "folderPicker.list": "prompt",
  "folderPicker.create": "prompt",
  // 03 §4.3: arranging the list, like pinning a conversation (a session metadata write).
  "projectList.set": "prompt",

  "accounts.test": "admin",
  // 02 §7.1.1 리셋권: reads the account's credits from ChatGPT with its login, like the connection test's request.
  "quota.resetCredits.list": "admin",
  "policy.set": "admin",
  // 02 §8.10.12: the Claude Agent process cap of this service, a setting like the policy.
  "claudeAgent.pool.set": "admin",
  "ratecards.set": "admin",
  "presets.set": "admin",
  "presets.remove": "admin",
  "presets.defaults.set": "admin",
  "diagnostics.selfTest": "admin",
  "session.approval.set": "admin",
  // 02 §3.9: on/off, service and language, like the switching policy.
  "voice.set": "admin",
  // 03 §18.2: choosing a service sends the agent's search queries to that third party, like widening approval.
  "websearch.set": "admin",
  // 02 §9.6: a cleared mark sends the next image to that key again, like a setting.
  "image.clear": "admin",
  // 03 §5.1: where every later folderless conversation works, for every window and device, like the voice settings.
  "conversationFolder.set": "admin",
  "folderPicker.set": "admin",
  // 07 §4.5 (CA): `Codex 최신 모델 자동 확인` changes what every ChatGPT account's list shows, like the voice settings.
  "codexModels.set": "admin",
  // In-process (own.harness's catalog, 10 §6.14): never a device's.
  "codexModels.rows": "local",
  // 03 §19.6.1 (SG): a skill on or off in a project or everywhere, like the MCP list's switch.
  "skillset.switch": "admin",

  "accounts.add.key": "local",
  // 02 §3.3a: the add form's server read; it may carry a key typed there, so only this PC's windows ask.
  "accounts.local.detect": "local",
  // BRW: turns 내 브라우저 사용 on or off and names the program, which runs on this PC: a PC window only.
  "browse.set": "local",
  // 02 §7.1.1: redeeming spends a credit for good, so only this PC's windows may; never a phone or another PC.
  "quota.resetCredits.redeem.plan": "local",
  "quota.resetCredits.redeem.execute": "local",
  "accounts.add.chatgpt.start": "local",
  "accounts.add.chatgpt.status": "local",
  "accounts.add.chatgpt.complete": "local",
  "accounts.add.chatgpt.cancel": "local",
  "accounts.import.codex.list": "local",
  "accounts.import.codex.plan": "local",
  "accounts.import.codex.execute": "local",
  "accounts.import.keys.list": "local",
  "accounts.import.keys.plan": "local",
  "accounts.import.keys.execute": "local",
  "accounts.update": "local",
  "accounts.remove.plan": "local",
  "accounts.remove.execute": "local",
  "plugin.claudeAuth.ack": "local",
  "plugin.claudeAuth.importSubscription": "local",
  "plugin.claudeAuth.install.plan": "local",
  "plugin.claudeAuth.install.execute": "local",
  "plugin.claudeAuth.uninstall.plan": "local",
  "plugin.claudeAuth.uninstall.execute": "local",
  "plugin.claudeAuth.changeSource.plan": "local",
  "plugin.claudeAuth.changeSource.execute": "local",
  // 04 §8.11.12: consent and per-host switches of the remote Claude relay are this PC's decisions.
  "plugin.claudeAuth.remote.ack": "local",
  "plugin.claudeAuth.remote.set": "local",
  "plugin.claudeAuth.fastAck": "local",
  // 02 §8.7 (2026-10-10): the login window opens on this PC, and logins and folders are this PC's.
  "plugin.claudeAuth.patch.plan": "local",
  "plugin.claudeAuth.patch.execute": "local",
  "plugin.claudeAuth.accounts.add.plan": "local",
  "plugin.claudeAuth.accounts.add.execute": "local",
  "plugin.claudeAuth.accounts.add.status": "local",
  "plugin.claudeAuth.accounts.detect": "local",
  "plugin.claudeAuth.accounts.remove.plan": "local",
  "plugin.claudeAuth.accounts.remove.execute": "local",
  // 02 §8.10 (CAG): the Claude Agent login folder and its login window are this PC's.
  "claudeAgent.setup": "local",
  "claudeAgent.login": "local",
  "claudeAgent.remove": "local",
  // A folder moving between routes renames login folders on this PC.
  "claudeAgent.folders.assign": "local",
  "plugin.trust.approve.plan": "local",
  "plugin.trust.approve.execute": "local",
  "plugin.trust.revoke": "local",
  // P0-3a (02 §7.8): the capture files hold local paths and the header census; never from a remote device.
  "diagnostics.capture.start": "local",
  "diagnostics.capture.stop": "local",
  "diagnostics.capture.status": "local",
  // 02 §3.9: a key goes into the vault from this PC only, like `accounts.add.key`.
  "voice.key.set": "local",
  // 02 §9.2 (SP): the same for a web search service's key; whether one is set is a read.
  "websearch.key.get": "read",
  "websearch.key.set": "local",
  // 01 §13 (PP): the user's protected paths change from this PC's windows only, like "항상 허용" (03 §18.8); the
  // suggestions name what lies in the home folder.
  "protectedPaths.add": "local",
  "protectedPaths.remove": "local",
  "protectedPaths.suggest": "local",
  // 03 §18.14 (SM): own's MCP servers. A local command server runs any program on this PC, and the list holds commands,
  // folders and addresses, so reading and changing them is this PC's windows' alone. The list's switch only turns a
  // server someone added here on or off in one project, like the web search choice.
  "mcp.list": "local",
  "mcp.save": "local",
  "mcp.remove": "local",
  "mcp.enable": "admin",
  "mcp.test": "local",
  "mcp.import.scan": "local",
  "mcp.import.apply": "local",
  // 찾아서 설치: the registry is asked from this PC, for the add form of this PC's windows.
  "mcp.registry.search": "local",
  "mcp.host.probe": "local",
  "mcp.host.save": "local",
  "mcp.host.remove": "local",
  "mcp.host.test": "local",
  "mcp.host.prefetch": "local",
  "mcp.hosts.send": "local",
  "mcp.hosts.unsend": "local",
  // 16 (GH): the GitHub accounts. The view names logins, folders and conversations but never a token (as the
  // account list does); a token goes into the vault from this PC only, and so do the settings (which name a program
  // own starts) and the write switch. A choice per project or conversation is like the MCP list's switch.
  "github.view": "read",
  "github.add.token": "local",
  "github.device.start": "local",
  "github.device.status": "local",
  "github.device.cancel": "local",
  "github.update": "local",
  "github.remove": "local",
  "github.bind": "admin",
  "github.settings.set": "local",
  "github.test": "local",
  // 05 §20 (UPD): the page names this PC's program paths, and an update runs a program on this PC: its windows' alone.
  "tools.view": "local",
  "tools.settings.set": "local",
  "tools.update.plan": "local",
  "tools.update.execute": "local",
  "tools.update.status": "local",
}

/**
 * What one call needs, with its input (MUX 2026-11-06). `session.approval.set` that only picks a mode for a conversation
 * (`{sessionID, mode}`, nothing else: `묻기`, `읽기 전용` or `전체 허용`) needs `prompt`: a phone's conversation runs under
 * the mode it chose, as one from this PC does (the user's choice of 2026-11-06, MUX-15: 전체 허용 from the phone too, after
 * the same confirmation). Turning the browser tool on with it (`browserTool: "on"`) needs `prompt` too since MBR
 * (2026-11-20, 05 §8.10.5): a device's new conversation already gets the tools while the PC's desktop app runs, so this
 * hands an older conversation nothing a new one lacks. Turning it off and computer use stay `admin` (computer use on
 * stays this PC's, 05 §13.4); 내 브라우저 사용 on needs `local` (BRW).
 */
export function scopeOf(method: MethodName, payload: unknown): Scope {
  if (method === "session.approval.set" && modeOnly(payload)) return "prompt"
  // 내 브라우저 사용 on (BRW) drives this PC's browser with the user's logins: a PC window only; off stays `admin`.
  if (method === "session.approval.set" && browseOn(payload)) return "local"
  return MethodScope[method]
}

function browseOn(payload: unknown) {
  return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>).browse === "on"
}

function modeOnly(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return false
  const keys = Object.keys(payload)
  const mode = (payload as Record<string, unknown>).mode
  const known = mode === "ask" || mode === "read-only" || mode === "full"
  const browserTool = (payload as Record<string, unknown>).browserTool
  if (browserTool !== undefined && browserTool !== "on") return false
  return known && keys.every((key) => key === "sessionID" || key === "mode" || key === "browserTool")
}

export const MethodLocation: { readonly [M in MethodName]: Location } = {
  health: "control",
  "diagnostics.selfTest": "control",
  "diagnostics.capture.start": "control",
  "diagnostics.capture.stop": "control",
  "diagnostics.capture.status": "control",
  "accounts.list": "control",
  "accounts.update": "control",
  "accounts.remove.plan": "control",
  "accounts.remove.execute": "control",
  "accounts.add.key": "control",
  "accounts.local.detect": "control",
  "accounts.add.chatgpt.start": "control",
  "accounts.add.chatgpt.status": "control",
  "accounts.add.chatgpt.complete": "control",
  "accounts.add.chatgpt.cancel": "control",
  "accounts.import.codex.list": "control",
  "accounts.import.codex.plan": "control",
  "accounts.import.codex.execute": "control",
  "accounts.import.keys.list": "control",
  "accounts.import.keys.plan": "control",
  "accounts.import.keys.execute": "control",
  "accounts.test": "control",
  "accounts.usage": "control",
  "quota.snapshot": "control",
  "quota.resetCredits.list": "control",
  "quota.resetCredits.redeem.plan": "control",
  "quota.resetCredits.redeem.execute": "control",
  "policy.get": "control",
  "policy.set": "control",
  "ratecards.get": "control",
  "ratecards.set": "control",
  "presets.list": "control",
  "presets.suggest": "control",
  // 2026-10-10: a main's speed offers before a session exists (the new-conversation composer, the switcher).
  "speed.offers": "control",
  "presets.set": "control",
  "presets.remove": "control",
  "presets.defaults.set": "control",
  "plugin.claudeAuth.status": "control",
  "plugin.claudeAuth.ack": "control",
  "plugin.claudeAuth.importSubscription": "control",
  "plugin.claudeAuth.install.plan": "control",
  "plugin.claudeAuth.install.execute": "control",
  "plugin.claudeAuth.uninstall.plan": "control",
  "plugin.claudeAuth.uninstall.execute": "control",
  "plugin.claudeAuth.changeSource.plan": "control",
  "plugin.claudeAuth.changeSource.execute": "control",
  "plugin.claudeAuth.remote.ack": "control",
  "plugin.claudeAuth.remote.set": "control",
  "plugin.claudeAuth.fastAck": "control",
  "plugin.claudeAuth.patch.plan": "control",
  "plugin.claudeAuth.patch.execute": "control",
  "plugin.claudeAuth.accounts.add.plan": "control",
  "plugin.claudeAuth.accounts.add.execute": "control",
  "plugin.claudeAuth.accounts.add.status": "control",
  "plugin.claudeAuth.accounts.detect": "control",
  "plugin.claudeAuth.accounts.remove.plan": "control",
  "plugin.claudeAuth.accounts.remove.execute": "control",
  "claudeAgent.status": "control",
  "claudeAgent.setup": "control",
  "claudeAgent.login": "control",
  "claudeAgent.remove": "control",
  "claudeAgent.limits.refresh": "control",
  "claudeAgent.default.set": "control",
  "claudeAgent.pool.set": "control",
  "claudeAgent.folders.list": "control",
  "claudeAgent.folders.assign": "control",
  "plugin.claudeAuth.default.set": "control",
  "plugin.trust.list": "control",
  "plugin.trust.approve.plan": "control",
  "plugin.trust.approve.execute": "control",
  "plugin.trust.revoke": "control",
  "worktree.inspect": "control",
  "estimate.request": "control",
  "notes.list": "control",
  "notes.get": "control",
  "notes.put": "control",
  "notes.remove": "control",
  "ideas.list": "control",
  "ideas.put": "control",
  "ideas.remove": "control",
  "voice.get": "control",
  "voice.set": "control",
  "voice.key.set": "control",
  "voice.transcribe": "control",
  "websearch.get": "control",
  "websearch.key.get": "control",
  "websearch.key.set": "control",
  "websearch.set": "control",
  "image.get": "control",
  "browse.status": "control",
  "browse.set": "control",
  "image.clear": "control",
  "conversationFolder.get": "control",
  "conversationFolder.set": "control",
  "conversationFolder.ensure": "control",
  "folderPicker.get": "control",
  "folderPicker.set": "control",
  "folderPicker.list": "control",
  "folderPicker.create": "control",
  "projectList.get": "control",
  "projectList.set": "control",
  "protectedPaths.get": "control",
  "protectedPaths.add": "control",
  "protectedPaths.remove": "control",
  "protectedPaths.suggest": "control",
  "protectedPaths.patterns": "control",
  "codexModels.get": "control",
  "codexModels.set": "control",
  "codexModels.rows": "control",
  "mcp.list": "control",
  "mcp.save": "control",
  "mcp.remove": "control",
  "mcp.enable": "control",
  "mcp.test": "control",
  "mcp.import.scan": "control",
  "mcp.import.apply": "control",
  "mcp.summary": "control",
  "mcp.registry.search": "control",
  "mcp.host.view": "control",
  "mcp.host.probe": "control",
  "mcp.host.save": "control",
  "mcp.host.remove": "control",
  "mcp.host.test": "control",
  "mcp.host.prefetch": "control",
  "mcp.hosts.send": "control",
  "mcp.hosts.unsend": "control",
  "mcp.hosts.view": "control",
  "skillset.view": "control",
  "skillset.switch": "control",
  "github.view": "control",
  "github.add.token": "control",
  "github.device.start": "control",
  "github.device.status": "control",
  "github.device.cancel": "control",
  "github.update": "control",
  "github.remove": "control",
  "github.bind": "control",
  "github.settings.set": "control",
  "github.test": "control",
  "tools.view": "control",
  "tools.settings.set": "control",
  "tools.update.plan": "control",
  "tools.update.execute": "control",
  "tools.update.status": "control",

  "session.binding": "session",
  "cache.state": "session",
  "cache.setTtlMode": "session",
  "ledger.session": "session",
  "switch.estimate": "session",
  "switch.apply": "session",
  "switch.schedule": "session",
  "switch.cancel": "session",
  "switch.undo": "session",
  "switch.state": "session",
  "switch.waitReset": "session",
  "switch.setConfirmOverride": "session",
  "compaction.setSession": "session",
  "session.presence": "session",
  "session.approval.get": "session",
  "session.approval.set": "session",
  "session.preset.get": "session",
  "session.preset.apply": "session",
  "session.ultra.set": "session",
  "session.preset.raiseOnce": "session",
  "session.preset.consent": "session",
  "session.speed.get": "session",
  "session.speed.set": "session",
  "side.ask": "session",
  "side.get": "session",
  "side.list": "session",
  "side.cancel": "session",
  "side.remove": "session",
  "plugin.claudeAuth.session.get": "session",
  "plugin.claudeAuth.session.set": "session",
  "claudeAgent.session.get": "session",
  "claudeAgent.session.set": "session",
}

export const EventOrigin: { readonly [E in EventName]: Origin | "either" } = {
  "accounts.changed": "global",
  "quota.updated": "global",
  "account.status": "global",
  "plugin.status": "global",
  "plugin.trust.changed": "global",
  "presets.changed": "global",
  "notes.changed": "global",
  "ideas.changed": "global",
  "conversationFolder.changed": "global",
  "folderPicker.changed": "global",
  "projectList.changed": "global",
  "protectedPaths.changed": "global",
  "codexModels.changed": "global",
  "mcp.changed": "global",
  "skillset.changed": "global",
  "claudeAgent.pool": "global",
  "github.changed": "global",
  "cache.state": "session",
  "compaction.due": "session",
  "approval.changed": "session",
  "session.preset.changed": "session",
  "session.speed.changed": "session",
  "binding.changed": "session",
  "switch.recorded": "session",
  "switch.scheduled": "session",
  "switch.state": "session",
  "switch.suggested": "session",
  "ledger.step": "session",
  "side.delta": "session",
  "side.ended": "session",
  alert: "either",
}
