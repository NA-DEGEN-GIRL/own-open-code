export * as ReadOnly from "./readonly.js"

import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { OwnBrowse, OwnGitHub, OwnImage, type Preset } from "@own/protocol"
import { Creator } from "@own/protocol/creator"
import type { Deps } from "../deps.js"

/**
 * What each read-only role (`Preset.READ_ONLY_ROLES`) may never do (07 §2.4): `explore` searches (no edits, no shell),
 * `own-review` reviews (no edits; its shell follows the approval mode). Neither drives the desktop: `computer` is
 * denied for every computer tool (cu-review "Presets gate and computer tools"). Neither writes to GitHub: a
 * `github.write` (an issue, a pull request, a comment, a push through the GitHub tools; 16 §5.4) is denied outright
 * instead of asking (MR9-8's product choice), while GitHub's reads stay. Neither makes images: own's `image_generate`
 * (02 §9.6) spends money or subscription usage and writes a file, which is the main conversation's call (merge round
 * 11, MR13). Neither calls a creator C2 server tool: every permission whose action begins with `creator-` (own's
 * generated MCP servers, which read and write project files and fetch declared hosts) is denied, whatever the
 * server's approval mode; creator mode's own write action `creator` is not one of these (merge round 11, MR15).
 * Keyed by the protocol's list, so a new read-only role needs its entry here.
 */
export const DENIED: { readonly [Role in Preset.ReadOnlyRole]: ReadonlyArray<string> } = {
  explore: ["edit", "shell", "computer", OwnGitHub.WRITE_ACTION, OwnImage.TOOL],
  "own-review": ["edit", "computer", OwnGitHub.WRITE_ACTION, OwnImage.TOOL],
}

/** {@link DENIED} by agent id; any other agent is no read-only role. */
const BY_AGENT: ReadonlyMap<string, ReadonlyArray<string>> = new Map(Object.entries(DENIED))
/** Every action some read-only role is denied by name: anything else (bar creator C2 tools) never needs the agent. */
const GUARDED = new Set([...BY_AGENT.values()].flat())

/** A creator C2 server tool permission (`creator-<id>-<name>_<tool>`), denied to every read-only role; never `creator`. */
function isCreatorServerTool(action: string) {
  return action.startsWith(Creator.SERVER_PREFIX)
}

/** What the model reads when a read-only role is refused (core turns it into the tool's `BlockedError`). */
const MESSAGE: Readonly<Record<string, string>> = {
  edit: "This subagent role is read-only: it may not edit files. Report the change you would make instead.",
  shell: "This subagent role is read-only: it may not run shell commands. Use read, grep and glob instead.",
  computer: "This subagent role may not use the computer. Ask the main conversation to do it.",
  [OwnGitHub.WRITE_ACTION]:
    "This subagent role is read-only: it may not make changes on GitHub. Report the change you would make instead.",
  [OwnImage.TOOL]: "This subagent role may not make images. Ask the main conversation to make the image instead.",
}

/**
 * A 내 브라우저 사용 action (`browse_<tool>` that is not a read, BRW): denied to every read-only role, like a creator
 * tool. Its reads (snapshot, screenshot, …) stay, under the conversation's switch and mode.
 */
function isBrowseAction(event: PermissionEvaluation) {
  const tool = OwnBrowse.toolOf(event.action)
  return tool !== undefined && OwnBrowse.kind(tool, event.metadata?.input) === "act"
}

/** The refusal of a browser action. */
const BROWSE_MESSAGE = "This subagent role is read-only: it may not act in the user's browser. Ask the main conversation."

/** The refusal of a creator C2 server tool. */
const CREATOR_TOOL_MESSAGE = "This subagent role is read-only: it may not call creator extension tools. Ask the main conversation."

/**
 * The read-only roles' `permission` `evaluate` hook (07 §2.4, 06 §4.9 조이기만). A child session copies its parent's
 * session rules (`packages/core/src/session.ts`), and session rules are evaluated after the agent's, so a parent in
 * `ask` or `full` approval (`edit ** allow`, `shell ** allow`) or with computer use on (`{computer,*,allow}`) would
 * lift the role agents' own deny. The hook turns the decision back to `deny` for those actions of an `explore` or
 * `own-review` session, whatever the parent's approval mode.
 * - Tighten only, like every own hook: an incoming `deny` is never changed and nothing is ever raised to `allow`.
 * - Nothing is written to the session: the approval bundle, its `modeOf` and the parent's rules stay as they were, and
 *   there is no race between a child's creation and its first step.
 * - The session's agent comes from the event; when the event has none it is looked up, and a session whose agent
 *   cannot be read is denied these actions (fail closed).
 * Core settles a rule `deny` before hooks run (`packages/core/src/permission.ts`), so this only sees `allow` and `ask`
 * (and a `deny` an earlier hook wrote). Core's computer tools carry no permission check of their own: `computer` here
 * holds only where a `computer` permission is evaluated.
 */
export function create(deps: Deps) {
  const log = deps.log.child("presets.readonly")

  const agentOf = async (event: PermissionEvaluation) =>
    event.agent ??
    (await deps.ctx.session.get({ sessionID: event.sessionID }).then(
      (session) => session.agent ?? NO_AGENT,
      (error: unknown) => {
        log.warn("readonly_role_undecided", { sessionID: event.sessionID, action: event.action, error })
        return undefined
      },
    ))

  return async (event: PermissionEvaluation) => {
    if (event.effect === "deny") return
    const creatorTool = isCreatorServerTool(event.action)
    const browseAction = isBrowseAction(event)
    if (!creatorTool && !browseAction && !GUARDED.has(event.action)) return
    const agent = await agentOf(event)
    if (browseAction) {
      if (agent !== undefined && !BY_AGENT.has(agent)) return
      event.effect = "deny"
      event.message = BROWSE_MESSAGE
      return
    }
    // Every read-only role is denied every creator C2 tool; the named actions are denied only to the roles that list them.
    if (agent !== undefined && !creatorTool && !BY_AGENT.get(agent)?.includes(event.action)) return
    if (agent !== undefined && creatorTool && !BY_AGENT.has(agent)) return
    event.effect = "deny"
    event.message = creatorTool ? CREATOR_TOOL_MESSAGE : MESSAGE[event.action]
  }
}

/** A session without an agent runs core's default agent, which is no read-only role. */
const NO_AGENT = ""
