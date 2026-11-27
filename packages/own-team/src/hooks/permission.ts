export * as PermissionHook from "./permission.js"

import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import { Guard } from "../assets/guard.js"
import { ShellRules } from "../assets/shell-rules.js"
import type { Services } from "../services.js"
import { WorktreeChatIntegrate } from "../worktree-chat/integrate.js"

/**
 * The permission `evaluate` hook (06 §4.9, §10.1, 07 §2.4): tighten only. An incoming `deny` is never changed (a rule's
 * deny never reaches the hook; one another plugin's hook wrote, such as own.accounts' read-only roles, stays).
 * Lowering to `ask` or `deny` (a write into a heavy folder outside the cone, dangerous shell commands) applies to
 * every session of an area folder, to the team main and to the sessions below it; raising `ask` to `allow` (the
 * team's commands that need no question) only to the session ids the registry holds as current team main or owner,
 * never to subagents or replaced conversations, and only while the team's policy `autoAllow` is on.
 */
export function create(services: Services.Context): (input: PermissionEvaluation) => Promise<void> {
  return async (event) => {
    if (event.effect === "deny") return
    // 06 §13.5: integrating a worktree conversation's branch asks in every approval mode (an agent's `*` allow and
    // 전체 허용 included) until the user's 항상 허용 saved that base branch (P-047 `saved`).
    if (event.action === WorktreeChatIntegrate.ACTION) {
      const saved = event.saved ?? []
      if (event.effect === "allow" && !event.resources.every((resource) => saved.includes(resource) || saved.includes("*")))
        event.effect = "ask"
      return
    }
    if (event.action !== "edit" && event.action !== "shell") return
    const subject = await Guard.subject(services, event.sessionID)
    if (!subject) return
    if (event.action === "edit") {
      const message = await Guard.edit(subject, event.resources)
      if (message === undefined) return
      event.effect = "deny"
      event.message = message
      return
    }
    const lowered = ShellRules.lower(event.resources, {
      codeOnly: subject.area?.shape === "code",
      main: subject.main,
      team: true,
    })
    if (lowered) {
      event.effect = lowered.effect
      event.message = lowered.message
      return
    }
    const role = subject.role
    // An ask another own hook wrote carries its reason (own.accounts' protected paths, 01 §13 PP) and stays: only the
    // ask core's rules gave is raised (L1/L2, MR15).
    if (event.effect !== "ask" || event.message !== undefined) return
    if (!role || !role.team.policy.autoAllow || event.resources.length === 0) return
    const folder = role.kind === "main" ? role.team.home.directory : role.area.directory
    const exact = [...ShellRules.commands(role.team), ...(await ShellRules.candidates(folder))]
    if (event.resources.every((resource) => ShellRules.allowed(resource, exact))) event.effect = "allow"
  }
}
