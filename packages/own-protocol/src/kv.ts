export * as Kv from "./kv.js"

/**
 * Session-scoped KV keys in the own-accounts namespace (02 §2.4.6). Values are plaintext: never store secrets.
 * Value schemas: `switch` → `Switch.State`, `home` → `Switch.Home`, `strip` → `Switch.StripRule[]`,
 * `ttlMode` → `Cache.TtlMode`, `confirmOverride` → `Switch.ConfirmOverride`, `cache` → `Cache.Entry`,
 * `epoch` → non-negative integer (cold point count: compactions and committed reverts), `compaction` →
 * `Switch.SessionCompaction`, `compactionDue` → `Switch.CompactionDue`, `children` → session id array,
 * `childPolicy` → `Switch.ChildPolicy`, `preset` → `Preset.Binding`, `presetUsage` → `Preset.Usage`,
 * `presetConsent` → `Preset.Consent`, `speed` → `Speed.State`,
 * `ack:claudeFast` → `Speed.Consent`, `ack:claudeRemote` → `Plugin.ClaudeRemoteAck`.
 */
export const switchState = (sessionID: string) => `sess:${sessionID}:switch`
export const home = (sessionID: string) => `sess:${sessionID}:home`
export const strip = (sessionID: string) => `sess:${sessionID}:strip`
export const ttlMode = (sessionID: string, providerID: string) => `sess:${sessionID}:ttlMode:${providerID}`
export const confirmOverride = (sessionID: string) => `sess:${sessionID}:confirmOverride`
/**
 * A slot's cache entry. `accountID` for a provider several accounts share (`Cache.keyAccount`: the Claude accounts on
 * `anthropic`, SL-8): each account has its own prompt cache, so each has its own entry. Every other provider is one
 * account and keyed by the provider alone.
 */
export const cache = (sessionID: string, providerID: string, accountID?: string) =>
  `sess:${sessionID}:cache:${providerID}${accountID === undefined ? "" : `@${accountID}`}`
/** The slot a {@link cache} key names, from the part after `sess:<sid>:cache:` (account ids are `acc_…`). */
export function cacheSlot(rest: string): { readonly providerID: string; readonly accountID?: string } {
  const at = rest.lastIndexOf("@acc_")
  return at < 0 ? { providerID: rest } : { providerID: rest.slice(0, at), accountID: rest.slice(at + 1) }
}
export const epoch = (sessionID: string) => `sess:${sessionID}:epoch`
/** Session auto-compaction threshold ("earlier" only), written by `compaction.setSession` (02 §4.7.4). */
export const compaction = (sessionID: string) => `sess:${sessionID}:compaction`
/** The last `compaction.due` sent, so one epoch never sends two (02 §4.7.4). */
export const compactionDue = (sessionID: string) => `sess:${sessionID}:compactionDue`
/** The idle compaction admitted in the current cold point epoch (`CompactionCache.IdleRecord`, 02 §4.7.7). */
export const idleCompaction = (sessionID: string) => `sess:${sessionID}:idleCompaction`
/** Child session ids from `session.created{parentID}` (02 §5.11, `session.approval.*`). */
export const children = (sessionID: string) => `sess:${sessionID}:children`
/** How the parent's last switch treats its children (02 §5.11). */
export const childPolicy = (sessionID: string) => `sess:${sessionID}:childPolicy`
/** The root session's preset binding (07 §5.1); child sessions follow their root's (07 §2.8). */
export const preset = (sessionID: string) => `sess:${sessionID}:preset`
/**
 * The root's subagent count for the conversation and the one message `session.preset.raiseOnce` raised (07 §2.6,
 * §8.1). Per-message counts and reservations stay in memory.
 */
export const presetUsage = (sessionID: string) => `sess:${sessionID}:presetUsage`
/** The root's per-conversation answers to running a role on a paid account (`session.preset.consent`, 07 §5.4). */
export const presetConsent = (sessionID: string) => `sess:${sessionID}:presetConsent`
/**
 * 02 §4.8: a session's speed (`Speed.State`): a root's choice, and on any session the Anthropic beta header's start
 * (it stays on the conversation's later requests, being part of the cache key). Absent = Standard, no header.
 */
export const speed = (sessionID: string) => `sess:${sessionID}:speed`
/** 02 §9.7 곁질문: the conversation's side threads `{threads: SideThread[]}`, newest first, at most `Side.THREADS_MAX`. */
export const side = (sessionID: string) => `sess:${sessionID}:side`
/** 02 §4.8: the one-time consent that Fast on the Claude subscription slot is billed to usage credits (`{at}`). */
export const ackClaudeFast = "ack:claudeFast"
/**
 * 04 §8.11.12: the consent to use the Claude subscription slot from SSH remote hosts (this PC's service only; a remote
 * service never writes it).
 */
export const ackClaudeRemote = "ack:claudeRemote"
/**
 * Sign in with ChatGPT `ext_agent_host_id` of this machine (`urn:uuid:<v4>`), created once before the first sign-in
 * and sent with every authorization (02 §3.2c). Not secret; the issued client ids stay with the accounts' tokens.
 */
export const chatgptAgentHost = "chatgpt:agentHost"
/**
 * 03 §18.2 `여러 서비스 함께` (MS, 2026-10-19): the web search services own's `own-multi` asks, `{services: id[]}` in the
 * order shown. Absent: own's default for the services listed now. Server-wide, so every window and device agrees.
 */
export const websearchMulti = "websearch:multi"

/**
 * 02 §9.2 notes: one workspace's index `{notes: [{id, title, rev, updatedAt}]}` in creation order, under the hash of
 * its `Notes.workspaceKey` (a path may be longer than a key should be, and may contain `:`).
 */
export const notesIndex = (workspaceHash: string) => `notes:${workspaceHash}`
/** 02 §9.2 notes: the text of one note (a JSON string). The index row holds its title and revision. */
export const noteText = (workspaceHash: string, id: string) => `notes:${workspaceHash}:${id}`

/**
 * 03 §5.1 기본 대화 폴더: the user's choice of this service's default conversation folder (`{path}`, absolute). Absent:
 * the service's built-in default.
 */
export const conversationFolder = "conversationFolder"
/** 03 §18.3 폴더 열기 시작 위치: the user's start folder of the folder picker (`{start}`). Absent: the default rule. */
export const folderPicker = "folderPicker"
/** 03 §4.3 프로젝트 순서와 고정: this service's `ProjectList.View`. Absent: nothing pinned, the default order. */
export const projectList = "projectList"
/**
 * 01 §13 에이전트가 못 여는 파일·폴더 (PP): this service's user list (`{paths: string[]}`, as added with `~` kept, in the
 * order added). Absent: none.
 */
export const protectedPaths = "protectedPaths"

/** 02 §9.2 아이디어 노트: prefix of the idea rows, scanned by `ideas.list`. */
export const ideasPrefix = "ideas:"
/** 02 §9.2 아이디어 노트: one idea `{id, text, color, pinned, rev, createdAt, updatedAt}` (a small row of its own). */
export const idea = (id: string) => `${ideasPrefix}${id}`

/**
 * 02 §8.7 (2026-10-10): the Claude account a root session's tree runs on (`{accountID, at}`). Subagents use their
 * root's; a root in a team uses {@link claudeTeam} instead (07 R4: one Claude account per session tree and team).
 */
export const claudeSession = (sessionID: string) => `claude:session:${sessionID}`
/** The Claude account every session of a team runs on (`{accountID, at}`), written by the switcher and auto-switch. */
export const claudeTeam = (teamID: string) => `claude:team:${teamID}`
export const CLAUDE_SESSION_PREFIX = "claude:session:"
/**
 * 02 §8.10 (CAG phase 2): the Claude Agent account a root session's tree runs on (`{accountID, at}`), and a team's
 * (one Claude Agent account per tree and team, 07 R4). The same shape and rules as {@link claudeSession}.
 */
export const claudeAgentSession = (sessionID: string) => `claude-agent:session:${sessionID}`
export const claudeAgentTeam = (teamID: string) => `claude-agent:team:${teamID}`
export const CLAUDE_AGENT_SESSION_PREFIX = "claude-agent:session:"
export const CLAUDE_AGENT_TEAM_PREFIX = "claude-agent:team:"
/** 02 §8.10.13: an SSH host's own default Claude Agent account (its switcher's choice for new conversations). */
export const CLAUDE_AGENT_HOST_DEFAULT = "claude-agent:host-default"
/**
 * 02 §8.9 (CW, 2026-10-19): this service sent its first request on a Claude account (`{at, sessionID}`, the tree's
 * root), so `claude_first_request` is raised once per account and never again.
 */
export const claudeFirstRequest = (accountID: string) => `claude:firstRequest:${accountID}`

/** Prefix of every key that belongs to one session, for scans and cleanup. */
export const sessionPrefix = (sessionID: string) => `sess:${sessionID}:`
