export * as Permissions from "./permissions.js"

import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { Services } from "../services.js"

/**
 * Who sees the team tools (06 §2.8 "누가 볼 수 있나"). Each tool's `options.permission` is one of three actions:
 * `team.main` (main-only tools), `team.owner` (owner-only tools) and `team.member` (tools both use: `team_status`,
 * `team_integrate`, `team_area`). One tool has one action, so the shared tools need the third action; the spec's two-action list
 * could not give a tool to both roles without also showing each role the other's tools.
 *
 * Every agent gets a `resource:"*"` deny for the three actions (`deny`), so the tools are not in any catalog
 * (core `tool.ts:292-295`, `whollyDisabled`); the main and owners carry the exact allows of `rules(role)` in their
 * session permissions from `session.create` (delta 0). Writing or removing them later (adopt, unadopt, undo) is a
 * read-merge-write of exactly these rules, followed by own.accounts `session.approval.set{sessionID, mode}` so its
 * bundle (the protected-path denies, 03 P10) is last again; that call never carries `computerUse`, and its own
 * read-merge-write keeps an existing `{computer, *, allow}` (computer use is switched on per session by the user only).
 */

export const ACTIONS = { main: "team.main", owner: "team.owner", member: "team.member" } as const

export type Role = "main" | "owner"

/** A session or agent permission rule, as the plugin API reads and writes it. */
export interface Rule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

const TEAM: ReadonlySet<string> = new Set(Object.values(ACTIONS))

/** The agent-wide denies (`ctx.agent.transform`). */
export const DENY: ReadonlyArray<Rule> = Object.values(ACTIONS).map((action) => ({
  action,
  resource: "*",
  effect: "deny" as const,
}))

/** The session allows of a team main or an owner: its role's action and the shared one. */
export function rules(role: Role): ReadonlyArray<Rule> {
  return [ACTIONS[role], ACTIONS.member].map((action) => ({ action, resource: "*", effect: "allow" as const }))
}

/**
 * Appends the team denies to every agent, after removing any earlier copy, so they stay the last team rules however
 * often the transform runs (the setup and the late registration, `tools/index.ts`).
 */
export function deny(editor: AgentEditor) {
  for (const agent of editor.list())
    editor.update(String(agent.id), (info) => {
      info.permissions = [
        ...info.permissions.filter(
          (rule) => !(TEAM.has(rule.action) && rule.effect === "deny" && rule.resource === "*"),
        ),
        ...DENY.map((rule) => ({ ...rule })),
      ]
    })
}

/** `rules` without any team rule, then the role's allows first (`null` removes them). Other rules keep their order. */
export function merge(current: ReadonlyArray<Rule>, role: Role | null): Rule[] {
  const kept = current.filter((rule) => !TEAM.has(rule.action))
  return [...(role === null ? [] : rules(role)), ...kept]
}

/**
 * Writes the team allows of `role` into the session's permissions (or removes them with `null`), then calls
 * own.accounts `session.approval.set{sessionID, mode}` with the mode the session had before the write, when it has an
 * own bundle (`mode` other than `custom`). Returns that mode (`null` when own.accounts could not say).
 */
export async function write(
  services: Services.Context,
  input: { readonly sessionID: string; readonly directory: string; readonly role: Role | null },
): Promise<Services.Result<{ readonly mode: string | null }>> {
  const instance = services.instance(input.directory)
  if (!instance) return Services.failure("internal_error", "이 폴더의 팀 서비스가 아직 준비되지 않았어요", {})
  const where = { directory: input.directory }
  const approval = await services.accounts.approvalGet({ sessionID: input.sessionID }, where)
  const session = await instance.ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
  if (!session) return Services.failure("not_found", "대화를 찾을 수 없어요", { what: "session", id: input.sessionID })
  const written = await instance.ctx.session
    .update({ sessionID: input.sessionID, permissions: merge(session.permissions ?? [], input.role) })
    .then(
      () => true,
      (error: unknown) => {
        services.log.warn("team_permissions_write_failed", { sessionID: input.sessionID, error })
        return false
      },
    )
  if (!written) return Services.failure("internal_error", "the session permissions could not be written", {})
  const mode = approval.ok ? approval.value.mode : null
  if (mode !== null && mode !== "custom") {
    // 06 §2.8: own.accounts puts its bundle back at the end; no `computerUse`, so its computer rule stays as it was.
    const set = await services.accounts.approvalSet({ sessionID: input.sessionID, mode }, where)
    if (!set.ok) services.log.warn("approval_reset_failed", { sessionID: input.sessionID, type: set.type })
  }
  return { ok: true, mode }
}
